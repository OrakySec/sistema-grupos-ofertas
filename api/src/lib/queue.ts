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
