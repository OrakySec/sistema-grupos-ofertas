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
const JWT_SECRET = process.env.JWT_SECRET ?? '';

/** Build a camelCase settings object from the flat DB key→value map */
function buildSettingsResponse(dbObj: Record<string, string>, authenticated = false): Record<string, any> {
  return {
    autoApprove: dbObj.auto_approve === 'true',
    telegramBotToken: dbObj.telegram_bot_token ? '***' : '',
    telegramApiId: dbObj.telegram_api_id ? Number(dbObj.telegram_api_id) : undefined,
    telegramApiHash: dbObj.telegram_api_hash ?? '',
    telegramPhone: dbObj.telegram_phone ?? '',
    evolutionApiUrl: dbObj.evolution_api_url ?? '',
    evolutionApiKey: dbObj.evolution_api_key ? '***' : '',
    evolutionInstance: dbObj.evolution_instance ?? '',
    telegramAuthenticated: authenticated,
  };
}

/** Notify the telegram-listener to reload settings immediately (best-effort). */
async function notifyListenerReload(log: any): Promise<void> {
  try {
    await axios.post(`${TELEGRAM_LISTENER_URL}/reload-settings`, {}, { timeout: 5000 });
    log.info('telegram-listener notified to reload settings');
  } catch (err: any) {
    log.warn(`Could not notify telegram-listener: ${err.message}`);
  }
}

export const settingsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {

  // ── GET /settings/internal ──────────────────────────────────────────────────
  // Internal-only endpoint used by the telegram-listener service.
  // Authenticates via X-Internal-Key header — no user JWT required.
  // Returns raw snake_case keys so the Python service can consume them directly.
  fastify.get('/internal', async (request, reply) => {
    const key = request.headers['x-internal-key'];
    if (!JWT_SECRET || key !== JWT_SECRET) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const settings = await prisma.setting.findMany();
    const dbObj: Record<string, string> = {};
    for (const s of settings) dbObj[s.key] = s.value;

    // Return raw keys so the Python listener can read them directly
    return reply.send({
      telegram_api_id: dbObj.telegram_api_id ?? '',
      telegram_api_hash: dbObj.telegram_api_hash ?? '',
      telegram_phone: dbObj.telegram_phone ?? '',
      telegram_bot_token: dbObj.telegram_bot_token ?? '',
    });
  });

  // All routes below require a user JWT
  fastify.addHook('preHandler', requireAuth);

  // GET /settings
  fastify.get('/', async (_request, reply) => {
    const settings = await prisma.setting.findMany();
    const dbObj: Record<string, string> = {};
    for (const s of settings) dbObj[s.key] = s.value;

    let authenticated = false;
    try {
      const statusResponse = await axios.get(`${TELEGRAM_LISTENER_URL}/status`, { timeout: 2000 });
      authenticated = !!statusResponse.data.authenticated;
    } catch (err: any) {
      fastify.log.warn(`Could not fetch status from telegram-listener: ${err.message}`);
    }

    return reply.send(buildSettingsResponse(dbObj, authenticated));
  });

  // PUT /settings
  fastify.put(
    '/',
    async (request, reply) => {
      const updates = request.body as Record<string, any>;
      const dbUpdates: Record<string, string> = {};

      // Map incoming keys to DB keys
      if ('autoApprove' in updates) dbUpdates.auto_approve = String(updates.autoApprove);
      if ('telegramBotToken' in updates && updates.telegramBotToken !== '***') dbUpdates.telegram_bot_token = updates.telegramBotToken ?? '';
      if ('telegramApiId' in updates) dbUpdates.telegram_api_id = updates.telegramApiId ? String(updates.telegramApiId) : '';
      if ('telegramApiHash' in updates) dbUpdates.telegram_api_hash = updates.telegramApiHash ?? '';
      if ('telegramPhone' in updates) dbUpdates.telegram_phone = updates.telegramPhone ?? '';
      if ('evolutionApiUrl' in updates) dbUpdates.evolution_api_url = updates.evolutionApiUrl ?? '';
      if ('evolutionApiKey' in updates && updates.evolutionApiKey !== '***') dbUpdates.evolution_api_key = updates.evolutionApiKey ?? '';
      if ('evolutionInstance' in updates) dbUpdates.evolution_instance = updates.evolutionInstance ?? '';

      await Promise.all(
        Object.entries(dbUpdates).map(([key, value]) =>
          prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } }),
        ),
      );

      // If Telegram credentials were touched, notify the listener immediately
      const touchedTelegram = ['telegramApiId', 'telegramApiHash', 'telegramPhone'].some((k) => k in updates);
      if (touchedTelegram) await notifyListenerReload(fastify.log);

      const settings = await prisma.setting.findMany();
      const dbObj: Record<string, string> = {};
      for (const s of settings) dbObj[s.key] = s.value;

      let authenticated = false;
      try {
        const statusResponse = await axios.get(`${TELEGRAM_LISTENER_URL}/status`, { timeout: 2000 });
        authenticated = !!statusResponse.data.authenticated;
      } catch { /* silent */ }

      return reply.send(buildSettingsResponse(dbObj, authenticated));
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
    } catch (err: any) {
      let message = err instanceof Error ? err.message : String(err);
      let code = 502;
      if (err.response) {
        code = err.response.status;
        message = err.response.data?.error || err.response.data?.message || message;
      }
      fastify.log.error({ err }, 'Failed to start Telegram auth');
      return reply.code(code).send({ success: false, message });
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
      } catch (err: any) {
        let message = err instanceof Error ? err.message : String(err);
        let code = 502;
        if (err.response) {
          code = err.response.status;
          message = err.response.data?.error || err.response.data?.message || message;
        }
        fastify.log.error({ err }, 'Failed to verify Telegram auth code');
        return reply.code(code).send({ success: false, message });
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
