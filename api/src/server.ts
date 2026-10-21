import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { authRoutes } from './routes/auth';
import { groupsRoutes } from './routes/groups';
import { nichesRoutes } from './routes/niches';
import { offersRoutes } from './routes/offers';
import { settingsRoutes } from './routes/settings';
import { logsRoutes } from './routes/logs';
import { statsRoutes } from './routes/stats';
import { trackingRoutes } from './routes/tracking'
import { clicksRoutes } from './routes/clicks';
import { publicRoutes } from './routes/public';
import { healthRoutes, unidentifiedLinksRoutes } from './routes/health';
import { analyticsRoutes } from './routes/analytics';
import { hunterRoutes } from './routes/hunter';
import { adsRoutes } from './routes/ads';
import { whatsappRoutes } from './routes/whatsapp';
import { leadsRoutes, leadsIntakeRoutes } from './routes/leads';
import { isConnectionEvent, recordConnectionUpdate } from './lib/whatsappNumbers';
import { recordLeavesFromWebhook } from './lib/leadBlocks';
import { recordCouponMessage } from './lib/coupons';
import { parseCookies, resolveFbc, resolveFbp, sendViewContent, COOKIE_MAX_AGE_S } from './lib/metaCapi';
import { recordAdClick } from './lib/metaPurchase';
import {
  getWebhookSecret,
  isParticipantsEvent,
  recordParticipantsUpdate,
  WEBHOOK_TOKEN_HEADER,
} from './lib/memberTracking';
import { classifyClick } from './lib/clickClassifier';
import { createHash } from 'crypto';
import prisma from './lib/prisma';
import { seed } from './seed';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const JWT_SECRET = process.env.JWT_SECRET ?? 'changeme-jwt-secret';
const INTERNAL_TOKEN = 'sistema-grupos-ofertas-internal-token-fallback-key-2026';
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? '*';
const MEDIA_BASE_PATH = process.env.MEDIA_BASE_PATH ?? '/app/media';

// ?g=<seq> on a short link → destination group id, cached briefly so a click
// never waits on an extra query more than once a minute.
let groupSeqCache: { at: number; map: Map<number, string> } = { at: 0, map: new Map() };
async function destinationIdForSeq(seq: number): Promise<string | null> {
  if (Date.now() - groupSeqCache.at > 60_000) {
    const rows = await prisma.destinationGroup.findMany({ select: { id: true, seq: true } });
    groupSeqCache = { at: Date.now(), map: new Map(rows.map((r) => [r.seq, r.id])) };
  }
  return groupSeqCache.map.get(seq) ?? null;
}

// Short code → the ad link it belongs to (only ad links fire the Shopee pixel).
let adLinkCache: { at: number; map: Map<string, { code: string; label: string | null; productUrl: string }> } = { at: 0, map: new Map() };
async function adLinkForShortCode(code: string) {
  if (Date.now() - adLinkCache.at > 60_000) {
    const links = await prisma.adLink.findMany({ select: { code: true, label: true, productUrl: true, finalLink: true } });
    const map = new Map<string, { code: string; label: string | null; productUrl: string }>();
    for (const l of links) {
      const m = /\/s\/([A-Za-z0-9]+)/.exec(l.finalLink);
      if (m) map.set(m[1], { code: l.code, label: l.label, productUrl: l.productUrl });
    }
    adLinkCache = { at: Date.now(), map };
  }
  return adLinkCache.map.get(code) ?? null;
}

const server = Fastify({
  // Behind Traefik in production — without this, request.ip resolves to the
  // proxy's internal container IP instead of the real visitor's IP (which
  // silently breaks Meta CAPI client_ip_address matching).
  trustProxy: true,
  logger: {
    level: NODE_ENV === 'production' ? 'info' : 'debug',
    transport:
      NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
});

async function buildApp() {
  // CORS
  await server.register(cors, {
    origin: NODE_ENV === 'production' ? CORS_ORIGIN : true,
    credentials: true,
  });

  // JWT
  await server.register(jwt, {
    secret: JWT_SECRET,
    sign: { expiresIn: '7d' },
  });

  // Multipart (file uploads — e.g. Mercado Livre session upload)
  await server.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  // Serve offer media (photos) read-only, publicly — used by the authenticated
  // panel (OfferCard) and by the public offers pages, neither of which should
  // need a JWT just to load an image.
  await server.register(fastifyStatic, {
    root: path.resolve(MEDIA_BASE_PATH),
    prefix: '/media/',
    decorateReply: false,
  });

  // Health check (no auth required)
  server.get('/health', async (_request, reply) => {
    return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Redirect route for internal shortener (no auth required)
  server.get('/s/:code', async (request, reply) => {
    const { code } = request.params as { code: string };
    const groupSeq = Number((request.query as { g?: string })?.g);
    // Meta appends ?fbclid to every ad click; its ad review crawlers and manual tests don't carry one.
    const fbclidParam = (request.query as { fbclid?: string })?.fbclid;
    const fromAd = typeof fbclidParam === 'string' && fbclidParam.length >= 10;
    try {
      const shortUrl = await prisma.shortUrl.findUnique({
        where: { code },
      });
      if (shortUrl) {
        // Log the access without delaying the redirect. Every request is
        // recorded (with who made it), but only real people count as clicks.
        const userAgent = (request.headers['user-agent'] as string | undefined)?.slice(0, 300);
        const { kind, agent } = classifyClick({ method: request.method, userAgent });
        // Salted hash: lets us spot the same visitor twice without storing the IP.
        const ipHash = createHash('sha256').update(`${request.ip}|${JWT_SECRET}`).digest('hex').slice(0, 16);

        // Ad traffic: first-party _fbc/_fbp cookies (fbc from the ?fbclid Meta
        // appends to the ad URL) for the server-side ViewContent below.
        const adLink = await adLinkForShortCode(code).catch(() => null);
        let pixel: { fbc: string | null; fbp: string } | null = null;
        if (adLink) {
          const cookies = parseCookies(request.headers.cookie);
          const fbclid = (request.query as { fbclid?: string })?.fbclid;
          const fbc = resolveFbc(cookies._fbc, fbclid);
          const { fbp } = resolveFbp(cookies._fbp);
          const cookieAttrs = `Path=/; Max-Age=${COOKIE_MAX_AGE_S}; Secure; SameSite=Lax`;
          const setCookies = [`_fbp=${fbp}; ${cookieAttrs}`];
          if (fbc) setCookies.push(`_fbc=${fbc}; ${cookieAttrs}`);
          reply.header('Set-Cookie', setCookies);
          pixel = { fbc, fbp };
        }

        (async () => {
          const destinationGroupId = Number.isInteger(groupSeq) && groupSeq > 0 ? await destinationIdForSeq(groupSeq) : null;
          let finalKind: string = kind;
          if (kind === 'HUMAN') {
            // Double-tap / refresh / app re-opening the link: same visitor,
            // same link, within a few minutes → one click, not several.
            const repeat = await prisma.shortUrlClick.findFirst({
              where: { code, ipHash, kind: 'HUMAN', createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } },
              select: { id: true },
            });
            if (repeat) finalKind = 'DUPLICATE';
          }
          const click = await prisma.shortUrlClick.create({ data: { code, kind: finalKind, agent, userAgent, ipHash, destinationGroupId, fromAd } });
          if (finalKind === 'HUMAN') {
            await prisma.shortUrl.update({ where: { code }, data: { clicks: { increment: 1 } } });
          }
          // Real ad clicks only: link previews, bots, double taps, Meta's ad review
          // and manual tests (no fbclid) never reach the pixel.
          if (finalKind === 'HUMAN' && fromAd && adLink && pixel) {
            // Kept for the Purchase event once the sale shows up in Shopee's report.
            await recordAdClick({ id: click.id, adCode: adLink.code, shortCode: code, fbc: pixel.fbc, fbp: pixel.fbp, ip: request.ip, userAgent: userAgent ?? null })
              .catch((err) => server.log.error({ err }, 'Failed to store ad click'));
            const domain = (await prisma.setting.findUnique({ where: { key: 'shortener_domain' } }))?.value || 'https://ofertas.ykaromarques.com';
            await sendViewContent({
              eventId: click.id,
              eventTimeS: Math.floor(Date.now() / 1000),
              sourceUrl: `${domain.replace(/\/$/, '')}/s/${code}`,
              ip: request.ip,
              userAgent: userAgent ?? '',
              fbc: pixel.fbc,
              fbp: pixel.fbp,
              productUrl: adLink.productUrl,
              productName: adLink.label,
              adCode: adLink.code,
            });
          }
        })().catch((err) => server.log.error({ err }, `Failed to track click for code ${code}`));

        return reply.redirect(302, shortUrl.originalUrl);
      }
    } catch (err) {
      server.log.error({ err }, `Error looking up short code ${code}`);
    }
    return reply.status(404).send('Link não encontrado');
  });

  // Evolution API webhook — WhatsApp group joins/leaves for analytics.
  // Authenticated by the secret header we set when configuring the webhook
  // (see lib/memberTracking.ts setupWebhook). Always answers 200 quickly so
  // Evolution doesn't retry; processing errors are only logged.
  server.post('/webhooks/evolution', async (request, reply) => {
    const token = request.headers[WEBHOOK_TOKEN_HEADER];
    if (!token || token !== (await getWebhookSecret())) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const body = request.body as { event?: string; instance?: string; data?: unknown } | undefined;
    if (isConnectionEvent(body?.event)) {
      // A WhatsApp number connected by QR code came online / dropped.
      recordConnectionUpdate(body?.instance, body?.data)
        .catch((err) => server.log.error({ err }, 'Failed to record WhatsApp connection update'));
    } else if (isParticipantsEvent(body?.event)) {
      // Whoever leaves one of our groups is never added again by the lead queue.
      recordLeavesFromWebhook(body?.data)
        .catch((err) => server.log.error({ err }, 'Failed to record lead leaves'));
      recordParticipantsUpdate(body?.data)
        .then((r) => server.log.info({ result: r }, 'WhatsApp participants update recorded'))
        .catch((err) => server.log.error({ err }, 'Failed to record WhatsApp participants update'));
    }
    return reply.send({ ok: true });
  });

  // Coupon mentions forwarded by the telegram-listener (requires X-Internal-Key).
  server.post('/coupons/internal', async (request, reply) => {
    const internalKey = request.headers['x-internal-key'];
    if (internalKey !== JWT_SECRET && internalKey !== INTERNAL_TOKEN) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const { text, sourceGroupId, sourceName } = (request.body ?? {}) as { text?: string; sourceGroupId?: string; sourceName?: string };
    if (!text) return reply.status(400).send({ error: 'Missing text' });
    try {
      return reply.send(await recordCouponMessage(text, { id: sourceGroupId, name: sourceName }));
    } catch (err) {
      server.log.error({ err }, 'Failed to record coupon message');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // Internal shorten route (requires X-Internal-Key)
  server.post('/s/internal', async (request, reply) => {
    const internalKey = request.headers['x-internal-key'];
    if (internalKey !== JWT_SECRET && internalKey !== INTERNAL_TOKEN) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { url } = request.body as { url?: string };
    if (!url) {
      return reply.status(400).send({ error: 'Missing url parameter' });
    }

    try {
      // Find if we already shortened this URL to save space
      const existing = await prisma.shortUrl.findFirst({
        where: { originalUrl: url },
      });
      if (existing) {
        const domainSetting = await prisma.setting.findUnique({ where: { key: 'shortener_domain' } });
        const domain = (domainSetting?.value || 'https://ofertas.ykaromarques.com').replace(/\/$/, '');
        return reply.send({ code: existing.code, shortUrl: `${domain}/s/${existing.code}` });
      }

      // Generate a unique code
      const pool = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let code = '';
      let isUnique = false;
      let attempts = 0;

      while (!isUnique && attempts < 10) {
        code = '';
        for (let i = 0; i < 6; i++) {
          code += pool.charAt(Math.floor(Math.random() * pool.length));
        }
        const conflict = await prisma.shortUrl.findUnique({ where: { code } });
        if (!conflict) {
          isUnique = true;
        }
        attempts++;
      }

      if (!isUnique) {
        return reply.status(500).send({ error: 'Failed to generate a unique short code' });
      }

      const created = await prisma.shortUrl.create({
        data: {
          code,
          originalUrl: url,
        },
      });

      const domainSetting = await prisma.setting.findUnique({ where: { key: 'shortener_domain' } });
      const domain = (domainSetting?.value || 'https://ofertas.ykaromarques.com').replace(/\/$/, '');
      return reply.send({ code: created.code, shortUrl: `${domain}/s/${created.code}` });
    } catch (err) {
      server.log.error({ err }, 'Failed to create short link');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // ── GET /settings/internal ────────────────────────────────────────────────
  // Registered at the TOP-LEVEL scope (no requireAuth hook here).
  // The telegram-listener uses this to fetch credentials without a user JWT.
  // Cannot live inside settingsRoutes because Fastify propagates parent hooks
  // (incluindo requireAuth) to ALL child scopes regardless of registration order.
  server.get('/settings/internal', async (request, reply) => {
    const internalKey = request.headers['x-internal-key'];
    if (internalKey !== JWT_SECRET && internalKey !== INTERNAL_TOKEN) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const settings = await prisma.setting.findMany();
    const dbObj: Record<string, string> = {};
    for (const s of settings) dbObj[s.key] = s.value;
    return reply.send({
      telegram_api_id:        dbObj.telegram_api_id ?? '',
      telegram_api_hash:      dbObj.telegram_api_hash ?? '',
      telegram_phone:         dbObj.telegram_phone ?? '',
      telegram_bot_token:     dbObj.telegram_bot_token ?? '',
      // Affiliate link conversion
      amazon_affiliate_tag:   dbObj.amazon_affiliate_tag ?? '',
      shopee_affiliate_id:    dbObj.shopee_affiliate_id ?? '',
      shopee_app_id:          dbObj.shopee_app_id ?? '',
      shopee_app_secret:      dbObj.shopee_app_secret ?? '',
      aliexpress_tracking_id: dbObj.aliexpress_tracking_id ?? '',
      magalu_store_name:      dbObj.magalu_store_name ?? '',
      ml_own_list_url:        dbObj.ml_own_list_url ?? '',
      strip_link_domains:     dbObj.strip_link_domains ?? '',
      strip_words:            dbObj.strip_words ?? '',
      link_shortener_enabled: dbObj.link_shortener_enabled ?? 'true',
      shortener_provider:     dbObj.shortener_provider ?? 'internal',
      shortener_platforms:    dbObj.shortener_platforms ?? '',
    });
  });

  // Register route plugins
  await server.register(authRoutes, { prefix: '/auth' });
  await server.register(groupsRoutes, { prefix: '/groups' });
  await server.register(nichesRoutes, { prefix: '/niches' });
  await server.register(offersRoutes, { prefix: '/offers' });
  await server.register(settingsRoutes, { prefix: '/settings' });
  await server.register(logsRoutes, { prefix: '/logs' });
  await server.register(statsRoutes, { prefix: '/stats' });
  await server.register(clicksRoutes, { prefix: '/stats/clicks' });
  await server.register(trackingRoutes, { prefix: '/tracking' });
  await server.register(publicRoutes, { prefix: '/public' });
  await server.register(healthRoutes, { prefix: '/health' });
  await server.register(unidentifiedLinksRoutes, { prefix: '/health' });
  await server.register(analyticsRoutes, { prefix: '/analytics' });
  await server.register(hunterRoutes, { prefix: '/hunter' });
  await server.register(adsRoutes, { prefix: '/ads' });
  await server.register(whatsappRoutes, { prefix: '/whatsapp' });
  await server.register(leadsRoutes, { prefix: '/leads' });
  // Public (no login): the capture page posts new leads here.
  await server.register(leadsIntakeRoutes, { prefix: '/leads/intake' });

  return server;
}

async function start() {
  try {
    const app = await buildApp();

    try {
      await seed();
    } catch (seedErr) {
      app.log.error({ err: seedErr }, 'Database auto-seed failed');
    }

    await app.listen({ port: PORT, host: '0.0.0.0' });
    app.log.info(`Server is running on port ${PORT}`);

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      app.log.info(`Received ${signal}, shutting down gracefully...`);
      try {
        await app.close();
        app.log.info('Server closed successfully');
        process.exit(0);
      } catch (err) {
        app.log.error({ err }, 'Error during shutdown');
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    server.log.error({ err }, 'Fatal error starting server');
    process.exit(1);
  }
}

start();
