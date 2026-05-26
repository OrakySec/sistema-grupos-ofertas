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
}

interface CreateDestinationGroupBody {
  name: string;
  type: 'TELEGRAM' | 'WHATSAPP';
  chatId: string;
}

interface UpdateDestinationGroupBody {
  name?: string;
  isActive?: boolean;
}

export const groupsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // All routes require auth
  fastify.addHook('preHandler', requireAuth);

  // ──────────────────────────────────────────────
  // SOURCE GROUPS
  // ──────────────────────────────────────────────

  // GET /groups/source
  fastify.get('/source', async (_request, reply) => {
    const groups = await prisma.sourceGroup.findMany({
      orderBy: { createdAt: 'desc' },
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

      const updated = await prisma.sourceGroup.update({ where: { id }, data });
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

      await prisma.sourceGroup.delete({ where: { id } });
      return reply.code(204).send();
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
          },
        },
      },
    },
    async (request, reply) => {
      const { name, type, chatId } = request.body;
      const group = await prisma.destinationGroup.create({
        data: { name, type, chatId },
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
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const data = request.body;

      const existing = await prisma.destinationGroup.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Destination group not found' });
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

      await prisma.destinationGroup.delete({ where: { id } });
      return reply.code(204).send();
    },
  );
};
