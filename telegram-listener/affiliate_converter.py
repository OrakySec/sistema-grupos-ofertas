"""
Affiliate Link Converter
========================
Intercepts message text, detects product links from supported platforms,
replaces them with affiliate-tagged links, and shortens the result via TinyURL.

Supported platforms
-------------------
- Amazon Brasil    (amazon.com.br / amzn.to)
- Shopee Brasil    (shopee.com.br / shope.ee)
- AliExpress       (aliexpress.com / s.click.aliexpress.com)
- Magazine Luiza   (magazineluiza.com.br / magalu.com)

Returns
-------
convert() returns (modified_text, events_list) where events_list is a list of
dicts describing what happened to each URL found — used for the debug panel.
"""

import re
import asyncio
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse, urlencode, urlunparse, parse_qs, urljoin
import urllib.parse

import aiohttp
from loguru import logger

# ---------------------------------------------------------------------------
# URL extraction
# ---------------------------------------------------------------------------

_URL_RE = re.compile(
    r"https?://[^\s\)\]\>\"\u2019\u201d\u300d\u3011\uff09\u300f\u3015\uff3d,，。？！]+",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

_AMAZON_HOSTS = {
    "amazon.com.br", "www.amazon.com.br",
    "amzn.to", "www.amzn.to",
    "amzn.com", "www.amzn.com",
}
_SHOPEE_HOSTS = {
    "shopee.com.br", "www.shopee.com.br",
    "shope.ee", "www.shope.ee",
    "s.shopee.com.br",
}
_ALIEXPRESS_HOSTS = {
    "aliexpress.com", "www.aliexpress.com",
    "s.click.aliexpress.com",
    "pt.aliexpress.com",
}
_MAGALU_HOSTS = {
    "magazineluiza.com.br", "www.magazineluiza.com.br",
    "magalu.com", "www.magalu.com",
    "magazinevoce.com.br", "www.magazinevoce.com.br",
}
_MERCADOLIVRE_HOSTS = {
    "mercadolivre.com.br", "www.mercadolivre.com.br",
    "produto.mercadolivre.com.br", "mlb.link", "www.mlb.link",
    "mercadolibre.com", "www.mercadolibre.com",
}

_ASIN_RE = re.compile(r"/(?:dp|gp/product|exec/obidos/ASIN)/([A-Z0-9]{10})")
_MAGALU_PRODUCT_RE = re.compile(r"/p/([^/]+)/([^/]+)/?$")


def _host(url: str) -> str:
    try:
        return urlparse(url).netloc.lower()
    except Exception:
        return ""


def _platform(url: str) -> Optional[str]:
    host = urlparse(url).netloc.lower()
    clean = host.replace("www.", "", 1)
    if host in _AMAZON_HOSTS or clean in _AMAZON_HOSTS:
        return "amazon"
    if host in _SHOPEE_HOSTS or clean in _SHOPEE_HOSTS:
        return "shopee"
    if host in _ALIEXPRESS_HOSTS or clean in _ALIEXPRESS_HOSTS:
        return "aliexpress"
    if host in _MAGALU_HOSTS or clean in _MAGALU_HOSTS:
        return "magalu"
    if host in _MERCADOLIVRE_HOSTS or clean in _MERCADOLIVRE_HOSTS:
        return "mercadolivre"
    return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# URL expansion
# ---------------------------------------------------------------------------

async def expand_url(url: str, session: aiohttp.ClientSession) -> str:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        )
    }
    try:
        async with session.head(
            url,
            headers=headers,
            allow_redirects=True,
            timeout=aiohttp.ClientTimeout(total=8),
            ssl=False,
        ) as resp:
            final = str(resp.url)
            return final
    except Exception as exc:
        logger.debug(f"expand_url failed for {url}: {exc}")
        return url


# ---------------------------------------------------------------------------
# Affiliate URL builders
# ---------------------------------------------------------------------------

def build_amazon_url(expanded_url: str, tag: str) -> tuple[Optional[str], Optional[str]]:
    """Returns (affiliate_url, error_message)."""
    m = _ASIN_RE.search(expanded_url)
    if not m:
        return None, f"ASIN não encontrado na URL: {expanded_url[:80]}"
    asin = m.group(1)
    return f"https://www.amazon.com.br/dp/{asin}/?tag={tag}", None


def build_shopee_url(expanded_url: str, affiliate_id: str) -> tuple[Optional[str], Optional[str]]:
    parsed = urlparse(expanded_url)
    if "shopee" not in parsed.netloc.lower():
        return None, f"URL expandida não é Shopee: {expanded_url[:80]}"
    encoded = urllib.parse.quote(expanded_url, safe="")
    return f"https://s.shopee.com.br/an_redir?origin_link={encoded}&affiliate_id={affiliate_id}", None


def build_aliexpress_url(expanded_url: str, tracking_id: str) -> tuple[Optional[str], Optional[str]]:
    try:
        parsed = urlparse(expanded_url)
        params = parse_qs(parsed.query, keep_blank_values=True)
        for key in ["aff_fcid", "aff_fsk", "aff_platform", "aff_trace_key", "af_id", "af_ad", "terminal_id"]:
            params.pop(key, None)
        params["aff_platform"] = ["portals-tool"]
        params["af_id"] = [tracking_id]
        new_query = urlencode({k: v[0] for k, v in params.items()}, quote_via=urllib.parse.quote)
        url = urlunparse(parsed._replace(query=new_query))
        return url, None
    except Exception as exc:
        return None, f"Erro ao construir URL AliExpress: {exc}"


def build_magalu_url(expanded_url: str, store_name: str) -> tuple[Optional[str], Optional[str]]:
    try:
        parsed = urlparse(expanded_url)
        m = _MAGALU_PRODUCT_RE.search(parsed.path)
        if m:
            slug, sku = m.group(1), m.group(2)
            return f"https://magazinevoce.com.br/magazine{store_name}/p/{slug}/{sku}/", None
        return None, f"Padrão de produto Magalu não encontrado em: {parsed.path}"
    except Exception as exc:
        return None, f"Erro ao construir URL Magalu: {exc}"


# ---------------------------------------------------------------------------
# TinyURL shortener
# ---------------------------------------------------------------------------

async def shorten_tinyurl(url: str, session: aiohttp.ClientSession) -> tuple[str, Optional[str]]:
    """Returns (final_url, error_message). On error returns original url. Retries up to 3x on 503."""
    api = f"https://tinyurl.com/api-create.php?url={urllib.parse.quote(url, safe='')}"
    last_error: Optional[str] = None

    for attempt in range(3):
        try:
            async with session.get(
                api,
                timeout=aiohttp.ClientTimeout(total=8),
                headers={"User-Agent": "Mozilla/5.0"},
            ) as resp:
                if resp.status == 200:
                    short = (await resp.text()).strip()
                    if short.startswith("https://tinyurl.com/"):
                        return short, None
                    last_error = f"TinyURL resposta inesperada: {short[:60]}"
                elif resp.status in (503, 502, 429) and attempt < 2:
                    last_error = f"TinyURL status {resp.status} (tentativa {attempt + 1}/3)"
                    logger.debug(f"[shorten] {last_error} — aguardando 1s")
                    await asyncio.sleep(1)
                    continue
                else:
                    last_error = f"TinyURL retornou status {resp.status}"
                    break
        except asyncio.TimeoutError:
            last_error = "TinyURL timeout (>8s)"
            if attempt < 2:
                await asyncio.sleep(1)
                continue
            break
        except Exception as exc:
            last_error = f"TinyURL erro: {exc}"
            break

    return url, last_error


# ---------------------------------------------------------------------------
# Main converter
# ---------------------------------------------------------------------------

PLATFORM_LABELS = {
    "amazon":     "Amazon",
    "shopee":     "Shopee",
    "aliexpress": "AliExpress",
    "magalu":     "Magazine Luiza",
    "mercadolivre": "Mercado Livre",
}


class AffiliateConverter:
    """
    Converts product links in message text to affiliate links + shortens them.
    convert() returns (modified_text, events_list).
    """

    def __init__(self, settings: dict) -> None:
        self.amazon_tag   = (settings.get("amazon_affiliate_tag") or "").strip()
        self.shopee_id    = (settings.get("shopee_affiliate_id") or "").strip()
        self.ali_tracking = (settings.get("aliexpress_tracking_id") or "").strip()
        self.magalu_store = (settings.get("magalu_store_name") or "").strip()
        self.shortener_on = settings.get("link_shortener_enabled", "true") != "false"

    async def convert(self, text: str, session: aiohttp.ClientSession) -> tuple[str, list[dict]]:
        """
        Returns (modified_text, events).
        events is a list of dicts with the processing trace for each URL found.
        """
        urls = _URL_RE.findall(text)
        if not urls:
            return text, []

        logger.info(f"[affiliate] Found {len(urls)} URL(s): {urls}")

        seen: set[str] = set()
        unique_urls = [u for u in urls if not (u in seen or seen.add(u))]  # type: ignore[func-returns-value]

        all_events: list[dict] = []
        replacements: dict[str, str] = {}

        for raw_url in unique_urls:
            final_url, event = await self._process_url(raw_url, session)
            all_events.append(event)
            if final_url and final_url != raw_url:
                replacements[raw_url] = final_url
                logger.info(f"[affiliate] Replaced: {raw_url} → {final_url}")

        for original, replacement in replacements.items():
            text = text.replace(original, replacement)

        return text, all_events

    async def _process_url(self, raw_url: str, session: aiohttp.ClientSession) -> tuple[Optional[str], dict]:
        """Process a single URL. Returns (final_url_or_None, event_dict)."""
        event: dict = {
            "ts":         _now_iso(),
            "step":       "url",
            "label":      "Conversão de link",
            "original":   raw_url,
            "expanded":   None,
            "platform":   None,
            "affiliate":  None,
            "shortened":  None,
            "final":      None,
            "status":     "skipped",  # ok | skipped | error
            "error":      None,
        }

        try:
            # Step 1 — expand
            expanded = await expand_url(raw_url, session)
            event["expanded"] = expanded if expanded != raw_url else None

            # Step 2 — detect platform
            platform = _platform(expanded)
            if platform is None:
                platform = _platform(raw_url)
                if platform:
                    expanded = raw_url

            if platform is None:
                event["status"] = "skipped"
                event["error"] = "Plataforma não reconhecida"
                logger.debug(f"[affiliate] Platform not recognized: {expanded[:80]}")
                return None, event

            event["platform"] = PLATFORM_LABELS.get(platform, platform)
            logger.info(f"[affiliate] Platform: {platform} — {expanded[:80]}")

            # Step 3 — build affiliate URL
            affiliate_url, build_error = self._build_affiliate(platform, expanded)
            if affiliate_url is None:
                event["status"] = "error"
                event["error"] = build_error or "Não foi possível gerar link de afiliado"
                logger.warning(f"[affiliate] Build failed ({platform}): {build_error}")
                return None, event

            event["affiliate"] = affiliate_url
            logger.info(f"[affiliate] Affiliate: {affiliate_url[:80]}")

            # Step 4 — shorten
            if self.shortener_on:
                final, shorten_error = await shorten_tinyurl(affiliate_url, session)
                if shorten_error:
                    logger.warning(f"[affiliate] Shorten failed: {shorten_error} — using affiliate URL")
                    event["error"] = f"TinyURL falhou ({shorten_error}) — usando link longo"
                event["shortened"] = final if final != affiliate_url else None
                event["final"] = final
            else:
                final = affiliate_url
                event["final"] = final

            event["status"] = "ok"
            return final, event

        except Exception as exc:
            event["status"] = "error"
            event["error"] = str(exc)
            logger.warning(f"[affiliate] Unexpected error for {raw_url}: {exc}")
            return None, event

    def _build_affiliate(self, platform: str, expanded_url: str) -> tuple[Optional[str], Optional[str]]:
        if platform == "amazon":
            if not self.amazon_tag:
                return None, "Tag Amazon não configurada (vá em Configurações → Links de Afiliado)"
            return build_amazon_url(expanded_url, self.amazon_tag)
        if platform == "shopee":
            if not self.shopee_id:
                return None, "ID Shopee não configurado"
            return build_shopee_url(expanded_url, self.shopee_id)
        if platform == "aliexpress":
            if not self.ali_tracking:
                return None, "Tracking ID AliExpress não configurado"
            return build_aliexpress_url(expanded_url, self.ali_tracking)
        if platform == "magalu":
            if not self.magalu_store:
                return None, "Nome da loja Magalu não configurado"
            return build_magalu_url(expanded_url, self.magalu_store)
        if platform == "mercadolivre":
            return expanded_url, None
        return None, f"Plataforma desconhecida: {platform}"
