/**
 * Safe queue that adds opt-in leads (from the account's own capture page) to
 * WhatsApp groups, one person at a time, through a dedicated number.
 *
 * Mass-adding is what gets WhatsApp numbers banned, so every number has its
 * own safety settings (LeadSafety) and the tick below never does more than
 * ONE add/invite per number per run:
 *   - daily limit, with an optional warm-up for new numbers
 *   - random interval between two actions (min..max seconds)
 *   - rest cycle: after N people added, stop for D days
 *   - working hours and weekdays (Brasília time)
 *   - per-group member cap → moves on to the next group of the campaign
 *   - privacy blocks a direct add → the group link goes in private (own daily limit)
 *   - automatic brake: N real failures in a row → the number's queue pauses
 *     and the owner is alerted
 *   - anyone who ever left one of the account's groups is never added again
 *     (lib/leadBlocks.ts)
 *
 * Evolution calls (v2): /chat/whatsappNumbers, /group/participants,
 * /group/updateParticipant (action "add"), /group/inviteCode, /message/sendText.
 */
import prisma from './prisma';
import { evo, getState } from './evolution';
import { brtDayStart, toBrt } from './time';
import { WhatsAppService } from '../services/whatsapp.service';
import { findBlock } from './leadBlocks';

export interface LeadSafety {
  dailyLimit: number;
  minDelaySec: number;
  maxDelaySec: number;
  restEvery: number; // 0 = never rest
  restDays: number;
  startHour: number; // 0-23, Brasília
  endHour: number; // exclusive
  weekdays: number[]; // 0 = Sunday … 6 = Saturday
  warmup: boolean;
  warmupStart: number;
  warmupStep: number;
  groupCap: number;
  inviteDailyLimit: number;
  inviteText: string;
  maxFailStreak: number;
}

export const DEFAULT_INVITE_TEXT =
  '{Oi|Olá|Oie} {{nome}}! {Tudo bem?|Tudo certo?} Você se cadastrou para entrar no nosso grupo {{grupo}} 🎉\n' +
  '{É só tocar no link para entrar|Entre por este link}: {{link}}';

export const DEFAULT_SAFETY: LeadSafety = {
  dailyLimit: 20,
  minDelaySec: 240,
  maxDelaySec: 720,
  restEvery: 30,
  restDays: 2,
  startHour: 9,
  endHour: 21,
  weekdays: [1, 2, 3, 4, 5, 6],
  warmup: true,
  warmupStart: 5,
  warmupStep: 3,
  groupCap: 1000,
  inviteDailyLimit: 15,
  inviteText: DEFAULT_INVITE_TEXT,
  maxFailStreak: 5,
};

const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

/** Stored JSON → complete, sane settings (anything missing/invalid falls back to the default). */
export function safetyOf(raw: unknown): LeadSafety {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<LeadSafety>;
  const d = DEFAULT_SAFETY;
  const minDelaySec = clampInt(r.minDelaySec, 30, 6 * 3600, d.minDelaySec);
  const weekdays = Array.isArray(r.weekdays)
    ? [...new Set(r.weekdays.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort()
    : d.weekdays;
  return {
    dailyLimit: clampInt(r.dailyLimit, 1, 500, d.dailyLimit),
    minDelaySec,
    maxDelaySec: Math.max(minDelaySec, clampInt(r.maxDelaySec, 30, 12 * 3600, d.maxDelaySec)),
    restEvery: clampInt(r.restEvery, 0, 5000, d.restEvery),
    restDays: clampInt(r.restDays, 0, 30, d.restDays),
    startHour: clampInt(r.startHour, 0, 23, d.startHour),
    endHour: clampInt(r.endHour, 1, 24, d.endHour),
    weekdays: weekdays.length ? weekdays : d.weekdays,
    warmup: typeof r.warmup === 'boolean' ? r.warmup : d.warmup,
    warmupStart: clampInt(r.warmupStart, 1, 500, d.warmupStart),
    warmupStep: clampInt(r.warmupStep, 0, 100, d.warmupStep),
    groupCap: clampInt(r.groupCap, 10, 1024, d.groupCap),
    inviteDailyLimit: clampInt(r.inviteDailyLimit, 0, 500, d.inviteDailyLimit),
    inviteText: typeof r.inviteText === 'string' && r.inviteText.includes('{{link}}') ? r.inviteText.slice(0, 1000) : d.inviteText,
    maxFailStreak: clampInt(r.maxFailStreak, 1, 50, d.maxFailStreak),
  };
}

const DAY_MS = 86_400_000;

/** Adds allowed today: the daily limit, ramped up during warm-up. */
export function effectiveDailyLimit(s: LeadSafety, warmupFrom: Date | null, now = new Date()): number {
  if (!s.warmup || !warmupFrom) return s.warmup ? Math.min(s.dailyLimit, s.warmupStart) : s.dailyLimit;
  const days = Math.max(0, Math.floor((brtDayStart(0, now).getTime() - brtDayStart(0, warmupFrom).getTime()) / DAY_MS));
  return Math.min(s.dailyLimit, s.warmupStart + s.warmupStep * days);
}

/** Inside working hours / weekdays (Brasília)? */
export function inWorkingWindow(s: LeadSafety, now = new Date()): boolean {
  const b = toBrt(now);
  const h = b.getUTCHours();
  const inHours = s.startHour < s.endHour ? h >= s.startHour && h < s.endHour : h >= s.startHour || h < s.endHour;
  return inHours && s.weekdays.includes(b.getUTCDay());
}

/** Next instant the working window opens (scans hour by hour, max 8 days). */
export function nextWindowStart(s: LeadSafety, now = new Date()): Date {
  const t = new Date(Math.ceil(now.getTime() / 3_600_000) * 3_600_000);
  for (let i = 0; i < 24 * 8; i++) {
    const c = new Date(t.getTime() + i * 3_600_000);
    if (inWorkingWindow(s, c)) return c;
  }
  return new Date(now.getTime() + DAY_MS);
}

export const randomDelayMs = (s: LeadSafety) =>
  (s.minDelaySec + Math.random() * (s.maxDelaySec - s.minDelaySec)) * 1000;

/** "{Oi|Olá}" picks one at random; "{{nome}}" etc. are filled in. */
export function renderInvite(template: string, vars: Record<string, string>): string {
  let out = template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  out = out.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, opts: string) => {
    const list = opts.split('|');
    return list[Math.floor(Math.random() * list.length)];
  });
  return out.replace(/[ \t]+([!?,.])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}

/** Parses pasted text / CSV lines into { phone, name } (Brazilian numbers). */
export function parseLeadLines(text: string, normalize: (raw: string) => string | null) {
  const leads: Array<{ phone: string; name: string | null }> = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cells = line.split(/[,;\t|]/).map((c) => c.trim().replace(/^"|"$/g, '')).filter(Boolean);
    let phone: string | null = null;
    let name: string | null = null;
    for (const c of cells) {
      if (!phone) {
        const p = normalize(c);
        if (p) { phone = p; continue; }
      }
      if (!name && !/\d{4,}/.test(c) && /[a-zA-ZÀ-ú]/.test(c) && !/^(nome|name|telefone|phone|whatsapp|celular)$/i.test(c)) name = c.slice(0, 80);
    }
    if (!phone) {
      // header rows ("nome,telefone") are not errors
      if (!/telefone|phone|whatsapp|celular/i.test(line)) invalid.push(line.slice(0, 60));
      continue;
    }
    if (seen.has(phone)) { duplicates++; continue; }
    seen.add(phone);
    leads.push({ phone, name });
  }
  return { leads, invalid, duplicates };
}

// ── Evolution helpers ───────────────────────────────────────────────────────

const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/** null = couldn't check (don't block on it). */
async function hasWhatsApp(instance: string, phone: string): Promise<{ exists: boolean; jid: string | null } | null> {
  const r = await evo('POST', `/chat/whatsappNumbers/${instance}`, { numbers: [phone] });
  if (!r.ok) return null;
  const list: any[] = Array.isArray(r.data) ? r.data : [];
  const hit = list.find((x) => digits(x?.number).endsWith(phone.slice(-8)) || digits(x?.jid).endsWith(phone.slice(-8))) ?? list[0];
  if (!hit) return null;
  return { exists: !!hit.exists, jid: hit.jid ? String(hit.jid) : null };
}

interface GroupInfo { ok: boolean; error?: string; size: number; memberDigits: Set<string>; selfIsAdmin: boolean | null }

async function groupInfo(instance: string, groupJid: string, selfNumber: string | null): Promise<GroupInfo> {
  const r = await evo('GET', `/group/participants/${instance}?groupJid=${encodeURIComponent(groupJid)}`);
  if (!r.ok) {
    return { ok: false, error: `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 150)}`, size: 0, memberDigits: new Set(), selfIsAdmin: null };
  }
  const list: any[] = Array.isArray(r.data?.participants) ? r.data.participants : Array.isArray(r.data) ? r.data : [];
  const memberDigits = new Set<string>();
  let selfIsAdmin: boolean | null = null;
  for (const p of list) {
    // A participant id is a phone JID (…@s.whatsapp.net) or a hidden @lid;
    // newer Evolution releases also give phoneNumber for @lid members.
    const ids = [p?.id, p?.phoneNumber, p?.jid].filter(Boolean).map(String).filter((x) => !x.endsWith('@lid'));
    for (const id of ids) {
      const d = digits(id.split('@')[0].split(':')[0]);
      if (d) memberDigits.add(d);
      if (selfNumber && d && d.slice(-8) === selfNumber.slice(-8)) selfIsAdmin = !!p?.admin;
    }
  }
  return { ok: true, size: list.length, memberDigits, selfIsAdmin };
}

function isMember(info: GroupInfo, phone: string) {
  const tail = phone.slice(-8); // tolerant to the Brazilian 9th digit
  for (const d of info.memberDigits) if (d.slice(-8) === tail) return true;
  return false;
}

type AddOutcome =
  | { kind: 'ADDED' }
  | { kind: 'ALREADY' }
  | { kind: 'NEEDS_INVITE'; why: string }
  | { kind: 'FAILED'; why: string; blocking: boolean };

/** Per-participant status from /group/updateParticipant (shape varies across releases). */
async function addToGroup(instance: string, groupJid: string, phone: string): Promise<AddOutcome> {
  const r = await evo('POST', `/group/updateParticipant/${instance}?groupJid=${encodeURIComponent(groupJid)}`, {
    action: 'add',
    participants: [phone],
  }, 45000);
  const text = JSON.stringify(r.data ?? '').slice(0, 300);
  if (!r.ok) {
    const lower = text.toLowerCase();
    if (/not-authorized|forbidden|not admin|admin/.test(lower)) {
      return { kind: 'FAILED', why: 'O número não é admin do grupo', blocking: true };
    }
    if (r.status === 0 || r.status >= 500 || /connection closed|not connected|disconnect/.test(lower)) {
      return { kind: 'FAILED', why: `Evolution/WhatsApp indisponível: ${text}`, blocking: true };
    }
    return { kind: 'FAILED', why: `Erro ao adicionar (HTTP ${r.status}): ${text}`, blocking: true };
  }
  const arr: any[] = r.data?.updateParticipants ?? r.data?.participants ?? (Array.isArray(r.data) ? r.data : []);
  const item = arr.find((x) => digits(x?.jid ?? x?.id).slice(-8) === phone.slice(-8)) ?? arr[0];
  const status = String(item?.status ?? item?.code ?? '200');
  if (status === '200') return { kind: 'ADDED' };
  if (status === '409') return { kind: 'ALREADY' };
  if (status === '403') return { kind: 'NEEDS_INVITE', why: 'A privacidade da pessoa não permite ser adicionada direto' };
  if (status === '408') return { kind: 'NEEDS_INVITE', why: 'A pessoa saiu do grupo há pouco — o WhatsApp só deixa voltar por convite' };
  return { kind: 'FAILED', why: `WhatsApp recusou (status ${status})`, blocking: false };
}

async function groupLink(instance: string, group: { chatId: string; inviteLink: string | null }): Promise<string | null> {
  if (group.inviteLink) return group.inviteLink;
  const r = await evo('GET', `/group/inviteCode/${instance}?groupJid=${encodeURIComponent(group.chatId)}`);
  const url = r.data?.inviteUrl ?? (r.data?.inviteCode ? `https://chat.whatsapp.com/${r.data.inviteCode}` : null);
  return r.ok && url ? String(url) : null;
}

async function sendPrivate(instance: string, phone: string, text: string): Promise<string | null> {
  const r = await evo('POST', `/message/sendText/${instance}`, { number: phone, text }, 45000);
  return r.ok ? null : `HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`;
}

async function alertOwner(text: string) {
  const row = await prisma.setting.findUnique({ where: { key: 'link_monitor_alert_number' } });
  const number = row?.value?.trim();
  if (!number) return;
  await new WhatsAppService().sendText(number, text).catch((err) => console.error('[leads] alert failed:', err.message));
}

// ── Tick ────────────────────────────────────────────────────────────────────

export interface TickResult { instance: string; action: string }

/** Runs every ~30 s. At most one WhatsApp action per number per run. */
export async function leadsTick(now = new Date()): Promise<TickResult[]> {
  const out: TickResult[] = [];
  const instances = await prisma.whatsAppInstance.findMany({
    where: { leadPaused: false, campaigns: { some: { status: 'ACTIVE', leads: { some: { status: { in: ['QUEUED', 'INVITE_PENDING'] } } } } } },
  });
  for (const inst of instances) {
    try {
      const action = await processInstance(inst.id, now);
      if (action) out.push({ instance: inst.label, action });
    } catch (err) {
      out.push({ instance: inst.label, action: `erro: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return out;
}

async function processInstance(instanceId: string, now: Date): Promise<string | null> {
  const inst = await prisma.whatsAppInstance.findUnique({ where: { id: instanceId } });
  if (!inst || inst.leadPaused) return null;
  const s = safetyOf(inst.leadSafety);

  if (inst.leadRestUntil && inst.leadRestUntil > now) return null;
  if (inst.leadNextAt && inst.leadNextAt > now) return null;
  if (!inWorkingWindow(s, now)) return null;

  const dayStart = brtDayStart(0, now);
  const [addsToday, invitesToday] = await Promise.all([
    prisma.lead.count({ where: { instanceId, status: 'ADDED', processedAt: { gte: dayStart } } }),
    prisma.lead.count({ where: { instanceId, status: 'INVITED', processedAt: { gte: dayStart } } }),
  ]);
  const limit = effectiveDailyLimit(s, inst.leadWarmupFrom, now);
  const canAdd = addsToday < limit;
  const canInvite = invitesToday < s.inviteDailyLimit;
  if (!canAdd && !canInvite) return null;

  // Invites postponed by yesterday's invite limit go first (no new add attempt for them).
  const pending = canInvite
    ? await prisma.lead.findFirst({
        where: { status: 'INVITE_PENDING', campaign: { instanceId, status: 'ACTIVE' } },
        orderBy: { createdAt: 'asc' },
        include: { campaign: true },
      })
    : null;
  const lead = pending ?? (canAdd
    ? await prisma.lead.findFirst({
        where: { status: 'QUEUED', campaign: { instanceId, status: 'ACTIVE' } },
        orderBy: { createdAt: 'asc' },
        include: { campaign: true },
      })
    : null);
  if (!lead) return null;

  const state = await getState(inst.name);
  if (state !== 'open') {
    await prisma.whatsAppInstance.update({ where: { id: instanceId }, data: { connected: false, lastState: state, leadLastResult: 'Número desconectado — conecte de novo em WhatsApp' } });
    return 'número desconectado';
  }

  const finish = async (status: string, detail: string | null, groupId: string | null, opts: { touched: boolean; added?: boolean; failure?: 'real' | 'none' }) => {
    await prisma.lead.update({
      where: { id: lead.id },
      data: { status, detail, groupId, instanceId, processedAt: new Date(), attempts: { increment: 1 } },
    });
    const data: Record<string, unknown> = { leadLastResult: `${lead.phone}: ${detail ?? status}` };
    // Cheap checks (no WhatsApp action) only wait a little; real actions wait the random interval.
    data.leadNextAt = new Date(Date.now() + (opts.touched ? randomDelayMs(s) : 20_000 + Math.random() * 40_000));
    if (opts.added) {
      const since = inst.leadSinceRest + 1;
      if (!inst.leadWarmupFrom) data.leadWarmupFrom = now;
      if (s.restEvery > 0 && s.restDays > 0 && since >= s.restEvery) {
        data.leadSinceRest = 0;
        data.leadRestUntil = new Date(now.getTime() + s.restDays * DAY_MS);
      } else {
        data.leadSinceRest = since;
      }
    }
    if (opts.failure === 'real') {
      const streak = inst.leadFailStreak + 1;
      data.leadFailStreak = streak;
      if (streak >= s.maxFailStreak) {
        data.leadPaused = true;
        data.leadPausedReason = `Pausado sozinho: ${streak} falhas seguidas (última: ${detail})`;
        await alertOwner(`⚠️ Leads: a fila do número "${inst.label}" foi pausada após ${streak} falhas seguidas.\nÚltima: ${detail}\nConfira o número antes de retomar.`);
      }
    } else {
      data.leadFailStreak = 0;
    }
    await prisma.whatsAppInstance.update({ where: { id: instanceId }, data });
    return `${lead.phone} → ${status}${detail ? ` (${detail})` : ''}`;
  };

  const sendInvite = async (target: { id: string; name: string; chatId: string; inviteLink: string | null }, why: string) => {
    const link = await groupLink(inst.name, target);
    if (!link) return finish('FAILED', `${why}, e não consegui o link do grupo ${target.name}`, target.id, { touched: true, failure: 'real' });
    const text = renderInvite(s.inviteText, { nome: lead.name?.split(' ')[0] ?? '', grupo: target.name, link });
    const sendErr = await sendPrivate(inst.name, lead.phone, text);
    if (sendErr) return finish('FAILED', `${why}; falhou ao mandar o convite: ${sendErr}`, target.id, { touched: true, failure: 'real' });
    return finish('INVITED', `${why} — link do grupo ${target.name} enviado no privado`, target.id, { touched: true });
  };

  // Left (or was removed from) one of the account's groups before → never again.
  if (await findBlock(lead.tenantId, lead.phone)) {
    return finish('BLOCKED', 'Já saiu de um dos seus grupos antes — não é adicionado de novo', null, { touched: false });
  }

  if (lead.status === 'INVITE_PENDING') {
    const g = lead.groupId ? await prisma.destinationGroup.findUnique({ where: { id: lead.groupId } }) : null;
    if (!g) return finish('FAILED', 'O grupo escolhido para o convite não existe mais', null, { touched: false });
    return sendInvite(g, 'Convite que tinha ficado para hoje');
  }

  // 1. Does the number have WhatsApp?
  const check = await hasWhatsApp(inst.name, lead.phone);
  if (check && !check.exists) return finish('NO_WHATSAPP', 'Número sem WhatsApp', null, { touched: false });

  // 2. First group of the campaign that has room (and where they aren't yet).
  const groupIds: string[] = Array.isArray(lead.campaign.groupIds) ? (lead.campaign.groupIds as string[]) : [];
  const groups = await prisma.destinationGroup.findMany({ where: { id: { in: groupIds }, type: 'WHATSAPP', isActive: true } });
  const ordered = groupIds.map((id) => groups.find((g) => g.id === id)).filter(Boolean) as typeof groups;
  let target: (typeof groups)[number] | null = null;
  for (const g of ordered) {
    const info = await groupInfo(inst.name, g.chatId, inst.number);
    if (!info.ok) {
      await pauseCampaign(lead.campaignId, `Não consegui ler o grupo "${g.name}" com este número (ele participa do grupo?): ${info.error}`);
      return `campanha pausada: grupo ${g.name} ilegível`;
    }
    if (info.selfIsAdmin === false) {
      await pauseCampaign(lead.campaignId, `O número "${inst.label}" não é admin do grupo "${g.name}". Torne-o admin e retome a campanha.`);
      return `campanha pausada: não é admin de ${g.name}`;
    }
    if (isMember(info, lead.phone)) return finish('ALREADY_MEMBER', `Já estava no grupo ${g.name}`, g.id, { touched: false });
    if (info.size < s.groupCap) { target = g; break; }
  }
  if (!target) {
    await pauseCampaign(lead.campaignId, ordered.length
      ? `Todos os grupos da campanha chegaram ao limite de ${s.groupCap} membros. Adicione outro grupo e retome.`
      : 'A campanha não tem nenhum grupo de WhatsApp ativo.');
    return 'campanha pausada: sem grupo com vaga';
  }

  // 3. Add.
  const add = await addToGroup(inst.name, target.chatId, lead.phone);
  if (add.kind === 'ADDED') return finish('ADDED', `Adicionado ao grupo ${target.name}`, target.id, { touched: true, added: true });
  if (add.kind === 'ALREADY') return finish('ALREADY_MEMBER', `Já estava no grupo ${target.name}`, target.id, { touched: true });
  if (add.kind === 'FAILED') {
    if (add.why.includes('não é admin')) {
      await pauseCampaign(lead.campaignId, `O número "${inst.label}" não é admin do grupo "${target.name}". Torne-o admin e retome a campanha.`);
    }
    return finish('FAILED', add.why, target.id, { touched: true, failure: add.blocking ? 'real' : 'none' });
  }

  // 4. Privacy blocks the add → link in private (if enabled and within its own daily limit).
  if (!lead.campaign.inviteFallback) return finish('FAILED', `${add.why} (convite no privado desligado)`, target.id, { touched: true });
  if (!canInvite) {
    // Today's invite quota is used up: wait for tomorrow's without another add attempt.
    return finish('INVITE_PENDING', `${add.why} — o convite fica para o próximo dia (limite diário de convites)`, target.id, { touched: true });
  }
  return sendInvite(target, add.why);
}

async function pauseCampaign(id: string, reason: string) {
  await prisma.leadCampaign.update({ where: { id }, data: { status: 'PAUSED', pausedReason: reason } });
}

/** Queue status of a number, for the panel. */
export async function queueStatus(instanceId: string, now = new Date()) {
  const inst = await prisma.whatsAppInstance.findUnique({ where: { id: instanceId } });
  if (!inst) return null;
  const s = safetyOf(inst.leadSafety);
  const dayStart = brtDayStart(0, now);
  const [addsToday, invitesToday, queued, invitePending] = await Promise.all([
    prisma.lead.count({ where: { instanceId, status: 'ADDED', processedAt: { gte: dayStart } } }),
    prisma.lead.count({ where: { instanceId, status: 'INVITED', processedAt: { gte: dayStart } } }),
    prisma.lead.count({ where: { status: 'QUEUED', campaign: { instanceId, status: 'ACTIVE' } } }),
    prisma.lead.count({ where: { status: 'INVITE_PENDING', campaign: { instanceId, status: 'ACTIVE' } } }),
  ]);
  const limit = effectiveDailyLimit(s, inst.leadWarmupFrom, now);
  let waitingFor: string | null = null;
  let nextAt: Date | null = inst.leadNextAt && inst.leadNextAt > now ? inst.leadNextAt : null;
  if (inst.leadPaused) waitingFor = 'paused';
  else if (inst.leadRestUntil && inst.leadRestUntil > now) { waitingFor = 'rest'; nextAt = inst.leadRestUntil; }
  else if (addsToday >= limit) { waitingFor = 'daily_limit'; nextAt = nextWindowStart(s, brtDayStart(-1, now)); }
  else if (!inWorkingWindow(s, now)) { waitingFor = 'window'; nextAt = nextWindowStart(s, now); }
  else if (!queued && !invitePending) waitingFor = 'empty';
  return {
    addsToday, invitesToday, limit, inviteLimit: s.inviteDailyLimit, queued, invitePending, nextAt, waitingFor,
    sinceRest: inst.leadSinceRest, restEvery: s.restEvery,
    paused: inst.leadPaused, pausedReason: inst.leadPausedReason, lastResult: inst.leadLastResult,
  };
}
