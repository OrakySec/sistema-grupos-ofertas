/**
 * Shopee affiliate sales (conversionReport) → ShopeeConversion rows, plus
 * one ShopeeOrderItem per item for the sales analysis.
 *
 * Re-pulls the last 30 days every run: orders move from PENDING to
 * COMPLETED/CANCELLED weeks after the purchase, and commissions only
 * become final then. The first run after the analysis shipped pulls 90
 * days (in 30-day windows) so the reports have history.
 *
 * Field names follow the Brazilian affiliate API. The richest query asks
 * for channel, category, photo, direct/indirect and Shopee × seller
 * commission; a field this account doesn't have is dropped by name and the
 * query retried, then smaller fixed sets are the fallback.
 */
import prisma from './prisma';
import { shopeeGraphql } from './shopeeApi';

const PAGE_DELAY_MS = 250;
const MAX_PAGES = 200;
const WINDOW_DAYS = 30;
const HISTORY_KEY = 'shopee_sales_history_v2'; // set once the 90-day pull worked

// Everything the sales analysis uses.
const ITEMS_FIELDS = `conversionId purchaseTime clickTime utmContent referrer totalCommission netCommission
  orders { orderId orderStatus items { shopId shopName itemId itemName imageUrl qty itemPrice actualAmount
    itemTotalCommission itemSellerCommission itemShopeeCommissionCapped attributionType globalCategoryLv1Name fraudStatus } }`;
// Same as FULL plus the product, for the per-sale list.
const RICH_FIELDS = `conversionId purchaseTime clickTime utmContent totalCommission netCommission
  orders { orderId orderStatus items { itemId itemName qty itemPrice actualAmount itemTotalCommission fraudStatus } }`;
const FULL_FIELDS = `conversionId purchaseTime clickTime utmContent totalCommission netCommission
  orders { orderId orderStatus items { qty itemPrice actualAmount itemTotalCommission fraudStatus } }`;
// Keeps clickTime (needed to match a sale to the ad click) even if the
// per-item commission field is not available on this account.
const MID_FIELDS = `conversionId purchaseTime clickTime utmContent totalCommission netCommission
  orders { orderId orderStatus items { qty itemPrice actualAmount fraudStatus } }`;
const MIN_FIELDS = `conversionId purchaseTime utmContent totalCommission netCommission
  orders { orderId orderStatus items { qty itemPrice actualAmount fraudStatus } }`;

const query = (fields: string, start: number, end: number, scrollId: string | null) =>
  `{ conversionReport(limit: 500, purchaseTimeStart: ${start}, purchaseTimeEnd: ${end}${scrollId ? `, scrollId: ${JSON.stringify(scrollId)}` : ''}) {
    nodes { ${fields} }
    pageInfo { hasNextPage scrollId }
  } }`;

/** utmContent as we store/match it: lowercase letters and digits only. */
export const normalizeSubCode = (utm: string | null | undefined) => String(utm ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

/** Splits one conversion's commission by order status. */
export function summarizeConversion(node: any) {
  const orders: any[] = Array.isArray(node?.orders) ? node.orders : [];
  const nodeCommission = num(node?.netCommission) > 0 ? num(node?.netCommission) : num(node?.totalCommission);
  let gmv = 0;
  let items = 0;
  let fraud = false;
  const perOrder = orders.map((o) => {
    const its: any[] = Array.isArray(o?.items) ? o.items : [];
    const amount = its.reduce((a, it) => a + (num(it.actualAmount) || num(it.itemPrice) * (num(it.qty) || 1)), 0);
    const itemCommission = its.reduce((a, it) => a + num(it.itemTotalCommission), 0);
    items += its.reduce((a, it) => a + (num(it.qty) || 1), 0);
    if (its.some((it) => String(it.fraudStatus ?? '').toUpperCase() === 'FRAUD')) fraud = true;
    gmv += amount;
    return { status: String(o?.orderStatus ?? '').toUpperCase(), amount, itemCommission };
  });
  const itemCommissionTotal = perOrder.reduce((a, o) => a + o.itemCommission, 0);
  const totalAmount = perOrder.reduce((a, o) => a + o.amount, 0);

  let pending = 0;
  let confirmed = 0;
  let cancelled = 0;
  for (const o of perOrder) {
    // Prefer per-item commission; otherwise split the conversion's commission by order value.
    const c = itemCommissionTotal > 0
      ? o.itemCommission
      : totalAmount > 0 ? (nodeCommission * o.amount) / totalAmount : nodeCommission / Math.max(1, perOrder.length);
    if (o.status === 'COMPLETED' || o.status.includes('COMPLET')) confirmed += c;
    else if (o.status === 'CANCELLED' || o.status === 'CANCELED') cancelled += c;
    else pending += c; // PENDING, UNPAID, anything new
  }
  if (perOrder.length === 0) pending = nodeCommission;
  if (fraud) { cancelled += pending + confirmed; pending = 0; confirmed = 0; }

  const statuses = new Set(perOrder.map((o) => o.status));
  const status = statuses.size === 0 ? 'PENDING'
    : statuses.size > 1 ? 'MIXED'
    : [...statuses][0].includes('COMPLET') ? 'COMPLETED'
    : [...statuses][0].startsWith('CANCEL') ? 'CANCELLED'
    : [...statuses][0] === 'UNPAID' ? 'UNPAID' : 'PENDING';

  const r2 = (v: number) => Math.round(v * 100) / 100;
  return { orders: perOrder.length, items, gmv: r2(gmv), pending: r2(pending), confirmed: r2(confirmed), cancelled: r2(cancelled), status, fraud };
}

/** Order status as the analysis groups it. */
export function orderStatusOf(raw: unknown): 'COMPLETED' | 'CANCELLED' | 'PENDING' {
  const s = String(raw ?? '').toUpperCase();
  if (s.includes('COMPLET')) return 'COMPLETED';
  if (s.startsWith('CANCEL')) return 'CANCELLED';
  return 'PENDING';
}

/** "Ordered in same shop" → DIRECT, "…different shop" → INDIRECT (also accepts DIRECT/INDIRECT). */
export function attributionOf(raw: unknown): 'DIRECT' | 'INDIRECT' | null {
  const s = String(raw ?? '').toLowerCase();
  if (!s) return null;
  if (s.includes('different') || s.includes('indirect')) return 'INDIRECT';
  if (s.includes('same') || s.includes('direct')) return 'DIRECT';
  return null;
}

/** Shopee's referrer → a readable channel name. */
export function channelOf(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const k = s.toLowerCase();
  if (k.includes('whatsapp')) return 'WhatsApp';
  if (k.includes('instagram')) return 'Instagram';
  if (k.includes('facebook') || k === 'fb') return 'Facebook';
  if (k.includes('telegram')) return 'Telegram';
  if (k.includes('tiktok')) return 'TikTok';
  if (k.includes('youtube')) return 'YouTube';
  if (k.includes('other')) return 'Outros';
  return s.slice(0, 40);
}

/** One conversion node → its item rows (commission per item, or the conversion's split by value). */
export function itemsOf(node: any, key: string, base: { purchaseTime: Date; clickTime: Date | null; subCode: string | null; channel: string | null }) {
  const orders: any[] = Array.isArray(node?.orders) ? node.orders : [];
  const lines = orders.flatMap((o) => (Array.isArray(o?.items) ? o.items : []).map((it: any) => ({ o, it })));
  const amountOf = (it: any) => num(it.actualAmount) || num(it.itemPrice) * (num(it.qty) || 1);
  const hasItemCommission = lines.some(({ it }) => num(it.itemTotalCommission) > 0);
  const nodeCommission = num(node?.netCommission) > 0 ? num(node?.netCommission) : num(node?.totalCommission);
  const totalAmount = lines.reduce((a, { it }) => a + amountOf(it), 0);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return lines.map(({ o, it }, i) => {
    const amount = amountOf(it);
    const commission = hasItemCommission ? num(it.itemTotalCommission)
      : totalAmount > 0 ? (nodeCommission * amount) / totalAmount : nodeCommission / Math.max(1, lines.length);
    const optional = (v: unknown) => (v === undefined || v === null || v === '' ? null : r2(num(v)));
    return {
      id: `${key}|${o?.orderId ?? ''}|${i}`,
      conversionId: key,
      orderId: String(o?.orderId ?? `${key}-${i}`),
      orderStatus: orderStatusOf(o?.orderStatus),
      purchaseTime: base.purchaseTime,
      clickTime: base.clickTime,
      subCode: base.subCode,
      channel: base.channel,
      itemId: it.itemId != null ? String(it.itemId) : null,
      itemName: it.itemName ? String(it.itemName).slice(0, 300) : null,
      imageUrl: it.imageUrl ? String(it.imageUrl) : null,
      shopId: it.shopId != null ? String(it.shopId) : null,
      shopName: it.shopName ? String(it.shopName).slice(0, 120) : null,
      categoryL1: it.globalCategoryLv1Name ? String(it.globalCategoryLv1Name).slice(0, 120) : null,
      qty: Math.max(1, Math.round(num(it.qty)) || 1),
      price: r2(num(it.itemPrice)),
      amount: r2(amount),
      commission: r2(commission),
      shopeeCommission: optional(it.itemShopeeCommissionCapped),
      sellerCommission: optional(it.itemSellerCommission),
      attribution: attributionOf(it.attributionType),
      fraud: String(it.fraudStatus ?? '').toUpperCase() === 'FRAUD',
    };
  });
}

/** `Cannot query field "referrer" on type …` → "referrer". */
export function unknownField(err: unknown): string | null {
  const m = /cannot query field ["'`]?(\w+)["'`]?/i.exec(String(err));
  return m ? m[1] : null;
}

export const dropField = (fields: string, name: string) => fields.replace(new RegExp(`\\b${name}\\b`, 'g'), ' ').replace(/[ \t]+/g, ' ');

export async function syncShopeeConversions(days = 30): Promise<{ nodes: number; saved: number; days?: number; fields?: string; error?: string }> {
  // History for the reports: the first successful run pulls 90 days.
  const history = await prisma.setting.findUnique({ where: { key: HISTORY_KEY } });
  const span = history ? days : Math.max(days, 90);
  const now = Math.floor(Date.now() / 1000);
  const fieldSets = [ITEMS_FIELDS, RICH_FIELDS, FULL_FIELDS, MID_FIELDS, MIN_FIELDS];
  let fieldIdx = 0;
  let fields = fieldSets[0];
  let drops = 0;
  let saved = 0;
  let total = 0;
  const seen = new Set<string>();

  try {
    // Newest window first, 30 days each.
    for (let w = 0; w * WINDOW_DAYS < span; w++) {
      const end = now - w * WINDOW_DAYS * 86400;
      const start = Math.max(now - span * 86400, end - WINDOW_DAYS * 86400);
      let scrollId: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        let data: any;
        try {
          data = await shopeeGraphql(query(fields, start, end, scrollId));
        } catch (err) {
          if (page === 0 && w === 0) {
            const bad = unknownField(err);
            if (bad && fieldIdx === 0 && drops < 12 && fields.includes(bad)) {
              fields = dropField(fields, bad); // this account doesn't have that field — ask without it
              drops++;
              page = -1;
              continue;
            }
            if (fieldIdx < fieldSets.length - 1 && /cannot query field|unknown field|field/i.test(String(err))) {
              fields = fieldSets[++fieldIdx]; // retry with a smaller fixed set
              page = -1;
              continue;
            }
          }
          throw err;
        }
        const report = data?.conversionReport ?? {};
        const nodes: any[] = report.nodes ?? [];
        for (const n of nodes) {
          const key = `${n?.conversionId ?? ''}_${n?.orders?.[0]?.orderId ?? ''}`;
          if (!n?.conversionId || seen.has(key)) continue;
          seen.add(key);
          total++;
          const s = summarizeConversion(n);
          const purchase = new Date(num(n.purchaseTime) * 1000);
          const click = n.clickTime ? new Date(num(n.clickTime) * 1000) : null;
          const subCode = normalizeSubCode(n.utmContent) || null;
          const channel = channelOf(n.referrer);
          const row = {
            purchaseTime: purchase,
            clickTime: click,
            utmContent: n.utmContent ?? null,
            subCode,
            channel,
            orders: s.orders,
            items: s.items,
            gmv: s.gmv,
            commissionPending: s.pending,
            commissionConfirmed: s.confirmed,
            commissionCancelled: s.cancelled,
            status: s.status,
            fraud: s.fraud,
            raw: n,
          };
          await prisma.shopeeConversion.upsert({ where: { id: key }, update: row, create: { id: key, ...row } });
          const items = itemsOf(n, key, { purchaseTime: purchase, clickTime: click, subCode, channel });
          await prisma.$transaction([
            prisma.shopeeOrderItem.deleteMany({ where: { conversionId: key } }),
            prisma.shopeeOrderItem.createMany({ data: items, skipDuplicates: true }),
          ]);
          saved++;
        }
        const pi = report.pageInfo ?? {};
        if (!pi.hasNextPage || !pi.scrollId || pi.scrollId === scrollId) break;
        scrollId = pi.scrollId;
        await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
      }
    }
  } catch (err) {
    const result = { nodes: total, saved, days: span, error: err instanceof Error ? err.message : String(err) };
    await recordSync(result);
    return result;
  }
  if (!history) {
    await prisma.setting.upsert({ where: { key: HISTORY_KEY }, update: { value: new Date().toISOString() }, create: { key: HISTORY_KEY, value: new Date().toISOString() } });
  }
  const missing = fieldIdx > 0 ? 'campos básicos' : drops ? `sem ${ITEMS_FIELDS.split(/\s+/).filter((f) => /^\w+$/.test(f) && !fields.includes(f)).join(', ')}` : undefined;
  const result = { nodes: total, saved, days: span, ...(missing ? { fields: missing } : {}) };
  await recordSync(result);
  return result;
}

async function recordSync(result: object) {
  const value = JSON.stringify({ at: new Date().toISOString(), ...result });
  await prisma.setting.upsert({ where: { key: 'shopee_sales_last_sync' }, update: { value }, create: { key: 'shopee_sales_last_sync', value } });
}
