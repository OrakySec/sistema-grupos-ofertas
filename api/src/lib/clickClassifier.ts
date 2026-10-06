/**
 * Decides whether a request to a short link (/s/:code) was a person clicking
 * or something else fetching it.
 *
 * Why this matters: every message we send carries /s/ links, and the apps that
 * receive them fetch the link on their own to build the preview card —
 * WhatsApp (through the Evolution API's link preview), Telegram's servers,
 * Meta/Google crawlers, link scanners. Fastify also answers HEAD on every GET
 * route. None of those are people, but the old counter logged all of them as
 * clicks, so the panel showed several times what Mercado Livre actually saw.
 *
 * Classification is deliberately conservative — only well-known fetcher
 * signatures are called BOT, so a real person is never discarded. The raw
 * User-Agent is stored too, so the rules can be tightened later from data.
 */

export type ClickKind = 'HUMAN' | 'BOT';

export interface ClickClassification {
  kind: ClickKind;
  /** Short human-readable label shown in the panel. */
  agent: string;
}

// Link-preview fetchers and well-known crawlers, most specific first. These
// tokens only appear in the User-Agent of the fetchers themselves — in-app
// browsers used by real people (Instagram, Facebook app) have different
// strings (FBAN/FBAV, Instagram), so they are intentionally NOT listed.
const KNOWN_FETCHERS: Array<[RegExp, string]> = [
  [/^whatsapp\//i, 'WhatsApp (prévia)'],
  [/telegrambot/i, 'Telegram (prévia)'],
  [/facebookexternalhit|facebot/i, 'Facebook/Meta (prévia)'],
  [/twitterbot/i, 'X/Twitter (prévia)'],
  [/slackbot|slack-imgproxy/i, 'Slack (prévia)'],
  [/discordbot/i, 'Discord (prévia)'],
  [/linkedinbot/i, 'LinkedIn (prévia)'],
  [/skypeuripreview/i, 'Skype (prévia)'],
  [/googlebot|google-inspectiontool|apis-google|adsbot-google|mediapartners-google|googleother|storebot-google|feedfetcher-google/i, 'Google'],
  [/bingbot|bingpreview|msnbot/i, 'Bing'],
  [/applebot/i, 'Apple'],
];

// Anything else that identifies itself as automation.
// Note on "bot": a bare "...bot" word also appears in phone brands (CUBOT), so
// it only counts when it looks like a crawler token — "SomethingBot/1.0" or
// "bot" as a standalone word — never as part of "Cubot KingKong".
const GENERIC_BOT =
  /[a-z]bot\/|(?:^|[^a-z])bot(?:[^a-z]|$)|crawl(?:er)?|spider|slurp|scanner|monitor|uptime|preview|headlesschrome|lighthouse|python-requests|python-urllib|aiohttp|httpx|axios|node-fetch|undici|go-http-client|java\/|libwww|httpclient|curl\/|wget\/|scrapy|postman|insomnia|pingdom|statuscake|zgrab|masscan|nikto|sqlmap/i;

export function classifyClick(input: { method: string; userAgent: string | undefined }): ClickClassification {
  const ua = (input.userAgent ?? '').trim();

  // A browser navigating to a link sends GET. HEAD is a checker/preview probe.
  if (input.method.toUpperCase() === 'HEAD') return { kind: 'BOT', agent: 'Verificação (HEAD)' };
  if (!ua) return { kind: 'BOT', agent: 'Sem User-Agent' };

  for (const [pattern, label] of KNOWN_FETCHERS) {
    if (pattern.test(ua)) return { kind: 'BOT', agent: label };
  }
  if (GENERIC_BOT.test(ua)) return { kind: 'BOT', agent: 'Outros robôs' };

  return { kind: 'HUMAN', agent: 'Navegador' };
}
