import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/auth';
import prisma from '../lib/prisma';

export const statsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', requireAuth);

  // GET /stats
  fastify.get('/', async (_request, reply) => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

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
