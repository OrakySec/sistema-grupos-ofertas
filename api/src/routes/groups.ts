import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/auth';
import prisma from '../lib/prisma';

interface CreateSourceGroupBody {
  telegramId: string; // sent as string, parsed to BigInt
  name: string;
  username?: string;
}

interface UpdateSourceGroupBody {
  name?: string;
  username?: string;
  isActive?: boolean;
  nicheId?: string | null;
}

interface CreateDestinationGroupBody {
  name: string;
  type: 'TELEGRAM' | 'WHATSAPP';
  chatId: string;
  inviteLink?: string; // WhatsApp only — optional, enables the link-monitor job for this group
}

interface UpdateDestinationGroupBody {
  name?: string;
  isActive?: boolean;
  inviteLink?: string | null;
}

export const groupsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // All routes require auth, unless it's the internal service requesting with correct key
  fastify.addHook('preHandler', async (request, reply) => {
    const internalKey = request.headers['x-internal-key'];
    if (internalKey === 'sistema-grupos-ofertas-internal-token-fallback-key-2026') {
      return;
    }
    await requireAuth(request, reply);
  });

  // ──────────────────────────────────────────────
  // SOURCE GROUPS
  // ──────────────────────────────────────────────

  // GET /groups/source
  // include: { niche: true } — both the panel (niche assignment dropdown) and
  // the telegram-listener (per-message mockup/footer/ML-link overrides) read
  // the nested niche off this same response, no separate call needed.
  fastify.get('/source', async (_request, reply) => {
    const groups = await prisma.sourceGroup.findMany({
      orderBy: { createdAt: 'desc' },
      include: { niche: true },
    });
    // Serialize BigInt
    const serialized = groups.map((g) => ({
      ...g,
      telegramId: g.telegramId.toString(),
    }));
    return reply.send(serialized);
  });

  // POST /groups/source
  fastify.post<{ Body: CreateSourceGroupBody }>(
    '/source',
    {
      schema: {
        body: {
          type: 'object',
          required: ['telegramId', 'name'],
          properties: {
            telegramId: { type: 'string' },
            name: { type: 'string', minLength: 1 },
            username: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { telegramId, name, username } = request.body;

      let telegramIdBig: bigint;
      try {
        telegramIdBig = BigInt(telegramId);
      } catch {
        return reply.code(400).send({ error: 'Invalid telegramId format' });
      }

      const existing = await prisma.sourceGroup.findUnique({
        where: { telegramId: telegramIdBig },
      });
      if (existing) {
        return reply.code(409).send({ error: 'Source group with this telegramId already exists' });
      }

      const group = await prisma.sourceGroup.create({
        data: { telegramId: telegramIdBig, name, username },
      });

      return reply.code(201).send({ ...group, telegramId: group.telegramId.toString() });
    },
  );

  // PATCH /groups/source/:id
  fastify.patch<{ Params: { id: string }; Body: UpdateSourceGroupBody }>(
    '/source/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            username: { type: 'string' },
            isActive: { type: 'boolean' },
            nicheId: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const data = request.body;

      const existing = await prisma.sourceGroup.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Source group not found' });
      }

      if (typeof data.nicheId === 'string') {
        const niche = await prisma.niche.findUnique({ where: { id: data.nicheId } });
        if (!niche) {
          return reply.code(404).send({ error: 'Nicho não encontrado' });
        }
      }

      const updated = await prisma.sourceGroup.update({
        where: { id },
        data,
        include: { niche: true },
      });
      return reply.send({ ...updated, telegramId: updated.telegramId.toString() });
    },
  );

  // DELETE /groups/source/:id
  fastify.delete<{ Params: { id: string } }>(
    '/source/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const existing = await prisma.sourceGroup.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Source group not found' });
      }

      // Offer.sourceGroupId has no onDelete: Cascade (on purpose — deleting
      // a source group must never silently wipe its offer history/logs).
      // Check first so the user gets an actionable message instead of a raw
      // Postgres foreign key error.
      const offerCount = await prisma.offer.count({ where: { sourceGroupId: id } });
      if (offerCount > 0) {
        return reply.code(409).send({
          error: 'Source group has offer history',
          message: `Este grupo tem ${offerCount} oferta${offerCount === 1 ? '' : 's'} no histórico e não pode ser excluído. Desative-o (toggle de Status) em vez de excluir, pra manter o histórico intacto.`,
        });
      }

      try {
        await prisma.sourceGroup.delete({ where: { id } });
      } catch (err) {
        fastify.log.error({ err }, `Failed to delete source group ${id}`);
        return reply.code(409).send({
          error: 'Cannot delete source group',
          message: 'Não foi possível excluir esse grupo — ele ainda tem registros vinculados. Desative-o em vez de excluir.',
        });
      }
      return reply.code(204).send();
    },
  );

  // GET /groups/source/:id/destinations — list linked destinations
  fastify.get<{ Params: { id: string } }>(
    '/source/:id/destinations',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const existing = await prisma.sourceGroup.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Source group not found' });
      }

      const links = await prisma.sourceGroupDestination.findMany({
        where: { sourceGroupId: id },
        include: { destinationGroup: true },
      });

      return reply.send(links.map((l) => l.destinationGroup));
    },
  );

  // PUT /groups/source/:id/destinations — replace all linked destinations
  fastify.put<{ Params: { id: string }; Body: { destinationIds: string[] } }>(
    '/source/:id/destinations',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['destinationIds'],
          properties: {
            destinationIds: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { destinationIds } = request.body;

      const existing = await prisma.sourceGroup.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Source group not found' });
      }

      // Replace all links atomically
      await prisma.$transaction([
        prisma.sourceGroupDestination.deleteMany({ where: { sourceGroupId: id } }),
        ...destinationIds.map((destinationGroupId) =>
          prisma.sourceGroupDestination.create({
            data: { sourceGroupId: id, destinationGroupId },
          }),
        ),
      ]);

      const updated = await prisma.sourceGroupDestination.findMany({
        where: { sourceGroupId: id },
        include: { destinationGroup: true },
      });

      return reply.send(updated.map((l) => l.destinationGroup));
    },
  );


  // ──────────────────────────────────────────────
  // DESTINATION GROUPS
  // ──────────────────────────────────────────────

  // GET /groups/destination
  fastify.get('/destination', async (_request, reply) => {
    const groups = await prisma.destinationGroup.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return reply.send(groups);
  });

  // POST /groups/destination
  fastify.post<{ Body: CreateDestinationGroupBody }>(
    '/destination',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'type', 'chatId'],
          properties: {
            name: { type: 'string', minLength: 1 },
            type: { type: 'string', enum: ['TELEGRAM', 'WHATSAPP'] },
            chatId: { type: 'string', minLength: 1 },
            inviteLink: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, type, chatId, inviteLink } = request.body;
      const group = await prisma.destinationGroup.create({
        data: { name, type, chatId, inviteLink: inviteLink?.trim() || null },
      });
      return reply.code(201).send(group);
    },
  );

  // PATCH /groups/destination/:id
  fastify.patch<{ Params: { id: string }; Body: UpdateDestinationGroupBody }>(
    '/destination/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            isActive: { type: 'boolean' },
            inviteLink: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { inviteLink, ...rest } = request.body;

      const existing = await prisma.destinationGroup.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Destination group not found' });
      }

      const data: Record<string, unknown> = { ...rest };
      if ('inviteLink' in request.body) {
        const trimmed = inviteLink?.trim() || null;
        data.inviteLink = trimmed;
        // A different link (including clearing it, or setting one for the
        // first time) invalidates whatever the monitor last knew — otherwise
        // a freshly pasted broken link can inherit a stale VALID status, or
        // inherit a recent linkLastNotifiedAt and have its very first alert
        // suppressed by the renotify cooldown (see worker.ts's shouldNotify).
        if (trimmed !== existing.inviteLink) {
          data.linkStatus = 'UNKNOWN';
          data.linkLastCheckedAt = null;
          data.linkLastNotifiedAt = null;
        }
      }

      const updated = await prisma.destinationGroup.update({ where: { id }, data });
      return reply.send(updated);
    },
  );

  // DELETE /groups/destination/:id
  fastify.delete<{ Params: { id: string } }>(
    '/destination/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const existing = await prisma.destinationGroup.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Destination group not found' });
      }

      // Same reasoning as DELETE /source/:id — DeliveryLog.destinationGroupId
      // has no onDelete: Cascade on purpose, so check first instead of
      // letting a raw Postgres FK error reach the user.
      const deliveryLogCount = await prisma.deliveryLog.count({ where: { destinationGroupId: id } });
      if (deliveryLogCount > 0) {
        return reply.code(409).send({
          error: 'Destination group has delivery history',
          message: `Este grupo tem ${deliveryLogCount} entrega${deliveryLogCount === 1 ? '' : 's'} no histórico e não pode ser excluído. Desative-o (toggle de Status) em vez de excluir, pra manter o histórico intacto.`,
        });
      }

      try {
        await prisma.destinationGroup.delete({ where: { id } });
      } catch (err) {
        fastify.log.error({ err }, `Failed to delete destination group ${id}`);
        return reply.code(409).send({
          error: 'Cannot delete destination group',
          message: 'Não foi possível excluir esse grupo — ele ainda tem registros vinculados. Desative-o em vez de excluir.',
        });
      }
      return reply.code(204).send();
    },
  );
};
