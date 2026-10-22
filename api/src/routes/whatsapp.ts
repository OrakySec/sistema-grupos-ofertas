/**
 * /whatsapp — the account's WhatsApp numbers, connected by QR code
 * (whatsapp-qrcode skill flow: create → QR → poll state every 3 s → connected).
 * The Evolution global key never leaves the server.
 */
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/auth';
import prisma from '../lib/prisma';
import { tenantIdOf } from '../lib/tenant';
import { checkGlobalKey, createInstanceWithQr, deleteInstance, evoConfig, getQr, logoutInstance } from '../lib/evolution';
import {
  MAX_NUMBERS, instanceNameFor, newInstanceId, refreshInstance, registerWebhook, setOffersInstance,
} from '../lib/whatsappNumbers';
import { DEFAULT_SAFETY, queueStatus, safetyOf } from '../lib/leadQueue';

const PURPOSES = new Set(['OFFERS', 'LEADS']);

function view(row: any) {
  return {
    id: row.id, label: row.label, purpose: row.purpose, name: row.name,
    connected: row.connected, number: row.number, profileName: row.profileName,
    lastState: row.liveState ?? row.lastState, lastSeenAt: row.lastSeenAt, createdAt: row.createdAt,
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
    return {
      configured: !!(await evoConfig()),
      max: MAX_NUMBERS,
      instances: live.filter(Boolean).map(view),
    };
  });

  // GET /whatsapp/check — is the Evolution reachable with the GLOBAL key?
  fastify.get('/check', async () => checkGlobalKey());

  // POST /whatsapp/instances { label, purpose } — creates the number and returns its QR
  fastify.post<{ Body: { label?: string; purpose?: string } }>('/instances', async (request, reply) => {
    const tenantId = tenantIdOf(request);
    if (!(await evoConfig())) return reply.code(400).send({ message: 'A Evolution API não está configurada (URL e chave global).' });
    const count = await prisma.whatsAppInstance.count({ where: { tenantId } });
    if (count >= MAX_NUMBERS) return reply.code(403).send({ message: `Seu plano permite até ${MAX_NUMBERS} números de WhatsApp.` });
    const label = String(request.body?.label ?? '').trim().slice(0, 60) || `Número ${count + 1}`;
    const purpose = PURPOSES.has(String(request.body?.purpose)) ? String(request.body?.purpose) : 'LEADS';

    const id = newInstanceId();
    const name = instanceNameFor(id);
    const { qrcode, error } = await createInstanceWithQr(name);
    if (error && !qrcode) {
      await deleteInstance(name);
      return reply.code(502).send({ message: error });
    }
    const row = await prisma.whatsAppInstance.create({ data: { id, tenantId, name, label, purpose: 'LEADS' } });
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
    const r = await getQr(row.name);
    if (r.state === 'not_found') return reply.code(404).send({ message: 'Essa conexão não existe mais na Evolution. Clique em "Conectar" de novo.' });
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
    const { qrcode, error } = await createInstanceWithQr(row.name);
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
    await logoutInstance(row.name);
    await prisma.whatsAppInstance.update({ where: { id: row.id }, data: { connected: false, lastState: 'close' } });
    return { ok: true };
  });

  // PATCH /whatsapp/instances/:id { label?, purpose? }
  fastify.patch<{ Params: { id: string }; Body: { label?: string; purpose?: string } }>('/instances/:id', async (request, reply) => {
    const tenantId = tenantIdOf(request);
    const row = await own(request, request.params.id);
    if (!row) return reply.code(404).send({ message: 'Número não encontrado' });
    const { label, purpose } = request.body ?? {};
    if (typeof label === 'string' && label.trim()) {
      await prisma.whatsAppInstance.update({ where: { id: row.id }, data: { label: label.trim().slice(0, 60) } });
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
    await deleteInstance(row.name);
    await prisma.whatsAppInstance.delete({ where: { id: row.id } });
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
