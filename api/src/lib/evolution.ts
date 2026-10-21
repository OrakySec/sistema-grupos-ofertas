/**
 * Evolution API v2 client for the WhatsApp numbers each account connects by
 * QR code (adapted from the whatsapp-qrcode skill / Sistema3D).
 *
 * Platform-level credentials: EVOLUTION_API_URL + EVOLUTION_API_KEY (the
 * Evolution's global AUTHENTICATION_API_KEY) from the environment — tenants
 * never see them. While the multi-tenant foundation isn't in place, the
 * panel's evolution_api_url / evolution_api_key settings are the fallback.
 *
 * Instance names: `<WHATSAPP_INSTANCE_PREFIX>_<WhatsAppInstance.id>` — the
 * full cuid, so two rows can never collide, and a per-install prefix so other
 * systems sharing the same Evolution (Sistema3D…) don't either.
 */
import axios, { AxiosError } from 'axios';
import QRCode from 'qrcode';
import prisma from './prisma';

export type EvoState = 'open' | 'connecting' | 'close' | 'not_found' | 'error';

export const INSTANCE_PREFIX = (process.env.WHATSAPP_INSTANCE_PREFIX || 'ofertas').replace(/[^a-zA-Z0-9]/g, '');

export function instanceNameFor(rowId: string) {
  return `${INSTANCE_PREFIX}_${rowId}`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let cfgCache: { at: number; url: string; key: string } | null = null;

export async function evoConfig(): Promise<{ url: string; key: string } | null> {
  const envUrl = process.env.EVOLUTION_API_URL?.trim();
  const envKey = process.env.EVOLUTION_API_KEY?.trim();
  if (envUrl && envKey) return { url: envUrl.replace(/\/$/, ''), key: envKey };
  if (cfgCache && Date.now() - cfgCache.at < 30_000) return { url: cfgCache.url, key: cfgCache.key };
  const rows = await prisma.setting.findMany({ where: { key: { in: ['evolution_api_url', 'evolution_api_key'] } } });
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value.trim()]));
  if (!m.evolution_api_url || !m.evolution_api_key) return null;
  cfgCache = { at: Date.now(), url: m.evolution_api_url.replace(/\/$/, ''), key: m.evolution_api_key };
  return { url: cfgCache.url, key: cfgCache.key };
}

export interface EvoResult { ok: boolean; status: number; data: any }

/** One Evolution call. Never throws for HTTP errors — callers read ok/status. */
export async function evo(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, timeout = 30000): Promise<EvoResult> {
  const cfg = await evoConfig();
  if (!cfg) return { ok: false, status: 0, data: { error: 'Evolution API não configurada' } };
  try {
    const res = await axios.request({
      method,
      url: `${cfg.url}${path}`,
      data: body,
      headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
      timeout,
      validateStatus: () => true,
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data };
  } catch (err) {
    const e = err as AxiosError;
    return { ok: false, status: 0, data: { error: e.message } };
  }
}

/** Human-readable error text out of an Evolution response. */
export function evoError(r: EvoResult, fallback: string): string {
  const d = r.data;
  const msg = d?.response?.message ?? d?.message ?? d?.error;
  const text = Array.isArray(msg) ? msg.flat().join(', ') : msg;
  if (r.status === 401 || r.status === 403) {
    return 'A Evolution recusou a chave. Para criar números pelo painel é preciso a chave GLOBAL (AUTHENTICATION_API_KEY do stack da Evolution).';
  }
  if (r.status === 0) return `Não consegui falar com a Evolution: ${text ?? 'sem resposta'}`;
  return text ? `${fallback}: ${text}` : `${fallback} (HTTP ${r.status})`;
}

/** Accepts { base64 } | { code } | { qrcode: { base64 | code } } → data URL or null. */
export async function extractQr(data: any): Promise<string | null> {
  const base64 = data?.base64 ?? data?.qrcode?.base64 ?? null;
  if (typeof base64 === 'string' && base64.startsWith('data:')) return base64;
  const code = data?.code ?? data?.qrcode?.code ?? null;
  if (typeof code === 'string' && code.length > 10) return QRCode.toDataURL(code, { width: 256, margin: 2 });
  return null;
}

export async function deleteInstance(name: string) {
  await evo('DELETE', `/instance/delete/${name}`);
}

export async function logoutInstance(name: string) {
  return evo('DELETE', `/instance/logout/${name}`);
}

/** Recreates the instance from scratch and returns its QR (falls back to /connect). */
export async function createInstanceWithQr(name: string): Promise<{ qrcode: string | null; error?: string }> {
  // Recreating avoids the classic "stuck in connecting" Evolution state.
  await deleteInstance(name);
  await sleep(500);

  const created = await evo('POST', '/instance/create', {
    instanceName: name,
    integration: 'WHATSAPP-BAILEYS',
    qrcode: true,
    rejectCall: false,
    groupsIgnore: true,
  });
  console.log('[evolution] create:', JSON.stringify(created.data).slice(0, 300));
  if (!created.ok) return { qrcode: null, error: evoError(created, 'Erro ao criar a instância') };

  const qr = await extractQr(created.data);
  if (qr) return { qrcode: qr };
  await sleep(2000);
  return getQr(name);
}

/** A fresh QR for an existing instance (up to 5 tries, 2 s apart — it may still be booting). */
export async function getQr(name: string): Promise<{ qrcode: string | null; state?: EvoState; error?: string }> {
  for (let i = 0; i < 5; i++) {
    if (i > 0) await sleep(2000);
    const r = await evo('GET', `/instance/connect/${name}`);
    console.log(`[evolution] connect ${i + 1}:`, JSON.stringify(r.data).slice(0, 300));
    if (r.status === 404) return { qrcode: null, state: 'not_found' };
    if (r.status === 401 || r.status === 403) return { qrcode: null, error: evoError(r, 'Erro ao gerar o QR') };
    if (!r.ok) continue;
    const state = r.data?.instance?.state ?? r.data?.state;
    if (state === 'open') return { qrcode: null, state: 'open' };
    const qr = await extractQr(r.data);
    if (qr) return { qrcode: qr, state };
  }
  return { qrcode: null, error: 'QR Code indisponível. A Evolution pode estar iniciando — tente de novo em alguns segundos.' };
}

export async function getState(name: string): Promise<EvoState> {
  const r = await evo('GET', `/instance/connectionState/${name}`, undefined, 15000);
  if (r.status === 404) return 'not_found';
  if (!r.ok) return 'error';
  return (r.data?.instance?.state ?? r.data?.state ?? 'close') as EvoState;
}

/** Connected number + profile name, from fetchInstances (shape differs between v2 releases). */
export async function getInstanceInfo(name: string): Promise<{ number: string | null; profileName: string | null }> {
  const r = await evo('GET', `/instance/fetchInstances?instanceName=${encodeURIComponent(name)}`, undefined, 15000);
  const list: any[] = Array.isArray(r.data) ? r.data : r.data ? [r.data] : [];
  const row = list.find((x) => (x?.name ?? x?.instance?.instanceName) === name) ?? list[0];
  const jid: string | undefined = row?.ownerJid ?? row?.instance?.owner ?? row?.owner;
  const number = jid ? String(jid).split('@')[0].split(':')[0] : row?.number ?? null;
  return { number: number || null, profileName: row?.profileName ?? row?.instance?.profileName ?? null };
}

/** True when the configured key can list every instance (i.e. it's the global key). */
export async function checkGlobalKey(): Promise<{ ok: boolean; message: string }> {
  const cfg = await evoConfig();
  if (!cfg) return { ok: false, message: 'URL e chave da Evolution não configuradas.' };
  const r = await evo('GET', '/instance/fetchInstances', undefined, 15000);
  if (r.ok) return { ok: true, message: `Evolution OK — chave global aceita (${Array.isArray(r.data) ? r.data.length : '?'} instâncias no servidor).` };
  return { ok: false, message: evoError(r, 'A Evolution recusou a listagem de instâncias') };
}

/**
 * Brazilian phone → 55DDDNNNNNNNN (12–13 digits), or null. Accepts the usual
 * mess: "+55 (11) 9 1234-5678", "011912345678", "11912345678", "5511…".
 */
export function normalizePhoneBR(raw: string): string | null {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('0')) d = d.replace(/^0+/, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  return null;
}
