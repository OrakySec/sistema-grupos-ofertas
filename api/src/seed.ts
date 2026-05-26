import prisma from './lib/prisma';

const DEFAULT_SETTINGS: Record<string, string> = {
  auto_approve: 'false',
  telegram_bot_token: '',
  telegram_api_id: '',
  telegram_api_hash: '',
  telegram_phone: '',
  evolution_api_url: '',
  evolution_api_key: '',
  evolution_instance: '',
};

async function seed() {
  console.log('[Seed] Starting database seed...');

  // Check if settings table is empty
  const existingCount = await prisma.setting.count();

  if (existingCount > 0) {
    console.log(`[Seed] Settings table already has ${existingCount} records. Skipping seed.`);
    return;
  }

  console.log('[Seed] Seeding default settings...');

  const upsertOps = Object.entries(DEFAULT_SETTINGS).map(([key, value]) =>
    prisma.setting.upsert({
      where: { key },
      update: {}, // Don't overwrite existing values
      create: { key, value },
    }),
  );

  await Promise.all(upsertOps);

  console.log(`[Seed] Created ${Object.keys(DEFAULT_SETTINGS).length} default settings`);
  console.log('[Seed] Done!');
}

seed()
  .catch((err) => {
    console.error('[Seed] Error during seeding:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
