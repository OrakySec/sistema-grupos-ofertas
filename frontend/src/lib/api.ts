/* ─────────────────────────────────────────
   API Client
   Base URL: import.meta.env.VITE_API_URL or /api
───────────────────────────────────────── */

const BASE_URL = (import.meta.env.VITE_API_URL as string) || '/api'

export interface PaginationParams {
  page?: number
  limit?: number
  status?: string
  dateRange?: string
}

export interface Offer {
  id: string
  sourceGroupId: string
  sourceGroupName: string
  text: string
  mediaType?: 'PHOTO' | 'VIDEO' | 'DOCUMENT' | null
  mediaPath?: string | null
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SENT' | 'FAILED'
  createdAt: string
  updatedAt: string
  deliveryLogs?: DeliveryLog[]
}

export interface DeliveryLog {
  id: string
  offerId: string
  offer?: { text?: string; mediaType: string }
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

export interface SourceGroup {
  id: string
  name: string
  username?: string | null
  telegramId: string
  isActive: boolean
  createdAt: string
}

export interface DestinationGroup {
  id: string
  name: string
  type: 'TELEGRAM' | 'WHATSAPP'
  chatId: string
  isActive: boolean
  createdAt: string
}

export interface Settings {
  autoApprove: boolean
  telegramBotToken?: string
  telegramApiId?: number
  telegramApiHash?: string
  telegramPhone?: string
  telegramAuthenticated?: boolean
  evolutionApiUrl?: string
  evolutionApiKey?: string
  evolutionInstance?: string
}

export interface Stats {
  pending: number
  approvedToday: number
  sentToday: number
  failedToday: number
}

export interface WhatsAppGroup {
  id: string
  name: string
  participants?: number
}

class ApiClient {
  private baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  private getToken(): string | null {
    return localStorage.getItem('auth_token')
  }

  private getHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
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
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.getHeaders(),
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
        `Erro ${res.status}: ${res.statusText}`
      throw new Error(errMsg)
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
    return this.request('POST', `/offers/${id}/approve`)
  }

  async rejectOffer(id: string): Promise<{ success: boolean }> {
    return this.request('POST', `/offers/${id}/reject`)
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
    data: Partial<{ name: string; telegramId: string; username: string; isActive: boolean }>
  ): Promise<SourceGroup> {
    return this.request('PATCH', `/groups/source/${id}`, data)
  }

  async deleteSourceGroup(id: string): Promise<{ success: boolean }> {
    return this.request('DELETE', `/groups/source/${id}`)
  }

  // ── Destination Groups ────────────────────────
  async getDestinationGroups(): Promise<DestinationGroup[]> {
    return this.request('GET', '/groups/destination')
  }

  async createDestinationGroup(data: {
    name: string
    type: 'TELEGRAM' | 'WHATSAPP'
    chatId: string
  }): Promise<DestinationGroup> {
    return this.request('POST', '/groups/destination', data)
  }

  async updateDestinationGroup(
    id: string,
    data: Partial<{ name: string; chatId: string; isActive: boolean }>
  ): Promise<DestinationGroup> {
    return this.request('PATCH', `/groups/destination/${id}`, data)
  }

  async deleteDestinationGroup(id: string): Promise<{ success: boolean }> {
    return this.request('DELETE', `/groups/destination/${id}`)
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

  async testWhatsApp(): Promise<{ success: boolean; message: string }> {
    return this.request('POST', '/settings/test-whatsapp')
  }

  async startTelegramAuth(phone: string): Promise<{ success: boolean; message: string }> {
    return this.request('POST', '/settings/telegram-auth/start', { phone })
  }

  async verifyTelegramAuth(code: string): Promise<{ success: boolean; message: string }> {
    return this.request('POST', '/settings/telegram-auth/verify', { code })
  }

  // ── WhatsApp ──────────────────────────────────
  async getWhatsAppGroups(): Promise<WhatsAppGroup[]> {
    return this.request('GET', '/settings/whatsapp-groups')
  }

  // ── Logs ──────────────────────────────────────
  async getDeliveryLogs(limit = 100): Promise<DeliveryLog[]> {
    return this.request('GET', `/logs?limit=${limit}`)
  }
}

export const api = new ApiClient(BASE_URL)
export default api
