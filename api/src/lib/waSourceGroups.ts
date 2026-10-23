/**
 * WhatsApp groups as offer sources (SourceGroup kind WHATSAPP).
 *
 * One of the account's numbers (readerInstance) is in the group; once a group
 * is registered, that number's webhook also sends its messages
 * (MESSAGES_UPSERT on the Evolution with groupsIgnore off, "message" on
 * WAHA). Each new text message from a registered, active group is handed to
 * the telegram-listener (POST /whatsapp/message), which runs the very same
 * pipeline as a Telegram message — affiliate conversion, product mockup,
 * word strip — and posts the offer.
 *
 * Reading messages is passive: nothing is sent, so it doesn't add to the
 * restrictions WhatsApp puts on linked devices.
 */
import axios from 'axios';
import { createHash } from 'crypto';
import prisma from './prisma';
import { allowGroupMessages } from './wa';

const LISTENER_URL = process.env.TELEGRAM_LISTENER_URL ?? 'http://telegram-listener:8080';
const INTERNAL_TOKEN = 'sistema-grupos-ofertas-internal-token-fallback-key-2026';
const MAX_AGE_S = 15 * 60; // older messages are a history replay after a reconnect, not new offers

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** Stable synthetic SourceGroup.telegramId for a WhatsApp group — far outside Telegram's range (like SHOPEE's). */
export function syntheticTelegramId(jid: string): bigint {
  return 9_100_000_000_000_000_000n + (BigInt(`0x${sha1(jid).slice(0, 15)}`) % 100_000_000_000_000n);
}

/** WhatsApp message ids are strings; Offer.telegramMessageId is numeric (< 2^52, safe in JSON). */
export function numericMessageId(id: string): number {
  return parseInt(sha1(id).slice(0, 13), 16);
}

export interface GroupMessage {
  instance: string;
  groupJid: string;
  id: string;
  fromMe: boolean;
  text: string;
  senderName: string | null;
  timestamp: number | null; // seconds
}

/** Evolution messages.upsert → GroupMessage (null for anything that isn't a group text). */
export function parseEvolutionUpsert(instance: string | undefined, data: any): GroupMessage | null {
  const d = Array.isArray(data) ? data[0] : data;
  const jid = String(d?.key?.remoteJid ?? '');
  if (!instance || !jid.endsWith('@g.us')) return null;
  const m = d?.message ?? {};
  const text = m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? m.videoMessage?.caption ?? m.documentMessage?.caption
    ?? m.ephemeralMessage?.message?.extendedTextMessage?.text ?? m.ephemeralMessage?.message?.conversation ?? '';
  const ts = Number(d?.messageTimestamp);
  return {
    instance, groupJid: jid, id: String(d?.key?.id ?? ''), fromMe: !!d?.key?.fromMe,
    text: String(text ?? ''), senderName: d?.pushName ?? null, timestamp: Number.isFinite(ts) && ts > 0 ? ts : null,
  };
}

/** WAHA "message" event → GroupMessage. */
export function parseWahaMessage(session: string | undefined, payload: any): GroupMessage | null {
  const jid = String(payload?.from ?? '');
  if (!session || !jid.endsWith('@g.us')) return null;
  const ts = Number(payload?.timestamp);
  return {
    instance: session, groupJid: jid, id: String(payload?.id ?? ''), fromMe: !!payload?.fromMe,
    text: String(payload?.body ?? ''),
    senderName: payload?._data?.Info?.PushName ?? payload?._data?.notifyName ?? payload?._data?.pushName ?? null,
    timestamp: Number.isFinite(ts) && ts > 0 ? ts : null,
  };
}

// Registered groups by JID (60 s cache) and the ids already handed over.
let cache: { at: number; byJid: Map<string, { id: string; telegramId: bigint; niche: unknown }> } | null = null;
const seen = new Map<string, number>();

export function forgetSourceCache() {
  cache = null;
}

async function sources() {
  if (cache && Date.now() - cache.at < 60_000) return cache.byJid;
  const rows = await prisma.sourceGroup.findMany({
    where: { kind: 'WHATSAPP', isActive: true, whatsappJid: { not: null } },
    include: { niche: true },
  });
  cache = { at: Date.now(), byJid: new Map(rows.map((r) => [r.whatsappJid as string, { id: r.id, telegramId: r.telegramId, niche: r.niche }])) };
  return cache.byJid;
}

/** A group message from a webhook: hand it to the listener when it comes from a registered source. */
export async function handleGroupMessage(msg: GroupMessage | null): Promise<string> {
  if (!msg) return 'ignored: not a group message';
  if (msg.fromMe) return 'ignored: own message';
  if (!msg.text.trim()) return 'ignored: no text';
  if (msg.timestamp && Date.now() / 1000 - msg.timestamp > MAX_AGE_S) return 'ignored: old message';
  const src = (await sources()).get(msg.groupJid);
  if (!src) return 'ignored: not a source group';

  // Several of the account's numbers may be in the same group: the first one wins.
  const key = `${msg.groupJid}|${msg.id}`;
  if (seen.has(key)) return 'ignored: duplicate';
  seen.set(key, Date.now());
  if (seen.size > 5000) for (const [k] of [...seen.entries()].slice(0, 2500)) seen.delete(k);

  await axios.post(`${LISTENER_URL}/whatsapp/message`, {
    sourceGroupId: src.id,
    chatId: src.telegramId.toString(),
    messageId: numericMessageId(msg.id),
    text: msg.text,
    senderName: msg.senderName,
    timestamp: msg.timestamp,
    niche: src.niche,
  }, { headers: { 'X-Internal-Key': INTERNAL_TOKEN }, timeout: 10_000 });
  return 'sent to the listener';
}

/** Makes a number deliver its group messages to us (Evolution setting + webhook events). */
export async function ensureGroupReader(instanceName: string): Promise<string | null> {
  const row = await prisma.whatsAppInstance.findUnique({ where: { name: instanceName }, select: { purpose: true } });
  const { registerWebhook } = await import('./whatsappNumbers');
  const settingErr = await allowGroupMessages(instanceName);
  const hookErr = await registerWebhook(instanceName, row?.purpose ?? 'LEADS');
  return settingErr ?? hookErr;
}

/** Whether a number reads any active WhatsApp source group (→ its webhook needs MESSAGES_UPSERT). */
export async function readsSourceGroups(instanceName: string): Promise<boolean> {
  return (await prisma.sourceGroup.count({ where: { kind: 'WHATSAPP', readerInstance: instanceName, isActive: true } })) > 0;
}
