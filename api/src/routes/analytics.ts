import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/auth';
import prisma from '../lib/prisma';
import { periodStats, cohorts, rangeSeries, byHour, type MemberEventRow } from '../lib/memberAnalytics';
import { brtDayStart, brtDateStart } from '../lib/time';
import {
  getWebhookStatus,
  setupWebhook,
  snapshotWhatsAppGroups,
  WebhookConflictError,
} from '../lib/memberTracking';

const DAY_MS = 24 * 60 * 60 * 1000;

export const analyticsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', requireAuth);

  // GET /analytics/whatsapp?days=30 | ?from=YYYY-MM-DD&to=YYYY-MM-DD  (+ &groupId=<destinationGroupId>)
  // Days are Brasília calendar days; "to" is inclusive. A single day is
  // broken down by hour.
  fastify.get<{ Querystring: { days?: string; from?: string; to?: string; groupId?: string } }>('/whatsapp', async (request, reply) => {
    const now = new Date();
    let since: Date;
    let until: Date;
    if (request.query.from) {
      const from = brtDateStart(request.query.from);
      const to = brtDateStart(request.query.to || request.query.from);
      if (!from || !to || to < from) return reply.code(400).send({ message: 'Período inválido' });
      if (to.getTime() - from.getTime() > 366 * DAY_MS) return reply.code(400).send({ message: 'Período máximo: 1 ano' });
      since = from;
      until = new Date(Math.min(to.getTime() + DAY_MS, now.getTime()));
      if (until <= since) return reply.code(400).send({ message: 'Período no futuro' });
    } else {
      const n = Math.min(Math.max(Number(request.query.days) || 30, 1), 366);
      since = brtDayStart(n - 1, now);
      until = now;
    }
    const days = Math.max(1, Math.ceil((until.getTime() - since.getTime()) / DAY_MS));
    const bucket: 'day' | 'hour' = until.getTime() - since.getTime() <= DAY_MS ? 'hour' : 'day';

    const allGroups = await prisma.destinationGroup.findMany({
      where: { type: 'WHATSAPP' },
      select: { id: true, name: true, isActive: true },
      orderBy: { name: 'asc' },
    });
    const scope = request.query.groupId ? allGroups.filter((g) => g.id === request.query.groupId) : allGroups;
    const ids = scope.map((g) => g.id);

    const [events, latestSnapshots, firstSnapshots, firstEvents, deliveries, clicks, activeCounts] = await Promise.all([
      prisma.waMemberEvent.findMany({
        where: { destinationGroupId: { in: ids }, createdAt: { gte: since } },
        select: { destinationGroupId: true, memberHash: true, type: true, memberJoinedAt: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.waGroupSnapshot.findMany({
        where: { destinationGroupId: { in: ids } },
        distinct: ['destinationGroupId'],
        orderBy: { createdAt: 'desc' },
      }),
      prisma.waGroupSnapshot.groupBy({ by: ['destinationGroupId'], where: { destinationGroupId: { in: ids } }, _min: { createdAt: true } }),
      prisma.waMemberEvent.groupBy({ by: ['destinationGroupId'], where: { destinationGroupId: { in: ids } }, _min: { createdAt: true } }),
      prisma.deliveryLog.findMany({
        where: { destinationGroupId: { in: ids }, status: 'SUCCESS', sentAt: { gte: since, lt: until } },
        select: { destinationGroupId: true, sentAt: true },
      }),
      prisma.shortUrlClick.findMany({
        where: { destinationGroupId: { in: ids }, kind: 'HUMAN', createdAt: { gte: since, lt: until } },
        select: { destinationGroupId: true, createdAt: true },
      }),
      prisma.waMember.groupBy({ by: ['destinationGroupId'], where: { destinationGroupId: { in: ids }, leftAt: null }, _count: { _all: true } }),
    ]);

    // Events after the latest snapshot, needed to bring its count up to date.
    const latestBy = new Map(latestSnapshots.map((s) => [s.destinationGroupId, s]));
    const afterSnapshot = await prisma.waMemberEvent.findMany({
      where: {
        OR: latestSnapshots.map((s) => ({ destinationGroupId: s.destinationGroupId, createdAt: { gt: s.createdAt } })),
      },
      select: { destinationGroupId: true, type: true },
    });

    const firstSnapBy = new Map(firstSnapshots.map((r) => [r.destinationGroupId, r._min.createdAt]));
    const firstEventBy = new Map(firstEvents.map((r) => [r.destinationGroupId, r._min.createdAt]));
    const activeBy = new Map(activeCounts.map((r) => [r.destinationGroupId, r._count._all]));

    const membersNowOf = (id: string): number | null => {
      const snap = latestBy.get(id);
      if (snap) {
        const delta = afterSnapshot
          .filter((e) => e.destinationGroupId === id)
          .reduce((acc, e) => acc + (e.type === 'JOIN' ? 1 : -1), 0);
        return Math.max(0, snap.memberCount + delta);
      }
      const active = activeBy.get(id) ?? 0;
      return active > 0 || firstEventBy.get(id) ? active : null;
    };
    const trackingSinceOf = (id: string): Date | null => {
      const candidates = [firstSnapBy.get(id), firstEventBy.get(id)].filter(Boolean) as Date[];
      return candidates.length ? new Date(Math.min(...candidates.map((d) => d.getTime()))) : null;
    };

    // Member count at the end of the range = today's count minus whatever
    // changed after the range ended.
    const inRange = (events as MemberEventRow[]).filter((e) => e.createdAt < until);
    const netAfterRange = (id: string) =>
      events
        .filter((e) => e.destinationGroupId === id && e.createdAt >= until)
        .reduce((acc, e) => acc + (e.type === 'JOIN' ? 1 : -1), 0);
    const membersAtEndOf = (id: string): number | null => {
      const nowCount = membersNowOf(id);
      return nowCount === null ? null : Math.max(0, nowCount - netAfterRange(id));
    };

    const groups = scope.map((g) => {
      const ev = inRange.filter((e) => e.destinationGroupId === g.id);
      const membersNow = membersAtEndOf(g.id);
      const stats = periodStats(ev, membersNow);
      const offersSent = deliveries.filter((d) => d.destinationGroupId === g.id).length;
      const groupClicks = clicks.filter((c) => c.destinationGroupId === g.id).length;
      return {
        id: g.id,
        name: g.name,
        isActive: g.isActive,
        trackingSince: trackingSinceOf(g.id),
        membersNow,
        ...stats,
        offersSent,
        clicks: groupClicks,
        clicksPerMember: membersNow ? groupClicks / membersNow : null,
        clicksPerOffer: offersSent ? groupClicks / offersSent : null,
        exitsPer100Offers: offersSent ? ((stats.leaves + stats.kicks) / offersSent) * 100 : null,
      };
    });

    // Totals across the scope
    const known = groups.filter((g) => g.membersNow !== null);
    const membersNowTotal = known.length ? known.reduce((a, g) => a + (g.membersNow ?? 0), 0) : null;
    const trackingStarts = groups.map((g) => g.trackingSince).filter(Boolean) as Date[];
    const trackingSince = trackingStarts.length ? new Date(Math.min(...trackingStarts.map((d) => d.getTime()))) : null;
    const allEvents = inRange;
    const totalStats = periodStats(allEvents, membersNowTotal);
    const totalOffers = deliveries.length;
    const totalClicks = clicks.length;

    return {
      generatedAt: now.toISOString(),
      days,
      from: since.toISOString(),
      to: until.toISOString(),
      bucket,
      endsNow: until.getTime() >= now.getTime() - 60000,
      trackingSince,
      groupOptions: allGroups.map((g) => ({ id: g.id, name: g.name })),
      totals: {
        membersNow: membersNowTotal,
        ...totalStats,
        offersSent: totalOffers,
        clicks: totalClicks,
        clicksPerMember: membersNowTotal ? totalClicks / membersNowTotal : null,
        clicksPerOffer: totalOffers ? totalClicks / totalOffers : null,
        exitsPer100Offers: totalOffers ? ((totalStats.leaves + totalStats.kicks) / totalOffers) * 100 : null,
      },
      series: rangeSeries({
        start: since,
        end: until,
        bucket,
        membersEnd: membersNowTotal,
        trackingSince,
        events: allEvents,
        offers: deliveries.map((d) => d.sentAt),
        clicks: clicks.map((c) => c.createdAt),
      }),
      // Cohorts judge retention up to now, so they get every event, not just the range.
      cohorts: cohorts(events as MemberEventRow[], now, Math.max(days, 7), until),
      joinsByHour: byHour(allEvents.filter((e) => e.type === 'JOIN').map((e) => e.createdAt)),
      exitsByHour: byHour(allEvents.filter((e) => e.type !== 'JOIN').map((e) => e.createdAt)),
      clicksByHour: byHour(clicks.map((c) => c.createdAt)),
      groups,
    };
  });

  // GET /analytics/whatsapp/webhook — is member collection switched on?
  fastify.get('/whatsapp/webhook', async () => getWebhookStatus());

  // POST /analytics/whatsapp/webhook { force?: boolean } — switch it on
  fastify.post<{ Body: { force?: boolean } }>('/whatsapp/webhook', async (request, reply) => {
    try {
      return await setupWebhook(!!request.body?.force);
    } catch (err) {
      if (err instanceof WebhookConflictError) return reply.code(409).send({ message: err.message });
      return reply.code(502).send({ message: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /analytics/whatsapp/snapshot — count members right now
  fastify.post('/whatsapp/snapshot', async () => ({ results: await snapshotWhatsAppGroups() }));
};
