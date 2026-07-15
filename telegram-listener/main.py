"""
Telegram Listener Service
=========================
Listens to source Telegram groups and forwards new messages (with media) to the
internal API.  An embedded aiohttp HTTP server on :8080 exposes auth + status
endpoints so the main API can drive the Telegram authentication flow.
"""

import asyncio
import os
import sys
import mimetypes
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import aiofiles
import aiohttp
from aiohttp import web
from dotenv import load_dotenv
from loguru import logger
from telethon import TelegramClient, events
from telethon.errors import (
    SessionPasswordNeededError,
    PhoneCodeInvalidError,
    PhoneCodeExpiredError,
    RPCError,
)
from telethon.tl.types import (
    MessageMediaPhoto,
    MessageMediaDocument,
    DocumentAttributeFilename,
    DocumentAttributeVideo,
)
from affiliate_converter import AffiliateConverter
import ml_browser
import mockup_composer

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

load_dotenv()

INTERNAL_API_URL: str = os.getenv("INTERNAL_API_URL", "http://api:3001")
MEDIA_BASE_PATH: str = os.getenv("MEDIA_BASE_PATH", "/app/media")
SESSION_PATH: str = os.getenv("SESSION_PATH", "/app/sessions")
JWT_SECRET: str = os.getenv("JWT_SECRET", "changeme-jwt-secret")
INTERNAL_TOKEN: str = "sistema-grupos-ofertas-internal-token-fallback-key-2026"
HTTP_PORT: int = int(os.getenv("HTTP_PORT", "8080"))
ML_STORAGE_STATE_PATH: str = str(Path(SESSION_PATH) / "ml_storage_state.json")

# Ensure directories exist
Path(MEDIA_BASE_PATH).mkdir(parents=True, exist_ok=True)
Path(SESSION_PATH).mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Logger setup
# ---------------------------------------------------------------------------

logger.remove()
logger.add(
    sys.stdout,
    format=(
        "<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | "
        "<level>{level: <8}</level> | "
        "<cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> | "
        "{message}"
    ),
    level="DEBUG",
    colorize=True,
)

# ---------------------------------------------------------------------------
# Shared application state
# ---------------------------------------------------------------------------

class AppState:
    """Mutable container shared between the Telethon coroutines and aiohttp routes."""

    def __init__(self) -> None:
        self.api_id: Optional[int] = None
        self.api_hash: Optional[str] = None
        self.phone: Optional[str] = None

        # Mapping from Telegram group chat-id (int) → UUID used by the API
        self.source_groups: dict[int, str] = {}  # {telegram_id: uuid}

        # Per-niche overrides, keyed by SourceGroup UUID (not chat-id) — see
        # _extract_niche_config. Refreshed on the same poll cycle as source_groups.
        self.source_group_configs: dict[str, dict] = {}

        self.client: Optional[TelegramClient] = None
        self.authenticated: bool = False
        self.connected: bool = False
        self.last_error: Optional[str] = None

        # Used during the phone-code sign-in flow
        self.phone_code_hash: Optional[str] = None

        # asyncio event so we can notify the main loop when settings change
        self.settings_changed = asyncio.Event()

        # Lock to protect client recreation
        self.client_lock = asyncio.Lock()

        # Affiliate link conversion settings (refreshed from API on every poll)
        self.affiliate_settings: dict = {}


state = AppState()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _internal_headers() -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "X-Internal-Key": INTERNAL_TOKEN,
    }


def _media_type_from_message(message) -> str:
    """Return PHOTO | VIDEO | DOCUMENT | NONE based on the message media."""
    if message.media is None:
        return "NONE"
    if isinstance(message.media, MessageMediaPhoto):
        return "PHOTO"
    if isinstance(message.media, MessageMediaDocument):
        doc = message.media.document
        for attr in doc.attributes:
            if isinstance(attr, DocumentAttributeVideo):
                return "VIDEO"
        return "DOCUMENT"
    return "NONE"


def _filename_from_message(message, media_type: str, message_id: int) -> str:
    """Derive a filename for media download."""
    if isinstance(message.media, MessageMediaDocument):
        doc = message.media.document
        for attr in doc.attributes:
            if isinstance(attr, DocumentAttributeFilename):
                return attr.file_name
        # Guess extension from MIME type
        mime = getattr(doc, "mime_type", None) or ""
        ext = mimetypes.guess_extension(mime) or ""
        return f"{message_id}{ext}"
    if media_type == "PHOTO":
        return f"{message_id}.jpg"
    return f"{message_id}.bin"


async def _download_media(client: TelegramClient, message, group_id: int) -> Optional[str]:
    """
    Download media attached to *message* into MEDIA_BASE_PATH/<group_id>/.
    Returns the relative path (from MEDIA_BASE_PATH) on success, None on failure.
    """
    media_type = _media_type_from_message(message)
    if media_type == "NONE":
        return None

    filename = _filename_from_message(message, media_type, message.id)
    rel_dir = str(group_id)
    abs_dir = Path(MEDIA_BASE_PATH) / rel_dir
    abs_dir.mkdir(parents=True, exist_ok=True)

    dest = abs_dir / f"{message.id}_{filename}"
    try:
        await client.download_media(message, file=str(dest))
        rel_path = f"{rel_dir}/{message.id}_{filename}"
        logger.info(f"Media downloaded → {rel_path}")
        return rel_path
    except Exception as exc:
        logger.warning(f"Media download failed for message {message.id}: {exc}")
        return None


def _sender_name(sender) -> Optional[str]:
    """Build a human-readable name from a sender entity."""
    if sender is None:
        return None
    first = getattr(sender, "first_name", None) or ""
    last = getattr(sender, "last_name", None) or ""
    full = f"{first} {last}".strip()
    if full:
        return full
    username = getattr(sender, "username", None)
    return username or str(getattr(sender, "id", "unknown"))


# ---------------------------------------------------------------------------
# API calls
# ---------------------------------------------------------------------------

async def fetch_settings(session: aiohttp.ClientSession) -> Optional[dict]:
    """GET /settings/internal from the internal API.  Returns the JSON body or None."""
    url = f"{INTERNAL_API_URL}/settings/internal"
    try:
        async with session.get(url, headers=_internal_headers(), timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status == 200:
                data = await resp.json()
                logger.debug(f"Settings fetched: {data}")
                return data
            logger.warning(f"GET /settings/internal returned HTTP {resp.status}")
    except Exception as exc:
        logger.warning(f"Failed to fetch settings: {exc}")
    return None


def _extract_niche_config(g: dict) -> dict:
    """
    Build the per-source-group override dict from a /groups/source row.
    ml_own_list_url is used whenever present. The mockup override is only
    applied when the template path AND all 4 box coordinates AND the corner
    radius are present — routes/groups.ts writes those 5 fields atomically,
    so a partially-configured template should never happen, but we still
    guard against it here rather than risk composing onto a None box.
    """
    config: dict = {}

    ml_own_list_url = g.get("mlOwnListUrl")
    if ml_own_list_url:
        config["ml_own_list_url"] = ml_own_list_url

    template_path = g.get("mockupTemplatePath")
    box_fields = (
        g.get("mockupBoxLeft"), g.get("mockupBoxTop"),
        g.get("mockupBoxRight"), g.get("mockupBoxBottom"),
    )
    corner_radius = g.get("mockupCornerRadius")
    if template_path and corner_radius is not None and all(v is not None for v in box_fields):
        config["mockup"] = {
            "template_path": template_path,
            "box": box_fields,
            "corner_radius": corner_radius,
        }

    return config


async def fetch_source_groups(session: aiohttp.ClientSession) -> tuple[dict[int, str], dict[str, dict]]:
    """
    GET /groups/source from the internal API.
    Returns (chat-id-variant → UUID mapping, UUID → niche config dict).
    We map multiple chat-id forms (base, negative, -100 prefix) so Telethon
    and the handler match reliably regardless of how the user typed it.
    """
    url = f"{INTERNAL_API_URL}/groups/source"
    try:
        async with session.get(url, headers=_internal_headers(), timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status == 200:
                groups = await resp.json()
                mapping: dict[int, str] = {}
                configs: dict[str, dict] = {}
                for g in groups:
                    tg_id = g.get("telegramId") or g.get("telegram_id")
                    uuid = g.get("id") or g.get("uuid")
                    if tg_id and uuid:
                        tg_id = int(tg_id)
                        str_id = str(tg_id)
                        if str_id.startswith("-100"):
                            base_id = int(str_id[4:])
                        elif str_id.startswith("-"):
                            base_id = int(str_id[1:])
                        else:
                            base_id = tg_id

                        # Map all possible Telegram ID variants
                        mapping[base_id] = str(uuid)
                        mapping[-base_id] = str(uuid)
                        mapping[int(f"-100{base_id}")] = str(uuid)

                        configs[str(uuid)] = _extract_niche_config(g)

                logger.info(f"Source groups loaded (expanded to variants): {list(mapping.keys())}")
                return mapping, configs
            logger.warning(f"GET /groups/source returned HTTP {resp.status}")
    except Exception as exc:
        logger.warning(f"Failed to fetch source groups: {exc}")
    return {}, {}



async def post_offer(session: aiohttp.ClientSession, payload: dict) -> None:
    """POST /offers/internal to the internal API."""
    url = f"{INTERNAL_API_URL}/offers/internal"
    try:
        async with session.post(
            url,
            json=payload,
            headers=_internal_headers(),
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            body = await resp.text()
            if resp.status in (200, 201):
                logger.info(f"Offer posted OK (msg {payload.get('telegramMessageId')}): {resp.status}")
            else:
                logger.warning(
                    f"POST /offers/internal returned {resp.status} for msg "
                    f"{payload.get('telegramMessageId')}: {body[:200]}"
                )
    except Exception as exc:
        logger.error(f"Failed to post offer (msg {payload.get('telegramMessageId')}): {exc}")


# ---------------------------------------------------------------------------
# Telethon client management
# ---------------------------------------------------------------------------

def _build_client(api_id: int, api_hash: str) -> TelegramClient:
    session_file = str(Path(SESSION_PATH) / "telegram")
    return TelegramClient(session_file, api_id, api_hash)


async def _make_message_handler(http_session: aiohttp.ClientSession):
    """Factory: returns a Telethon event handler coroutine closed over http_session."""

    async def on_new_message(event: events.NewMessage.Event) -> None:
        message = event.message
        chat_id = event.chat_id  # may be negative for groups/channels

        # Resolve the UUID for this group
        uuid = state.source_groups.get(chat_id)
        if uuid is None:
            # Try with the positive form (some channels use positive IDs internally)
            uuid = state.source_groups.get(abs(chat_id))
        if uuid is None:
            logger.debug(f"Message from unmonitored chat {chat_id} — ignoring")
            return

        # Per-niche overrides for this source group (ml_own_list_url / mockup
        # template) — empty dict when the group has no custom config, which
        # falls back to the exact behavior that existed before niches.
        group_config = state.source_group_configs.get(uuid, {})

        logger.info(
            f"New message in chat {chat_id} (uuid={uuid}), "
            f"message_id={message.id}, has_media={message.media is not None}"
        )

        try:
            _ts = lambda: datetime.now(timezone.utc).isoformat()

            # ── STEP 1: Message received ──────────────────────────────────────────
            processing_events: list[dict] = [{
                "ts":     _ts(),
                "step":   "received",
                "status": "ok",
                "label":  "Mensagem recebida",
                "detail": (
                    f"Chat {chat_id} • Msg #{message.id}"
                    + (" • com mídia" if message.media else " • texto puro")
                ),
            }]

            # ── STEP 2: Sender ────────────────────────────────────────────────────
            try:
                sender = await event.get_sender()
            except Exception:
                sender = None
            name = _sender_name(sender)
            processing_events.append({
                "ts":     _ts(),
                "step":   "sender",
                "status": "ok",
                "label":  "Remetente identificado",
                "detail": name or "Anônimo / Canal",
            })

            # ── STEP 3: Media ─────────────────────────────────────────────────────
            media_type = _media_type_from_message(message)
            media_local_path: Optional[str] = None
            media_caption: Optional[str] = None

            if media_type != "NONE" and state.client is not None:
                processing_events.append({
                    "ts":     _ts(),
                    "step":   "media_download",
                    "status": "info",
                    "label":  f"Mídia ({media_type})",
                    "detail": "Baixando arquivo...",
                })
                media_local_path = await _download_media(state.client, message, chat_id)
                processing_events[-1]["status"] = "ok" if media_local_path else "error"
                processing_events[-1]["detail"] = (
                    f"Salvo: {media_local_path}" if media_local_path
                    else "Falha no download de mídia"
                )
                media_caption = message.message or None

            text = message.message if media_type == "NONE" else None

            # ── STEP 4: URL detection ─────────────────────────────────────────────
            _raw = text or media_caption or ""
            _has_url = "http://" in _raw or "https://" in _raw
            processing_events.append({
                "ts":     _ts(),
                "step":   "url_detect",
                "status": "ok" if _has_url else "skipped",
                "label":  "Detecção de links",
                "detail": (
                    "Link(s) encontrado(s) — iniciando conversão de afiliado"
                    if _has_url else
                    "Nenhum link HTTP detectado na mensagem"
                ),
            })

            # ── STEP 5: Affiliate link conversion ─────────────────────────────────
            if state.affiliate_settings and _has_url:
                _original_text    = text
                _original_caption = media_caption
                try:
                    # This source group's own ML list link (if configured) takes
                    # priority over the global fallback — everything else in
                    # affiliate_settings stays shared across niches (affiliate
                    # tags are account-level, not niche-level).
                    message_affiliate_settings = state.affiliate_settings
                    if group_config.get("ml_own_list_url"):
                        message_affiliate_settings = {
                            **state.affiliate_settings,
                            "ml_own_list_url": group_config["ml_own_list_url"],
                        }

                    converter = AffiliateConverter(
                        message_affiliate_settings,
                        ml_session=ml_browser.get_session(ML_STORAGE_STATE_PATH),
                    )

                    async def _convert_all() -> None:
                        nonlocal text, media_caption
                        if text:
                            text, evts = await converter.convert(text, http_session)
                            processing_events.extend(evts)
                        if media_caption:
                            media_caption, evts = await converter.convert(media_caption, http_session)
                            processing_events.extend(evts)

                    # Mercado Livre links now go through real browser automation
                    # (Link Builder tool), which is much slower than the other
                    # marketplaces' plain string-based conversion — give it more room.
                    await asyncio.wait_for(_convert_all(), timeout=45.0)

                    converted = any(e.get("status") == "ok" for e in processing_events)
                    if converted:
                        logger.info(f"[affiliate] msg {message.id}: links converted OK ({len(processing_events)} event(s))")
                    else:
                        logger.debug(f"[affiliate] msg {message.id}: no convertible links found")

                except asyncio.TimeoutError:
                    logger.warning(f"[affiliate] msg {message.id}: conversion timed out — sending original text")
                    text          = _original_text
                    media_caption = _original_caption
                    processing_events.append({
                        "ts": _ts(), "step": "url_convert", "status": "error",
                        "label": "Conversão de afiliado", "error": "Timeout (>45s) — texto original mantido",
                    })

                except Exception as conv_exc:
                    logger.warning(f"[affiliate] msg {message.id}: conversion error ({conv_exc}) — sending original text")
                    text          = _original_text
                    media_caption = _original_caption
                    processing_events.append({
                        "ts": _ts(), "step": "url_convert", "status": "error",
                        "label": "Conversão de afiliado", "error": str(conv_exc),
                    })

            elif not state.affiliate_settings:
                processing_events.append({
                    "ts":     _ts(),
                    "step":   "url_convert",
                    "status": "skipped",
                    "label":  "Conversão de afiliado",
                    "detail": "Configurações de afiliado não carregadas do servidor",
                })

            # ── STEP 5.5: Offer image (always regenerated from the product page) ──
            # Never trust whatever photo/caption came with the original message —
            # find the recognized marketplace link and fetch the product's own
            # image (og:image) to paste into our branded mockup instead.
            product_url_for_mockup: Optional[str] = None
            for ev in processing_events:
                if ev.get("step") == "url" and ev.get("platform"):
                    product_url_for_mockup = ev.get("expanded") or ev.get("original")
                    break

            if product_url_for_mockup:
                message_text = text or media_caption
                image_bytes, mockup_error = await mockup_composer.generate_offer_image(
                    product_url_for_mockup, http_session,
                    template_override=group_config.get("mockup"),
                )
                if image_bytes:
                    mockup_dir = Path(MEDIA_BASE_PATH) / str(chat_id)
                    mockup_dir.mkdir(parents=True, exist_ok=True)
                    mockup_filename = f"{message.id}_mockup.jpg"
                    (mockup_dir / mockup_filename).write_bytes(image_bytes)

                    media_type = "PHOTO"
                    media_local_path = f"{chat_id}/{mockup_filename}"
                    media_caption = message_text
                    text = None
                    processing_events.append({
                        "ts": _ts(), "step": "mockup", "status": "ok",
                        "label": "Imagem do produto", "detail": "Foto do produto montada no mockup",
                    })
                else:
                    # Per spec: on failure, send WITHOUT any photo — never fall
                    # back to whatever media came with the original message.
                    media_type = "NONE"
                    media_local_path = None
                    media_caption = None
                    text = message_text
                    processing_events.append({
                        "ts": _ts(), "step": "mockup", "status": "error",
                        "label": "Imagem do produto",
                        "error": mockup_error or "Falha desconhecida — oferta enviada sem foto",
                    })

            # ── STEP 6: Send to API ───────────────────────────────────────────────
            original_date: str = (
                message.date.astimezone(timezone.utc).isoformat()
                if message.date
                else datetime.now(timezone.utc).isoformat()
            )

            processing_events.append({
                "ts":     _ts(),
                "step":   "api_post",
                "status": "ok",
                "label":  "Enviado para API",
                "detail": "POST /offers/internal → salvo no banco de dados",
            })

            payload = {
                "sourceGroupId":    uuid,
                "telegramMessageId": message.id,
                "text":             text,
                "mediaType":        media_type,
                "mediaLocalPath":   media_local_path,
                "mediaCaption":     media_caption,
                "senderName":       name,
                "originalDate":     original_date,
                "processingLog":    processing_events,
            }

            logger.debug(f"Sending offer payload: {payload}")
            await post_offer(http_session, payload)

        except Exception as exc:
            logger.exception(f"Unhandled error in message handler (msg {message.id}): {exc}")

    return on_new_message


def _register_handlers(client: TelegramClient, handler_fn, group_ids: list[int]) -> None:
    """Clear all existing handlers and register *handler_fn* for *group_ids*."""
    client.remove_event_handler(handler_fn)  # no-op if not registered; ignore errors
    if not group_ids:
        logger.info("No source groups configured — no handlers registered")
        return
    client.add_event_handler(
        handler_fn,
        events.NewMessage(chats=group_ids),
    )
    logger.info(f"Registered NewMessage handler for {len(group_ids)} groups: {group_ids}")


async def start_client(http_session: aiohttp.ClientSession) -> bool:
    """
    (Re)create and connect the TelegramClient using current state settings.
    Returns True if the client connected successfully.
    """
    async with state.client_lock:
        if state.api_id is None or state.api_hash is None or state.phone is None:
            logger.warning("Cannot start client: api_id / api_hash / phone not yet configured")
            state.last_error = "Credenciais incompletas no banco (API ID, API Hash ou Telefone ausente)"
            return False

        # Disconnect previous client if any
        if state.client is not None:
            try:
                await state.client.disconnect()
            except Exception:
                pass
            state.client = None
            state.connected = False
            state.authenticated = False

        logger.info(f"Creating TelegramClient (api_id={state.api_id})")
        
        try:
            client = _build_client(state.api_id, state.api_hash)
        except Exception as exc:
            logger.error(f"Failed to build TelegramClient: {exc}")
            state.last_error = f"Erro de construção do cliente: {str(exc)}"
            return False

        try:
            await client.connect()
            state.last_error = None
        except Exception as exc:
            logger.error(f"Failed to connect TelegramClient: {exc}")
            state.last_error = f"Falha de conexão com os servidores do Telegram: {str(exc)}"
            return False

        state.client = client
        state.connected = client.is_connected()
        try:
            state.authenticated = await client.is_user_authorized()
        except Exception as exc:
            logger.error(f"Failed to check user authorization: {exc}")
            state.last_error = f"Erro de autorização: {str(exc)}"
            return False

        logger.info(f"Client connected={state.connected}, authenticated={state.authenticated}")

        if state.authenticated:
            handler_fn = await _make_message_handler(http_session)
            state._handler_fn = handler_fn  # keep reference so we can remove it later
            group_ids = list(state.source_groups.keys())
            _register_handlers(client, handler_fn, group_ids)

        return True


async def reconnect_loop(http_session: aiohttp.ClientSession) -> None:
    """Background task: watch for disconnections and reconnect automatically."""
    while True:
        await asyncio.sleep(15)
        if state.client is None:
            continue
        if not state.client.is_connected():
            logger.warning("Telethon client disconnected — reconnecting …")
            state.connected = False
            try:
                await state.client.connect()
                state.connected = state.client.is_connected()
                state.authenticated = await state.client.is_user_authorized()
                logger.info(f"Reconnected. authenticated={state.authenticated}")
            except Exception as exc:
                logger.error(f"Reconnection attempt failed: {exc}")


# ---------------------------------------------------------------------------
# Settings polling loop
# ---------------------------------------------------------------------------

async def settings_poll_loop(http_session: aiohttp.ClientSession) -> None:
    """
    Periodically refresh settings and source groups from the API.
    If anything relevant changes, recreate/update the Telethon client.
    """
    # Wait for the API to become available on first boot
    while True:
        settings = await fetch_settings(http_session)
        if settings is not None:
            break
        logger.info("API not yet available — retrying in 10 s …")
        await asyncio.sleep(10)

    # Apply initial settings
    await _apply_settings(settings, http_session, initial=True)

    while True:
        await asyncio.sleep(60)
        logger.debug("Polling settings …")
        new_settings = await fetch_settings(http_session)
        if new_settings is None:
            continue
        await _apply_settings(new_settings, http_session, initial=False)


async def _apply_settings(settings: dict, http_session: aiohttp.ClientSession, *, initial: bool) -> None:
    """
    Compare incoming settings with current state and react to changes.
    """
    new_api_id_raw = settings.get("telegram_api_id") or settings.get("telegramApiId")
    new_api_hash = settings.get("telegram_api_hash") or settings.get("telegramApiHash")
    new_phone = settings.get("telegram_phone") or settings.get("telegramPhone")

    new_api_id = int(new_api_id_raw) if new_api_id_raw else None

    credentials_changed = (
        new_api_id != state.api_id
        or new_api_hash != state.api_hash
        or new_phone != state.phone
    )

    state.api_id = new_api_id
    state.api_hash = new_api_hash
    state.phone = new_phone

    state.affiliate_settings = {
        "amazon_affiliate_tag":   settings.get("amazon_affiliate_tag") or "",
        "shopee_affiliate_id":    settings.get("shopee_affiliate_id") or "",
        "aliexpress_tracking_id": settings.get("aliexpress_tracking_id") or "",
        "magalu_store_name":      settings.get("magalu_store_name") or "",
        "ml_own_list_url":        settings.get("ml_own_list_url") or "",
        "link_shortener_enabled": settings.get("link_shortener_enabled", "true"),
        "shortener_provider":     settings.get("shortener_provider", "internal"),
        "internal_api_url":       INTERNAL_API_URL,
        "internal_token":         INTERNAL_TOKEN,
    }
    logger.debug(f"Affiliate settings refreshed: { {k: ('✓' if v else '–') for k, v in state.affiliate_settings.items()} }")
    # ─────────────────────────────────────────────────────────────────────

    # Fetch source groups (+ their per-niche config overrides) regardless
    new_groups, new_group_configs = await fetch_source_groups(http_session)
    groups_changed = new_groups != state.source_groups
    state.source_groups = new_groups
    state.source_group_configs = new_group_configs

    if initial or credentials_changed:
        if state.api_id and state.api_hash and state.phone:
            logger.info("Credentials available — starting Telethon client …")
            await start_client(http_session)
        else:
            missing = []
            if not state.api_id: missing.append("API ID")
            if not state.api_hash: missing.append("API Hash")
            if not state.phone: missing.append("Telefone")
            state.last_error = f"Credenciais incompletas no banco (faltando: {', '.join(missing)})"
            logger.info(f"Credentials incomplete (missing {', '.join(missing)}) — Telethon client not started")
        return

    # Credentials unchanged but groups may have changed
    if groups_changed and state.client is not None and state.authenticated:
        logger.info("Source groups changed — refreshing event handlers …")
        handler_fn = getattr(state, "_handler_fn", None)
        if handler_fn is None:
            handler_fn = await _make_message_handler(http_session)
            state._handler_fn = handler_fn
        # Remove all existing handlers and re-add
        state.client.list_event_handlers()  # ensure internal list is alive
        _clear_all_handlers(state.client)
        group_ids = list(state.source_groups.keys())
        _register_handlers(state.client, handler_fn, group_ids)


def _clear_all_handlers(client: TelegramClient) -> None:
    """Remove every registered event handler from the client."""
    for callback, _ in list(client.list_event_handlers()):
        client.remove_event_handler(callback)


# ---------------------------------------------------------------------------
# aiohttp HTTP server routes
# ---------------------------------------------------------------------------

async def route_status(request: web.Request) -> web.Response:
    """GET /status → { authenticated, connected, monitoredGroups, lastError }"""
    return web.json_response(
        {
            "authenticated": state.authenticated,
            "connected": state.connected,
            "monitoredGroups": len(state.source_groups),
            "lastError": state.last_error,
        }
    )


async def route_auth_start(request: web.Request) -> web.Response:
    """
    POST /auth/start
    Body: { phone: string }
    Triggers send_code_request and returns the phone_code_hash.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    phone = body.get("phone") or state.phone
    if not phone:
        return web.json_response({"error": "phone is required"}, status=400)

    if state.client is None:
        err_msg = "Telethon client not initialised"
        if state.last_error:
            err_msg = f"{err_msg} ({state.last_error})"
        return web.json_response({"error": err_msg}, status=503)

    try:
        result = await state.client.send_code_request(phone)
        state.phone_code_hash = result.phone_code_hash
        logger.info(f"Auth code sent to {phone}")
        return web.json_response({"ok": True, "phoneCodeHash": result.phone_code_hash})
    except Exception as exc:
        logger.error(f"send_code_request failed: {exc}")
        return web.json_response({"error": str(exc)}, status=500)


async def route_auth_verify(request: web.Request) -> web.Response:
    """
    POST /auth/verify
    Body: { phone: string, code: string, phone_hash: string }
    Signs in the user.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    phone = body.get("phone") or state.phone
    code = body.get("code")
    phone_hash = body.get("phone_hash") or state.phone_code_hash

    if not phone or not code:
        return web.json_response({"error": "phone and code are required"}, status=400)

    if state.client is None:
        return web.json_response({"error": "Telethon client not initialised"}, status=503)

    try:
        await state.client.sign_in(phone, code, phone_code_hash=phone_hash)
        state.authenticated = await state.client.is_user_authorized()
        logger.info(f"Authentication successful for {phone}: {state.authenticated}")

        if state.authenticated:
            http_session: aiohttp.ClientSession = request.app["http_session"]
            handler_fn = await _make_message_handler(http_session)
            state._handler_fn = handler_fn
            _clear_all_handlers(state.client)
            group_ids = list(state.source_groups.keys())
            _register_handlers(state.client, handler_fn, group_ids)

        return web.json_response({"ok": True, "authenticated": state.authenticated})

    except PhoneCodeInvalidError:
        return web.json_response({"error": "Invalid code"}, status=400)
    except PhoneCodeExpiredError:
        return web.json_response({"error": "Code expired — request a new one"}, status=400)
    except SessionPasswordNeededError:
        return web.json_response(
            {"error": "Two-factor authentication is enabled; password required"}, status=400
        )
    except Exception as exc:
        logger.error(f"sign_in failed: {exc}")
        return web.json_response({"error": str(exc)}, status=500)


async def route_reload(request: web.Request) -> web.Response:
    """
    POST /reload
    Forces an immediate reload of source groups and refreshes handlers.
    """
    http_session: aiohttp.ClientSession = request.app["http_session"]
    new_groups, new_group_configs = await fetch_source_groups(http_session)
    state.source_groups = new_groups
    state.source_group_configs = new_group_configs
    logger.info(f"Reloaded groups via /reload: {list(new_groups.keys())}")

    if state.client is not None and state.authenticated:
        handler_fn = getattr(state, "_handler_fn", None)
        if handler_fn is None:
            handler_fn = await _make_message_handler(http_session)
            state._handler_fn = handler_fn
        _clear_all_handlers(state.client)
        group_ids = list(state.source_groups.keys())
        _register_handlers(state.client, handler_fn, group_ids)

    return web.json_response(
        {"ok": True, "monitoredGroups": len(state.source_groups)}
    )


async def route_reload_settings(request: web.Request) -> web.Response:
    """
    POST /reload-settings
    Forces an immediate re-fetch of credentials from the API and recreates
    the Telethon client if they changed.  Called by the API right after
    PUT /settings so the user does not have to wait up to 60 s for the poll loop.
    """
    http_session: aiohttp.ClientSession = request.app["http_session"]
    settings = await fetch_settings(http_session)
    if settings is None:
        return web.json_response({"error": "Could not fetch settings from API"}, status=502)

    await _apply_settings(settings, http_session, initial=True)
    logger.info("Settings reloaded via /reload-settings")
    return web.json_response(
        {
            "ok": True,
            "clientReady": state.client is not None,
            "authenticated": state.authenticated,
        }
    )


# ---------------------------------------------------------------------------
# Mercado Livre affiliate session routes
# ---------------------------------------------------------------------------

async def route_ml_session_upload(request: web.Request) -> web.Response:
    """
    POST /ml-session/upload (multipart form, field name "file")
    Saves the uploaded Playwright storage_state.json and reloads the
    browser context so it takes effect immediately (no restart needed).
    """
    try:
        reader = await request.multipart()
        field = await reader.next()
        if field is None or field.name != "file":
            return web.json_response({"error": "Campo 'file' ausente no upload"}, status=400)

        data = await field.read(decode=True)
        Path(ML_STORAGE_STATE_PATH).write_bytes(data)
        logger.info(f"[ml_session] New session file saved ({len(data)} bytes)")

        session = ml_browser.get_session(ML_STORAGE_STATE_PATH)
        await session.reload_session()
        active = await session.check_session_status(force=True)

        return web.json_response({"ok": True, "active": active})
    except Exception as exc:
        logger.error(f"[ml_session] Upload failed: {exc}")
        return web.json_response({"error": str(exc)}, status=500)


async def route_ml_session_status(request: web.Request) -> web.Response:
    """GET /ml-session/status → { active: bool } — does a live check, not just a file-exists check."""
    session = ml_browser.get_session(ML_STORAGE_STATE_PATH)
    active = await session.check_session_status()
    return web.json_response({"active": active})


# ---------------------------------------------------------------------------
# Application lifecycle
# ---------------------------------------------------------------------------

async def on_startup(app: web.Application) -> None:
    """aiohttp startup hook — creates the shared HTTP session and starts background tasks."""
    connector = aiohttp.TCPConnector(limit=20)
    http_session = aiohttp.ClientSession(connector=connector)
    app["http_session"] = http_session

    # Kick off background coroutines
    app["task_settings_poll"] = asyncio.create_task(
        settings_poll_loop(http_session), name="settings_poll"
    )
    app["task_reconnect"] = asyncio.create_task(
        reconnect_loop(http_session), name="reconnect_loop"
    )

    try:
        await ml_browser.get_session(ML_STORAGE_STATE_PATH).start()
    except Exception as exc:
        logger.error(f"[ml_session] Failed to start Playwright browser: {exc}")

    try:
        await mockup_composer.get_image_browser().start()
    except Exception as exc:
        logger.error(f"[mockup] Failed to start product-image browser: {exc}")

    logger.info("Service started — background tasks running")


async def on_shutdown(app: web.Application) -> None:
    """aiohttp shutdown hook — clean up tasks, client, and HTTP session."""
    for task_key in ("task_settings_poll", "task_reconnect"):
        task = app.get(task_key)
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    if state.client is not None:
        try:
            await state.client.disconnect()
        except Exception:
            pass

    try:
        await ml_browser.get_session(ML_STORAGE_STATE_PATH).stop()
    except Exception:
        pass

    try:
        await mockup_composer.get_image_browser().stop()
    except Exception:
        pass

    http_session: aiohttp.ClientSession = app.get("http_session")
    if http_session is not None:
        await http_session.close()

    logger.info("Service shut down cleanly")


def build_app() -> web.Application:
    app = web.Application()

    app.router.add_get("/status", route_status)
    app.router.add_post("/auth/start", route_auth_start)
    app.router.add_post("/auth/verify", route_auth_verify)
    app.router.add_post("/reload", route_reload)
    app.router.add_post("/reload-settings", route_reload_settings)
    app.router.add_post("/ml-session/upload", route_ml_session_upload)
    app.router.add_get("/ml-session/status", route_ml_session_status)

    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)

    return app


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logger.info(
        f"Starting Telegram Listener Service | "
        f"API={INTERNAL_API_URL} | MEDIA={MEDIA_BASE_PATH} | SESSION={SESSION_PATH} | PORT={HTTP_PORT}"
    )
    app = build_app()
    web.run_app(app, host="0.0.0.0", port=HTTP_PORT, access_log=None)
