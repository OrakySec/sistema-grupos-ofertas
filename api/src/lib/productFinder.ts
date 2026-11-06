/**
 * Product finder for direct traffic (Tráfego pago → Produtos para anúncio).
 *
 *   runFinderScan    — searches the whole Shopee catalog (best sellers, top
 *                      performing, and a varied list of broad terms), saves
 *                      each product and one sales reading per day
 *   finderProducts   — the catalog filtered and ranked, with the day-1 math
 *   testedProducts   — products already run as ads (AdLinks): real spend,
 *                      clicks and same-day sales, so the assumptions are learnt
 *
 * Shopee only reports a product's total "sales"; sales per day come from two
 * readings about a day apart, so the column fills in after the second day.
 *
 * Day-1 math (Meta charges 12.15% tax on the invoice → ad cost × 1/(1−0.1215)):
 *   earned per click  = commission × (1 − revenue tax) × same-day conversion
 *   max CPC (break-even on day 1) = earned per click ÷ tax factor
 */
import prisma from './prisma';
import { shopeeGraphql, parseProductNode, ShopeeApiError } from './shopeeApi';
import { unknownField, dropField } from './shopeeConversions';
import { upsertProduct } from './shopeeHunter';
import { parseTerms } from './hunterRules';
import { taxConfig, cookieDay } from './salesAnalysis';
import { toBrt } from './time';

const DAY_MS = 86400000;
const r2 = (v: number) => Math.round(v * 100) / 100;
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const SCAN_EVERY_MS = 6 * 3600000;
const STATE_KEY = 'finder_scan_state';
const settingsKey = (tenantId: string) => `finder_settings:${tenantId}`;
const MAX_CALLS = 90;
const PAGE_SIZE = 50;
const CALL_GAP_MS = 350;

/** Varied on purpose — the finder is not tied to a niche. */
export const DEFAULT_TERMS = [
  'casa', 'cozinha', 'organizador', 'limpeza', 'banheiro', 'decoração', 'luminária led', 'ferramentas',
  'carro', 'acessórios celular', 'fone bluetooth', 'beleza', 'maquiagem', 'skincare', 'cabelo',
  'moda feminina', 'moda masculina', 'bolsa', 'relógio', 'infantil', 'brinquedo', 'bebê', 'pet',
  'fitness', 'papelaria', 'jardim', 'viagem', 'presente', 'utilidades', 'gadgets',
];

export interface FinderSettings {
  terms: string[];
  cpc: number; // R$ per link click, before Meta's tax
  cvrPct: number; // same-day sales per 100 link clicks
  filters: FinderFilters;
}

export interface FinderFilters {
  minPrice: number | null;
  maxPrice: number | null;
  minCommission: number | null; // R$
  maxCommission: number | null;
  minRating: number;
  minSales: number;
  minSalesPerDay: number;
  exclude: string; // comma-separated words
  officialOnly: boolean;
  onlyProfitable: boolean;
  q: string;
  sort: 'salesPerDay' | 'sales' | 'commission' | 'profit' | 'trend';
}

export const DEFAULT_FILTERS: FinderFilters = {
  minPrice: 20,
  maxPrice: 30,
  minCommission: 2,
  maxCommission: 5,
  minRating: 4.5,
  minSales: 100,
  minSalesPerDay: 0,
  exclude: 'filamento',
  officialOnly: false,
  onlyProfitable: false,
  q: '',
  sort: 'salesPerDay',
};

export const DEFAULT_SETTINGS: FinderSettings = { terms: DEFAULT_TERMS, cpc: 0.15, cvrPct: 3, filters: DEFAULT_FILTERS };

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Sales per day from the daily readings: the latest reading against the
 * oldest one up to ~8 days back (at least 20 h apart). Trend = the last
 * ~1–2 days against that week rate. A falling total (Shopee recount) → null.
 */
export function salesRate(snaps: Array<{ at: Date; sales: number }>): { perDay: number | null; trend: number | null } {
  const s = [...snaps].sort((a, b) => a.at.getTime() - b.at.getTime());
  const last = s[s.length - 1];
  if (!last) return { perDay: null, trend: null };
  const gap = (x: { at: Date }) => last.at.getTime() - x.at.getTime();
  const MIN_GAP = 20 * 3600000;
  const old = s.find((x) => gap(x) >= MIN_GAP && gap(x) <= 8.5 * DAY_MS);
  if (!old) return { perDay: null, trend: null };
  const rate = (x: { at: Date; sales: number }) => (last.sales - x.sales) / (gap(x) / DAY_MS);
  const perDay = rate(old);
  if (perDay < 0) return { perDay: null, trend: null };
  const recent = [...s].reverse().find((x) => gap(x) >= MIN_GAP)!;
  const trend = recent !== old && gap(old) >= 2.5 * DAY_MS && perDay > 0 ? rate(recent) / perDay : null;
  return { perDay: Math.round(perDay * 10) / 10, trend: trend === null || trend < 0 ? null : Math.round(trend * 100) / 100 };
}

/** R$ earned per sale: the rate on the current price; Shopee's own value when there is no rate. */
export function commissionOf(p: { lastPrice: number; commissionPct: number | null; commissionValue: number | null }): number | null {
  if (p.commissionPct !== null && p.commissionPct > 0) return r2((p.lastPrice * p.commissionPct) / 100);
  return p.commissionValue !== null ? r2(p.commissionValue) : null;
}

export interface Assumptions {
  cpc: number;
  cvrPct: number;
  metaTaxPct: number;
  revenueTaxPct: number;
}

export const taxFactorOf = (metaTaxPct: number) => (metaTaxPct > 0 && metaTaxPct < 100 ? 1 / (1 - metaTaxPct / 100) : 1);

/** Day-1 numbers of one product under the assumptions. */
export function dayOne(commission: number, a: Assumptions) {
  const factor = taxFactorOf(a.metaTaxPct);
  const net = commission * (1 - a.revenueTaxPct / 100);
  const perClick = (net * a.cvrPct) / 100;
  const maxCpc = perClick / factor;
  // R$100 of ad budget: costs 100 × factor, buys 100 / CPC clicks.
  const profitPer100 = a.cpc > 0 ? (100 / a.cpc) * perClick - 100 * factor : null;
  return { maxCpc: Math.round(maxCpc * 1000) / 1000, profitPer100: profitPer100 === null ? null : r2(profitPer100) };
}

/** The smallest commission that pays for itself on day 1 under the assumptions. */
export function breakEvenCommission(a: Assumptions): number | null {
  if (a.cvrPct <= 0 || a.revenueTaxPct >= 100) return null;
  return r2((a.cpc * taxFactorOf(a.metaTaxPct)) / (a.cvrPct / 100) / (1 - a.revenueTaxPct / 100));
}

/** Shopee item id from a product URL (…-i.<shop>.<item>, /product/<shop>/<item>). */
export function itemIdOfUrl(url: string): string | null {
  const m = /-i\.(\d+)\.(\d+)/.exec(url) ?? /\/product\/(\d+)\/(\d+)/.exec(url) ?? /[?&]itemId=(\d+)/.exec(url);
  if (!m) return null;
  return m.length > 2 ? m[2] : m[1];
}

function num(v: unknown, fallback: number | null): number | null {
  if (v === null || v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

/** Fills missing/invalid filter fields with the defaults (query strings and saved JSON alike). */
export function cleanFilters(raw: Record<string, unknown> | null | undefined, base: FinderFilters = DEFAULT_FILTERS): FinderFilters {
  const r = raw ?? {};
  const bool = (v: unknown, d: boolean) => (v === undefined ? d : v === true || v === 'true' || v === '1');
  const optional = (k: keyof FinderFilters) => (k in r ? num(r[k], null) : (base[k] as number | null));
  const sorts = ['salesPerDay', 'sales', 'commission', 'profit', 'trend'];
  return {
    minPrice: optional('minPrice'),
    maxPrice: optional('maxPrice'),
    minCommission: optional('minCommission'),
    maxCommission: optional('maxCommission'),
    minRating: num(r.minRating, base.minRating) ?? 0,
    minSales: num(r.minSales, base.minSales) ?? 0,
    minSalesPerDay: num(r.minSalesPerDay, base.minSalesPerDay) ?? 0,
    exclude: r.exclude !== undefined ? String(r.exclude).slice(0, 500) : base.exclude,
    officialOnly: bool(r.officialOnly, base.officialOnly),
    onlyProfitable: bool(r.onlyProfitable, base.onlyProfitable),
    q: r.q !== undefined ? String(r.q).slice(0, 100) : base.q,
    sort: (sorts.includes(String(r.sort)) ? r.sort : base.sort) as FinderFilters['sort'],
  };
}

export interface CatalogProduct {
  id: string;
  itemId: bigint;
  shopId: bigint;
  name: string;
  imageUrl: string | null;
  productLink: string | null;
  shopName: string | null;
  isOfficial: boolean;
  ratingStar: number | null;
  sales: number | null;
  commissionPct: number | null;
  commissionValue: number | null;
  lastPrice: number;
  salesPerDay: number | null;
  salesTrend: number | null;
  lastSeenAt: Date;
}

export interface FinderRow {
  id: string;
  itemId: string;
  shopId: string;
  name: string;
  imageUrl: string | null;
  link: string;
  shopName: string | null;
  isOfficial: boolean;
  rating: number | null;
  price: number;
  commission: number;
  commissionPct: number | null;
  sales: number | null;
  salesPerDay: number | null;
  trend: number | null;
  maxCpc: number;
  profitPer100: number | null;
  tested: boolean;
  seenAt: Date;
}

/** Filters and ranks the catalog (pure — the DB query only narrows by price/rating/sales). */
export function rankProducts(products: CatalogProduct[], f: FinderFilters, a: Assumptions, tested: Set<string>) {
  const excluded = parseTerms(f.exclude).map(fold);
  const q = fold(f.q.trim());
  const rows: FinderRow[] = [];
  for (const p of products) {
    const name = fold(p.name);
    if (excluded.some((w) => name.includes(w))) continue;
    if (q && !name.includes(q)) continue;
    if (f.minPrice !== null && p.lastPrice < f.minPrice) continue;
    if (f.maxPrice !== null && p.lastPrice > f.maxPrice) continue;
    if (f.minRating > 0 && (p.ratingStar ?? 0) < f.minRating) continue;
    if (f.minSales > 0 && (p.sales ?? 0) < f.minSales) continue;
    if (f.minSalesPerDay > 0 && (p.salesPerDay ?? -1) < f.minSalesPerDay) continue;
    if (f.officialOnly && !p.isOfficial) continue;
    const commission = commissionOf(p);
    if (commission === null) continue;
    if (f.minCommission !== null && commission < f.minCommission) continue;
    if (f.maxCommission !== null && commission > f.maxCommission) continue;
    const d1 = dayOne(commission, a);
    if (f.onlyProfitable && !((d1.profitPer100 ?? -1) > 0)) continue;
    rows.push({
      id: p.id,
      itemId: String(p.itemId),
      shopId: String(p.shopId),
      name: p.name,
      imageUrl: p.imageUrl,
      link: p.productLink || `https://shopee.com.br/product/${p.shopId}/${p.itemId}`,
      shopName: p.shopName,
      isOfficial: p.isOfficial,
      rating: p.ratingStar,
      price: p.lastPrice,
      commission,
      commissionPct: p.commissionPct,
      sales: p.sales,
      salesPerDay: p.salesPerDay,
      trend: p.salesTrend,
      maxCpc: d1.maxCpc,
      profitPer100: d1.profitPer100,
      tested: tested.has(String(p.itemId)),
      seenAt: p.lastSeenAt,
    });
  }
  const nullLast = (v: number | null | undefined) => (v === null || v === undefined ? -Infinity : v);
  const key: Record<FinderFilters['sort'], (r: (typeof rows)[number]) => number> = {
    salesPerDay: (r) => nullLast(r.salesPerDay),
    sales: (r) => nullLast(r.sales),
    commission: (r) => r.commission,
    profit: (r) => nullLast(r.profitPer100),
    trend: (r) => nullLast(r.trend),
  };
  // Ties (e.g. no sales per day yet) fall back to the total sold.
  rows.sort((x, y) => key[f.sort](y) - key[f.sort](x) || nullLast(y.sales) - nullLast(x.sales));
  return rows;
}

// ── Settings ────────────────────────────────────────────────────────────────

export async function finderSettings(tenantId: string): Promise<FinderSettings> {
  const row = await prisma.setting.findUnique({ where: { key: settingsKey(tenantId) } });
  let saved: any = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { saved = {}; }
  const terms = Array.isArray(saved.terms) ? saved.terms.map(String).filter(Boolean) : DEFAULT_TERMS;
  return {
    terms,
    cpc: num(saved.cpc, DEFAULT_SETTINGS.cpc)!,
    cvrPct: num(saved.cvrPct, DEFAULT_SETTINGS.cvrPct)!,
    filters: cleanFilters(saved.filters ?? {}),
  };
}

export async function saveFinderSettings(tenantId: string, patch: { terms?: string | string[]; cpc?: unknown; cvrPct?: unknown; filters?: Record<string, unknown> }) {
  const cur = await finderSettings(tenantId);
  const terms = patch.terms === undefined ? cur.terms : (Array.isArray(patch.terms) ? patch.terms : parseTerms(patch.terms)).map((t) => String(t).trim().slice(0, 60)).filter(Boolean).slice(0, 60);
  const cpc = num(patch.cpc, cur.cpc)!;
  const cvrPct = num(patch.cvrPct, cur.cvrPct)!;
  if (!(cpc > 0 && cpc < 50)) throw new Error('CPC inválido');
  if (!(cvrPct > 0 && cvrPct <= 100)) throw new Error('Conversão inválida (use de 0,1 a 100%)');
  const next: FinderSettings = { terms, cpc, cvrPct, filters: patch.filters ? cleanFilters(patch.filters, cur.filters) : cur.filters };
  const value = JSON.stringify(next);
  await prisma.setting.upsert({ where: { key: settingsKey(tenantId) }, update: { value }, create: { key: settingsKey(tenantId), value } });
  return next;
}

// ── Scan ────────────────────────────────────────────────────────────────────

export interface ScanState {
  at?: string; // last finished scan
  startedAt?: string;
  running?: boolean;
  calls?: number;
  found?: number;
  saved?: number;
  fields?: string;
  errors?: string[];
}

export async function scanState(): Promise<ScanState> {
  const row = await prisma.setting.findUnique({ where: { key: STATE_KEY } });
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}

async function saveState(s: ScanState) {
  const value = JSON.stringify(s);
  await prisma.setting.upsert({ where: { key: STATE_KEY }, update: { value }, create: { key: STATE_KEY, value } });
}

export async function markScanQueued() {
  const s = await scanState();
  await saveState({ ...s, running: true, startedAt: new Date().toISOString() });
}

const FIELDS = `itemId shopId productName imageUrl productLink offerLink shopName shopType
  priceMin priceMax priceDiscountRate ratingStar sales commissionRate commission productCatIds`;

function buildQuery(fields: string, vars: Record<string, unknown>) {
  const types: Record<string, string> = { keyword: 'String', sortType: 'Int', page: 'Int', limit: 'Int', listType: 'Int' };
  const keys = Object.keys(vars).filter((k) => types[k]);
  return `query Finder(${keys.map((k) => `$${k}: ${types[k]}`).join(', ')}) {
  productOfferV2(${keys.map((k) => `${k}: $${k}`).join(', ')}) {
    nodes { ${fields} }
    pageInfo { page limit hasNextPage }
  }
}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every tenant's search terms (the catalog is shared). */
async function allTerms(): Promise<string[]> {
  const rows = await prisma.setting.findMany({ where: { key: { startsWith: 'finder_settings:' } } });
  const terms = new Set<string>();
  for (const r of rows) {
    try { for (const t of JSON.parse(r.value).terms ?? []) terms.add(String(t)); } catch { /* ignore */ }
  }
  if (rows.length === 0) DEFAULT_TERMS.forEach((t) => terms.add(t));
  return [...terms];
}

export async function runFinderScan(): Promise<ScanState> {
  const started = new Date();
  const plan: Array<{ label: string; vars: Record<string, unknown>; pages: number }> = [
    { label: 'mais vendidos', vars: { sortType: 2 }, pages: 4 },
    { label: 'em alta', vars: { listType: 2, sortType: 2 }, pages: 2 },
    ...(await allTerms()).map((t) => ({ label: t, vars: { keyword: t, sortType: 2 }, pages: 2 })),
  ];
  let fields = FIELDS;
  let drops = 0;
  let calls = 0;
  let found = 0;
  const savedIds = new Set<string>();
  const errors: string[] = [];
  await saveState({ ...(await scanState()), running: true, startedAt: started.toISOString() });

  outer: for (const step of plan) {
    for (let page = 1; page <= step.pages; page++) {
      if (calls >= MAX_CALLS) break outer;
      if (calls > 0) await sleep(CALL_GAP_MS);
      calls++;
      let nodes: any[] = [];
      let hasNext = false;
      try {
        const data = await shopeeGraphql<any>(buildQuery(fields, { ...step.vars, page, limit: PAGE_SIZE }), { ...step.vars, page, limit: PAGE_SIZE });
        nodes = data?.productOfferV2?.nodes ?? [];
        hasNext = !!data?.productOfferV2?.pageInfo?.hasNextPage;
      } catch (err) {
        const bad = unknownField(err);
        if (bad && drops < 5 && fields.includes(bad)) {
          fields = dropField(fields, bad); // this account doesn't have that field — ask without it
          drops++;
          page--;
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        // Credentials / signature problems fail every call — stop right away.
        if (err instanceof ShopeeApiError && (calls === 1 || /credential|signature|auth|não configurados/i.test(msg))) {
          errors.push(msg);
          break outer;
        }
        if (errors.length < 8) errors.push(`${step.label}: ${msg}`);
        break; // next step
      }
      found += nodes.length;
      for (const n of nodes) {
        const p = parseProductNode(n);
        if (!p || !p.name) continue;
        try {
          const row = await upsertProduct(p, { finderSeenAt: new Date() });
          savedIds.add(row.id);
        } catch (err) {
          if (errors.length < 8) errors.push(`salvar produto: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (!hasNext) break;
    }
  }

  await refreshSalesRates();
  // Readings older than 35 days are no longer used.
  await prisma.shopeeSalesSnapshot.deleteMany({ where: { at: { lt: new Date(Date.now() - 35 * DAY_MS) } } });

  const dropped = FIELDS.split(/\s+/).filter((f) => f && !fields.split(/\s+/).includes(f));
  const state: ScanState = {
    at: new Date().toISOString(),
    startedAt: started.toISOString(),
    running: false,
    calls,
    found,
    saved: savedIds.size,
    fields: dropped.length ? `sem ${dropped.join(', ')}` : undefined,
    errors,
  };
  await saveState(state);
  return state;
}

/** Recomputes sales/day and trend for every product read in the last 9 days. */
export async function refreshSalesRates() {
  const snaps = await prisma.shopeeSalesSnapshot.findMany({
    where: { at: { gte: new Date(Date.now() - 9 * DAY_MS) } },
    select: { productId: true, at: true, sales: true },
  });
  const by = new Map<string, Array<{ at: Date; sales: number }>>();
  for (const s of snaps) {
    const list = by.get(s.productId) ?? [];
    list.push(s);
    by.set(s.productId, list);
  }
  const updates = [...by.entries()].map(([id, list]) => {
    const r = salesRate(list);
    return prisma.shopeeProduct.update({ where: { id }, data: { salesPerDay: r.perDay, salesTrend: r.trend } });
  });
  for (let i = 0; i < updates.length; i += 200) await prisma.$transaction(updates.slice(i, i + 200));
  return by.size;
}

/** Worker entry point: scans when the last one is older than SCAN_EVERY_MS. */
export async function finderTick(force = false): Promise<ScanState | null> {
  const creds = await prisma.setting.count({ where: { key: { in: ['shopee_app_id', 'shopee_app_secret'] }, value: { not: '' } } });
  if (creds < 2) return null;
  const s = await scanState();
  const last = s.at ? Date.parse(s.at) : 0;
  if (!force && Date.now() - last < SCAN_EVERY_MS) return null;
  try {
    return await runFinderScan();
  } catch (err) {
    await saveState({ ...(await scanState()), running: false, errors: [err instanceof Error ? err.message : String(err)] });
    throw err;
  }
}

// ── Real numbers (learnt from the ads already run) ──────────────────────────

const brtToday = () => toBrt(new Date()).toISOString().slice(0, 10);
const shiftDay = (ymd: string, n: number) => new Date(Date.parse(ymd + 'T12:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Products already run as ads, grouped by Shopee item: spend and link clicks
 * of the ads tied to their links, and the sales those links brought —
 * split into same-day (day 1) and the rest of the 7-day cookie.
 */
export async function testedProducts(days = 30) {
  const [links, taxes] = await Promise.all([prisma.adLink.findMany(), taxConfig()]);
  const factor = taxFactorOf(taxes.metaTaxPct);
  const net = (v: number) => v * (1 - taxes.revenueTaxPct / 100);
  const since = shiftDay(brtToday(), -(days - 1));
  const sinceDate = new Date(Date.now() - days * DAY_MS);
  const codes = links.map((l) => l.code);
  const adIds = [...new Set(links.map((l) => l.metaAdId).filter(Boolean) as string[])];
  const [items, daily, allDaily] = await Promise.all([
    codes.length ? prisma.shopeeOrderItem.findMany({ where: { subCode: { in: codes }, purchaseTime: { gte: sinceDate } } }) : [],
    adIds.length ? prisma.metaAdDaily.findMany({ where: { adId: { in: adIds }, date: { gte: since } } }) : [],
    prisma.metaAdDaily.findMany({ where: { date: { gte: since } }, select: { spend: true, linkClicks: true } }),
  ]);

  // Which item each link sells: from its URL, else the item its direct sales were of.
  const directItem = new Map<string, Map<string, number>>();
  for (const it of items) {
    if (it.attribution !== 'DIRECT' || !it.itemId || !it.subCode) continue;
    const m = directItem.get(it.subCode) ?? new Map<string, number>();
    m.set(it.itemId, (m.get(it.itemId) ?? 0) + 1);
    directItem.set(it.subCode, m);
  }
  const itemOfLink = new Map<string, string>();
  for (const l of links) {
    const fromUrl = itemIdOfUrl(l.productUrl);
    const fromSales = [...(directItem.get(l.code)?.entries() ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0];
    itemOfLink.set(l.code, fromUrl ?? fromSales ?? `link:${l.code}`);
  }

  type G = { key: string; label: string | null; codes: Set<string>; adIds: Set<string>; firstAt: Date; spend: number; clicks: number; orders: Set<string>; day1Orders: Set<string>; commission: number; day1Commission: number; itemName: string | null; imageUrl: string | null };
  const groups = new Map<string, G>();
  for (const l of links) {
    const key = itemOfLink.get(l.code)!;
    const g = groups.get(key) ?? { key, label: l.label, codes: new Set(), adIds: new Set(), firstAt: l.createdAt, spend: 0, clicks: 0, orders: new Set(), day1Orders: new Set(), commission: 0, day1Commission: 0, itemName: null, imageUrl: null };
    g.codes.add(l.code);
    if (l.metaAdId) g.adIds.add(l.metaAdId);
    if (l.createdAt < g.firstAt) g.firstAt = l.createdAt;
    groups.set(key, g);
  }
  const groupOfCode = new Map<string, G>();
  for (const g of groups.values()) for (const c of g.codes) groupOfCode.set(c, g);
  const groupOfAd = new Map<string, G>();
  for (const g of groups.values()) for (const a of g.adIds) groupOfAd.set(a, g);
  for (const d of daily) {
    const g = groupOfAd.get(d.adId);
    if (!g) continue;
    g.spend += d.spend;
    g.clicks += d.linkClicks;
  }
  for (const it of items) {
    const g = it.subCode ? groupOfCode.get(it.subCode) : undefined;
    if (!g || it.orderStatus === 'CANCELLED' || it.fraud) continue;
    if (!g.itemName && it.attribution === 'DIRECT' && it.itemId === g.key) { g.itemName = it.itemName; g.imageUrl = it.imageUrl; }
    g.orders.add(it.orderId);
    g.commission += it.commission;
    if (cookieDay(it.clickTime, it.purchaseTime) === 0) {
      g.day1Orders.add(it.orderId);
      g.day1Commission += it.commission;
    }
  }

  const itemIds = [...groups.keys()].filter((k) => /^\d+$/.test(k)).map((k) => BigInt(k));
  const products = itemIds.length ? await prisma.shopeeProduct.findMany({ where: { itemId: { in: itemIds } } }) : [];
  const productBy = new Map(products.map((p) => [String(p.itemId), p]));

  const rows = [...groups.values()].map((g) => {
    const p = productBy.get(g.key);
    const cost = g.spend * factor;
    return {
      itemId: /^\d+$/.test(g.key) ? g.key : null,
      name: p?.name ?? g.itemName ?? g.label ?? 'Produto do link',
      imageUrl: p?.imageUrl ?? g.imageUrl,
      price: p?.lastPrice ?? null,
      commissionNow: p ? commissionOf(p) : null,
      links: g.codes.size,
      ads: g.adIds.size,
      since: g.firstAt,
      spend: r2(g.spend),
      cost: r2(cost),
      clicks: g.clicks,
      cpc: g.clicks > 0 ? Math.round((g.spend / g.clicks) * 1000) / 1000 : null,
      orders: g.orders.size,
      day1Orders: g.day1Orders.size,
      commission: r2(g.commission),
      day1Commission: r2(g.day1Commission),
      day1CvrPct: g.clicks > 0 ? Math.round((g.day1Orders.size / g.clicks) * 10000) / 100 : null,
      day1Profit: r2(net(g.day1Commission) - cost),
      profit: r2(net(g.commission) - cost),
    };
  });
  rows.sort((a, b) => b.spend - a.spend || b.commission - a.commission);

  // Account-wide numbers to start the assumptions from.
  const tot = rows.reduce((t, r) => ({ spend: t.spend + r.spend, clicks: t.clicks + r.clicks, day1Orders: t.day1Orders + r.day1Orders, day1Commission: t.day1Commission + r.day1Commission }), { spend: 0, clicks: 0, day1Orders: 0, day1Commission: 0 });
  const account = allDaily.reduce((t, d) => ({ spend: t.spend + d.spend, clicks: t.clicks + d.linkClicks }), { spend: 0, clicks: 0 });
  const real = {
    days,
    cpc: account.clicks >= 30 ? Math.round((account.spend / account.clicks) * 1000) / 1000 : null,
    cpcClicks: account.clicks,
    cvrPct: tot.clicks >= 100 ? Math.round((tot.day1Orders / tot.clicks) * 10000) / 100 : null,
    cvrClicks: tot.clicks,
    day1Orders: tot.day1Orders,
    // R$ of same-day commission per link click — what one click is really worth on day 1.
    day1PerClick: tot.clicks >= 100 ? Math.round((tot.day1Commission / tot.clicks) * 1000) / 1000 : null,
  };
  return { rows, real };
}

// ── Listing ─────────────────────────────────────────────────────────────────

export async function finderProducts(tenantId: string, query: Record<string, unknown>, limit = 100) {
  const settings = await finderSettings(tenantId);
  const f = cleanFilters(query, settings.filters);
  const taxes = await taxConfig();
  const a: Assumptions = {
    cpc: num(query.cpc, settings.cpc)!,
    cvrPct: num(query.cvrPct, settings.cvrPct)!,
    metaTaxPct: taxes.metaTaxPct,
    revenueTaxPct: taxes.revenueTaxPct,
  };
  const fresh = new Date(Date.now() - 4 * DAY_MS);
  const products = await prisma.shopeeProduct.findMany({
    where: {
      lastSeenAt: { gte: fresh },
      ...(f.minPrice !== null || f.maxPrice !== null ? { lastPrice: { ...(f.minPrice !== null && { gte: f.minPrice }), ...(f.maxPrice !== null && { lte: f.maxPrice }) } } : {}),
      ...(f.minRating > 0 && { ratingStar: { gte: f.minRating } }),
      ...(f.minSales > 0 && { sales: { gte: f.minSales } }),
      ...(f.officialOnly && { isOfficial: true }),
    },
    orderBy: { sales: 'desc' },
    take: 5000,
  });
  const links = await prisma.adLink.findMany({ select: { productUrl: true } });
  const tested = new Set(links.map((l) => itemIdOfUrl(l.productUrl)).filter(Boolean) as string[]);
  const ranked = rankProducts(products, f, a, tested);
  const [catalog, withRate, state] = await Promise.all([
    prisma.shopeeProduct.count({ where: { lastSeenAt: { gte: fresh } } }),
    prisma.shopeeProduct.count({ where: { lastSeenAt: { gte: fresh }, salesPerDay: { not: null } } }),
    scanState(),
  ]);
  return {
    filters: f,
    assumptions: a,
    breakEvenCommission: breakEvenCommission(a),
    total: ranked.length,
    items: ranked.slice(0, limit),
    catalog,
    withRate,
    scan: state,
  };
}
