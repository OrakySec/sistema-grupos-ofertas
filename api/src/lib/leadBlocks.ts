/**
 * "Left once, never re-added": anyone who leaves (or is removed from) one of
 * the account's WhatsApp groups goes into LeadBlock, and the lead queue never
 * adds that person to any group again.
 *
 * Leaves are caught two ways:
 *   - in real time, from the group-participants.update webhook (action "remove")
 *   - every 6 h, by re-reading the groups people were added to and checking
 *     who is no longer there (catches leaves while the webhook was down)
 * Only participants whose phone is visible count: WhatsApp increasingly hides
 * numbers behind @lid ids, and we never guess.
 *
 * Also: reading a group's members to import them as a lead list.
 */
import prisma from './prisma';
import { fetchAllGroups, groupParticipants } from './wa';
import { DEFAULT_TENANT_ID } from './tenant';

const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/** Phone digits of one participant (string JID or object), or null when hidden (@lid). */
export function participantPhone(p: unknown): string | null {
  const candidates: unknown[] = typeof p === 'string' ? [p] : [(p as any)?.phoneNumber, (p as any)?.id, (p as any)?.jid];
  for (const c of candidates) {
    if (!c) continue;
    const s = String(c);
    if (s.endsWith('@lid')) continue;
    const d = digits(s.split('@')[0].split(':')[0]);
    if (d.length >= 10 && d.length <= 15) return d;
  }
  return null;
}

/**
 * Same Brazilian phone? Tolerant to the 9th digit (WhatsApp ids of older
 * numbers come without it): same DDD + same last 8 digits.
 */
export function samePhone(a: string, b: string): boolean {
  const norm = (x: string) => {
    let d = digits(x);
    if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
    return { ddd: d.slice(0, 2), tail: d.slice(-8), len: d.length };
  };
  const x = norm(a);
  const y = norm(b);
  if (x.len < 10 || y.len < 10) return digits(a) === digits(b);
  return x.ddd === y.ddd && x.tail === y.tail;
}

export async function findBlock(tenantId: string, phone: string) {
  const rows = await prisma.leadBlock.findMany({ where: { tenantId, phone: { endsWith: phone.slice(-8) } } });
  return rows.find((r) => samePhone(r.phone, phone)) ?? null;
}

async function block(tenantId: string, phone: string, reason: 'LEFT' | 'REMOVED', groupId: string | null, at: Date) {
  if (await findBlock(tenantId, phone)) return false;
  await prisma.leadBlock.create({ data: { tenantId, phone, reason, groupId, createdAt: at } }).catch(() => null);
  // Mark the lead(s) we added to that group as gone.
  const leads = await prisma.lead.findMany({
    where: { tenantId, phone: { endsWith: phone.slice(-8) }, leftAt: null, status: { in: ['ADDED', 'INVITED', 'ALREADY_MEMBER'] } },
    select: { id: true, phone: true, joinedAt: true, processedAt: true },
  });
  for (const l of leads.filter((x) => samePhone(x.phone, phone))) {
    // An invited person who leaves had joined at some point (the join itself may have been missed).
    await prisma.lead.update({ where: { id: l.id }, data: { leftAt: at, ...(l.joinedAt ? {} : { joinedAt: l.processedAt ?? at }) } });
  }
  return true;
}

/**
 * An invited lead showed up in the group → record when they got in. A lead of
 * an "add from the phone" batch (MANUAL_PENDING) showing up = the owner added them.
 */
async function markJoined(tenantId: string, phone: string, groupId: string, at: Date) {
  const leads = await prisma.lead.findMany({
    where: { tenantId, phone: { endsWith: phone.slice(-8) }, joinedAt: null, status: { in: ['INVITED', 'INVITE_PENDING', 'MANUAL_PENDING'] } },
    select: { id: true, phone: true, groupId: true, status: true },
  });
  const hits = leads.filter((l) => samePhone(l.phone, phone) && (!l.groupId || l.groupId === groupId));
  for (const l of hits) {
    await prisma.lead.update({
      where: { id: l.id },
      data: l.status === 'MANUAL_PENDING'
        ? { joinedAt: at, status: 'ADDED', groupId, detail: 'Adicionado pelo celular (entrou no grupo)' }
        : { joinedAt: at, status: 'INVITED', groupId },
    });
  }
  return hits.length;
}

/**
 * group-participants.update webhook:
 *   remove → block whoever left (never re-added)
 *   add    → an invited lead joined through the link (counts as a converted invite)
 * Phones only — hidden (@lid) participants can't be matched.
 */
export async function recordMembershipFromWebhook(data: any): Promise<{ left: number; joined: number }> {
  const action = String(data?.action ?? '').toLowerCase();
  if (action !== 'remove' && action !== 'add') return { left: 0, joined: 0 };
  const groupJid = String(data?.id ?? data?.groupJid ?? '');
  const dest = await prisma.destinationGroup.findFirst({ where: { type: 'WHATSAPP', chatId: groupJid }, select: { id: true } });
  if (!dest) return { left: 0, joined: 0 };
  const authorPhone = participantPhone(data?.author);
  const tenantId = DEFAULT_TENANT_ID; // TODO(multi-tenant): DestinationGroup.tenantId
  const now = new Date();
  let left = 0;
  let joined = 0;
  for (const p of Array.isArray(data?.participants) ? data.participants : []) {
    const phone = participantPhone(p);
    if (!phone) continue;
    if (action === 'add') {
      joined += await markJoined(tenantId, phone, dest.id, now);
    } else {
      const removed = !!authorPhone && !samePhone(authorPhone, phone);
      if (await block(tenantId, phone, removed ? 'REMOVED' : 'LEFT', dest.id, now)) left++;
    }
  }
  return { left, joined };
}

/** Raw participant list of a group, read through the first instance that can see it. */
export async function readParticipants(groupJid: string, instanceNames: string[]): Promise<{ ok: true; list: any[]; via: string } | { ok: false; error: string }> {
  let lastError = 'nenhum número disponível para ler o grupo';
  for (const name of instanceNames) {
    const r = await groupParticipants(name, groupJid, 60000);
    if (r.ok) {
      const list: any[] = Array.isArray(r.data?.participants) ? r.data.participants : Array.isArray(r.data) ? r.data : [];
      return { ok: true, list, via: name };
    }
    lastError = `HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 150)}`;
  }
  return { ok: false, error: lastError };
}

/**
 * Every 6 h, for each group we sent people to:
 *   - who we added (or who joined by invite) is no longer there → left, blocked
 *   - who we invited is there now → joined by invite
 * Skipped when most of the group's numbers are hidden (@lid) — no guessing.
 */
export async function detectLeadLeaves(): Promise<Array<{ group: string; left?: number; joined?: number; skipped?: string }>> {
  const settle = new Date(Date.now() - 15 * 60_000);
  const rows = await prisma.lead.findMany({
    where: {
      groupId: { not: null },
      leftAt: null,
      processedAt: { lt: settle },
      OR: [
        { joinedAt: { not: null }, status: { in: ['ADDED', 'INVITED'] } },
        // invites still waiting for a join (only recent ones are worth checking)
        { joinedAt: null, status: 'INVITED', processedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      ],
    },
    select: { id: true, tenantId: true, phone: true, groupId: true, instanceId: true, joinedAt: true },
  });
  const byGroup = new Map<string, typeof rows>();
  for (const r of rows) byGroup.set(r.groupId as string, [...(byGroup.get(r.groupId as string) ?? []), r]);

  const out: Array<{ group: string; left?: number; joined?: number; skipped?: string }> = [];
  for (const [groupId, leads] of byGroup) {
    const g = await prisma.destinationGroup.findUnique({ where: { id: groupId } });
    if (!g) continue;
    const instIds = [...new Set(leads.map((l) => l.instanceId).filter(Boolean))] as string[];
    const names = (await prisma.whatsAppInstance.findMany({ where: { id: { in: instIds } }, select: { name: true } })).map((i) => i.name);
    const offers = await prisma.setting.findUnique({ where: { key: 'evolution_instance' } });
    if (offers?.value) names.push(offers.value);
    const read = await readParticipants(g.chatId, names);
    if (!read.ok) { out.push({ group: g.name, skipped: read.error }); continue; }
    const phones = read.list.map(participantPhone).filter(Boolean) as string[];
    if (read.list.length === 0 || phones.length < read.list.length * 0.8) {
      out.push({ group: g.name, skipped: 'números dos membros ocultos (@lid) — não dá para saber quem saiu' });
      continue;
    }
    const now = new Date();
    let left = 0;
    let joined = 0;
    for (const l of leads) {
      const present = phones.some((p) => samePhone(p, l.phone));
      if (l.joinedAt) {
        if (!present && (await block(l.tenantId, l.phone, 'LEFT', groupId, now))) left++;
      } else if (present) {
        joined += await markJoined(l.tenantId, l.phone, groupId, now);
      }
    }
    out.push({ group: g.name, left, joined });
  }
  return out;
}

/**
 * Every WhatsApp group the account's connected numbers are in (live from the
 * Evolution), merged by group — the sources offered for "Membros de um grupo meu".
 */
export async function groupsOfConnectedNumbers(tenantId: string) {
  const instances = await prisma.whatsAppInstance.findMany({ where: { tenantId, connected: true }, orderBy: { createdAt: 'asc' } });
  const registered = await prisma.destinationGroup.findMany({ where: { type: 'WHATSAPP' }, select: { id: true, chatId: true } });
  const regByJid = new Map(registered.map((r) => [r.chatId, r.id]));
  const map = new Map<string, { jid: string; name: string; size: number | null; announce: boolean; via: string[]; registeredId: string | null }>();
  const errors: string[] = [];
  await Promise.all(instances.map(async (inst) => {
    const r = await fetchAllGroups(inst.name, 90000);
    if (!r.ok) { errors.push(`${inst.label}: HTTP ${r.status}`); return; }
    const list: any[] = Array.isArray(r.data) ? r.data : [];
    for (const g of list) {
      const jid = String(g?.id ?? '');
      if (!jid.endsWith('@g.us') || g?.isCommunity) continue; // a community's parent has no members of its own
      const row = map.get(jid) ?? {
        jid, name: String(g?.subject ?? jid), size: Number.isFinite(Number(g?.size)) ? Number(g.size) : null,
        announce: !!g?.isCommunityAnnounce, via: [], registeredId: regByJid.get(jid) ?? null,
      };
      if (!row.via.includes(inst.label)) row.via.push(inst.label);
      map.set(jid, row);
    }
  }));
  const groups = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return { groups, errors };
}

/**
 * Members of one of the account's groups, as phone numbers, for a new lead list.
 * `source` is a group JID (…@g.us, any group a connected number is in) or the
 * id of a registered DestinationGroup.
 */
export async function membersForImport(tenantId: string, source: string, preferredInstanceId: string, sourceName?: string) {
  let g: { chatId: string; name: string } | null;
  if (source.endsWith('@g.us')) {
    const reg = await prisma.destinationGroup.findFirst({ where: { chatId: source, type: 'WHATSAPP' }, select: { chatId: true, name: true } });
    g = reg ?? { chatId: source, name: (sourceName || source).slice(0, 100) };
  } else {
    g = await prisma.destinationGroup.findFirst({ where: { id: source, type: 'WHATSAPP' }, select: { chatId: true, name: true } });
  }
  if (!g) return { ok: false as const, error: 'Grupo não encontrado' };
  const instances = await prisma.whatsAppInstance.findMany({ where: { tenantId } });
  const ordered = [
    ...instances.filter((i) => i.id === preferredInstanceId),
    ...instances.filter((i) => i.purpose === 'OFFERS' && i.id !== preferredInstanceId),
    ...instances.filter((i) => i.purpose !== 'OFFERS' && i.id !== preferredInstanceId),
  ];
  const read = await readParticipants(g.chatId, ordered.map((i) => i.name));
  if (!read.ok) return { ok: false as const, error: `Não consegui ler os membros do grupo "${g.name}": ${read.error}` };

  const ownNumbers = instances.map((i) => i.number).filter(Boolean) as string[];
  const phones: string[] = [];
  let hidden = 0;
  let admins = 0;
  let own = 0;
  for (const p of read.list) {
    if (p?.admin) { admins++; continue; }
    const phone = participantPhone(p);
    if (!phone) { hidden++; continue; }
    if (ownNumbers.some((n) => samePhone(n, phone))) { own++; continue; }
    phones.push(phone);
  }
  return { ok: true as const, groupName: g.name, chatId: g.chatId, total: read.list.length, phones, hidden, admins, own };
}
