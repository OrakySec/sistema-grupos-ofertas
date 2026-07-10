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
- Mercado Livre    (mercadolivre.com.br / meli.la / mlb.link)

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
    "meli.la", "www.meli.la",
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

_MARKETPLACE_URL_RE = re.compile(
    r"https?://(?:www\.)?(?:amazon\.com\.br|amazon\.com|amzn\.to|shopee\.com\.br|shope\.ee|s\.shopee\.com\.br|aliexpress\.com|s\.click\.aliexpress\.com|magazineluiza\.com\.br|magalu\.com|magazinevoce\.com\.br|mercadolivre\.com\.br|meli\.la|mlb\.link|mercadolibre\.com)[^\s\"'<>)\u2019\u201d\u300d\u3011\uff09\u300f\u3015\uff3d,，。？！]+"
)

def _find_redirect_url_in_html(html: str) -> Optional[str]:
    # 1. Try to find meta refresh URL
    meta_match = re.search(
        r'<meta\s+http-equiv=["\']refresh["\']\s+content=["\'].*?url=([^"\']+)["\']',
        html,
        re.IGNORECASE
    )
    if meta_match:
        import html as html_lib
        return html_lib.unescape(meta_match.group(1).strip())

    # 2. Try to find window.location/location redirects (redundant patterns)
    js_patterns = [
        r'window\.location(?:\.href)?\s*=\s*["\']([^"\']+)["\']',
        r'location\.replace\(\s*["\']([^"\']+)["\']\s*\)',
        r'location\.href\s*=\s*["\']([^"\']+)["\']',
        r'window\.location\.replace\(\s*["\']([^"\']+)["\']\s*\)',
        r'window\.navigate\(\s*["\']([^"\']+)["\']\s*\)',
        r'self\.location(?:\.href)?\s*=\s*["\']([^"\']+)["\']',
        r'top\.location(?:\.href)?\s*=\s*["\']([^"\']+)["\']',
    ]
    for pattern in js_patterns:
        js_match = re.search(pattern, html, re.IGNORECASE)
        if js_match:
            return js_match.group(1).strip()

    # 3. Try to find marketplace URLs inside JSON blocks (e.g. structured data or page variables)
    json_patterns = [
        r'"url"\s*:\s*"(https?://[^"]+)"',
        r'"targetUrl"\s*:\s*"(https?://[^"]+)"',
        r'"redirectUrl"\s*:\s*"(https?://[^"]+)"',
    ]
    for pattern in json_patterns:
        for json_match in re.finditer(pattern, html, re.IGNORECASE):
            found_url = json_match.group(1).replace("\\/", "/")  # unescape JSON slashes
            if _platform(found_url):
                return found_url

    # 4. Find the first link in the HTML body that points to a recognized marketplace
    marketplace_match = _MARKETPLACE_URL_RE.search(html)
    if marketplace_match:
        import html as html_lib
        return html_lib.unescape(marketplace_match.group(0))

    return None


def _extract_url_from_query(url: str) -> Optional[str]:
    """Check if the URL query string contains a marketplace URL as a parameter."""
    try:
        parsed = urlparse(url)
        params = parse_qs(parsed.query)
        for key, values in params.items():
            for val in values:
                val = val.strip()
                if val.startswith(("http://", "https://")):
                    if _platform(val):
                        logger.info(f"Extracted marketplace URL from query parameter '{key}': {val[:80]}")
                        return val
    except Exception as exc:
        logger.debug(f"Failed to extract URL from query parameters of {url}: {exc}")
    return None


async def expand_url(url: str, session: aiohttp.ClientSession) -> str:
    # Pre-check: try to extract from query parameters to save requests
    query_extracted = _extract_url_from_query(url)
    if query_extracted:
        # Recursively expand the extracted URL in case it is another short link
        return await expand_url(query_extracted, session)

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "max-age=0",
        "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Upgrade-Insecure-Requests": "1",
    }
    try:
        # Try HEAD first
        async with session.head(
            url,
            headers=headers,
            allow_redirects=True,
            timeout=aiohttp.ClientTimeout(total=8),
            ssl=False,
        ) as resp:
            if resp.status < 400:
                final_url = str(resp.url)
                if _platform(final_url):
                    return final_url
                logger.debug(f"expand_url HEAD returned non-platform url: {final_url}")
    except Exception as exc:
        logger.debug(f"expand_url HEAD failed for {url}: {exc}")

    # Fallback to GET
    try:
        async with session.get(
            url,
            headers=headers,
            allow_redirects=True,
            timeout=aiohttp.ClientTimeout(total=8),
            ssl=False,
        ) as resp:
            final_url = str(resp.url)
            if _platform(final_url):
                return final_url
            
            # If not a recognized platform, check HTML content
            content_type = resp.headers.get("Content-Type", "")
            if "text/html" in content_type.lower():
                html_body = await resp.text()
                extracted_url = _find_redirect_url_in_html(html_body)
                if extracted_url:
                    # Resolve relative URLs if any
                    resolved_url = urljoin(str(resp.url), extracted_url)
                    logger.info(f"Extracted destination URL from HTML: {resolved_url[:80]}")
                    
                    # If the extracted URL is also a short URL or another redirect, recursively expand it once
                    if not _platform(resolved_url):
                        logger.debug(f"Recursively expanding extracted URL: {resolved_url[:80]}")
                        try:
                            async with session.head(
                                resolved_url,
                                headers=headers,
                                allow_redirects=True,
                                timeout=aiohttp.ClientTimeout(total=8),
                                ssl=False,
                            ) as r_resp:
                                if r_resp.status < 400:
                                    resolved_url = str(r_resp.url)
                        except Exception:
                            pass
                    return resolved_url
            return final_url
    except Exception as exc:
        logger.debug(f"expand_url GET failed for {url}: {exc}")
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


_ML_SOCIAL_PATH_RE = re.compile(r"^(/social/)([^/]+)(/.*)?$")


def build_mercadolivre_url(expanded_url: str, affiliate_id: str) -> tuple[Optional[str], Optional[str]]:
    """
    Mercado Livre "social" share links (e.g. mercadolivre.com.br/social/<handle>/lists/...
    or /social/<handle>/p/...) carry the affiliate attribution in the <handle> PATH
    segment right after /social/ — NOT in a query parameter. If we only add a query
    param and leave that segment untouched, the commission still goes to whoever's
    handle is already baked into the shared link.
    Works for direct product links and expanded meli.la / mlb.link short links.
    """
    try:
        parsed = urlparse(expanded_url)
        social_match = _ML_SOCIAL_PATH_RE.match(parsed.path)

        # Remove any existing affiliate-related params to avoid duplicates
        params = parse_qs(parsed.query, keep_blank_values=True)
        for p in ["affiliate", "campId", "affiliate_id", "matt_tool", "matt_word"]:
            params.pop(p, None)
        params["campId"] = [affiliate_id]
        # matt_word is Mercado Livre's real affiliate query param (confirmed via a
        # working third-party affiliate-link generator's source). We don't have a
        # matt_tool value configured, but sending matt_word alone is still closer
        # to the real mechanism than campId (which isn't documented anywhere for ML).
        params["matt_word"] = [affiliate_id]
        new_query = urlencode({k: v[0] for k, v in params.items()}, quote_via=urllib.parse.quote)

        if social_match:
            # Replace the embedded handle (someone else's affiliate account) with ours
            new_path = f"{social_match.group(1)}{affiliate_id}{social_match.group(3) or ''}"
            url = urlunparse(parsed._replace(path=new_path, query=new_query))
        else:
            url = urlunparse(parsed._replace(query=new_query))

        return url, None
    except Exception as exc:
        return None, f"Erro ao construir URL Mercado Livre: {exc}"


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


async def shorten_internal(url: str, session: aiohttp.ClientSession, internal_api_url: str, internal_token: str) -> tuple[str, Optional[str]]:
    """Shortens a URL using our own internal shortener endpoint."""
    api = f"{internal_api_url}/s/internal"
    try:
        async with session.post(
            api,
            json={"url": url},
            headers={"X-Internal-Key": internal_token},
            timeout=aiohttp.ClientTimeout(total=8),
        ) as resp:
            if resp.status == 200:
                res_data = await resp.json()
                short_url = res_data.get("shortUrl")
                if short_url:
                    return short_url, None
                return url, "API retornou JSON sem shortUrl"
            else:
                body = await resp.text()
                return url, f"API retornou status {resp.status}: {body[:60]}"
    except Exception as exc:
        return url, f"Erro de conexão com API interna: {exc}"


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
        self.amazon_tag      = (settings.get("amazon_affiliate_tag") or "").strip()
        self.shopee_id       = (settings.get("shopee_affiliate_id") or "").strip()
        self.ali_tracking    = (settings.get("aliexpress_tracking_id") or "").strip()
        self.magalu_store    = (settings.get("magalu_store_name") or "").strip()
        self.ml_affiliate_id = (settings.get("ml_affiliate_id") or "").strip()
        self.shortener_on = settings.get("link_shortener_enabled", "true") != "false"
        self.shortener_provider = settings.get("shortener_provider", "internal")
        self.internal_api_url = settings.get("internal_api_url", "http://api:3001")
        self.internal_token = settings.get("internal_token", "")

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
                if self.shortener_provider == "tinyurl":
                    final, shorten_error = await shorten_tinyurl(affiliate_url, session)
                    if shorten_error:
                        logger.warning(f"[affiliate] TinyURL shorten failed: {shorten_error} — using affiliate URL")
                        event["error"] = f"TinyURL falhou ({shorten_error}) — usando link longo"
                else:
                    final, shorten_error = await shorten_internal(affiliate_url, session, self.internal_api_url, self.internal_token)
                    if shorten_error:
                        logger.warning(f"[affiliate] Internal shorten failed: {shorten_error} — using affiliate URL")
                        event["error"] = f"Encurtador interno falhou ({shorten_error}) — usando link longo"
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
            if not self.ml_affiliate_id:
                return None, "ID de afiliado do Mercado Livre não configurado (vá em Configurações → Links de Afiliado)"
            return build_mercadolivre_url(expanded_url, self.ml_affiliate_id)
        return None, f"Plataforma desconhecida: {platform}"
