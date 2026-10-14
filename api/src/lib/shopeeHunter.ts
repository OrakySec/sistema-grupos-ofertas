/**
 * Automatic Shopee search, one per niche.
 *
 *   runHunter      — searches every keyword, records prices, filters, scores
 *                    and stores the good ones as candidates
 *   dispatchHunter — when a sending slot is open (daily limit, spacing,
 *                    quiet hours), turns the best candidate into an Offer
 *   hunterTick     — the worker's periodic entry point for all niches
 *
 * Offers go out through the niche's virtual SHOPEE source group, so the
 * normal pipeline (destinations, footer, shortener tagging, health,
 * analytics) applies unchanged.
 */
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import prisma from './prisma';
import { addSendOfferJob } from './queue';
import { brtDayStart, toBrt } from './time';
import { searchProducts, generateShortLink, type ShopeeProductOffer } from './shopeeApi';
import { createShortUrl, shouldShorten } from './shortener';
import { bestCouponFor, couponsEnabled } from './coupons';
import {
  parseTerms,
  rejectReason,
  historyStats,
  scoreProduct,
  buildOfferText,
  inQuietHours,
  type HunterFilters,
} from './hunterRules';

const LISTENER_URL = process.env.TELEGRAM_LISTENER_URL ?? 'http://telegram-listener:8080';
const MEDIA_BASE_PATH = process.env.MEDIA_BASE_PATH ?? '/app/media';
const DAY_MS = 86400000;
const READY_TTL_MS = 6 * 3600000; // a found deal older than this may no longer be valid
const REPEAT_DAYS = 7;
const REPEAT_PRICE_DROP = 0.95; // …unless the price fell at least 5% since it was sent
const MAX_KEYWORDS = 25;

type Hunter = NonNullable<Awaited<ReturnType<typeof prisma.shopeeHunter.findUnique>>>;

// ── Setup ───────────────────────────────────────────────────────────────────

/** The niche's hunter, creating it (and its virtual source group) on first use. */
export async function ensureHunter(nicheId: string) {
  const existing = await prisma.shopeeHunter.findUnique({ where: { nicheId } });
  if (existing) return existing;
  const niche = await prisma.niche.findUniqueOrThrow({ where: { id: nicheId } });
  // Synthetic id far outside Telegram's range — the listener never sees SHOPEE groups.
  const telegramId = BigInt(9_000_000_000_000_000) + BigInt(Date.now()) * 10n + BigInt(Math.floor(Math.random() * 10));
  const source = await prisma.sourceGroup.create({
    data: { name: `Busca Shopee · ${niche.name}`, kind: 'SHOPEE', telegramId, nicheId, isActive: true },
  });
  return prisma.shopeeHunter.create({ data: { nicheId, sourceGroupId: source.id } });
}

function filtersOf(h: Hunter): HunterFilters {
  return {
    forbiddenWords: parseTerms(h.forbiddenWords),
    minPrice: h.minPrice,
    maxPrice: h.maxPrice,
    minRating: h.minRating,
    minSales: h.minSales,
    minCommissionPct: h.minCommissionPct,
    minDiscountPct: h.minDiscountPct,
    officialOnly: h.officialOnly,
  };
}

// ── Search ──────────────────────────────────────────────────────────────────

async function upsertProduct(p: ShopeeProductOffer) {
  const data = {
    name: p.name,
    imageUrl: p.imageUrl,
    productLink: p.productLink,
    offerLink: p.offerLink,
    shopName: p.shopName,
    isOfficial: p.isOfficial,
    ratingStar: p.rating,
    sales: p.sales === null ? null : Math.round(p.sales),
    commissionPct: p.commissionPct,
    lastPrice: p.priceMin,
    lastPriceMax: p.priceMax,
    lastDiscountPct: p.discountPct,
    lastSeenAt: new Date(),
  };
  const product = await prisma.shopeeProduct.upsert({
    where: { shopId_itemId: { shopId: p.shopId, itemId: p.itemId } },
    update: data,
    create: { ...data, shopId: p.shopId, itemId: p.itemId },
  });
  // One price point per change, or at most every 6h when it doesn't change.
  const last = await prisma.shopeePricePoint.findFirst({ where: { productId: product.id }, orderBy: { createdAt: 'desc' } });
  if (!last || Math.abs(last.price - p.priceMin) > 0.009 || Date.now() - last.createdAt.getTime() > 6 * 3600000) {
    await prisma.shopeePricePoint.create({ data: { productId: product.id, price: p.priceMin, discountPct: p.discountPct } });
  }
  return product;
}

export interface RunSummary {
  at: string;
  keywords: number;
  found: number;
  passed: number;
  newCandidates: number;
  rejected: Record<string, number>;
  errors: string[];
}

export async function runHunter(hunterId: string): Promise<RunSummary> {
  const hunter = await prisma.shopeeHunter.findUniqueOrThrow({ where: { id: hunterId } });
  const keywords = parseTerms(hunter.keywords).slice(0, MAX_KEYWORDS);
  const filters = filtersOf(hunter);
  const summary: RunSummary = { at: new Date().toISOString(), keywords: keywords.length, found: 0, passed: 0, newCandidates: 0, rejected: {}, errors: [] };
  const reject = (r: string) => (summary.rejected[r] = (summary.rejected[r] ?? 0) + 1);
  const seen = new Set<string>();
  const status = hunter.mode === 'PREVIEW' ? 'PREVIEW' : 'READY';

  for (const keyword of keywords) {
    let products: ShopeeProductOffer[] = [];
    try {
      products = (await searchProducts(keyword)).products;
    } catch (err) {
      summary.errors.push(`${keyword}: ${err instanceof Error ? err.message : String(err)}`);
      // Credentials/signature problems will fail every keyword the same way.
      if (/credencia|signature|configurad|10020/i.test(String(err))) break;
      continue;
    }
    for (const p of products) {
      const key = `${p.shopId}:${p.itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      summary.found++;

      const product = await upsertProduct(p);
      const why = rejectReason(p, filters);
      if (why) { reject(why); continue; }

      const history = historyStats(
        await prisma.shopeePricePoint.findMany({
          where: { productId: product.id, createdAt: { gte: new Date(Date.now() - 30 * DAY_MS) } },
          select: { price: true, createdAt: true },
        }),
      );
      const s = scoreProduct(p, history);
      if ((s.discountPct ?? 0) < filters.minDiscountPct) { reject('desconto pequeno'); continue; }
      if (s.score < hunter.minScore) { reject('nota baixa'); continue; }

      // Don't repeat a product sent recently, unless it got clearly cheaper.
      const lastSent = await prisma.hunterCandidate.findFirst({
        where: { productId: product.id, status: { in: ['QUEUED', 'SENT'] }, decidedAt: { gte: new Date(Date.now() - REPEAT_DAYS * DAY_MS) } },
        orderBy: { decidedAt: 'desc' },
      });
      if (lastSent && p.priceMin > lastSent.price * REPEAT_PRICE_DROP) { reject('enviado nos últimos 7 dias'); continue; }

      summary.passed++;
      const fields = {
        keyword,
        price: p.priceMin,
        originalPrice: s.originalPrice,
        discountPct: s.discountPct,
        discountSource: s.discountSource,
        score: s.score,
        scoreDetail: s.parts,
        createdAt: new Date(),
      };
      // Same product still waiting in this niche → refresh it instead of duplicating.
      const open = await prisma.hunterCandidate.findFirst({
        where: { hunterId, productId: product.id, status: { in: ['PREVIEW', 'READY'] } },
      });
      if (open) {
        await prisma.hunterCandidate.update({ where: { id: open.id }, data: { ...fields, status } });
      } else {
        await prisma.hunterCandidate.create({ data: { ...fields, hunterId, productId: product.id, status } });
        summary.newCandidates++;
      }
    }
    await new Promise((r) => setTimeout(r, 400)); // be gentle with the API
  }

  await prisma.shopeeHunter.update({
    where: { id: hunterId },
    data: { lastRunAt: new Date(), lastRunSummary: summary as any },
  });
  return summary;
}

// ── Turning a candidate into an offer ───────────────────────────────────────

async function composeImage(imageUrl: string, niche: { mockupTemplatePath: string | null; mockupBoxLeft: number | null; mockupBoxTop: number | null; mockupBoxRight: number | null; mockupBoxBottom: number | null; mockupCornerRadius: number | null }, name: string): Promise<string | null> {
  const box = [niche.mockupBoxLeft, niche.mockupBoxTop, niche.mockupBoxRight, niche.mockupBoxBottom];
  const template =
    niche.mockupTemplatePath && box.every((v) => v !== null) && niche.mockupCornerRadius !== null
      ? { template_path: niche.mockupTemplatePath, box, corner_radius: niche.mockupCornerRadius }
      : null;
  // The listener owns the mockup composer (Pillow) — ask it first.
  try {
    const res = await axios.post(`${LISTENER_URL}/hunter/image`, { image_url: imageUrl, template, name }, { timeout: 45000 });
    if (res.data?.path) return res.data.path as string;
  } catch {
    // fall through to a plain download
  }
  try {
    const res = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 20000 });
    const rel = path.join('hunter', `${name}.jpg`);
    fs.mkdirSync(path.join(MEDIA_BASE_PATH, 'hunter'), { recursive: true });
    fs.writeFileSync(path.join(MEDIA_BASE_PATH, rel), Buffer.from(res.data));
    return rel;
  } catch {
    return null;
  }
}

export async function createOfferFromCandidate(candidateId: string, approved: boolean) {
  const c = await prisma.hunterCandidate.findUniqueOrThrow({
    where: { id: candidateId },
    include: { product: true, hunter: { include: { niche: true } } },
  });
  const p = c.product;
  const niche = c.hunter.niche;
  const log: any[] = [
    {
      ts: new Date().toISOString(), step: 'hunter', status: 'ok', label: 'Busca Shopee',
      detail: `Palavra-chave "${c.keyword}" · nota ${c.score}` +
        (c.discountPct ? ` · ${Math.round(c.discountPct)}% ${c.discountSource === 'HISTORY' ? 'abaixo do preço normal' : 'de desconto anunciado'}` : ''),
    },
  ];

  // Affiliate link: official short link (sub-ids identify the niche in Shopee's reports).
  const origin = p.productLink ?? `https://shopee.com.br/product/${p.shopId}/${p.itemId}`;
  let affiliate = p.offerLink ?? origin;
  try {
    affiliate = await generateShortLink(origin, ['busca', (niche.slug ?? niche.name).replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || 'nicho']);
  } catch (err) {
    log.push({ ts: new Date().toISOString(), step: 'hunter_link', status: 'info', label: 'Link de afiliado', detail: `generateShortLink falhou (${err instanceof Error ? err.message : err}) — usando o link da oferta` });
  }
  let finalLink = affiliate;
  if (await shouldShorten('shopee')) {
    try {
      finalLink = (await createShortUrl(affiliate)).shortUrl;
    } catch {
      finalLink = affiliate;
    }
  }
  log.push({ ts: new Date().toISOString(), step: 'url', status: 'ok', label: 'Conversão de link', original: origin, platform: 'Shopee', affiliate, shortened: finalLink !== affiliate ? finalLink : null, final: finalLink });

  const offerProduct = {
    itemId: p.itemId, shopId: p.shopId, name: p.name, imageUrl: p.imageUrl, productLink: p.productLink, offerLink: p.offerLink,
    shopName: p.shopName, isOfficial: p.isOfficial, priceMin: c.price, priceMax: Math.max(p.lastPriceMax ?? c.price, c.price),
    discountPct: p.lastDiscountPct, rating: p.ratingStar, sales: p.sales, commissionPct: p.commissionPct,
  };
  const coupon = c.hunter.useCoupons && (await couponsEnabled()) ? await bestCouponFor(c.price) : null;
  if (coupon) log.push({ ts: new Date().toISOString(), step: 'coupon', status: 'ok', label: 'Cupom', detail: `${coupon.code}: ${c.price.toFixed(2)} → ${coupon.finalPrice.toFixed(2)}` });
  const text = buildOfferText({ product: offerProduct, originalPrice: c.originalPrice, discountPct: c.discountPct, link: finalLink, coupon });

  const imagePath = p.imageUrl ? await composeImage(p.imageUrl, niche, `${p.shopId}_${p.itemId}_${Date.now()}`) : null;
  log.push({ ts: new Date().toISOString(), step: 'mockup', status: imagePath ? 'ok' : 'error', label: 'Imagem do produto', ...(imagePath ? { detail: 'Foto da API da Shopee' } : { error: 'Não foi possível baixar a foto — enviada sem imagem' }) });

  const offer = await prisma.offer.create({
    data: {
      sourceGroupId: c.hunter.sourceGroupId,
      telegramMessageId: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
      text: imagePath ? null : text,
      mediaType: imagePath ? 'PHOTO' : 'NONE',
      mediaLocalPath: imagePath,
      mediaCaption: imagePath ? text : null,
      senderName: 'Busca Shopee',
      status: approved ? 'APPROVED' : 'PENDING',
      originalDate: new Date(),
      reviewedAt: approved ? new Date() : null,
      processingLog: log,
    },
  });
  await prisma.hunterCandidate.update({
    where: { id: c.id },
    data: { status: approved ? 'SENT' : 'QUEUED', offerId: offer.id, decidedAt: new Date() },
  });
  if (approved) await addSendOfferJob(offer.id);
  return offer;
}

// ── Sending slots ───────────────────────────────────────────────────────────

export async function dispatchHunter(hunter: Hunter): Promise<string | null> {
  if (!['APPROVAL', 'AUTO', 'AUTO_BEST'].includes(hunter.mode)) return null;
  const now = new Date();
  if (inQuietHours(toBrt(now).getUTCHours(), hunter.quietStart, hunter.quietEnd)) return 'horário de silêncio';

  const dispatched = { hunterId: hunter.id, status: { in: ['QUEUED', 'SENT'] } };
  const today = await prisma.hunterCandidate.count({ where: { ...dispatched, decidedAt: { gte: brtDayStart(0, now) } } });
  if (today >= hunter.dailyLimit) return 'limite diário atingido';
  const last = await prisma.hunterCandidate.findFirst({ where: dispatched, orderBy: { decidedAt: 'desc' } });
  if (last?.decidedAt && now.getTime() - last.decidedAt.getTime() < hunter.minIntervalMin * 60000) return 'aguardando intervalo';

  const best = await prisma.hunterCandidate.findFirst({
    where: { hunterId: hunter.id, status: 'READY', createdAt: { gte: new Date(now.getTime() - READY_TTL_MS) } },
    orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
  });
  if (!best) return 'nenhuma oferta na fila';
  const approved = hunter.mode === 'AUTO' || (hunter.mode === 'AUTO_BEST' && best.score >= hunter.autoMinScore);
  await createOfferFromCandidate(best.id, approved);
  return approved ? 'enviada' : 'na fila de aprovação';
}

// ── Periodic entry point (worker) ───────────────────────────────────────────

export async function hunterTick(): Promise<Array<{ niche: string; ran?: RunSummary; dispatch?: string | null; error?: string }>> {
  const hunters = await prisma.shopeeHunter.findMany({ where: { mode: { not: 'OFF' } }, include: { niche: true } });
  const out: Array<{ niche: string; ran?: RunSummary; dispatch?: string | null; error?: string }> = [];
  for (const h of hunters) {
    const entry: { niche: string; ran?: RunSummary; dispatch?: string | null; error?: string } = { niche: h.niche.name };
    try {
      const due = !h.lastRunAt || Date.now() - h.lastRunAt.getTime() >= h.intervalHours * 3600000;
      if (due && parseTerms(h.keywords).length) entry.ran = await runHunter(h.id);
      entry.dispatch = await dispatchHunter(h);
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
    }
    out.push(entry);
  }
  // Housekeeping: stale waiting deals expire; old previews/expired rows go away.
  await prisma.hunterCandidate.updateMany({
    where: { status: 'READY', createdAt: { lt: new Date(Date.now() - READY_TTL_MS) } },
    data: { status: 'EXPIRED', decidedAt: new Date() },
  });
  await prisma.hunterCandidate.deleteMany({
    where: { status: { in: ['PREVIEW', 'EXPIRED'] }, createdAt: { lt: new Date(Date.now() - 14 * DAY_MS) } },
  });
  return out;
}
