/**
 * Which WhatsApp API a number goes through — Evolution or WAHA — and the
 * calls the rest of the system makes, routed to the right one.
 *
 * Each WhatsAppInstance row records its own provider (a number connected by
 * QR lives inside one API); the panel setting `whatsapp_provider` only picks
 * the API for NEW numbers. A name with no row (e.g. an old evolution_instance
 * typed by hand) is an Evolution instance.
 *
 * WAHA's answers are translated into the Evolution's shapes (lib/waha.ts), so
 * callers keep reading `r.data.participants`, `r.data.updateParticipants`…
 */
import prisma from './prisma';
import * as evolution from './evolution';
import * as wahaApi from './waha';
import type { EvoResult, EvoState } from './evolution';

export type Provider = 'EVOLUTION' | 'WAHA';
export const PROVIDERS: Provider[] = ['EVOLUTION', 'WAHA'];
export const PROVIDER_LABEL: Record<Provider, string> = { EVOLUTION: 'Evolution', WAHA: 'WAHA' };

export function asProvider(v: unknown): Provider | null {
  const s = String(v ?? '').toUpperCase();
  return s === 'WAHA' || s === 'EVOLUTION' ? s : null;
}

/** API for numbers created from now on (panel setting, default Evolution). */
export async function defaultProvider(): Promise<Provider> {
  const row = await prisma.setting.findUnique({ where: { key: 'whatsapp_provider' } });
  return asProvider(row?.value) ?? 'EVOLUTION';
}

export async function providerConfigured(p: Provider): Promise<boolean> {
  return p === 'WAHA' ? !!(await wahaApi.wahaConfig()) : !!(await evolution.evoConfig());
}

const cache = new Map<string, { at: number; p: Provider }>();

export async function providerOf(name: string): Promise<Provider> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < 30_000) return hit.p;
  const row = await prisma.whatsAppInstance.findUnique({ where: { name }, select: { provider: true } });
  const p = asProvider(row?.provider) ?? 'EVOLUTION';
  cache.set(name, { at: Date.now(), p });
  return p;
}

export function forgetProvider(name: string) {
  cache.delete(name);
}

const isWaha = async (name: string, provider?: Provider) => (provider ?? (await providerOf(name))) === 'WAHA';
const enc = encodeURIComponent;

// ── Connection ──────────────────────────────────────────────────────────────

/** Events of our webhook, by the number's role (Evolution names; translated for WAHA). */
export function webhookEvents(purpose: string): string[] {
  return ['CONNECTION_UPDATE', ...(purpose === 'OFFERS' ? ['GROUP_PARTICIPANTS_UPDATE'] : [])];
}

export async function createWithQr(name: string, purpose: string, provider?: Provider) {
  return (await isWaha(name, provider))
    ? wahaApi.createSessionWithQr(name, webhookEvents(purpose))
    : evolution.createInstanceWithQr(name);
}

export async function getQr(name: string, provider?: Provider) {
  return (await isWaha(name, provider)) ? wahaApi.getSessionQr(name) : evolution.getQr(name);
}

export async function getState(name: string, provider?: Provider): Promise<EvoState> {
  return (await isWaha(name, provider)) ? wahaApi.getSessionState(name) : evolution.getState(name);
}

export async function getInfo(name: string, provider?: Provider) {
  return (await isWaha(name, provider)) ? wahaApi.getSessionInfo(name) : evolution.getInstanceInfo(name);
}

export async function logout(name: string, provider?: Provider) {
  return (await isWaha(name, provider)) ? wahaApi.logoutSession(name) : evolution.logoutInstance(name);
}

export async function remove(name: string, provider?: Provider) {
  return (await isWaha(name, provider)) ? wahaApi.deleteSession(name) : evolution.deleteInstance(name);
}

/**
 * Brings a dropped session back with the credentials it already has — no QR.
 * Works when WhatsApp only closed the connection; when it really unlinked the
 * device the API ends up asking for a QR, which counts as "didn't come back"
 * (a WAHA session is then stopped so it doesn't sit generating QRs).
 */
export async function resume(name: string, provider?: Provider, waitMs = 20000): Promise<boolean> {
  const p = provider ?? (await providerOf(name));
  if (p === 'WAHA') {
    const s = await wahaApi.waha('GET', `/api/sessions/${enc(name)}`, undefined, 15000);
    if (s.status === 404 || !s.ok) return false;
    const status = String(s.data?.status ?? '');
    if (status === 'WORKING') return true;
    if (status === 'FAILED') await wahaApi.waha('POST', `/api/sessions/${enc(name)}/stop`, {});
    await wahaApi.waha('POST', `/api/sessions/${enc(name)}/${status === 'STOPPED' || status === 'FAILED' ? 'start' : 'restart'}`, {});
  } else {
    const r = await evolution.evo('GET', `/instance/connect/${name}`, undefined, 30000);
    if (r.status === 404) return false;
    if ((r.data?.instance?.state ?? r.data?.state) === 'open') return true;
  }
  for (let waited = 0; waited < waitMs; waited += 4000) {
    await evolution.sleep(4000);
    if (p === 'WAHA') {
      const s = await wahaApi.waha('GET', `/api/sessions/${enc(name)}`, undefined, 15000);
      const status = String(s.data?.status ?? '');
      if (status === 'WORKING') return true;
      if (status === 'SCAN_QR_CODE' || status === 'FAILED') {
        await wahaApi.waha('POST', `/api/sessions/${enc(name)}/stop`, {});
        return false;
      }
    } else if ((await evolution.getState(name)) === 'open') {
      return true;
    }
  }
  return false;
}

/** Reach-out timelock (WAHA only; the Evolution doesn't expose it → null = unknown). */
export async function reachoutLock(name: string): Promise<{ active: boolean; until: Date | null } | null> {
  return (await isWaha(name)) ? wahaApi.getReachoutTimelock(name).catch(() => null) : null;
}

// ── Groups and messages (Evolution-shaped results) ──────────────────────────

export async function groupParticipants(name: string, groupJid: string, timeout = 30000): Promise<EvoResult> {
  return (await isWaha(name))
    ? wahaApi.groupParticipants(name, groupJid, timeout)
    : evolution.evo('GET', `/group/participants/${name}?groupJid=${enc(groupJid)}`, undefined, timeout);
}

export async function addParticipant(name: string, groupJid: string, phone: string): Promise<EvoResult> {
  return (await isWaha(name))
    ? wahaApi.addParticipant(name, groupJid, phone)
    : evolution.evo('POST', `/group/updateParticipant/${name}?groupJid=${enc(groupJid)}`, { action: 'add', participants: [phone] }, 45000);
}

export async function groupInviteCode(name: string, groupJid: string): Promise<EvoResult> {
  return (await isWaha(name))
    ? wahaApi.groupInviteCode(name, groupJid)
    : evolution.evo('GET', `/group/inviteCode/${name}?groupJid=${enc(groupJid)}`);
}

export async function fetchAllGroups(name: string, timeout = 90000): Promise<EvoResult> {
  return (await isWaha(name))
    ? wahaApi.fetchAllGroups(name, timeout)
    : evolution.evo('GET', `/group/fetchAllGroups/${name}?getParticipants=false`, undefined, timeout);
}

export async function sendText(name: string, to: string, text: string, timeout = 45000): Promise<EvoResult> {
  return (await isWaha(name))
    ? wahaApi.sendText(name, to, text, timeout)
    : evolution.evo('POST', `/message/sendText/${name}`, { number: to, text }, timeout);
}
