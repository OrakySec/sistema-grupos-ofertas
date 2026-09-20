import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import axios from 'axios';
import { requireAuth } from '../middleware/auth';
import prisma from '../lib/prisma';
import { WhatsAppService } from '../services/whatsapp.service';
import { classifyOfferProblem } from '../lib/failureReason';

const TELEGRAM_LISTENER_URL = process.env.TELEGRAM_LISTENER_URL ?? 'http://telegram-listener:8080';

type HealthLevel = 'ok' | 'warning' | 'critical' | 'inactive';

interface ReasonCount {
  reason: string;
  count: number;
}

const HOUR_MS = 60 * 60 * 1000;
const LEVEL_ORDER: Record<HealthLevel, number> = { inactive: 0, ok: 1, warning: 2, critical: 3 };

function worst(a: HealthLevel, b: HealthLevel): HealthLevel {
  return LEVEL_ORDER[b] > LEVEL_ORDER[a] ? b : a;
}

function tally(reasons: string[]): ReasonCount[] {
  const map = new Map<string, number>();
  for (const r of reasons) map.set(r, (map.get(r) ?? 0) + 1);
  return [...map.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

async function probeListener(): Promise<{ reachable: boolean; authenticated: boolean | null; mlSessionActive: boolean | null }> {
  const [status, ml] = await Promise.all([
    axios.get(`${TELEGRAM_LISTENER_URL}/status`, { timeout: 3000 }).then((r) => r.data).catch(() => null),
    axios.get(`${TELEGRAM_LISTENER_URL}/ml-session/status`, { timeout: 20000 }).then((r) => r.data).catch(() => null),
  ]);
  return {
    reachable: status !== null,
    authenticated: status ? !!status.authenticated : null,
    mlSessionActive: ml ? !!ml.active : null,
  };
}

export const healthRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', requireAuth);

  // GET /health/groups?hours=24&silentWarnHours=6&silentCritHours=24
  // Per-group health for every source AND destination group, plus a small
  // system block — meant to answer "which group is broken and why" at a glance.
  fastify.get<{ Querystring: { hours?: string; silentWarnHours?: string; silentCritHours?: string } }>(
    '/groups',
    async (request, reply) => {
      const windowHours = Math.min(Math.max(Number(request.query.hours) || 24, 1), 168);
      const silentWarnHours = Number(request.query.silentWarnHours) || 6;
      const silentCritHours = Number(request.query.silentCritHours) || 24;
      const now = Date.now();
      const since = new Date(now - windowHours * HOUR_MS);
      const staleBefore = new Date(now - 2 * HOUR_MS);

      const [
        sourceGroups,
        destGroups,
        offerCounts,
        lastOfferAt,
        lastSentAt,
        problemOffers,
        deliveryCounts,
        lastDeliverySuccess,
        recentDeliveryFailures,
        pendingStaleRows,
        autoApproveSetting,
      ] = await Promise.all([
        prisma.sourceGroup.findMany({
          include: { niche: { select: { name: true } }, destinations: { include: { destinationGroup: true } } },
        }),
        prisma.destinationGroup.findMany({ include: { sourceGroups: true } }),
        prisma.offer.groupBy({ by: ['sourceGroupId', 'status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
        prisma.offer.groupBy({ by: ['sourceGroupId'], _max: { createdAt: true } }),
        prisma.offer.groupBy({ by: ['sourceGroupId'], where: { status: 'SENT' }, _max: { sentAt: true } }),
        prisma.offer.findMany({
          where: { createdAt: { gte: since }, status: { in: ['REJECTED', 'FAILED'] } },
          orderBy: { createdAt: 'desc' },
          take: 3000,
          select: {
            sourceGroupId: true,
            status: true,
            processingLog: true,
            deliveryLogs: { select: { status: true, errorMessage: true } },
          },
        }),
        prisma.deliveryLog.groupBy({ by: ['destinationGroupId', 'status'], where: { sentAt: { gte: since } }, _count: { _all: true } }),
        prisma.deliveryLog.groupBy({ by: ['destinationGroupId'], where: { status: 'SUCCESS' }, _max: { sentAt: true } }),
        prisma.deliveryLog.findMany({
          where: { status: 'FAILED', sentAt: { gte: since } },
          orderBy: { sentAt: 'desc' },
          take: 1000,
          select: { destinationGroupId: true, errorMessage: true, sentAt: true },
        }),
        prisma.offer.groupBy({ by: ['sourceGroupId'], where: { status: 'PENDING', createdAt: { lt: staleBefore } }, _count: { _all: true } }),
        prisma.setting.findUnique({ where: { key: 'auto_approve' } }),
      ]);

      // ── Lookup tables ───────────────────────────────────────────────────
      const countsBySource = new Map<string, Record<string, number>>();
      for (const row of offerCounts) {
        const c = countsBySource.get(row.sourceGroupId) ?? {};
        c[row.status] = row._count._all;
        countsBySource.set(row.sourceGroupId, c);
      }
      const lastOfferBySource = new Map(lastOfferAt.map((r) => [r.sourceGroupId, r._max.createdAt]));
      const lastSentBySource = new Map(lastSentAt.map((r) => [r.sourceGroupId, r._max.sentAt]));
      const stalePendingBySource = new Map(pendingStaleRows.map((r) => [r.sourceGroupId, r._count._all]));

      const reasonsBySource = new Map<string, string[]>();
      for (const o of problemOffers) {
        const reason = classifyOfferProblem(o);
        if (!reason) continue;
        const list = reasonsBySource.get(o.sourceGroupId) ?? [];
        list.push(reason);
        reasonsBySource.set(o.sourceGroupId, list);
      }

      // ── Source groups ───────────────────────────────────────────────────
      const sources = sourceGroups.map((g) => {
        const counts = countsBySource.get(g.id) ?? {};
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        const rejected = counts.REJECTED ?? 0;
        const failed = counts.FAILED ?? 0;
        const last = lastOfferBySource.get(g.id) ?? null;
        const silentHours = last ? (now - last.getTime()) / HOUR_MS : null;
        const activeDestinations = g.destinations.filter((d) => d.destinationGroup.isActive).length;
        const stalePending = stalePendingBySource.get(g.id) ?? 0;

        let level: HealthLevel = 'ok';
        const issues: string[] = [];

        if (!g.isActive) {
          level = 'inactive';
        } else {
          if (activeDestinations === 0) {
            level = worst(level, 'critical');
            issues.push(
              g.destinations.length === 0
                ? 'Nenhum grupo de destino vinculado — as ofertas falham sem tentar enviar'
                : 'Todos os destinos vinculados estão desativados',
            );
          }
          if (silentHours === null) {
            level = worst(level, 'critical');
            issues.push('Nenhuma oferta registrada — o listener pode não ter acesso a esse grupo (obs.: ofertas enviadas/rejeitadas somem do histórico após 7 dias)');
          } else if (silentHours >= silentCritHours) {
            level = worst(level, 'critical');
            issues.push(`Sem mensagens novas há ${Math.floor(silentHours)}h — confira se o listener ainda tem acesso ao grupo`);
          } else if (silentHours >= silentWarnHours) {
            level = worst(level, 'warning');
            issues.push(`Sem mensagens novas há ${Math.floor(silentHours)}h`);
          }
          if (total >= 5 && rejected / total >= 0.8) {
            level = worst(level, 'critical');
            issues.push(`${Math.round((rejected / total) * 100)}% das ofertas foram rejeitadas nas últimas ${windowHours}h`);
          } else if (total >= 5 && rejected / total >= 0.5) {
            level = worst(level, 'warning');
            issues.push(`${Math.round((rejected / total) * 100)}% das ofertas foram rejeitadas nas últimas ${windowHours}h`);
          }
          if (failed > 0) {
            level = worst(level, 'warning');
            issues.push(`${failed} oferta(s) falharam no envio nas últimas ${windowHours}h`);
          }
          if (stalePending > 0) {
            level = worst(level, 'warning');
            issues.push(`${stalePending} oferta(s) pendentes há mais de 2h (aprovação automática está ${autoApproveSetting?.value === 'true' ? 'ligada' : 'desligada'})`);
          }
        }

        return {
          id: g.id,
          name: g.name,
          telegramId: g.telegramId.toString(),
          isActive: g.isActive,
          nicheName: g.niche?.name ?? null,
          level,
          issues,
          lastOfferAt: last,
          lastSentAt: lastSentBySource.get(g.id) ?? null,
          silentHours: silentHours === null ? null : Math.round(silentHours * 10) / 10,
          counts: {
            total,
            pending: counts.PENDING ?? 0,
            approved: counts.APPROVED ?? 0,
            sent: counts.SENT ?? 0,
            rejected,
            failed,
          },
          problemReasons: tally(reasonsBySource.get(g.id) ?? []),
          destinations: g.destinations.map((d) => ({
            id: d.destinationGroup.id,
            name: d.destinationGroup.name,
            type: d.destinationGroup.type,
            isActive: d.destinationGroup.isActive,
          })),
        };
      });

      // ── Destination groups ──────────────────────────────────────────────
      const deliveryByDest = new Map<string, { SUCCESS: number; FAILED: number }>();
      for (const row of deliveryCounts) {
        const c = deliveryByDest.get(row.destinationGroupId) ?? { SUCCESS: 0, FAILED: 0 };
        c[row.status] = row._count._all;
        deliveryByDest.set(row.destinationGroupId, c);
      }
      const lastSuccessByDest = new Map(lastDeliverySuccess.map((r) => [r.destinationGroupId, r._max.sentAt]));
      const failuresByDest = new Map<string, { errorMessage: string | null; sentAt: Date }[]>();
      for (const f of recentDeliveryFailures) {
        const list = failuresByDest.get(f.destinationGroupId) ?? [];
        list.push({ errorMessage: f.errorMessage, sentAt: f.sentAt });
        failuresByDest.set(f.destinationGroupId, list);
      }

      const destinations = destGroups.map((g) => {
        const c = deliveryByDest.get(g.id) ?? { SUCCESS: 0, FAILED: 0 };
        const attempts = c.SUCCESS + c.FAILED;
        const lastSuccess = lastSuccessByDest.get(g.id) ?? null;
        const failures = failuresByDest.get(g.id) ?? [];
        const lastFailure = failures[0] ?? null;
        const failedAfterLastSuccess = lastFailure && (!lastSuccess || lastFailure.sentAt > lastSuccess);

        let level: HealthLevel = 'ok';
        const issues: string[] = [];

        if (!g.isActive) {
          level = 'inactive';
        } else {
          if (g.sourceGroups.length === 0) {
            level = worst(level, 'warning');
            issues.push('Nenhum grupo de origem vinculado — nunca vai receber ofertas');
          }
          if (failedAfterLastSuccess) {
            level = worst(level, 'critical');
            issues.push(`A última entrega falhou${lastFailure?.errorMessage ? `: ${lastFailure.errorMessage.slice(0, 160)}` : ''}`);
          } else if (attempts >= 5 && c.FAILED / attempts >= 0.3) {
            level = worst(level, 'warning');
            issues.push(`${Math.round((c.FAILED / attempts) * 100)}% das entregas falharam nas últimas ${windowHours}h`);
          }
          if (g.sourceGroups.length > 0 && c.SUCCESS === 0) {
            level = worst(level, attempts === 0 ? 'warning' : 'critical');
            issues.push(`Nenhuma entrega com sucesso nas últimas ${windowHours}h`);
          }
          if (g.type === 'WHATSAPP' && g.inviteLink && g.linkStatus === 'INVALID') {
            level = worst(level, 'critical');
            issues.push('Link de convite do grupo expirou/foi revogado');
          }
        }

        return {
          id: g.id,
          name: g.name,
          type: g.type,
          chatId: g.chatId,
          isActive: g.isActive,
          level,
          issues,
          linkedSources: g.sourceGroups.length,
          lastSuccessAt: lastSuccess,
          lastFailure: lastFailure ? { at: lastFailure.sentAt, error: lastFailure.errorMessage } : null,
          counts: { success: c.SUCCESS, failed: c.FAILED },
          failureReasons: tally(failures.map((f) => f.errorMessage ?? 'Erro sem mensagem')),
          linkStatus: g.type === 'WHATSAPP' && g.inviteLink ? g.linkStatus : null,
        };
      });

      // ── System block (best-effort, never blocks the whole response) ─────
      const wa = new WhatsAppService();
      const [listener, evolutionConnected] = await Promise.all([
        withTimeout(probeListener(), 22000, { reachable: false, authenticated: null, mlSessionActive: null }),
        withTimeout(wa.testConnection().catch(() => false), 8000, false),
      ]);

      return reply.send({
        generatedAt: new Date().toISOString(),
        windowHours,
        thresholds: { silentWarnHours, silentCritHours },
        system: {
          autoApprove: autoApproveSetting?.value === 'true',
          listener,
          evolutionConnected,
        },
        sourceGroups: sources.sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level] || a.name.localeCompare(b.name)),
        destinationGroups: destinations.sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level] || a.name.localeCompare(b.name)),
      });
    },
  );
};
