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
  // Marketplaces
  marketplace_amazon_enabled: 'true',
  marketplace_shopee_enabled: 'true',
  marketplace_aliexpress_enabled: 'true',
  marketplace_magalu_enabled: 'true',
  marketplace_mercadolivre_enabled: 'true',
  // Shortener settings
  shortener_provider: 'internal',
  shortener_domain: 'https://ofertas.ykaromarques.com',
};

export async function seed() {
  console.log('[Seed] Starting database seed...');

  // Seeding default settings...
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

if (typeof require !== 'undefined' && require.main === module) {
  seed()
    .catch((err) => {
      console.error('[Seed] Error during seeding:', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
