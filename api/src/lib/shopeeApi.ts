/**
 * Shopee Affiliate Open API (Brazil) — GraphQL, signed with
 *   Authorization: SHA256 Credential=<appId>, Timestamp=<ts>, Signature=<sha256(appId+ts+body+secret)>
 * The signature covers the exact request body, so the body string is built
 * once and sent as-is. Credentials come from Settings (shopee_app_id /
 * shopee_app_secret) — the same ones the telegram-listener uses.
 */
import axios from 'axios';
import { createHash } from 'crypto';
import prisma from './prisma';

const ENDPOINT = process.env.SHOPEE_API_URL ?? 'https://open-api.affiliate.shopee.com.br/graphql';

export class ShopeeApiError extends Error {}

async function credentials(): Promise<{ appId: string; secret: string }> {
  const rows = await prisma.setting.findMany({ where: { key: { in: ['shopee_app_id', 'shopee_app_secret'] } } });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value.trim()]));
  if (!map.shopee_app_id || !map.shopee_app_secret) {
    throw new ShopeeApiError('App ID / Secret da Shopee não configurados (Configurações → Links de Afiliado)');
  }
  return { appId: map.shopee_app_id, secret: map.shopee_app_secret };
}

export async function shopeeGraphql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const { appId, secret } = await credentials();
  const body = JSON.stringify({ query, variables });
  const ts = Math.floor(Date.now() / 1000);
  const signature = createHash('sha256').update(`${appId}${ts}${body}${secret}`).digest('hex');
  let data: any;
  try {
    const res = await axios.post(ENDPOINT, body, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `SHA256 Credential=${appId}, Timestamp=${ts}, Signature=${signature}`,
      },
      timeout: 20000,
      transformRequest: [(d) => d], // keep the signed body byte-for-byte
      validateStatus: () => true,
    });
    data = res.data;
    if (typeof data !== 'object' || data === null) throw new ShopeeApiError(`HTTP ${res.status}: resposta inválida`);
  } catch (err) {
    if (err instanceof ShopeeApiError) throw err;
    throw new ShopeeApiError(`falha de rede: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (Array.isArray(data.errors) && data.errors.length) {
    const e = data.errors[0];
    const code = e?.extensions?.code;
    throw new ShopeeApiError(`${e?.message ?? 'erro desconhecido'}${code ? ` (código ${code})` : ''}`);
  }
  return data.data as T;
}

// ── productOfferV2 ──────────────────────────────────────────────────────────

/** sortType values of productOfferV2. */
export const SORT = { RELEVANCE: 1, MOST_SOLD: 2, PRICE_DESC: 3, PRICE_ASC: 4, COMMISSION: 5 } as const;

const PRODUCT_FIELDS = `
  itemId shopId productName imageUrl productLink offerLink shopName shopType
  priceMin priceMax priceDiscountRate ratingStar sales commissionRate`;

const SEARCH_QUERY = `query Search($keyword: String, $sortType: Int, $page: Int, $limit: Int) {
  productOfferV2(keyword: $keyword, sortType: $sortType, page: $page, limit: $limit) {
    nodes { ${PRODUCT_FIELDS} }
    pageInfo { page limit hasNextPage }
  }
}`;

export interface ShopeeProductOffer {
  itemId: bigint;
  shopId: bigint;
  name: string;
  imageUrl: string | null;
  productLink: string | null;
  offerLink: string | null;
  shopName: string | null;
  isOfficial: boolean;
  priceMin: number;
  priceMax: number;
  discountPct: number | null; // Shopee's own announced discount, in %
  rating: number | null;
  sales: number | null;
  commissionPct: number | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
};

/** Normalizes one productOfferV2 node; null when it lacks an id or a price. */
export function parseProductNode(n: any): ShopeeProductOffer | null {
  const priceMin = num(n?.priceMin);
  if (n?.itemId === undefined || n?.shopId === undefined || priceMin === null || priceMin <= 0) return null;
  const priceMax = num(n?.priceMax) ?? priceMin;
  const commission = num(n?.commissionRate);
  const discount = num(n?.priceDiscountRate);
  return {
    itemId: BigInt(String(n.itemId)),
    shopId: BigInt(String(n.shopId)),
    name: String(n.productName ?? '').trim(),
    imageUrl: n.imageUrl ?? null,
    productLink: n.productLink ?? null,
    offerLink: n.offerLink ?? null,
    shopName: n.shopName ?? null,
    // shopType 1 = official shop (Shopee Mall)
    isOfficial: Array.isArray(n.shopType) && n.shopType.map(Number).includes(1),
    priceMin,
    priceMax: Math.max(priceMax, priceMin),
    discountPct: discount !== null && discount > 0 ? discount : null,
    rating: num(n.ratingStar),
    sales: num(n.sales),
    // Comes as a fraction ("0.08") — tolerate a percentage too.
    commissionPct: commission === null ? null : commission <= 1 ? commission * 100 : commission,
  };
}

export async function searchProducts(keyword: string, opts: { sortType?: number; limit?: number; page?: number } = {}) {
  const data = await shopeeGraphql<{ productOfferV2: { nodes: any[] } }>(SEARCH_QUERY, {
    keyword,
    sortType: opts.sortType ?? SORT.MOST_SOLD,
    page: opts.page ?? 1,
    limit: opts.limit ?? 50,
  });
  const nodes = data?.productOfferV2?.nodes ?? [];
  return {
    raw: nodes,
    products: nodes.map(parseProductNode).filter(Boolean) as ShopeeProductOffer[],
  };
}

/** Official affiliate short link; subIds show up in Shopee's conversion report. */
export async function generateShortLink(originUrl: string, subIds: string[] = []): Promise<string> {
  const data = await shopeeGraphql<{ generateShortLink: { shortLink: string } }>(
    `mutation Link($originUrl: String!, $subIds: [String!]) {
      generateShortLink(input: { originUrl: $originUrl, subIds: $subIds }) { shortLink }
    }`,
    { originUrl, subIds: subIds.slice(0, 5) },
  );
  const link = data?.generateShortLink?.shortLink;
  if (!link) throw new ShopeeApiError('A API não devolveu o link');
  return link;
}
