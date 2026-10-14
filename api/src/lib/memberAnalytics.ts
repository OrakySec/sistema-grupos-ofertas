/**
 * Pure calculations behind the WhatsApp group analytics page — no database
 * access here, so the math can be tested on plain arrays.
 */
import { brtDayStart, brtDayLabel, brtHourLabel, toBrt } from './time';

export interface MemberEventRow {
  destinationGroupId: string;
  memberHash: string;
  type: string; // JOIN | LEAVE | KICK
  memberJoinedAt: Date | null;
  createdAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isExit = (t: string) => t === 'LEAVE' || t === 'KICK';

export interface PeriodStats {
  joins: number;
  leaves: number; // left on their own
  kicks: number; // removed by an admin
  net: number;
  membersStart: number | null;
  /** % of (members at start + joins) still in the group at the end. */
  retentionPct: number | null;
  /** exits / members at start, in %. */
  churnPct: number | null;
  /** Left less than 24h after joining (only stints whose start we know). */
  quickLeaves: number;
  avgTenureDays: number | null;
}

export function periodStats(events: MemberEventRow[], membersNow: number | null): PeriodStats {
  const joins = events.filter((e) => e.type === 'JOIN').length;
  const leaves = events.filter((e) => e.type === 'LEAVE').length;
  const kicks = events.filter((e) => e.type === 'KICK').length;
  const exits = leaves + kicks;
  const net = joins - exits;

  const tenures = events
    .filter((e) => isExit(e.type) && e.memberJoinedAt)
    .map((e) => e.createdAt.getTime() - (e.memberJoinedAt as Date).getTime());
  const quickLeaves = tenures.filter((ms) => ms < DAY_MS).length;
  const avgTenureDays = tenures.length ? tenures.reduce((a, b) => a + b, 0) / tenures.length / DAY_MS : null;

  const membersStart = membersNow === null ? null : Math.max(0, membersNow - net);
  const base = membersStart === null ? 0 : membersStart + joins;
  const retentionPct = base > 0 ? Math.max(0, Math.min(100, ((base - exits) / base) * 100)) : null;
  const churnPct = membersStart ? (exits / membersStart) * 100 : null;

  return { joins, leaves, kicks, net, membersStart, retentionPct, churnPct, quickLeaves, avgTenureDays };
}

export interface Cohort {
  label: string; // "DD/MM" — Monday-less: first BRT day of the 7-day block
  size: number;
  d1: number | null;
  d7: number | null;
  d30: number | null;
}

/**
 * Join cohorts in 7-day blocks (newest first). For each join, the stint ends
 * at the member's next exit in the same group. Retention at Dk counts only
 * joins at least k days old — younger ones can't be judged yet.
 */
export function cohorts(events: MemberEventRow[], now: Date, days: number, rangeEnd: Date = now): Cohort[] {
  // Blocks end at the selected range's last day; retention is judged as of now.
  const ref = new Date(Math.min(rangeEnd.getTime(), now.getTime()) - 1);
  const sorted = [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const nextExit = new Map<number, Date | null>(); // index of JOIN → exit time
  const openJoin = new Map<string, number>(); // group|member → index of open JOIN
  sorted.forEach((e, i) => {
    const key = `${e.destinationGroupId}|${e.memberHash}`;
    if (e.type === 'JOIN') {
      openJoin.set(key, i);
      nextExit.set(i, null);
    } else if (isExit(e.type) && openJoin.has(key)) {
      nextExit.set(openJoin.get(key) as number, e.createdAt);
      openJoin.delete(key);
    }
  });

  const blocks = Math.max(1, Math.ceil(days / 7));
  const out: Cohort[] = [];
  for (let b = 0; b < blocks; b++) {
    const end = brtDayStart(b * 7 - 1, ref); // exclusive: start of the day after the block
    const start = brtDayStart(b * 7 + 6, ref);
    const joins = sorted
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.type === 'JOIN' && e.createdAt >= start && e.createdAt < end);
    const rate = (k: number): number | null => {
      const eligible = joins.filter(({ e }) => now.getTime() - e.createdAt.getTime() >= k * DAY_MS);
      if (eligible.length === 0) return null;
      const kept = eligible.filter(({ e, i }) => {
        const exit = nextExit.get(i);
        return !exit || exit.getTime() - e.createdAt.getTime() > k * DAY_MS;
      });
      return (kept.length / eligible.length) * 100;
    };
    out.push({ label: brtDayLabel(start), size: joins.length, d1: rate(1), d7: rate(7), d30: rate(30) });
  }
  return out;
}

export interface SeriesPoint {
  date: string;
  members: number | null;
  joins: number;
  exits: number;
  offers: number;
  clicks: number;
}

/**
 * Series over [start, end) in Brasília time: one point per day, or per hour
 * when the range is a single day. Member counts are rebuilt backwards from
 * the count at `end` using each bucket's net change; buckets that ended
 * before tracking started have no member count.
 */
export function rangeSeries(opts: {
  start: Date;
  end: Date;
  bucket: 'day' | 'hour';
  membersEnd: number | null;
  trackingSince: Date | null;
  events: MemberEventRow[];
  offers: Date[];
  clicks: Date[];
}): SeriesPoint[] {
  const { start, end, bucket, membersEnd, trackingSince } = opts;
  const step = bucket === 'hour' ? 3600000 : DAY_MS;
  const starts: Date[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += step) starts.push(new Date(t));
  const n = starts.length;

  const indexOf = (d: Date) => {
    if (d < start || d >= end) return -1;
    return Math.min(n - 1, Math.floor((d.getTime() - start.getTime()) / step));
  };
  const joins = new Array(n).fill(0);
  const exits = new Array(n).fill(0);
  const offers = new Array(n).fill(0);
  const clicks = new Array(n).fill(0);
  for (const e of opts.events) {
    const i = indexOf(e.createdAt);
    if (i < 0) continue;
    if (e.type === 'JOIN') joins[i]++;
    else if (isExit(e.type)) exits[i]++;
  }
  for (const d of opts.offers) { const i = indexOf(d); if (i >= 0) offers[i]++; }
  for (const d of opts.clicks) { const i = indexOf(d); if (i >= 0) clicks[i]++; }

  const members: (number | null)[] = new Array(n).fill(null);
  if (membersEnd !== null) {
    let running = membersEnd;
    for (let i = n - 1; i >= 0; i--) {
      const bucketEnd = i + 1 < n ? starts[i + 1] : end;
      if (trackingSince && bucketEnd < trackingSince) break;
      members[i] = Math.max(0, running);
      running -= joins[i] - exits[i];
    }
  }

  return starts.map((t, i) => ({
    date: bucket === 'hour' ? brtHourLabel(t) : brtDayLabel(t),
    members: members[i],
    joins: joins[i],
    exits: exits[i],
    offers: offers[i],
    clicks: clicks[i],
  }));
}

/** Counts per Brasília hour of day (0–23). */
export function byHour(dates: Date[]): number[] {
  const out = new Array(24).fill(0);
  for (const d of dates) out[toBrt(d).getUTCHours()]++;
  return out;
}
