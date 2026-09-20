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
import json
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse, urlencode, urlunparse, parse_qs, urljoin
import urllib.parse

import aiohttp
from loguru import logger

# ---------------------------------------------------------------------------
# URL extraction
# ---------------------------------------------------------------------------

# Emoji glued directly after a URL with no space (common in Telegram ofertas,
# e.g. "confira 🔥https://amzn.to/xyz🚀") used to get captured as part of the
# URL itself, corrupting it before expansion/affiliate conversion — hence the
# \U0001F300-\U0001FAFF / ☀-➿ / variation-selector / ZWJ exclusions.
_URL_RE = re.compile(
    r"https?://[^\s\)\]\>\"\u2019\u201d\u300d\u3011\uff09\u300f\u3015\uff3d,，。？！\U0001F300-\U0001FAFF\u2600-\u27BF\uFE0F\u200D]+",
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


def _host_matches(url: str, domains: set[str]) -> bool:
    """True if the URL's host is one of `domains` or a subdomain of one."""
    host = _host(url)
    if host.startswith("www."):
        host = host[4:]
    return any(host == d or host.endswith("." + d) for d in domains)


def _strip_urls_from_text(text: str, urls: list[str]) -> str:
    """
    Removes the given URLs from a message together with the line that only
    introduced them — e.g. "✅Review no link abaixo:" followed by the link —
    so the group doesn't get a dangling lead-in with nothing under it.
    """
    kept: list[str] = []
    for line in text.split("\n"):
        if not any(u in line for u in urls):
            kept.append(line)
            continue
        for u in urls:
            line = line.replace(u, "")
        remaining = line.strip()
        if not re.sub(r"[\W_]+", "", remaining):
            # The line was just the URL (plus emoji/punctuation): drop it, and
            # the "…abaixo:" style lead-in line right above it.
            if kept and kept[-1].rstrip().endswith(":"):
                kept.pop()
            continue
        if remaining.endswith(":"):
            continue  # "Review: <url>" → nothing left after the colon
        kept.append(line.rstrip())
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# URL expansion
# ---------------------------------------------------------------------------

_MARKETPLACE_URL_RE = re.compile(
    r"https?://(?:www\.)?(?:amazon\.com\.br|amazon\.com|amzn\.to|shopee\.com\.br|shope\.ee|s\.shopee\.com\.br|aliexpress\.com|s\.click\.aliexpress\.com|magazineluiza\.com\.br|magalu\.com|magazinevoce\.com\.br|mercadolivre\.com\.br|meli\.la|mlb\.link|mercadolibre\.com)[^\s\"'<>)\u2019\u201d\u300d\u3011\uff09\u300f\u3015\uff3d,，。？！\U0001F300-\U0001FAFF\u2600-\u27BF\uFE0F\u200D]+"
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


# HTTP statuses that mean "the server refused our plain HTTP request" (bot
# protection / rate limit) rather than "this link doesn't exist" — see
# expand_url_ex(): a real browser often gets through where aiohttp doesn't.
_BLOCK_STATUSES = {401, 403, 429, 503}

# Link-shortener family used by many Brazilian promo channels
# (amzon.promo/s/xxxxxx, meli.promo/s/xxxxxx, ...). They 302 straight to the
# marketplace, but sit behind Cloudflare, which tends to refuse plain aiohttp
# requests from a datacenter IP. Matching the shape lets us go straight to
# the browser fallback even when the refusal isn't a clean 403.
_SHORTENER_PATH_RE = re.compile(r"^/s/[A-Za-z0-9]{4,12}/?$")


def looks_like_shortener(url: str) -> bool:
    try:
        return bool(_SHORTENER_PATH_RE.match(urlparse(url).path))
    except Exception:
        return False


async def expand_url(url: str, session: aiohttp.ClientSession) -> str:
    expanded, _blocked = await expand_url_ex(url, session)
    return expanded


async def expand_url_ex(url: str, session: aiohttp.ClientSession) -> tuple[str, bool]:
    """
    Follows redirects to the final URL. Returns (final_url, blocked), where
    blocked=True means the server answered with a bot-protection style status
    (401/403/429/503) — the caller can then retry with a real browser instead
    of silently treating the link as "platform not recognized".
    """
    blocked = False
    head_status: Optional[int] = None
    get_status: Optional[int] = None

    # Pre-check: try to extract from query parameters to save requests
    query_extracted = _extract_url_from_query(url)
    if query_extracted:
        # Recursively expand the extracted URL in case it is another short link
        return await expand_url_ex(query_extracted, session)

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
            head_status = resp.status
            if resp.status < 400:
                final_url = str(resp.url)
                if _platform(final_url):
                    return final_url, False
                logger.debug(f"expand_url HEAD returned non-platform url: {final_url}")
            elif resp.status in _BLOCK_STATUSES:
                blocked = True
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
            get_status = resp.status
            if resp.status in _BLOCK_STATUSES:
                blocked = True
            final_url = str(resp.url)
            if _platform(final_url):
                return final_url, False

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
                    return resolved_url, False

            # Nothing resolved to a marketplace. Log WHY at INFO — this used to
            # be invisible (DEBUG, or nothing at all), which is what made a whole
            # channel's links fail as "Plataforma não reconhecida" with no clue.
            logger.info(
                f"[expand] no marketplace URL for {url[:70]} "
                f"(HEAD={head_status}, GET={get_status}, final={final_url[:80]}, blocked={blocked})"
            )
            return final_url, blocked
    except Exception as exc:
        logger.info(
            f"[expand] request failed for {url[:70]} (HEAD={head_status}, GET={get_status}): {exc}"
        )
        return url, blocked


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


_ML_SOCIAL_SHOW_PRODUCT_RE = re.compile(r'"id":"show_product"[^{}]*?"url":"((?:[^"\\]|\\.)*)"')

_ML_TRACKING_QUERY_KEYS = {
    "matt_word", "matt_tool", "matt_tool_id",
    "matt_event_ts", "matt_d2id", "matt_tracing_id", "tid",
}


async def resolve_ml_social_product_url(social_url: str, session: aiohttp.ClientSession) -> Optional[str]:
    """
    Mercado Livre "social profile" links (mercadolivre.com.br/social/<handle>?...&ref=...,
    generated by the official "Compartilhar" affiliate tool) don't expose the target
    product in the URL itself — it's encoded in the opaque `ref` token and only resolved
    client-side via JavaScript. However, the server DOES render a JSON payload in the raw
    HTML (no JS needed) with a "show_product" action link pointing at the real product
    permalink — still tagged with the ORIGINAL affiliate's matt_tool_id, which we strip
    off before re-tagging with our own affiliate params.
    Returns the clean product URL (no query/fragment), or None if not found (e.g. the
    link is a generic profile/list page with no single featured product).
    """
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    }
    html = None
    # One retry: this page is slow/flaky from a datacenter IP, and a bare
    # timeout used to be swallowed (blank message at DEBUG) — turning a
    # transient hiccup into "perfil/lista de outro afiliado" and a rejected offer.
    for attempt in (1, 2):
        try:
            async with session.get(
                social_url,
                headers=headers,
                allow_redirects=True,
                timeout=aiohttp.ClientTimeout(total=12),
                ssl=False,
            ) as resp:
                if resp.status >= 400:
                    logger.info(f"[affiliate] ML social profile page returned HTTP {resp.status}")
                    return None
                html = await resp.text()
                break
        except Exception as exc:
            logger.info(f"[affiliate] Failed to fetch ML social profile page (attempt {attempt}/2): {exc!r}")
    if html is None:
        return None

    match = _ML_SOCIAL_SHOW_PRODUCT_RE.search(html)
    if not match:
        return None

    raw_url = match.group(1)
    try:
        # The URL comes JSON-string-escaped (e.g. / for '/') — decode it properly
        decoded_url = json.loads(f'"{raw_url}"')
    except Exception:
        decoded_url = raw_url.replace("\\u002F", "/").replace("\\/", "/")

    parsed = urlparse(decoded_url)
    if not _platform(decoded_url):
        return None
    # Strip only the tracking/session params (the ORIGINAL affiliate's matt_tool_id +
    # recommendation-engine ids) — keep product-identifying params like pdp_filters
    # (selects which specific seller/offer wins the "buy box" on catalog listings),
    # otherwise the page may show a different seller/price than what was promoted.
    params = parse_qs(parsed.query, keep_blank_values=True)
    for k in _ML_TRACKING_QUERY_KEYS:
        params.pop(k, None)
    new_query = urlencode({k: v[0] for k, v in params.items()}, quote_via=urllib.parse.quote)
    return urlunparse(parsed._replace(query=new_query, fragment=""))


# NOTE: Mercado Livre affiliate links are no longer built by tagging query
# params (matt_word/matt_tool) onto the URL ourselves — comparing our own
# click tracking against Mercado Livre's own affiliate metrics dashboard
# confirmed that mechanism registers ZERO clicks/commission on their side.
# The only confirmed-working mechanism is their official Link Builder tool,
# automated via a real logged-in browser session — see ml_browser.py.


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

    def __init__(self, settings: dict, ml_session=None) -> None:
        self.amazon_tag      = (settings.get("amazon_affiliate_tag") or "").strip()
        self.shopee_id       = (settings.get("shopee_affiliate_id") or "").strip()
        self.ali_tracking    = (settings.get("aliexpress_tracking_id") or "").strip()
        self.magalu_store    = (settings.get("magalu_store_name") or "").strip()
        # Domains whose links are removed from messages instead of converted
        # (own site / review pages / Instagram) — comma or newline separated.
        self.strip_domains: set[str] = set()
        for d in re.split(r"[,\n]+", settings.get("strip_link_domains") or ""):
            d = d.strip().lower()
            if d.startswith("www."):
                d = d[4:]
            if d:
                self.strip_domains.add(d)
        self.ml_session = ml_session  # ml_browser.MLBrowserSession, generates real ML affiliate links
        self.ml_own_list_url = (settings.get("ml_own_list_url") or "").strip()
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

        # Links to configured domains (the channel's own site, review pages,
        # Instagram…) are REMOVED from the message rather than converted: they
        # aren't offers, each one used to cost an extra (slow) conversion, and
        # being "unrecognized" they made the API reject the whole message.
        strip_urls = [u for u in unique_urls if self.strip_domains and _host_matches(u, self.strip_domains)]
        if strip_urls:
            unique_urls = [u for u in unique_urls if u not in strip_urls]
            text = _strip_urls_from_text(text, strip_urls)
            for u in strip_urls:
                all_events.append({
                    "ts": _now_iso(), "step": "link_strip", "status": "info",
                    "label": "Link removido", "detail": f"{u} (domínio configurado pra remoção)",
                })
                logger.info(f"[affiliate] Stripped link from message: {u[:80]}")
            if not unique_urls:
                # Nothing but stripped links — not an offer. Keep it blocked
                # (same as before, when the unrecognized link rejected it).
                all_events.append({
                    "ts": _now_iso(), "step": "url", "label": "Conversão de link",
                    "original": strip_urls[0], "expanded": None, "platform": None, "affiliate": None,
                    "shortened": None, "final": None, "status": "skipped",
                    "error": "Mensagem sem link de oferta (só links removidos)",
                })
                return text, all_events

        # Convert the message's links CONCURRENTLY. They used to run one after
        # another, so a post with several slow links (each Mercado Livre one
        # needs the browser, ~10-25s) blew the 90s per-message budget on the sum
        # alone — even with the browser page pool sitting idle. The pool and the
        # redirect-resolver semaphore already cap real browser concurrency; this
        # just bounds how many links of one message are in flight at once.
        # gather() keeps results in input order, so the events stay ordered.
        sem = asyncio.Semaphore(4)

        async def _run(url: str) -> tuple[Optional[str], dict]:
            async with sem:
                return await self._process_url(url, session)

        results = await asyncio.gather(*(_run(u) for u in unique_urls), return_exceptions=True)

        for raw_url, result in zip(unique_urls, results):
            if isinstance(result, Exception):
                logger.warning(f"[affiliate] Unexpected error converting {raw_url[:80]}: {result!r}")
                all_events.append({
                    "ts": _now_iso(), "step": "url", "label": "Conversão de link",
                    "original": raw_url, "expanded": None, "platform": None, "affiliate": None,
                    "shortened": None, "final": None, "status": "error", "error": f"Erro inesperado: {result}",
                })
                continue
            final_url, event = result
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
            expanded, blocked = await expand_url_ex(raw_url, session)

            # Plain HTTP couldn't reach a marketplace: either the server refused
            # us (403/429/503 — bot protection) or it's one of the /s/xxxxxx
            # promo shorteners that sit behind Cloudflare. A real browser gets
            # through where aiohttp doesn't — ask it to follow the redirect
            # instead of giving up with "Plataforma não reconhecida".
            if (
                _platform(expanded) is None
                and _platform(raw_url) is None
                and (blocked or looks_like_shortener(raw_url))
                and self.ml_session is not None
            ):
                browser_url = await self.ml_session.resolve_redirect(raw_url)
                if browser_url and browser_url != raw_url and _platform(browser_url):
                    logger.info(f"[affiliate] Browser resolved {raw_url[:60]} → {browser_url[:80]}")
                    expanded = browser_url
                else:
                    logger.warning(
                        f"[affiliate] Browser fallback could not resolve {raw_url[:60]} "
                        f"(got: {(browser_url or 'nothing')[:80]})"
                    )

            event["expanded"] = expanded if expanded != raw_url else None

            # Mercado Livre sometimes gates automated requests with an interstitial
            # "prove you're not a bot" page (mercadolivre.com.br/gz/account-verification)
            # instead of the real product. The intended destination is embedded in the
            # ?go= query param — unwrap it so we don't tag affiliate params onto the gate.
            gate_parsed = urlparse(expanded)
            if gate_parsed.path.startswith("/gz/account-verification"):
                gate_go = parse_qs(gate_parsed.query).get("go", [None])[0]
                if gate_go:
                    expanded = urllib.parse.unquote(gate_go)
                    event["expanded"] = expanded
                    logger.info(f"[affiliate] Unwrapped ML bot-check gate → {expanded[:80]}")

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

            # Mercado Livre "social profile" links (someone else's affiliate share, e.g.
            # mercadolivre.com.br/social/<handle>?...&ref=...) don't point at a usable
            # product URL directly — try to resolve the featured product's real permalink
            # from the page's embedded data first.
            ml_direct_affiliate: Optional[str] = None
            if platform == "mercadolivre" and "/social/" in urlparse(expanded).path:
                resolved = await resolve_ml_social_product_url(expanded, session)
                if resolved:
                    logger.info(f"[affiliate] Resolved ML social link to product: {resolved[:80]}")
                    expanded = resolved
                elif "/lists/" in urlparse(expanded).path and self.ml_own_list_url:
                    # Someone else's list — there's no way to attribute a specific product
                    # to us, so swap it for the user's own configured list link instead of
                    # blocking the offer entirely.
                    ml_direct_affiliate = self.ml_own_list_url
                    logger.info(f"[affiliate] ML list link swapped for own list: {ml_direct_affiliate[:80]}")
                else:
                    event["status"] = "error"
                    event["error"] = (
                        "Link do Mercado Livre é de perfil/lista de outro afiliado — não foi "
                        "possível identificar um produto específico pra converter"
                    )
                    logger.warning(f"[affiliate] Could not resolve ML social link: {expanded[:80]}")
                    return None, event

            # Step 3 — build affiliate URL
            if ml_direct_affiliate is not None:
                affiliate_url, build_error = ml_direct_affiliate, None
            elif platform == "mercadolivre":
                if self.ml_session is None:
                    affiliate_url, build_error = None, "Automação do Mercado Livre não inicializada"
                else:
                    affiliate_url, build_error = await self.ml_session.generate_affiliate_link(expanded)
                    # One retry — most failures here are transient (slow page
                    # load, element not ready yet, a stuck page the pool
                    # already swapped out), not a real selector/site change.
                    # Skip it for an expired session — retrying that is
                    # guaranteed to fail again identically.
                    if affiliate_url is None and build_error and "expirada" not in build_error:
                        logger.info(f"[affiliate] ML link generation failed once, retrying: {build_error}")
                        affiliate_url, build_error = await self.ml_session.generate_affiliate_link(expanded)
            else:
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
        return None, f"Plataforma desconhecida: {platform}"
