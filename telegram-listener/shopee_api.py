"""
Shopee Affiliate Open API client
================================
GraphQL API at open-api.affiliate.shopee.com.br. Used for two things the page
scraper can't do reliably (Shopee blocks automated page requests, which is why
Shopee offers never got a photo):

  * product photo + name   -> productOfferV2(itemId, shopId)
  * affiliate short link   -> generateShortLink(originUrl)

Auth: every request carries
    Authorization: SHA256 Credential=<AppId>, Signature=<sig>, Timestamp=<ts>
where sig = sha256(AppId + Timestamp + <exact request body> + Secret) in hex.
The body that is signed must be the exact bytes that are sent.

Everything here is best-effort: on any failure the callers fall back to the
previous behaviour (og:image scraping / the an_redir affiliate link).
"""

import hashlib
import json
import os
import re
import time
from typing import Optional
from urllib.parse import urlparse

import aiohttp
from loguru import logger

SHOPEE_GRAPHQL_URL = os.getenv(
    "SHOPEE_API_URL", "https://open-api.affiliate.shopee.com.br/graphql"
)

# shopee.com.br/product/<shopId>/<itemId>
# shopee.com.br/<slug>-i.<shopId>.<itemId>
# shopee.com.br/opaanlp/<shopId>/<itemId>   (and /universal-link/product/...)
_ID_PATTERNS = (
    re.compile(r"/product/(\d+)/(\d+)"),
    re.compile(r"/opaanlp/(\d+)/(\d+)"),
    re.compile(r"-i\.(\d+)\.(\d+)"),
)


def extract_ids(url: str) -> Optional[tuple[int, int]]:
    """Returns (shop_id, item_id) parsed from a Shopee product URL, or None."""
    try:
        path = urlparse(url).path
    except Exception:
        return None
    for pattern in _ID_PATTERNS:
        m = pattern.search(path)
        if m:
            return int(m.group(1)), int(m.group(2))
    return None


def canonical_product_url(shop_id: int, item_id: int) -> str:
    """Clean product URL — drops other affiliates' tracking params."""
    return f"https://shopee.com.br/product/{shop_id}/{item_id}"


class ShopeeApiError(Exception):
    pass


class ShopeeApi:
    def __init__(self, app_id: str, secret: str) -> None:
        self.app_id = (app_id or "").strip()
        self.secret = (secret or "").strip()
        self._cache: dict[tuple[int, int], dict] = {}

    @classmethod
    def from_settings(cls, settings: dict) -> Optional["ShopeeApi"]:
        app_id = (settings.get("shopee_app_id") or "").strip()
        secret = (settings.get("shopee_app_secret") or "").strip()
        if app_id and secret:
            return cls(app_id, secret)
        return None

    # -- transport ---------------------------------------------------------

    async def _graphql(self, session: aiohttp.ClientSession, query: str) -> dict:
        body = json.dumps({"query": query}, separators=(",", ":"))
        ts = int(time.time())
        signature = hashlib.sha256(
            f"{self.app_id}{ts}{body}{self.secret}".encode("utf-8")
        ).hexdigest()
        headers = {
            "Authorization": f"SHA256 Credential={self.app_id}, Signature={signature}, Timestamp={ts}",
            "Content-Type": "application/json",
        }
        try:
            async with session.post(
                SHOPEE_GRAPHQL_URL,
                data=body.encode("utf-8"),
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=12),
            ) as resp:
                text = await resp.text()
                try:
                    data = json.loads(text)
                except ValueError:
                    raise ShopeeApiError(f"HTTP {resp.status}: resposta inválida ({text[:120]})")
        except ShopeeApiError:
            raise
        except Exception as exc:
            raise ShopeeApiError(f"falha de rede: {type(exc).__name__}: {exc}")

        errors = data.get("errors")
        if errors:
            first = errors[0] if isinstance(errors, list) and errors else errors
            msg = first.get("message") if isinstance(first, dict) else str(first)
            code = ""
            if isinstance(first, dict):
                code = (first.get("extensions") or {}).get("code") or ""
            raise ShopeeApiError(f"{msg}" + (f" (código {code})" if code else ""))
        return data.get("data") or {}

    # -- product photo / name ---------------------------------------------

    async def product_info(
        self, session: aiohttp.ClientSession, product_url: str
    ) -> Optional[dict]:
        """{'image_url': str, 'name': str|None} for a Shopee product URL, or None."""
        ids = extract_ids(product_url)
        if not ids:
            logger.info(f"[shopee_api] no shopId/itemId in {product_url[:90]}")
            return None
        if ids in self._cache:
            return self._cache[ids]
        shop_id, item_id = ids

        node: Optional[dict] = None
        # Fewer fields / quoted ids are fallbacks for schema details I could not
        # verify against the live API; stop early on auth/rate-limit errors.
        attempts = (
            ("itemId productName imageUrl", False),
            ("imageUrl", False),
            ("itemId productName imageUrl", True),
        )
        last_error = ""
        for fields, quoted in attempts:
            item_arg = f"\"{item_id}\"" if quoted else str(item_id)
            shop_arg = f"\"{shop_id}\"" if quoted else str(shop_id)
            query = (
                f"{{ productOfferV2(itemId: {item_arg}, shopId: {shop_arg}, limit: 1) "
                f"{{ nodes {{ {fields} }} }} }}"
            )
            try:
                data = await self._graphql(session, query)
            except ShopeeApiError as exc:
                last_error = str(exc)
                if any(w in last_error.lower() for w in ("signature", "credential", "10020", "auth", "rate", "limit", "rede")):
                    break
                continue
            nodes = ((data.get("productOfferV2") or {}).get("nodes")) or []
            node = nodes[0] if nodes else None
            last_error = ""
            break
        if last_error:
            logger.warning(f"[shopee_api] productOfferV2 failed for {ids}: {last_error}")
            return None

        if not node or not node.get("imageUrl"):
            logger.info(f"[shopee_api] no image returned for shop={shop_id} item={item_id}")
            return None
        # Wrong photo is worse than no photo.
        if node.get("itemId") is not None and str(node["itemId"]) != str(item_id):
            logger.warning(f"[shopee_api] item mismatch: asked {item_id}, got {node.get('itemId')}")
            return None

        info = {"image_url": node["imageUrl"], "name": node.get("productName")}
        if len(self._cache) > 200:
            self._cache.clear()
        self._cache[ids] = info
        logger.info(f"[shopee_api] image found for shop={shop_id} item={item_id}")
        return info

    # -- affiliate link ----------------------------------------------------

    async def short_link(
        self, session: aiohttp.ClientSession, product_url: str, sub_ids: Optional[list[str]] = None
    ) -> tuple[Optional[str], Optional[str]]:
        """Returns (short_link, error)."""
        ids = extract_ids(product_url)
        origin = canonical_product_url(*ids) if ids else product_url
        subs = json.dumps((sub_ids or ["ofertas"])[:5])
        query = (
            "mutation { generateShortLink(input: {originUrl: %s, subIds: %s}) { shortLink } }"
            % (json.dumps(origin), subs)
        )
        try:
            data = await self._graphql(session, query)
        except ShopeeApiError as exc:
            return None, str(exc)
        link = ((data.get("generateShortLink") or {}).get("shortLink"))
        if not link:
            return None, "A API não devolveu o link"
        return link, None

    # -- credentials check --------------------------------------------------

    async def test(self, session: aiohttp.ClientSession) -> tuple[bool, str]:
        try:
            data = await self._graphql(
                session, "{ productOfferV2(limit: 1) { nodes { productName imageUrl } } }"
            )
        except ShopeeApiError as exc:
            return False, str(exc)
        nodes = ((data.get("productOfferV2") or {}).get("nodes")) or []
        sample = nodes[0].get("productName") if nodes and isinstance(nodes[0], dict) else None
        return True, "Conexão OK" + (f" — exemplo: {sample[:60]}" if sample else "")
