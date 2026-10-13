/**
 * Appends ?g=<seq> to every one of our short links in a message, so the
 * /s/:code redirect can tell which destination group the click came from.
 * Links that already carry a query string are left alone.
 */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function tagShortLinks(text: string | null, shortenerBase: string, groupSeq: number): string | null {
  if (!text) return text;
  const base = escapeRegExp(shortenerBase.replace(/\/$/, ''));
  const re = new RegExp(`(${base}/s/[A-Za-z0-9]+)(?![A-Za-z0-9?/])`, 'g');
  return text.replace(re, `$1?g=${groupSeq}`);
}
