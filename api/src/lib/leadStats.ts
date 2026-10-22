/**
 * Results of the lead queue — the Analytics view for people the system put
 * into groups: how many got in (added directly or joined through the private
 * invite), how many left afterwards, retention after 1/7/30 days, invite
 * conversion, broken down by list, destination group, source and number.
 *
 * "Got in" = Lead.joinedAt (set when added, or when an invited person shows
 * up in the group — webhook or the 6 h check). Leaves only count when the
 * person's phone is visible (see lib/leadBlocks.ts).
 */
import prisma from './prisma';
import { brtDateStart, brtDayLabel, brtDayStart, brtHourLabel } from './time';

const DAY_MS = 86_400_000;
const r1 = (v: number) => Math.round(v * 10) / 10;
const pct = (a: number, b: number) => (b > 0 ? r1((a / b) * 100) : null);

type Row = {
  campaignId: string; status: string; source: string; groupId: string | null; instanceId: string | null;
  processedAt: Date | null; joinedAt: Date | null; leftAt: Date | null;
};

const inRange = (d: Date | null, start: Date, end: Date) => !!d && d >= start && d < end;

export function summarize(rows: Row[], start: Date, end: Date, now: Date) {
  const processed = rows.filter((r) => inRange(r.processedAt, start, end));
  const count = (s: string) => processed.filter((r) => r.status === s).length;
  const invitesSent = processed.filter((r) => r.status === 'INVITED');
  const invitesJoined = invitesSent.filter((r) => r.joinedAt).length;

  const entered = rows.filter((r) => inRange(r.joinedAt, start, end) && (r.status === 'ADDED' || r.status === 'INVITED'));
  const left = entered.filter((r) => r.leftAt);
  const quick = left.filter((r) => r.leftAt!.getTime() - r.joinedAt!.getTime() < DAY_MS).length;
  const tenure = left.map((r) => (r.leftAt!.getTime() - r.joinedAt!.getTime()) / DAY_MS);

  const stayed = (days: number) => {
    const eligible = entered.filter((r) => now.getTime() - r.joinedAt!.getTime() >= days * DAY_MS);
    const kept = eligible.filter((r) => !r.leftAt || r.leftAt.getTime() - r.joinedAt!.getTime() >= days * DAY_MS).length;
    return { eligible: eligible.length, pct: pct(kept, eligible.length) };
  };

  return {
    processed: processed.length,
    added: count('ADDED'),
    invitesSent: invitesSent.length,
    invitesJoined,
    inviteConversionPct: pct(invitesJoined, invitesSent.length),
    alreadyMember: count('ALREADY_MEMBER'),
    noWhatsApp: count('NO_WHATSAPP'),
    blocked: count('BLOCKED'),
    failed: count('FAILED'),
    entered: entered.length,
    left: left.length,
    stillIn: entered.length - left.length,
    retentionPct: pct(entered.length - left.length, entered.length),
    leftPct: pct(left.length, entered.length),
    quickLeaves: quick,
    avgTenureDays: tenure.length ? r1(tenure.reduce((a, b) => a + b, 0) / tenure.length) : null,
    d1: stayed(1),
    d7: stayed(7),
    d30: stayed(30),
  };
}

export interface LeadResultsQuery { days?: number; from?: string; to?: string; campaignId?: string; instanceId?: string }

export async function leadResults(tenantId: string, q: LeadResultsQuery) {
  const now = new Date();
  let start: Date;
  let end: Date;
  const from = q.from ? brtDateStart(q.from) : null;
  const to = q.to ? brtDateStart(q.to) : null;
  if (from && to) {
    start = from <= to ? from : to;
    end = new Date((from <= to ? to : from).getTime() + DAY_MS);
  } else {
    const days = Math.min(365, Math.max(1, Math.round(Number(q.days) || 30)));
    start = brtDayStart(days - 1, now);
    end = brtDayStart(-1, now);
  }

  const where = {
    tenantId,
    ...(q.campaignId ? { campaignId: q.campaignId } : {}),
    ...(q.instanceId ? { instanceId: q.instanceId } : {}),
    OR: [
      { processedAt: { gte: start, lt: end } },
      { joinedAt: { gte: start, lt: end } },
      { leftAt: { gte: start, lt: end } },
    ],
  };
  const rows: Row[] = await prisma.lead.findMany({
    where,
    select: { campaignId: true, status: true, source: true, groupId: true, instanceId: true, processedAt: true, joinedAt: true, leftAt: true },
  });

  // Daily series (hourly for a single day): who got in, who left.
  const hourly = end.getTime() - start.getTime() <= DAY_MS;
  const buckets: Array<{ date: string; entered: number; left: number; invitesSent: number }> = [];
  const index = new Map<string, number>();
  const stepMs = hourly ? 3_600_000 : DAY_MS;
  for (let t = start.getTime(); t < end.getTime() && buckets.length < 400; t += stepMs) {
    const label = hourly ? brtHourLabel(new Date(t)) : brtDayLabel(new Date(t));
    index.set(label, buckets.length);
    buckets.push({ date: label, entered: 0, left: 0, invitesSent: 0 });
  }
  const bump = (d: Date | null, key: 'entered' | 'left' | 'invitesSent') => {
    if (!inRange(d, start, end)) return;
    const i = index.get(hourly ? brtHourLabel(d!) : brtDayLabel(d!));
    if (i !== undefined) buckets[i][key]++;
  };
  for (const r of rows) {
    if (r.status === 'ADDED' || r.status === 'INVITED') bump(r.joinedAt, 'entered');
    if (r.joinedAt) bump(r.leftAt, 'left');
    if (r.status === 'INVITED') bump(r.processedAt, 'invitesSent');
  }

  // Breakdowns.
  const [campaigns, groups, instances] = await Promise.all([
    prisma.leadCampaign.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.destinationGroup.findMany({ select: { id: true, name: true } }),
    prisma.whatsAppInstance.findMany({ where: { tenantId }, select: { id: true, label: true } }),
  ]);
  const names = {
    campaign: new Map(campaigns.map((c) => [c.id, c.name])),
    group: new Map(groups.map((g) => [g.id, g.name])),
    instance: new Map(instances.map((i) => [i.id, i.label])),
    source: new Map([['LIST', 'Lista colada / CSV'], ['INTAKE', 'Página de captura (webhook)'], ['GROUP', 'Membros de outro grupo']]),
  };
  const breakdown = (keyOf: (r: Row) => string | null, nameOf: Map<string, string>) => {
    const by = new Map<string, Row[]>();
    for (const r of rows) {
      const k = keyOf(r);
      if (!k) continue;
      by.set(k, [...(by.get(k) ?? []), r]);
    }
    return [...by.entries()]
      .map(([key, rs]) => ({ key, label: nameOf.get(key) ?? '(removido)', ...summarize(rs, start, end, now) }))
      .filter((x) => x.processed || x.entered || x.left)
      .sort((a, b) => b.entered - a.entered || b.processed - a.processed);
  };

  const lastCheck = await prisma.setting.findUnique({ where: { key: 'lead_membership_check' } });
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    bucket: hourly ? 'hour' : 'day',
    totals: summarize(rows, start, end, now),
    series: buckets,
    byCampaign: breakdown((r) => r.campaignId, names.campaign),
    byGroup: breakdown((r) => r.groupId, names.group),
    bySource: breakdown((r) => r.source, names.source),
    byInstance: breakdown((r) => r.instanceId, names.instance),
    lastCheck: lastCheck ? JSON.parse(lastCheck.value) : null,
    options: {
      campaigns: campaigns.map((c) => ({ id: c.id, name: c.name })),
      instances: instances.map((i) => ({ id: i.id, label: i.label })),
    },
  };
}
