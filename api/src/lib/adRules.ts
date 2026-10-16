/**
 * Monitoring rules on Meta campaigns / ad sets / ads:
 *   "cost per LINK click above R$ X for N days → notify (or pause + notify)".
 *
 * Only entities the user switched on are ever evaluated, only complete days
 * (in the ad account's time zone) are judged, and a day only counts once it
 * reached the minimum spend. Pausing re-checks the live status at Meta first
 * and nothing is ever re-activated automatically.
 */
import prisma from './prisma';
import { WhatsAppService } from '../services/whatsapp.service';
import { accountOffset, accountToday, shiftDate, pauseEntity, liveStatus } from './metaAds';

export interface DayMetrics {
  date: string;
  spend: number;
  linkClicks: number;
}

export interface RuleParams {
  maxCpc: number;
  days: number;
  mode: string; // CONSECUTIVE | AVERAGE
  minSpend: number;
}

export interface Evaluation {
  breach: boolean;
  reason: string;
  days: Array<DayMetrics & { cpc: number | null }>;
  avgCpc: number | null;
}

const cpcOf = (spend: number, clicks: number): number | null => (clicks > 0 ? spend / clicks : spend > 0 ? Infinity : null);
const brl = (v: number | null) =>
  v === null ? '—' : v === Infinity ? 'sem cliques' : `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Pure: does this window of days break the rule? `days` must be the N judged days, oldest first. */
export function evaluateRule(rule: RuleParams, days: DayMetrics[]): Evaluation {
  const withCpc = days.map((d) => ({ ...d, cpc: cpcOf(d.spend, d.linkClicks) }));
  const totalSpend = days.reduce((a, d) => a + d.spend, 0);
  const totalClicks = days.reduce((a, d) => a + d.linkClicks, 0);
  const avgCpc = cpcOf(totalSpend, totalClicks);
  const base = { days: withCpc, avgCpc };

  if (days.length < rule.days) return { ...base, breach: false, reason: 'dias insuficientes' };

  if (rule.mode === 'AVERAGE') {
    if (totalSpend < rule.minSpend * rule.days) {
      return { ...base, breach: false, reason: `gasto total ${brl(totalSpend)} abaixo do mínimo para avaliar (${brl(rule.minSpend * rule.days)})` };
    }
    const breach = avgCpc !== null && avgCpc > rule.maxCpc;
    return { ...base, breach, reason: `média ${brl(avgCpc)} por clique nos últimos ${rule.days} dias (limite ${brl(rule.maxCpc)})` };
  }

  // CONSECUTIVE: every judged day must have reached the minimum spend and gone over the limit.
  const thin = withCpc.find((d) => d.spend < rule.minSpend);
  if (thin) return { ...base, breach: false, reason: `dia ${thin.date} com gasto ${brl(thin.spend)}, abaixo do mínimo (${brl(rule.minSpend)})` };
  const breach = withCpc.every((d) => d.cpc !== null && d.cpc > rule.maxCpc);
  return {
    ...base,
    breach,
    reason: `${withCpc.map((d) => `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}: ${brl(d.cpc)}`).join(', ')} (limite ${brl(rule.maxCpc)})`,
  };
}

/** Daily spend/link clicks of any level, summed from the ad rows. */
export async function entityDays(entity: { id: string; level: string }, dates: string[]): Promise<DayMetrics[]> {
  const where =
    entity.level === 'CAMPAIGN' ? { campaignId: entity.id } : entity.level === 'ADSET' ? { adsetId: entity.id } : { adId: entity.id };
  const rows = await prisma.metaAdDaily.findMany({ where: { ...where, date: { in: dates } } });
  return dates.map((date) => {
    const r = rows.filter((x) => x.date === date);
    return { date, spend: r.reduce((a, x) => a + x.spend, 0), linkClicks: r.reduce((a, x) => a + x.linkClicks, 0) };
  });
}

const LEVEL_LABEL: Record<string, string> = { CAMPAIGN: 'a campanha', ADSET: 'o conjunto', AD: 'o anúncio' };
const REFIRE_MS = 20 * 3600000; // at most one alert/pause per rule per day

async function notify(text: string) {
  const row = await prisma.setting.findUnique({ where: { key: 'link_monitor_alert_number' } });
  const number = row?.value?.trim();
  if (!number) throw new Error('Número de alerta não configurado (Configurações → Monitor de Link)');
  await new WhatsAppService().sendText(number, text);
}

export async function runAdRules(now = new Date()) {
  const rules = await prisma.metaRule.findMany({ where: { enabled: true } });
  const out: Array<{ entity: string; result: string }> = [];

  for (const rule of rules) {
    const entity = await prisma.metaEntity.findUnique({ where: { id: rule.entityId } });
    if (!entity) { out.push({ entity: rule.entityId, result: 'não encontrado na Meta' }); continue; }

    // Only judge things that are actually running (including their parents).
    const parents = await prisma.metaEntity.findMany({ where: { id: { in: [entity.campaignId, entity.adsetId].filter(Boolean) as string[] } } });
    const inactive = [entity, ...parents].find((e) => e.status !== 'ACTIVE');
    if (inactive) {
      await prisma.metaRule.update({ where: { id: rule.id }, data: { lastCheck: { at: now.toISOString(), skipped: `${inactive.name} não está ativa (${inactive.status})` } } });
      out.push({ entity: entity.name, result: 'inativa' });
      continue;
    }

    const today = accountToday(await accountOffset(entity.accountId), now);
    const dates = Array.from({ length: rule.days }, (_, i) => shiftDate(today, -(rule.days - i))); // complete days only
    const ev = evaluateRule(rule, await entityDays(entity, dates));
    await prisma.metaRule.update({
      where: { id: rule.id },
      data: { lastCheck: { at: now.toISOString(), breach: ev.breach, reason: ev.reason, days: ev.days.map((d) => ({ ...d, cpc: d.cpc === Infinity ? null : d.cpc })) } as any },
    });
    if (!ev.breach) { out.push({ entity: entity.name, result: 'ok' }); continue; }
    if (rule.lastFiredAt && now.getTime() - rule.lastFiredAt.getTime() < REFIRE_MS) {
      out.push({ entity: entity.name, result: 'já tratado hoje' });
      continue;
    }

    let success = true;
    let detail = ev.reason;
    let action = rule.action;
    try {
      if (rule.action === 'PAUSE') {
        const live = await liveStatus(entity.id);
        if (live && live !== 'ACTIVE') {
          action = 'NOTIFY';
          detail = `já estava ${live} na Meta — nada pausado. ${ev.reason}`;
        } else {
          await pauseEntity(entity.id);
          await prisma.metaEntity.update({ where: { id: entity.id }, data: { status: 'PAUSED' } });
        }
      }
      const verb = action === 'PAUSE' ? `⏸️ Pausei ${LEVEL_LABEL[entity.level]}` : `⚠️ Atenção: ${LEVEL_LABEL[entity.level]}`;
      await notify(`${verb} "${entity.name}"\nCusto por clique no link: ${ev.reason}${action === 'NOTIFY' && rule.action === 'NOTIFY' ? '\n(regra em modo "só avisar" — nada foi pausado)' : ''}`);
    } catch (err) {
      success = false;
      detail = `${err instanceof Error ? err.message : String(err)} — ${ev.reason}`;
    }
    await prisma.metaRuleAction.create({ data: { entityId: entity.id, level: entity.level, name: entity.name, action, success, detail } });
    // A failure (e.g. token without ads_management) is retried on the next run.
    if (success) await prisma.metaRule.update({ where: { id: rule.id }, data: { lastFiredAt: now } });
    out.push({ entity: entity.name, result: success ? (action === 'PAUSE' ? 'pausada' : 'avisado') : `erro: ${detail}` });
  }
  return out;
}
