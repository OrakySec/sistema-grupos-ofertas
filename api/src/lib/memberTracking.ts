/**
 * WhatsApp group membership tracking (destination groups only).
 *
 * Two inputs feed the same tables:
 *  - Evolution API's group-participants.update webhook — real-time joins and
 *    leaves (recordParticipantsUpdate).
 *  - A periodic participant snapshot (snapshotWhatsAppGroups) — records the
 *    member count and reconciles anything the webhook missed while it was
 *    down. A group's very first snapshot is the baseline: people already in
 *    the group are stored with an unknown join date.
 *
 * Members are keyed by a salted hash of the id WhatsApp uses for them inside
 * that group (phone JID or @lid) — the raw number is never stored.
 */
import { createHash, randomBytes } from 'crypto';
import prisma from './prisma';
import { WhatsAppService } from '../services/whatsapp.service';

const HASH_SALT = process.env.JWT_SECRET ?? 'changeme-jwt-secret';
export const WEBHOOK_EVENT = 'GROUP_PARTICIPANTS_UPDATE';
export const WEBHOOK_TOKEN_HEADER = 'x-ofertas-webhook-token';
const SECRET_KEY = 'evolution_webhook_secret';
const LAST_EVENT_KEY = 'wa_webhook_last_event_at';

export function hashMember(jid: string): string {
  return createHash('sha256').update(`${HASH_SALT}|wa|${jid.trim().toLowerCase()}`).digest('hex').slice(0, 32);
}

/** Participants arrive as JID strings or (newer Baileys) objects with an id. */
export function participantIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => (typeof p === 'string' ? p : (p as any)?.id ?? (p as any)?.jid ?? ''))
    .map((s) => String(s))
    .filter(Boolean);
}

/** Event name variants: "group-participants.update", "GROUP_PARTICIPANTS_UPDATE"… */
export function isParticipantsEvent(event: unknown): boolean {
  return String(event ?? '').replace(/[._-]/g, '').toLowerCase() === 'groupparticipantsupdate';
}

// ── Membership state transitions ────────────────────────────────────────────

type Source = 'WEBHOOK' | 'SNAPSHOT';

async function applyJoin(destinationGroupId: string, memberHash: string, at: Date, source: Source): Promise<boolean> {
  const key = { destinationGroupId_memberHash: { destinationGroupId, memberHash } };
  const existing = await prisma.waMember.findUnique({ where: key });
  if (existing && !existing.leftAt) return false; // already in the group
  if (existing) {
    await prisma.waMember.update({ where: key, data: { joinedAt: at, leftAt: null, joinCount: { increment: 1 } } });
  } else {
    await prisma.waMember.create({ data: { destinationGroupId, memberHash, joinedAt: at, joinCount: 1 } });
  }
  await prisma.waMemberEvent.create({ data: { destinationGroupId, memberHash, type: 'JOIN', source, createdAt: at } });
  return true;
}

async function applyLeave(
  destinationGroupId: string,
  memberHash: string,
  at: Date,
  type: 'LEAVE' | 'KICK',
  source: Source,
): Promise<boolean> {
  const key = { destinationGroupId_memberHash: { destinationGroupId, memberHash } };
  const existing = await prisma.waMember.findUnique({ where: key });
  if (existing?.leftAt) return false; // already out
  if (existing) {
    await prisma.waMember.update({ where: key, data: { leftAt: at } });
  } else {
    // Joined before tracking started — we only learn about them as they leave.
    await prisma.waMember.create({ data: { destinationGroupId, memberHash, joinedAt: null, leftAt: at } });
  }
  await prisma.waMemberEvent.create({
    data: { destinationGroupId, memberHash, type, source, memberJoinedAt: existing?.joinedAt ?? null, createdAt: at },
  });
  return true;
}

/**
 * Applies one group-participants.update payload. Unknown groups (anything
 * that isn't a registered WhatsApp destination) are ignored.
 */
export async function recordParticipantsUpdate(data: any): Promise<{ applied: number; ignored?: string }> {
  const groupJid = String(data?.id ?? data?.groupJid ?? '');
  const action = String(data?.action ?? '').toLowerCase();
  if (!groupJid || (action !== 'add' && action !== 'remove')) return { applied: 0, ignored: `action ${action || '?'}` };

  const dest = await prisma.destinationGroup.findFirst({ where: { type: 'WHATSAPP', chatId: groupJid }, select: { id: true } });
  if (!dest) return { applied: 0, ignored: 'grupo não cadastrado' };

  const author = participantIds([data?.author])[0] ?? '';
  const now = new Date();
  let applied = 0;
  for (const jid of participantIds(data?.participants)) {
    const memberHash = hashMember(jid);
    if (action === 'add') {
      if (await applyJoin(dest.id, memberHash, now, 'WEBHOOK')) applied++;
    } else {
      // Removed by someone else = kicked by an admin; otherwise they left.
      const type = author && author !== jid ? 'KICK' : 'LEAVE';
      if (await applyLeave(dest.id, memberHash, now, type, 'WEBHOOK')) applied++;
    }
  }
  await prisma.setting.upsert({
    where: { key: LAST_EVENT_KEY },
    update: { value: now.toISOString() },
    create: { key: LAST_EVENT_KEY, value: now.toISOString() },
  });
  return { applied };
}

// ── Periodic snapshot ───────────────────────────────────────────────────────

export interface SnapshotResult {
  group: string;
  members?: number;
  joins?: number;
  leaves?: number;
  baseline?: boolean;
  skipped?: string;
  error?: string;
}

export async function snapshotWhatsAppGroups(): Promise<SnapshotResult[]> {
  const whatsapp = new WhatsAppService();
  const groups = await prisma.destinationGroup.findMany({ where: { type: 'WHATSAPP', isActive: true } });
  const results: SnapshotResult[] = [];

  for (const g of groups) {
    try {
      const ids = await whatsapp.getGroupParticipantIds(g.chatId);
      const now = new Date();
      const current = new Set(ids.map(hashMember));
      const isBaseline = (await prisma.waGroupSnapshot.count({ where: { destinationGroupId: g.id } })) === 0;
      const active = await prisma.waMember.findMany({
        where: { destinationGroupId: g.id, leftAt: null },
        select: { memberHash: true },
      });

      // A participant list that suddenly shrank by half is far more likely a
      // partial/broken response than half the group leaving at once — record
      // nothing rather than invent a mass exodus.
      if (!isBaseline && active.length >= 20 && current.size < active.length * 0.5) {
        results.push({ group: g.name, skipped: `lista veio com ${current.size} de ~${active.length} membros` });
        continue;
      }

      let joins = 0;
      let leaves = 0;
      if (isBaseline) {
        for (const memberHash of current) {
          await prisma.waMember.upsert({
            where: { destinationGroupId_memberHash: { destinationGroupId: g.id, memberHash } },
            update: {},
            create: { destinationGroupId: g.id, memberHash, joinedAt: null, joinCount: 0 },
          });
        }
      } else {
        const activeSet = new Set(active.map((m) => m.memberHash));
        for (const memberHash of current) {
          if (!activeSet.has(memberHash) && (await applyJoin(g.id, memberHash, now, 'SNAPSHOT'))) joins++;
        }
        for (const memberHash of activeSet) {
          if (!current.has(memberHash) && (await applyLeave(g.id, memberHash, now, 'LEAVE', 'SNAPSHOT'))) leaves++;
        }
      }

      await prisma.waGroupSnapshot.create({ data: { destinationGroupId: g.id, memberCount: current.size, createdAt: now } });
      results.push({ group: g.name, members: current.size, joins, leaves, baseline: isBaseline });
    } catch (err) {
      results.push({ group: g.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

// ── Webhook setup (never silently replaces someone else's webhook) ──────────

export async function getWebhookSecret(): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key: SECRET_KEY } });
  if (row?.value) return row.value;
  const secret = randomBytes(24).toString('hex');
  await prisma.setting.upsert({ where: { key: SECRET_KEY }, update: { value: secret }, create: { key: SECRET_KEY, value: secret } });
  return secret;
}

export async function getWebhookUrl(): Promise<string> {
  if (process.env.WEBHOOK_PUBLIC_URL) return process.env.WEBHOOK_PUBLIC_URL;
  const domain = await prisma.setting.findUnique({ where: { key: 'shortener_domain' } });
  const base = (domain?.value || 'https://ofertas.ykaromarques.com').replace(/\/$/, '');
  return `${base}/api/webhooks/evolution`;
}

export type WebhookState = 'ACTIVE' | 'NOT_CONFIGURED' | 'DISABLED' | 'OTHER_URL' | 'MISSING_EVENT' | 'ERROR';

export interface WebhookStatus {
  state: WebhookState;
  ourUrl: string;
  currentUrl?: string;
  currentEvents?: string[];
  lastEventAt?: string | null;
  error?: string;
}

const sameUrl = (a: string, b: string) => a.trim().replace(/\/$/, '').toLowerCase() === b.trim().replace(/\/$/, '').toLowerCase();

export async function getWebhookStatus(): Promise<WebhookStatus> {
  const ourUrl = await getWebhookUrl();
  const last = await prisma.setting.findUnique({ where: { key: LAST_EVENT_KEY } });
  const lastEventAt = last?.value ?? null;
  try {
    const current = await new WhatsAppService().getWebhook();
    if (!current) return { state: 'NOT_CONFIGURED', ourUrl, lastEventAt };
    const base = { ourUrl, currentUrl: current.url, currentEvents: current.events, lastEventAt };
    if (!sameUrl(current.url, ourUrl)) return { state: current.enabled ? 'OTHER_URL' : 'DISABLED', ...base };
    if (!current.enabled) return { state: 'DISABLED', ...base };
    if (current.events.length > 0 && !current.events.includes(WEBHOOK_EVENT)) return { state: 'MISSING_EVENT', ...base };
    return { state: 'ACTIVE', ...base };
  } catch (err) {
    return { state: 'ERROR', ourUrl, lastEventAt, error: err instanceof Error ? err.message : String(err) };
  }
}

export class WebhookConflictError extends Error {}

/**
 * Points the instance's webhook at us. If it currently points somewhere else
 * (n8n, another bot…), refuses unless force=true — Evolution keeps a single
 * webhook per instance, so taking it over would cut that other system off.
 */
export async function setupWebhook(force = false): Promise<WebhookStatus> {
  const status = await getWebhookStatus();
  if (status.state === 'ACTIVE') return status;
  if (status.state === 'ERROR') throw new Error(status.error ?? 'Não consegui ler o webhook atual da Evolution');
  if (status.state === 'OTHER_URL' && !force) {
    throw new WebhookConflictError(
      `A instância já envia webhook para ${status.currentUrl}. Ativar a coleta substitui esse webhook e aquele sistema para de receber eventos.`,
    );
  }
  // Keep whatever events our own webhook already had; otherwise just ours.
  const keep = status.currentUrl && sameUrl(status.currentUrl, status.ourUrl) ? status.currentEvents ?? [] : [];
  const events = Array.from(new Set([...keep, WEBHOOK_EVENT]));
  await new WhatsAppService().setWebhook({
    url: status.ourUrl,
    events,
    headers: { [WEBHOOK_TOKEN_HEADER]: await getWebhookSecret() },
  });
  return getWebhookStatus();
}
