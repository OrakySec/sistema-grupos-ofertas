/**
 * Shopee coupons learned automatically from the monitored Telegram channels.
 *
 * The telegram-listener forwards every Shopee message that talks about
 * coupons; parseCouponMessage() extracts code / value / minimum / validity,
 * and recordCouponMessage() keeps the Coupon table current:
 *  - a new mention (re)activates the coupon and refreshes lastSeenAt
 *  - "esgotou/acabou/encerrado" next to a known code marks it EXHAUSTED
 *  - expireCoupons(): past the stated validity, 6h without any mention, or
 *    24h old with no stated validity → EXPIRED
 * Nothing here is ever confirmed against Shopee itself (the affiliate API has
 * no coupon endpoint) — it's an estimate from what the channels post.
 */
import prisma from './prisma';
import { brtDayStart } from './time';

export interface ParsedCoupon {
  code: string;
  discountType: 'FIXED' | 'PERCENT';
  value: number;
  maxDiscount: number | null;
  minSpend: number | null;
  validUntil: Date | null;
}

const SILENCE_MS = 6 * 3600000;
const NO_VALIDITY_MAX_MS = 24 * 3600000;
const BRT_OFFSET_MS = -3 * 3600000;

const money = (s: string) => parseFloat(s.replace(/\./g, '').replace(',', '.'));

// Uppercase-ish tokens that look like codes but are just words.
const NOT_CODES = new Set([
  'OFF', 'SHOPEE', 'CUPOM', 'CUPONS', 'CODIGO', 'CÓDIGO', 'FRETE', 'GRATIS', 'GRÁTIS', 'APP', 'PIX', 'HOJE', 'ATE', 'ATÉ',
  'NOVO', 'NOVOS', 'LINK', 'AQUI', 'COMPRAS', 'ACIMA', 'VALIDO', 'VÁLIDO', 'LIMITADO', 'RESGATE', 'USE', 'PARA', 'COM',
  'DESCONTO', 'MERCADOLIVRE', 'AMAZON', 'MAGALU', 'ALIEXPRESS', 'PROMO', 'OFERTA', 'OFERTAS', 'BRL', 'REAIS',
]);

const CODE_AFTER_LABEL = /(?:cupom|cupons|c[óo]digo|use(?:\s+o)?(?:\s+cupom)?)\s*(?:de\s+desconto)?\s*[:\-–➜→»]?\s*[`"'«]?([A-Z0-9][A-Z0-9_-]{3,19})\b/gi;
const EXHAUSTED_RE = /(esgot(?:ou|ado|ada)|acabou|encerrad[oa]|expirou|expirado|n[ãa]o\s+(?:est[áa]\s+)?funciona(?:ndo)?\s+mais|chegou\s+ao\s+limite)/i;

export function isShopeeMessage(text: string): boolean {
  return /shopee|shope\.ee|s\.shopee\.com\.br/i.test(text);
}

/** Stated validity → instant (Brasília time). "até 23h59", "até as 12h", "hoje", "até 31/10". */
export function parseValidity(text: string, now: Date): Date | null {
  const t = text.toLowerCase();
  const brtMidnight = brtDayStart(0, now).getTime(); // instant of today's 00:00 BRT
  const m = t.match(/at[ée]\s*(?:as|às)?\s*(\d{1,2})\s*(?:h|:)\s*(\d{2})?/);
  if (m) {
    const h = Math.min(23, parseInt(m[1], 10));
    const min = m[2] ? Math.min(59, parseInt(m[2], 10)) : 0;
    let at = brtMidnight + (h * 60 + min) * 60000;
    if (at < now.getTime() - 3600000) at += 86400000; // "até 10h" said at 22h → tomorrow
    return new Date(at);
  }
  const d = t.match(/at[ée]\s*(?:o\s+dia\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (d) {
    const brtNow = new Date(now.getTime() + BRT_OFFSET_MS);
    let year = d[3] ? parseInt(d[3], 10) : brtNow.getUTCFullYear();
    if (year < 100) year += 2000;
    const endOfDay = Date.UTC(year, parseInt(d[2], 10) - 1, parseInt(d[1], 10), 23, 59) - BRT_OFFSET_MS;
    return new Date(endOfDay);
  }
  if (/\b(s[óo]\s+)?hoje\b|meia[-\s]?noite/.test(t)) return new Date(brtMidnight + (23 * 60 + 59) * 60000);
  return null;
}

/** Finds the coupons in one message (blocks split by blank lines). */
export function parseCouponMessage(text: string, now = new Date()): ParsedCoupon[] {
  const out: ParsedCoupon[] = [];
  const blocks = text.split(/\n\s*\n/);
  const globalValidity = parseValidity(text, now);
  for (const block of blocks) {
    const codes: string[] = [];
    for (const m of block.matchAll(CODE_AFTER_LABEL)) {
      const code = m[1].toUpperCase();
      if (NOT_CODES.has(code) || !/[A-Z]/.test(code) || /^\d+$/.test(code)) continue;
      if (/^R\$/.test(code)) continue;
      if (!codes.includes(code)) codes.push(code);
    }
    if (codes.length === 0) continue;

    const pct = block.match(/(\d{1,2})\s*%\s*(?:off|de\s+desconto|desconto)/i);
    const fixed = block.match(/R\$\s*(\d{1,4}(?:[.,]\d{2})?)\s*(?:off|de\s+desconto|desconto)/i) ?? block.match(/(?:desconto\s+de|ganhe)\s*R\$\s*(\d{1,4}(?:[.,]\d{2})?)/i);
    const cap = block.match(/(?:m[áa]x(?:imo)?\.?|at[ée]|limite\s+de)\s*R\$\s*(\d{1,4}(?:[.,]\d{2})?)/i);
    const min = block.match(/(?:acima\s+de|compras?\s+(?:m[íi]nimas?\s+)?(?:de|acima\s+de)?|m[íi]nim[oa]\s+(?:de)?|a\s+partir\s+de|pedidos?\s+(?:acima\s+)?de)\s*R\$\s*(\d{1,5}(?:[.,]\d{2})?)/i);

    let discountType: 'FIXED' | 'PERCENT';
    let value: number;
    if (pct) {
      discountType = 'PERCENT';
      value = parseInt(pct[1], 10);
    } else if (fixed) {
      discountType = 'FIXED';
      value = money(fixed[1]);
    } else {
      continue; // a code with no value (frete grátis, etc.) can't change a price
    }
    if (!(value > 0) || (discountType === 'PERCENT' && value >= 90)) continue;
    const minSpend = min ? money(min[1]) : null;
    const maxDiscount = discountType === 'PERCENT' && cap ? money(cap[1]) : null;
    const validUntil = parseValidity(block, now) ?? globalValidity;

    for (const code of codes) out.push({ code, discountType, value, maxDiscount, minSpend, validUntil });
  }
  return out;
}

/** Discount (R$) a coupon gives on this price, or 0 when it doesn't apply. */
export function couponDiscount(c: Pick<ParsedCoupon, 'discountType' | 'value' | 'maxDiscount' | 'minSpend'>, price: number): number {
  if (c.minSpend !== null && price < c.minSpend) return 0;
  let d = c.discountType === 'FIXED' ? c.value : (price * c.value) / 100;
  if (c.maxDiscount !== null) d = Math.min(d, c.maxDiscount);
  return Math.max(0, Math.min(d, price - 0.01));
}

// ── Database side ───────────────────────────────────────────────────────────

export async function couponsEnabled(): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: 'coupons_enabled' } });
  return row?.value === 'true';
}

/** Applies one forwarded channel message: new/refreshed coupons and "esgotou" notices. */
export async function recordCouponMessage(text: string, source: { id?: string | null; name?: string | null }, now = new Date()) {
  if (!isShopeeMessage(text)) return { created: 0, refreshed: 0, exhausted: 0 };
  let created = 0;
  let refreshed = 0;
  let exhausted = 0;

  if (EXHAUSTED_RE.test(text)) {
    const upper = text.toUpperCase();
    const active = await prisma.coupon.findMany({ where: { status: 'ACTIVE' }, select: { id: true, code: true } });
    for (const c of active) {
      if (new RegExp(`\\b${c.code.replace(/[^A-Z0-9_-]/g, '')}\\b`).test(upper)) {
        await prisma.coupon.update({ where: { id: c.id }, data: { status: 'EXHAUSTED', endedAt: now, endReason: 'canal avisou que esgotou' } });
        exhausted++;
      }
    }
    if (exhausted) return { created, refreshed, exhausted };
  }

  for (const p of parseCouponMessage(text, now)) {
    const existing = await prisma.coupon.findUnique({ where: { code: p.code } });
    const src = { id: source.id ?? null, name: source.name ?? null, at: now.toISOString() };
    if (!existing) {
      await prisma.coupon.create({
        data: { ...p, status: 'ACTIVE', sources: [src], sourceCount: 1, mentions: 1, firstSeenAt: now, lastSeenAt: now, sample: text.slice(0, 500) },
      });
      created++;
      continue;
    }
    // An exhausted coupon only comes back when re-posted more than 1h later.
    if (existing.status === 'EXHAUSTED' && existing.endedAt && now.getTime() - existing.endedAt.getTime() < 3600000) continue;
    const sources = (Array.isArray(existing.sources) ? (existing.sources as any[]) : []).filter((s) => s?.id !== src.id);
    sources.push(src);
    await prisma.coupon.update({
      where: { id: existing.id },
      data: {
        discountType: p.discountType,
        value: p.value,
        maxDiscount: p.maxDiscount ?? existing.maxDiscount,
        minSpend: p.minSpend ?? existing.minSpend,
        validUntil: p.validUntil ?? existing.validUntil,
        status: 'ACTIVE',
        endedAt: null,
        endReason: null,
        sources: sources.slice(-10),
        sourceCount: new Set(sources.map((s) => s?.id ?? s?.name)).size,
        mentions: { increment: 1 },
        lastSeenAt: now,
        sample: text.slice(0, 500),
        // a fresh run of mentions restarts the "no validity → 24h" clock
        ...(existing.status !== 'ACTIVE' ? { firstSeenAt: now } : {}),
      },
    });
    refreshed++;
  }
  return { created, refreshed, exhausted };
}

export async function expireCoupons(now = new Date()): Promise<number> {
  const active = await prisma.coupon.findMany({ where: { status: 'ACTIVE' } });
  let n = 0;
  for (const c of active) {
    let reason: string | null = null;
    if (c.validUntil && c.validUntil < now) reason = 'passou da validade';
    else if (now.getTime() - c.lastSeenAt.getTime() > SILENCE_MS) reason = 'nenhum canal mencionou nas últimas 6h';
    else if (!c.validUntil && now.getTime() - c.firstSeenAt.getTime() > NO_VALIDITY_MAX_MS) reason = 'sem validade informada (máx. 24h)';
    if (reason) {
      await prisma.coupon.update({ where: { id: c.id }, data: { status: 'EXPIRED', endedAt: now, endReason: reason } });
      n++;
    }
  }
  return n;
}

/** Best currently-active coupon for this price, or null. */
export async function bestCouponFor(price: number): Promise<{ code: string; finalPrice: number } | null> {
  await expireCoupons();
  const active = await prisma.coupon.findMany({ where: { status: 'ACTIVE' } });
  let best: { id: string; code: string; discount: number } | null = null;
  for (const c of active) {
    const d = couponDiscount(c as any, price);
    if (d > 0 && (!best || d > best.discount)) best = { id: c.id, code: c.code, discount: d };
  }
  if (!best) return null;
  await prisma.coupon.update({ where: { id: best.id }, data: { usedCount: { increment: 1 } } });
  return { code: best.code, finalPrice: Math.round((price - best.discount) * 100) / 100 };
}
