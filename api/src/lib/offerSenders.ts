/**
 * Several WhatsApp numbers can post the offers. For each destination group the
 * sender is drawn at random among the connected numbers marked "Envia ofertas"
 * that are admin of that group — which spreads the posting load and keeps
 * numbers warmed up (normal admin activity) before they're used for leads.
 *
 * Whether a number is admin of a group is read from the group's participant
 * list and cached for an hour per (number, group). A number whose own entry is
 * hidden (@lid, no phone) counts as "member" — used only when no confirmed
 * admin is available. No eligible number → the caller falls back to the main
 * number (evolution_instance), exactly as before.
 */
import prisma from './prisma';
import { evo } from './evolution';
import { participantPhone, samePhone } from './leadBlocks';

const TTL_MS = 60 * 60 * 1000;
type Role = 'admin' | 'member' | 'none';
const cache = new Map<string, { at: number; role: Role }>();

async function roleIn(inst: { name: string; number: string | null }, groupJid: string): Promise<Role> {
  const key = `${inst.name}|${groupJid}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.role;
  const r = await evo('GET', `/group/participants/${inst.name}?groupJid=${encodeURIComponent(groupJid)}`, undefined, 30000);
  let role: Role = 'none';
  if (r.ok) {
    const list: any[] = Array.isArray(r.data?.participants) ? r.data.participants : Array.isArray(r.data) ? r.data : [];
    role = 'member';
    if (inst.number) {
      const self = list.find((p) => {
        const phone = participantPhone(p);
        return phone ? samePhone(phone, inst.number as string) : false;
      });
      if (self) role = self.admin ? 'admin' : 'none'; // a plain member can't post in admin-only groups
    }
  }
  cache.set(key, { at: Date.now(), role });
  return role;
}

export function forgetSender(name: string, groupJid: string) {
  cache.delete(`${name}|${groupJid}`);
}

/** Senders for one group, in the order to try: random admins first, then random "probably members". */
export async function sendersFor(groupJid: string): Promise<Array<{ name: string; label: string }>> {
  // TODO(multi-tenant): filter by the destination group's tenant.
  const numbers = await prisma.whatsAppInstance.findMany({
    where: { sendsOffers: true, connected: true },
    select: { name: true, label: true, number: true },
  });
  if (!numbers.length) return [];
  const roles = await Promise.all(numbers.map(async (n) => ({ n, role: await roleIn(n, groupJid).catch(() => 'none' as Role) })));
  const shuffle = <T>(a: T[]) => a.map((x) => ({ x, k: Math.random() })).sort((p, q) => p.k - q.k).map((p) => p.x);
  const admins = shuffle(roles.filter((r) => r.role === 'admin').map((r) => r.n));
  const members = shuffle(roles.filter((r) => r.role === 'member').map((r) => r.n));
  return [...admins, ...members].map((n) => ({ name: n.name, label: n.label }));
}
