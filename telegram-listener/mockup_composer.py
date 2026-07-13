"""
Offer Mockup Composer
======================
Instead of trusting whatever photo/caption came attached to the original
Telegram message, this always regenerates the offer's photo from scratch:
fetches the product's own image from its marketplace page (via the og:image
meta tag — a near-universal standard for link-preview images, so this works
across Amazon/Shopee/AliExpress/Magalu/Mercado Livre without per-site
scraping logic), then pastes it into a branded template.
"""

import asyncio
import re
from io import BytesIO
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse, parse_qs, unquote

import aiohttp
from loguru import logger
from PIL import Image, ImageDraw
from playwright.async_api import async_playwright, Browser, BrowserContext, Playwright

MOCKUP_PATH = Path(__file__).resolve().parent / "assets" / "mockup_template.jpg"

# Detected via pixel analysis of the mockup (largest contiguous near-white
# region) — the blank placeholder rectangle where the product photo goes.
# Re-detect (see scripts/) if the template image is ever replaced.
PLACEHOLDER_BOX = (203, 491, 1588, 1908)  # (left, top, right, bottom)
PLACEHOLDER_CORNER_RADIUS = 50  # matches the template's own rounded-corner style

_OG_IMAGE_RE = re.compile(
    r'<meta[^>]+property=["\']og:image(?::secure_url)?["\'][^>]+content=["\']([^"\']+)["\']',
    re.IGNORECASE,
)
_OG_IMAGE_REVERSED_RE = re.compile(
    r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image(?::secure_url)?["\']',
    re.IGNORECASE,
)
_TWITTER_IMAGE_RE = re.compile(
    r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)["\']',
    re.IGNORECASE,
)
# Amazon doesn't set og:image on product pages at all — the main product
# photo (highest-res variant) sits in data-old-hires on the #landingImage img.
_AMAZON_HIRES_RE = re.compile(r'data-old-hires=["\']([^"\']+)["\']', re.IGNORECASE)


def _looks_like_unresolved_template(url: str) -> bool:
    """Catches raw template placeholders (e.g. "...{sanitized_title}...") that
    slipped into server-rendered HTML unfilled — seen on Mercado Livre list
    pages. Downloading these can still "succeed" against a lenient CDN and
    silently return an unrelated image, so reject them outright."""
    return "{" in url or "}" in url or "${" in url


def _extract_image_from_html(html: str) -> Optional[str]:
    """Tries every known pattern for a representative product image in page HTML."""
    for pattern in (_OG_IMAGE_RE, _OG_IMAGE_REVERSED_RE, _TWITTER_IMAGE_RE, _AMAZON_HIRES_RE):
        match = pattern.search(html)
        if match:
            candidate = match.group(1).replace("&amp;", "&")
            if _looks_like_unresolved_template(candidate):
                logger.debug(f"[mockup] Rejecting unresolved-template image URL: {candidate[:100]}")
                continue
            return candidate
    return None

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
}


async def _fetch_product_image_url(
    product_url: str, session: aiohttp.ClientSession, _allow_gate_retry: bool = True
) -> Optional[str]:
    """Extracts the representative product image URL (og:image) from the product page."""
    # Mercado Livre "list" pages (someone's curated collection, not a single
    # product) have been confirmed to expose an og:image that has NOTHING to
    # do with the promoted item — e.g. a coupon message linking to a filament
    # list resolved to a photo of acrylic paint markers. Wrong photo is worse
    # than no photo, so refuse to even try for this URL shape.
    if "/lists/" in urlparse(product_url).path:
        logger.debug(f"[mockup] Refusing to extract image for a list URL: {product_url[:80]}")
        return None

    try:
        async with session.get(
            product_url,
            headers=_HEADERS,
            allow_redirects=True,
            timeout=aiohttp.ClientTimeout(total=15),
            ssl=False,
        ) as resp:
            if resp.status >= 400:
                return None
            final_url = str(resp.url)
            if "/lists/" in urlparse(final_url).path:
                logger.debug(f"[mockup] Redirected into a list URL, refusing: {final_url[:80]}")
                return None
            html = await resp.text()
    except Exception as exc:
        logger.debug(f"[mockup] Failed to fetch product page {product_url[:80]}: {exc}")
        return None

    # Mercado Livre (and possibly others) gate automated requests behind an
    # anti-bot interstitial that embeds the real destination in ?go= — retry
    # against the unwrapped URL once instead of failing outright.
    if urlparse(final_url).path.startswith("/gz/account-verification"):
        gate_go = parse_qs(urlparse(final_url).query).get("go", [None])[0]
        if gate_go and _allow_gate_retry:
            real_url = unquote(gate_go)
            logger.info(f"[mockup] Unwrapped bot-check gate → {real_url[:80]}")
            return await _fetch_product_image_url(real_url, session, _allow_gate_retry=False)
        return None

    return _extract_image_from_html(html)


async def _download_image(image_url: str, session: aiohttp.ClientSession) -> Optional[bytes]:
    try:
        async with session.get(
            image_url,
            headers=_HEADERS,
            timeout=aiohttp.ClientTimeout(total=15),
            ssl=False,
        ) as resp:
            if resp.status >= 400:
                return None
            return await resp.read()
    except Exception as exc:
        logger.debug(f"[mockup] Failed to download product image {image_url[:80]}: {exc}")
        return None


def _rounded_rect_mask(size: tuple[int, int], radius: int) -> Image.Image:
    """Returns a white-on-black "L" mode mask with rounded-rectangle corners, used as a paste mask."""
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return mask


def _compose(product_image_bytes: bytes) -> bytes:
    """
    Fills PLACEHOLDER_BOX edge-to-edge with the product photo (cropping any
    overflow, never leaving background showing through) and rounds the pasted
    photo's corners to match the template's own rounded-corner frame style.
    """
    template = Image.open(MOCKUP_PATH).convert("RGB")
    product = Image.open(BytesIO(product_image_bytes)).convert("RGB")

    left, top, right, bottom = PLACEHOLDER_BOX
    box_w, box_h = right - left, bottom - top

    # Cover (crop overflow) — fills the box completely so the rounded-corner
    # mask lines up with the template's own frame instead of floating over
    # letterboxed white space.
    scale = max(box_w / product.width, box_h / product.height)
    new_w, new_h = max(1, round(product.width * scale)), max(1, round(product.height * scale))
    product_resized = product.resize((new_w, new_h), Image.LANCZOS)

    crop_x = (new_w - box_w) // 2
    crop_y = (new_h - box_h) // 2
    product_cropped = product_resized.crop((crop_x, crop_y, crop_x + box_w, crop_y + box_h))

    mask = _rounded_rect_mask((box_w, box_h), PLACEHOLDER_CORNER_RADIUS)
    template.paste(product_cropped, (left, top), mask=mask)

    buf = BytesIO()
    template.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


class ProductImageBrowser:
    """
    Generic headless browser — separate from ml_browser's ML-authenticated
    session — used as a fallback when a plain HTTP fetch can't find og:image.
    Amazon/Shopee/Magalu returned anti-bot challenge pages or JS-only shells
    to a bare aiohttp request in testing; a real browser looks more human and
    actually executes the client-side rendering that populates those tags.

    IMPORTANT: this does not solve CAPTCHAs. If a real interactive challenge
    blocks the page, extraction just fails here and the caller falls back to
    sending the offer without a photo — same as any other failure mode.
    """

    def __init__(self) -> None:
        self._playwright: Optional[Playwright] = None
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(
            headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        self._context = await self._browser.new_context(
            user_agent=_HEADERS["User-Agent"], locale="pt-BR",
        )
        logger.info("[mockup] Generic product-image browser started")

    async def stop(self) -> None:
        try:
            if self._context:
                await self._context.close()
            if self._browser:
                await self._browser.close()
            if self._playwright:
                await self._playwright.stop()
        except Exception as exc:
            logger.warning(f"[mockup] Error stopping image browser: {exc}")
        logger.info("[mockup] Generic product-image browser stopped")

    async def fetch_image_url(self, product_url: str) -> Optional[str]:
        if self._context is None:
            return None
        async with self._lock:
            page = await self._context.new_page()
            try:
                await page.goto(product_url, wait_until="domcontentloaded", timeout=20000)
                await page.wait_for_timeout(2500)  # let client-side rendering populate meta tags

                # Parse the fully-rendered DOM as HTML (same regex as the plain-HTTP
                # path) instead of Playwright's locator-based get_attribute, whose
                # auto-waiting defaults to a 30s timeout when the element never
                # appears — far too slow for a "just try it and move on" fallback.
                # Some sites (e.g. Mercado Livre's bot-check gate) trigger a second
                # client-side redirect around this time, so page.content() can
                # transiently fail mid-navigation — wait and retry once before giving up.
                try:
                    html = await page.content()
                except Exception:
                    await page.wait_for_load_state("domcontentloaded", timeout=10000)
                    await page.wait_for_timeout(1500)
                    html = await page.content()
                title = await page.title()
                image_url = _extract_image_from_html(html)
                if not image_url:
                    logger.debug(
                        f"[mockup] Browser render found no product image for {product_url[:80]} "
                        f"(page title: {title!r}, html length: {len(html)})"
                    )
                return image_url
            except Exception as exc:
                logger.debug(f"[mockup] Browser fetch failed for {product_url[:80]}: {exc}")
                return None
            finally:
                await page.close()


_image_browser: Optional[ProductImageBrowser] = None


def get_image_browser() -> ProductImageBrowser:
    global _image_browser
    if _image_browser is None:
        _image_browser = ProductImageBrowser()
    return _image_browser


async def generate_offer_image(
    product_url: str, session: aiohttp.ClientSession
) -> tuple[Optional[bytes], Optional[str]]:
    """Returns (composed_jpeg_bytes, error_message) — bytes is None on any failure."""
    image_url = await _fetch_product_image_url(product_url, session)

    if not image_url:
        logger.info(f"[mockup] Plain fetch failed, trying browser fallback: {product_url[:80]}")
        image_url = await get_image_browser().fetch_image_url(product_url)

    if not image_url:
        return None, "Não foi possível encontrar a imagem do produto na página"

    image_bytes = await _download_image(image_url, session)
    if not image_bytes:
        return None, "Não foi possível baixar a imagem do produto"

    try:
        composed = _compose(image_bytes)
    except Exception as exc:
        logger.warning(f"[mockup] Compose failed for {product_url[:80]}: {exc}")
        return None, f"Falha ao montar a imagem: {exc}"

    return composed, None
