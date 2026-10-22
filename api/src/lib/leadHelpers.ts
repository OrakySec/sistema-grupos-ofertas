/**
 * Phones that add people by hand ("Adicionar pelo celular" lists).
 *
 * Every day, at the phone's send hour, the main number sends it its own
 * batch: a message with the instructions + a .vcf with the people to add
 * (lib/leadManual.ts makes the batch, so nobody is in two batches and the
 * usual filters apply). Each phone has its own safety settings, like the
 * numbers of the automatic queue:
 *   - people per day, with an optional warm-up (start low, +N per day)
 *   - rest cycle: after N people sent, D days off
 *   - weekdays and the hour the batch is sent (Brasília)
 *   - people not added after X days go back to the queue
 * Who got in is detected the same way as the owner's batches (webhook + the
 * 15-min check), so the phone only has to add them.
 */
import prisma from './prisma';
import { brtDayStart, toBrt } from './time';
import { makeManualBatch, vcardOf, vcfFileName } from './leadManual';
import { WhatsAppService } from '../services/whatsapp.service';

export interface HelperSafety {
  dailyLimit: number;
  warmup: boolean;
  warmupStart: number;
  warmupStep: number;
  restEvery: number; // people sent; 0 = never rest
  restDays: number;
  weekdays: number[]; // 0 = Sunday … 6 = Saturday
  sendHour: number; // 0-23, Brasília
  expireDays: number; // not added after this → back to the queue
  message: string;
}

export const DEFAULT_HELPER_MESSAGE =
  'Oi {{nome}}! 📋 Lista de hoje: *{{quantidade}} pessoas* para adicionar.\n\n' +
  '1. Abra o arquivo abaixo e salve os contatos.\n' +
  '2. No grupo: *Dados do grupo → Adicionar participantes*, busque o nome indicado e marque (de 5 em 5, com calma).\n\n' +
  '{{grupos}}\n\n' +
  'O sistema confere sozinho quem entrou. Obrigado!';

export const DEFAULT_HELPER_SAFETY: HelperSafety = {
  dailyLimit: 15,
  warmup: true,
  warmupStart: 5,
  warmupStep: 3,
  restEvery: 60,
  restDays: 1,
  weekdays: [1, 2, 3, 4, 5, 6],
  sendHour: 9,
  expireDays: 2,
  message: DEFAULT_HELPER_MESSAGE,
};

const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

export function helperSafetyOf(raw: unknown): HelperSafety {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<HelperSafety>;
  const d = DEFAULT_HELPER_SAFETY;
  const weekdays = Array.isArray(r.weekdays)
    ? [...new Set(r.weekdays.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort()
    : d.weekdays;
  return {
    dailyLimit: clampInt(r.dailyLimit, 1, 200, d.dailyLimit),
    warmup: typeof r.warmup === 'boolean' ? r.warmup : d.warmup,
    warmupStart: clampInt(r.warmupStart, 1, 200, d.warmupStart),
    warmupStep: clampInt(r.warmupStep, 0, 100, d.warmupStep),
    restEvery: clampInt(r.restEvery, 0, 5000, d.restEvery),
    restDays: clampInt(r.restDays, 0, 30, d.restDays),
    weekdays: weekdays.length ? weekdays : d.weekdays,
    sendHour: clampInt(r.sendHour, 0, 23, d.sendHour),
    expireDays: clampInt(r.expireDays, 1, 30, d.expireDays),
    message: typeof r.message === 'string' && r.message.trim() ? r.message.slice(0, 1500) : d.message,
  };
}

const DAY_MS = 86_400_000;

/** People allowed today: the daily limit, ramped up during warm-up (counted from the first batch). */
export function helperDailyLimit(s: HelperSafety, warmupFrom: Date | null, now = new Date()): number {
  if (!s.warmup) return s.dailyLimit;
  if (!warmupFrom) return Math.min(s.dailyLimit, s.warmupStart);
  const days = Math.max(0, Math.floor((brtDayStart(0, now).getTime() - brtDayStart(0, warmupFrom).getTime()) / DAY_MS));
  return Math.min(s.dailyLimit, s.warmupStart + s.warmupStep * days);
}

/** Next instant this phone's batch is due (send hour on an allowed weekday), from `from`. */
export function nextSendAt(s: HelperSafety, from: Date): Date {
  for (let d = 0; d < 9; d++) {
    const dayStart = brtDayStart(-d, from); // brtDayStart(-1) = tomorrow 00:00 BRT
    const at = new Date(dayStart.getTime() + s.sendHour * 3_600_000);
    if (at >= from && s.weekdays.includes(toBrt(at).getUTCDay())) return at;
  }
  return new Date(from.getTime() + DAY_MS);
}

type HelperRow = NonNullable<Awaited<ReturnType<typeof prisma.leadHelper.findUnique>>>;

async function sentToday(helperId: string, now: Date) {
  return prisma.lead.count({ where: { helperId, processedAt: { gte: brtDayStart(0, now) } } });
}

/** Why the batch isn't due now (null = due). `force` ("Enviar agora") skips the hour/weekday/once-a-day checks. */
function notDue(h: HelperRow, s: HelperSafety, now: Date, force: boolean): string | null {
  if (h.paused) return h.pausedReason ?? 'pausado';
  if (h.restUntil && h.restUntil > now) return 'em descanso';
  if (force) return null;
  const b = toBrt(now);
  if (!s.weekdays.includes(b.getUTCDay())) return 'dia sem envio';
  if (b.getUTCHours() < s.sendHour) return 'antes do horário';
  if (h.lastSentAt && h.lastSentAt >= brtDayStart(0, now)) return 'já enviado hoje';
  return null;
}

export function renderHelperMessage(template: string, vars: Record<string, string>) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '').trim();
}

/** Builds and sends this phone's batch. Returns what happened (also stored in lastResult). */
export async function sendHelperBatch(helperId: string, opts: { now?: Date; force?: boolean } = {}): Promise<{ sent: number; result: string }> {
  const now = opts.now ?? new Date();
  const h = await prisma.leadHelper.findUnique({ where: { id: helperId } });
  if (!h) return { sent: 0, result: 'celular não encontrado' };
  const s = helperSafetyOf(h.safety);
  const why = notDue(h, s, now, !!opts.force);
  if (why) return { sent: 0, result: why };

  const done = async (result: string, data: Record<string, unknown> = {}) => {
    await prisma.leadHelper.update({ where: { id: h.id }, data: { lastResult: result, ...data } });
    return { sent: 0, result };
  };

  const limit = helperDailyLimit(s, h.warmupFrom, now);
  let room = limit - (await sentToday(h.id, now));
  if (s.restEvery > 0) room = Math.min(room, s.restEvery - h.sinceRest);
  if (room <= 0) return done(`Limite de hoje (${limit}) já enviado`, opts.force ? {} : { lastSentAt: now });

  const links = await prisma.leadCampaignHelper.findMany({
    where: { helperId: h.id, campaign: { status: 'ACTIVE', mode: 'MANUAL' } },
    include: { campaign: { select: { id: true, name: true, createdAt: true } } },
  });
  const lists = links.map((l) => l.campaign).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (!lists.length) return done('Nenhuma lista "Adicionar pelo celular" ativa para este celular');

  const people: Array<{ id: string; phone: string; name: string | null; group: string; prefix: string }> = [];
  const problems: string[] = [];
  for (const list of lists) {
    if (room <= 0) break;
    const r = await makeManualBatch(h.tenantId, list.id, room, { helperId: h.id, now });
    if (!r.ok) { problems.push(`${list.name}: ${r.error}`); continue; }
    for (const p of r.batch) people.push({ ...p, prefix: r.prefix });
    room -= r.batch.length;
  }
  if (!people.length) {
    return done(problems.length ? `Nada enviado — ${problems.join(' | ')}` : 'Nada para enviar: as filas das listas estão vazias', opts.force ? {} : { lastSentAt: now });
  }

  // One line per group: how many and what to search for.
  const byGroup = new Map<string, { prefix: string; n: number }[]>();
  for (const p of people) {
    const list = byGroup.get(p.group) ?? [];
    const hit = list.find((x) => x.prefix === p.prefix);
    if (hit) hit.n++; else list.push({ prefix: p.prefix, n: 1 });
    byGroup.set(p.group, list);
  }
  const groupsText = [...byGroup.entries()]
    .map(([g, parts]) => parts.map((x) => `• *${g}*: ${x.n} ${x.n === 1 ? 'pessoa' : 'pessoas'} — busque "${x.prefix}"`).join('\n'))
    .join('\n');
  const text = renderHelperMessage(s.message, { nome: h.label.split(' ')[0], quantidade: String(people.length), grupos: groupsText });
  const vcf = vcardOf(people);
  const fileName = vcfFileName(people.length && byGroup.size === 1 ? people[0].prefix : `Lista ${h.label} ${people[0].prefix.split(' ').pop()}`);

  try {
    const wa = new WhatsAppService();
    await wa.sendText(h.phone, text);
    await wa.sendDocumentData(h.phone, vcf, fileName, 'text/vcard', `${people.length} contatos para adicionar`);
  } catch (err) {
    // Not delivered → the people go back to the queue for the next try.
    await prisma.lead.updateMany({
      where: { id: { in: people.map((p) => p.id) } },
      data: { status: 'QUEUED', helperId: null, groupId: null, detail: null },
    });
    return done(`Falhou ao enviar pelo número principal: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
  }

  const since = h.sinceRest + people.length;
  const rest = s.restEvery > 0 && s.restDays > 0 && since >= s.restEvery;
  const when = now.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  const result = `${people.length} pessoa(s) enviadas às ${when}${problems.length ? ` (avisos: ${problems.join(' | ')})` : ''}${rest ? ` — descansa ${s.restDays} dia(s)` : ''}`;
  await prisma.leadHelper.update({
    where: { id: h.id },
    data: {
      lastSentAt: now,
      lastResult: result,
      warmupFrom: h.warmupFrom ?? now,
      sinceRest: rest ? 0 : since,
      ...(rest ? { restUntil: new Date(now.getTime() + s.restDays * DAY_MS) } : {}),
    },
  });
  return { sent: people.length, result };
}

/** People a phone didn't add within its expiry go back to the queue (another batch / phone). */
export async function expireHelperPending(now = new Date()) {
  const helpers = await prisma.leadHelper.findMany({ select: { id: true, label: true, safety: true } });
  let total = 0;
  for (const h of helpers) {
    const s = helperSafetyOf(h.safety);
    const r = await prisma.lead.updateMany({
      where: { helperId: h.id, status: 'MANUAL_PENDING', processedAt: { lt: new Date(now.getTime() - s.expireDays * DAY_MS) } },
      data: { status: 'QUEUED', helperId: null, groupId: null, detail: `Não foi adicionado por "${h.label}" em ${s.expireDays} dia(s) — voltou para a fila` },
    });
    total += r.count;
  }
  return total;
}

/** Worker tick: expire stale batches, then send every phone whose batch is due. */
export async function helpersTick(now = new Date()) {
  const out: Array<{ helper: string; result: string }> = [];
  const expired = await expireHelperPending(now);
  if (expired) out.push({ helper: '*', result: `${expired} de volta para a fila (não adicionados no prazo)` });
  const helpers = await prisma.leadHelper.findMany({ where: { paused: false } });
  for (const h of helpers) {
    if (notDue(h, helperSafetyOf(h.safety), now, false)) continue;
    const r = await sendHelperBatch(h.id, { now }).catch((err) => ({ sent: 0, result: `erro: ${err instanceof Error ? err.message : String(err)}` }));
    out.push({ helper: h.label, result: r.result });
  }
  return out;
}

/** Panel view of one phone. */
export async function helperView(h: HelperRow & { campaigns?: Array<{ campaign: { id: string; name: string; mode: string; status: string } }> }, now = new Date()) {
  const s = helperSafetyOf(h.safety);
  const [today, pending, added, addedToday] = await Promise.all([
    sentToday(h.id, now),
    prisma.lead.count({ where: { helperId: h.id, status: 'MANUAL_PENDING' } }),
    prisma.lead.count({ where: { helperId: h.id, status: 'ADDED' } }),
    prisma.lead.count({ where: { helperId: h.id, status: 'ADDED', joinedAt: { gte: brtDayStart(0, now) } } }),
  ]);
  const limit = helperDailyLimit(s, h.warmupFrom, now);
  const resting = !!h.restUntil && h.restUntil > now;
  const sentTodayAlready = !!h.lastSentAt && h.lastSentAt >= brtDayStart(0, now);
  const nextAt = h.paused ? null
    : resting ? h.restUntil
    : !notDue(h, s, now, false) ? now // due: goes out on the next worker tick
    : nextSendAt(s, sentTodayAlready ? brtDayStart(-1, now) : now);
  return {
    id: h.id, label: h.label, phone: h.phone, safety: s,
    paused: h.paused, pausedReason: h.pausedReason, restUntil: resting ? h.restUntil : null,
    lastSentAt: h.lastSentAt, lastResult: h.lastResult,
    limit, sentToday: today, pending, added, addedToday, sinceRest: h.sinceRest, nextAt,
    campaigns: (h.campaigns ?? []).map((c) => ({ id: c.campaign.id, name: c.campaign.name, mode: c.campaign.mode, status: c.campaign.status })),
  };
}
