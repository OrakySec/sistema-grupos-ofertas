import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import prisma from '../lib/prisma';

interface ProcessingEvent {
  step?: string;
  platform?: string;
  affiliate?: string;
  status?: string;
}

/** Pulls the clean, tagged affiliate link (pre-shortening) out of an offer's processingLog. */
function extractAffiliateLink(processingLog: unknown): { url: string | null; platform: string | null } {
  if (!Array.isArray(processingLog)) return { url: null, platform: null };
  const urlEvent = (processingLog as ProcessingEvent[]).find(
    (e) => e.step === 'url' && e.status === 'ok' && e.affiliate,
  );
  return {
    url: urlEvent?.affiliate ?? null,
    platform: urlEvent?.platform ?? null,
  };
}

function serializePublicOffer(offer: {
  id: string;
  text: string | null;
  mediaCaption: string | null;
  mediaType: string;
  mediaLocalPath: string | null;
  sentAt: Date | null;
  createdAt: Date;
  processingLog: unknown;
  sourceGroup?: { slug: string | null; name: string } | null;
}) {
  const { url, platform } = extractAffiliateLink(offer.processingLog);
  return {
    id: offer.id,
    text: offer.text,
    mediaCaption: offer.mediaCaption,
    mediaType: offer.mediaType,
    mediaPath: offer.mediaLocalPath,
    sentAt: offer.sentAt ?? offer.createdAt,
    platform,
    affiliateUrl: url,
    niche: offer.sourceGroup
      ? { slug: offer.sourceGroup.slug, name: offer.sourceGroup.name }
      : null,
  };
}

/**
 * Public, unauthenticated read-only endpoints backing the /ofertas pages —
 * required so Amazon (and anyone else) can visit a real, crawlable page
 * showing our tagged affiliate links, instead of only seeing them inside
 * closed Telegram/WhatsApp groups. See Offer.processingLog for how the
 * affiliate link is recovered (it's baked into the message text sent to
 * groups, but not stored as its own column).
 */
export const publicRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // GET /public/niches — one entry per SourceGroup that has a public slug
  // configured and at least one SENT offer. Used by the frontend to decide
  // whether /ofertas can redirect straight into the single niche's feed, or
  // needs to show a chooser when more than one niche is live.
  fastify.get('/niches', async (_request, reply) => {
    const groups = await prisma.sourceGroup.findMany({
      where: { slug: { not: null }, offers: { some: { status: 'SENT' } } },
      select: {
        slug: true,
        name: true,
        _count: { select: { offers: { where: { status: 'SENT' } } } },
      },
    });

    return reply.send(
      groups.map((g) => ({ slug: g.slug, name: g.name, offerCount: g._count.offers })),
    );
  });

  fastify.get<{ Querystring: { page?: number; limit?: number; slug?: string } }>(
    '/offers',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            slug: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const page = request.query.page ?? 1;
      const limit = request.query.limit ?? 20;
      const skip = (page - 1) * limit;
      const where = {
        status: 'SENT' as const,
        ...(request.query.slug ? { sourceGroup: { slug: request.query.slug } } : {}),
      };

      const [offers, total] = await Promise.all([
        prisma.offer.findMany({
          where,
          include: { sourceGroup: { select: { slug: true, name: true } } },
          orderBy: { sentAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.offer.count({ where }),
      ]);

      return reply.send({
        data: offers.map(serializePublicOffer),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/offers/:id',
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
        include: { sourceGroup: { select: { slug: true, name: true } } },
      });

      if (!offer || offer.status !== 'SENT') {
        return reply.code(404).send({ error: 'Oferta não encontrada' });
      }

      return reply.send(serializePublicOffer(offer));
    },
  );
};
