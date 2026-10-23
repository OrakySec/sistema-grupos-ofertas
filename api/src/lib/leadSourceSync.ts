/**
 * Lists made from the members of one of the account's groups keep following
 * that group: once a day its members are read again and whoever isn't in the
 * list yet (joined the group since) goes into the queue — same filters as the
 * first import (no admins, none of the account's numbers, no hidden @lid
 * members, nobody who left one of the account's groups before). People already
 * in the list, with any status, are never added twice (unique campaign+phone).
 */
import prisma from './prisma';
import { membersForImport, withoutBlocked } from './leadBlocks';
import { brtDayStart, toBrt } from './time';

const SYNC_FROM_HOUR = 7; // Brasília — the day's sync runs from this hour on

export async function syncSourceGroup(campaignId: string, now = new Date()): Promise<{ ok: boolean; added: number; result: string }> {
  const c = await prisma.leadCampaign.findUnique({ where: { id: campaignId } });
  if (!c?.sourceGroupJid) return { ok: false, added: 0, result: 'A lista não tem grupo de origem' };

  // A failed read isn't marked as the day's sync: the next tick (30 min) tries again.
  const save = async (ok: boolean, added: number, result: string) => {
    await prisma.leadCampaign.update({ where: { id: c.id }, data: { ...(ok ? { sourceSyncedAt: now } : {}), sourceSyncResult: result } });
    return { ok, added, result };
  };

  const m = await membersForImport(c.tenantId, c.sourceGroupJid, c.instanceId, c.sourceGroupName ?? undefined);
  if (!m.ok) return save(false, 0, m.error);
  const targets = await prisma.destinationGroup.findMany({ where: { id: { in: (c.groupIds as string[]) ?? [] } }, select: { chatId: true } });
  if (targets.some((t) => t.chatId === m.chatId)) return save(false, 0, 'O grupo de origem também é um destino desta lista');

  const { keep, blocked } = await withoutBlocked(c.tenantId, m.phones.map((phone) => ({ phone })));
  const added = keep.length
    ? (await prisma.lead.createMany({
        data: keep.map((l) => ({ tenantId: c.tenantId, campaignId: c.id, phone: l.phone, source: 'GROUP' })),
        skipDuplicates: true,
      })).count
    : 0;
  const when = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const extra = [blocked && `${blocked} já saíram de um grupo seu`, m.hidden && `${m.hidden} com número oculto`].filter(Boolean).join(', ');
  return save(true, added, `${when}: ${added ? `${added} pessoa(s) nova(s) na fila` : 'ninguém novo'} — ${m.total} membros no grupo${extra ? ` (${extra})` : ''}`);
}

/** Worker tick: each active list that follows a group, once per Brasília day. */
export async function sourceSyncTick(now = new Date()) {
  if (toBrt(now).getUTCHours() < SYNC_FROM_HOUR) return [];
  const due = await prisma.leadCampaign.findMany({
    where: {
      status: 'ACTIVE', sourceSync: true, sourceGroupJid: { not: null },
      OR: [{ sourceSyncedAt: null }, { sourceSyncedAt: { lt: brtDayStart(0, now) } }],
    },
    select: { id: true, name: true },
  });
  const out: Array<{ list: string; result: string }> = [];
  for (const c of due) {
    const r = await syncSourceGroup(c.id, now).catch((err) => ({ ok: false, added: 0, result: `erro: ${err instanceof Error ? err.message : String(err)}` }));
    out.push({ list: c.name, result: r.result });
  }
  return out;
}
