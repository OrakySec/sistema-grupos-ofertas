/**
 * Shopee sales analysis (Tráfego pago → Análise de vendas): every number of
 * the dashboard, out of the synced order items (ShopeeOrderItem) of a period.
 *
 * "Commission" / "orders" / "sales" count pending + completed orders, as the
 * Shopee panel does; cancelled (and fraud) only show up in the status table.
 * Conversions synced before items existed count as one pseudo-item each, so
 * old periods still add up (just without category/product detail).
 *
 * analyze() is pure (tested); salesAnalysis() loads the period from the DB.
 */
import prisma from './prisma';
import { linkLabel } from './adLinks';
import { brtDateStart, toBrt } from './time';

const DAY_MS = 86_400_000;
const r2 = (v: number) => Math.round(v * 100) / 100;

export interface Item {
  orderId: string;
  orderStatus: string; // COMPLETED | CANCELLED | PENDING
  purchaseTime: Date;
  clickTime: Date | null;
  subCode: string | null;
  channel: string | null;
  itemId: string | null;
  itemName: string | null;
  imageUrl: string | null;
  shopId: string | null;
  categoryL1: string | null;
  price: number;
  amount: number;
  commission: number;
  shopeeCommission: number | null;
  sellerCommission: number | null;
  attribution: string | null;
  fraud: boolean;
}

export const PRICE_BANDS: Array<{ label: string; min: number; max: number }> = [
  { label: 'Até R$ 10', min: 0, max: 10 },
  { label: 'R$ 10–20', min: 10, max: 20 },
  { label: 'R$ 20–30', min: 20, max: 30 },
  { label: 'R$ 30–50', min: 30, max: 50 },
  { label: 'R$ 50–100', min: 50, max: 100 },
  { label: 'R$ 100–200', min: 100, max: 200 },
  { label: 'Acima de R$ 200', min: 200, max: Infinity },
];

/** Calendar days (Brasília) between the click and the purchase, 0 = same day; capped at 7. */
export function cookieDay(click: Date | null, purchase: Date): number | null {
  if (!click) return null;
  const day = (d: Date) => { const b = toBrt(d); return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()); };
  const n = Math.round((day(purchase) - day(click)) / DAY_MS);
  return Math.max(0, Math.min(7, n));
}

type Agg = { orders: Set<string>; commission: number };
const agg = (): Agg => ({ orders: new Set(), commission: 0 });
const out = (a: Agg) => ({ orders: a.orders.size, commission: r2(a.commission) });

export function analyze(items: Item[], days: number) {
  const live = items.filter((i) => i.orderStatus !== 'CANCELLED' && !i.fraud);
  const orderIds = new Set(live.map((i) => i.orderId));
  const commission = live.reduce((a, i) => a + i.commission, 0);
  const gmv = live.reduce((a, i) => a + i.amount, 0);
  const d = Math.max(1, days);

  // Status (all orders; an order's status is its items').
  const status: Record<string, Agg> = { COMPLETED: agg(), CANCELLED: agg(), PENDING: agg() };
  for (const i of items) {
    const s = i.fraud ? 'CANCELLED' : (status[i.orderStatus] ? i.orderStatus : 'PENDING');
    status[s].orders.add(i.orderId);
    status[s].commission += s === 'CANCELLED' ? 0 : i.commission;
  }

  // Direct / indirect: an order is direct when any item is the linked product/shop.
  const rank: Record<string, number> = { UNKNOWN: 0, INDIRECT: 1, DIRECT: 2 };
  const orderAttr = new Map<string, string>();
  for (const i of live) {
    const a = i.attribution === 'DIRECT' || i.attribution === 'INDIRECT' ? i.attribution : 'UNKNOWN';
    const prev = orderAttr.get(i.orderId);
    if (!prev || rank[a] > rank[prev]) orderAttr.set(i.orderId, a);
  }
  const attr: Record<string, { orders: number; commission: number }> = {
    DIRECT: { orders: 0, commission: 0 }, INDIRECT: { orders: 0, commission: 0 }, UNKNOWN: { orders: 0, commission: 0 },
  };
  for (const a of orderAttr.values()) attr[a in attr ? a : 'UNKNOWN'].orders++;
  for (const i of live) attr[i.attribution === 'DIRECT' || i.attribution === 'INDIRECT' ? i.attribution : 'UNKNOWN'].commission += i.commission;

  // Grouped breakdowns.
  const group = (key: (i: Item) => string) => {
    const m = new Map<string, Agg>();
    for (const i of live) {
      const k = key(i);
      const a = m.get(k) ?? agg();
      a.orders.add(i.orderId);
      a.commission += i.commission;
      m.set(k, a);
    }
    return [...m.entries()].map(([k, a]) => ({ key: k, ...out(a) })).sort((x, y) => y.commission - x.commission || y.orders - x.orders);
  };
  const channels = group((i) => i.channel ?? 'Outros').map(({ key, ...r }) => ({ channel: key, ...r }));
  const categories = group((i) => i.categoryL1 ?? 'Sem categoria').map(({ key, ...r }) => ({ category: key, ...r }));

  // Shopee × seller commission (only when the account reports the split).
  const hasSplit = live.some((i) => i.shopeeCommission != null || i.sellerCommission != null);
  const split = hasSplit
    ? { shopee: r2(live.reduce((a, i) => a + (i.shopeeCommission ?? 0), 0)), seller: r2(live.reduce((a, i) => a + (i.sellerCommission ?? 0), 0)) }
    : null;

  // Orders per hour of the day (Brasília), averaged over the period's days.
  const perHour = Array.from({ length: 24 }, () => new Set<string>());
  for (const i of live) perHour[toBrt(i.purchaseTime).getUTCHours()].add(i.orderId);
  const hourly = perHour.map((s, hour) => ({ hour, orders: s.size, avg: r2(s.size / d) }));

  // Days between click and purchase (the Shopee cookie lasts 7 days).
  const cookie = Array.from({ length: 8 }, () => agg());
  let cookieKnown = 0;
  for (const i of live) {
    const day = cookieDay(i.clickTime, i.purchaseTime);
    if (day == null) continue;
    cookie[day].orders.add(i.orderId);
    cookie[day].commission += i.commission;
    cookieKnown += i.commission;
  }
  const cookieDays = cookie.map((a, day) => ({ day, ...out(a), share: cookieKnown ? r2((a.commission / cookieKnown) * 100) : 0 }));

  // Top products by commission.
  const products = new Map<string, Agg & { name: string; image: string | null; itemId: string | null; shopId: string | null }>();
  for (const i of live) {
    if (!i.itemId && !i.itemName) continue;
    const k = i.itemId ? `${i.shopId ?? ''}|${i.itemId}` : `name|${i.itemName}`;
    const p = products.get(k) ?? { ...agg(), name: i.itemName ?? `Produto ${i.itemId}`, image: i.imageUrl, itemId: i.itemId, shopId: i.shopId };
    p.orders.add(i.orderId);
    p.commission += i.commission;
    if (!p.image && i.imageUrl) p.image = i.imageUrl;
    products.set(k, p);
  }
  const topProducts = [...products.values()]
    .map((p) => ({
      name: p.name, image: p.image, itemId: p.itemId, shopId: p.shopId, ...out(p),
      link: p.itemId && p.shopId ? `https://shopee.com.br/product/${p.shopId}/${p.itemId}` : null,
    }))
    .sort((a, b) => b.commission - a.commission)
    .slice(0, 15);

  // Price bands: what each unit-price range earns per order and how much of it lands on the click's day.
  const priceBands = PRICE_BANDS.map((b) => {
    const inBand = live.filter((i) => i.price >= b.min && i.price < b.max);
    const orders = new Set(inBand.map((i) => i.orderId)).size;
    const c = inBand.reduce((a, i) => a + i.commission, 0);
    const known = inBand.filter((i) => i.clickTime);
    const knownC = known.reduce((a, i) => a + i.commission, 0);
    const sameDay = known.filter((i) => cookieDay(i.clickTime, i.purchaseTime) === 0).reduce((a, i) => a + i.commission, 0);
    return {
      label: b.label, orders, commission: r2(c), perOrder: orders ? r2(c / orders) : null,
      sameDayShare: knownC ? r2((sameDay / knownC) * 100) : null,
      shareOfCommission: commission ? r2((c / commission) * 100) : 0,
    };
  });

  // Per sub-ID (spend is added by the caller).
  const subs = new Map<string, { orders: Set<string>; gmv: number; commission: number; direct: number; indirect: number }>();
  for (const i of live) {
    const k = i.subCode ?? '';
    const s = subs.get(k) ?? { orders: new Set<string>(), gmv: 0, commission: 0, direct: 0, indirect: 0 };
    s.orders.add(i.orderId);
    s.gmv += i.amount;
    s.commission += i.commission;
    if (i.attribution === 'DIRECT') s.direct += i.commission;
    else if (i.attribution === 'INDIRECT') s.indirect += i.commission;
    subs.set(k, s);
  }
  const subIds = [...subs.entries()].map(([subCode, s]) => ({
    subCode, orders: s.orders.size, gmv: r2(s.gmv), commission: r2(s.commission), direct: r2(s.direct), indirect: r2(s.indirect),
  })).sort((a, b) => b.commission - a.commission);

  return {
    days: d,
    summary: {
      commission: r2(commission), orders: orderIds.size, gmv: r2(gmv),
      commissionPerDay: r2(commission / d), ordersPerDay: r2(orderIds.size / d), gmvPerDay: r2(gmv / d),
      commissionPerOrder: orderIds.size ? r2(commission / orderIds.size) : null,
    },
    status: (['COMPLETED', 'CANCELLED', 'PENDING'] as const).map((s) => ({ status: s, ...out(status[s]) })),
    attribution: { direct: { ...attr.DIRECT, commission: r2(attr.DIRECT.commission) }, indirect: { ...attr.INDIRECT, commission: r2(attr.INDIRECT.commission) }, unknown: { ...attr.UNKNOWN, commission: r2(attr.UNKNOWN.commission) } },
    channels, categories, split, hourly, cookieDays, topProducts, priceBands, subIds,
    hasItemDetail: live.some((i) => i.itemId || i.categoryL1),
  };
}

/** Pseudo-item of a conversion synced before items existed (no product/category detail). */
function itemOfConversion(c: any): Item[] {
  const base = {
    purchaseTime: c.purchaseTime, clickTime: c.clickTime, subCode: c.subCode, channel: c.channel ?? null,
    itemId: null, itemName: null, imageUrl: null, shopId: null, categoryL1: null, price: c.orders ? c.gmv / Math.max(1, c.items || 1) : 0,
    shopeeCommission: null, sellerCommission: null, attribution: null, fraud: c.fraud,
  };
  const rows: Item[] = [];
  const live = c.commissionPending + c.commissionConfirmed;
  if (live > 0 || c.status !== 'CANCELLED') {
    rows.push({ ...base, orderId: `${c.id}#`, orderStatus: c.commissionConfirmed > 0 && c.commissionPending === 0 ? 'COMPLETED' : 'PENDING', amount: c.gmv, commission: live });
  }
  if (c.commissionCancelled > 0 || c.status === 'CANCELLED') {
    rows.push({ ...base, orderId: `${c.id}#x`, orderStatus: 'CANCELLED', amount: 0, commission: 0 });
  }
  return rows;
}

const dateKeys = (from: string, to: string) => {
  const keys: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) keys.push(new Date(t).toISOString().slice(0, 10));
  return keys;
};

/** Manual spend of an entry that falls inside [from, to], spread evenly over its days. */
export function manualSpendIn(e: { startDate: string; endDate: string; amount: number }, from: string, to: string): number {
  const all = dateKeys(e.startDate, e.endDate);
  if (!all.length) return 0;
  const inside = all.filter((k) => k >= from && k <= to).length;
  return (e.amount * inside) / all.length;
}

export async function taxConfig() {
  const rows = await prisma.setting.findMany({ where: { key: { in: ['ads_meta_tax_pct', 'ads_revenue_tax_pct'] } } });
  const m = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  return {
    // Since 01/01/2026 Meta passes on PIS/Cofins + ISS in Brazil: 12.15% of the invoice total (= +13.83% on the ad).
    metaTaxPct: Number.isFinite(m.ads_meta_tax_pct) ? m.ads_meta_tax_pct : 12.15,
    revenueTaxPct: Number.isFinite(m.ads_revenue_tax_pct) ? m.ads_revenue_tax_pct : 0,
  };
}

export async function salesAnalysis(params: { from: string; to: string; subCode?: string; tenantId: string }) {
  const start = brtDateStart(params.from);
  const endStart = brtDateStart(params.to);
  if (!start || !endStart) throw new Error('Período inválido');
  const end = new Date(endStart.getTime() + DAY_MS);
  const days = Math.round((endStart.getTime() - start.getTime()) / DAY_MS) + 1;
  const subFilter = params.subCode !== undefined ? { subCode: params.subCode === '' ? null : params.subCode } : {};

  // TODO(multi-tenant): ShopeeConversion has no tenantId yet — items carry it.
  const [rows, convs, links, daily, manual, taxes, lastSync] = await Promise.all([
    prisma.shopeeOrderItem.findMany({ where: { tenantId: params.tenantId, purchaseTime: { gte: start, lt: end }, ...subFilter } }),
    prisma.shopeeConversion.findMany({ where: { purchaseTime: { gte: start, lt: end }, ...subFilter, orderItems: { none: {} } } }),
    prisma.adLink.findMany({ select: { code: true, label: true, ads: { select: { adId: true } } } }),
    prisma.metaAdDaily.findMany({ where: { date: { gte: params.from, lte: params.to } }, select: { adId: true, spend: true } }),
    prisma.manualAdSpend.findMany({ where: { tenantId: params.tenantId } }),
    taxConfig(),
    prisma.setting.findUnique({ where: { key: 'shopee_sales_last_sync' } }),
  ]);
  const items: Item[] = [...rows, ...convs.flatMap(itemOfConversion)];
  const a = analyze(items, days);

  // Spend per sub-ID: our Meta ads (AdLink code = sub-ID) + what was typed in by hand.
  const spendByAd = new Map<string, number>();
  for (const d of daily) spendByAd.set(d.adId, (spendByAd.get(d.adId) ?? 0) + d.spend);
  const metaSpendBySub = new Map<string, number>();
  for (const l of links) {
    for (const { adId } of l.ads) metaSpendBySub.set(l.code, (metaSpendBySub.get(l.code) ?? 0) + (spendByAd.get(adId) ?? 0));
  }
  const manualBySub = new Map<string, { amount: number; entries: Array<{ id: string; startDate: string; endDate: string; amount: number; inPeriod: number }> }>();
  for (const e of manual) {
    const v = manualSpendIn(e, params.from, params.to);
    if (v <= 0) continue;
    const m = manualBySub.get(e.subCode) ?? { amount: 0, entries: [] };
    m.amount += v;
    m.entries.push({ id: e.id, startDate: e.startDate, endDate: e.endDate, amount: e.amount, inPeriod: r2(v) });
    manualBySub.set(e.subCode, m);
  }
  const adNames = new Map((await prisma.metaEntity.findMany({ where: { id: { in: links.flatMap((l) => l.ads.map((a) => a.adId)) } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
  const labelOf = (l: (typeof links)[number]) => linkLabel(l, l.ads.map((a) => adNames.get(a.adId)));
  const linkBy = new Map(links.map((l) => [l.code, l]));
  const subIds = a.subIds.map((s) => {
    const link = linkBy.get(s.subCode);
    const label = link ? labelOf(link) : s.subCode || 'Sem sub-ID';
    const source = link ? 'Anúncio' : s.subCode.startsWith('busca') ? 'Busca Shopee' : s.subCode ? 'Outro sub-ID' : 'Sem sub-ID';
    const metaSpend = r2(metaSpendBySub.get(s.subCode) ?? 0);
    const m = manualBySub.get(s.subCode);
    return { ...s, label, source, metaSpend, manualSpend: r2(m?.amount ?? 0), manualEntries: m?.entries ?? [] };
  });
  // Sub-IDs with spend but no sale in the period still show (they're the losses).
  for (const [code, spend] of metaSpendBySub) {
    if (spend <= 0 || subIds.some((s) => s.subCode === code)) continue;
    if (params.subCode !== undefined && params.subCode !== code) continue;
    const link = linkBy.get(code);
    const m = manualBySub.get(code);
    subIds.push({
      subCode: code, orders: 0, gmv: 0, commission: 0, direct: 0, indirect: 0,
      label: link ? labelOf(link) : code, source: 'Anúncio',
      metaSpend: r2(spend), manualSpend: r2(m?.amount ?? 0), manualEntries: m?.entries ?? [],
    });
  }
  for (const [code, m] of manualBySub) {
    if (subIds.some((s) => s.subCode === code)) continue;
    if (params.subCode !== undefined && params.subCode !== code) continue;
    subIds.push({ subCode: code, orders: 0, gmv: 0, commission: 0, direct: 0, indirect: 0, label: code, source: 'Outro sub-ID', metaSpend: 0, manualSpend: r2(m.amount), manualEntries: m.entries });
  }

  // The whole period's Meta spend (every campaign, as the invoice) — or just the filtered sub-ID's.
  const metaSpendTotal = r2(params.subCode !== undefined ? metaSpendBySub.get(params.subCode) ?? 0 : daily.reduce((s, d) => s + d.spend, 0));
  const manualTotal = r2([...manualBySub.values()].reduce((s, m) => s + m.amount, 0));
  let sync: unknown = null;
  try { sync = lastSync?.value ? JSON.parse(lastSync.value) : null; } catch { /* ignore */ }

  return {
    from: params.from, to: params.to, subCode: params.subCode ?? null,
    ...a, subIds,
    investment: { metaSpend: metaSpendTotal, manualSpend: manualTotal, total: r2(metaSpendTotal + manualTotal) },
    taxes, lastSync: sync,
  };
}
