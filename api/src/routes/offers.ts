import { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requireAuth } from '../middleware/auth';
import prisma from '../lib/prisma';
import { addNewOfferJob, addSendOfferJob } from '../lib/queue';

const JWT_SECRET = process.env.JWT_SECRET ?? 'changeme-jwt-secret';

interface ListOffersQuery {
  page?: number;
  limit?: number;
  status?: string;
}

interface CreateOfferBody {
  sourceGroupId: string;
  telegramMessageId: string;
  text?: string;
  mediaType: 'NONE' | 'PHOTO' | 'VIDEO' | 'DOCUMENT';
  mediaLocalPath?: string;
  mediaCaption?: string;
  senderName?: string;
  originalDate: string;
}

interface BatchApproveBody {
  ids: string[];
}

function serializeOffer(offer: Record<string, unknown>): Record<string, unknown> {
  return {
    ...offer,
    telegramMessageId: offer.telegramMessageId
      ? (offer.telegramMessageId as bigint).toString()
      : offer.telegramMessageId,
  };
}

export const offersRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // ──────────────────────────────────────────────
  // INTERNAL endpoint (no JWT auth, uses X-Internal-Key header)
  // ──────────────────────────────────────────────

  fastify.post<{ Body: CreateOfferBody }>(
    '/internal',
    {
      schema: {
        body: {
          type: 'object',
          required: ['sourceGroupId', 'telegramMessageId', 'mediaType', 'originalDate'],
          properties: {
            sourceGroupId: { type: 'string' },
            telegramMessageId: { type: 'string' },
            text: { type: 'string' },
            mediaType: { type: 'string', enum: ['NONE', 'PHOTO', 'VIDEO', 'DOCUMENT'] },
            mediaLocalPath: { type: 'string' },
            mediaCaption: { type: 'string' },
            senderName: { type: 'string' },
            originalDate: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: CreateOfferBody }>, reply) => {
      const internalKey = request.headers['x-internal-key'];
      if (!internalKey || internalKey !== JWT_SECRET) {
        return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid internal key' });
      }

      const {
        sourceGroupId,
        telegramMessageId,
        text,
        mediaType,
        mediaLocalPath,
        mediaCaption,
        senderName,
        originalDate,
      } = request.body;

      let telegramMessageIdBig: bigint;
      try {
        telegramMessageIdBig = BigInt(telegramMessageId);
      } catch {
        return reply.code(400).send({ error: 'Invalid telegramMessageId format' });
      }

      // Check source group exists
      const sourceGroup = await prisma.sourceGroup.findUnique({ where: { id: sourceGroupId } });
      if (!sourceGroup) {
        return reply.code(404).send({ error: 'Source group not found' });
      }

      // Prevent duplicates
      const existing = await prisma.offer.findUnique({
        where: {
          telegramMessageId_sourceGroupId: {
            telegramMessageId: telegramMessageIdBig,
            sourceGroupId,
          },
        },
      });
      if (existing) {
        return reply.code(409).send({
          error: 'Offer already exists',
          offerId: existing.id,
        });
      }

      // Create offer
      const offer = await prisma.offer.create({
        data: {
          sourceGroupId,
          telegramMessageId: telegramMessageIdBig,
          text,
          mediaType,
          mediaLocalPath,
          mediaCaption,
          senderName,
          originalDate: new Date(originalDate),
        },
      });

      // Check auto_approve setting
      const autoApproveSetting = await prisma.setting.findUnique({
        where: { key: 'auto_approve' },
      });

      if (autoApproveSetting?.value === 'true') {
        await prisma.offer.update({
          where: { id: offer.id },
          data: { status: 'APPROVED', reviewedAt: new Date() },
        });
        await addSendOfferJob(offer.id);
      } else {
        await addNewOfferJob(offer.id);
      }

      return reply.code(201).send({ ...serializeOffer(offer as unknown as Record<string, unknown>) });
    },
  );

  // All subsequent routes require JWT auth
  fastify.addHook('preHandler', async (request, reply) => {
    // Skip internal route which is handled above
    if (request.url === '/offers/internal') return;
    await requireAuth(request, reply);
  });

  // ──────────────────────────────────────────────
  // AUTHENTICATED ROUTES
  // ──────────────────────────────────────────────

  // GET /offers
  fastify.get<{ Querystring: ListOffersQuery }>(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            status: {
              type: 'string',
              enum: ['PENDING', 'APPROVED', 'REJECTED', 'SENT', 'FAILED'],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const page = request.query.page ?? 1;
      const limit = request.query.limit ?? 20;
      const skip = (page - 1) * limit;
      const where = request.query.status
        ? { status: request.query.status as 'PENDING' | 'APPROVED' | 'REJECTED' | 'SENT' | 'FAILED' }
        : {};

      const [offers, total] = await Promise.all([
        prisma.offer.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          include: { sourceGroup: true },
        }),
        prisma.offer.count({ where }),
      ]);

      const serialized = offers.map((o) => ({
        ...o,
        telegramMessageId: o.telegramMessageId.toString(),
        sourceGroup: o.sourceGroup
          ? { ...o.sourceGroup, telegramId: o.sourceGroup.telegramId.toString() }
          : null,
      }));

      return reply.send({
        data: serialized,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      });
    },
  );

  // GET /offers/:id
  fastify.get<{ Params: { id: string } }>(
    '/:id',
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

      const offer = await prisma.offer.findUnique({
        where: { id },
        include: {
          sourceGroup: true,
          deliveryLogs: {
            include: { destinationGroup: true },
            orderBy: { sentAt: 'desc' },
          },
        },
      });

      if (!offer) {
        return reply.code(404).send({ error: 'Offer not found' });
      }

      return reply.send({
        ...offer,
        telegramMessageId: offer.telegramMessageId.toString(),
        sourceGroup: offer.sourceGroup
          ? { ...offer.sourceGroup, telegramId: offer.sourceGroup.telegramId.toString() }
          : null,
      });
    },
  );

  // PATCH /offers/:id/approve
  fastify.patch<{ Params: { id: string } }>(
    '/:id/approve',
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

      const offer = await prisma.offer.findUnique({ where: { id } });
      if (!offer) {
        return reply.code(404).send({ error: 'Offer not found' });
      }

      if (offer.status !== 'PENDING') {
        return reply
          .code(409)
          .send({ error: `Cannot approve offer with status ${offer.status}` });
      }

      const updated = await prisma.offer.update({
        where: { id },
        data: { status: 'APPROVED', reviewedAt: new Date() },
      });

      await addSendOfferJob(id);

      return reply.send({
        ...updated,
        telegramMessageId: updated.telegramMessageId.toString(),
      });
    },
  );

  // PATCH /offers/:id/reject
  fastify.patch<{ Params: { id: string } }>(
    '/:id/reject',
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

      const offer = await prisma.offer.findUnique({ where: { id } });
      if (!offer) {
        return reply.code(404).send({ error: 'Offer not found' });
      }

      if (offer.status !== 'PENDING') {
        return reply
          .code(409)
          .send({ error: `Cannot reject offer with status ${offer.status}` });
      }

      const updated = await prisma.offer.update({
        where: { id },
        data: { status: 'REJECTED', reviewedAt: new Date() },
      });

      return reply.send({
        ...updated,
        telegramMessageId: updated.telegramMessageId.toString(),
      });
    },
  );

  // POST /offers/batch-approve
  fastify.post<{ Body: BatchApproveBody }>(
    '/batch-approve',
    {
      schema: {
        body: {
          type: 'object',
          required: ['ids'],
          properties: {
            ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { ids } = request.body;

      // Find all PENDING offers in the list
      const offers = await prisma.offer.findMany({
        where: { id: { in: ids }, status: 'PENDING' },
      });

      if (offers.length === 0) {
        return reply.code(400).send({ error: 'No pending offers found with provided ids' });
      }

      const now = new Date();
      const approvedIds: string[] = [];

      for (const offer of offers) {
        await prisma.offer.update({
          where: { id: offer.id },
          data: { status: 'APPROVED', reviewedAt: now },
        });
        await addSendOfferJob(offer.id);
        approvedIds.push(offer.id);
      }

      return reply.send({
        approved: approvedIds.length,
        ids: approvedIds,
      });
    },
  );
};
