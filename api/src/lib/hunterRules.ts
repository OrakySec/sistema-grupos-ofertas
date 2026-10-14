/**
 * Pure rules of the automatic Shopee search — filters, deal score, title
 * clean-up and the offer text. No I/O, so they can be tested on plain data.
 */
import type { ShopeeProductOffer } from './shopeeApi';

export interface HunterFilters {
  forbiddenWords: string[];
  minPrice: number | null;
  maxPrice: number | null;
  minRating: number;
  minSales: number;
  minCommissionPct: number;
  minDiscountPct: number;
  officialOnly: boolean;
}

/** Splits a textarea (one per line, commas also accepted) into clean terms. */
export function parseTerms(text: string | null | undefined): string[] {
  return Array.from(
    new Set(
      String(text ?? '')
        .split(/[\n,;]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  );
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** null = passes; otherwise the (Portuguese) reason it was dropped. */
export function rejectReason(p: ShopeeProductOffer, f: HunterFilters): string | null {
  const name = fold(p.name);
  const bad = f.forbiddenWords.find((w) => name.includes(fold(w)));
  if (bad) return `palavra proibida "${bad}"`;
  if (f.minPrice !== null && p.priceMin < f.minPrice) return 'preço abaixo da faixa';
  if (f.maxPrice !== null && p.priceMin > f.maxPrice) return 'preço acima da faixa';
  if ((p.rating ?? 0) < f.minRating) return 'avaliação baixa';
  if ((p.sales ?? 0) < f.minSales) return 'poucas vendas';
  if (f.minCommissionPct > 0 && (p.commissionPct ?? 0) < f.minCommissionPct) return 'comissão baixa';
  if (f.officialOnly && !p.isOfficial) return 'não é loja oficial';
  return null;
}

// ── Price history ───────────────────────────────────────────────────────────

export interface HistoryStats {
  points: number;
  spanDays: number;
  median: number | null;
  min: number | null;
}

export function historyStats(points: Array<{ price: number; createdAt: Date }>): HistoryStats {
  if (points.length === 0) return { points: 0, spanDays: 0, median: null, min: null };
  const prices = points.map((p) => p.price).sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
  const times = points.map((p) => p.createdAt.getTime());
  const spanDays = (Math.max(...times) - Math.min(...times)) / 86400000;
  return { points: points.length, spanDays, median, min: prices[0] };
}

/** Enough history to trust "normal price": 3+ observations over 2+ days. */
export const historyIsReliable = (h: HistoryStats) => h.points >= 3 && h.spanDays >= 2 && h.median !== null;

// ── Score ───────────────────────────────────────────────────────────────────

export interface ScoreResult {
  score: number;
  discountPct: number | null;
  discountSource: 'HISTORY' | 'ANNOUNCED';
  originalPrice: number | null;
  parts: Record<string, number>;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * 0–100. With reliable history, the drop below our own median price weighs
 * most (up to 45, +5 at the lowest price seen). Without history, Shopee's
 * announced discount counts for less (up to 35) — "-50%" is often inflated.
 * Rating, sales and commission add up to 15 each.
 */
export function scoreProduct(p: ShopeeProductOffer, h: HistoryStats): ScoreResult {
  const parts: Record<string, number> = {};
  let discountPct: number | null = null;
  let discountSource: 'HISTORY' | 'ANNOUNCED' = 'ANNOUNCED';
  let originalPrice: number | null = null;

  if (historyIsReliable(h)) {
    discountSource = 'HISTORY';
    const drop = ((h.median as number) - p.priceMin) / (h.median as number);
    discountPct = Math.max(0, drop * 100);
    originalPrice = drop > 0 ? (h.median as number) : null;
    parts.queda = Math.round(clamp01(drop / 0.3) * 45);
    if (h.min !== null && p.priceMin <= h.min * 1.01) parts.menorPreco = 5;
  } else if (p.discountPct) {
    discountPct = p.discountPct;
    originalPrice = p.priceMin / (1 - p.discountPct / 100);
    parts.desconto = Math.round(clamp01(p.discountPct / 60) * 35);
  }

  parts.avaliacao = Math.round(clamp01(((p.rating ?? 0) - 4.0) / 1.0) * 15);
  parts.vendas = Math.round(clamp01(Math.log10(Math.max(1, p.sales ?? 0)) / 4) * 15); // 10k sold = full
  parts.comissao = Math.round(clamp01((p.commissionPct ?? 0) / 15) * 15);

  const score = Math.min(100, Object.values(parts).reduce((a, b) => a + b, 0));
  return { score, discountPct, discountSource, originalPrice, parts };
}

// ── Title & text ────────────────────────────────────────────────────────────

const NOISE = [
  'original', 'lacrado', 'envio imediato', 'pronta entrega', 'promoção', 'promocao', 'oferta', 'frete grátis',
  'frete gratis', 'lançamento', 'lancamento', 'novo', 'nova', 'barato', 'atacado', 'super', 'top', 'premium',
  'envio rápido', 'envio rapido', 'imperdível', 'imperdivel', 'queima de estoque', 'mega', 'sucesso',
];

/** Shopee titles are long keyword soup — keep the product, drop the shouting. */
export function cleanTitle(name: string, maxLen = 70): string {
  let t = name
    .replace(/[\[{(【].*?[\]})】]/g, ' ') // [promo] {kit} (envio)
    .replace(/[|/\\#*!]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const w of NOISE) {
    t = t.replace(new RegExp(`(^|\\s)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'gi'), ' ');
  }
  t = t.replace(/\s+/g, ' ').trim().replace(/^[-–:,\s]+|[-–:,\s]+$/g, '');
  if (t.length > maxLen) {
    t = t.slice(0, maxLen);
    const cut = t.lastIndexOf(' ');
    if (cut > maxLen * 0.6) t = t.slice(0, cut);
  }
  // Sentence-case shouting titles ("PERFUME MALBEC" → "Perfume malbec")
  if (t === t.toUpperCase() && /[A-Z]/.test(t)) t = t.charAt(0) + t.slice(1).toLowerCase();
  return t || name.slice(0, maxLen);
}

export const brl = (v: number) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtSales = (n: number) =>
  n >= 1000 ? `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: n >= 10000 ? 0 : 1 })} mil vendidos` : `${n} vendidos`;

export interface CouponLine {
  code: string;
  finalPrice: number;
}

export function buildOfferText(opts: {
  product: ShopeeProductOffer;
  originalPrice: number | null;
  discountPct: number | null;
  link: string;
  coupon?: CouponLine | null;
}): string {
  const { product: p, originalPrice, discountPct, link, coupon } = opts;
  const lines: string[] = [`🔥 ${cleanTitle(p.name)}`, ''];
  const fromPrefix = p.priceMax > p.priceMin * 1.05 ? 'A partir de ' : '';
  if (originalPrice && discountPct && discountPct >= 5) {
    lines.push(
      fromPrefix
        ? `A partir de ${brl(p.priceMin)} (-${Math.round(discountPct)}%)`
        : `De ${brl(originalPrice)} por ${brl(p.priceMin)} (-${Math.round(discountPct)}%)`,
    );
  } else {
    lines.push(`${fromPrefix || 'Por '}${brl(p.priceMin)}`);
  }
  if (coupon) lines.push(`🎟️ Com o cupom ${coupon.code}: ${brl(coupon.finalPrice)}`);
  const facts: string[] = [];
  if (p.rating) facts.push(`⭐ ${p.rating.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}`);
  if (p.sales) facts.push(fmtSales(p.sales));
  if (facts.length) lines.push(facts.join(' · '));
  lines.push('', `🛒 ${link}`);
  return lines.join('\n');
}

// ── Sending window ──────────────────────────────────────────────────────────

/** Is this Brasília hour inside the quiet window [start, end)? Handles midnight wrap. */
export function inQuietHours(brtHour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? brtHour >= start && brtHour < end : brtHour >= start || brtHour < end;
}
