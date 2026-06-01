import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { authRoutes } from './routes/auth';
import { groupsRoutes } from './routes/groups';
import { offersRoutes } from './routes/offers';
import { settingsRoutes } from './routes/settings';
import { logsRoutes } from './routes/logs';
import { statsRoutes } from './routes/stats';
import prisma from './lib/prisma';
import { seed } from './seed';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const JWT_SECRET = process.env.JWT_SECRET ?? 'changeme-jwt-secret';
const INTERNAL_TOKEN = 'sistema-grupos-ofertas-internal-token-fallback-key-2026';
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? '*';

const server = Fastify({
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

  // Health check (no auth required)
  server.get('/health', async (_request, reply) => {
    return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Redirect route for internal shortener (no auth required)
  server.get('/s/:code', async (request, reply) => {
    const { code } = request.params as { code: string };
    try {
      const shortUrl = await prisma.shortUrl.findUnique({
        where: { code },
      });
      if (shortUrl) {
        // Increment clicks asynchronously
        prisma.shortUrl.update({
          where: { code },
          data: { clicks: { increment: 1 } },
        }).catch(err => server.log.error({ err }, `Failed to increment clicks for code ${code}`));

        return reply.redirect(302, shortUrl.originalUrl);
      }
    } catch (err) {
      server.log.error({ err }, `Error looking up short code ${code}`);
    }
    return reply.status(404).send('Link não encontrado');
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
  server.get('/settings/internal', async (_request, reply) => {
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
      aliexpress_tracking_id: dbObj.aliexpress_tracking_id ?? '',
      magalu_store_name:      dbObj.magalu_store_name ?? '',
      link_shortener_enabled: dbObj.link_shortener_enabled ?? 'true',
      shortener_provider:     dbObj.shortener_provider ?? 'internal',
    });
  });

  // Register route plugins
  await server.register(authRoutes, { prefix: '/auth' });
  await server.register(groupsRoutes, { prefix: '/groups' });
  await server.register(offersRoutes, { prefix: '/offers' });
  await server.register(settingsRoutes, { prefix: '/settings' });
  await server.register(logsRoutes, { prefix: '/logs' });
  await server.register(statsRoutes, { prefix: '/stats' });

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
