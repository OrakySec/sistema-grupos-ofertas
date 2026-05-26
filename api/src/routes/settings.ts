import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import axios from 'axios';
import { requireAuth } from '../middleware/auth';
import prisma from '../lib/prisma';
import { TelegramService } from '../services/telegram.service';
import { WhatsAppService } from '../services/whatsapp.service';

interface UpsertSettingsBody {
  [key: string]: string;
}

interface TelegramAuthVerifyBody {
  code: string;
}

const TELEGRAM_LISTENER_URL = process.env.TELEGRAM_LISTENER_URL ?? 'http://telegram-listener:8000';

export const settingsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', requireAuth);

  // GET /settings
  fastify.get('/', async (_request, reply) => {
    const settings = await prisma.setting.findMany();
    const obj: Record<string, string> = {};
    for (const s of settings) {
      // Mask sensitive values
      if (s.key === 'telegram_bot_token' || s.key === 'evolution_api_key') {
        obj[s.key] = s.value ? '***' : '';
      } else {
        obj[s.key] = s.value;
      }
    }
    return reply.send(obj);
  });

  // PUT /settings
  fastify.put<{ Body: UpsertSettingsBody }>(
    '/',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      },
    },
    async (request, reply) => {
      const updates = request.body;

      const upsertOps = Object.entries(updates).map(([key, value]) =>
        prisma.setting.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        }),
      );

      await Promise.all(upsertOps);

      return reply.send({ success: true, updatedKeys: Object.keys(updates) });
    },
  );

  // POST /settings/test-telegram
  fastify.post('/test-telegram', async (_request, reply) => {
    try {
      const telegramService = new TelegramService();
      const ok = await telegramService.testConnection();
      if (ok) {
        return reply.send({ success: true, message: 'Telegram Bot API connection successful' });
      } else {
        return reply.code(502).send({ success: false, message: 'Telegram Bot API returned failure' });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ success: false, message });
    }
  });

  // POST /settings/test-whatsapp
  fastify.post('/test-whatsapp', async (_request, reply) => {
    try {
      const whatsappService = new WhatsAppService();
      const ok = await whatsappService.testConnection();
      if (ok) {
        return reply.send({ success: true, message: 'Evolution API connection successful' });
      } else {
        return reply.code(502).send({ success: false, message: 'Evolution API returned failure' });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ success: false, message });
    }
  });

  // POST /settings/telegram-auth-start
  fastify.post('/telegram-auth-start', async (_request, reply) => {
    try {
      const response = await axios.post(`${TELEGRAM_LISTENER_URL}/auth/start`, {}, {
        timeout: 15000,
      });
      return reply.send({ success: true, data: response.data });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err }, 'Failed to start Telegram auth');
      return reply.code(502).send({ success: false, message });
    }
  });

  // POST /settings/telegram-auth-verify
  fastify.post<{ Body: TelegramAuthVerifyBody }>(
    '/telegram-auth-verify',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code'],
          properties: {
            code: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { code } = request.body;
      try {
        const response = await axios.post(
          `${TELEGRAM_LISTENER_URL}/auth/verify`,
          { code },
          { timeout: 15000 },
        );
        return reply.send({ success: true, data: response.data });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err }, 'Failed to verify Telegram auth code');
        return reply.code(502).send({ success: false, message });
      }
    },
  );

  // GET /settings/whatsapp-groups
  fastify.get('/whatsapp-groups', async (_request, reply) => {
    try {
      const whatsappService = new WhatsAppService();
      const groups = await whatsappService.listGroups();
      return reply.send({ groups });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err }, 'Failed to fetch WhatsApp groups');
      return reply.code(502).send({ error: 'Failed to fetch groups', message });
    }
  });
};
