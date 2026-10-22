/**
 * /whatsapp — the account's WhatsApp numbers, connected by QR code
 * (whatsapp-qrcode skill flow: create → QR → poll state every 3 s → connected).
 * Each number lives in the Evolution or in WAHA (row.provider, lib/wa.ts); the
 * API keys never leave the server.
 */
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/auth';
import prisma from '../lib/prisma';
import { tenantIdOf } from '../lib/tenant';
import { checkGlobalKey, disconnectReasonText } from '../lib/evolution';
import { checkWahaKey } from '../lib/waha';
import {
  PROVIDERS, PROVIDER_LABEL, asProvider, createWithQr, defaultProvider, forgetProvider, getQr, logout, providerConfigured, remove,
  type Provider,
} from '../lib/wa';
import {
  MAX_NUMBERS, instanceNameFor, newInstanceId, refreshInstance, registerWebhook, setOffersInstance,
} from '../lib/whatsappNumbers';
import { DEFAULT_SAFETY, queueStatus, safetyOf } from '../lib/leadQueue';
import { brtDayStart } from '../lib/time';

const PURPOSES = new Set(['OFFERS', 'LEADS']);

function view(row: any, offersToday?: number) {
  return {
    id: row.id, label: row.label, purpose: row.purpose, name: row.name, provider: asProvider(row.provider) ?? 'EVOLUTION',
    sendsOffers: !!row.sendsOffers, offersToday: offersToday ?? 0,
    connected: row.connected, number: row.number, profileName: row.profileName,
    lastState: row.liveState ?? row.lastState, lastSeenAt: row.lastSeenAt, createdAt: row.createdAt,
    lastDisconnectAt: row.lastDisconnectAt ?? null,
    lastDisconnectCode: row.lastDisconnectCode ?? null,
    lastDisconnectText: row.lastDisconnectCode ? disconnectReasonText(row.lastDisconnectCode) : null,
  };
}

export const whatsappRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', requireAuth);

  const own = async (request: any, id: string) =>
    prisma.whatsAppInstance.findFirst({ where: { id, tenantId: tenantIdOf(request) } });

  // GET /whatsapp/instances — list with the live state of each number
  fastify.get('/instances', async (request) => {
    const tenantId = tenantIdOf(request);
    const rows = await prisma.whatsAppInstance.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
    const live = await Promise.all(rows.map((r) => refreshInstance(r.id).catch(() => r)));
    // Offers each number posted today (Brasília day).
    const sent = await prisma.deliveryLog.groupBy({
      by: ['senderInstance'],
      where: { status: 'SUCCESS', senderInstance: { in: rows.map((r) => r.name) }, sentAt: { gte: brtDayStart(0) } },
      _count: { _all: true },
    });
    const sentBy = new Map(sent.map((s) => [s.senderInstance, s._count._all]));
    const providers = Object.fromEntries(await Promise.all(PROVIDERS.map(async (p) => [p, await providerConfigured(p)]))) as Record<Provider, boolean>;
    return {
      configured: providers.EVOLUTION || providers.WAHA,
      providers,
      defaultProvider: await defaultProvider(),
      max: MAX_NUMBERS,
      instances: live.filter(Boolean).map((r: any) => view(r, sentBy.get(r.name) ?? 0)),
    };
  });

  // GET /whatsapp/check?provider= — is the Evolution (GLOBAL key) / WAHA reachable?
  fastify.get<{ Querystring: { provider?: string } }>('/check', async (request) => {
    const p = asProvider(request.query.provider) ?? (await defaultProvider());
    return p === 'WAHA' ? checkWahaKey() : checkGlobalKey();
  });

  // POST /whatsapp/instances { label, purpose, provider? } — creates the number and returns its QR
  fastify.post<{ Body: { label?: string; purpose?: string; sendsOffers?: boolean; provider?: string } }>('/instances', async (request, reply) => {
    const tenantId = tenantIdOf(request);
    const provider = asProvider(request.body?.provider) ?? (await defaultProvider());
    if (!(await providerConfigured(provider))) {
      return reply.code(400).send({ message: `${PROVIDER_LABEL[provider]} não está configurado (URL e chave em Configurações → WhatsApp).` });
    }
    const count = await prisma.whatsAppInstance.count({ where: { tenantId } });
    if (count >= MAX_NUMBERS) return reply.code(403).send({ message: `Seu plano permite até ${MAX_NUMBERS} números de WhatsApp.` });
    const label = String(request.body?.label ?? '').trim().slice(0, 60) || `Número ${count + 1}`;
    const purpose = PURPOSES.has(String(request.body?.purpose)) ? String(request.body?.purpose) : 'LEADS';

    const id = newInstanceId();
    const name = instanceNameFor(id);
    const { qrcode, error } = await createWithQr(name, purpose, provider);
    if (error && !qrcode) {
      await remove(name, provider);
      return reply.code(502).send({ message: error });
    }
    const row = await prisma.whatsAppInstance.create({
      data: { id, tenantId, name, label, provider, purpose: 'LEADS', sendsOffers: purpose === 'OFFERS' || request.body?.sendsOffers === true },
    });
    const whErr = await registerWebhook(name, purpose);
    if (whErr) fastify.log.warn({ name, whErr }, 'WhatsApp number: webhook not registered');
    // Only one number posts the offers; making this one the poster updates the setting too.
    if (purpose === 'OFFERS') await setOffersInstance(tenantId, id);
    return reply.code(201).send({ instance: view({ ...row, purpose }), qrcode });
  });

  // GET /whatsapp/instances/:id — live state (polled every 3 s while the QR is on screen)
  fastify.get<{ Params: { id: string } }>('/instances/:id', async (request, reply) => {
    if (!(await own(request, request.params.id))) return reply.code(404).send({ message: 'Número não encontrado' });
    const row = await refreshInstance(request.params.id);
    return { instance: view(row), status: row?.liveState === 'open' ? 'connected' : row?.liveState === 'not_found' ? 'not_created' : 'disconnected' };
  });

  // GET /whatsapp/instances/:id/qr — a new QR for the same instance ("Novo QR")
  fastify.get<{ Params: { id: string } }>('/instances/:id/qr', async (request, reply) => {
    const row = await own(request, request.params.id);
    if (!row) return reply.code(404).send({ message: 'Número não encontrado' });
    const r = await getQr(row.name, asProvider(row.provider) ?? 'EVOLUTION');
    if (r.state === 'not_found') return reply.code(404).send({ message: `Essa conexão não existe mais no ${PROVIDER_LABEL[asProvider(row.provider) ?? 'EVOLUTION']}. Clique em "Conectar" de novo.` });
    if (r.state === 'open') await refreshInstance(row.id);
    return r;
  });

  // POST /whatsapp/instances/:id/connect — recreate + QR ("Conectar" / "Resetar")
  fastify.post<{ Params: { id: string }; Body: { confirm?: boolean } }>('/instances/:id/connect', async (request, reply) => {
    const row = await own(request, request.params.id);
    if (!row) return reply.code(404).send({ message: 'Número não encontrado' });
    if (row.purpose === 'OFFERS' && row.connected && request.body?.confirm !== true) {
      return reply.code(409).send({ message: 'Este número posta as ofertas. Reconectar derruba os envios até escanear o QR de novo.' });
    }
    const { qrcode, error } = await createWithQr(row.name, row.purpose, asProvider(row.provider) ?? 'EVOLUTION');
    if (error && !qrcode) return reply.code(502).send({ message: error });
    await prisma.whatsAppInstance.update({ where: { id: row.id }, data: { connected: false, lastState: 'connecting' } });
    const whErr = await registerWebhook(row.name, row.purpose);
    if (whErr) fastify.log.warn({ name: row.name, whErr }, 'WhatsApp number: webhook not registered');
    return { qrcode };
  });

  // POST /whatsapp/instances/:id/logout — disconnects the phone, keeps the number in the list
  fastify.post<{ Params: { id: string } }>('/instances/:id/logout', async (request, reply) => {
    const row = await own(request, request.params.id);
    if (!row) return reply.code(404).send({ message: 'Número não encontrado' });
    await logout(row.name, asProvider(row.provider) ?? 'EVOLUTION');
    await prisma.whatsAppInstance.update({ where: { id: row.id }, data: { connected: false, lastState: 'close' } });
    return { ok: true };
  });

  // POST /whatsapp/instances/:id/provider { provider, confirm? } — move the number to the other API.
  // The session can't be carried over: the old one is removed and a new QR is returned.
  fastify.post<{ Params: { id: string }; Body: { provider?: string; confirm?: boolean } }>('/instances/:id/provider', async (request, reply) => {
    const row = await own(request, request.params.id);
    if (!row) return reply.code(404).send({ message: 'Número não encontrado' });
    const to = asProvider(request.body?.provider);
    const from = asProvider(row.provider) ?? 'EVOLUTION';
    if (!to || to === from) return reply.code(400).send({ message: 'Escolha a outra API.' });
    if (!(await providerConfigured(to))) {
      return reply.code(400).send({ message: `${PROVIDER_LABEL[to]} não está configurado (URL e chave em Configurações → WhatsApp).` });
    }
    if (row.purpose === 'OFFERS' && row.connected && request.body?.confirm !== true) {
      return reply.code(409).send({ message: 'Este é o número principal. Trocar de API desconecta ele até escanear o QR de novo.' });
    }
    await remove(row.name, from).catch(() => null);
    await prisma.whatsAppInstance.update({ where: { id: row.id }, data: { provider: to, connected: false, lastState: 'connecting' } });
    forgetProvider(row.name);
    const { qrcode, error } = await createWithQr(row.name, row.purpose, to);
    if (error && !qrcode) return reply.code(502).send({ message: error });
    const whErr = await registerWebhook(row.name, row.purpose);
    if (whErr) fastify.log.warn({ name: row.name, whErr }, 'WhatsApp number: webhook not registered');
    return { instance: view(await prisma.whatsAppInstance.findUnique({ where: { id: row.id } })), qrcode };
  });

  // PATCH /whatsapp/instances/:id { label?, purpose? }
  fastify.patch<{ Params: { id: string }; Body: { label?: string; purpose?: string; sendsOffers?: boolean } }>('/instances/:id', async (request, reply) => {
    const tenantId = tenantIdOf(request);
    const row = await own(request, request.params.id);
    if (!row) return reply.code(404).send({ message: 'Número não encontrado' });
    const { label, purpose, sendsOffers } = request.body ?? {};
    if (typeof label === 'string' && label.trim()) {
      await prisma.whatsAppInstance.update({ where: { id: row.id }, data: { label: label.trim().slice(0, 60) } });
    }
    if (typeof sendsOffers === 'boolean') {
      await prisma.whatsAppInstance.update({ where: { id: row.id }, data: { sendsOffers } });
    }
    if (purpose === 'OFFERS' && row.purpose !== 'OFFERS') {
      await setOffersInstance(tenantId, row.id);
      // The offers number also feeds the member analytics.
      await registerWebhook(row.name, 'OFFERS');
    } else if (purpose === 'LEADS' && row.purpose === 'OFFERS') {
      return reply.code(400).send({ message: 'Escolha outro número para postar as ofertas — ele assume a função e este vira número de leads.' });
    }
    return view(await prisma.whatsAppInstance.findUnique({ where: { id: row.id } }));
  });

  // DELETE /whatsapp/instances/:id?force=1
  fastify.delete<{ Params: { id: string }; Querystring: { force?: string } }>('/instances/:id', async (request, reply) => {
    const row = await own(request, request.params.id);
    if (!row) return reply.code(404).send({ message: 'Número não encontrado' });
    const campaigns = await prisma.leadCampaign.count({ where: { OR: [{ instanceId: row.id }, { numbers: { some: { instanceId: row.id } } }] } });
    if (campaigns) return reply.code(409).send({ message: `Este número está em ${campaigns} lista(s) de leads. Tire ele dessas listas (botão "Números") ou exclua-as antes.` });
    if (row.purpose === 'OFFERS' && request.query.force !== '1') {
      return reply.code(409).send({ message: 'Este número posta as ofertas. Remover para os envios para o WhatsApp.' });
    }
    await remove(row.name, asProvider(row.provider) ?? 'EVOLUTION');
    await prisma.whatsAppInstance.delete({ where: { id: row.id } });
    forgetProvider(row.name);
    if (row.purpose === 'OFFERS') {
      await prisma.setting.updateMany({ where: { key: 'evolution_instance', value: row.name }, data: { value: '' } });
    }
    return { ok: true };
  });

  // ── Lead-adding safety settings per number ──────────────────────────────
  fastify.get<{ Params: { id: string } }>('/instances/:id/safety', async (request, reply) => {
    const row = await own(request, request.params.id);
    if (!row) return reply.code(404).send({ message: 'Número não encontrado' });
    return { safety: safetyOf(row.leadSafety), defaults: DEFAULT_SAFETY, status: await queueStatus(row.id) };
  });

  fastify.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/instances/:id/safety', async (request, reply) => {
    const row = await own(request, request.params.id);
    if (!row) return reply.code(404).send({ message: 'Número não encontrado' });
    const safety = safetyOf(request.body);
    await prisma.whatsAppInstance.update({ where: { id: row.id }, data: { leadSafety: safety as any } });
    return { safety };
  });

  // Pause / resume this number's lead queue (resume also clears the failure streak).
  fastify.post<{ Params: { id: string }; Body: { paused?: boolean } }>('/instances/:id/lead-pause', async (request, reply) => {
    const row = await own(request, request.params.id);
    if (!row) return reply.code(404).send({ message: 'Número não encontrado' });
    const paused = request.body?.paused !== false;
    await prisma.whatsAppInstance.update({
      where: { id: row.id },
      data: paused
        ? { leadPaused: true, leadPausedReason: 'Pausado por você' }
        : { leadPaused: false, leadPausedReason: null, leadFailStreak: 0 },
    });
    return queueStatus(row.id);
  });

  // End the rest period now (e.g. after changing the settings).
  fastify.post<{ Params: { id: string } }>('/instances/:id/end-rest', async (request, reply) => {
    const row = await own(request, request.params.id);
    if (!row) return reply.code(404).send({ message: 'Número não encontrado' });
    await prisma.whatsAppInstance.update({ where: { id: row.id }, data: { leadRestUntil: null, leadSinceRest: 0 } });
    return queueStatus(row.id);
  });
};
