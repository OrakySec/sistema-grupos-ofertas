import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/auth';
import prisma from '../lib/prisma';
import { ensureHunter, runHunter, createOfferFromCandidate } from '../lib/shopeeHunter';
import { searchProducts } from '../lib/shopeeApi';
import { parseTerms } from '../lib/hunterRules';
import { couponsEnabled, expireCoupons } from '../lib/coupons';

const MODES = ['OFF', 'PREVIEW', 'APPROVAL', 'AUTO', 'AUTO_BEST'];

const serializeCandidate = (c: any) => ({
  ...c,
  product: c.product
    ? { ...c.product, itemId: c.product.itemId.toString(), shopId: c.product.shopId.toString() }
    : undefined,
});

export const hunterRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', requireAuth);

  // GET /hunter — every niche with its search status
  fastify.get('/', async () => {
    const niches = await prisma.niche.findMany({ orderBy: { name: 'asc' }, include: { shopeeHunter: true } });
    const counts = await prisma.hunterCandidate.groupBy({
      by: ['hunterId', 'status'],
      where: { createdAt: { gte: new Date(Date.now() - 86400000) } },
      _count: { _all: true },
    });
    return niches.map((n) => {
      const h = n.shopeeHunter;
      const c = h ? counts.filter((x) => x.hunterId === h.id) : [];
      const by = (s: string) => c.find((x) => x.status === s)?._count._all ?? 0;
      return {
        nicheId: n.id,
        nicheName: n.name,
        mode: h?.mode ?? 'OFF',
        keywords: h ? parseTerms(h.keywords).length : 0,
        lastRunAt: h?.lastRunAt ?? null,
        last24h: { preview: by('PREVIEW'), ready: by('READY'), queued: by('QUEUED'), sent: by('SENT') },
      };
    });
  });

  // GET /hunter/:nicheId — config, destinations, recent candidates
  fastify.get<{ Params: { nicheId: string } }>('/:nicheId', async (request) => {
    const hunter = await ensureHunter(request.params.nicheId);
    const [niche, destinations, candidates] = await Promise.all([
      prisma.niche.findUnique({ where: { id: hunter.nicheId }, select: { id: true, name: true } }),
      prisma.sourceGroupDestination.findMany({ where: { sourceGroupId: hunter.sourceGroupId }, select: { destinationGroupId: true } }),
      prisma.hunterCandidate.findMany({
        where: { hunterId: hunter.id, createdAt: { gte: new Date(Date.now() - 3 * 86400000) } },
        orderBy: [{ createdAt: 'desc' }],
        take: 150,
        include: { product: true },
      }),
    ]);
    return {
      hunter,
      niche,
      destinationIds: destinations.map((d) => d.destinationGroupId),
      candidates: candidates.map(serializeCandidate),
    };
  });

  // PUT /hunter/:nicheId — save config (+ destination groups)
  fastify.put<{ Params: { nicheId: string }; Body: Record<string, any> }>('/:nicheId', async (request, reply) => {
    const hunter = await ensureHunter(request.params.nicheId);
    const b = request.body ?? {};
    const numOrNull = (v: any) => (v === '' || v === null || v === undefined ? null : Number(v));
    const int = (v: any, def: number, min: number, max: number) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
    };
    if (b.mode !== undefined && !MODES.includes(b.mode)) return reply.code(400).send({ message: 'Modo inválido' });

    const updated = await prisma.shopeeHunter.update({
      where: { id: hunter.id },
      data: {
        ...(b.mode !== undefined && { mode: b.mode }),
        ...(b.keywords !== undefined && { keywords: String(b.keywords) }),
        ...(b.forbiddenWords !== undefined && { forbiddenWords: String(b.forbiddenWords) }),
        ...(b.minPrice !== undefined && { minPrice: numOrNull(b.minPrice) }),
        ...(b.maxPrice !== undefined && { maxPrice: numOrNull(b.maxPrice) }),
        ...(b.minRating !== undefined && { minRating: Number(b.minRating) || 0 }),
        ...(b.minSales !== undefined && { minSales: int(b.minSales, 100, 0, 10_000_000) }),
        ...(b.minCommissionPct !== undefined && { minCommissionPct: Number(b.minCommissionPct) || 0 }),
        ...(b.minDiscountPct !== undefined && { minDiscountPct: Number(b.minDiscountPct) || 0 }),
        ...(b.minScore !== undefined && { minScore: int(b.minScore, 60, 0, 100) }),
        ...(b.autoMinScore !== undefined && { autoMinScore: int(b.autoMinScore, 80, 0, 100) }),
        ...(b.officialOnly !== undefined && { officialOnly: !!b.officialOnly }),
        ...(b.intervalHours !== undefined && { intervalHours: int(b.intervalHours, 3, 1, 48) }),
        ...(b.dailyLimit !== undefined && { dailyLimit: int(b.dailyLimit, 12, 0, 200) }),
        ...(b.minIntervalMin !== undefined && { minIntervalMin: int(b.minIntervalMin, 20, 0, 1440) }),
        ...(b.quietStart !== undefined && { quietStart: int(b.quietStart, 23, 0, 23) }),
        ...(b.quietEnd !== undefined && { quietEnd: int(b.quietEnd, 7, 0, 23) }),
        ...(b.useCoupons !== undefined && { useCoupons: !!b.useCoupons }),
      },
    });

    if (Array.isArray(b.destinationIds)) {
      const ids: string[] = b.destinationIds.map(String);
      await prisma.$transaction([
        prisma.sourceGroupDestination.deleteMany({ where: { sourceGroupId: hunter.sourceGroupId } }),
        prisma.sourceGroupDestination.createMany({
          data: ids.map((destinationGroupId) => ({ sourceGroupId: hunter.sourceGroupId, destinationGroupId })),
          skipDuplicates: true,
        }),
      ]);
    }
    // Keep the virtual source group's name in sync with the niche.
    const niche = await prisma.niche.findUnique({ where: { id: hunter.nicheId } });
    if (niche) await prisma.sourceGroup.update({ where: { id: hunter.sourceGroupId }, data: { name: `Busca Shopee · ${niche.name}` } });
    return updated;
  });

  // POST /hunter/:nicheId/run — search now (doesn't send; the worker sends on its next tick)
  fastify.post<{ Params: { nicheId: string } }>('/:nicheId/run', async (request, reply) => {
    const hunter = await ensureHunter(request.params.nicheId);
    if (!parseTerms(hunter.keywords).length) return reply.code(400).send({ message: 'Adicione ao menos uma palavra-chave' });
    return runHunter(hunter.id);
  });

  // POST /hunter/candidates/:id/send — push one found product now (to the approval queue)
  fastify.post<{ Params: { id: string } }>('/candidates/:id/send', async (request) => {
    const offer = await createOfferFromCandidate(request.params.id, false);
    return { offerId: offer.id };
  });

  // POST /hunter/test-search { keyword } — what the API returns, raw-ish (diagnostics)
  fastify.post<{ Body: { keyword?: string } }>('/test-search', async (request, reply) => {
    const keyword = String(request.body?.keyword ?? '').trim();
    if (!keyword) return reply.code(400).send({ message: 'Informe uma palavra-chave' });
    try {
      const { products, raw } = await searchProducts(keyword, { limit: 10 });
      return {
        ok: true,
        count: products.length,
        fields: raw[0] ? Object.keys(raw[0]) : [],
        products: products.map((p) => ({ ...p, itemId: p.itemId.toString(), shopId: p.shopId.toString() })),
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Coupons ───────────────────────────────────────────────────────────────

  // GET /hunter/coupons/list
  fastify.get('/coupons/list', async () => {
    await expireCoupons();
    const [coupons, enabled] = await Promise.all([
      prisma.coupon.findMany({ orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }], take: 200 }),
      couponsEnabled(),
    ]);
    return { enabled, coupons };
  });

  // PUT /hunter/coupons/settings { enabled }
  fastify.put<{ Body: { enabled?: boolean } }>('/coupons/settings', async (request) => {
    const value = request.body?.enabled ? 'true' : 'false';
    await prisma.setting.upsert({ where: { key: 'coupons_enabled' }, update: { value }, create: { key: 'coupons_enabled', value } });
    return { enabled: value === 'true' };
  });
};
