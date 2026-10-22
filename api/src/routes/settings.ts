import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import axios from 'axios';
import FormData from 'form-data';
import { requireAuth } from '../middleware/auth';
import prisma from '../lib/prisma';
import { TelegramService } from '../services/telegram.service';
import { WhatsAppService, extractWhatsAppInviteCode } from '../services/whatsapp.service';
import { parseStripDomains } from './health';

interface UpsertSettingsBody {
  [key: string]: string;
}

interface TelegramAuthVerifyBody {
  code: string;
}

const TELEGRAM_LISTENER_URL = process.env.TELEGRAM_LISTENER_URL ?? 'http://telegram-listener:8080';
const JWT_SECRET = process.env.JWT_SECRET || 'changeme-jwt-secret';
const INTERNAL_TOKEN = 'sistema-grupos-ofertas-internal-token-fallback-key-2026';

/** Build a camelCase settings object from the flat DB key→value map */
function buildSettingsResponse(
  dbObj: Record<string, string>,
  authenticated = false,
  mlSessionActive = false,
): Record<string, any> {
  return {
    autoApprove:            dbObj.auto_approve === 'true',
    messageFooterText:      dbObj.message_footer_text ?? '',
    telegramBotToken:       dbObj.telegram_bot_token ? '***' : '',
    telegramApiId:          dbObj.telegram_api_id ? Number(dbObj.telegram_api_id) : undefined,
    telegramApiHash:        dbObj.telegram_api_hash ?? '',
    telegramPhone:          dbObj.telegram_phone ?? '',
    evolutionApiUrl:        dbObj.evolution_api_url ?? '',
    evolutionApiKey:        dbObj.evolution_api_key ? '***' : '',
    evolutionInstance:      dbObj.evolution_instance ?? '',
    // API for new WhatsApp numbers (each number keeps the one it was connected through)
    whatsappProvider:       dbObj.whatsapp_provider === 'WAHA' ? 'WAHA' : 'EVOLUTION',
    wahaApiUrl:             dbObj.waha_api_url ?? '',
    wahaApiKey:             dbObj.waha_api_key ? '***' : '',
    telegramAuthenticated:  authenticated,
    // Affiliate link conversion
    amazonAffiliateTag:     dbObj.amazon_affiliate_tag ?? '',
    shopeeAffiliateId:      dbObj.shopee_affiliate_id ?? '',
    shopeeAppId:            dbObj.shopee_app_id ?? '',
    shopeeAppSecret:        dbObj.shopee_app_secret ? '***' : '',
    aliexpressTrackingId:   dbObj.aliexpress_tracking_id ?? '',
    magaluStoreName:        dbObj.magalu_store_name ?? '',
    mlOwnListUrl:           dbObj.ml_own_list_url ?? '',
    stripLinkDomains:       dbObj.strip_link_domains ?? '',
    stripWords:             dbObj.strip_words ?? '',
    mlSessionActive:        mlSessionActive,
    linkShortenerEnabled:   dbObj.link_shortener_enabled !== 'false',
    shortenerProvider:      dbObj.shortener_provider ?? 'internal',
    shortenerDomain:        dbObj.shortener_domain ?? 'https://ofertas.ykaromarques.com',
    // Platforms whose links get shortened; empty/unset = every platform.
    shortenerPlatforms:     (dbObj.shortener_platforms ?? '').split(',').map((p) => p.trim()).filter(Boolean),
    // Marketplaces toggles
    marketplaceAmazonEnabled:       dbObj.marketplace_amazon_enabled !== 'false',
    marketplaceShopeeEnabled:       dbObj.marketplace_shopee_enabled !== 'false',
    marketplaceAliExpressEnabled:   dbObj.marketplace_aliexpress_enabled !== 'false',
    marketplaceMagaluEnabled:       dbObj.marketplace_magalu_enabled !== 'false',
    marketplaceMercadoLivreEnabled: dbObj.marketplace_mercadolivre_enabled !== 'false',
    // Invite link monitor — applies to every WhatsApp destination group that
    // has an inviteLink set (configured per-group in Grupos → Destino)
    linkMonitorEnabled:      dbObj.link_monitor_enabled === 'true',
    linkMonitorAlertNumber:  dbObj.link_monitor_alert_number ?? '',
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

/** Live-checks whether the Mercado Livre browser session is currently logged in (best-effort). */
async function fetchMlSessionActive(log: any): Promise<boolean> {
  try {
    const res = await axios.get(`${TELEGRAM_LISTENER_URL}/ml-session/status`, { timeout: 20000 });
    return !!res.data?.active;
  } catch (err: any) {
    log.warn(`Could not fetch ML session status from telegram-listener: ${err.message}`);
    return false;
  }
}


// Domains the converter turns into affiliate links — stripping one of these
// would delete real offers' links, so they can never go on the strip list.
const PROTECTED_DOMAINS = [
  'amazon.com.br', 'amazon.com', 'amzn.to', 'amzn.com',
  'shopee.com.br', 'shope.ee',
  'aliexpress.com',
  'magazineluiza.com.br', 'magalu.com', 'magazinevoce.com.br',
  'mercadolivre.com.br', 'mercadolibre.com', 'meli.la', 'mlb.link',
];

/** Accepts "https://www.Site.com/x?y", "www.site.com" or "site.com" → "site.com" (null if invalid). */
function normalizeDomain(input: string): string | null {
  let d = input.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/^www\./, '');
  d = d.replace(/:\d+$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

function isProtectedDomain(domain: string): boolean {
  return PROTECTED_DOMAINS.some((p) => domain === p || domain.endsWith('.' + p));
}

export const settingsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {

  // NOTE: GET /settings/internal is registered in server.ts at the top-level
  // scope to avoid Fastify's parent→child hook propagation hitting it with
  // the requireAuth hook below.

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

    const mlSessionActive = await fetchMlSessionActive(fastify.log);

    return reply.send(buildSettingsResponse(dbObj, authenticated, mlSessionActive));
  });

  // PUT /settings
  fastify.put(
    '/',
    async (request, reply) => {
      const updates = request.body as Record<string, any>;
      const dbUpdates: Record<string, string> = {};

      // Map incoming keys to DB keys
      if ('autoApprove' in updates)        dbUpdates.auto_approve       = String(updates.autoApprove);
      if ('messageFooterText' in updates)  dbUpdates.message_footer_text = updates.messageFooterText ?? '';
      if ('telegramBotToken' in updates && updates.telegramBotToken !== '***') dbUpdates.telegram_bot_token = updates.telegramBotToken ?? '';
      if ('telegramApiId' in updates)      dbUpdates.telegram_api_id    = updates.telegramApiId ? String(updates.telegramApiId) : '';
      if ('telegramApiHash' in updates)    dbUpdates.telegram_api_hash   = updates.telegramApiHash ?? '';
      if ('telegramPhone' in updates)      dbUpdates.telegram_phone      = updates.telegramPhone ?? '';
      if ('evolutionApiUrl' in updates)    dbUpdates.evolution_api_url   = updates.evolutionApiUrl ?? '';
      if ('evolutionApiKey' in updates && updates.evolutionApiKey !== '***') dbUpdates.evolution_api_key = updates.evolutionApiKey ?? '';
      if ('evolutionInstance' in updates)  dbUpdates.evolution_instance  = updates.evolutionInstance ?? '';
      if ('whatsappProvider' in updates)   dbUpdates.whatsapp_provider   = updates.whatsappProvider === 'WAHA' ? 'WAHA' : 'EVOLUTION';
      if ('wahaApiUrl' in updates)         dbUpdates.waha_api_url        = String(updates.wahaApiUrl ?? '').trim();
      if ('wahaApiKey' in updates && updates.wahaApiKey !== '***') dbUpdates.waha_api_key = String(updates.wahaApiKey ?? '').trim();
      // Affiliate link conversion
      if ('amazonAffiliateTag' in updates)   dbUpdates.amazon_affiliate_tag   = updates.amazonAffiliateTag ?? '';
      if ('shopeeAffiliateId' in updates)    dbUpdates.shopee_affiliate_id    = updates.shopeeAffiliateId ?? '';
      if ('shopeeAppId' in updates)          dbUpdates.shopee_app_id          = String(updates.shopeeAppId ?? '').trim();
      if ('shopeeAppSecret' in updates && updates.shopeeAppSecret !== '***') dbUpdates.shopee_app_secret = String(updates.shopeeAppSecret ?? '').trim();
      if ('aliexpressTrackingId' in updates) dbUpdates.aliexpress_tracking_id = updates.aliexpressTrackingId ?? '';
      if ('magaluStoreName' in updates)      dbUpdates.magalu_store_name      = updates.magaluStoreName ?? '';
      if ('mlOwnListUrl' in updates)         dbUpdates.ml_own_list_url        = updates.mlOwnListUrl ?? '';
      if ('stripLinkDomains' in updates)     dbUpdates.strip_link_domains     = updates.stripLinkDomains ?? '';
      // one term per line, stored as typed (a term may contain spaces)
      if ('stripWords' in updates)           dbUpdates.strip_words            = String(updates.stripWords ?? '');
      if ('linkShortenerEnabled' in updates) dbUpdates.link_shortener_enabled = String(updates.linkShortenerEnabled);
      if ('shortenerProvider' in updates)     dbUpdates.shortener_provider = updates.shortenerProvider ?? 'internal';
      if ('shortenerDomain' in updates)       dbUpdates.shortener_domain = updates.shortenerDomain ?? '';
      if ('shortenerPlatforms' in updates) {
        const allowed = new Set(['amazon', 'shopee', 'aliexpress', 'magalu', 'mercadolivre']);
        const list: string[] = Array.isArray(updates.shortenerPlatforms) ? updates.shortenerPlatforms : [];
        dbUpdates.shortener_platforms = list.filter((p) => allowed.has(p)).join(',');
      }
      // Marketplaces toggles
      if ('marketplaceAmazonEnabled' in updates)       dbUpdates.marketplace_amazon_enabled = String(updates.marketplaceAmazonEnabled);
      if ('marketplaceShopeeEnabled' in updates)       dbUpdates.marketplace_shopee_enabled = String(updates.marketplaceShopeeEnabled);
      if ('marketplaceAliExpressEnabled' in updates)   dbUpdates.marketplace_aliexpress_enabled = String(updates.marketplaceAliExpressEnabled);
      if ('marketplaceMagaluEnabled' in updates)       dbUpdates.marketplace_magalu_enabled = String(updates.marketplaceMagaluEnabled);
      if ('marketplaceMercadoLivreEnabled' in updates) dbUpdates.marketplace_mercadolivre_enabled = String(updates.marketplaceMercadoLivreEnabled);
      // Invite link monitor (global on/off + who gets alerted; the actual
      // links live per-group on DestinationGroup.inviteLink)
      if ('linkMonitorEnabled' in updates)     dbUpdates.link_monitor_enabled = String(updates.linkMonitorEnabled);
      if ('linkMonitorAlertNumber' in updates)  dbUpdates.link_monitor_alert_number = updates.linkMonitorAlertNumber ?? '';

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

      const mlSessionActive = await fetchMlSessionActive(fastify.log);

      return reply.send(buildSettingsResponse(dbObj, authenticated, mlSessionActive));
    },
  );

  // POST /settings/ml-session — upload the Playwright storage_state.json
  // generated by scripts/gerar_sessao_ml.py and forward it to the listener.
  fastify.post('/ml-session', async (request, reply) => {
    try {
      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ success: false, message: 'Nenhum arquivo enviado' });
      }
      const buffer = await file.toBuffer();

      const form = new FormData();
      form.append('file', buffer, { filename: 'ml_storage_state.json', contentType: 'application/json' });

      const response = await axios.post(`${TELEGRAM_LISTENER_URL}/ml-session/upload`, form, {
        headers: form.getHeaders(),
        timeout: 30000,
      });

      return reply.send({ success: true, active: !!response.data?.active });
    } catch (err: any) {
      let message = err instanceof Error ? err.message : String(err);
      let code = 502;
      if (err.response) {
        code = err.response.status;
        message = err.response.data?.error || err.response.data?.message || message;
      }
      fastify.log.error({ err }, 'Failed to upload ML session');
      return reply.code(code).send({ success: false, message });
    }
  });

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

  // POST /settings/test-shopee — checks the Shopee Affiliate API credentials
  // live (the listener signs and sends the request, from the same network the
  // real conversions use).
  fastify.post('/test-shopee', async (_request, reply) => {
    const rows = await prisma.setting.findMany({ where: { key: { in: ['shopee_app_id', 'shopee_app_secret'] } } });
    const cfg: Record<string, string> = {};
    for (const r of rows) cfg[r.key] = r.value;
    if (!cfg.shopee_app_id || !cfg.shopee_app_secret) {
      return reply.send({ success: false, message: 'Preencha e salve o App ID e o Secret da Shopee primeiro' });
    }
    try {
      const res = await axios.post(
        `${TELEGRAM_LISTENER_URL}/shopee/test`,
        { app_id: cfg.shopee_app_id, secret: cfg.shopee_app_secret },
        { timeout: 20000 },
      );
      return reply.send({ success: !!res.data?.ok, message: res.data?.message ?? '' });
    } catch (err: any) {
      return reply.send({ success: false, message: `Não consegui falar com o listener: ${err.message}` });
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
        timeout: 60000, // 60s — listing groups can be slow on large instances
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

  // POST /settings/strip-domain { domain } — add a domain to the strip list
  // (its links get removed from messages instead of blocking them).
  fastify.post<{ Body: { domain?: string } }>('/strip-domain', async (request, reply) => {
    const domain = normalizeDomain(request.body?.domain ?? '');
    if (!domain) {
      return reply.code(400).send({ success: false, message: 'Domínio inválido' });
    }
    if (isProtectedDomain(domain)) {
      return reply.code(400).send({
        success: false,
        message: `${domain} é uma loja suportada — remover os links dela apagaria as ofertas. Se o problema é a conversão, veja o motivo na aba Saúde.`,
      });
    }
    const current = await prisma.setting.findUnique({ where: { key: 'strip_link_domains' } });
    const domains = parseStripDomains(current?.value);
    if (!domains.includes(domain)) domains.push(domain);
    const value = domains.join(',');
    await prisma.setting.upsert({ where: { key: 'strip_link_domains' }, update: { value }, create: { key: 'strip_link_domains', value } });
    await notifyListenerReload(fastify.log);
    return reply.send({ success: true, domains });
  });

  // DELETE /settings/strip-domain?domain=x — take a domain off the strip list
  fastify.delete<{ Querystring: { domain?: string } }>('/strip-domain', async (request, reply) => {
    const domain = normalizeDomain(request.query.domain ?? '');
    if (!domain) {
      return reply.code(400).send({ success: false, message: 'Domínio inválido' });
    }
    const current = await prisma.setting.findUnique({ where: { key: 'strip_link_domains' } });
    const domains = parseStripDomains(current?.value).filter((d) => d !== domain);
    const value = domains.join(',');
    await prisma.setting.upsert({ where: { key: 'strip_link_domains' }, update: { value }, create: { key: 'strip_link_domains', value } });
    await notifyListenerReload(fastify.log);
    return reply.send({ success: true, domains });
  });

  // POST /settings/test-link-monitor — ad-hoc check of any WhatsApp invite
  // link, without touching any stored monitor state. Used by the "Verificar
  // agora" button both here and per-group in Grupos → Destino.
  fastify.post<{ Body: { url?: string } }>('/test-link-monitor', async (request, reply) => {
    try {
      const url = request.body?.url?.trim();
      if (!url) {
        return reply.code(400).send({ success: false, message: 'Informe um link para verificar' });
      }
      if (!extractWhatsAppInviteCode(url)) {
        return reply.code(400).send({ success: false, message: 'Não parece um link de convite do WhatsApp (chat.whatsapp.com/...)' });
      }

      const whatsappService = new WhatsAppService();
      const result = await whatsappService.checkInviteLink(url);
      return reply.send({
        success: true,
        valid: result.valid,
        message: result.valid
          ? `Link válido${result.groupName ? ` — grupo "${result.groupName}"` : ''}`
          : 'Link inválido ou expirado',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err }, 'Failed to check WhatsApp invite link');
      return reply.code(502).send({ success: false, message });
    }
  });

  // GET /settings/whatsapp-groups
  fastify.get('/whatsapp-groups', async (_request, reply) => {
    try {
      const whatsappService = new WhatsAppService();
      const groups = await whatsappService.listGroups();
      return reply.send(groups);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err }, 'Failed to fetch WhatsApp groups');
      return reply.code(502).send({ error: 'Failed to fetch groups', message });
    }
  });
};
