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

const TELEGRAM_LISTENER_URL = process.env.TELEGRAM_LISTENER_URL ?? 'http://telegram-listener:8080';

export const settingsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', requireAuth);

  // GET /settings
  fastify.get('/', async (_request, reply) => {
    const settings = await prisma.setting.findMany();
    const dbObj: Record<string, string> = {};
    for (const s of settings) {
      dbObj[s.key] = s.value;
    }

    // Map to camelCase for the frontend
    const responseObj: Record<string, any> = {
      autoApprove: dbObj.auto_approve === 'true',
      telegramBotToken: dbObj.telegram_bot_token ? '***' : '',
      telegramApiId: dbObj.telegram_api_id ? Number(dbObj.telegram_api_id) : undefined,
      telegramApiHash: dbObj.telegram_api_hash ?? '',
      telegramPhone: dbObj.telegram_phone ?? '',
      evolutionApiUrl: dbObj.evolution_api_url ?? '',
      evolutionApiKey: dbObj.evolution_api_key ? '***' : '',
      evolutionInstance: dbObj.evolution_instance ?? '',
      telegramAuthenticated: false,
    };

    // Try to fetch telegram authentication status from the listener
    try {
      const statusResponse = await axios.get(`${TELEGRAM_LISTENER_URL}/status`, { timeout: 2000 });
      responseObj.telegramAuthenticated = !!statusResponse.data.authenticated;
    } catch (err: any) {
      fastify.log.warn(`Could not fetch status from telegram-listener: ${err.message}`);
    }

    return reply.send(responseObj);
  });

  // PUT /settings
  fastify.put(
    '/',
    async (request, reply) => {
      const updates = request.body as Record<string, any>;
      const dbUpdates: Record<string, string> = {};

      // Map incoming keys to DB keys
      if ('autoApprove' in updates) {
        dbUpdates.auto_approve = String(updates.autoApprove);
      }
      if ('telegramBotToken' in updates && updates.telegramBotToken !== '***') {
        dbUpdates.telegram_bot_token = updates.telegramBotToken ?? '';
      }
      if ('telegramApiId' in updates) {
        dbUpdates.telegram_api_id = updates.telegramApiId ? String(updates.telegramApiId) : '';
      }
      if ('telegramApiHash' in updates) {
        dbUpdates.telegram_api_hash = updates.telegramApiHash ?? '';
      }
      if ('telegramPhone' in updates) {
        dbUpdates.telegram_phone = updates.telegramPhone ?? '';
      }
      if ('evolutionApiUrl' in updates) {
        dbUpdates.evolution_api_url = updates.evolutionApiUrl ?? '';
      }
      if ('evolutionApiKey' in updates && updates.evolutionApiKey !== '***') {
        dbUpdates.evolution_api_key = updates.evolutionApiKey ?? '';
      }
      if ('evolutionInstance' in updates) {
        dbUpdates.evolution_instance = updates.evolutionInstance ?? '';
      }

      const upsertOps = Object.entries(dbUpdates).map(([key, value]) =>
        prisma.setting.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        }),
      );

      await Promise.all(upsertOps);

      // Fetch the updated settings and return in the camelCase format
      const settings = await prisma.setting.findMany();
      const dbObj: Record<string, string> = {};
      for (const s of settings) {
        dbObj[s.key] = s.value;
      }

      const responseObj: Record<string, any> = {
        autoApprove: dbObj.auto_approve === 'true',
        telegramBotToken: dbObj.telegram_bot_token ? '***' : '',
        telegramApiId: dbObj.telegram_api_id ? Number(dbObj.telegram_api_id) : undefined,
        telegramApiHash: dbObj.telegram_api_hash ?? '',
        telegramPhone: dbObj.telegram_phone ?? '',
        evolutionApiUrl: dbObj.evolution_api_url ?? '',
        evolutionApiKey: dbObj.evolution_api_key ? '***' : '',
        evolutionInstance: dbObj.evolution_instance ?? '',
        telegramAuthenticated: false,
      };

      try {
        const statusResponse = await axios.get(`${TELEGRAM_LISTENER_URL}/status`, { timeout: 2000 });
        responseObj.telegramAuthenticated = !!statusResponse.data.authenticated;
      } catch (err: any) {
        // silent warning
      }

      return reply.send(responseObj);
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

  // POST /settings/telegram-auth/start
  fastify.post<{ Body: { phone: string } }>('/telegram-auth/start', async (request, reply) => {
    const { phone } = request.body;
    try {
      const response = await axios.post(`${TELEGRAM_LISTENER_URL}/auth/start`, { phone }, {
        timeout: 15000,
      });
      return reply.send({ success: true, data: response.data });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err }, 'Failed to start Telegram auth');
      return reply.code(502).send({ success: false, message });
    }
  });

  // POST /settings/telegram-auth/verify
  fastify.post<{ Body: TelegramAuthVerifyBody }>(
    '/telegram-auth/verify',
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
