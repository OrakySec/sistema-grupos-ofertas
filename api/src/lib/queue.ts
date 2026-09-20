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
