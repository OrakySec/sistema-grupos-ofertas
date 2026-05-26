import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { authRoutes } from './routes/auth';
import { groupsRoutes } from './routes/groups';
import { offersRoutes } from './routes/offers';
import { settingsRoutes } from './routes/settings';
import { logsRoutes } from './routes/logs';
import { statsRoutes } from './routes/stats';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const JWT_SECRET = process.env.JWT_SECRET ?? 'changeme-jwt-secret';
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
