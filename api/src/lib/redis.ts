import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null, // required by BullMQ
  enableReadyCheck: false,
  lazyConnect: false,
});

redis.on('connect', () => {
  console.log('[Redis] Connected successfully');
});

redis.on('error', (err) => {
  console.error('[Redis] Connection error:', err);
});

redis.on('reconnecting', () => {
  console.log('[Redis] Reconnecting...');
});

export default redis;
