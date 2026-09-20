import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/auth';
import prisma from '../lib/prisma';
import { classifyOfferProblem } from '../lib/failureReason';

// In-memory log buffer for SSE streaming
const logBuffer: Array<{ timestamp: string; level: string; message: string; data?: unknown }> = [];
const MAX_BUFFER_SIZE = 500;

export function appendLog(level: string, message: string, data?: unknown): void {
  const entry = { timestamp: new Date().toISOString(), level, message, data };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer.shift();
  }
  // Emit to all active SSE clients
  for (const client of sseClients) {
    try {
      client(`data: ${JSON.stringify(entry)}\n\n`);
    } catch {
      // Client disconnected — will be cleaned up
    }
  }
}

const sseClients: Set<(data: string) => void> = new Set();

export const logsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', requireAuth);

  // GET /logs/stream — Server-Sent Events
  fastify.get('/stream', async (request, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    // Send last 50 buffered logs immediately
    const recent = logBuffer.slice(-50);
    for (const entry of recent) {
      reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    // Send a heartbeat every 15 seconds to keep connection alive
    const heartbeat = setInterval(() => {
      reply.raw.write(': heartbeat\n\n');
    }, 15000);

    // Register this client
    const sendToClient = (data: string) => {
      reply.raw.write(data);
    };
    sseClients.add(sendToClient);

    // Cleanup on disconnect
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(sendToClient);
    });

    request.raw.on('aborted', () => {
      clearInterval(heartbeat);
      sseClients.delete(sendToClient);
    });

    // Return raw response — Fastify should not auto-finalize
    await new Promise<void>((resolve) => {
      request.raw.on('close', resolve);
      request.raw.on('aborted', resolve);
    });
  });

  // GET /logs — last 100 delivery logs, optionally filtered by source group
  fastify.get<{ Querystring: { sourceGroupId?: string } }>('/', async (request, reply) => {
    const { sourceGroupId } = request.query;

    const logs = await prisma.deliveryLog.findMany({
      where: sourceGroupId ? { offer: { sourceGroupId } } : {},
      orderBy: { sentAt: 'desc' },
      take: 100,
      include: {
        offer: {
          select: {
            id: true,
            text: true,
            mediaType: true,
            status: true,
            telegramMessageId: true,
            sourceGroup: {
              select: { id: true, name: true },
            },
          },
        },
        destinationGroup: {
          select: {
            id: true,
            name: true,
            type: true,
          },
        },
      },
    });

    // Serialize BigInt in telegramMessageId
    const serialized = logs.map((log) => ({
      ...log,
      offer: log.offer
        ? {
            ...log.offer,
            telegramMessageId: log.offer.telegramMessageId.toString(),
          }
        : null,
    }));

    return reply.send(serialized);
  });

  // GET /logs/processing — last 200 messages with processing trace (for debug panel),
  // optionally filtered by source group
  fastify.get<{ Querystring: { sourceGroupId?: string } }>('/processing', async (request, reply) => {
    // Auto-cleanup: delete offers older than 7 days that are already SENT or FAILED
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await prisma.offer.deleteMany({
      where: {
        createdAt: { lt: cutoff },
        status: { in: ['SENT', 'FAILED', 'REJECTED'] },
      },
    }).catch(() => {/* non-critical */});

    const { sourceGroupId } = request.query;

    const offers = await prisma.offer.findMany({
      where: sourceGroupId ? { sourceGroupId } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        telegramMessageId: true,
        text: true,
        mediaType: true,
        mediaCaption: true,
        senderName: true,
        status: true,
        createdAt: true,
        sentAt: true,
        processingLog: true,
        sourceGroup: {
          select: { id: true, name: true },
        },
        deliveryLogs: {
          select: {
            id: true,
            status: true,
            errorMessage: true,
            sentAt: true,
            destinationGroup: {
              select: { id: true, name: true, type: true },
            },
          },
        },
      },
    });

    const serialized = offers.map((o) => ({
      ...o,
      telegramMessageId: o.telegramMessageId.toString(),
      problemReason: classifyOfferProblem(o),
    }));

    return reply.send(serialized);
  });
};
