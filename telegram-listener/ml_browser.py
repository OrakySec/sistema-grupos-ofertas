"""
Mercado Livre Affiliate Link Builder (browser automation)
===========================================================
Generates real, working Mercado Livre affiliate links using the official
"Link Builder" tool (mercadolivre.com.br/afiliados/linkbuilder) via a
persistent, already-logged-in Playwright browser session.

Why this exists: Mercado Livre has no public affiliate API. Tagging a
product URL with ?matt_word=&matt_tool= manually (the previous approach)
was confirmed NOT to register any click/commission attribution — comparing
our own click tracking against Mercado Livre's own affiliate metrics
dashboard showed real clicks but zero registered on their side. The only
confirmed-working mechanism is the official Link Builder tool itself.

The browser is launched once and reused across link generations (launching
a fresh browser per link would add several seconds of pure startup overhead
on top of the generation itself). Login happens OUTSIDE this system — see
scripts/gerar_sessao_ml.py — this module only ever loads a previously
exported storage_state (cookies), never handles credentials.
"""

import asyncio
import os
import time
from pathlib import Path
from typing import Optional

from loguru import logger
from playwright.async_api import async_playwright, Browser, BrowserContext, Page, Playwright

LINK_BUILDER_URL = "https://www.mercadolivre.com.br/afiliados/linkbuilder"

# The status check does a real page navigation (a few seconds) — cache the
# result briefly so GET /settings (which reads this on every load) stays fast.
_STATUS_CACHE_TTL_SECONDS = 60

# Telethon dispatches messages from different source groups as CONCURRENT
# asyncio tasks (it does not serialize them) — under any real traffic,
# several "generate affiliate link" calls land here at close to the same
# moment. With a single shared Page they used to queue up single-file: the
# N-th message in line could burn through most of its 90s per-message budget
# just WAITING for a turn, before the automation itself even started, and
# then still time out even though no individual Playwright call was slow.
# A small pool of pages under the same logged-in context lets a few of these
# run at once instead of piling up behind one another.
_POOL_SIZE = int(os.environ.get("ML_BROWSER_POOL_SIZE", "3"))

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def _looks_logged_in(current_url: str) -> bool:
    lowered = current_url.lower()
    return "login" not in lowered and "signin" not in lowered and "/gz/" not in lowered


class MLBrowserSession:
    """
    Owns a pool of long-lived headless Chromium pages under one shared,
    already-logged-in browser context — see the module docstring above for
    why a pool instead of one shared Page. Each `generate_affiliate_link`/
    `check_session_status` call checks a page out of the pool and always
    returns one (a fresh replacement if the checked-out page just failed or
    the call was cancelled mid-flight), so a single broken page can never
    permanently shrink the pool or wedge every future call behind it.
    """

    def __init__(self, storage_state_path: str) -> None:
        self.storage_state_path = Path(storage_state_path)
        self._playwright: Optional[Playwright] = None
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None
        self._pool: "asyncio.Queue[Page]" = asyncio.Queue()
        self._status_cache: Optional[bool] = None
        self._status_cache_at: float = 0.0

    async def start(self) -> None:
        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        await self._open_context()
        logger.info(f"[ml_browser] Playwright browser started (pool size {_POOL_SIZE})")

    async def _open_context(self) -> None:
        """(Re)creates the browser context + the whole page pool from scratch.
        Closing the old context (if any) also closes every page still under
        it, so the caller must make sure no page from the old pool is
        currently checked out — see reload_session()."""
        if self._context is not None:
            try:
                await self._context.close()
            except Exception:
                pass
        kwargs: dict = {"user_agent": _USER_AGENT, "locale": "pt-BR"}
        if self.storage_state_path.exists():
            kwargs["storage_state"] = str(self.storage_state_path)
        self._context = await self._browser.new_context(**kwargs)
        # Chromium supports the async Clipboard API in-process — no OS
        # clipboard / Xvfb dependency needed, unlike Selenium+pyperclip.
        await self._context.grant_permissions(["clipboard-read", "clipboard-write"], origin=LINK_BUILDER_URL)
        for _ in range(_POOL_SIZE):
            await self._pool.put(await self._context.new_page())

    async def _replace_page(self, page: Page) -> Page:
        """Swap out a page that just failed/was cancelled for a fresh one
        from the same context, so one bad page doesn't keep failing every
        subsequent link that happens to draw it from the pool."""
        try:
            await page.close()
        except Exception:
            pass
        try:
            return await self._context.new_page()
        except Exception as exc:
            logger.warning(f"[ml_browser] Failed to open a replacement page: {exc}")
            # Last resort: hand back the possibly-broken page rather than
            # permanently losing a pool slot.
            return page

    async def reload_session(self) -> None:
        """Call after a new storage_state file is uploaded so it takes effect immediately."""
        # Wait for every checked-out page to come back before swapping the
        # context out from under an in-flight generate_affiliate_link/
        # check_session_status call.
        for _ in range(_POOL_SIZE):
            await self._pool.get()
        await self._open_context()
        self._status_cache = None
        logger.info("[ml_browser] Session reloaded from disk")

    async def stop(self) -> None:
        try:
            if self._context:
                await self._context.close()
            if self._browser:
                await self._browser.close()
            if self._playwright:
                await self._playwright.stop()
        except Exception as exc:
            logger.warning(f"[ml_browser] Error during shutdown: {exc}")
        logger.info("[ml_browser] Playwright browser stopped")

    async def check_session_status(self, force: bool = False) -> bool:
        """
        True if the saved session is currently logged in on Mercado Livre.
        Does a real page navigation, so the result is cached briefly —
        GET /settings reads this on every load and shouldn't pay that cost
        every time. Pass force=True to bypass the cache (e.g. right after upload).
        """
        if self._context is None or not self.storage_state_path.exists():
            return False

        now = time.monotonic()
        if not force and self._status_cache is not None and (now - self._status_cache_at) < _STATUS_CACHE_TTL_SECONDS:
            return self._status_cache

        page = await self._pool.get()
        active = False
        try:
            resp = await page.goto(LINK_BUILDER_URL, wait_until="domcontentloaded", timeout=20000)
            active = _looks_logged_in(page.url) and not (resp is not None and resp.status >= 400)
        except asyncio.CancelledError:
            page = await self._replace_page(page)
            raise
        except Exception as exc:
            logger.warning(f"[ml_browser] Session status check failed: {exc}")
            page = await self._replace_page(page)
        finally:
            await self._pool.put(page)

        self._status_cache = active
        self._status_cache_at = now
        return active

    async def generate_affiliate_link(self, product_url: str) -> tuple[Optional[str], Optional[str]]:
        """
        Returns (affiliate_link, error_message).

        NOTE: the exact selectors below are based on how community Mercado
        Livre affiliate bots automate this same page (input#url-0, a "Gerar"
        button, a "Copiar" button) — we don't have a logged-in session to
        verify the live DOM ourselves yet. First real run after a session is
        uploaded should be checked against the logs; the diagnostic dump on
        failure (visible button texts) is there specifically to make fixing
        selector drift fast without needing another full research round.
        """
        if self._context is None:
            return None, "Navegador do Mercado Livre ainda não inicializado"
        if not self.storage_state_path.exists():
            return None, "Sessão do Mercado Livre não configurada (faça upload em Configurações)"

        page = await self._pool.get()
        try:
            await page.goto(LINK_BUILDER_URL, wait_until="domcontentloaded", timeout=20000)

            if not _looks_logged_in(page.url):
                return None, "Sessão do Mercado Livre expirada — gere uma nova sessão e faça upload em Configurações"

            input_field = page.locator("#url-0")
            try:
                await input_field.wait_for(state="visible", timeout=15000)
            except Exception:
                # Fallback: any single visible text input on the page
                input_field = page.locator("input[type='text'], input[type='url']").first
                await input_field.wait_for(state="visible", timeout=10000)

            await input_field.fill("")
            await input_field.fill(product_url)

            generate_button = page.get_by_text("Gerar", exact=False).first
            await generate_button.click(timeout=15000)

            copy_button = page.get_by_text("Copiar", exact=False).first
            await copy_button.wait_for(state="visible", timeout=15000)

            affiliate_link: Optional[str] = None

            # Strategy 1: a readonly input/textarea holding the generated link
            try:
                result_locator = page.locator("input[readonly], textarea[readonly]").first
                await result_locator.wait_for(state="visible", timeout=5000)
                candidate = await result_locator.input_value()
                if candidate and candidate.startswith("http"):
                    affiliate_link = candidate
            except Exception:
                pass

            # Strategy 2: click "Copiar" and read it back from the clipboard
            if not affiliate_link:
                await copy_button.click(timeout=10000)
                try:
                    clipboard_text = await page.evaluate("navigator.clipboard.readText()")
                    if clipboard_text and clipboard_text.startswith("http"):
                        affiliate_link = clipboard_text
                except Exception as exc:
                    logger.debug(f"[ml_browser] Clipboard read failed: {exc}")

            if not affiliate_link:
                visible_texts = await page.locator("button, span").all_inner_texts()
                logger.warning(
                    f"[ml_browser] Could not extract generated link for {product_url[:80]} — "
                    f"visible button/span texts on page: {visible_texts[:30]}"
                )
                return None, "Não foi possível ler o link gerado pelo Link Builder (seletor pode ter mudado)"

            return affiliate_link, None

        except asyncio.CancelledError:
            # Almost always the 90s per-message wait_for() upstream cancelling
            # this call — the page may be mid-navigation/mid-click. Never
            # reuse it as-is, or the NEXT link that draws it from the pool
            # inherits whatever inconsistent state it was left in.
            logger.warning(f"[ml_browser] Link generation for {product_url[:80]} was cancelled (likely a timeout upstream)")
            page = await self._replace_page(page)
            raise
        except Exception as exc:
            logger.warning(f"[ml_browser] Failed to generate affiliate link for {product_url[:80]}: {exc}")
            page = await self._replace_page(page)
            return None, f"Falha na automação do Link Builder: {exc}"
        finally:
            await self._pool.put(page)


_session: Optional[MLBrowserSession] = None


def get_session(storage_state_path: str) -> MLBrowserSession:
    global _session
    if _session is None:
        _session = MLBrowserSession(storage_state_path)
    return _session
