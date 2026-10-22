/**
 * Brings dropped WhatsApp numbers back by themselves — with the credentials
 * they already have, no QR — a few times with growing pauses.
 *
 * A temporary drop (network, API restart, deploy, 428/440/515) normally comes
 * back on the first try. After a "device removed" (401) the device often still
 * shows as connected on the phone, so it gets two tries too; if WhatsApp
 * really unlinked it, the API asks for a QR and the owner is told once.
 *
 * Runs in the worker (single process), so the retry state lives in memory.
 */
import prisma from './prisma';
import { LOGOUT_CODES } from './evolution';
import { asProvider, getState, resume } from './wa';
import { alertOwner } from './leadQueue';
import { refreshInstance } from './whatsappNumbers';

const PAUSES_MIN = [1, 5, 20, 60, 180]; // before each try (temporary drops)
const LOGOUT_TRIES = 2; // after a 401/403…: WhatsApp may have really unlinked it
const RECENT_MS = 7 * 86_400_000; // only numbers that were online in the last 7 days
const QR_FLOW_MS = 10 * 60_000; // someone just clicked "Conectar": leave the QR flow alone

const state = new Map<string, { tries: number; next: number; gaveUp: boolean }>();

export async function autoReconnect(now = new Date()): Promise<Array<{ number: string; result: string }>> {
  const out: Array<{ number: string; result: string }> = [];
  const rows = await prisma.whatsAppInstance.findMany({
    where: { connected: false, lastSeenAt: { gte: new Date(now.getTime() - RECENT_MS) } },
  });
  for (const row of rows) {
    if (row.lastState === 'connecting' && now.getTime() - row.updatedAt.getTime() < QR_FLOW_MS) continue;
    const provider = asProvider(row.provider) ?? 'EVOLUTION';
    const live = await getState(row.name, provider).catch(() => 'error' as const);
    if (live === 'open') {
      await refreshInstance(row.id);
      state.delete(row.id);
      continue;
    }
    if (live === 'not_found' || live === 'error') continue; // removed from the API / API down

    const logout = !!row.lastDisconnectCode && LOGOUT_CODES.has(row.lastDisconnectCode);
    const maxTries = logout ? LOGOUT_TRIES : PAUSES_MIN.length;
    const s = state.get(row.id) ?? { tries: 0, next: now.getTime() + PAUSES_MIN[0] * 60_000, gaveUp: false };
    state.set(row.id, s);
    if (s.gaveUp || now.getTime() < s.next) continue;

    s.tries++;
    const back = await resume(row.name, provider).catch(() => false);
    if (back) {
      state.delete(row.id);
      await refreshInstance(row.id);
      const when = now.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
      if (row.leadPaused && row.leadPausedReason?.startsWith('Pausado sozinho')) {
        await prisma.whatsAppInstance.update({
          where: { id: row.id },
          data: { leadPausedReason: `${row.leadPausedReason} — o número voltou sozinho às ${when}, sem QR. Retome a fila quando quiser.` },
        });
      }
      await alertOwner(`✅ WhatsApp "${row.label}"${row.number ? ` (${row.number})` : ''} voltou sozinho às ${when}, sem precisar ler o QR Code.${row.leadPaused ? '\nA fila de leads dele continua pausada — retome pelo painel quando quiser.' : ''}`);
      out.push({ number: row.label, result: 'reconectado sem QR' });
      continue;
    }
    if (s.tries >= maxTries) {
      s.gaveUp = true;
      await alertOwner(`📵 WhatsApp "${row.label}"${row.number ? ` (${row.number})` : ''} não voltou sozinho (${s.tries} tentativa${s.tries > 1 ? 's' : ''} sem QR). O WhatsApp desconectou o aparelho de vez: conecte de novo pelo QR Code no painel.`);
      out.push({ number: row.label, result: 'precisa de QR' });
    } else {
      s.next = now.getTime() + PAUSES_MIN[Math.min(s.tries, PAUSES_MIN.length - 1)] * 60_000;
      out.push({ number: row.label, result: `tentativa ${s.tries} sem sucesso` });
    }
  }
  return out;
}
