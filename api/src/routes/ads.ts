import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { randomBytes } from 'crypto';
import { requireAuth } from '../middleware/auth';
import prisma from '../lib/prisma';
import { brtDateStart } from '../lib/time';
import { metaConfig, syncMeta, testMeta, accountOffset, accountToday, shiftDate } from '../lib/metaAds';
import { syncShopeeConversions } from '../lib/shopeeConversions';
import { sendPendingPurchases } from '../lib/metaPurchase';
import { runAdRules } from '../lib/adRules';
import { generateShortLink } from '../lib/shopeeApi';
import { createShortUrl } from '../lib/shortener';
import { sendViewContent } from '../lib/metaCapi';

const LEVELS = ['CAMPAIGN', 'ADSET', 'AD'] as const;
const DAY_MS = 86400000;
const r2 = (v: number) => Math.round(v * 100) / 100;

function newCode() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(7);
  return 'm' + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Name filter terms ("shopee, trafego direto") saved by the user. */
async function campaignFilterTerms(): Promise<string[]> {
  const row = await prisma.setting.findUnique({ where: { key: 'ads_campaign_filter' } });
  return (row?.value ?? '').split(',').map((t) => fold(t.trim())).filter(Boolean);
}

/**
 * Which campaigns the page shows: the user's explicit choice wins; for
 * campaigns never chosen, the name filter decides (no filter = shown).
 */
export function isCampaignShown(c: { name: string; shown: boolean | null }, terms: string[]): boolean {
  if (c.shown === true) return true;
  if (c.shown === false) return false;
  if (terms.length === 0) return true;
  const name = fold(c.name);
  return terms.some((t) => name.includes(t));
}

async function shownCampaignIds(): Promise<Set<string>> {
  const [campaigns, terms] = await Promise.all([
    prisma.metaEntity.findMany({ where: { level: 'CAMPAIGN' }, select: { id: true, name: true, shown: true } }),
    campaignFilterTerms(),
  ]);
  return new Set(campaigns.filter((c) => isCampaignShown(c, terms)).map((c) => c.id));
}

export const adsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', requireAuth);

  // ── Config ────────────────────────────────────────────────────────────────

  fastify.get('/config', async () => {
    const rows = await prisma.setting.findMany({
      where: { key: { in: ['meta_ads_token', 'meta_ad_account_ids', 'meta_api_version', 'meta_last_sync', 'shopee_sales_last_sync', 'meta_rule_defaults', 'meta_shopee_pixel_id', 'meta_shopee_capi_token', 'meta_shopee_test_code', 'meta_shopee_capi_stats'] } },
    });
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const parse = (v?: string) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
    return {
      tokenSet: !!m.meta_ads_token,
      accounts: m.meta_ad_account_ids ?? '',
      version: m.meta_api_version ?? '',
      lastMetaSync: parse(m.meta_last_sync),
      lastShopeeSync: parse(m.shopee_sales_last_sync),
      ruleDefaults: parse(m.meta_rule_defaults) ?? { maxCpc: 0.5, days: 2, mode: 'CONSECUTIVE', minSpend: 10, action: 'NOTIFY' },
      pixel: {
        pixelId: m.meta_shopee_pixel_id ?? '',
        tokenSet: !!m.meta_shopee_capi_token,
        testCode: m.meta_shopee_test_code ?? '',
        stats: parse(m.meta_shopee_capi_stats),
      },
    };
  });

  fastify.put<{ Body: { token?: string; accounts?: string; version?: string; ruleDefaults?: any; pixelId?: string; pixelToken?: string; testCode?: string } }>('/config', async (request) => {
    const b = request.body ?? {};
    const set = (key: string, value: string) => prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    if (b.token && b.token !== '***') await set('meta_ads_token', b.token.trim());
    if (b.accounts !== undefined) await set('meta_ad_account_ids', String(b.accounts).trim());
    if (b.version !== undefined) await set('meta_api_version', String(b.version).trim());
    if (b.ruleDefaults) await set('meta_rule_defaults', JSON.stringify(b.ruleDefaults));
    if (b.pixelId !== undefined) await set('meta_shopee_pixel_id', String(b.pixelId).replace(/[^0-9]/g, ''));
    if (b.pixelToken && b.pixelToken !== '***') await set('meta_shopee_capi_token', b.pixelToken.trim());
    if (b.testCode !== undefined) await set('meta_shopee_test_code', String(b.testCode).trim());
    return { ok: true };
  });

  // POST /ads/pixel/test: one ViewContent with sample data (shows up in
  // Events Manager > Test events when a test code is set).
  fastify.post('/pixel/test', async (request) => {
    const now = Date.now();
    return sendViewContent({
      eventId: `teste-${now}`,
      eventTimeS: Math.floor(now / 1000),
      sourceUrl: 'https://ofertas.ykaromarques.com/s/teste',
      ip: request.ip,
      userAgent: String(request.headers['user-agent'] ?? 'Mozilla/5.0'),
      fbc: `fb.1.${now}.teste-fbclid-ofertas-manager`,
      fbp: `fb.1.${now}.1234567890`,
      productUrl: 'https://shopee.com.br/product/1/2',
      productName: 'Evento de teste',
      adCode: 'teste',
    });
  });

  fastify.post('/test', async () => testMeta());

  // POST /ads/sync — pull Meta + Shopee sales now (rules run in the worker every hour)
  fastify.post('/sync', async () => {
    // Say clearly when Meta is skipped, instead of a silent "synced".
    const meta = (await metaConfig())
      ? await syncMeta(7)
      : [{ account: '—', error: 'Token de acesso ou conta de anúncio não configurados (aba Configuração)' }];
    const shopee = await syncShopeeConversions(30);
    const purchases = shopee.error ? null : await sendPendingPurchases();
    return { meta, shopee, purchases };
  });

  // POST /ads/rules/run — evaluate the monitoring rules right now
  fastify.post('/rules/run', async () => ({ results: await runAdRules() }));

  // ── Which campaigns appear on the page ─────────────────────────────────

  fastify.get('/campaigns-visibility', async () => {
    const [campaigns, row] = await Promise.all([
      prisma.metaEntity.findMany({ where: { level: 'CAMPAIGN' }, orderBy: { name: 'asc' }, select: { id: true, name: true, status: true, shown: true } }),
      prisma.setting.findUnique({ where: { key: 'ads_campaign_filter' } }),
    ]);
    const terms = (row?.value ?? '').split(',').map((t) => fold(t.trim())).filter(Boolean);
    return {
      filter: row?.value ?? '',
      campaigns: campaigns.map((c) => ({ ...c, visible: isCampaignShown(c, terms) })),
    };
  });

  // PUT { filter?: "shopee, trafego direto", shown?: { <campaignId>: true | false | null } }
  fastify.put<{ Body: { filter?: string; shown?: Record<string, boolean | null> } }>('/campaigns-visibility', async (request) => {
    const b = request.body ?? {};
    if (b.filter !== undefined) {
      const value = String(b.filter);
      await prisma.setting.upsert({ where: { key: 'ads_campaign_filter' }, update: { value }, create: { key: 'ads_campaign_filter', value } });
    }
    for (const [id, shown] of Object.entries(b.shown ?? {})) {
      await prisma.metaEntity.updateMany({ where: { id, level: 'CAMPAIGN' }, data: { shown: shown === null ? null : !!shown } });
    }
    return { ok: true };
  });

  // ── Overview: one level at a time, optionally inside a parent ────────────

  fastify.get<{ Querystring: { level?: string; parentId?: string; from?: string; to?: string } }>('/overview', async (request, reply) => {
    const level = (LEVELS as readonly string[]).includes(request.query.level ?? '') ? (request.query.level as (typeof LEVELS)[number]) : 'CAMPAIGN';
    const parentId = request.query.parentId;
    const today = accountToday(-3);
    const to = request.query.to || today;
    const from = request.query.from || shiftDate(to, -6);
    if (!brtDateStart(from) || !brtDateStart(to) || to < from) return reply.code(400).send({ message: 'Período inválido' });

    const parentFilter =
      !parentId ? {} : level === 'ADSET' ? { campaignId: parentId } : level === 'AD' ? { OR: [{ adsetId: parentId }, { campaignId: parentId }] } : {};
    const shownIds = await shownCampaignIds();
    const [allEntities, daily, rules, links] = await Promise.all([
      prisma.metaEntity.findMany({ where: { level, ...parentFilter }, orderBy: { name: 'asc' } }),
      prisma.metaAdDaily.findMany({ where: { date: { gte: from, lte: to } } }),
      prisma.metaRule.findMany(),
      prisma.adLink.findMany({ where: { metaAdId: { not: null } } }),
    ]);

    const entities = allEntities.filter((e) => shownIds.has(level === 'CAMPAIGN' ? e.id : e.campaignId ?? ''));

    // Sales: conversions whose sub-code belongs to an ad's link.
    const ads = await prisma.metaEntity.findMany({ where: { level: 'AD' }, select: { id: true, campaignId: true, adsetId: true } });
    const adParents = new Map(ads.map((a) => [a.id, a]));
    const codeToAd = new Map(links.map((l) => [l.code, l.metaAdId as string]));
    const start = brtDateStart(from)!;
    const end = new Date(brtDateStart(to)!.getTime() + DAY_MS);
    const conversions = codeToAd.size
      ? await prisma.shopeeConversion.findMany({ where: { subCode: { in: [...codeToAd.keys()] }, purchaseTime: { gte: start, lt: end } } })
      : [];
    // Real clicks: our short link inside each ad's final link.
    const shortCodes = new Map<string, string>(); // short code -> adId
    for (const l of links) {
      const m = /\/s\/([A-Za-z0-9]+)/.exec(l.finalLink);
      if (m) shortCodes.set(m[1], l.metaAdId as string);
    }
    const clicks = shortCodes.size
      ? await prisma.shortUrlClick.groupBy({ by: ['code'], where: { code: { in: [...shortCodes.keys()] }, kind: 'HUMAN', fromAd: true, createdAt: { gte: start, lt: end } }, _count: { _all: true } })
      : [];

    const keyOf = (adId: string, campaignId: string | null, adsetId: string | null) =>
      level === 'CAMPAIGN' ? campaignId : level === 'ADSET' ? adsetId : adId;

    type M = { spend: number; impressions: number; clicks: number; linkClicks: number; realClicks: number; orders: number; gmv: number; pending: number; confirmed: number; cancelled: number };
    const zero = (): M => ({ spend: 0, impressions: 0, clicks: 0, linkClicks: 0, realClicks: 0, orders: 0, gmv: 0, pending: 0, confirmed: 0, cancelled: 0 });
    const by = new Map<string, M>();
    const get = (k: string | null) => { if (!k) return null; if (!by.has(k)) by.set(k, zero()); return by.get(k)!; };

    for (const d of daily) {
      const m = get(keyOf(d.adId, d.campaignId, d.adsetId));
      if (!m) continue;
      m.spend += d.spend; m.impressions += d.impressions; m.clicks += d.clicks; m.linkClicks += d.linkClicks;
    }
    for (const c of conversions) {
      const adId = codeToAd.get(c.subCode ?? '');
      const p = adId ? adParents.get(adId) : undefined;
      const m = adId ? get(keyOf(adId, p?.campaignId ?? null, p?.adsetId ?? null)) : null;
      if (!m) continue;
      m.orders += c.orders; m.gmv += c.gmv; m.pending += c.commissionPending; m.confirmed += c.commissionConfirmed; m.cancelled += c.commissionCancelled;
    }
    for (const c of clicks) {
      const adId = shortCodes.get(c.code);
      const p = adId ? adParents.get(adId) : undefined;
      const m = adId ? get(keyOf(adId, p?.campaignId ?? null, p?.adsetId ?? null)) : null;
      if (m) m.realClicks += c._count._all;
    }

    const childCounts = new Map<string, number>();
    if (level !== 'AD') {
      const childLevel = level === 'CAMPAIGN' ? 'ADSET' : 'AD';
      const kids = await prisma.metaEntity.findMany({ where: { level: childLevel }, select: { campaignId: true, adsetId: true } });
      for (const k of kids) {
        const pid = level === 'CAMPAIGN' ? k.campaignId : k.adsetId;
        if (pid) childCounts.set(pid, (childCounts.get(pid) ?? 0) + 1);
      }
    }
    const ruleBy = new Map(rules.map((r) => [r.entityId, r]));
    const linkCountBy = new Map<string, number>();
    for (const l of links) linkCountBy.set(l.metaAdId as string, (linkCountBy.get(l.metaAdId as string) ?? 0) + 1);

    const shape = (m: M) => {
      const projected = m.pending + m.confirmed;
      return {
        spend: r2(m.spend), impressions: m.impressions, clicks: m.clicks, linkClicks: m.linkClicks, realClicks: m.realClicks,
        cpcLink: m.linkClicks ? r2(m.spend / m.linkClicks) : null,
        ctr: m.impressions ? r2((m.clicks / m.impressions) * 100) : null,
        orders: m.orders, gmv: r2(m.gmv),
        commissionPending: r2(m.pending), commissionConfirmed: r2(m.confirmed), commissionCancelled: r2(m.cancelled),
        profitProjected: r2(projected - m.spend), profitConfirmed: r2(m.confirmed - m.spend),
        roas: m.spend ? r2(projected / m.spend) : null,
        cpa: m.orders ? r2(m.spend / m.orders) : null,
      };
    };

    const rows = entities.map((e) => ({
      id: e.id, level: e.level, name: e.name, status: e.status, campaignId: e.campaignId, adsetId: e.adsetId,
      children: childCounts.get(e.id) ?? 0,
      links: level === 'AD' ? linkCountBy.get(e.id) ?? 0 : undefined,
      metrics: shape(by.get(e.id) ?? zero()),
      rule: ruleBy.get(e.id) ?? null,
    }));
    const totals = shape(rows.reduce((acc, r) => {
      const m = by.get(r.id);
      if (m) for (const k of Object.keys(acc) as (keyof M)[]) acc[k] += m[k];
      return acc;
    }, zero()));
    return { level, parentId: parentId ?? null, from, to, rows, totals };
  });

  // ── Rules ─────────────────────────────────────────────────────────────────

  fastify.put<{ Params: { entityId: string }; Body: Record<string, any> }>('/rules/:entityId', async (request, reply) => {
    const entity = await prisma.metaEntity.findUnique({ where: { id: request.params.entityId } });
    if (!entity) return reply.code(404).send({ message: 'Campanha/conjunto/anúncio não encontrado — sincronize com a Meta' });
    const b = request.body ?? {};
    const data = {
      ...(b.enabled !== undefined && { enabled: !!b.enabled }),
      ...(b.maxCpc !== undefined && { maxCpc: Math.max(0.01, Number(b.maxCpc) || 0.5) }),
      ...(b.days !== undefined && { days: Math.min(30, Math.max(1, Math.round(Number(b.days) || 2))) }),
      ...(b.mode !== undefined && { mode: b.mode === 'AVERAGE' ? 'AVERAGE' : 'CONSECUTIVE' }),
      ...(b.minSpend !== undefined && { minSpend: Math.max(0, Number(b.minSpend) || 0) }),
      ...(b.action !== undefined && { action: b.action === 'PAUSE' ? 'PAUSE' : 'NOTIFY' }),
    };
    return prisma.metaRule.upsert({
      where: { entityId: entity.id },
      update: data,
      create: { entityId: entity.id, level: entity.level, ...data },
    });
  });

  fastify.get('/actions', async () => prisma.metaRuleAction.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }));

  // ── Sales (every sub-ID, including groups / automatic search) ────────────

  fastify.get<{ Querystring: { from?: string; to?: string } }>('/sales', async (request, reply) => {
    const today = accountToday(-3);
    const to = request.query.to || today;
    const from = request.query.from || shiftDate(to, -6);
    const start = brtDateStart(from);
    const endStart = brtDateStart(to);
    if (!start || !endStart) return reply.code(400).send({ message: 'Período inválido' });
    const [conversions, links] = await Promise.all([
      prisma.shopeeConversion.findMany({ where: { purchaseTime: { gte: start, lt: new Date(endStart.getTime() + DAY_MS) } } }),
      prisma.adLink.findMany(),
    ]);
    const ads = await prisma.metaEntity.findMany({ where: { id: { in: links.map((l) => l.metaAdId).filter(Boolean) as string[] } } });
    const adName = new Map(ads.map((a) => [a.id, a.name]));
    const linkBy = new Map(links.map((l) => [l.code, l]));
    const groups = new Map<string, { subCode: string; label: string; source: string; orders: number; gmv: number; pending: number; confirmed: number; cancelled: number }>();
    for (const c of conversions) {
      const code = c.subCode ?? '';
      const link = linkBy.get(code);
      const label = link ? (link.label || (link.metaAdId ? adName.get(link.metaAdId) : null) || code) : code || '(sem sub-ID)';
      const source = link ? 'Anúncio' : code.startsWith('busca') ? 'Busca Shopee' : code ? 'Outro sub-ID' : 'Sem sub-ID';
      const g = groups.get(code) ?? { subCode: code, label, source, orders: 0, gmv: 0, pending: 0, confirmed: 0, cancelled: 0 };
      g.orders += c.orders; g.gmv += c.gmv; g.pending += c.commissionPending; g.confirmed += c.commissionConfirmed; g.cancelled += c.commissionCancelled;
      groups.set(code, g);
    }
    const rows = [...groups.values()].map((g) => ({ ...g, gmv: r2(g.gmv), pending: r2(g.pending), confirmed: r2(g.confirmed), cancelled: r2(g.cancelled) }))
      .sort((a, b) => b.pending + b.confirmed - (a.pending + a.confirmed));
    return { from, to, rows };
  });

  // GET /ads/sales/list — every sale in the period, one row each, with its sub-ID.
  fastify.get<{ Querystring: { from?: string; to?: string } }>('/sales/list', async (request, reply) => {
    const today = accountToday(-3);
    const to = request.query.to || today;
    const from = request.query.from || shiftDate(to, -6);
    const start = brtDateStart(from);
    const endStart = brtDateStart(to);
    if (!start || !endStart) return reply.code(400).send({ message: 'Período inválido' });
    const LIMIT = 2000;
    const [conversions, links] = await Promise.all([
      prisma.shopeeConversion.findMany({
        where: { purchaseTime: { gte: start, lt: new Date(endStart.getTime() + DAY_MS) } },
        orderBy: { purchaseTime: 'desc' },
        take: LIMIT + 1,
      }),
      prisma.adLink.findMany(),
    ]);
    const ads = await prisma.metaEntity.findMany({ where: { id: { in: links.map((l) => l.metaAdId).filter(Boolean) as string[] } } });
    const adName = new Map(ads.map((a) => [a.id, a.name]));
    const linkBy = new Map(links.map((l) => [l.code, l]));
    const rows = conversions.slice(0, LIMIT).map((c) => {
      const code = c.subCode ?? '';
      const link = linkBy.get(code);
      const raw = (c.raw ?? {}) as { orders?: Array<{ orderId?: unknown; items?: Array<{ itemName?: unknown; qty?: unknown }> }> };
      const orders = Array.isArray(raw.orders) ? raw.orders : [];
      const products = orders.flatMap((o) => (Array.isArray(o.items) ? o.items : []))
        .map((it) => (it.itemName ? `${Number(it.qty) > 1 ? `${it.qty}× ` : ''}${it.itemName}` : null))
        .filter(Boolean) as string[];
      return {
        id: c.id,
        purchaseTime: c.purchaseTime,
        clickTime: c.clickTime,
        utmContent: c.utmContent,
        subCode: code,
        source: link ? 'Anúncio' : code.startsWith('busca') ? 'Busca Shopee' : code ? 'Outro sub-ID' : 'Sem sub-ID',
        label: link ? link.label || (link.metaAdId ? adName.get(link.metaAdId) : null) || code : null,
        orderIds: orders.map((o) => String(o.orderId ?? '')).filter(Boolean),
        products,
        items: c.items,
        gmv: r2(c.gmv),
        pending: r2(c.commissionPending),
        confirmed: r2(c.commissionConfirmed),
        cancelled: r2(c.commissionCancelled),
        status: c.status,
        fraud: c.fraud,
        purchaseEvent: c.purchaseEventStatus ? { status: c.purchaseEventStatus, detail: c.purchaseEventDetail, at: c.purchaseEventAt } : null,
      };
    });
    return { from, to, truncated: conversions.length > LIMIT, rows };
  });

  // GET /ads/sales/raw — what Shopee actually returned for the latest sales
  // (to check fields such as clickTime before relying on them).
  fastify.get('/sales/raw', async () => {
    const rows = await prisma.shopeeConversion.findMany({ orderBy: { purchaseTime: 'desc' }, take: 8 });
    const last = await prisma.setting.findUnique({ where: { key: 'shopee_sales_last_sync' } });
    return {
      lastSync: last ? JSON.parse(last.value) : null,
      rows: rows.map((r) => {
        const raw = (r.raw ?? {}) as Record<string, unknown>;
        return {
          id: r.id,
          purchaseTime: r.purchaseTime,
          clickTime: r.clickTime,
          rawClickTime: raw.clickTime ?? null,
          utmContent: r.utmContent,
          status: r.status,
          fields: Object.keys(raw),
        };
      }),
    };
  });

  // ── Ad links ──────────────────────────────────────────────────────────────

  fastify.get('/links', async () => {
    const links = await prisma.adLink.findMany({ orderBy: { createdAt: 'desc' }, take: 300 });
    const ads = await prisma.metaEntity.findMany({ where: { id: { in: links.map((l) => l.metaAdId).filter(Boolean) as string[] } } });
    const names = new Map(ads.map((a) => [a.id, a.name]));
    return links.map((l) => ({ ...l, adName: l.metaAdId ? names.get(l.metaAdId) ?? null : null }));
  });

  fastify.post<{ Body: { productUrl?: string; metaAdId?: string | null; label?: string; viaOurLink?: boolean } }>('/links', async (request, reply) => {
    const productUrl = String(request.body?.productUrl ?? '').trim();
    if (!/^https?:\/\/[^\s]*shopee/i.test(productUrl)) return reply.code(400).send({ message: 'Cole o link de um produto da Shopee' });
    const code = newCode();
    let shopeeLink: string;
    try {
      shopeeLink = await generateShortLink(productUrl, [code]);
    } catch (err) {
      return reply.code(502).send({ message: `Shopee não gerou o link: ${err instanceof Error ? err.message : err}` });
    }
    const finalLink = request.body?.viaOurLink === false ? shopeeLink : (await createShortUrl(shopeeLink)).shortUrl;
    return prisma.adLink.create({
      data: { code, label: request.body?.label?.trim() || null, metaAdId: request.body?.metaAdId || null, productUrl, shopeeLink, finalLink },
    });
  });

  // GET /ads/links/:id/clicks — latest requests to that link (who opened it)
  fastify.get<{ Params: { id: string } }>('/links/:id/clicks', async (request, reply) => {
    const link = await prisma.adLink.findUnique({ where: { id: request.params.id } });
    const m = link ? /\/s\/([A-Za-z0-9]+)/.exec(link.finalLink) : null;
    if (!link || !m) return reply.code(404).send({ message: 'Link não encontrado ou sem o nosso encurtador' });
    const rows = await prisma.shortUrlClick.findMany({ where: { code: m[1] }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((r) => ({ at: r.createdAt, kind: r.kind, agent: r.agent, fromAd: r.fromAd, userAgent: r.userAgent }));
  });

  fastify.patch<{ Params: { id: string }; Body: { metaAdId?: string | null; label?: string } }>('/links/:id', async (request) =>
    prisma.adLink.update({
      where: { id: request.params.id },
      data: {
        ...(request.body?.metaAdId !== undefined && { metaAdId: request.body.metaAdId || null }),
        ...(request.body?.label !== undefined && { label: request.body.label || null }),
      },
    }),
  );

  // Ads to pick from when tying a link to an ad.
  fastify.get('/ads-list', async () => {
    const shownIds = await shownCampaignIds();
    const ads = (await prisma.metaEntity.findMany({ where: { level: 'AD' }, orderBy: { name: 'asc' } })).filter((a) => shownIds.has(a.campaignId ?? ''));
    const campaigns = await prisma.metaEntity.findMany({ where: { level: 'CAMPAIGN' } });
    const cname = new Map(campaigns.map((c) => [c.id, c.name]));
    return ads.map((a) => ({ id: a.id, name: a.name, status: a.status, campaign: a.campaignId ? cname.get(a.campaignId) ?? '' : '' }));
  });

  // Today in the first account's time zone (for the UI's default dates).
  fastify.get('/today', async () => {
    const cfg = await metaConfig();
    const offset = cfg?.accounts[0] ? await accountOffset(cfg.accounts[0]) : -3;
    return { today: accountToday(offset) };
  });
};
