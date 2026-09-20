/**
 * Turns an offer's processingLog (and delivery errors) into ONE short,
 * human-readable, groupable reason for why it was rejected / failed — so the
 * panel can show "why" right on the card and the health view can count
 * offers per reason instead of every error being a unique free-text string.
 *
 * Reasons are intentionally coarse buckets (same wording every time) so they
 * aggregate well; the full raw error is still in the processingLog.
 */

interface LogEvent {
  step?: string;
  status?: string;
  error?: string;
  detail?: string;
  platform?: string;
}

interface OfferLike {
  status: string;
  processingLog?: unknown;
  deliveryLogs?: Array<{ status: string; errorMessage?: string | null }>;
}

function events(processingLog: unknown): LogEvent[] {
  return Array.isArray(processingLog) ? (processingLog as LogEvent[]) : [];
}

function bucketFromError(error: string, platform?: string): string {
  const e = error.toLowerCase();
  if (e.includes('timeout')) return `Timeout na conversão${platform ? ` (${platform})` : ''}`;
  if (e.includes('plataforma não reconhecida')) return 'Plataforma não reconhecida';
  if (e.includes('perfil/lista')) return 'Link de perfil/lista do Mercado Livre';
  if (e.includes('expirada')) return 'Sessão do Mercado Livre expirada';
  if (e.includes('não configurad')) return 'Tag/ID de afiliado não configurado';
  if (e.includes('seletor')) return 'Mercado Livre: não leu o link gerado';
  if (e.includes('falha na automação')) return 'Mercado Livre: falha na automação';
  return error.length > 70 ? `${error.slice(0, 70)}…` : error;
}

/** Returns a reason for REJECTED / FAILED offers, or null when nothing is wrong. */
export function classifyOfferProblem(offer: OfferLike): string | null {
  if (offer.status !== 'REJECTED' && offer.status !== 'FAILED') return null;

  const evs = events(offer.processingLog);

  const marketplace = evs.find((e) => e.step === 'marketplace_filter');
  if (marketplace) return 'Marketplace desativado nas configurações';

  const sendError = evs.find((e) => e.step === 'send' && e.status === 'error');
  if (sendError?.error?.toLowerCase().includes('nenhum destino')) return 'Sem destino vinculado ao grupo de origem';

  // Prefer the root-cause event (url / url_convert error) over the generic
  // "link_filter" marker the API appends after it.
  const cause = evs.find(
    (e) =>
      (e.step === 'url' && (e.status === 'error' || e.status === 'skipped')) ||
      (e.step === 'url_convert' && e.status === 'error'),
  );
  if (cause) return bucketFromError(cause.error ?? cause.detail ?? 'Erro na conversão do link', cause.platform);

  if (evs.some((e) => e.step === 'link_filter')) return 'Link não identificado';

  if (offer.status === 'FAILED') {
    const failedDelivery = offer.deliveryLogs?.find((d) => d.status === 'FAILED' && d.errorMessage);
    if (failedDelivery?.errorMessage) return `Falha no envio: ${bucketFromError(failedDelivery.errorMessage)}`;
    return 'Falha no envio';
  }
  return 'Rejeitada (motivo não registrado)';
}
