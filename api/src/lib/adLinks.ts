/**
 * Which Meta ads use which ad link (AdLinkAd).
 *
 * A link can run in many ads — duplicated campaigns usually keep the same
 * link. The tie comes from two places: the URL inside the ad's creative, read
 * on every Meta sync (AUTO), and the user's choice in the panel (MANUAL).
 *
 * Shopee reports one sub-ID per sale, so a sale of a shared link can't be
 * pinned on one ad. It is split by each ad's link clicks instead: on the day
 * of the sale's click when Shopee says it, else over the cookie's 7 days,
 * else evenly. Those numbers are estimates and the panel says so.
 */
import prisma from './prisma';
import { toBrt } from './time';

const DAY_MS = 86400000;

/** Every http(s) URL anywhere inside a creative — its shape varies by ad format. */
export function urlsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) urlsIn(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) urlsIn(v, out);
  }
  return out;
}

const normalizeUrl = (url: string) => url.trim().split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase();
const shortCodeOf = (url: string) => /\/s\/([A-Za-z0-9]+)/.exec(url)?.[1] ?? null;

export interface LinkUrls {
  id: string;
  finalLink: string;
  shopeeLink: string;
}

/** Ids of the links these URLs point to: our short link (any domain) or the link's Shopee URL. */
export function matchLinks(urls: string[], links: LinkUrls[]): string[] {
  const seen = new Set(urls.map(normalizeUrl));
  const codes = new Set(urls.map(shortCodeOf).filter(Boolean));
  return links
    .filter((l) => {
      const code = shortCodeOf(l.finalLink);
      return (code !== null && codes.has(code)) || seen.has(normalizeUrl(l.finalLink)) || seen.has(normalizeUrl(l.shopeeLink));
    })
    .map((l) => l.id);
}

/** Saves what the sync read from the creatives; manual ties are never touched. */
export async function applyDetectedLinks(ads: Array<{ id: string; creative?: unknown }>): Promise<{ checked: number; withUrl: number; linked: number }> {
  const links = await prisma.adLink.findMany({ select: { id: true, finalLink: true, shopeeLink: true } });
  let withUrl = 0;
  let linked = 0;
  for (const ad of ads) {
    const urls = urlsIn(ad.creative);
    if (urls.length === 0) continue; // format we can't read: leave its ties alone
    withUrl++;
    const ids = matchLinks(urls, links);
    if (ids.length) linked++;
    // The ad was edited to another link: its old automatic tie goes away.
    await prisma.adLinkAd.deleteMany({ where: { adId: ad.id, source: 'AUTO', linkId: { notIn: ids } } });
    if (ids.length) {
      await prisma.adLinkAd.createMany({ data: ids.map((linkId) => ({ linkId, adId: ad.id, source: 'AUTO' })), skipDuplicates: true });
    }
  }
  return { checked: ads.length, withUrl, linked };
}

const brtDay = (d: Date) => toBrt(d).toISOString().slice(0, 10);
const shiftDay = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** adId → date → link clicks. */
export type DayClicks = Map<string, Map<string, number>>;

export function dayClicksOf(rows: Array<{ adId: string; date: string; linkClicks: number }>): DayClicks {
  const out: DayClicks = new Map();
  for (const r of rows) {
    const days = out.get(r.adId) ?? new Map<string, number>();
    days.set(r.date, (days.get(r.date) ?? 0) + r.linkClicks);
    out.set(r.adId, days);
  }
  return out;
}

const byWeight = (adIds: string[], weightOf: (adId: string) => number): Array<[string, number]> | null => {
  const total = adIds.reduce((s, id) => s + weightOf(id), 0);
  return total > 0 ? adIds.map((id): [string, number] => [id, weightOf(id) / total]).filter(([, share]) => share > 0) : null;
};

/** How much of one sale of a link goes to each of its ads; the shares add up to 1. */
export function saleShares(adIds: string[], clicks: DayClicks, clickTime: Date | null, purchaseTime: Date): Array<[string, number]> {
  if (adIds.length === 0) return [];
  if (adIds.length === 1) return [[adIds[0], 1]];
  const inRange = (adId: string, from: string, to: string) => {
    let sum = 0;
    for (const [date, n] of clicks.get(adId) ?? []) if (date >= from && date <= to) sum += n;
    return sum;
  };
  if (clickTime) {
    const day = brtDay(clickTime);
    const onClickDay = byWeight(adIds, (id) => inRange(id, day, day));
    if (onClickDay) return onClickDay;
  }
  const end = brtDay(purchaseTime);
  return byWeight(adIds, (id) => inRange(id, shiftDay(end, -7), end)) ?? adIds.map((id): [string, number] => [id, 1 / adIds.length]);
}

/** What to call a link: its name, else the ads it runs in, else its code. */
export function linkLabel(link: { code: string; label: string | null }, adNames: Array<string | undefined>): string {
  if (link.label) return link.label;
  const names = adNames.filter(Boolean) as string[];
  if (names.length === 0) return link.code;
  return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
}
