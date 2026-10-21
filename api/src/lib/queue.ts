import { Queue } from 'bullmq';
import redis from './redis';

const connection = redis;

export const offersQueue = new Queue('offers', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: {
      count: 1000,
      age: 60 * 60 * 24, // 24 hours
    },
    removeOnFail: {
      count: 500,
      age: 60 * 60 * 24 * 7, // 7 days
    },
  },
});

/**
 * Enqueues a job to evaluate whether a new offer should be auto-approved.
 */
export async function addNewOfferJob(offerId: string): Promise<void> {
  await offersQueue.add(
    'new-offer',
    { offerId },
    {
      jobId: `new-offer-${offerId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
    },
  );
}

/**
 * Enqueues a job to send an approved offer to all active destination groups.
 */
export async function addSendOfferJob(offerId: string): Promise<void> {
  await offersQueue.add(
    'send-offer',
    { offerId },
    {
      jobId: `send-offer-${offerId}-${Date.now()}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  );
}

export const linkMonitorQueue = new Queue('link-monitor', {
  connection,
  defaultJobOptions: {
    attempts: 1, // a failed check just gets tried again on the next repeat tick
    removeOnComplete: { count: 200, age: 60 * 60 * 24 * 3 }, // 3 days
    removeOnFail: { count: 200, age: 60 * 60 * 24 * 3 },
  },
});

const LINK_MONITOR_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Schedules the recurring "is the monitored WhatsApp invite link still
 * valid?" check as a BullMQ repeatable job. Safe to call on every worker
 * boot — a fixed jobId makes BullMQ update the existing repeat schedule
 * instead of stacking duplicates.
 */
export async function scheduleLinkMonitor(): Promise<void> {
  await linkMonitorQueue.add(
    'check-invite-link',
    {},
    {
      jobId: 'check-invite-link-repeat',
      repeat: { every: LINK_MONITOR_INTERVAL_MS },
    },
  );
}

const SILENT_GROUP_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Schedules the recurring "has any active source group gone quiet?" check.
 * Same idempotency trick as scheduleLinkMonitor — fixed jobId, safe to call on
 * every worker boot.
 */
export async function scheduleSilentGroupCheck(): Promise<void> {
  await linkMonitorQueue.add(
    'check-silent-groups',
    {},
    {
      jobId: 'check-silent-groups-repeat',
      repeat: { every: SILENT_GROUP_CHECK_INTERVAL_MS },
    },
  );
}

const MEMBER_SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Schedules the recurring WhatsApp member snapshot (member count + catching
 * joins/leaves the webhook missed). Fixed jobId — safe on every worker boot.
 */
export async function scheduleMemberSnapshot(): Promise<void> {
  await linkMonitorQueue.add(
    'snapshot-wa-members',
    {},
    {
      jobId: 'snapshot-wa-members-repeat',
      repeat: { every: MEMBER_SNAPSHOT_INTERVAL_MS, immediately: true },
    },
  );
}

const SHOPEE_HUNTER_TICK_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Recurring tick of the automatic Shopee search: runs each niche's search
 * when it's due and releases one offer per niche when a sending slot opens.
 */
export async function scheduleShopeeHunter(): Promise<void> {
  await linkMonitorQueue.add(
    'shopee-hunter-tick',
    {},
    { jobId: 'shopee-hunter-tick-repeat', repeat: { every: SHOPEE_HUNTER_TICK_MS } },
  );
}

// Lead adding has its own queue so a long job elsewhere (ads sync, Shopee
// search) never delays it; each tick does at most one action per number.
export const leadsQueue = new Queue('leads', {
  connection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 100, age: 60 * 60 * 24 },
    removeOnFail: { count: 100, age: 60 * 60 * 24 * 3 },
  },
});

const LEADS_TICK_MS = 30 * 1000;

export async function scheduleLeadsTick(): Promise<void> {
  await leadsQueue.add('leads-tick', {}, { jobId: 'leads-tick-repeat', repeat: { every: LEADS_TICK_MS } });
}

const ADS_SYNC_MS = 60 * 60 * 1000; // hourly

/** Meta Ads delivery + Shopee sales sync, followed by the ad monitoring rules. */
export async function scheduleAdsSync(): Promise<void> {
  await linkMonitorQueue.add('ads-sync', {}, { jobId: 'ads-sync-repeat', repeat: { every: ADS_SYNC_MS } });
}
