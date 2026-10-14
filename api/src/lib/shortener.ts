/**
 * Our own link shortener (ofertas.ykaromarques.com/s/<code>). Shared by the
 * /s/internal route (used by the telegram-listener) and the automatic
 * Shopee search in the worker.
 */
import prisma from './prisma';

const POOL = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export async function shortenerDomain(): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key: 'shortener_domain' } });
  return (row?.value || 'https://ofertas.ykaromarques.com').replace(/\/$/, '');
}

/** Returns { code, shortUrl }, reusing the existing code when this URL was shortened before. */
export async function createShortUrl(url: string): Promise<{ code: string; shortUrl: string }> {
  const domain = await shortenerDomain();
  const existing = await prisma.shortUrl.findFirst({ where: { originalUrl: url } });
  if (existing) return { code: existing.code, shortUrl: `${domain}/s/${existing.code}` };

  for (let attempt = 0; attempt < 10; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += POOL.charAt(Math.floor(Math.random() * POOL.length));
    const conflict = await prisma.shortUrl.findUnique({ where: { code } });
    if (conflict) continue;
    const created = await prisma.shortUrl.create({ data: { code, originalUrl: url } });
    return { code: created.code, shortUrl: `${domain}/s/${created.code}` };
  }
  throw new Error('Failed to generate a unique short code');
}

/**
 * Should links of this platform be shortened? Mirrors the listener's rule:
 * shortener on, and either no platform list (= all) or the platform is in it.
 */
export async function shouldShorten(platform: string): Promise<boolean> {
  const rows = await prisma.setting.findMany({ where: { key: { in: ['link_shortener_enabled', 'shortener_platforms'] } } });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (map.link_shortener_enabled === 'false') return false;
  const list = (map.shortener_platforms ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  return list.length === 0 || list.includes(platform);
}
