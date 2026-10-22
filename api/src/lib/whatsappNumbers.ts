/**
 * WhatsApp numbers connected by QR code (WhatsAppInstance rows).
 *
 * Each new instance gets our webhook right away (CONNECTION_UPDATE — plus
 * GROUP_PARTICIPANTS_UPDATE for the number that posts the offers, which feeds
 * the member analytics), so the panel learns that a number connected or
 * dropped even with the page closed. The status is also re-read live
 * (connectionState) whenever the panel polls.
 */
import { randomBytes } from 'crypto';
import prisma from './prisma';
import { disconnectReasonText, evo, getInstanceInfo, getState, instanceNameFor, LOGOUT_CODES, type EvoState } from './evolution';
import { alertOwner } from './leadQueue';
import { getWebhookSecret, getWebhookUrl, WEBHOOK_EVENT, WEBHOOK_TOKEN_HEADER } from './memberTracking';

export const MAX_NUMBERS = Math.max(1, Number(process.env.WHATSAPP_MAX_NUMBERS) || 5);

export function newInstanceId() {
  return `wa${randomBytes(10).toString('hex')}`;
}

export { instanceNameFor };

/** Points the instance's (single) webhook at us. Best-effort: returns an error text instead of throwing. */
export async function registerWebhook(name: string, purpose: string): Promise<string | null> {
  const events = ['CONNECTION_UPDATE', ...(purpose === 'OFFERS' ? [WEBHOOK_EVENT] : [])];
  const r = await evo('POST', `/webhook/set/${name}`, {
    webhook: {
      enabled: true,
      url: await getWebhookUrl(),
      headers: { [WEBHOOK_TOKEN_HEADER]: await getWebhookSecret() },
      byEvents: false,
      base64: false,
      events,
    },
  });
  return r.ok ? null : `webhook/set falhou (HTTP ${r.status}): ${JSON.stringify(r.data).slice(0, 200)}`;
}

/** Re-reads the live state and mirrors it on the row. */
export async function refreshInstance(id: string) {
  const row = await prisma.whatsAppInstance.findUnique({ where: { id } });
  if (!row) return null;
  const state: EvoState = await getState(row.name);
  if (state === 'error') return { ...row, liveState: state };
  const connected = state === 'open';
  const data: Record<string, unknown> = { connected, lastState: state };
  if (connected) {
    data.lastSeenAt = new Date();
    // Learn the number the first time (or after a reconnect with another phone).
    if (!row.connected || !row.number) {
      const info = await getInstanceInfo(row.name).catch(() => null);
      if (info?.number) data.number = info.number;
      if (info?.profileName) data.profileName = info.profileName;
    }
  } else if (state === 'close') {
    // Why it dropped (Evolution keeps the last disconnection code).
    const info = await getInstanceInfo(row.name).catch(() => null);
    if (info?.disconnectCode) await recordDisconnect(row.id, info.disconnectCode, info.disconnectAt ?? new Date());
  }
  const updated = await prisma.whatsAppInstance.update({ where: { id }, data });
  return { ...updated, liveState: state };
}

/**
 * WhatsApp closed a number's session. Remembers why, and when it's a logout
 * (device removed / forbidden — the session won't come back by itself) pauses
 * that number's lead queue and alerts the owner: reconnecting and going right
 * back to adding people is what got the session removed again.
 */
export async function recordDisconnect(id: string, code: number, at: Date) {
  const row = await prisma.whatsAppInstance.findUnique({ where: { id } });
  if (!row) return;
  // Same event seen again (webhook + live check) → nothing new.
  if (row.lastDisconnectAt && Math.abs(row.lastDisconnectAt.getTime() - at.getTime()) < 60_000 && row.lastDisconnectCode === code) return;
  const logout = LOGOUT_CODES.has(code);
  const when = at.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  await prisma.whatsAppInstance.update({
    where: { id },
    data: {
      lastDisconnectAt: at,
      lastDisconnectCode: code,
      ...(logout ? {
        connected: false,
        leadPaused: true,
        leadPausedReason: `Pausado sozinho: às ${when} ${disconnectReasonText(code)}. Reconecte e só retome a fila quando tiver certeza.`,
      } : {}),
    },
  });
  if (logout) {
    await alertOwner(`⚠️ WhatsApp "${row.label}"${row.number ? ` (${row.number})` : ''} foi desconectado às ${when}: ${disconnectReasonText(code)}.\nA fila de leads dele foi pausada. Reconecte pelo painel e só retome quando tiver certeza.`);
  }
}

export function isConnectionEvent(event: unknown): boolean {
  return String(event ?? '').replace(/[._-]/g, '').toLowerCase() === 'connectionupdate';
}

/** Evolution CONNECTION_UPDATE webhook → row status. */
export async function recordConnectionUpdate(instance: string | undefined, data: any) {
  if (!instance) return;
  const state = String(data?.state ?? '');
  if (!['open', 'close', 'connecting'].includes(state)) return;
  const jid: string | undefined = data?.wuid ?? data?.jid;
  await prisma.whatsAppInstance.updateMany({
    where: { name: instance },
    data: {
      connected: state === 'open',
      lastState: state,
      ...(state === 'open' ? { lastSeenAt: new Date() } : {}),
      ...(state === 'open' && jid ? { number: String(jid).split('@')[0].split(':')[0] } : {}),
    },
  });
  const code = Number(data?.statusReason ?? data?.statusCode);
  if (state === 'close' && Number.isFinite(code) && code > 0) {
    const row = await prisma.whatsAppInstance.findUnique({ where: { name: instance }, select: { id: true } });
    if (row) await recordDisconnect(row.id, code, new Date());
  }
}

/** The account's number that posts the offers is still read from this setting by WhatsAppService. */
export async function setOffersInstance(tenantId: string, id: string) {
  const row = await prisma.whatsAppInstance.findFirst({ where: { id, tenantId } });
  if (!row) return null;
  await prisma.$transaction([
    prisma.whatsAppInstance.updateMany({ where: { tenantId, purpose: 'OFFERS', NOT: { id } }, data: { purpose: 'LEADS' } }),
    prisma.whatsAppInstance.update({ where: { id }, data: { purpose: 'OFFERS', sendsOffers: true } }),
    // TODO(multi-tenant): per-tenant setting once Setting is tenant-scoped.
    prisma.setting.upsert({
      where: { key: 'evolution_instance' },
      update: { value: row.name },
      create: { key: 'evolution_instance', value: row.name },
    }),
  ]);
  return row;
}
