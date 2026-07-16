import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import prisma from '../lib/prisma';

interface ProcessingEvent {
  step?: string;
  platform?: string;
  affiliate?: string;
  shortened?: string | null;
  final?: string | null;
  status?: string;
}

/**
 * Pulls the clean, tagged affiliate link (pre-shortening) out of an offer's
 * processingLog, plus the literal string that's actually embedded in
 * text/mediaCaption (may be shortened — see worker.ts's findAmazonLinkInText
 * for the same "final" field usage), so the caller can strip that redundant
 * inline link from the body copy — the public page already has a dedicated
 * "buy" button for it.
 */
function extractAffiliateLink(
  processingLog: unknown,
): { url: string | null; platform: string | null; embeddedLink: string | null } {
  if (!Array.isArray(processingLog)) return { url: null, platform: null, embeddedLink: null };
  const urlEvent = (processingLog as ProcessingEvent[]).find(
    (e) => e.step === 'url' && e.status === 'ok' && e.affiliate,
  );
  return {
    url: urlEvent?.affiliate ?? null,
    platform: urlEvent?.platform ?? null,
    embeddedLink: urlEvent?.final ?? urlEvent?.affiliate ?? null,
  };
}

/**
 * Removes the redundant inline link from displayed body copy — drops the
 * whole line it's on (not just the URL substring), since the line is usually
 * just a "🔗 <link>" label with nothing else worth keeping once the link is
 * gone — and collapses any leftover blank lines.
 */
function stripEmbeddedLink(text: string | null, link: string | null): string | null {
  if (!text || !link) return text;
  const stripped = text
    .split('\n')
    .filter((line) => !line.includes(link))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return stripped || null;
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
  sourceGroup?: { niche: { slug: string | null; name: string } | null } | null;
}) {
  const { url, platform, embeddedLink } = extractAffiliateLink(offer.processingLog);
  return {
    id: offer.id,
    text: stripEmbeddedLink(offer.text, embeddedLink),
    mediaCaption: stripEmbeddedLink(offer.mediaCaption, embeddedLink),
    mediaType: offer.mediaType,
    mediaPath: offer.mediaLocalPath,
    sentAt: offer.sentAt ?? offer.createdAt,
    platform,
    affiliateUrl: url,
    niche: offer.sourceGroup?.niche
      ? { slug: offer.sourceGroup.niche.slug, name: offer.sourceGroup.niche.name }
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
  // GET /public/niches — one entry per Niche that has a public slug configured
  // and at least one SENT offer among its (possibly several) source groups.
  // Used by the frontend to decide whether /ofertas can redirect straight
  // into the single niche's feed, or needs to show a chooser when more than
  // one niche is live.
  fastify.get('/niches', async (_request, reply) => {
    const niches = await prisma.niche.findMany({
      where: { slug: { not: null } },
      select: { slug: true, name: true, id: true },
    });

    const withCounts = await Promise.all(
      niches.map(async (n) => ({
        slug: n.slug,
        name: n.name,
        offerCount: await prisma.offer.count({
          where: { status: 'SENT', sourceGroup: { nicheId: n.id } },
        }),
      })),
    );

    return reply.send(withCounts.filter((n) => n.offerCount > 0));
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
        ...(request.query.slug ? { sourceGroup: { niche: { slug: request.query.slug } } } : {}),
      };

      const [offers, total] = await Promise.all([
        prisma.offer.findMany({
          where,
          include: { sourceGroup: { include: { niche: true } } },
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
        include: { sourceGroup: { include: { niche: true } } },
      });

      if (!offer || offer.status !== 'SENT') {
        return reply.code(404).send({ error: 'Oferta não encontrada' });
      }

      return reply.send(serializePublicOffer(offer));
    },
  );
};
