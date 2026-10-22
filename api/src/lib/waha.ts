/**
 * WAHA (WhatsApp HTTP API, devlikeapro/waha) client — the alternative to the
 * Evolution API. A WhatsApp number (WhatsAppInstance.provider = 'WAHA') is a
 * WAHA "session" with the same name we'd give the Evolution instance.
 *
 * Built for the GOWS engine (WHATSAPP_DEFAULT_ENGINE=GOWS on the WAHA stack),
 * but the parsers accept the other engines' shapes too where they differ.
 *
 * Results come back in the shapes the rest of the code already reads from the
 * Evolution (see lib/wa.ts), so the lead queue, the offer senders and the
 * member tracking don't care which API a number uses.
 *
 * Platform credentials: WAHA_API_URL + WAHA_API_KEY from the environment,
 * falling back to the panel settings waha_api_url / waha_api_key.
 */
import axios, { AxiosError } from 'axios';
import QRCode from 'qrcode';
import prisma from './prisma';
import { sleep, type EvoResult, type EvoState } from './evolution';

let cfgCache: { at: number; url: string; key: string } | null = null;

export async function wahaConfig(): Promise<{ url: string; key: string } | null> {
  const envUrl = process.env.WAHA_API_URL?.trim();
  const envKey = process.env.WAHA_API_KEY?.trim();
  if (envUrl && envKey) return { url: envUrl.replace(/\/$/, ''), key: envKey };
  if (cfgCache && Date.now() - cfgCache.at < 30_000) return { url: cfgCache.url, key: cfgCache.key };
  const rows = await prisma.setting.findMany({ where: { key: { in: ['waha_api_url', 'waha_api_key'] } } });
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value.trim()]));
  if (!m.waha_api_url || !m.waha_api_key) return null;
  cfgCache = { at: Date.now(), url: m.waha_api_url.replace(/\/$/, ''), key: m.waha_api_key };
  return { url: cfgCache.url, key: cfgCache.key };
}

/** One WAHA call. Never throws for HTTP errors — callers read ok/status. */
export async function waha(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, timeout = 30000, accept = 'application/json',
): Promise<EvoResult> {
  const cfg = await wahaConfig();
  if (!cfg) return { ok: false, status: 0, data: { error: 'WAHA não configurado' } };
  try {
    const res = await axios.request({
      method,
      url: `${cfg.url}${path}`,
      data: body,
      headers: { 'X-Api-Key': cfg.key, 'Content-Type': 'application/json', Accept: accept },
      timeout,
      validateStatus: () => true,
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data };
  } catch (err) {
    const e = err as AxiosError;
    return { ok: false, status: 0, data: { error: e.message } };
  }
}

export function wahaError(r: EvoResult, fallback: string): string {
  const d = r.data;
  const msg = d?.message ?? d?.error ?? d?.exception?.message;
  const text = Array.isArray(msg) ? msg.flat().join(', ') : typeof msg === 'string' ? msg : null;
  if (r.status === 401 || r.status === 403) return 'O WAHA recusou a chave (WAHA_API_KEY do stack do WAHA).';
  if (r.status === 0) return `Não consegui falar com o WAHA: ${text ?? 'sem resposta'}`;
  return text ? `${fallback}: ${text}` : `${fallback} (HTTP ${r.status})`;
}

// ── Ids ─────────────────────────────────────────────────────────────────────

/** WAHA uses …@c.us for people; the rest of the system (and the member hashes) use …@s.whatsapp.net. */
export function toSwa(id: unknown): string {
  const s = String(id ?? '');
  return s.endsWith('@c.us') ? s.replace(/@c\.us$/, '@s.whatsapp.net') : s;
}

/** A phone, a phone JID or a group JID → a WAHA chatId. */
export function toChatId(to: string): string {
  const s = String(to).trim();
  if (s.includes('@')) return s.replace(/@s\.whatsapp\.net$/, '@c.us');
  return `${s.replace(/\D/g, '')}@c.us`;
}

const enc = encodeURIComponent;

// ── Sessions ────────────────────────────────────────────────────────────────

/** Our webhook in WAHA's format (the same URL and secret header as the Evolution's). */
async function webhookConfig(events: string[]) {
  const { getWebhookSecret, getWebhookUrl, WEBHOOK_TOKEN_HEADER } = await import('./memberTracking');
  return {
    url: await getWebhookUrl(),
    events,
    customHeaders: [{ name: WEBHOOK_TOKEN_HEADER, value: await getWebhookSecret() }],
  };
}

export const WAHA_EVENTS = { connection: 'session.status', participants: 'group.v2.participants' } as const;

async function getSession(name: string) {
  return waha('GET', `/api/sessions/${enc(name)}`, undefined, 15000);
}

export async function deleteSession(name: string) {
  await waha('DELETE', `/api/sessions/${enc(name)}`, undefined, 30000);
}

export async function logoutSession(name: string) {
  const r = await waha('POST', `/api/sessions/${enc(name)}/logout`, {}, 30000);
  // Logout restarts the session waiting for a new QR — keep it quiet until "Conectar".
  await waha('POST', `/api/sessions/${enc(name)}/stop`, {}, 30000);
  return r;
}

async function qrOnce(name: string): Promise<string | null> {
  const r = await waha('GET', `/api/${enc(name)}/auth/qr`, undefined, 20000);
  if (!r.ok) return null;
  const data = r.data?.data;
  if (typeof data === 'string' && data.length > 50) return `data:${r.data?.mimetype ?? 'image/png'};base64,${data}`;
  const value = r.data?.value;
  if (typeof value === 'string' && value.length > 10) return QRCode.toDataURL(value, { width: 256, margin: 2 });
  return null;
}

/** Recreates the session from scratch (webhook included) and returns its QR. */
export async function createSessionWithQr(name: string, events: string[]): Promise<{ qrcode: string | null; error?: string }> {
  await deleteSession(name);
  await sleep(500);
  const created = await waha('POST', '/api/sessions', {
    name,
    start: true,
    config: { webhooks: [await webhookConfig([...new Set(events.map(toWahaEvent))])] },
  }, 30000);
  console.log('[waha] create:', JSON.stringify(created.data).slice(0, 300));
  if (!created.ok) return { qrcode: null, error: wahaError(created, 'Erro ao criar a sessão no WAHA') };
  await sleep(2000);
  return getSessionQr(name);
}

/** A QR for an existing session (starts it when stopped; up to ~12 s while it boots). */
export async function getSessionQr(name: string): Promise<{ qrcode: string | null; state?: EvoState; error?: string }> {
  for (let i = 0; i < 6; i++) {
    if (i > 0) await sleep(2000);
    const s = await getSession(name);
    if (s.status === 404) return { qrcode: null, state: 'not_found' };
    if (s.status === 401 || s.status === 403) return { qrcode: null, error: wahaError(s, 'Erro ao gerar o QR') };
    const status = String(s.data?.status ?? '');
    if (status === 'WORKING') return { qrcode: null, state: 'open' };
    if (status === 'STOPPED' || status === 'FAILED') {
      // FAILED = the QRs expired (or WhatsApp logged it out): start again for a fresh QR.
      if (status === 'FAILED') await waha('POST', `/api/sessions/${enc(name)}/stop`, {});
      await waha('POST', `/api/sessions/${enc(name)}/start`, {});
      continue;
    }
    if (status !== 'SCAN_QR_CODE') continue;
    const qr = await qrOnce(name);
    if (qr) return { qrcode: qr, state: 'connecting' };
  }
  return { qrcode: null, error: 'QR Code indisponível. O WAHA pode estar iniciando a sessão — tente de novo em alguns segundos.' };
}

function stateOf(status: string): EvoState {
  if (status === 'WORKING') return 'open';
  if (status === 'STARTING' || status === 'SCAN_QR_CODE') return 'connecting';
  return 'close'; // STOPPED, FAILED, passkey states
}

export async function getSessionState(name: string): Promise<EvoState> {
  const r = await getSession(name);
  if (r.status === 404) return 'not_found';
  if (!r.ok) return 'error';
  return stateOf(String(r.data?.status ?? ''));
}

/**
 * Connected number + profile name. WAHA doesn't keep a disconnection code:
 * a FAILED session (after it was connected) is WhatsApp logging it out, so
 * it's reported as 401 without a date — callers only record it when the row
 * was connected, so it isn't re-recorded on every poll.
 */
export async function getSessionInfo(name: string) {
  const r = await getSession(name);
  const me = r.data?.me;
  const number = me?.id ? String(me.id).split('@')[0].split(':')[0] : null;
  const failed = String(r.data?.status ?? '') === 'FAILED';
  return {
    number: number || null,
    profileName: me?.pushName ?? null,
    disconnectCode: failed ? 401 : null,
    disconnectAt: null as Date | null,
  };
}

/**
 * WhatsApp's "reach-out timelock" on this number (a server-side block on
 * messaging people who never talked to it), as last seen by WAHA — from
 * GET /api/sessions/{s}/me. null = no lock seen / unknown.
 */
export async function getReachoutTimelock(name: string): Promise<{ active: boolean; until: Date | null } | null> {
  const r = await waha('GET', `/api/sessions/${enc(name)}/me`, undefined, 15000);
  const t = r.ok ? r.data?.reachoutTimelock : null;
  if (!t || typeof t !== 'object') return null;
  const endsRaw = t.timeEnforcementEnds ?? t.TimeEnforcementEnds ?? t.enforcementEnds ?? t.until ?? t.expiresAt ?? null;
  const until = endsRaw ? new Date(typeof endsRaw === 'number' && endsRaw < 1e12 ? endsRaw * 1000 : endsRaw) : null;
  const validUntil = until && !Number.isNaN(until.getTime()) ? until : null;
  const flag = t.isActive ?? t.IsActive ?? t.active;
  const active = typeof flag === 'boolean' ? flag : !!validUntil && validUntil.getTime() > Date.now();
  return { active: active && (!validUntil || validUntil.getTime() > Date.now()), until: validUntil };
}

/** The session's webhook pointing at us, Evolution-style ({ enabled, url, events }), or null. */
export async function getSessionWebhook(name: string): Promise<{ enabled: boolean; url: string; events: string[] } | null> {
  const r = await getSession(name);
  if (!r.ok) throw new Error(wahaError(r, 'Não consegui ler a sessão no WAHA'));
  const hooks: any[] = Array.isArray(r.data?.config?.webhooks) ? r.data.config.webhooks : [];
  const { getWebhookUrl } = await import('./memberTracking');
  const ours = await getWebhookUrl();
  const hook = hooks.find((h) => String(h?.url ?? '').replace(/\/$/, '') === ours.replace(/\/$/, '')) ?? hooks[0];
  if (!hook?.url) return null;
  return { enabled: true, url: String(hook.url), events: (hook.events ?? []).map((e: string) => fromWahaEvent(e)) };
}

/** Evolution event name → WAHA's, and back. */
function toWahaEvent(e: string) {
  const k = e.replace(/[._-]/g, '').toLowerCase();
  if (k === 'connectionupdate') return WAHA_EVENTS.connection;
  if (k === 'groupparticipantsupdate') return WAHA_EVENTS.participants;
  return e;
}
function fromWahaEvent(e: string) {
  if (e === WAHA_EVENTS.connection) return 'CONNECTION_UPDATE';
  if (e === WAHA_EVENTS.participants) return 'GROUP_PARTICIPANTS_UPDATE';
  return e;
}

/**
 * Makes our webhook carry exactly these events (Evolution or WAHA names).
 * WAHA keeps several webhooks per session, so other systems' hooks are kept.
 * Changing the config restarts a running session — skipped when nothing changes.
 */
export async function setSessionWebhook(name: string, events: string[]): Promise<string | null> {
  const r = await getSession(name);
  if (!r.ok) return wahaError(r, 'Não consegui ler a sessão no WAHA');
  const wanted = [...new Set(events.map(toWahaEvent))].sort();
  const mine = await webhookConfig(wanted);
  const config = r.data?.config ?? {};
  const hooks: any[] = Array.isArray(config.webhooks) ? config.webhooks : [];
  const same = (u: unknown) => String(u ?? '').replace(/\/$/, '') === mine.url.replace(/\/$/, '');
  const current = hooks.find((h) => same(h?.url));
  const currentHeader = (current?.customHeaders ?? []).find((h: any) => h?.name === mine.customHeaders[0].name)?.value;
  if (current && JSON.stringify([...(current.events ?? [])].sort()) === JSON.stringify(wanted) && currentHeader === mine.customHeaders[0].value) {
    return null;
  }
  const u = await waha('PUT', `/api/sessions/${enc(name)}`, {
    name,
    config: { ...config, webhooks: [...hooks.filter((h) => !same(h?.url)), mine] },
  }, 30000);
  return u.ok ? null : wahaError(u, 'Não consegui gravar o webhook no WAHA');
}

export async function checkWahaKey(): Promise<{ ok: boolean; message: string }> {
  if (!(await wahaConfig())) return { ok: false, message: 'URL e chave do WAHA não configuradas.' };
  const r = await waha('GET', '/api/sessions?all=true', undefined, 15000);
  if (r.ok) return { ok: true, message: `WAHA OK — chave aceita (${Array.isArray(r.data) ? r.data.length : '?'} sessões no servidor).` };
  return { ok: false, message: wahaError(r, 'O WAHA recusou a listagem de sessões') };
}

// ── Groups (answers in the Evolution's shapes) ──────────────────────────────

function roleOf(p: any): 'admin' | 'superadmin' | 'left' | null {
  const role = String(p?.role ?? '').toLowerCase();
  if (role === 'superadmin' || p?.IsSuperAdmin) return 'superadmin';
  if (role === 'admin' || p?.IsAdmin) return 'admin';
  if (role === 'left') return 'left';
  if (p?.admin === 'admin' || p?.admin === 'superadmin') return p.admin;
  return null;
}

/** → { participants: [{ id, phoneNumber?, admin }] } like Evolution's /group/participants. */
export async function groupParticipants(name: string, groupJid: string, timeout = 30000): Promise<EvoResult> {
  let r = await waha('GET', `/api/${enc(name)}/groups/${enc(groupJid)}/participants/v2`, undefined, timeout);
  if (r.status === 404) r = await waha('GET', `/api/${enc(name)}/groups/${enc(groupJid)}/participants`, undefined, timeout);
  if (!r.ok) return r;
  const raw: any[] = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.participants) ? r.data.participants : [];
  const participants = raw
    .map((p) => ({ p, role: roleOf(p) }))
    .filter(({ role }) => role !== 'left')
    .map(({ p, role }) => {
      const id = toSwa(p?.id ?? p?.JID ?? p?.jid);
      const pn = p?.pn ?? p?.PhoneNumber ?? p?.phoneNumber;
      return { id, ...(pn ? { phoneNumber: toSwa(pn) } : {}), admin: role };
    });
  return { ok: true, status: r.status, data: { participants } };
}

/** → { updateParticipants: [{ jid, status }] } like Evolution's /group/updateParticipant (status "200", "403", "408", "409"…). */
export async function addParticipant(name: string, groupJid: string, phone: string): Promise<EvoResult> {
  const call = (p: string) => waha('POST', `/api/${enc(name)}/groups/${enc(groupJid)}/participants/add`, {
    participants: [{ id: toChatId(p) }],
  }, 45000);
  const parse = (r: EvoResult) => {
    const arr: any[] = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.participants) ? r.data.participants : [];
    const item = arr[0];
    // GOWS answers whatsmeow's list: { JID, PhoneNumber, Error } (Error 0 = added); NOWEB { status }.
    const code = item?.status ?? item?.code ?? (item && 'Error' in item ? (Number(item.Error) || 200) : 200);
    return { jid: toSwa(item?.PhoneNumber || item?.JID || item?.jid || `${phone}@s.whatsapp.net`), status: String(code) };
  };
  let r = await call(phone);
  if (!r.ok) return r;
  let item = parse(r);
  // Brazilian numbers of older accounts are registered without the 9th digit.
  if ((item.status === '400' || item.status === '404') && phone.startsWith('55') && phone.length === 13 && phone[4] === '9') {
    const r2 = await call(phone.slice(0, 4) + phone.slice(5));
    if (r2.ok) { r = r2; item = parse(r2); }
  }
  return { ok: true, status: r.status, data: { updateParticipants: [item] } };
}

/** → { inviteUrl, inviteCode } like Evolution's /group/inviteCode. */
export async function groupInviteCode(name: string, groupJid: string): Promise<EvoResult> {
  const r = await waha('GET', `/api/${enc(name)}/groups/${enc(groupJid)}/invite-code`);
  if (!r.ok) return r;
  const raw = typeof r.data === 'string' ? r.data : r.data?.value ?? r.data?.code ?? r.data?.inviteCode ?? '';
  const s = String(raw).trim().replace(/^"|"$/g, '');
  if (!s) return { ok: false, status: r.status, data: { error: 'WAHA não devolveu o código de convite' } };
  const inviteUrl = s.includes('chat.whatsapp.com') ? s : `https://chat.whatsapp.com/${s}`;
  return { ok: true, status: r.status, data: { inviteUrl, inviteCode: inviteUrl.split('/').pop() } };
}

/** → [{ id, subject, size, isCommunity }] like Evolution's /group/fetchAllGroups. */
export async function fetchAllGroups(name: string, timeout = 90000): Promise<EvoResult> {
  const r = await waha('GET', `/api/${enc(name)}/groups?exclude=participants`, undefined, timeout);
  if (!r.ok) return r;
  const raw: any[] = Array.isArray(r.data) ? r.data : r.data && typeof r.data === 'object' ? Object.values(r.data) : [];
  const groups = raw.map((g) => {
    const participants = g?.participants ?? g?.Participants;
    const size = Number(g?.size ?? g?.ParticipantCount ?? (Array.isArray(participants) ? participants.length : NaN));
    return {
      id: String(g?.id?._serialized ?? g?.id ?? g?.JID ?? ''),
      subject: g?.subject ?? g?.Name ?? g?.name ?? g?.groupMetadata?.subject ?? '',
      size: Number.isFinite(size) ? size : null,
      isCommunity: !!(g?.isCommunity ?? g?.IsParent),
      isCommunityAnnounce: !!(g?.isCommunityAnnounce ?? g?.IsDefaultSubGroup),
    };
  });
  return { ok: true, status: r.status, data: groups };
}

/** Is a chat.whatsapp.com code still valid? → { ok, status, data: { subject } } (4xx = invalid). */
export async function inviteInfo(name: string, code: string): Promise<EvoResult> {
  const r = await waha('GET', `/api/${enc(name)}/groups/join-info?code=${enc(code)}`);
  if (!r.ok) return r;
  return { ok: true, status: r.status, data: { subject: r.data?.subject ?? r.data?.Name ?? r.data?.name } };
}

// ── Messages ────────────────────────────────────────────────────────────────

export async function sendText(name: string, to: string, text: string, timeout = 45000): Promise<EvoResult> {
  return waha('POST', '/api/sendText', { session: name, chatId: toChatId(to), text, linkPreview: true }, timeout);
}

export async function sendFile(
  name: string, to: string, kind: 'image' | 'document',
  file: { mimetype: string; filename: string; data: string }, caption: string,
): Promise<EvoResult> {
  return waha('POST', kind === 'image' ? '/api/sendImage' : '/api/sendFile', {
    session: name, chatId: toChatId(to), file, caption,
  }, 90000);
}

// ── Webhook (WAHA's payloads → the Evolution shapes our handlers read) ──────

export function isWahaWebhook(body: any): boolean {
  return typeof body?.session === 'string' && typeof body?.event === 'string' && body.event.includes('.');
}

/** group.v2.participants → Evolution's group-participants.update data, or null for other types. */
export function wahaParticipantsToEvo(payload: any): { id: string; action: 'add' | 'remove'; participants: any[] } | null {
  const type = String(payload?.type ?? '');
  const action = type === 'join' ? 'add' : type === 'leave' ? 'remove' : null;
  const id = String(payload?.group?.id ?? '');
  if (!action || !id) return null;
  const participants = (Array.isArray(payload?.participants) ? payload.participants : []).map((p: any) => ({
    id: toSwa(p?.id),
    ...(p?.pn ? { phoneNumber: toSwa(p.pn) } : {}),
  }));
  return { id, action, participants };
}

/** session.status → Evolution's CONNECTION_UPDATE data ({ state, wuid }). */
export function wahaStatusToEvo(body: any): { state: EvoState; wuid?: string; failed: boolean } {
  const status = String(body?.payload?.status ?? '');
  return { state: stateOf(status), wuid: body?.me?.id ? toSwa(body.me.id) : undefined, failed: status === 'FAILED' };
}
