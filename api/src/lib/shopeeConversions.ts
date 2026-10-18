/**
 * Shopee affiliate sales (conversionReport) → ShopeeConversion rows.
 *
 * Re-pulls the last 30 days every run: orders move from PENDING to
 * COMPLETED/CANCELLED weeks after the purchase, and commissions only
 * become final then. Field names follow a working Brazilian integration;
 * a minimal query is used as a fallback if the richer one is rejected.
 */
import prisma from './prisma';
import { shopeeGraphql } from './shopeeApi';

const PAGE_DELAY_MS = 250;
const MAX_PAGES = 200;

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

export async function syncShopeeConversions(days = 30): Promise<{ nodes: number; saved: number; error?: string }> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 86400;
  const fieldSets = [RICH_FIELDS, FULL_FIELDS, MID_FIELDS, MIN_FIELDS];
  let fieldIdx = 0;
  let fields = fieldSets[0];
  let scrollId: string | null = null;
  let saved = 0;
  let total = 0;
  const seen = new Set<string>();

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      let data: any;
      try {
        data = await shopeeGraphql(query(fields, start, end, scrollId));
      } catch (err) {
        if (page === 0 && fieldIdx < fieldSets.length - 1 && /cannot query field|unknown field|field/i.test(String(err))) {
          fields = fieldSets[++fieldIdx]; // a field isn't available on this account — retry with fewer
          page = -1;
          continue;
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
        const data = {
          purchaseTime: purchase,
          clickTime: click,
          utmContent: n.utmContent ?? null,
          subCode: normalizeSubCode(n.utmContent) || null,
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
        await prisma.shopeeConversion.upsert({ where: { id: key }, update: data, create: { id: key, ...data } });
        saved++;
      }
      const pi = report.pageInfo ?? {};
      if (!pi.hasNextPage || !pi.scrollId || pi.scrollId === scrollId) break;
      scrollId = pi.scrollId;
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }
  } catch (err) {
    const result = { nodes: total, saved, error: err instanceof Error ? err.message : String(err) };
    await recordSync(result);
    return result;
  }
  const result = { nodes: total, saved };
  await recordSync(result);
  return result;
}

async function recordSync(result: object) {
  const value = JSON.stringify({ at: new Date().toISOString(), ...result });
  await prisma.setting.upsert({ where: { key: 'shopee_sales_last_sync' }, update: { value }, create: { key: 'shopee_sales_last_sync', value } });
}
