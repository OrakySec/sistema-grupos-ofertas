import { Worker, Job } from 'bullmq';
import redis from './lib/redis';
import prisma from './lib/prisma';
import { addSendOfferJob, scheduleLinkMonitor } from './lib/queue';
import { TelegramService } from './services/telegram.service';
import { WhatsAppService } from './services/whatsapp.service';

interface NewOfferJobData {
  offerId: string;
}

interface SendOfferJobData {
  offerId: string;
}

const telegramService = new TelegramService();
const whatsappService = new WhatsAppService();

async function handleNewOffer(job: Job<NewOfferJobData>): Promise<void> {
  const { offerId } = job.data;

  const offer = await prisma.offer.findUnique({ where: { id: offerId } });
  if (!offer) {
    throw new Error(`Offer ${offerId} not found`);
  }

  if (offer.status !== 'PENDING') {
    // A delayed/retried job (queue backlog, worker restart) can run after a
    // human already approved or rejected this offer manually — don't let
    // auto-approve below silently overwrite that decision.
    console.log(`[Worker] Offer ${offerId} is no longer PENDING (status: ${offer.status}) — already handled, skipping`);
    return;
  }

  const autoApproveSetting = await prisma.setting.findUnique({
    where: { key: 'auto_approve' },
  });

  if (autoApproveSetting?.value === 'true') {
    // Conditional update (only flips rows still PENDING) instead of a blind
    // write — closes the gap between the read above and this write where a
    // manual approve/reject could otherwise be reverted.
    const { count } = await prisma.offer.updateMany({
      where: { id: offerId, status: 'PENDING' },
      data: { status: 'APPROVED', reviewedAt: new Date() },
    });
    if (count === 0) {
      console.log(`[Worker] Offer ${offerId} was handled manually just before auto-approve — skipping`);
      return;
    }
    console.log(`[Worker] Auto-approving offer ${offerId}`);
    await addSendOfferJob(offerId);
  } else {
    console.log(`[Worker] Offer ${offerId} queued for manual review`);
  }
}

async function handleSendOffer(job: Job<SendOfferJobData>): Promise<void> {
  const { offerId } = job.data;

  const offer = await prisma.offer.findUnique({
    where: { id: offerId },
    include: { sourceGroup: { include: { niche: true } } },
  });

  if (!offer) {
    throw new Error(`Offer ${offerId} not found`);
  }

  if (offer.status !== 'APPROVED') {
    console.warn(`[Worker] Skipping non-approved offer ${offerId} (status: ${offer.status})`);
    return;
  }

  // Fetch destinations linked to this source group. No fallback to "all active
  // destinations" — with multiple niches sharing the system, a source group
  // without explicit links must NOT leak into every other niche's channels.
  // See the destinationGroups.length === 0 check below for the failure path.
  const links = await prisma.sourceGroupDestination.findMany({
    where: { sourceGroupId: offer.sourceGroupId },
    include: { destinationGroup: true },
  });

  const destinationGroups = links.map((l) => l.destinationGroup).filter((d) => d.isActive);

  console.log(`[Worker] Offer ${offerId}: ${destinationGroups.length} linked active destination(s)`);

  const domainSetting = await prisma.setting.findUnique({ where: { key: 'shortener_domain' } });
  const publicBaseUrl = (domainSetting?.value || 'https://ofertas.ykaromarques.com').replace(/\/$/, '');
  const publicOfferUrl = `${publicBaseUrl}/ofertas/${offerId}`;

  const amazonLink = findAmazonLinkInText(offer.processingLog);
  const footerSetting = await prisma.setting.findUnique({ where: { key: 'message_footer_text' } });
  const footerText = offer.sourceGroup.niche?.footerText?.trim() || footerSetting?.value?.trim();
  const offerWithPublicLink: OfferWithMediaType = {
    ...offer,
    text: replaceAmazonLinkWithPublicPage(offer.text, amazonLink, publicOfferUrl),
    mediaCaption: replaceAmazonLinkWithPublicPage(offer.mediaCaption, amazonLink, publicOfferUrl),
  };
  const offerToSend: OfferWithMediaType = footerText
    ? {
        ...offerWithPublicLink,
        text: offerWithPublicLink.text ? `${offerWithPublicLink.text}\n\n${footerText}` : offerWithPublicLink.text,
        mediaCaption: offerWithPublicLink.mediaCaption
          ? `${offerWithPublicLink.mediaCaption}\n\n${footerText}`
          : offerWithPublicLink.mediaCaption,
      }
    : offerWithPublicLink;

  if (destinationGroups.length === 0) {
    console.warn(`[Worker] Offer ${offerId}: source group has no linked active destinations — failing instead of broadcasting`);
    const existingLog = Array.isArray(offer.processingLog) ? offer.processingLog : [];
    await prisma.offer.update({
      where: { id: offerId },
      data: {
        status: 'FAILED',
        sentAt: new Date(),
        processingLog: [
          ...existingLog,
          {
            ts: new Date().toISOString(),
            step: 'send',
            status: 'error',
            label: 'Envio',
            error: 'Nenhum destino vinculado a este grupo fonte — configure em Grupos → Vincular destinos',
          },
        ],
      },
    });
    return;
  }

  // Idempotency guard: a BullMQ retry after a mid-loop failure (or a
  // duplicate job for the same offer) must not re-send to destinations that
  // already succeeded in a previous attempt.
  const alreadyDelivered = new Set(
    (await prisma.deliveryLog.findMany({
      where: { offerId, status: 'SUCCESS' },
      select: { destinationGroupId: true },
    })).map((l) => l.destinationGroupId),
  );

  let successCount = 0;
  let failCount = 0;

  for (const dest of destinationGroups) {
    if (alreadyDelivered.has(dest.id)) {
      console.log(`[Worker] Offer ${offerId}: already delivered to ${dest.type} group ${dest.name} in a previous attempt — skipping`);
      successCount++;
      continue;
    }

    let deliveryStatus: 'SUCCESS' | 'FAILED' = 'SUCCESS';
    let errorMessage: string | undefined;

    try {
      if (dest.type === 'TELEGRAM') {
        await sendToTelegram(dest.chatId, offerToSend);
      } else if (dest.type === 'WHATSAPP') {
        await sendToWhatsApp(dest.chatId, offerToSend);
      }
      successCount++;
      console.log(`[Worker] Sent offer ${offerId} to ${dest.type} group ${dest.name}`);
    } catch (err: unknown) {
      deliveryStatus = 'FAILED';
      errorMessage = err instanceof Error ? err.message : String(err);
      failCount++;
      console.error(
        `[Worker] Failed to send offer ${offerId} to ${dest.type} group ${dest.name}: ${errorMessage}`,
      );
    }

    await prisma.deliveryLog.create({
      data: {
        offerId,
        destinationGroupId: dest.id,
        status: deliveryStatus,
        errorMessage,
      },
    });
  }

  const finalStatus = successCount > 0 ? 'SENT' : 'FAILED';
  await prisma.offer.update({
    where: { id: offerId },
    data: { status: finalStatus, sentAt: new Date() },
  });

  console.log(
    `[Worker] Offer ${offerId} done: ${successCount} success, ${failCount} failed → status: ${finalStatus}`,
  );
}

// Amazon Associates requires tagged links to only appear on a public,
// crawlable page (not inside closed Telegram/WhatsApp groups) — so instead of
// sending the affiliate link directly, point at our own public offer page,
// which itself links out to the real tagged URL. Other marketplaces are
// unaffected.
//
// The literal string embedded in offer.text/mediaCaption isn't always the raw
// amazon.com.br link — when link_shortener_enabled is on (the default), the
// telegram-listener (affiliate_converter.py) replaces it with a shortened
// ofertas.ykaromarques.com/s/xxxxxx URL before the offer is ever saved. The
// only reliable way to know the exact substring to replace is the "final"
// field of the matching URL event in processingLog (see
// affiliate_converter.py's _process_url — "final" is exactly what got
// substituted into the text).
function findAmazonLinkInText(processingLog: unknown): string | null {
  if (!Array.isArray(processingLog)) return null;
  const urlEvent = (processingLog as Array<Record<string, unknown>>).find(
    (e) => e.step === 'url' && e.status === 'ok' && e.platform === 'Amazon',
  );
  if (!urlEvent) return null;
  const link = (urlEvent.final ?? urlEvent.affiliate) as string | undefined;
  return link ?? null;
}

function replaceAmazonLinkWithPublicPage(
  text: string | null,
  amazonLink: string | null,
  publicOfferUrl: string,
): string | null {
  if (!text || !amazonLink) return text;
  return text.split(amazonLink).join(publicOfferUrl);
}

type OfferWithMediaType = {
  mediaType: string;
  mediaLocalPath: string | null;
  mediaCaption: string | null;
  text: string | null;
};

async function sendToTelegram(chatId: string, offer: OfferWithMediaType): Promise<void> {
  switch (offer.mediaType) {
    case 'PHOTO':
      if (!offer.mediaLocalPath) throw new Error('mediaLocalPath is required for PHOTO');
      await telegramService.sendPhoto(chatId, offer.mediaLocalPath, offer.mediaCaption ?? undefined);
      break;

    case 'VIDEO':
    case 'DOCUMENT':
      if (!offer.mediaLocalPath) throw new Error('mediaLocalPath is required for VIDEO/DOCUMENT');
      await telegramService.sendDocument(chatId, offer.mediaLocalPath, offer.mediaCaption ?? undefined);
      break;

    case 'NONE':
    default:
      if (!offer.text) throw new Error('text is required when mediaType is NONE');
      await telegramService.sendText(chatId, offer.text);
      break;
  }
}

async function sendToWhatsApp(chatId: string, offer: OfferWithMediaType): Promise<void> {
  switch (offer.mediaType) {
    case 'PHOTO':
      if (!offer.mediaLocalPath) throw new Error('mediaLocalPath is required for PHOTO');
      await whatsappService.sendImage(chatId, offer.mediaLocalPath, offer.mediaCaption ?? undefined);
      break;

    case 'VIDEO':
    case 'DOCUMENT':
      if (!offer.mediaLocalPath) throw new Error('mediaLocalPath is required for VIDEO/DOCUMENT');
      await whatsappService.sendDocument(chatId, offer.mediaLocalPath, offer.mediaCaption ?? undefined);
      break;

    case 'NONE':
    default:
      if (!offer.text) throw new Error('text is required when mediaType is NONE');
      await whatsappService.sendText(chatId, offer.text);
      break;
  }
}

// Re-notify at most this often while a given group's link stays broken, so
// the admin gets one alert per outage instead of one every 15 minutes forever.
const LINK_MONITOR_RENOTIFY_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Checks every active WHATSAPP destination group that has an inviteLink
 * configured, and alerts the admin (via WhatsApp) about each one that just
 * became invalid or has stayed invalid past the renotify window.
 */
async function handleCheckInviteLink(): Promise<void> {
  const settingsRows = await prisma.setting.findMany({
    where: { key: { in: ['link_monitor_enabled', 'link_monitor_alert_number'] } },
  });
  const settingsMap: Record<string, string> = {};
  for (const r of settingsRows) settingsMap[r.key] = r.value;

  if (settingsMap.link_monitor_enabled !== 'true') return;

  const alertNumber = settingsMap.link_monitor_alert_number?.trim();
  if (!alertNumber) {
    console.warn('[Worker] Link monitor is enabled but no alert number is configured — skipping check');
    return;
  }

  // inviteLink is always trimmed to a non-empty string or null when written
  // (see groups.ts), so the `not: null` filter above is already sufficient.
  const groupsToCheck = await prisma.destinationGroup.findMany({
    where: { type: 'WHATSAPP', isActive: true, inviteLink: { not: null } },
  });
  if (groupsToCheck.length === 0) return;

  console.log(`[Worker] Link monitor: checking ${groupsToCheck.length} WhatsApp group invite link(s)`);

  for (const group of groupsToCheck) {
    await checkGroupInviteLink(group, alertNumber);
  }
}

async function checkGroupInviteLink(
  group: { id: string; name: string; inviteLink: string | null; linkStatus: string | null; linkLastNotifiedAt: Date | null },
  alertNumber: string,
): Promise<void> {
  const url = group.inviteLink!.trim();

  let result: { valid: boolean; groupName?: string };
  try {
    result = await whatsappService.checkInviteLink(url);
  } catch (err) {
    // Inconclusive (Evolution API/instance unreachable, etc.) — log and bail
    // without touching the stored status, so a transient outage never gets
    // reported to the admin as "the link expired".
    console.error(
      `[Worker] Link monitor: check for "${group.name}" was inconclusive, skipping this cycle:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }

  const now = new Date();
  const previousStatus = group.linkStatus;
  const newStatus = result.valid ? 'VALID' : 'INVALID';

  await prisma.destinationGroup.update({
    where: { id: group.id },
    data: { linkStatus: newStatus, linkLastCheckedAt: now },
  });

  if (newStatus === 'VALID') {
    console.log(`[Worker] Link monitor: "${group.name}" invite link is valid${result.groupName ? ` (${result.groupName})` : ''}`);
    return;
  }

  const lastNotifiedAt = group.linkLastNotifiedAt;
  const shouldNotify =
    previousStatus !== 'INVALID' || // just went down — always notify on transition
    !lastNotifiedAt ||
    now.getTime() - lastNotifiedAt.getTime() > LINK_MONITOR_RENOTIFY_MS;

  if (!shouldNotify) {
    console.warn(`[Worker] Link monitor: "${group.name}" still invalid, already notified recently — skipping alert`);
    return;
  }

  console.warn(`[Worker] Link monitor: "${group.name}" invite link is INVALID — alerting ${alertNumber}`);
  try {
    await whatsappService.sendText(
      alertNumber,
      `⚠️ *Alerta: link de convite expirou*\n\nO grupo "${group.name}" tem um link de convite que parou de funcionar:\n${url}\n\nGere um novo link no grupo do WhatsApp e atualize-o em Grupos → Destino.`,
    );
    // A few short retries here matter: if this write is lost to a transient
    // blip right after the WhatsApp send succeeds, linkLastNotifiedAt stays
    // stale/null and the next 15-minute cycle re-notifies immediately,
    // turning the intended "once per 12h" cooldown into "every 15 minutes".
    await updateLastNotifiedWithRetry(group.id, now);
  } catch (err) {
    console.error(
      `[Worker] Failed to send link-monitor alert for "${group.name}" via WhatsApp:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function updateLastNotifiedWithRetry(groupId: string, now: Date, attempts = 3): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await prisma.destinationGroup.update({
        where: { id: groupId },
        data: { linkLastNotifiedAt: now },
      });
      return;
    } catch (err) {
      if (attempt === attempts) {
        console.error(
          `[Worker] Giving up persisting linkLastNotifiedAt for group ${groupId} after ${attempts} attempts:`,
          err instanceof Error ? err.message : err,
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

const worker = new Worker<NewOfferJobData | SendOfferJobData>(
  'offers',
  async (job) => {
    console.log(`[Worker] Processing job ${job.id} (${job.name})`);

    if (job.name === 'new-offer') {
      await handleNewOffer(job as Job<NewOfferJobData>);
    } else if (job.name === 'send-offer') {
      await handleSendOffer(job as Job<SendOfferJobData>);
    } else {
      console.warn(`[Worker] Unknown job type: ${job.name}`);
    }
  },
  {
    connection: redis,
    concurrency: 5,
    limiter: {
      max: 10,
      duration: 1000,
    },
  },
);

worker.on('completed', (job) => {
  console.log(`[Worker] Job ${job.id} (${job.name}) completed successfully`);
});

worker.on('failed', (job, err) => {
  console.error(`[Worker] Job ${job?.id} (${job?.name}) failed:`, err.message);
});

worker.on('error', (err) => {
  console.error('[Worker] Worker error:', err);
});

const linkMonitorWorker = new Worker(
  'link-monitor',
  async (job) => {
    console.log(`[Worker] Processing job ${job.id} (${job.name}) on queue: link-monitor`);
    if (job.name === 'check-invite-link') {
      await handleCheckInviteLink();
    } else {
      console.warn(`[Worker] Unknown link-monitor job type: ${job.name}`);
    }
  },
  { connection: redis, concurrency: 1 },
);

linkMonitorWorker.on('completed', (job) => {
  console.log(`[Worker] Job ${job.id} (${job.name}) completed successfully`);
});

linkMonitorWorker.on('failed', (job, err) => {
  console.error(`[Worker] Job ${job?.id} (${job?.name}) failed:`, err.message);
});

linkMonitorWorker.on('error', (err) => {
  console.error('[Worker] link-monitor worker error:', err);
});

scheduleLinkMonitor().catch((err) => {
  console.error('[Worker] Failed to schedule link-monitor repeatable job:', err);
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`[Worker] Received ${signal}, shutting down gracefully...`);
  try {
    await worker.close();
    await linkMonitorWorker.close();
    await redis.quit();
    await prisma.$disconnect();
    console.log('[Worker] Shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('[Worker] Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log('[Worker] Started and listening for jobs on queues: offers, link-monitor');
