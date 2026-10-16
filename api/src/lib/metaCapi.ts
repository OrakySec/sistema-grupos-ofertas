/**
 * Server-side ViewContent (Meta Conversions API) for clicks on ad links.
 *
 * When someone taps an ad's link (ofertas…/s/<code> belonging to an AdLink),
 * the redirect to Shopee is immediate and, in the background, a ViewContent
 * goes to the dedicated "Shopee traffic" pixel with everything Meta can use
 * to tie it to the ad click:
 *   - fbc: from the _fbc cookie, or built from the ?fbclid Meta appends to
 *          the ad's URL (fb.1.<ms>.<fbclid>) — this is what links event→ad
 *   - fbp: from the _fbp cookie, or generated (fb.1.<ms>.<random>) and set as
 *          a first-party cookie so the same person keeps the same browser id
 *   - client_ip_address + client_user_agent (required for website events)
 *   - external_id: sha256 of the fbp — a stable anonymous visitor id
 *   - custom_data: product id / name, content_type=product, BRL
 * Only real people trigger it (bots and link previews never do).
 *
 * Settings: meta_shopee_pixel_id, meta_shopee_capi_token,
 * meta_shopee_test_code (optional, Events Manager → Test events).
 */
import axios from 'axios';
import { createHash, randomInt } from 'crypto';
import prisma from './prisma';

export const COOKIE_MAX_AGE_S = 90 * 24 * 3600; // Meta keeps fbc/fbp 90 days

const sha256 = (s: string) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const FBC_RE = /^fb\.\d\.\d{10,13}\..+$/;
const FBP_RE = /^fb\.\d\.\d{10,13}\.\d+$/;

/** fbc from the cookie, else built from fbclid. A new fbclid always wins (it's the latest ad click). */
export function resolveFbc(cookieFbc: string | undefined, fbclid: string | undefined, nowMs = Date.now()): string | null {
  if (fbclid && fbclid.length >= 10) {
    // Keep the cookie when it already carries this exact click id (preserves its timestamp).
    if (cookieFbc && FBC_RE.test(cookieFbc) && cookieFbc.endsWith(`.${fbclid}`)) return cookieFbc;
    return `fb.1.${nowMs}.${fbclid}`;
  }
  return cookieFbc && FBC_RE.test(cookieFbc) ? cookieFbc : null;
}

export function resolveFbp(cookieFbp: string | undefined, nowMs = Date.now()): { fbp: string; isNew: boolean } {
  if (cookieFbp && FBP_RE.test(cookieFbp)) return { fbp: cookieFbp, isNew: false };
  return { fbp: `fb.1.${nowMs}.${randomInt(1_000_000_000, 2_147_483_647)}`, isNew: true };
}

/** Shopee item id out of a product URL (…/product/<shop>/<item> or …-i.<shop>.<item>). */
export function shopeeItemId(url: string): string | null {
  const m = /\/product\/\d+\/(\d+)/.exec(url) ?? /-i\.\d+\.(\d+)/.exec(url);
  return m ? m[1] : null;
}

export interface ViewContentInput {
  eventId: string;
  eventTimeS: number;
  sourceUrl: string;
  ip: string;
  userAgent: string;
  fbc: string | null;
  fbp: string;
  productUrl: string;
  productName: string | null;
  adCode: string;
}

export function buildViewContent(i: ViewContentInput) {
  const userData: Record<string, unknown> = {
    client_ip_address: i.ip,
    client_user_agent: i.userAgent,
    fbp: i.fbp,
    external_id: [sha256(i.fbp)],
  };
  if (i.fbc) userData.fbc = i.fbc;
  const itemId = shopeeItemId(i.productUrl);
  const customData: Record<string, unknown> = {
    content_type: 'product',
    currency: 'BRL',
    ad_link: i.adCode,
  };
  if (itemId) customData.content_ids = [itemId];
  if (i.productName) customData.content_name = i.productName;
  return {
    event_name: 'ViewContent',
    event_time: i.eventTimeS,
    event_id: i.eventId,
    event_source_url: i.sourceUrl,
    action_source: 'website',
    user_data: userData,
    custom_data: customData,
  };
}

export async function shopeePixelConfig(): Promise<{ pixelId: string; token: string; testCode: string | null; version: string } | null> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ['meta_shopee_pixel_id', 'meta_shopee_capi_token', 'meta_shopee_test_code', 'meta_api_version'] } },
  });
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value.trim()]));
  if (!m.meta_shopee_pixel_id || !m.meta_shopee_capi_token) return null;
  return { pixelId: m.meta_shopee_pixel_id, token: m.meta_shopee_capi_token, testCode: m.meta_shopee_test_code || null, version: m.meta_api_version || 'v24.0' };
}

/** Sends one event; records the outcome so the panel can show it. */
export async function sendViewContent(input: ViewContentInput): Promise<{ ok: boolean; detail: string }> {
  const cfg = await shopeePixelConfig();
  if (!cfg) return { ok: false, detail: 'pixel não configurado' };
  const body: Record<string, unknown> = { data: [buildViewContent(input)] };
  if (cfg.testCode) body.test_event_code = cfg.testCode;
  let result: { ok: boolean; detail: string };
  try {
    const res = await axios.post(`https://graph.facebook.com/${cfg.version}/${cfg.pixelId}/events`, body, {
      params: { access_token: cfg.token },
      timeout: 15000,
    });
    result = { ok: true, detail: `recebido pela Meta (${res.data?.events_received ?? '?'} evento)${cfg.testCode ? ' · modo teste' : ''}` };
  } catch (err: any) {
    const e = err.response?.data?.error;
    result = { ok: false, detail: e ? `${e.message}${e.code ? ` (código ${e.code})` : ''}` : err.message };
  }
  const now = new Date().toISOString();
  const statsKey = 'meta_shopee_capi_stats';
  const row = await prisma.setting.findUnique({ where: { key: statsKey } });
  let stats: { day: string; sent: number; failed: number; last?: unknown } = { day: now.slice(0, 10), sent: 0, failed: 0 };
  try { if (row) stats = JSON.parse(row.value); } catch { /* reset */ }
  if (stats.day !== now.slice(0, 10)) stats = { day: now.slice(0, 10), sent: 0, failed: 0 };
  if (result.ok) stats.sent++; else stats.failed++;
  stats.last = { at: now, ...result, fbc: !!input.fbc };
  await prisma.setting.upsert({ where: { key: statsKey }, update: { value: JSON.stringify(stats) }, create: { key: statsKey, value: JSON.stringify(stats) } });
  return result;
}
