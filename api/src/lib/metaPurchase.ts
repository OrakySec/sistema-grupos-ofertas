/**
 * Server-side Purchase (Meta Conversions API) for Shopee sales that came from an ad.
 *
 * Shopee never tells us who bought, so the buyer is found through the ad click:
 *   1. every real ad click (fbclid) on an AdLink short link stores the browser
 *      data Meta matches on (fbc, fbp, IP, user agent) in AdClick;
 *   2. a sale carrying that ad's sub-ID is tied to the AdClick closest to the
 *      clickTime Shopee reports (the jump from our link to Shopee happens within
 *      seconds); without clickTime, the latest click shortly before the purchase;
 *   3. a Purchase goes to the Shopee-traffic pixel with that browser data and
 *      value = commission (what the sale is actually worth to us).
 *
 * Each sale is sent once (event_id = purchase_<conversion id>). Meta rejects
 * events older than 7 days, so older sales are marked TOO_OLD instead.
 * AdClick keeps the raw IP only for that window and is purged after 8 days.
 */
import axios from 'axios';
import { createHash } from 'crypto';
import prisma from './prisma';
import { shopeePixelConfig } from './metaCapi';

const DAY_MS = 86_400_000;
const MAX_EVENT_AGE_MS = 7 * DAY_MS - 30 * 60_000; // a little margin under Meta's 7 days
const CLICK_TOLERANCE_MS = 10 * 60_000; // our click → Shopee's clickTime
const NO_CLICKTIME_WINDOW_MS = 3 * 3600_000; // fallback: click at most 3h before the purchase
const KEEP_CLICKS_MS = 8 * DAY_MS;
const MAX_ATTEMPTS = 5;

const sha256 = (s: string) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');
const r2 = (v: number) => Math.round(v * 100) / 100;

export type PurchaseStatus = 'SENT' | 'FAILED' | 'NO_MATCH' | 'TOO_OLD' | 'SKIPPED';

/** Store the browser data of one real ad click (called from the /s/:code redirect). */
export async function recordAdClick(input: { id: string; adCode: string; shortCode: string; fbc: string | null; fbp: string; ip: string; userAgent: string | null }) {
  await prisma.adClick.create({ data: input });
}

/** The stored ad click that most likely led to this sale, if any. */
export function pickClick<T extends { createdAt: Date }>(clicks: T[], purchaseTime: Date, clickTime: Date | null): { click: T; approximate: boolean } | null {
  if (clickTime) {
    let best: T | null = null;
    let bestGap = Infinity;
    for (const c of clicks) {
      const gap = Math.abs(c.createdAt.getTime() - clickTime.getTime());
      if (gap < bestGap) { best = c; bestGap = gap; }
    }
    return best && bestGap <= CLICK_TOLERANCE_MS ? { click: best, approximate: false } : null;
  }
  const before = clicks
    .filter((c) => c.createdAt.getTime() <= purchaseTime.getTime() && purchaseTime.getTime() - c.createdAt.getTime() <= NO_CLICKTIME_WINDOW_MS)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return before.length ? { click: before[0], approximate: true } : null;
}

/** Item ids / order ids out of the stored conversionReport node. */
function saleDetails(raw: unknown) {
  const orders: any[] = Array.isArray((raw as any)?.orders) ? (raw as any).orders : [];
  const items = orders.flatMap((o) => (Array.isArray(o?.items) ? o.items : []));
  return {
    orderIds: orders.map((o) => String(o?.orderId ?? '')).filter(Boolean),
    itemIds: [...new Set(items.map((it) => String(it?.itemId ?? '')).filter(Boolean))],
    names: items.map((it) => String(it?.itemName ?? '')).filter(Boolean),
    numItems: items.reduce((a, it) => a + (Number(it?.qty) || 1), 0),
  };
}

async function mark(id: string, status: PurchaseStatus, detail: string, clickId: string | null, attempts?: number) {
  await prisma.shopeeConversion.update({
    where: { id },
    data: {
      purchaseEventStatus: status,
      purchaseEventDetail: detail.slice(0, 500),
      purchaseEventAt: new Date(),
      purchaseClickId: clickId,
      ...(attempts !== undefined && { purchaseEventAttempts: attempts }),
    },
  });
}

/** Sends a Purchase for every ad sale not sent yet. Runs after each Shopee sales sync. */
export async function sendPendingPurchases(now = new Date()): Promise<{ sent: number; failed: number; noMatch: number; tooOld: number; skipped?: string }> {
  const out = { sent: 0, failed: 0, noMatch: 0, tooOld: 0 };
  await prisma.adClick.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - KEEP_CLICKS_MS) } } });

  const cfg = await shopeePixelConfig();
  if (!cfg) return { ...out, skipped: 'pixel não configurado' };

  const links = await prisma.adLink.findMany({ select: { code: true, label: true, productUrl: true } });
  if (!links.length) return out;
  const linkBy = new Map(links.map((l) => [l.code, l]));

  const sales = await prisma.shopeeConversion.findMany({
    where: {
      subCode: { in: [...linkBy.keys()] },
      OR: [{ purchaseEventStatus: null }, { purchaseEventStatus: 'FAILED', purchaseEventAttempts: { lt: MAX_ATTEMPTS } }],
    },
    orderBy: { purchaseTime: 'asc' },
    take: 200,
  });
  const domain = ((await prisma.setting.findUnique({ where: { key: 'shortener_domain' } }))?.value || 'https://ofertas.ykaromarques.com').replace(/\/$/, '');

  for (const sale of sales) {
    // Cancelled / fraud: nothing to report (it would teach Meta the wrong buyers).
    if (sale.fraud || sale.status === 'CANCELLED') {
      await mark(sale.id, 'SKIPPED', sale.fraud ? 'Marcada como fraude pela Shopee — não enviada' : 'Pedido cancelado — não enviado', null);
      continue;
    }
    if (now.getTime() - sale.purchaseTime.getTime() > MAX_EVENT_AGE_MS) {
      await mark(sale.id, 'TOO_OLD', 'Venda com mais de 7 dias — a Meta não aceita mais', null);
      out.tooOld++;
      continue;
    }
    const code = sale.subCode as string;
    const clicks = await prisma.adClick.findMany({
      where: { adCode: code, createdAt: { gte: new Date(sale.purchaseTime.getTime() - 7 * DAY_MS), lte: new Date(sale.purchaseTime.getTime() + CLICK_TOLERANCE_MS) } },
    });
    const match = pickClick(clicks, sale.purchaseTime, sale.clickTime);
    if (!match) {
      await mark(sale.id, 'NO_MATCH', clicks.length
        ? 'Nenhum clique do anúncio perto do horário do clique informado pela Shopee'
        : 'Nenhum clique do anúncio registrado antes da venda (cliques anteriores a esta função não foram guardados)', null);
      out.noMatch++;
      continue;
    }

    const { click } = match;
    const d = saleDetails(sale.raw);
    const link = linkBy.get(code);
    const value = r2(sale.commissionPending + sale.commissionConfirmed);
    const userData: Record<string, unknown> = {
      client_ip_address: click.ip,
      client_user_agent: click.userAgent ?? '',
      fbp: click.fbp,
      external_id: [sha256(click.fbp)],
    };
    if (click.fbc) userData.fbc = click.fbc;
    const customData: Record<string, unknown> = {
      currency: 'BRL',
      value,
      content_type: 'product',
      num_items: d.numItems || sale.items || 1,
      order_id: d.orderIds.join(',') || sale.id,
      ad_link: code,
      order_value: r2(sale.gmv),
    };
    if (d.itemIds.length) customData.content_ids = d.itemIds;
    if (d.names.length) customData.content_name = d.names.join(' | ').slice(0, 200);
    else if (link?.label) customData.content_name = link.label;

    const body: Record<string, unknown> = {
      data: [{
        event_name: 'Purchase',
        event_time: Math.floor(sale.purchaseTime.getTime() / 1000),
        event_id: `purchase_${sale.id}`,
        event_source_url: `${domain}/s/${click.shortCode}`,
        action_source: 'website',
        user_data: userData,
        custom_data: customData,
      }],
    };
    if (cfg.testCode) body.test_event_code = cfg.testCode;

    try {
      const res = await axios.post(`https://graph.facebook.com/${cfg.version}/${cfg.pixelId}/events`, body, {
        params: { access_token: cfg.token },
        timeout: 15000,
      });
      await mark(sale.id, 'SENT',
        `Enviada à Meta: R$ ${value.toFixed(2).replace('.', ',')} (${res.data?.events_received ?? '?'} evento)${match.approximate ? ' · clique aproximado (a Shopee não informou o horário do clique)' : ''}${cfg.testCode ? ' · modo teste' : ''}`,
        click.id);
      out.sent++;
    } catch (err: any) {
      const e = err.response?.data?.error;
      const msg = e ? `${e.error_user_msg || e.message}${e.code ? ` (código ${e.code})` : ''}` : err.message;
      await mark(sale.id, 'FAILED', `Meta recusou: ${msg}`, click.id, sale.purchaseEventAttempts + 1);
      out.failed++;
    }
  }
  return out;
}
