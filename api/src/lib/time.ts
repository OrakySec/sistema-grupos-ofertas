/**
 * Day boundaries and hour buckets in Brasília time (UTC-3, no DST since 2019).
 *
 * The API container runs in UTC, and the stats used `new Date(y, m, d)` /
 * `getHours()` — i.e. UTC days. So "today" ended at 21:00 in Brazil and every
 * hourly chart was shifted by 3h relative to Mercado Livre's own day, which
 * makes comparing the two panels misleading. This does the math explicitly
 * and independently of the process time zone.
 */

const BRT_OFFSET_MS = -3 * 60 * 60 * 1000;

/** Shifts an instant so that its getUTC* fields read as Brasília wall-clock time. */
export function toBrt(date: Date): Date {
  return new Date(date.getTime() + BRT_OFFSET_MS);
}

/**
 * The real instant at which a Brasília day starts (00:00 BRT).
 * daysAgo = 0 → today, 1 → yesterday, -1 → tomorrow.
 */
export function brtDayStart(daysAgo = 0, now: Date = new Date()): Date {
  const b = toBrt(now);
  return new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() - daysAgo) - BRT_OFFSET_MS);
}

const pad2 = (n: number) => n.toString().padStart(2, '0');

/** "HH:00" of the Brasília hour this instant falls in. */
export function brtHourLabel(date: Date): string {
  return `${pad2(toBrt(date).getUTCHours())}:00`;
}

/** "DD/MM" of the Brasília day this instant falls in. */
export function brtDayLabel(date: Date): string {
  const b = toBrt(date);
  return `${pad2(b.getUTCDate())}/${pad2(b.getUTCMonth() + 1)}`;
}

/** "MM/YYYY" of the Brasília month this instant falls in. */
export function brtMonthLabel(date: Date): string {
  const b = toBrt(date);
  return `${pad2(b.getUTCMonth() + 1)}/${b.getUTCFullYear()}`;
}
