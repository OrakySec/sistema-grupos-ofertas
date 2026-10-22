/**
 * /leads — opt-in leads (from the account's own capture page) added to the
 * WhatsApp groups of a niche through a number's safe queue (lib/leadQueue.ts).
 */
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { randomBytes } from 'crypto';
import { requireAuth } from '../middleware/auth';
import prisma from '../lib/prisma';
import { tenantIdOf } from '../lib/tenant';
import { normalizePhoneBR } from '../lib/evolution';
import { parseLeadLines, queueStatus } from '../lib/leadQueue';
import { shortenerDomain } from '../lib/shortener';
import { findBlock, groupsOfConnectedNumbers, membersForImport, samePhone } from '../lib/leadBlocks';
import { leadResults } from '../lib/leadStats';

const STATUSES = ['QUEUED', 'ADDED', 'INVITED', 'INVITE_PENDING', 'ALREADY_MEMBER', 'NO_WHATSAPP', 'BLOCKED', 'FAILED'] as const;
const MAX_IMPORT = 20000;

/** Drops people who already left one of the account's groups (they're never re-added). */
async function withoutBlocked<T extends { phone: string }>(tenantId: string, leads: T[]): Promise<{ keep: T[]; blocked: number }> {
  if (!leads.length) return { keep: leads, blocked: 0 };
  const blocks = await prisma.leadBlock.findMany({ where: { tenantId }, select: { phone: true } });
  if (!blocks.length) return { keep: leads, blocked: 0 };
  const byTail = new Map<string, string[]>();
  for (const b of blocks) byTail.set(b.phone.slice(-8), [...(byTail.get(b.phone.slice(-8)) ?? []), b.phone]);
  const keep = leads.filter((l) => !(byTail.get(l.phone.slice(-8)) ?? []).some((p) => samePhone(p, l.phone)));
  return { keep, blocked: leads.length - keep.length };
}

async function intakeUrl(token: string) {
  return `${await shortenerDomain()}/api/leads/intake/${token}`;
}

/** WhatsApp destination groups reachable from a niche (through its source groups). */
async function nicheGroups() {
  const niches = await prisma.niche.findMany({
    orderBy: { name: 'asc' },
    include: { sourceGroups: { include: { destinations: { include: { destinationGroup: true } } } } },
  });
  return niches.map((n) => {
    const map = new Map<string, { id: string; name: string }>();
    for (const sg of n.sourceGroups) {
      for (const d of sg.destinations) {
        const g = d.destinationGroup;
        if (g.type === 'WHATSAPP' && g.isActive) map.set(g.id, { id: g.id, name: g.name });
      }
    }
    return { id: n.id, name: n.name, groups: [...map.values()] };
  });
}

export const leadsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', requireAuth);

  // GET /leads/options — numbers, niches with their WhatsApp groups, all WhatsApp groups
  fastify.get('/options', async (request) => {
    const tenantId = tenantIdOf(request);
    const [instances, niches, groups] = await Promise.all([
      prisma.whatsAppInstance.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } }),
      nicheGroups(),
      // TODO(multi-tenant): DestinationGroup has no tenantId yet.
      prisma.destinationGroup.findMany({ where: { type: 'WHATSAPP', isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ]);
    return {
      instances: instances.map((i) => ({ id: i.id, label: i.label, purpose: i.purpose, connected: i.connected, number: i.number })),
      niches,
      groups,
    };
  });

  // GET /leads/results?days|from&to&campaignId&instanceId — entries, leaves, retention
  fastify.get<{ Querystring: { days?: string; from?: string; to?: string; campaignId?: string; instanceId?: string } }>('/results', async (request) => {
    const q = request.query;
    return leadResults(tenantIdOf(request), {
      days: q.days ? Number(q.days) : undefined, from: q.from, to: q.to,
      campaignId: q.campaignId || undefined, instanceId: q.instanceId || undefined,
    });
  });

  // GET /leads/source-groups — every group the connected numbers are in (live)
  fastify.get('/source-groups', async (request) => groupsOfConnectedNumbers(tenantIdOf(request)));

  // GET /leads/overview — campaigns with counts + each number's queue status
  fastify.get('/overview', async (request) => {
    const tenantId = tenantIdOf(request);
    const campaigns = await prisma.leadCampaign.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      include: { instance: { select: { id: true, label: true, connected: true, number: true } } },
    });
    const [counts, leftCounts] = await Promise.all([
      prisma.lead.groupBy({ by: ['campaignId', 'status'], where: { tenantId }, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['campaignId'], where: { tenantId, leftAt: { not: null } }, _count: { _all: true } }),
    ]);
    const groupNames = new Map(
      (await prisma.destinationGroup.findMany({ select: { id: true, name: true } })).map((g) => [g.id, g.name]),
    );
    const nicheNames = new Map((await prisma.niche.findMany({ select: { id: true, name: true } })).map((n) => [n.id, n.name]));
    // Every lead-adding number shows its queue (so its safety can be set before the first list).
    const leadNumbers = await prisma.whatsAppInstance.findMany({ where: { tenantId, purpose: 'LEADS' }, select: { id: true } });
    const instanceIds = [...new Set([...campaigns.map((c) => c.instanceId), ...leadNumbers.map((n) => n.id)])];
    const queues = await Promise.all(instanceIds.map(async (id) => ({ instanceId: id, ...(await queueStatus(id)) })));
    const instances = await prisma.whatsAppInstance.findMany({ where: { id: { in: instanceIds } }, select: { id: true, label: true, connected: true, number: true } });

    return {
      campaigns: await Promise.all(campaigns.map(async (c) => {
        const byStatus: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
        for (const row of counts) if (row.campaignId === c.id) byStatus[row.status] = row._count._all;
        const groupIds = (Array.isArray(c.groupIds) ? c.groupIds : []) as string[];
        return {
          id: c.id, name: c.name, status: c.status, pausedReason: c.pausedReason,
          niche: c.nicheId ? nicheNames.get(c.nicheId) ?? null : null,
          groups: groupIds.map((id) => ({ id, name: groupNames.get(id) ?? '(grupo removido)' })),
          instance: c.instance, inviteFallback: c.inviteFallback,
          counts: byStatus, total: Object.values(byStatus).reduce((a, b) => a + b, 0),
          left: leftCounts.find((r) => r.campaignId === c.id)?._count._all ?? 0,
          intakeUrl: await intakeUrl(c.intakeToken), createdAt: c.createdAt,
        };
      })),
      queues: queues.map((q) => ({ ...q, instance: instances.find((i) => i.id === q.instanceId) ?? null })),
    };
  });

  // POST /leads/campaigns — new campaign + its leads, from a pasted list or
  // from the members of one of the account's WhatsApp groups (sourceGroupId).
  fastify.post<{ Body: { name?: string; nicheId?: string | null; instanceId?: string; groupIds?: string[]; inviteFallback?: boolean; phones?: string; sourceGroupId?: string; sourceGroupName?: string; consent?: boolean } }>(
    '/campaigns',
    async (request, reply) => {
      const tenantId = tenantIdOf(request);
      const b = request.body ?? {};
      if (b.consent !== true) {
        return reply.code(400).send({ message: 'Marque a confirmação antes de criar a lista.' });
      }
      const name = String(b.name ?? '').trim().slice(0, 80);
      if (!name) return reply.code(400).send({ message: 'Dê um nome para a lista (ex.: "Captura Casa outubro").' });
      const instance = await prisma.whatsAppInstance.findFirst({ where: { id: String(b.instanceId ?? ''), tenantId } });
      if (!instance) return reply.code(400).send({ message: 'Escolha o número que vai adicionar as pessoas.' });
      const groupIds = Array.isArray(b.groupIds) ? b.groupIds.map(String) : [];
      const valid = await prisma.destinationGroup.findMany({ where: { id: { in: groupIds }, type: 'WHATSAPP' }, select: { id: true } });
      const ordered = groupIds.filter((id) => valid.some((v) => v.id === id));
      if (!ordered.length) return reply.code(400).send({ message: 'Escolha pelo menos um grupo de WhatsApp de destino.' });

      let source: 'LIST' | 'GROUP' = 'LIST';
      let incoming: Array<{ phone: string; name: string | null }>;
      let report: { duplicates: number; invalid: number; invalidSamples: string[]; fromGroup?: { group: string; total: number; hidden: number; admins: number; own: number } };
      if (b.sourceGroupId) {
        const m = await membersForImport(tenantId, String(b.sourceGroupId), instance.id, b.sourceGroupName);
        if (!m.ok) return reply.code(502).send({ message: m.error });
        const targets = await prisma.destinationGroup.findMany({ where: { id: { in: ordered } }, select: { chatId: true } });
        if (targets.some((t) => t.chatId === m.chatId)) return reply.code(400).send({ message: 'O grupo de origem não pode ser também um dos destinos.' });
        source = 'GROUP';
        incoming = m.phones.map((phone) => ({ phone, name: null }));
        report = { duplicates: 0, invalid: 0, invalidSamples: [], fromGroup: { group: m.groupName, total: m.total, hidden: m.hidden, admins: m.admins, own: m.own } };
      } else {
        const parsed = parseLeadLines(String(b.phones ?? ''), normalizePhoneBR);
        incoming = parsed.leads;
        report = { duplicates: parsed.duplicates, invalid: parsed.invalid.length, invalidSamples: parsed.invalid.slice(0, 10) };
      }
      if (incoming.length > MAX_IMPORT) return reply.code(400).send({ message: `Máximo de ${MAX_IMPORT} números por vez.` });
      const { keep, blocked } = await withoutBlocked(tenantId, incoming);

      const campaign = await prisma.leadCampaign.create({
        data: {
          tenantId, name, nicheId: b.nicheId || null, instanceId: instance.id, groupIds: ordered,
          inviteFallback: b.inviteFallback !== false, intakeToken: randomBytes(18).toString('hex'),
        },
      });
      const created = keep.length
        ? (await prisma.lead.createMany({ data: keep.map((l) => ({ tenantId, campaignId: campaign.id, phone: l.phone, name: l.name, source })), skipDuplicates: true })).count
        : 0;
      return reply.code(201).send({ id: campaign.id, created, blocked, ...report });
    },
  );

  const ownCampaign = (request: any, id: string) => prisma.leadCampaign.findFirst({ where: { id, tenantId: tenantIdOf(request) } });

  // POST /leads/campaigns/:id/leads { phones, consent } — more leads into an existing campaign
  fastify.post<{ Params: { id: string }; Body: { phones?: string; consent?: boolean } }>('/campaigns/:id/leads', async (request, reply) => {
    const c = await ownCampaign(request, request.params.id);
    if (!c) return reply.code(404).send({ message: 'Campanha não encontrada' });
    if (request.body?.consent !== true) return reply.code(400).send({ message: 'Confirme que esses contatos se cadastraram e aceitaram entrar no grupo.' });
    const parsed = parseLeadLines(String(request.body?.phones ?? ''), normalizePhoneBR);
    if (parsed.leads.length > MAX_IMPORT) return reply.code(400).send({ message: `Máximo de ${MAX_IMPORT} números por vez.` });
    const { keep, blocked } = await withoutBlocked(c.tenantId, parsed.leads);
    const before = await prisma.lead.count({ where: { campaignId: c.id } });
    await prisma.lead.createMany({ data: keep.map((l) => ({ tenantId: c.tenantId, campaignId: c.id, phone: l.phone, name: l.name })), skipDuplicates: true });
    const created = (await prisma.lead.count({ where: { campaignId: c.id } })) - before;
    if (created && c.status === 'DONE') await prisma.leadCampaign.update({ where: { id: c.id }, data: { status: 'ACTIVE' } });
    return { created, blocked, alreadyInCampaign: keep.length - created, duplicates: parsed.duplicates, invalid: parsed.invalid.length, invalidSamples: parsed.invalid.slice(0, 10) };
  });

  // PATCH /leads/campaigns/:id { status?, name?, groupIds?, inviteFallback? }
  fastify.patch<{ Params: { id: string }; Body: { status?: string; name?: string; groupIds?: string[]; inviteFallback?: boolean } }>(
    '/campaigns/:id',
    async (request, reply) => {
      const c = await ownCampaign(request, request.params.id);
      if (!c) return reply.code(404).send({ message: 'Campanha não encontrada' });
      const b = request.body ?? {};
      const data: Record<string, unknown> = {};
      if (b.status === 'ACTIVE' || b.status === 'PAUSED') {
        data.status = b.status;
        data.pausedReason = b.status === 'PAUSED' ? 'Pausada por você' : null;
      }
      if (typeof b.name === 'string' && b.name.trim()) data.name = b.name.trim().slice(0, 80);
      if (typeof b.inviteFallback === 'boolean') data.inviteFallback = b.inviteFallback;
      if (Array.isArray(b.groupIds)) {
        const ids = b.groupIds.map(String);
        const valid = await prisma.destinationGroup.findMany({ where: { id: { in: ids }, type: 'WHATSAPP' }, select: { id: true } });
        const ordered = ids.filter((id) => valid.some((v) => v.id === id));
        if (!ordered.length) return reply.code(400).send({ message: 'Escolha pelo menos um grupo de WhatsApp.' });
        data.groupIds = ordered;
      }
      return prisma.leadCampaign.update({ where: { id: c.id }, data });
    },
  );

  // DELETE /leads/campaigns/:id — the campaign and its leads
  fastify.delete<{ Params: { id: string } }>('/campaigns/:id', async (request, reply) => {
    const c = await ownCampaign(request, request.params.id);
    if (!c) return reply.code(404).send({ message: 'Campanha não encontrada' });
    await prisma.leadCampaign.delete({ where: { id: c.id } });
    return { ok: true };
  });

  // POST /leads/campaigns/:id/retry — failed (and optionally no-WhatsApp) leads back to the queue
  fastify.post<{ Params: { id: string }; Body: { includeNoWhatsApp?: boolean } }>('/campaigns/:id/retry', async (request, reply) => {
    const c = await ownCampaign(request, request.params.id);
    if (!c) return reply.code(404).send({ message: 'Campanha não encontrada' });
    const statuses = ['FAILED', ...(request.body?.includeNoWhatsApp ? ['NO_WHATSAPP'] : [])];
    const r = await prisma.lead.updateMany({ where: { campaignId: c.id, status: { in: statuses } }, data: { status: 'QUEUED', detail: null } });
    return { requeued: r.count };
  });

  // GET /leads/campaigns/:id/leads?status&q&page
  fastify.get<{ Params: { id: string }; Querystring: { status?: string; q?: string; page?: string } }>('/campaigns/:id/leads', async (request, reply) => {
    const c = await ownCampaign(request, request.params.id);
    if (!c) return reply.code(404).send({ message: 'Campanha não encontrada' });
    const page = Math.max(1, Number(request.query.page) || 1);
    const take = 100;
    const q = String(request.query.q ?? '').replace(/\D/g, '');
    const where = {
      campaignId: c.id,
      ...(STATUSES.includes(request.query.status as any) ? { status: request.query.status } : {}),
      ...(request.query.status === 'LEFT' ? { leftAt: { not: null } } : {}),
      ...(q ? { phone: { contains: q } } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.lead.findMany({ where, orderBy: [{ processedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'asc' }], skip: (page - 1) * take, take }),
      prisma.lead.count({ where }),
    ]);
    const groupNames = new Map((await prisma.destinationGroup.findMany({ select: { id: true, name: true } })).map((g) => [g.id, g.name]));
    return {
      total, page, pages: Math.max(1, Math.ceil(total / take)),
      rows: rows.map((l) => ({ id: l.id, phone: l.phone, name: l.name, status: l.status, source: l.source, detail: l.detail, group: l.groupId ? groupNames.get(l.groupId) ?? null : null, processedAt: l.processedAt, leftAt: l.leftAt, createdAt: l.createdAt })),
    };
  });
};

/**
 * Public intake — the capture page (or any form tool) posts each new lead here:
 * POST /api/leads/intake/<token>  JSON { "telefone": "...", "nome": "..." }
 */
export const leadsIntakeRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.post<{ Params: { token: string } }>('/:token', async (request, reply) => {
    const c = await prisma.leadCampaign.findUnique({ where: { intakeToken: request.params.token } });
    if (!c) return reply.code(404).send({ ok: false, message: 'Link de entrada inválido' });
    const b = (request.body ?? {}) as Record<string, unknown>;
    const rawPhone = b.telefone ?? b.phone ?? b.whatsapp ?? b.celular ?? b.number ?? '';
    const phone = normalizePhoneBR(String(rawPhone));
    if (!phone) return reply.code(400).send({ ok: false, message: 'Telefone inválido' });
    const rawName = b.nome ?? b.name ?? null;
    const name = rawName ? String(rawName).trim().slice(0, 80) || null : null;
    // Someone who left one of the groups before is never re-added (answer ok anyway).
    if (await findBlock(c.tenantId, phone)) return { ok: true };
    await prisma.lead.upsert({
      where: { campaignId_phone: { campaignId: c.id, phone } },
      update: name ? { name } : {},
      create: { tenantId: c.tenantId, campaignId: c.id, phone, name, source: 'INTAKE' },
    });
    if (c.status === 'DONE') await prisma.leadCampaign.update({ where: { id: c.id }, data: { status: 'ACTIVE' } });
    return { ok: true };
  });
};
