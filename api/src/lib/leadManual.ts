/**
 * "Adicionar pelo celular" lists (LeadCampaign.mode = MANUAL).
 *
 * WhatsApp logs out linked devices (Evolution, WAHA) that add people to
 * groups, but the same add made in the phone's own app goes through. So for
 * these lists the system prepares and checks, and the owner adds by hand:
 *   1. batch — the next N queued leads, filtered (left one of the groups
 *      before / already in the group / already handled by another list), each
 *      assigned to the list's first group with room → MANUAL_PENDING
 *   2. a vCard of the batch to import into the phone (the app only adds saved
 *      contacts), all named "<prefix> — <name>" so they're found together
 *   3. who got in is picked up from the group's members: the main number's
 *      participants webhook in real time (leadBlocks.markJoined) and
 *      checkManualJoins (button + every 15 min) → ADDED
 * The numbers never act here — they only read the member lists.
 */
import prisma from './prisma';
import { findBlock, participantPhone, readParticipants, samePhone } from './leadBlocks';
import { safetyOf } from './leadQueue';
import { toBrt } from './time';

const PENDING = 'MANUAL_PENDING';

/** Names of the numbers that can read a list's groups: its own, then the main one, then any connected. */
async function readerNames(tenantId: string, campaignId: string): Promise<string[]> {
  const own = await prisma.leadCampaignNumber.findMany({ where: { campaignId }, include: { instance: { select: { name: true, connected: true } } } });
  const main = await prisma.setting.findUnique({ where: { key: 'evolution_instance' } });
  const others = await prisma.whatsAppInstance.findMany({ where: { tenantId, connected: true }, select: { name: true } });
  const names = [
    ...own.filter((n) => n.instance.connected).map((n) => n.instance.name),
    ...(main?.value ? [main.value] : []),
    ...others.map((o) => o.name),
  ];
  return [...new Set(names)];
}

/** Phones currently in a group (null when the list can't be read or most numbers are hidden). */
async function groupPhones(chatId: string, names: string[]): Promise<{ phones: string[]; size: number } | { error: string }> {
  const read = await readParticipants(chatId, names);
  if (!read.ok) return { error: read.error };
  const phones = read.list.map(participantPhone).filter(Boolean) as string[];
  if (read.list.length > 0 && phones.length < read.list.length * 0.5) {
    return { error: 'os números dos membros estão ocultos (@lid) — não dá para conferir quem já está no grupo' };
  }
  return { phones, size: read.list.length };
}

const dayLabel = (d: Date) => {
  const b = toBrt(d);
  return `${String(b.getUTCDate()).padStart(2, '0')}/${String(b.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** Contact name prefix of a batch: "Lead <list> 22/10" — search it in the app to find the whole batch. */
export function batchPrefix(campaignName: string, at: Date) {
  const short = campaignName.replace(/[—–-].*$/, '').trim().slice(0, 18) || 'Lista';
  return `Lead ${short} ${dayLabel(at)}`;
}

/**
 * Next batch of a list. Without helperId it's the owner's own batch (one open at
 * a time); with helperId it's that phone's daily batch (lib/leadHelpers.ts).
 */
export async function makeManualBatch(tenantId: string, campaignId: string, size: number, opts: { helperId?: string; now?: Date } = {}) {
  const campaign = await prisma.leadCampaign.findFirst({ where: { id: campaignId, tenantId }, include: { numbers: { include: { instance: true } } } });
  if (!campaign) return { ok: false as const, error: 'Lista não encontrada' };
  const want = Math.max(1, Math.min(200, Math.round(size) || 10));
  const pending = opts.helperId ? 0 : await prisma.lead.count({ where: { campaignId, status: PENDING, helperId: null } });
  if (pending) return { ok: false as const, error: `Ainda há ${pending} pessoa(s) no lote atual. Confira quem entrou ou devolva os pendentes para a fila antes de gerar outro.` };

  const groupIds: string[] = Array.isArray(campaign.groupIds) ? (campaign.groupIds as string[]) : [];
  const dbGroups = await prisma.destinationGroup.findMany({ where: { id: { in: groupIds }, type: 'WHATSAPP', isActive: true } });
  const groups = groupIds.map((id) => dbGroups.find((g) => g.id === id)).filter(Boolean) as typeof dbGroups;
  if (!groups.length) return { ok: false as const, error: 'A lista não tem nenhum grupo de WhatsApp ativo.' };

  const cap = safetyOf(campaign.numbers[0]?.instance.leadSafety).groupCap;
  const names = await readerNames(tenantId, campaignId);
  const state: Array<{ g: (typeof groups)[number]; phones: string[]; room: number }> = [];
  for (const g of groups) {
    const r = await groupPhones(g.chatId, names);
    if ('error' in r) return { ok: false as const, error: `Não consegui ler o grupo "${g.name}": ${r.error}` };
    state.push({ g, phones: r.phones, room: Math.max(0, cap - r.size) });
  }

  const now = opts.now ?? new Date();
  const prefix = batchPrefix(campaign.name, now);
  const skipped = { blocked: 0, member: 0, duplicate: 0 };
  const batch: Array<{ id: string; phone: string; name: string | null; group: string }> = [];
  const candidates = await prisma.lead.findMany({ where: { campaignId, status: 'QUEUED' }, orderBy: { createdAt: 'asc' }, take: want * 5 });
  for (const lead of candidates) {
    if (batch.length >= want) break;
    const set = (status: string, detail: string, groupId: string | null) =>
      prisma.lead.update({ where: { id: lead.id }, data: { status, detail, groupId, processedAt: now, attempts: { increment: 1 } } });

    if (await findBlock(tenantId, lead.phone)) {
      await set('BLOCKED', 'Já saiu de um dos seus grupos antes — não é adicionado de novo', null);
      skipped.blocked++;
      continue;
    }
    const inGroup = state.find((s) => s.phones.some((p) => samePhone(p, lead.phone)));
    if (inGroup) {
      await set('ALREADY_MEMBER', `Já estava no grupo ${inGroup.g.name}`, inGroup.g.id);
      skipped.member++;
      continue;
    }
    const others = await prisma.lead.findMany({
      where: { tenantId, id: { not: lead.id }, phone: { endsWith: lead.phone.slice(-8) }, status: { in: ['ADDED', 'INVITED', 'INVITE_PENDING', PENDING] }, groupId: { in: groupIds } },
      select: { phone: true, campaign: { select: { name: true } } },
    });
    const dup = others.find((o) => samePhone(o.phone, lead.phone));
    if (dup) {
      await set('DUPLICATE', `Já foi adicionado ou convidado para esse grupo pela lista "${dup.campaign.name}"`, null);
      skipped.duplicate++;
      continue;
    }
    const target = state.find((s) => s.room > 0);
    if (!target) break; // every group is full
    target.room--;
    await prisma.lead.update({
      where: { id: lead.id },
      data: { status: PENDING, detail: `Lote ${dayLabel(now)} — adicionar pelo celular no grupo ${target.g.name}`, groupId: target.g.id, helperId: opts.helperId ?? null, processedAt: now, attempts: { increment: 1 } },
    });
    batch.push({ id: lead.id, phone: lead.phone, name: lead.name, group: target.g.name });
  }
  const full = !state.some((s) => s.room > 0);
  return { ok: true as const, prefix, batch, skipped, groupsFull: full && batch.length < want, exhausted: candidates.length < want * 5 && batch.length < want };
}

/** The current batch (still to add + added since it was made). */
export async function manualBatch(tenantId: string, campaignId: string) {
  const campaign = await prisma.leadCampaign.findFirst({ where: { id: campaignId, tenantId } });
  if (!campaign) return null;
  const pending = await prisma.lead.findMany({ where: { campaignId, status: PENDING }, orderBy: { createdAt: 'asc' } });
  const since = pending.reduce<Date | null>((min, l) => (l.processedAt && (!min || l.processedAt < min) ? l.processedAt : min), null)
    ?? new Date(Date.now() - 86_400_000);
  const added = await prisma.lead.findMany({
    where: { campaignId, status: 'ADDED', joinedAt: { gte: since }, detail: { startsWith: 'Adicionado pelo celular' } },
    orderBy: { joinedAt: 'desc' },
  });
  const groupIds = [...new Set([...pending, ...added].map((l) => l.groupId).filter(Boolean))] as string[];
  const groups = await prisma.destinationGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } });
  const gName = new Map(groups.map((g) => [g.id, g.name]));
  const helperIds = [...new Set([...pending, ...added].map((l) => l.helperId).filter(Boolean))] as string[];
  const helpers = await prisma.leadHelper.findMany({ where: { id: { in: helperIds } }, select: { id: true, label: true } });
  const hName = new Map(helpers.map((h) => [h.id, h.label]));
  const row = (l: (typeof pending)[number], status: 'PENDING' | 'ADDED') => ({
    id: l.id, phone: l.phone, name: l.name, group: l.groupId ? gName.get(l.groupId) ?? null : null, status, at: (status === 'ADDED' ? l.joinedAt : l.processedAt) ?? null,
    helper: l.helperId ? hName.get(l.helperId) ?? null : null,
  });
  const madeAt = pending[0]?.processedAt ?? added[added.length - 1]?.processedAt ?? null;
  return {
    prefix: madeAt ? batchPrefix(campaign.name, madeAt) : null,
    pending: pending.map((l) => row(l, 'PENDING')),
    added: added.map((l) => row(l, 'ADDED')),
    queued: await prisma.lead.count({ where: { campaignId, status: 'QUEUED' } }),
  };
}

/** vCard 3.0 text: each person as "<prefix> — <name>" (search the prefix in the app to find the batch). */
export function vcardOf(people: Array<{ phone: string; name: string | null; group: string | null; prefix: string }>) {
  const esc = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`);
  const cards = people.map((l) => {
    const who = l.name?.trim() || `final ${l.phone.slice(-4)}`;
    const full = `${l.prefix} — ${who}`;
    return ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(full)}`, `N:${esc(full)};;;;`, `TEL;TYPE=CELL:+${l.phone}`, `NOTE:${esc(`Grupo: ${l.group ?? ''}`)}`, 'END:VCARD'].join('\r\n');
  });
  return `${cards.join('\r\n')}\r\n`;
}

export const vcfFileName = (prefix: string) => `${prefix.replace(/[^\w\d]+/g, '-').replace(/-+$/, '')}.vcf`;

/** vCard of the owner's own pending batch (not the helpers') — import it on the phone, then add them. */
export async function manualVcard(tenantId: string, campaignId: string) {
  const b = await manualBatch(tenantId, campaignId);
  if (!b || !b.prefix) return null;
  const mine = b.pending.filter((l) => !l.helper);
  if (!mine.length) return null;
  const prefix = b.prefix;
  return { filename: vcfFileName(prefix), vcf: vcardOf(mine.map((l) => ({ ...l, prefix }))), count: mine.length };
}

/**
 * Who of the pending batches is in the group now → ADDED. Reads each group
 * once; groups whose members are hidden can't be checked (left pending).
 */
export async function checkManualJoins(tenantId?: string, campaignId?: string) {
  const pending = await prisma.lead.findMany({
    where: { status: PENDING, groupId: { not: null }, ...(tenantId ? { tenantId } : {}), ...(campaignId ? { campaignId } : {}) },
    select: { id: true, tenantId: true, campaignId: true, phone: true, groupId: true },
  });
  const byGroup = new Map<string, typeof pending>();
  for (const l of pending) byGroup.set(l.groupId as string, [...(byGroup.get(l.groupId as string) ?? []), l]);
  const out: Array<{ group: string; joined?: number; pending?: number; skipped?: string }> = [];
  for (const [groupId, leads] of byGroup) {
    const g = await prisma.destinationGroup.findUnique({ where: { id: groupId } });
    if (!g) continue;
    const r = await groupPhones(g.chatId, await readerNames(leads[0].tenantId, leads[0].campaignId));
    if ('error' in r) { out.push({ group: g.name, skipped: r.error }); continue; }
    const now = new Date();
    let joined = 0;
    for (const l of leads) {
      if (!r.phones.some((p) => samePhone(p, l.phone))) continue;
      await prisma.lead.update({ where: { id: l.id }, data: { status: 'ADDED', joinedAt: now, detail: `Adicionado pelo celular (conferido no grupo ${g.name})` } });
      joined++;
    }
    out.push({ group: g.name, joined, pending: leads.length - joined });
  }
  return out;
}

/** "Não consegui adicionar" — the pending ones go back to the queue (next batch). */
export async function requeueManual(campaignId: string, opts: { ownerOnly?: boolean } = {}) {
  const r = await prisma.lead.updateMany({ where: { campaignId, status: PENDING, ...(opts.ownerOnly ? { helperId: null } : {}) }, data: { status: 'QUEUED', groupId: null, detail: null, helperId: null } });
  return r.count;
}

/** Group members hidden → the owner confirms by hand. */
export async function markManualAdded(campaignId: string, ids?: string[]) {
  const r = await prisma.lead.updateMany({
    // Without ids: the owner's own batch (the phones' batches are checked in the group).
    where: { campaignId, status: PENDING, ...(ids?.length ? { id: { in: ids } } : { helperId: null }) },
    data: { status: 'ADDED', joinedAt: new Date(), detail: 'Adicionado pelo celular (marcado por você)' },
  });
  return r.count;
}
