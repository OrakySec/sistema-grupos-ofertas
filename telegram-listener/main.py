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

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

load_dotenv()

INTERNAL_API_URL: str = os.getenv("INTERNAL_API_URL", "http://api:3001")
MEDIA_BASE_PATH: str = os.getenv("MEDIA_BASE_PATH", "/app/media")
SESSION_PATH: str = os.getenv("SESSION_PATH", "/app/sessions")
JWT_SECRET: str = os.getenv("JWT_SECRET", "changeme-jwt-secret")
HTTP_PORT: int = int(os.getenv("HTTP_PORT", "8080"))

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


state = AppState()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _internal_headers() -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "X-Internal-Key": JWT_SECRET,
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


async def fetch_source_groups(session: aiohttp.ClientSession) -> dict[int, str]:
    """
    GET /groups/source from the internal API.
    Returns a dict mapping Telegram chat-id (int) → UUID string.
    """
    url = f"{INTERNAL_API_URL}/groups/source"
    try:
        async with session.get(url, headers=_internal_headers(), timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status == 200:
                groups = await resp.json()
                # Expected shape: list of { telegramId: int|str, id: uuid }
                mapping: dict[int, str] = {}
                for g in groups:
                    tg_id = g.get("telegramId") or g.get("telegram_id")
                    uuid = g.get("id") or g.get("uuid")
                    if tg_id and uuid:
                        mapping[int(tg_id)] = str(uuid)
                logger.info(f"Source groups loaded: {list(mapping.keys())}")
                return mapping
            logger.warning(f"GET /groups/source returned HTTP {resp.status}")
    except Exception as exc:
        logger.warning(f"Failed to fetch source groups: {exc}")
    return {}


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

        logger.info(
            f"New message in chat {chat_id} (uuid={uuid}), "
            f"message_id={message.id}, has_media={message.media is not None}"
        )

        try:
            # Sender info
            try:
                sender = await event.get_sender()
            except Exception:
                sender = None
            name = _sender_name(sender)

            # Media
            media_type = _media_type_from_message(message)
            media_local_path: Optional[str] = None
            media_caption: Optional[str] = None

            if media_type != "NONE" and state.client is not None:
                media_local_path = await _download_media(state.client, message, chat_id)
                # Caption lives on the message itself (same as text for media messages)
                media_caption = message.message or None

            text = message.message if media_type == "NONE" else None

            original_date: str = (
                message.date.astimezone(timezone.utc).isoformat()
                if message.date
                else datetime.now(timezone.utc).isoformat()
            )

            payload = {
                "sourceGroupId": uuid,
                "telegramMessageId": message.id,
                "text": text,
                "mediaType": media_type,
                "mediaLocalPath": media_local_path,
                "mediaCaption": media_caption,
                "senderName": name,
                "originalDate": original_date,
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

    # Fetch source groups regardless
    new_groups = await fetch_source_groups(http_session)
    groups_changed = new_groups != state.source_groups
    state.source_groups = new_groups

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
    new_groups = await fetch_source_groups(http_session)
    state.source_groups = new_groups
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
