/**
 * Meta Marketing API (Graph API) — read campaigns / ad sets / ads and their
 * daily delivery, and pause an entity when a monitoring rule says so.
 *
 * Config (Settings): meta_ads_token (system-user token with ads_read, plus
 * ads_management to be able to pause), meta_ad_account_ids (comma
 * separated, with or without "act_"), meta_api_version (optional).
 */
import axios from 'axios';
import prisma from './prisma';

export class MetaApiError extends Error {}

export interface MetaConfig {
  token: string;
  accounts: string[]; // act_…
  version: string;
}

export async function metaConfig(): Promise<MetaConfig | null> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ['meta_ads_token', 'meta_ad_account_ids', 'meta_api_version'] } },
  });
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value.trim()]));
  if (!m.meta_ads_token || !m.meta_ad_account_ids) return null;
  const accounts = m.meta_ad_account_ids
    .split(/[\s,;]+/)
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => (a.startsWith('act_') ? a : `act_${a}`));
  return { token: m.meta_ads_token, accounts, version: m.meta_api_version || 'v24.0' };
}

async function graphGet(cfg: MetaConfig, path: string, params: Record<string, string> = {}): Promise<any> {
  const url = `https://graph.facebook.com/${cfg.version}/${path}`;
  try {
    const res = await axios.get(url, { params: { ...params, access_token: cfg.token }, timeout: 60000 });
    return res.data;
  } catch (err: any) {
    const e = err.response?.data?.error;
    throw new MetaApiError(e ? `${e.message}${e.code ? ` (código ${e.code})` : ''}` : err.message);
  }
}

/** Follows paging.next until the end. */
async function graphGetAll(cfg: MetaConfig, path: string, params: Record<string, string>): Promise<any[]> {
  const out: any[] = [];
  let page = await graphGet(cfg, path, { limit: '500', ...params });
  for (let guard = 0; guard < 200; guard++) {
    out.push(...(page.data ?? []));
    const next: string | undefined = page.paging?.next;
    if (!next) break;
    try {
      page = (await axios.get(next, { timeout: 60000 })).data;
    } catch (err: any) {
      const e = err.response?.data?.error;
      throw new MetaApiError(e ? e.message : err.message);
    }
  }
  return out;
}

/** "YYYY-MM-DD" of today in the account's time zone. */
export function accountToday(offsetHours: number, now = new Date()): string {
  return new Date(now.getTime() + offsetHours * 3600000).toISOString().slice(0, 10);
}

export function shiftDate(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/** Account time-zone offset (hours), cached in Settings. */
export async function accountOffset(accountId: string): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: `meta_tz_${accountId}` } });
  return row ? Number(row.value) || 0 : -3;
}

export async function testMeta(): Promise<{ ok: boolean; message: string }> {
  const cfg = await metaConfig();
  if (!cfg) return { ok: false, message: 'Token e contas de anúncio não configurados' };
  try {
    const names: string[] = [];
    for (const acc of cfg.accounts) {
      const info = await graphGet(cfg, acc, { fields: 'name,currency,timezone_name,timezone_offset_hours_utc' });
      names.push(`${info.name} (${info.currency}, ${info.timezone_name})`);
    }
    return { ok: true, message: `Conectado: ${names.join(' · ')}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export interface MetaSyncResult {
  account: string;
  campaigns?: number;
  adsets?: number;
  ads?: number;
  insightRows?: number;
  error?: string;
}

/** Imports structure + the last `days` days of daily delivery for every account. */
export async function syncMeta(days = 7): Promise<MetaSyncResult[]> {
  const cfg = await metaConfig();
  if (!cfg) return [];
  const results: MetaSyncResult[] = [];

  for (const acc of cfg.accounts) {
    try {
      const info = await graphGet(cfg, acc, { fields: 'timezone_offset_hours_utc' });
      const offset = Number(info.timezone_offset_hours_utc ?? -3);
      await prisma.setting.upsert({
        where: { key: `meta_tz_${acc}` },
        update: { value: String(offset) },
        create: { key: `meta_tz_${acc}`, value: String(offset) },
      });

      const statusFields = 'id,name,effective_status';
      const [campaigns, adsets, ads] = await Promise.all([
        graphGetAll(cfg, `${acc}/campaigns`, { fields: statusFields }),
        graphGetAll(cfg, `${acc}/adsets`, { fields: `${statusFields},campaign_id` }),
        graphGetAll(cfg, `${acc}/ads`, { fields: `${statusFields},campaign_id,adset_id` }),
      ]);
      const upsert = (id: string, data: { level: string; name: string; status: string; campaignId?: string | null; adsetId?: string | null }) =>
        prisma.metaEntity.upsert({
          where: { id },
          update: { ...data, accountId: acc },
          create: { id, ...data, accountId: acc },
        });
      for (const c of campaigns) await upsert(c.id, { level: 'CAMPAIGN', name: c.name, status: c.effective_status });
      for (const s of adsets) await upsert(s.id, { level: 'ADSET', name: s.name, status: s.effective_status, campaignId: s.campaign_id });
      for (const a of ads) await upsert(a.id, { level: 'AD', name: a.name, status: a.effective_status, campaignId: a.campaign_id, adsetId: a.adset_id });

      const until = accountToday(offset);
      const since = shiftDate(until, -(days - 1));
      const rows = await graphGetAll(cfg, `${acc}/insights`, {
        level: 'ad',
        fields: 'ad_id,adset_id,campaign_id,spend,impressions,clicks,inline_link_clicks,date_start',
        time_increment: '1',
        time_range: JSON.stringify({ since, until }),
      });
      for (const r of rows) {
        const data = {
          adsetId: r.adset_id ?? null,
          campaignId: r.campaign_id ?? null,
          spend: parseFloat(r.spend ?? '0') || 0,
          impressions: parseInt(r.impressions ?? '0', 10) || 0,
          clicks: parseInt(r.clicks ?? '0', 10) || 0,
          linkClicks: parseInt(r.inline_link_clicks ?? '0', 10) || 0,
        };
        await prisma.metaAdDaily.upsert({
          where: { adId_date: { adId: r.ad_id, date: r.date_start } },
          update: data,
          create: { adId: r.ad_id, date: r.date_start, ...data },
        });
      }
      results.push({ account: acc, campaigns: campaigns.length, adsets: adsets.length, ads: ads.length, insightRows: rows.length });
    } catch (err) {
      results.push({ account: acc, error: err instanceof Error ? err.message : String(err) });
    }
  }
  await prisma.setting.upsert({
    where: { key: 'meta_last_sync' },
    update: { value: JSON.stringify({ at: new Date().toISOString(), results }) },
    create: { key: 'meta_last_sync', value: JSON.stringify({ at: new Date().toISOString(), results }) },
  });
  return results;
}

/** Pauses a campaign / ad set / ad (needs ads_management). */
export async function pauseEntity(id: string): Promise<void> {
  const cfg = await metaConfig();
  if (!cfg) throw new MetaApiError('Meta não configurada');
  try {
    await axios.post(`https://graph.facebook.com/${cfg.version}/${id}`, null, {
      params: { status: 'PAUSED', access_token: cfg.token },
      timeout: 30000,
    });
  } catch (err: any) {
    const e = err.response?.data?.error;
    throw new MetaApiError(e ? `${e.message}${e.code ? ` (código ${e.code})` : ''}` : err.message);
  }
}

/** Current effective_status straight from Meta (checked right before pausing). */
export async function liveStatus(id: string): Promise<string | null> {
  const cfg = await metaConfig();
  if (!cfg) return null;
  const r = await graphGet(cfg, id, { fields: 'effective_status' });
  return r.effective_status ?? null;
}
