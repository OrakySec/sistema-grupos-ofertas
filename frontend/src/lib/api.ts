/* ─────────────────────────────────────────
   API Client
   Base URL: import.meta.env.VITE_API_URL or /api
───────────────────────────────────────── */

const BASE_URL = (import.meta.env.VITE_API_URL as string) || '/api'

// Carries the HTTP status alongside the message so callers can react to a
// specific status (e.g. 409 "has history, confirm force-delete") instead of
// only having the display text to work with.
export interface ShopeeSale {
  id: string
  purchaseTime: string
  clickTime: string | null
  utmContent: string | null
  subCode: string
  source: string
  label: string | null
  orderIds: string[]
  products: string[]
  items: number
  gmv: number
  pending: number
  confirmed: number
  cancelled: number
  status: string
  fraud: boolean
  purchaseEvent: { status: 'SENT' | 'FAILED' | 'NO_MATCH' | 'TOO_OLD' | 'SKIPPED'; detail: string | null; at: string | null } | null
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export interface PaginationParams {
  page?: number
  limit?: number
  status?: string
  dateRange?: string
}

export interface ProcessingEvent {
  ts: string
  // pipeline step identifier
  step?: string           // 'received' | 'sender' | 'media_download' | 'url_detect' | 'url' | 'url_convert' | 'api_post'
  label?: string          // human-readable step name
  detail?: string         // extra info for non-url steps
  // url-specific fields (step === 'url')
  original?: string | null
  expanded?: string | null
  platform?: string | null
  affiliate?: string | null
  shortened?: string | null
  final?: string | null
  status: 'ok' | 'skipped' | 'error' | 'info'
  error?: string | null
}

export interface Offer {
  id: string
  problemReason?: string | null
  sourceGroupId: string
  sourceGroup?: {
    id: string
    name: string
    destinations?: Array<{
      destinationGroup: {
        id: string
        name: string
        type: string
      }
    }>
  }
  text?: string | null
  mediaType?: 'PHOTO' | 'VIDEO' | 'DOCUMENT' | null
  mediaCaption?: string | null
  mediaPath?: string | null
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SENT' | 'FAILED'
  createdAt: string
  updatedAt: string
  deliveryLogs?: DeliveryLog[]
  processingLog?: ProcessingEvent[] | null
}

export interface ProcessingOffer {
  id: string
  problemReason?: string | null
  telegramMessageId: string
  text?: string | null
  mediaType: string
  mediaCaption?: string | null
  senderName?: string | null
  status: string
  createdAt: string
  sentAt?: string | null
  processingLog?: ProcessingEvent[] | null
  sourceGroup?: { id: string; name: string }
  deliveryLogs?: Array<{
    id: string
    status: 'SUCCESS' | 'FAILED'
    errorMessage?: string | null
    sentAt: string
    destinationGroup?: { id: string; name: string; type: string }
  }>
}

export interface DeliveryLog {
  id: string
  offerId: string
  offer?: { text?: string; mediaType: string; sourceGroup?: { id: string; name: string } }
  destinationGroupId: string
  destinationGroup?: { name: string; type: 'TELEGRAM' | 'WHATSAPP' }
  status: 'SUCCESS' | 'FAILED'
  errorMessage?: string | null
  sentAt: string
}

export interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface Niche {
  id: string
  name: string
  slug?: string | null
  footerText?: string | null
  mlOwnListUrl?: string | null
  mockupTemplatePath?: string | null
  mockupBoxLeft?: number | null
  mockupBoxTop?: number | null
  mockupBoxRight?: number | null
  mockupBoxBottom?: number | null
  mockupCornerRadius?: number | null
  sourceGroupCount?: number
}

export interface SourceGroup {
  id: string
  // TELEGRAM = real channel; SHOPEE = virtual source of a niche's automatic search
  kind?: 'TELEGRAM' | 'SHOPEE'
  name: string
  username?: string | null
  telegramId: string
  isActive: boolean
  createdAt: string
  // Several source groups can share one niche (mockup/footer/ML link/public page)
  nicheId?: string | null
  niche?: Niche | null
}

export interface DestinationGroup {
  id: string
  name: string
  type: 'TELEGRAM' | 'WHATSAPP'
  chatId: string
  isActive: boolean
  createdAt: string
  // WhatsApp invite-link monitor (WHATSAPP groups only)
  inviteLink?: string | null
  linkStatus?: 'VALID' | 'INVALID' | 'UNKNOWN' | null
  linkLastCheckedAt?: string | null
}

export interface Settings {
  autoApprove: boolean
  messageFooterText?: string
  telegramBotToken?: string
  telegramApiId?: number
  telegramApiHash?: string
  telegramPhone?: string
  telegramAuthenticated?: boolean
  evolutionApiUrl?: string
  evolutionApiKey?: string
  evolutionInstance?: string
  whatsappProvider?: 'EVOLUTION' | 'WAHA'
  wahaApiUrl?: string
  wahaApiKey?: string
  // Affiliate link conversion
  amazonAffiliateTag?: string
  shopeeAffiliateId?: string
  shopeeAppId?: string
  shopeeAppSecret?: string
  aliexpressTrackingId?: string
  magaluStoreName?: string
  mlOwnListUrl?: string
  stripLinkDomains?: string
  stripWords?: string
  mlSessionActive?: boolean
  linkShortenerEnabled?: boolean
  shortenerProvider?: string
  shortenerDomain?: string
  // Platforms whose links get shortened; empty = all
  shortenerPlatforms?: string[]
  // Marketplace toggles
  marketplaceAmazonEnabled?: boolean
  marketplaceShopeeEnabled?: boolean
  marketplaceAliExpressEnabled?: boolean
  marketplaceMagaluEnabled?: boolean
  marketplaceMercadoLivreEnabled?: boolean
  // Invite link monitor (global on/off + who gets alerted; the links
  // themselves live per-group on DestinationGroup.inviteLink)
  linkMonitorEnabled?: boolean
  linkMonitorAlertNumber?: string
}

export interface Stats {
  pending: number
  approvedToday: number
  sentToday: number
  failedToday: number
  clicksToday?: number
}

// ── WhatsApp group analytics ─────────────────
export interface WaPeriodStats {
  membersNow: number | null
  joins: number
  leaves: number
  kicks: number
  net: number
  membersStart: number | null
  retentionPct: number | null
  churnPct: number | null
  quickLeaves: number
  avgTenureDays: number | null
  offersSent: number
  clicks: number
  clicksPerMember: number | null
  clicksPerOffer: number | null
  exitsPer100Offers: number | null
}

export interface WaGroupAnalytics extends WaPeriodStats {
  id: string
  name: string
  isActive: boolean
  trackingSince: string | null
}

export interface WaAnalytics {
  generatedAt: string
  days: number
  from: string
  to: string
  bucket: 'day' | 'hour'
  endsNow: boolean
  trackingSince: string | null
  groupOptions: Array<{ id: string; name: string }>
  totals: WaPeriodStats
  series: Array<{ date: string; members: number | null; joins: number; exits: number; offers: number; clicks: number }>
  cohorts: Array<{ label: string; size: number; d1: number | null; d7: number | null; d30: number | null }>
  joinsByHour: number[]
  exitsByHour: number[]
  clicksByHour: number[]
  groups: WaGroupAnalytics[]
}

export type WaWebhookState = 'ACTIVE' | 'NOT_CONFIGURED' | 'DISABLED' | 'OTHER_URL' | 'MISSING_EVENT' | 'ERROR'

export interface WaWebhookStatus {
  state: WaWebhookState
  ourUrl: string
  currentUrl?: string
  currentEvents?: string[]
  lastEventAt?: string | null
  error?: string
}

export interface WaSnapshotResult {
  group: string
  members?: number
  joins?: number
  leaves?: number
  baseline?: boolean
  skipped?: string
  error?: string
}

// ── Automatic Shopee search ──────────────────
export type HunterMode = 'OFF' | 'PREVIEW' | 'APPROVAL' | 'AUTO' | 'AUTO_BEST'

export interface ShopeeHunterConfig {
  id: string
  nicheId: string
  sourceGroupId: string
  mode: HunterMode
  keywords: string
  forbiddenWords: string
  minPrice: number | null
  maxPrice: number | null
  minRating: number
  minSales: number
  minCommissionPct: number
  minDiscountPct: number
  minScore: number
  autoMinScore: number
  officialOnly: boolean
  intervalHours: number
  dailyLimit: number
  minIntervalMin: number
  quietStart: number
  quietEnd: number
  useCoupons: boolean
  lastRunAt: string | null
  lastRunSummary: { at: string; keywords: number; found: number; passed: number; newCandidates: number; rejected: Record<string, number>; errors: string[] } | null
}

export interface HunterCandidate {
  id: string
  keyword: string
  price: number
  originalPrice: number | null
  discountPct: number | null
  discountSource: 'HISTORY' | 'ANNOUNCED'
  score: number
  scoreDetail: Record<string, number> | null
  status: 'PREVIEW' | 'READY' | 'QUEUED' | 'SENT' | 'EXPIRED'
  offerId: string | null
  createdAt: string
  product?: { name: string; imageUrl: string | null; productLink: string | null; ratingStar: number | null; sales: number | null; commissionPct: number | null; shopName: string | null; isOfficial: boolean }
}

export interface HunterListItem {
  nicheId: string
  nicheName: string
  mode: HunterMode
  keywords: number
  lastRunAt: string | null
  last24h: { preview: number; ready: number; queued: number; sent: number }
}

export interface Coupon {
  id: string
  code: string
  discountType: 'FIXED' | 'PERCENT'
  value: number
  maxDiscount: number | null
  minSpend: number | null
  validUntil: string | null
  status: 'ACTIVE' | 'EXPIRED' | 'EXHAUSTED'
  endReason: string | null
  sourceCount: number
  mentions: number
  usedCount: number
  sample: string | null
  firstSeenAt: string
  lastSeenAt: string
}

// ── Paid traffic (Meta Ads + Shopee sales) ───
export type AdLevel = 'CAMPAIGN' | 'ADSET' | 'AD'

export interface AdMetrics {
  spend: number
  impressions: number
  clicks: number
  linkClicks: number
  realClicks: number
  cpcLink: number | null
  ctr: number | null
  orders: number
  gmv: number
  commissionPending: number
  commissionConfirmed: number
  commissionCancelled: number
  profitProjected: number
  profitConfirmed: number
  roas: number | null
  cpa: number | null
}

export interface MetaRule {
  id: string
  entityId: string
  level: AdLevel
  enabled: boolean
  maxCpc: number
  days: number
  mode: 'CONSECUTIVE' | 'AVERAGE'
  minSpend: number
  action: 'NOTIFY' | 'PAUSE'
  lastFiredAt: string | null
  lastCheck: { at: string; breach?: boolean; reason?: string; skipped?: string } | null
}

export interface AdRow {
  id: string
  level: AdLevel
  name: string
  status: string
  campaignId: string | null
  adsetId: string | null
  children: number
  links?: number
  metrics: AdMetrics
  rule: MetaRule | null
}

export interface AdsConfig {
  tokenSet: boolean
  accounts: string
  version: string
  lastMetaSync: { at: string; results: Array<{ account: string; campaigns?: number; adsets?: number; ads?: number; insightRows?: number; error?: string }> } | null
  lastShopeeSync: { at: string; nodes: number; saved: number; error?: string } | null
  ruleDefaults: { maxCpc: number; days: number; mode: 'CONSECUTIVE' | 'AVERAGE'; minSpend: number; action: 'NOTIFY' | 'PAUSE' }
  pixel: {
    pixelId: string
    tokenSet: boolean
    testCode: string
    stats: { day: string; sent: number; failed: number; last?: { at: string; ok: boolean; detail: string; fbc: boolean } } | null
  }
}

export interface AdLinkItem {
  id: string
  code: string
  label: string | null
  metaAdId: string | null
  adName: string | null
  productUrl: string
  shopeeLink: string
  finalLink: string
  createdAt: string
}

export interface WhatsAppGroup {
  id: string
  name: string
  participants?: number
}

// ── Clicks ───────────────────────────────────
export interface ClickStats {
  /** Real people only (plus clicks logged before bots could be told apart). */
  total: number
  chartData: { date: string; clicks: number }[]
  topLinks: { originalUrl: string; title?: string; count: number }[]
  breakdown?: {
    human: number
    legacy: number
    duplicate: number
    bot: number
    uniqueVisitors: number
    allRequests: number
  }
  botAgents?: { agent: string; count: number }[]
  botSamples?: { userAgent: string; count: number }[]
  timezone?: string
}

// ── Health (per-group) ───────────────────────
export type HealthLevel = 'ok' | 'warning' | 'critical' | 'inactive'

export interface ReasonCount {
  reason: string
  count: number
}

export interface SourceGroupHealth {
  id: string
  name: string
  telegramId: string
  isActive: boolean
  nicheName: string | null
  level: HealthLevel
  issues: string[]
  lastOfferAt: string | null
  lastSentAt: string | null
  silentHours: number | null
  counts: { total: number; pending: number; approved: number; sent: number; rejected: number; failed: number }
  problemReasons: ReasonCount[]
  destinations: Array<{ id: string; name: string; type: 'TELEGRAM' | 'WHATSAPP'; isActive: boolean }>
}

export interface DestinationGroupHealth {
  id: string
  name: string
  type: 'TELEGRAM' | 'WHATSAPP'
  chatId: string
  isActive: boolean
  level: HealthLevel
  issues: string[]
  linkedSources: number
  lastSuccessAt: string | null
  lastFailure: { at: string; error: string | null } | null
  counts: { success: number; failed: number }
  failureReasons: ReasonCount[]
  linkStatus: 'VALID' | 'INVALID' | 'UNKNOWN' | null
}

export interface GroupsHealth {
  generatedAt: string
  windowHours: number
  thresholds: { silentWarnHours: number; silentCritHours: number }
  system: {
    autoApprove: boolean
    listener: { reachable: boolean; authenticated: boolean | null; mlSessionActive: boolean | null }
    evolutionConnected: boolean
  }
  sourceGroups: SourceGroupHealth[]
  destinationGroups: DestinationGroupHealth[]
}

// ── Unidentified links ───────────────────────
export interface UnidentifiedLinkDomain {
  domain: string
  occurrences: number
  offers: number
  rejectedOffers: number
  stripped: number
  lastSeenAt: string
  blocked: boolean
  looksLikeShortener: boolean
  resolvesTo: string | null
  groups: Array<{ id: string; name: string; count: number }>
  samples: Array<{ url: string; at: string }>
}

export interface UnidentifiedLinks {
  generatedAt: string
  windowHours: number
  blockedDomains: string[]
  totals: { domains: number; affectedOffers: number }
  domains: UnidentifiedLinkDomain[]
}

// ── WhatsApp numbers (QR code) & Leads ─────────────────────────────────────

export type WaProvider = 'EVOLUTION' | 'WAHA'

export interface WaNumber {
  id: string
  label: string
  purpose: 'OFFERS' | 'LEADS'
  name: string
  provider: WaProvider
  sendsOffers: boolean
  offersToday: number
  connected: boolean
  number: string | null
  profileName: string | null
  lastState: string | null
  lastSeenAt: string | null
  createdAt: string
  lastDisconnectAt: string | null
  lastDisconnectCode: number | null
  lastDisconnectText: string | null
}

export interface LeadSafety {
  dailyLimit: number
  minDelaySec: number
  maxDelaySec: number
  restEvery: number
  restDays: number
  startHour: number
  endHour: number
  weekdays: number[]
  warmup: boolean
  warmupStart: number
  warmupStep: number
  groupCap: number
  inviteDailyLimit: number
  inviteText: string
  maxFailStreak: number
}

export interface LeadQueueStatus {
  addsToday: number
  invitesToday: number
  limit: number
  inviteLimit: number
  queued: number
  invitePending: number
  nextAt: string | null
  waitingFor: 'paused' | 'rest' | 'daily_limit' | 'window' | 'empty' | null
  sinceRest: number
  restEvery: number
  paused: boolean
  pausedReason: string | null
  lastResult: string | null
}

/** ADD = the queue adds; INVITE = link in private only; MANUAL = the owner adds from the phone. */
export type LeadMode = 'ADD' | 'INVITE' | 'MANUAL'

export type LeadStatus = 'QUEUED' | 'ADDED' | 'INVITED' | 'INVITE_PENDING' | 'MANUAL_PENDING' | 'ALREADY_MEMBER' | 'NO_WHATSAPP' | 'BLOCKED' | 'DUPLICATE' | 'FAILED'

export interface ManualBatchRow { id: string; phone: string; name: string | null; group: string | null; status: 'PENDING' | 'ADDED'; at: string | null; helper: string | null }

export interface HelperSafety {
  dailyLimit: number
  warmup: boolean
  warmupStart: number
  warmupStep: number
  restEvery: number
  restDays: number
  weekdays: number[]
  sendHour: number
  expireDays: number
  /** LIST = numbers in the message, one per line; EACH = one number per message; VCF = contacts file */
  delivery: 'LIST' | 'EACH' | 'VCF'
  message: string
}

/** A phone that gets a daily batch to add by hand ("Adicionar pelo celular" lists). */
export interface LeadHelperItem {
  id: string
  label: string
  phone: string
  safety: HelperSafety
  paused: boolean
  pausedReason: string | null
  restUntil: string | null
  lastSentAt: string | null
  lastResult: string | null
  limit: number
  sentToday: number
  pending: number
  added: number
  addedToday: number
  sinceRest: number
  nextAt: string | null
  campaigns: Array<{ id: string; name: string; mode: string; status: string }>
}
export interface ManualBatch { prefix: string | null; pending: ManualBatchRow[]; added: ManualBatchRow[]; queued: number }

export interface LeadCampaignItem {
  id: string
  name: string
  status: 'ACTIVE' | 'PAUSED' | 'DONE'
  pausedReason: string | null
  niche: string | null
  groups: Array<{ id: string; name: string }>
  instance: { id: string; label: string; connected: boolean; number: string | null }
  instances: Array<{ id: string; label: string; connected: boolean; number: string | null }>
  inviteFallback: boolean
  mode: LeadMode
  counts: Record<LeadStatus, number>
  total: number
  left: number
  intakeUrl: string
  createdAt: string
}

export interface LeadResultsSummary {
  processed: number
  added: number
  invitesSent: number
  invitesJoined: number
  inviteConversionPct: number | null
  alreadyMember: number
  noWhatsApp: number
  blocked: number
  failed: number
  entered: number
  left: number
  stillIn: number
  retentionPct: number | null
  leftPct: number | null
  quickLeaves: number
  avgTenureDays: number | null
  d1: { eligible: number; pct: number | null }
  d7: { eligible: number; pct: number | null }
  d30: { eligible: number; pct: number | null }
}

export interface LeadResults {
  from: string
  to: string
  bucket: 'day' | 'hour'
  totals: LeadResultsSummary
  series: Array<{ date: string; entered: number; left: number; invitesSent: number }>
  byCampaign: Array<LeadResultsSummary & { key: string; label: string }>
  byGroup: Array<LeadResultsSummary & { key: string; label: string }>
  bySource: Array<LeadResultsSummary & { key: string; label: string }>
  byInstance: Array<LeadResultsSummary & { key: string; label: string }>
  lastCheck: { at: string; results: Array<{ group: string; left?: number; joined?: number; skipped?: string }> } | null
  options: { campaigns: Array<{ id: string; name: string }>; instances: Array<{ id: string; label: string }> }
}

export interface LeadImportResult {
  created: number
  blocked?: number
  duplicates: number
  invalid: number
  invalidSamples: string[]
  alreadyInCampaign?: number
  fromGroup?: { group: string; total: number; hidden: number; admins: number; own: number }
}

class ApiClient {
  private baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  private getToken(): string | null {
    return localStorage.getItem('auth_token')
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    const token = this.getToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    return headers
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const headers = this.getHeaders()
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (res.status === 401) {
      localStorage.removeItem('auth_token')
      window.location.href = '/login'
      throw new Error('Sessão expirada. Faça login novamente.')
    }

    let data: unknown
    const contentType = res.headers.get('content-type')
    if (contentType && contentType.includes('application/json')) {
      data = await res.json()
    } else {
      data = await res.text()
    }

    if (!res.ok) {
      const errMsg =
        (data as { message?: string })?.message ||
        (data as { error?: string })?.error ||
        (typeof data === 'string' && data.trim() && data.length < 300 ? data : '') ||
        `Erro ${res.status}${res.statusText ? `: ${res.statusText}` : ''}`
      throw new ApiError(errMsg, res.status)
    }

    return data as T
  }

  // ── Auth ──────────────────────────────────────
  async login(email: string, password: string): Promise<{ token: string }> {
    return this.request('POST', '/auth/login', { email, password })
  }

  async getMe(): Promise<{ email: string; id: string }> {
    return this.request('GET', '/auth/me')
  }

  // ── Stats ─────────────────────────────────────
  async getStats(): Promise<Stats> {
    return this.request('GET', '/stats')
  }

  async getClicksStats(period: string = 'today'): Promise<ClickStats> {
    return this.request('GET', `/stats/clicks?period=${period}`)
  }

  // ── Offers ────────────────────────────────────
  async getOffers(params: PaginationParams = {}): Promise<PaginatedResponse<Offer>> {
    const qs = new URLSearchParams()
    if (params.page) qs.set('page', String(params.page))
    if (params.limit) qs.set('limit', String(params.limit))
    if (params.status) qs.set('status', params.status)
    if (params.dateRange) qs.set('dateRange', params.dateRange)
    return this.request('GET', `/offers?${qs.toString()}`)
  }

  async getOffer(id: string): Promise<Offer> {
    return this.request('GET', `/offers/${id}`)
  }

  async approveOffer(id: string): Promise<{ success: boolean }> {
    return this.request('PATCH', `/offers/${id}/approve`)
  }

  async rejectOffer(id: string): Promise<{ success: boolean }> {
    return this.request('PATCH', `/offers/${id}/reject`)
  }

  async batchApproveOffers(ids: string[]): Promise<{ success: boolean; count: number }> {
    return this.request('POST', '/offers/batch-approve', { ids })
  }

  // ── Source Groups ─────────────────────────────
  async getSourceGroups(): Promise<SourceGroup[]> {
    return this.request('GET', '/groups/source')
  }

  async createSourceGroup(data: {
    name: string
    telegramId: string
    username?: string
  }): Promise<SourceGroup> {
    return this.request('POST', '/groups/source', data)
  }

  async updateSourceGroup(
    id: string,
    data: Partial<{
      name: string
      telegramId: string
      username: string
      isActive: boolean
      nicheId: string | null
    }>
  ): Promise<SourceGroup> {
    return this.request('PATCH', `/groups/source/${id}`, data)
  }

  async deleteSourceGroup(id: string, force = false): Promise<{ success: boolean }> {
    return this.request('DELETE', `/groups/source/${id}${force ? '?force=true' : ''}`)
  }

  // ── Niches ────────────────────────────────────
  async getNiches(): Promise<Niche[]> {
    return this.request('GET', '/niches')
  }

  async createNiche(data: { name: string; slug?: string | null }): Promise<Niche> {
    return this.request('POST', '/niches', data)
  }

  async updateNiche(
    id: string,
    data: Partial<{
      name: string
      slug: string | null
      footerText: string | null
      mlOwnListUrl: string | null
      clearMockupTemplate: boolean
    }>
  ): Promise<Niche> {
    return this.request('PATCH', `/niches/${id}`, data)
  }

  async deleteNiche(id: string): Promise<{ success: boolean }> {
    return this.request('DELETE', `/niches/${id}`)
  }

  async uploadNicheMockupTemplate(
    nicheId: string,
    file: File,
    box: { left: number; top: number; right: number; bottom: number },
    cornerRadius: number
  ): Promise<Niche> {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('boxLeft', String(Math.round(box.left)))
    formData.append('boxTop', String(Math.round(box.top)))
    formData.append('boxRight', String(Math.round(box.right)))
    formData.append('boxBottom', String(Math.round(box.bottom)))
    formData.append('cornerRadius', String(Math.round(cornerRadius)))

    const headers = this.getHeaders()
    const res = await fetch(`${this.baseUrl}/niches/${nicheId}/mockup-template`, {
      method: 'POST',
      headers,
      body: formData,
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data?.error || `Erro ${res.status}: ${res.statusText}`)
    }
    return data
  }

  async getSourceGroupDestinations(sourceGroupId: string): Promise<DestinationGroup[]> {
    return this.request('GET', `/groups/source/${sourceGroupId}/destinations`)
  }

  async setSourceGroupDestinations(sourceGroupId: string, destinationIds: string[]): Promise<DestinationGroup[]> {
    return this.request('PUT', `/groups/source/${sourceGroupId}/destinations`, { destinationIds })
  }

  // ── Destination Groups ────────────────────────
  async getDestinationGroups(): Promise<DestinationGroup[]> {
    return this.request('GET', '/groups/destination')
  }

  async createDestinationGroup(data: {
    name: string
    type: 'TELEGRAM' | 'WHATSAPP'
    chatId: string
    inviteLink?: string
  }): Promise<DestinationGroup> {
    return this.request('POST', '/groups/destination', data)
  }

  async updateDestinationGroup(
    id: string,
    data: Partial<{ name: string; chatId: string; isActive: boolean; inviteLink: string | null }>
  ): Promise<DestinationGroup> {
    return this.request('PATCH', `/groups/destination/${id}`, data)
  }

  async deleteDestinationGroup(id: string, force = false): Promise<{ success: boolean }> {
    return this.request('DELETE', `/groups/destination/${id}${force ? '?force=true' : ''}`)
  }

  // ── Settings ──────────────────────────────────
  async getSettings(): Promise<Settings> {
    return this.request('GET', '/settings')
  }

  async updateSettings(data: Partial<Settings>): Promise<Settings> {
    return this.request('PUT', '/settings', data)
  }

  async testTelegram(): Promise<{ success: boolean; message: string }> {
    return this.request('POST', '/settings/test-telegram')
  }

  async testShopee(): Promise<{ success: boolean; message: string }> {
    return this.request('POST', '/settings/test-shopee')
  }

  async testWhatsApp(): Promise<{ success: boolean; message: string }> {
    return this.request('POST', '/settings/test-whatsapp')
  }

  async testLinkMonitor(url?: string): Promise<{ success: boolean; valid?: boolean; message: string }> {
    return this.request('POST', '/settings/test-link-monitor', url ? { url } : undefined)
  }

  async startTelegramAuth(phone: string): Promise<{ success: boolean; message: string }> {
    return this.request('POST', '/settings/telegram-auth/start', { phone })
  }

  async verifyTelegramAuth(code: string): Promise<{ success: boolean; message: string }> {
    return this.request('POST', '/settings/telegram-auth/verify', { code })
  }

  async uploadMlSession(file: File): Promise<{ success: boolean; active: boolean; message?: string }> {
    const formData = new FormData()
    formData.append('file', file)
    const headers = this.getHeaders()
    const res = await fetch(`${this.baseUrl}/settings/ml-session`, {
      method: 'POST',
      headers,
      body: formData,
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data?.message || `Erro ${res.status}: ${res.statusText}`)
    }
    return data
  }

  // ── WhatsApp ──────────────────────────────────
  async getWhatsAppGroups(): Promise<WhatsAppGroup[]> {
    return this.request('GET', '/settings/whatsapp-groups')
  }

  // ── Logs ──────────────────────────────────────
  async getDeliveryLogs(limit = 100, sourceGroupId?: string): Promise<DeliveryLog[]> {
    const params = new URLSearchParams({ limit: String(limit) })
    if (sourceGroupId) params.set('sourceGroupId', sourceGroupId)
    return this.request('GET', `/logs?${params.toString()}`)
  }

  async getUnidentifiedLinks(hours = 72): Promise<UnidentifiedLinks> {
    return this.request('GET', `/health/links?hours=${hours}`)
  }

  async addStripDomain(domain: string): Promise<{ success: boolean; domains: string[] }> {
    return this.request('POST', '/settings/strip-domain', { domain })
  }

  async removeStripDomain(domain: string): Promise<{ success: boolean; domains: string[] }> {
    return this.request('DELETE', `/settings/strip-domain?domain=${encodeURIComponent(domain)}`)
  }

  // ── Paid traffic ──
  async getAdsConfig(): Promise<AdsConfig> {
    return this.request('GET', '/ads/config')
  }

  async saveAdsConfig(data: { token?: string; accounts?: string; version?: string; ruleDefaults?: AdsConfig['ruleDefaults']; pixelId?: string; pixelToken?: string; testCode?: string }): Promise<{ ok: boolean }> {
    return this.request('PUT', '/ads/config', data)
  }

  async testShopeePixel(): Promise<{ ok: boolean; detail: string }> {
    return this.request('POST', '/ads/pixel/test', {})
  }

  async testAds(): Promise<{ ok: boolean; message: string }> {
    return this.request('POST', '/ads/test', {})
  }

  async syncAds(): Promise<{ meta: Array<{ account: string; error?: string }>; shopee: { nodes: number; saved: number; error?: string } }> {
    return this.request('POST', '/ads/sync', {})
  }

  async runAdRules(): Promise<{ results: Array<{ entity: string; result: string }> }> {
    return this.request('POST', '/ads/rules/run', {})
  }

  async getCampaignVisibility(): Promise<{ filter: string; campaigns: Array<{ id: string; name: string; status: string; shown: boolean | null; visible: boolean }> }> {
    return this.request('GET', '/ads/campaigns-visibility')
  }

  async saveCampaignVisibility(data: { filter?: string; shown?: Record<string, boolean | null> }): Promise<{ ok: boolean }> {
    return this.request('PUT', '/ads/campaigns-visibility', data)
  }

  async getAdsOverview(q: { level: AdLevel; parentId?: string; from: string; to: string }): Promise<{ level: AdLevel; from: string; to: string; rows: AdRow[]; totals: AdMetrics }> {
    const qs = new URLSearchParams({ level: q.level, from: q.from, to: q.to })
    if (q.parentId) qs.set('parentId', q.parentId)
    return this.request('GET', `/ads/overview?${qs.toString()}`)
  }

  async saveAdRule(entityId: string, data: Partial<MetaRule>): Promise<MetaRule> {
    return this.request('PUT', `/ads/rules/${entityId}`, data)
  }

  async getAdActions(): Promise<Array<{ id: string; entityId: string; level: AdLevel; name: string; action: string; success: boolean; detail: string; createdAt: string }>> {
    return this.request('GET', '/ads/actions')
  }

  async getAdSales(from: string, to: string): Promise<{ rows: Array<{ subCode: string; label: string; source: string; orders: number; gmv: number; pending: number; confirmed: number; cancelled: number }> }> {
    return this.request('GET', `/ads/sales?from=${from}&to=${to}`)
  }

  async getAdSalesList(from: string, to: string): Promise<{ truncated: boolean; rows: ShopeeSale[] }> {
    return this.request('GET', `/ads/sales/list?from=${from}&to=${to}`)
  }

  // ── WhatsApp numbers ──────────────────────────
  async getWaNumbers(): Promise<{ configured: boolean; providers: Record<WaProvider, boolean>; defaultProvider: WaProvider; max: number; instances: WaNumber[] }> {
    return this.request('GET', '/whatsapp/instances')
  }

  async checkEvolution(provider?: WaProvider): Promise<{ ok: boolean; message: string }> {
    return this.request('GET', `/whatsapp/check${provider ? `?provider=${provider}` : ''}`)
  }

  async createWaNumber(label: string, purpose: 'OFFERS' | 'LEADS', sendsOffers = false, provider?: WaProvider): Promise<{ instance: WaNumber; qrcode: string | null }> {
    return this.request('POST', '/whatsapp/instances', { label, purpose, sendsOffers, provider })
  }

  async switchWaProvider(id: string, provider: WaProvider, confirm = false): Promise<{ instance: WaNumber; qrcode: string | null }> {
    return this.request('POST', `/whatsapp/instances/${id}/provider`, { provider, confirm })
  }

  async getWaNumberState(id: string): Promise<{ instance: WaNumber; status: 'connected' | 'disconnected' | 'not_created' }> {
    return this.request('GET', `/whatsapp/instances/${id}`)
  }

  async getWaNumberQr(id: string): Promise<{ qrcode: string | null; state?: string; error?: string }> {
    return this.request('GET', `/whatsapp/instances/${id}/qr`)
  }

  async connectWaNumber(id: string, confirm = false, fresh = false): Promise<{ qrcode: string | null; connected?: boolean }> {
    return this.request('POST', `/whatsapp/instances/${id}/connect`, { confirm, fresh })
  }

  async logoutWaNumber(id: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/whatsapp/instances/${id}/logout`, {})
  }

  async updateWaNumber(id: string, data: { label?: string; purpose?: 'OFFERS' | 'LEADS'; sendsOffers?: boolean }): Promise<WaNumber> {
    return this.request('PATCH', `/whatsapp/instances/${id}`, data)
  }

  async deleteWaNumber(id: string, force = false): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/whatsapp/instances/${id}${force ? '?force=1' : ''}`)
  }

  async getLeadSafety(id: string): Promise<{ safety: LeadSafety; defaults: LeadSafety; status: LeadQueueStatus }> {
    return this.request('GET', `/whatsapp/instances/${id}/safety`)
  }

  async saveLeadSafety(id: string, safety: LeadSafety): Promise<{ safety: LeadSafety }> {
    return this.request('PUT', `/whatsapp/instances/${id}/safety`, safety)
  }

  async setLeadQueuePaused(id: string, paused: boolean): Promise<LeadQueueStatus> {
    return this.request('POST', `/whatsapp/instances/${id}/lead-pause`, { paused })
  }

  async endLeadRest(id: string): Promise<LeadQueueStatus> {
    return this.request('POST', `/whatsapp/instances/${id}/end-rest`, {})
  }

  // ── Leads ─────────────────────────────────────
  async getLeadOptions(): Promise<{
    instances: Array<{ id: string; label: string; purpose: string; connected: boolean; number: string | null }>
    niches: Array<{ id: string; name: string; groups: Array<{ id: string; name: string }> }>
    groups: Array<{ id: string; name: string }>
  }> {
    return this.request('GET', '/leads/options')
  }

  async getLeadResults(params: { days?: number; from?: string; to?: string; campaignId?: string; instanceId?: string }): Promise<LeadResults> {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v))
    return this.request('GET', `/leads/results?${qs.toString()}`)
  }

  async getLeadSourceGroups(): Promise<{
    groups: Array<{ jid: string; name: string; size: number | null; announce: boolean; via: string[]; registeredId: string | null }>
    errors: string[]
  }> {
    return this.request('GET', '/leads/source-groups')
  }

  async getLeadsOverview(): Promise<{
    campaigns: LeadCampaignItem[]
    queues: Array<LeadQueueStatus & { instanceId: string; instance: { id: string; label: string; connected: boolean; number: string | null } | null }>
  }> {
    return this.request('GET', '/leads/overview')
  }

  async createLeadCampaign(data: { name: string; nicheId: string | null; instanceIds: string[]; groupIds: string[]; inviteFallback: boolean; mode?: LeadMode; phones?: string; sourceGroupId?: string; sourceGroupName?: string; consent: boolean }): Promise<LeadImportResult & { id: string }> {
    return this.request('POST', '/leads/campaigns', data)
  }

  async addLeads(id: string, phones: string, consent: boolean): Promise<LeadImportResult> {
    return this.request('POST', `/leads/campaigns/${id}/leads`, { phones, consent })
  }

  // ── "Adicionar pelo celular" batches ──
  // ── Phones that add by hand ──
  async getLeadHelpers(): Promise<{ helpers: LeadHelperItem[]; defaults: HelperSafety }> {
    return this.request('GET', '/leads/helpers')
  }

  async createLeadHelper(data: { label: string; phone: string; campaignIds: string[]; safety: HelperSafety }): Promise<LeadHelperItem> {
    return this.request('POST', '/leads/helpers', data)
  }

  async updateLeadHelper(id: string, data: { label?: string; phone?: string; campaignIds?: string[]; safety?: HelperSafety; paused?: boolean }): Promise<LeadHelperItem> {
    return this.request('PATCH', `/leads/helpers/${id}`, data)
  }

  async deleteLeadHelper(id: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/leads/helpers/${id}`)
  }

  async sendLeadHelperNow(id: string): Promise<{ sent: number; result: string; helper: LeadHelperItem }> {
    return this.request('POST', `/leads/helpers/${id}/send`, {})
  }

  async endLeadHelperRest(id: string): Promise<LeadHelperItem> {
    return this.request('POST', `/leads/helpers/${id}/end-rest`, {})
  }

  async getManualBatch(id: string): Promise<ManualBatch> {
    return this.request('GET', `/leads/campaigns/${id}/manual`)
  }

  async makeManualBatch(id: string, size: number): Promise<{ prefix: string; batch: Array<{ id: string; phone: string; name: string | null; group: string }>; skipped: { blocked: number; member: number; duplicate: number }; groupsFull: boolean }> {
    return this.request('POST', `/leads/campaigns/${id}/manual/batch`, { size })
  }

  async getManualVcard(id: string): Promise<{ filename: string; vcf: string; count: number }> {
    return this.request('GET', `/leads/campaigns/${id}/manual/vcard`)
  }

  async checkManualBatch(id: string): Promise<{ results: Array<{ group: string; joined?: number; pending?: number; skipped?: string }> }> {
    return this.request('POST', `/leads/campaigns/${id}/manual/check`, {})
  }

  async requeueManualBatch(id: string): Promise<{ requeued: number }> {
    return this.request('POST', `/leads/campaigns/${id}/manual/requeue`, {})
  }

  async markManualAdded(id: string, ids?: string[]): Promise<{ marked: number }> {
    return this.request('POST', `/leads/campaigns/${id}/manual/mark-added`, { ids })
  }

  async updateLeadCampaign(id: string, data: { status?: 'ACTIVE' | 'PAUSED'; name?: string; groupIds?: string[]; inviteFallback?: boolean; mode?: LeadMode; instanceIds?: string[] }): Promise<unknown> {
    return this.request('PATCH', `/leads/campaigns/${id}`, data)
  }

  async deleteLeadCampaign(id: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/leads/campaigns/${id}`)
  }

  async retryLeads(id: string, includeNoWhatsApp = false): Promise<{ requeued: number }> {
    return this.request('POST', `/leads/campaigns/${id}/retry`, { includeNoWhatsApp })
  }

  async getCampaignLeads(id: string, params: { status?: string; q?: string; page?: number }): Promise<{
    total: number; page: number; pages: number
    rows: Array<{ id: string; phone: string; name: string | null; status: LeadStatus; source: 'LIST' | 'INTAKE' | 'GROUP'; detail: string | null; group: string | null; number: string | null; processedAt: string | null; leftAt: string | null; createdAt: string }>
  }> {
    const qs = new URLSearchParams()
    if (params.status) qs.set('status', params.status)
    if (params.q) qs.set('q', params.q)
    if (params.page) qs.set('page', String(params.page))
    return this.request('GET', `/leads/campaigns/${id}/leads?${qs.toString()}`)
  }

  async getAdSalesRaw(): Promise<{ lastSync: { at: string; error?: string } | null; rows: Array<{ id: string; purchaseTime: string; clickTime: string | null; rawClickTime: unknown; utmContent: string | null; status: string; fields: string[] }> }> {
    return this.request('GET', '/ads/sales/raw')
  }

  async getAdLinks(): Promise<AdLinkItem[]> {
    return this.request('GET', '/ads/links')
  }

  async createAdLink(data: { productUrl: string; metaAdId?: string | null; label?: string; viaOurLink?: boolean }): Promise<AdLinkItem> {
    return this.request('POST', '/ads/links', data)
  }

  async getAdLinkClicks(id: string): Promise<Array<{ at: string; kind: string; agent: string | null; fromAd: boolean; userAgent: string | null }>> {
    return this.request('GET', `/ads/links/${id}/clicks`)
  }

  async updateAdLink(id: string, data: { metaAdId?: string | null; label?: string }): Promise<AdLinkItem> {
    return this.request('PATCH', `/ads/links/${id}`, data)
  }

  async getAdsList(): Promise<Array<{ id: string; name: string; status: string; campaign: string }>> {
    return this.request('GET', '/ads/ads-list')
  }

  async getAdsToday(): Promise<{ today: string }> {
    return this.request('GET', '/ads/today')
  }

  async getHunters(): Promise<HunterListItem[]> {
    return this.request('GET', '/hunter')
  }

  async getHunter(nicheId: string): Promise<{ hunter: ShopeeHunterConfig; niche: { id: string; name: string }; destinationIds: string[]; candidates: HunterCandidate[] }> {
    return this.request('GET', `/hunter/${nicheId}`)
  }

  async saveHunter(nicheId: string, data: Partial<ShopeeHunterConfig> & { destinationIds?: string[] }): Promise<ShopeeHunterConfig> {
    return this.request('PUT', `/hunter/${nicheId}`, data)
  }

  async runHunter(nicheId: string): Promise<NonNullable<ShopeeHunterConfig['lastRunSummary']>> {
    return this.request('POST', `/hunter/${nicheId}/run`, {})
  }

  async sendHunterCandidate(candidateId: string): Promise<{ offerId: string }> {
    return this.request('POST', `/hunter/candidates/${candidateId}/send`, {})
  }

  async testHunterSearch(keyword: string): Promise<{ ok: boolean; message?: string; count?: number; fields?: string[]; products?: Array<{ name: string; priceMin: number; priceMax: number; discountPct: number | null; rating: number | null; sales: number | null; commissionPct: number | null; imageUrl: string | null; isOfficial: boolean }> }> {
    return this.request('POST', '/hunter/test-search', { keyword })
  }

  async getCoupons(): Promise<{ enabled: boolean; coupons: Coupon[] }> {
    return this.request('GET', '/hunter/coupons/list')
  }

  async setCouponsEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
    return this.request('PUT', '/hunter/coupons/settings', { enabled })
  }

  /** period: { days } for the last N days, or { from, to } as YYYY-MM-DD (Brasília days, inclusive). */
  async getWaAnalytics(period: { days?: number; from?: string; to?: string }, groupId?: string): Promise<WaAnalytics> {
    const qs = new URLSearchParams()
    if (period.from) {
      qs.set('from', period.from)
      qs.set('to', period.to ?? period.from)
    } else {
      qs.set('days', String(period.days ?? 30))
    }
    if (groupId) qs.set('groupId', groupId)
    return this.request('GET', `/analytics/whatsapp?${qs.toString()}`)
  }

  async getWaWebhookStatus(): Promise<WaWebhookStatus> {
    return this.request('GET', '/analytics/whatsapp/webhook')
  }

  async setupWaWebhook(force = false): Promise<WaWebhookStatus> {
    return this.request('POST', '/analytics/whatsapp/webhook', { force })
  }

  async snapshotWaGroups(): Promise<{ results: WaSnapshotResult[] }> {
    return this.request('POST', '/analytics/whatsapp/snapshot', {})
  }

  async getGroupsHealth(hours = 24): Promise<GroupsHealth> {
    return this.request('GET', `/health/groups?hours=${hours}`)
  }

  async getProcessingLogs(sourceGroupId?: string): Promise<ProcessingOffer[]> {
    const params = new URLSearchParams()
    if (sourceGroupId) params.set('sourceGroupId', sourceGroupId)
    const qs = params.toString()
    return this.request('GET', `/logs/processing${qs ? `?${qs}` : ''}`)
  }
}

export const api = new ApiClient(BASE_URL)
export default api
