import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fs from 'fs';
import path from 'path';
import { requireAuth } from '../middleware/auth';
import prisma from '../lib/prisma';

const MEDIA_BASE_PATH = process.env.MEDIA_BASE_PATH || '/app/media';
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface CreateNicheBody {
  name: string;
  slug?: string | null;
}

interface UpdateNicheBody {
  name?: string;
  slug?: string | null;
  footerText?: string | null;
  mlOwnListUrl?: string | null;
  clearMockupTemplate?: boolean;
}

function normalizeSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase();
  return SLUG_RE.test(slug) ? slug : null;
}

export const nichesRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Same internal-key bypass pattern as groupsRoutes — the panel authenticates
  // normally, the telegram-listener doesn't call this file directly (it reads
  // niches nested inside GET /groups/source instead).
  fastify.addHook('preHandler', async (request, reply) => {
    const internalKey = request.headers['x-internal-key'];
    if (internalKey === 'sistema-grupos-ofertas-internal-token-fallback-key-2026') {
      return;
    }
    await requireAuth(request, reply);
  });

  // GET /niches
  fastify.get('/', async (_request, reply) => {
    const niches = await prisma.niche.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { sourceGroups: true } } },
    });
    return reply.send(
      niches.map((n) => ({ ...n, sourceGroupCount: n._count.sourceGroups, _count: undefined })),
    );
  });

  // POST /niches
  fastify.post<{ Body: CreateNicheBody }>(
    '/',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1 },
            slug: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, slug: rawSlug } = request.body;

      let slug: string | null = null;
      if (typeof rawSlug === 'string' && rawSlug.trim()) {
        slug = normalizeSlug(rawSlug);
        if (!slug) {
          return reply.code(400).send({
            error: 'Slug inválido — use apenas letras minúsculas, números e hífens (ex: impressao-3d)',
          });
        }
        const conflict = await prisma.niche.findUnique({ where: { slug } });
        if (conflict) {
          return reply.code(409).send({ error: 'Já existe um nicho com esse slug' });
        }
      }

      const niche = await prisma.niche.create({ data: { name, slug } });
      return reply.code(201).send(niche);
    },
  );

  // PATCH /niches/:id
  fastify.patch<{ Params: { id: string }; Body: UpdateNicheBody }>(
    '/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            slug: { type: ['string', 'null'] },
            footerText: { type: ['string', 'null'] },
            mlOwnListUrl: { type: ['string', 'null'] },
            clearMockupTemplate: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { clearMockupTemplate, ...data } = request.body;

      const existing = await prisma.niche.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Niche not found' });
      }

      if (typeof data.slug === 'string') {
        const slug = normalizeSlug(data.slug);
        if (!slug) {
          return reply.code(400).send({
            error: 'Slug inválido — use apenas letras minúsculas, números e hífens (ex: impressao-3d)',
          });
        }
        const slugConflict = await prisma.niche.findUnique({ where: { slug } });
        if (slugConflict && slugConflict.id !== id) {
          return reply.code(409).send({ error: 'Já existe um nicho com esse slug' });
        }
        data.slug = slug;
      }

      if (clearMockupTemplate) {
        Object.assign(data, {
          mockupTemplatePath: null,
          mockupBoxLeft: null,
          mockupBoxTop: null,
          mockupBoxRight: null,
          mockupBoxBottom: null,
          mockupCornerRadius: null,
        });
      }

      const updated = await prisma.niche.update({ where: { id }, data });
      return reply.send(updated);
    },
  );

  // POST /niches/:id/mockup-template — upload a custom mockup template image
  // for this niche, together with the placeholder rectangle (coordinates
  // chosen visually in the frontend). All 5 mockup fields are written
  // atomically — either a fully custom template or none at all, so the
  // telegram-listener never sees a half-configured template.
  fastify.post<{ Params: { id: string } }>(
    '/:id/mockup-template',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const existing = await prisma.niche.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Niche not found' });
      }

      let fileBuffer: Buffer | null = null;
      let fileExt = 'jpg';
      const fields: Record<string, string> = {};

      for await (const part of request.parts()) {
        if (part.type === 'file') {
          fileBuffer = await part.toBuffer();
          const ext = path.extname(part.filename || '').replace('.', '').toLowerCase();
          if (ext) fileExt = ext;
        } else if (part.type === 'field' && typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
      }

      if (!fileBuffer) {
        return reply.code(400).send({ error: 'Nenhuma imagem enviada' });
      }

      const boxLeft = Number(fields.boxLeft);
      const boxTop = Number(fields.boxTop);
      const boxRight = Number(fields.boxRight);
      const boxBottom = Number(fields.boxBottom);
      const cornerRadius = Number(fields.cornerRadius);

      if ([boxLeft, boxTop, boxRight, boxBottom, cornerRadius].some((n) => !Number.isFinite(n))) {
        return reply.code(400).send({ error: 'Coordenadas do template ausentes ou inválidas' });
      }
      if (boxRight <= boxLeft || boxBottom <= boxTop) {
        return reply.code(400).send({ error: 'Retângulo do template inválido' });
      }

      const templatesDir = path.join(MEDIA_BASE_PATH, 'templates');
      fs.mkdirSync(templatesDir, { recursive: true });
      const relativePath = `templates/niche-${id}.${fileExt}`;
      fs.writeFileSync(path.join(MEDIA_BASE_PATH, relativePath), fileBuffer);

      const updated = await prisma.niche.update({
        where: { id },
        data: {
          mockupTemplatePath: relativePath,
          mockupBoxLeft: Math.round(boxLeft),
          mockupBoxTop: Math.round(boxTop),
          mockupBoxRight: Math.round(boxRight),
          mockupBoxBottom: Math.round(boxBottom),
          mockupCornerRadius: Math.round(cornerRadius),
        },
      });

      return reply.send(updated);
    },
  );

  // DELETE /niches/:id — sourceGroups pointing here just fall back to global
  // defaults (nicheId set to NULL via onDelete: SetNull), nothing cascades.
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const existing = await prisma.niche.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Niche not found' });
      }

      await prisma.niche.delete({ where: { id } });
      return reply.code(204).send();
    },
  );
};
