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

Pipeline per URL found in the message text
------------------------------------------
1. expand_url()         — follow redirects to get the real product URL
2. identify_platform()  — which store is this?
3. build_affiliate_url()— inject the affiliate tag/id
4. shorten_url()        — shorten via TinyURL (if shortening is enabled)
5. Replace original URL in the text with the final URL
"""

import re
import asyncio
from typing import Optional
from urllib.parse import urlparse, urlencode, urlunparse, parse_qs, urljoin
import urllib.parse

import aiohttp
from loguru import logger

# ---------------------------------------------------------------------------
# URL extraction — grab every http/https URL from free text
# ---------------------------------------------------------------------------

_URL_RE = re.compile(
    r"https?://[^\s\)\]\>\"\u2019\u201d\u300d\u3011\uff09\u300f\u3015\uff3d,，。？！]+",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Platform detection helpers
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

# ASIN regex: 10 uppercase alphanumeric characters
_ASIN_RE = re.compile(r"/(?:dp|gp/product|exec/obidos/ASIN)/([A-Z0-9]{10})")

# Magalu product URL: /p/{slug}/{id}/
_MAGALU_PRODUCT_RE = re.compile(r"/p/([^/]+)/([^/]+)/?$")
# Magalu alternate: /{name}/{sku}/p
_MAGALU_ALT_RE = re.compile(r"/([^/]+)/p$")


def _host(url: str) -> str:
    try:
        return urlparse(url).netloc.lower().lstrip("www.")
    except Exception:
        return ""


def _platform(url: str) -> Optional[str]:
    host = urlparse(url).netloc.lower()
    clean = host.lstrip("www.")
    if clean in _AMAZON_HOSTS or host in _AMAZON_HOSTS:
        return "amazon"
    if clean in _SHOPEE_HOSTS or host in _SHOPEE_HOSTS:
        return "shopee"
    if clean in _ALIEXPRESS_HOSTS or host in _ALIEXPRESS_HOSTS:
        return "aliexpress"
    if clean in _MAGALU_HOSTS or host in _MAGALU_HOSTS:
        return "magalu"
    return None


# ---------------------------------------------------------------------------
# URL expansion — follow HTTP redirects asynchronously
# ---------------------------------------------------------------------------

async def expand_url(url: str, session: aiohttp.ClientSession) -> str:
    """Follow redirects and return the final URL. Returns original on failure."""
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
            if final != url:
                logger.debug(f"Expanded: {url} → {final}")
            return final
    except Exception as exc:
        logger.debug(f"expand_url failed for {url}: {exc}")
        return url


# ---------------------------------------------------------------------------
# Affiliate URL builders
# ---------------------------------------------------------------------------

def build_amazon_url(expanded_url: str, tag: str) -> Optional[str]:
    """Extract ASIN and build a clean affiliate URL."""
    m = _ASIN_RE.search(expanded_url)
    if not m:
        logger.debug(f"Amazon: no ASIN found in {expanded_url}")
        return None
    asin = m.group(1)
    url = f"https://www.amazon.com.br/dp/{asin}/?tag={tag}"
    logger.info(f"Amazon affiliate: {expanded_url} → {url}")
    return url


def build_shopee_url(expanded_url: str, affiliate_id: str) -> Optional[str]:
    """Wrap original product URL in the Shopee affiliate redirect."""
    # Make sure we have a proper shopee.com.br product URL after expansion
    parsed = urlparse(expanded_url)
    host = parsed.netloc.lower()
    if "shopee" not in host:
        logger.debug(f"Shopee: expanded URL is not shopee: {expanded_url}")
        return None
    encoded = urllib.parse.quote(expanded_url, safe="")
    url = f"https://s.shopee.com.br/an_redir?origin_link={encoded}&affiliate_id={affiliate_id}"
    logger.info(f"Shopee affiliate: {expanded_url} → {url}")
    return url


def build_aliexpress_url(expanded_url: str, tracking_id: str) -> Optional[str]:
    """Add/replace affiliate parameters in the AliExpress URL."""
    try:
        parsed = urlparse(expanded_url)
        params = parse_qs(parsed.query, keep_blank_values=True)

        # Remove existing affiliate params to avoid conflicts
        for key in ["aff_fcid", "aff_fsk", "aff_platform", "aff_trace_key",
                    "af_id", "af_ad", "terminal_id"]:
            params.pop(key, None)

        # Inject our tracking
        params["aff_platform"] = ["portals-tool"]
        params["af_id"] = [tracking_id]

        new_query = urlencode(
            {k: v[0] for k, v in params.items()},
            quote_via=urllib.parse.quote,
        )
        url = urlunparse(parsed._replace(query=new_query))
        logger.info(f"AliExpress affiliate: {expanded_url} → {url}")
        return url
    except Exception as exc:
        logger.debug(f"AliExpress build failed: {exc}")
        return None


def build_magalu_url(expanded_url: str, store_name: str) -> Optional[str]:
    """Convert a magalu/magazineluiza URL to a Parceiro Magalu affiliate URL."""
    try:
        parsed = urlparse(expanded_url)
        path = parsed.path

        # Pattern: /p/{slug}/{sku}/
        m = _MAGALU_PRODUCT_RE.search(path)
        if m:
            slug, sku = m.group(1), m.group(2)
            url = f"https://magazinevoce.com.br/magazine{store_name}/p/{slug}/{sku}/"
            logger.info(f"Magalu affiliate: {expanded_url} → {url}")
            return url

        logger.debug(f"Magalu: no product pattern found in {expanded_url}")
        return None
    except Exception as exc:
        logger.debug(f"Magalu build failed: {exc}")
        return None


# ---------------------------------------------------------------------------
# TinyURL shortener
# ---------------------------------------------------------------------------

async def shorten_tinyurl(url: str, session: aiohttp.ClientSession) -> str:
    """Shorten a URL using TinyURL's free API. Returns original on failure."""
    api = f"https://tinyurl.com/api-create.php?url={urllib.parse.quote(url, safe='')}"
    try:
        async with session.get(
            api,
            timeout=aiohttp.ClientTimeout(total=8),
            headers={"User-Agent": "Mozilla/5.0"},
        ) as resp:
            if resp.status == 200:
                short = (await resp.text()).strip()
                if short.startswith("https://tinyurl.com/"):
                    logger.info(f"Shortened: {url} → {short}")
                    return short
    except Exception as exc:
        logger.debug(f"TinyURL failed for {url}: {exc}")
    return url


# ---------------------------------------------------------------------------
# Main converter
# ---------------------------------------------------------------------------

class AffiliateConverter:
    """
    Converts product links in message text to affiliate links + shortens them.

    Settings dict expected keys (all optional — skips platform if missing):
      amazon_affiliate_tag   : str
      shopee_affiliate_id    : str
      aliexpress_tracking_id : str
      magalu_store_name      : str
      link_shortener_enabled : str  "true" | "false"  (default: "true")
    """

    def __init__(self, settings: dict) -> None:
        self.amazon_tag      = (settings.get("amazon_affiliate_tag") or "").strip()
        self.shopee_id       = (settings.get("shopee_affiliate_id") or "").strip()
        self.ali_tracking    = (settings.get("aliexpress_tracking_id") or "").strip()
        self.magalu_store    = (settings.get("magalu_store_name") or "").strip()
        self.shortener_on    = settings.get("link_shortener_enabled", "true") != "false"

    async def convert(self, text: str, session: aiohttp.ClientSession) -> str:
        """
        Find all URLs in *text*, convert affiliate links, shorten, and return
        the modified text. Returns original text unchanged if no URLs found or
        no affiliate settings are configured.
        """
        urls = _URL_RE.findall(text)
        if not urls:
            return text

        # Deduplicate while preserving order
        seen: set[str] = set()
        unique_urls = [u for u in urls if not (u in seen or seen.add(u))]  # type: ignore[func-returns-value]

        replacements: dict[str, str] = {}

        for raw_url in unique_urls:
            final = await self._process_url(raw_url, session)
            if final and final != raw_url:
                replacements[raw_url] = final

        if not replacements:
            return text

        for original, replacement in replacements.items():
            text = text.replace(original, replacement)

        return text

    async def _process_url(self, raw_url: str, session: aiohttp.ClientSession) -> Optional[str]:
        """Process a single URL through the full pipeline."""
        try:
            # Step 1 — expand redirects (resolves amzn.to, shope.ee, bit.ly, etc.)
            expanded = await expand_url(raw_url, session)

            # Step 2 — identify platform from expanded URL
            platform = _platform(expanded)

            # If still a shortener after expansion, try raw URL as fallback
            if platform is None:
                platform = _platform(raw_url)
                if platform:
                    expanded = raw_url  # use raw if platform detected from original

            if platform is None:
                return None  # not a supported platform

            # Step 3 — build affiliate URL
            affiliate_url = self._build_affiliate(platform, expanded)
            if affiliate_url is None:
                return None  # platform matched but couldn't build URL (e.g. no ASIN, missing config)

            # Step 4 — shorten
            if self.shortener_on:
                final = await shorten_tinyurl(affiliate_url, session)
            else:
                final = affiliate_url

            return final

        except Exception as exc:
            logger.warning(f"AffiliateConverter._process_url failed for {raw_url}: {exc}")
            return None

    def _build_affiliate(self, platform: str, expanded_url: str) -> Optional[str]:
        """Dispatch to the correct affiliate URL builder."""
        if platform == "amazon":
            if not self.amazon_tag:
                logger.debug("Amazon: no affiliate tag configured — skipping")
                return None
            return build_amazon_url(expanded_url, self.amazon_tag)

        if platform == "shopee":
            if not self.shopee_id:
                logger.debug("Shopee: no affiliate id configured — skipping")
                return None
            return build_shopee_url(expanded_url, self.shopee_id)

        if platform == "aliexpress":
            if not self.ali_tracking:
                logger.debug("AliExpress: no tracking id configured — skipping")
                return None
            return build_aliexpress_url(expanded_url, self.ali_tracking)

        if platform == "magalu":
            if not self.magalu_store:
                logger.debug("Magalu: no store name configured — skipping")
                return None
            return build_magalu_url(expanded_url, self.magalu_store)

        return None
