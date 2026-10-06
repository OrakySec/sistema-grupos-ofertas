import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/auth';
import prisma from '../lib/prisma';
import { classifyOfferProblem } from '../lib/failureReason';
import { brtDayStart } from '../lib/time';

export const statsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', requireAuth);

  // GET /stats
  fastify.get('/', async (_request, reply) => {
    // "Today" is the Brasília day (UTC-3) — the container runs in UTC, so
    // plain local-date math cut the day off at 21:00 in Brazil.
    const startOfDay = brtDayStart(0);
    const endOfDay = brtDayStart(-1);

    const [pending, approvedToday, sentToday, failedToday, totalOffers, clicksToday, recentOffers] =
      await Promise.all([
        prisma.offer.count({ where: { status: 'PENDING' } }),

        prisma.offer.count({
          where: {
            status: 'APPROVED',
            reviewedAt: { gte: startOfDay, lt: endOfDay },
          },
        }),

        prisma.offer.count({
          where: {
            status: 'SENT',
            sentAt: { gte: startOfDay, lt: endOfDay },
          },
        }),

        prisma.offer.count({
          where: {
            status: 'FAILED',
            sentAt: { gte: startOfDay, lt: endOfDay },
          },
        }),

        prisma.offer.count(),

        prisma.shortUrlClick.count({
          where: {
            createdAt: { gte: startOfDay, lt: endOfDay },
            // real people only (LEGACY = logged before bots could be told apart)
            kind: { in: ['HUMAN', 'LEGACY'] },
          },
        }),

        prisma.offer.findMany({
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            sourceGroup: {
              select: { id: true, name: true },
            },
          },
        }),
      ]);

    const recentSerialized = recentOffers.map((o: any) => ({
      ...o,
      telegramMessageId: o.telegramMessageId.toString(),
      problemReason: classifyOfferProblem(o),
      sourceGroup: o.sourceGroup
        ? { ...o.sourceGroup }
        : null,
    }));

    return reply.send({
      pending,
      approvedToday,
      sentToday,
      failedToday,
      totalOffers,
      clicksToday,
      recentOffers: recentSerialized,
    });
  });
};
