/**
 * Product finder for direct traffic (Tráfego pago → Produtos para anúncio).
 *
 *   runFinderScan    — sweeps Shopee: the general best-seller / highest-
 *                      commission lists, then category after category (the
 *                      categories come from the products themselves, least
 *                      recently scanned first); saves each product and one
 *                      sales reading per day
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
const MAX_CALLS = 1500;
const MAX_SCAN_MS = 50 * 60000;
const PAGE_SIZE = 50;
const CALL_GAP_MS = 300;
const GENERAL_PAGES = 10; // pages of the general lists (best sellers, highest commission…)
const CATEGORY_PAGES = 2; // pages per category, per order (most sold / highest commission)

/** Only used when the account doesn't send product categories (or rejects the category filter). */
const FALLBACK_TERMS = [
  'casa', 'cozinha', 'organizador', 'limpeza', 'banheiro', 'decoração', 'luminária led', 'ferramentas', 'jardim',
  'acessórios celular', 'fone bluetooth', 'carregador', 'smartwatch', 'carro', 'moto', 'beleza', 'maquiagem', 'skincare',
  'cabelo', 'perfume', 'moda feminina', 'moda masculina', 'tênis', 'bolsa', 'relógio', 'infantil', 'brinquedo', 'bebê',
  'pet', 'fitness', 'papelaria', 'camping', 'viagem', 'festa', 'presente', 'utilidades',
];

export interface FinderSettings {
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

export const DEFAULT_SETTINGS: FinderSettings = { cpc: 0.15, cvrPct: 3, filters: DEFAULT_FILTERS };

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
  favoriteId: string | null;
  seenAt: Date;
}

/** Filters and ranks the catalog (pure — the DB query only narrows by price/rating/sales). */
/** Why products were left out, in the order the filters run (the first one that cuts counts). */
export type DropReason = 'excluded' | 'name' | 'price' | 'rating' | 'sales' | 'salesPerDay' | 'official' | 'noCommission' | 'commissionLow' | 'commissionHigh' | 'notProfitable';

export function rankProducts(products: CatalogProduct[], f: FinderFilters, a: Assumptions, tested: Set<string>) {
  const excluded = parseTerms(f.exclude).map(fold);
  const q = fold(f.q.trim());
  const rows: FinderRow[] = [];
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (r: DropReason) => { dropped[r] = (dropped[r] ?? 0) + 1; };
  for (const p of products) {
    const name = fold(p.name);
    if (excluded.some((w) => name.includes(w))) { drop('excluded'); continue; }
    if (q && !name.includes(q)) { drop('name'); continue; }
    if ((f.minPrice !== null && p.lastPrice < f.minPrice) || (f.maxPrice !== null && p.lastPrice > f.maxPrice)) { drop('price'); continue; }
    if (f.minRating > 0 && (p.ratingStar ?? 0) < f.minRating) { drop('rating'); continue; }
    if (f.minSales > 0 && (p.sales ?? 0) < f.minSales) { drop('sales'); continue; }
    if (f.minSalesPerDay > 0 && (p.salesPerDay ?? -1) < f.minSalesPerDay) { drop('salesPerDay'); continue; }
    if (f.officialOnly && !p.isOfficial) { drop('official'); continue; }
    const commission = commissionOf(p);
    if (commission === null) { drop('noCommission'); continue; }
    if (f.minCommission !== null && commission < f.minCommission) { drop('commissionLow'); continue; }
    if (f.maxCommission !== null && commission > f.maxCommission) { drop('commissionHigh'); continue; }
    const d1 = dayOne(commission, a);
    if (f.onlyProfitable && !((d1.profitPer100 ?? -1) > 0)) { drop('notProfitable'); continue; }
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
      favoriteId: null,
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
  return { rows, dropped };
}

// ── Settings ────────────────────────────────────────────────────────────────

export async function finderSettings(tenantId: string): Promise<FinderSettings> {
  const row = await prisma.setting.findUnique({ where: { key: settingsKey(tenantId) } });
  let saved: any = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { saved = {}; }
  return {
    cpc: num(saved.cpc, DEFAULT_SETTINGS.cpc)!,
    cvrPct: num(saved.cvrPct, DEFAULT_SETTINGS.cvrPct)!,
    filters: cleanFilters(saved.filters ?? {}),
  };
}

export async function saveFinderSettings(tenantId: string, patch: { cpc?: unknown; cvrPct?: unknown; filters?: Record<string, unknown> }) {
  const cur = await finderSettings(tenantId);
  const cpc = num(patch.cpc, cur.cpc)!;
  const cvrPct = num(patch.cvrPct, cur.cvrPct)!;
  if (!(cpc > 0 && cpc < 50)) throw new Error('CPC inválido');
  if (!(cvrPct > 0 && cvrPct <= 100)) throw new Error('Conversão inválida (use de 0,1 a 100%)');
  const next: FinderSettings = { cpc, cvrPct, filters: patch.filters ? cleanFilters(patch.filters, cur.filters) : cur.filters };
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
  errors?: string[]; // the scan stopped (credentials, network…)
  warnings?: string[]; // single searches that failed — the rest went on
  categories?: number; // categories known so far
  categoriesScanned?: number; // swept in this scan
  categoriesLeft?: number; // never swept yet
  mode?: 'categories' | 'terms'; // terms = fallback when the account has no categories
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
  const types: Record<string, string> = { keyword: 'String', sortType: 'Int', page: 'Int', limit: 'Int', listType: 'Int', productCatId: 'Int' };
  const keys = Object.keys(vars).filter((k) => types[k]);
  return `query Finder(${keys.map((k) => `$${k}: ${types[k]}`).join(', ')}) {
  productOfferV2(${keys.map((k) => `${k}: $${k}`).join(', ')}) {
    nodes { ${fields} }
    pageInfo { page limit hasNextPage }
  }
}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Step = { label: string; vars: Record<string, unknown>; pages: number };

export async function runFinderScan(): Promise<ScanState> {
  const started = Date.now();
  let fields = FIELDS;
  let drops = 0;
  let calls = 0;
  let found = 0;
  let steps = 0;
  let failedSteps = 0;
  let rateLimitStreak = 0;
  let stopped = false;
  const seen = new Set<string>();
  const errors: string[] = [];
  const warnings: string[] = [];

  // Categories known so far: never swept first, then the least recently swept.
  const known = await prisma.shopeeCategory.findMany({ select: { id: true, lastScannedAt: true }, orderBy: { lastScannedAt: { sort: 'asc', nulls: 'first' } } });
  const knownIds = new Set(known.map((c) => c.id));
  const neverScanned = known.filter((c) => !c.lastScannedAt).map((c) => c.id);
  const scannedBefore = known.filter((c) => c.lastScannedAt).map((c) => c.id);
  const discovered: string[] = []; // new in this scan
  let newCats: Array<{ id: string; level: number }> = [];
  let categoriesScanned = 0;

  const prevAt = (await scanState()).at; // kept, so a crashed scan isn't retried every tick
  const progress = () => saveState({
    running: true, startedAt: new Date(started).toISOString(), at: prevAt, calls, found, saved: seen.size,
    categories: knownIds.size, categoriesScanned, mode: 'categories',
  });
  await progress();
  const outOfBudget = () => stopped || calls >= MAX_CALLS || Date.now() - started > MAX_SCAN_MS;

  /** Runs one search through its pages; returns how many products came back, or null if it failed. */
  const runStep = async (step: Step): Promise<{ count: number; error?: string } > => {
    steps++;
    let retried = false;
    let count = 0;
    for (let page = 1; page <= step.pages; page++) {
      if (outOfBudget()) break;
      if (calls > 0) await sleep(CALL_GAP_MS);
      calls++;
      if (calls % 20 === 0) await progress();
      let nodes: any[] = [];
      let hasNext = false;
      try {
        const vars = { ...step.vars, page, limit: PAGE_SIZE };
        const data = await shopeeGraphql<any>(buildQuery(fields, vars), vars);
        nodes = data?.productOfferV2?.nodes ?? [];
        hasNext = !!data?.productOfferV2?.pageInfo?.hasNextPage;
        rateLimitStreak = 0;
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
          stopped = true;
          return { count, error: msg };
        }
        // Too many requests: wait and try the same page again; stop the scan if it keeps happening.
        if (/limit|too many|frequen|429|throttl/i.test(msg)) {
          rateLimitStreak++;
          if (rateLimitStreak >= 4) {
            warnings.unshift('A Shopee limitou as consultas — a varredura continua na próxima rodada');
            stopped = true;
            return { count, error: msg };
          }
          if (!retried) {
            retried = true;
            await sleep(30000);
            page--;
            continue;
          }
        }
        failedSteps++;
        if (warnings.length < 8) warnings.push(`${step.label}: ${msg}`);
        return { count, error: msg };
      }
      found += nodes.length;
      count += nodes.length;
      for (const n of nodes) {
        const p = parseProductNode(n);
        if (!p || !p.name) continue;
        // Every product tells which categories it is in → the next ones to sweep.
        p.categoryIds?.forEach((cid, i) => {
          if (!cid || cid === '0' || knownIds.has(cid)) return;
          knownIds.add(cid);
          discovered.push(cid);
          newCats.push({ id: cid, level: i + 1 });
        });
        const key = `${p.shopId}-${p.itemId}`;
        if (seen.has(key)) continue; // already saved in this scan
        try {
          await upsertProduct(p, { finderSeenAt: new Date() });
          seen.add(key);
        } catch (err) {
          if (warnings.length < 8) warnings.push(`salvar produto: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (newCats.length) {
        await prisma.shopeeCategory.createMany({ data: newCats, skipDuplicates: true });
        newCats = [];
      }
      if (!hasNext || nodes.length === 0) break;
    }
    return { count };
  };

  // 1) The general lists — they also reveal the categories.
  // Most sold AND highest commission: cheap products paying R$2–5 are mostly in the second.
  const general: Step[] = [
    { label: 'mais vendidos', vars: { sortType: 2 }, pages: GENERAL_PAGES },
    { label: 'maior comissão', vars: { sortType: 5 }, pages: GENERAL_PAGES },
    { label: 'lista maior comissão', vars: { listType: 1 }, pages: 5 },
    { label: 'lista em alta', vars: { listType: 2 }, pages: 5 },
  ];
  for (const step of general) {
    if (outOfBudget()) break;
    await runStep(step);
  }

  // 2) Category after category, until the call / time budget runs out.
  let mode: 'categories' | 'terms' = 'categories';
  let categoryFilterBroken = false;
  while (!outOfBudget()) {
    const id = neverScanned.shift() ?? discovered.shift() ?? scannedBefore.shift();
    if (!id) break;
    let count = 0;
    let unsupported = false;
    for (const sortType of [2, 5]) {
      const r = await runStep({ label: `categoria ${id}`, vars: { productCatId: Number(id), sortType }, pages: CATEGORY_PAGES });
      count += r.count;
      if (r.error && /productCatId|unknown argument|argument/i.test(r.error)) unsupported = true;
      if (outOfBudget() || unsupported) break;
    }
    if (unsupported) { categoryFilterBroken = true; break; }
    categoriesScanned++;
    await prisma.shopeeCategory.update({ where: { id }, data: { lastScannedAt: new Date(), products: count } }).catch(() => {});
  }

  // 3) Fallback: this account sends no categories (or rejects the filter) — broad words instead.
  if (knownIds.size === 0 || categoryFilterBroken) {
    mode = 'terms';
    for (const t of FALLBACK_TERMS) {
      if (outOfBudget()) break;
      await runStep({ label: t, vars: { keyword: t, sortType: 2 }, pages: 3 });
      if (outOfBudget()) break;
      await runStep({ label: `${t} (comissão)`, vars: { keyword: t, sortType: 5 }, pages: 3 });
    }
  }

  await refreshSalesRates();
  // Readings older than 35 days are no longer used.
  await prisma.shopeeSalesSnapshot.deleteMany({ where: { at: { lt: new Date(Date.now() - 35 * DAY_MS) } } });

  const droppedFields = FIELDS.split(/\s+/).filter((f) => f && !fields.split(/\s+/).includes(f));
  const left = await prisma.shopeeCategory.count({ where: { lastScannedAt: null } });
  const state: ScanState = {
    at: new Date().toISOString(),
    startedAt: new Date(started).toISOString(),
    running: false,
    calls,
    found,
    saved: seen.size,
    fields: droppedFields.length ? `sem ${droppedFields.join(', ')}` : undefined,
    errors,
    warnings: failedSteps ? [`${failedSteps} de ${steps} buscas falharam`, ...warnings] : warnings,
    categories: knownIds.size,
    categoriesScanned,
    categoriesLeft: left,
    mode,
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

export async function finderProducts(tenantId: string, query: Record<string, unknown>) {
  const limit = Math.min(500, Math.max(10, Math.floor(num(query.limit, 200) ?? 200)));
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
  // The whole fresh catalog, so the panel can say how many each filter cut.
  const products = await prisma.shopeeProduct.findMany({
    where: { lastSeenAt: { gte: fresh } },
    select: {
      id: true, itemId: true, shopId: true, name: true, imageUrl: true, productLink: true, shopName: true, isOfficial: true,
      ratingStar: true, sales: true, commissionPct: true, commissionValue: true, lastPrice: true, salesPerDay: true, salesTrend: true, lastSeenAt: true,
    },
    orderBy: { sales: 'desc' },
    take: 60000,
  });
  const links = await prisma.adLink.findMany({ select: { productUrl: true } });
  const tested = new Set(links.map((l) => itemIdOfUrl(l.productUrl)).filter(Boolean) as string[]);
  const { rows: ranked, dropped } = rankProducts(products, f, a, tested);
  const favs = await prisma.shopeeFavorite.findMany({ where: { tenantId }, select: { id: true, productId: true } });
  const favBy = new Map(favs.map((x) => [x.productId, x.id]));
  for (const r of ranked) r.favoriteId = favBy.get(r.id) ?? null;
  const catalog = products.length;
  const withRate = products.filter((p) => p.salesPerDay !== null).length;
  const state = await scanState();
  const offset = Math.max(0, Math.floor(num(query.offset, 0) ?? 0));
  return {
    filters: f,
    assumptions: a,
    breakEvenCommission: breakEvenCommission(a),
    total: ranked.length,
    offset,
    items: ranked.slice(offset, offset + limit),
    dropped,
    catalog,
    withRate,
    scan: state,
  };
}

// ── Favorites (test queue) ──────────────────────────────────────────────────

export const FAVORITE_STATUSES = ['QUEUE', 'TESTING', 'WINNER', 'LOSER'] as const;
export type FavoriteStatus = (typeof FAVORITE_STATUSES)[number];
const STATUS_ORDER: Record<string, number> = { TESTING: 0, QUEUE: 1, WINNER: 2, LOSER: 3 };

export async function addFavorite(tenantId: string, productId: string) {
  const product = await prisma.shopeeProduct.findUnique({ where: { id: productId }, select: { id: true, itemId: true } });
  if (!product) throw new Error('Produto não encontrado');
  // Already has an ad link → it is being tested.
  const links = await prisma.adLink.findMany({ select: { productUrl: true } });
  const hasLink = links.some((l) => itemIdOfUrl(l.productUrl) === String(product.itemId));
  return prisma.shopeeFavorite.upsert({
    where: { tenantId_productId: { tenantId, productId } },
    update: {},
    create: { tenantId, productId, status: hasLink ? 'TESTING' : 'QUEUE' },
  });
}

export async function updateFavorite(tenantId: string, id: string, patch: { status?: string; note?: string | null }) {
  const fav = await prisma.shopeeFavorite.findFirst({ where: { id, tenantId } });
  if (!fav) throw new Error('Favorito não encontrado');
  if (patch.status !== undefined && !FAVORITE_STATUSES.includes(patch.status as FavoriteStatus)) throw new Error('Status inválido');
  return prisma.shopeeFavorite.update({
    where: { id },
    data: {
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.note !== undefined && { note: patch.note ? String(patch.note).slice(0, 500) : null }),
    },
  });
}

export async function removeFavorite(tenantId: string, id: string) {
  await prisma.shopeeFavorite.deleteMany({ where: { id, tenantId } });
}

/** A new ad link for a favorite still waiting in the queue moves it to "testing". */
export async function markFavoriteTesting(productUrl: string) {
  const itemId = itemIdOfUrl(productUrl);
  if (!itemId) return 0;
  const r = await prisma.shopeeFavorite.updateMany({ where: { status: 'QUEUE', product: { itemId: BigInt(itemId) } }, data: { status: 'TESTING' } });
  return r.count;
}

/** The favorites with today's numbers, the day-1 math and — once tested — the real ad results (90 days). */
export async function listFavorites(tenantId: string) {
  const [favs, settings, taxes, tested] = await Promise.all([
    prisma.shopeeFavorite.findMany({ where: { tenantId }, include: { product: true }, orderBy: { createdAt: 'asc' } }),
    finderSettings(tenantId),
    taxConfig(),
    testedProducts(90),
  ]);
  const a: Assumptions = { cpc: settings.cpc, cvrPct: settings.cvrPct, metaTaxPct: taxes.metaTaxPct, revenueTaxPct: taxes.revenueTaxPct };
  const testedBy = new Map(tested.rows.filter((r) => r.itemId).map((r) => [r.itemId as string, r]));
  const rows = favs.map((fav, i) => {
    const p = fav.product;
    const commission = commissionOf(p);
    const d1 = commission === null ? null : dayOne(commission, a);
    return {
      id: fav.id,
      position: i + 1,
      status: fav.status as FavoriteStatus,
      note: fav.note,
      addedAt: fav.createdAt,
      product: {
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
        maxCpc: d1?.maxCpc ?? null,
        profitPer100: d1?.profitPer100 ?? null,
      },
      result: testedBy.get(String(p.itemId)) ?? null,
    };
  });
  rows.sort((x, y) => (STATUS_ORDER[x.status] ?? 9) - (STATUS_ORDER[y.status] ?? 9) || x.position - y.position);
  const counts = Object.fromEntries(FAVORITE_STATUSES.map((st) => [st, favs.filter((f) => f.status === st).length]));
  return { rows, counts, assumptions: a };
}
