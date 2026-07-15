import { Worker, Job } from 'bullmq';
import redis from './lib/redis';
import prisma from './lib/prisma';
import { addSendOfferJob } from './lib/queue';
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

  const autoApproveSetting = await prisma.setting.findUnique({
    where: { key: 'auto_approve' },
  });

  if (autoApproveSetting?.value === 'true') {
    console.log(`[Worker] Auto-approving offer ${offerId}`);
    await prisma.offer.update({
      where: { id: offerId },
      data: { status: 'APPROVED', reviewedAt: new Date() },
    });
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

  let successCount = 0;
  let failCount = 0;

  for (const dest of destinationGroups) {
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

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`[Worker] Received ${signal}, shutting down gracefully...`);
  try {
    await worker.close();
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

console.log('[Worker] Started and listening for jobs on queue: offers');
