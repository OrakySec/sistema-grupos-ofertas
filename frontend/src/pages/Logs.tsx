import React, { useEffect, useState, useCallback, useRef } from 'react'
import api, { type DeliveryLog, type ProcessingOffer, type ProcessingEvent } from '../lib/api'

// ─── helpers ────────────────────────────────────────────────────────────────

function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'agora'
  if (mins < 60) return `${mins}m atrás`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h atrás`
  return `${Math.floor(hrs / 24)}d atrás`
}

function fmt(dateStr: string) {
  return new Date(dateStr).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function fmtTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// ─── Processing tab ──────────────────────────────────────────────────────────

type ProcFilter = 'ALL' | 'ok' | 'error' | 'nolink'

const STATUS_COLORS = {
  ok:      { bg: 'rgba(34,197,94,0.12)',  color: 'var(--accent-success)',  label: '✅ Convertido' },
  error:   { bg: 'rgba(239,68,68,0.12)',  color: 'var(--accent-danger)',   label: '❌ Erro'       },
  skipped: { bg: 'rgba(234,179,8,0.12)',  color: '#eab308',               label: '⚠️ Ignorado'  },
  nolink:  { bg: 'rgba(100,116,139,0.12)',color: 'var(--text-muted)',      label: '💬 Sem link'   },
  pending: { bg: 'rgba(234,179,8,0.08)',  color: '#eab308',               label: '⏳ Aguardando log' },
}

const PLATFORM_ICON: Record<string, string> = {
  Amazon: '🛒', Shopee: '🛍️', AliExpress: '📦', 'Magazine Luiza': '🛒',
}

function offerProcStatus(offer: ProcessingOffer): 'ok' | 'error' | 'skipped' | 'nolink' | 'pending' {
  const events = offer.processingLog
  if (events === null || events === undefined) return 'pending' // container not redeployed yet
  if (events.length === 0) return 'nolink'
  if (events.some(e => e.status === 'ok')) return 'ok'
  if (events.some(e => e.status === 'error')) return 'error'
  return 'nolink'
}

// ─── Step icons & colors ─────────────────────────────────────────────────────

const STEP_ICON: Record<string, string> = {
  received:      '📨',
  sender:        '👤',
  media_download:'📎',
  url_detect:    '🔍',
  url:           '🔗',
  url_convert:   '💰',
  api_post:      '🚀',
}

function stepColor(status: string): { border: string; bg: string; text: string } {
  if (status === 'ok')      return { border: 'rgba(34,197,94,0.25)',   bg: 'rgba(34,197,94,0.06)',   text: 'var(--accent-success)' }
  if (status === 'error')   return { border: 'rgba(239,68,68,0.3)',    bg: 'rgba(239,68,68,0.06)',   text: 'var(--accent-danger)'  }
  if (status === 'skipped') return { border: 'rgba(100,116,139,0.2)', bg: 'rgba(100,116,139,0.04)', text: 'var(--text-muted)'     }
  /* info */                return { border: 'rgba(234,179,8,0.2)',    bg: 'rgba(234,179,8,0.05)',   text: '#eab308'               }
}

function EventTimeline({ events, isNull }: { events: ProcessingEvent[], isNull: boolean }) {
  if (isNull) {
    return (
      <div style={{
        fontSize: '0.8rem', color: '#eab308', padding: '10px 12px',
        background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.2)',
        borderRadius: 6, display: 'flex', alignItems: 'flex-start', gap: 8,
      }}>
        <span style={{ flexShrink: 0 }}>⏳</span>
        <span>
          Log de processamento não disponível para esta mensagem.{' '}
          <strong>Redeploye o container telegram-listener no Portainer</strong>{' '}
          para ativar o rastreamento nas próximas mensagens.
        </span>
      </div>
    )
  }

  if (!events || events.length === 0) {
    return (
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', padding: '8px 0' }}>
        💬 Nenhum evento registrado.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {events.map((ev, i) => {
        const step = ev.step || 'url'
        const isUrl = step === 'url'
        const icon = ev.status === 'error' ? '❌'
          : ev.status === 'skipped' ? '⏩'
          : ev.status === 'info' ? (STEP_ICON[step] || '⏳')
          : (STEP_ICON[step] || '✅')
        const { border, bg } = stepColor(ev.status)
        const label = ev.label || (isUrl && ev.platform ? ev.platform : step)

        return (
          <div key={i} style={{
            background: bg,
            border: `1px solid ${border}`,
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: '0.78rem',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: '1rem', flexShrink: 0 }}>{icon}</span>
              <span style={{ fontWeight: 600, flex: 1 }}>{label}</span>
              {isUrl && ev.platform && (
                <span style={{
                  background: 'var(--surface-2)', borderRadius: 4,
                  padding: '1px 6px', fontSize: '0.68rem', fontWeight: 600, color: 'var(--text-secondary)',
                }}>
                  {PLATFORM_ICON[ev.platform] ?? '🔗'} {ev.platform}
                </span>
              )}
              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                {ev.ts ? fmtTime(ev.ts) : ''}
              </span>
            </div>

            {/* Detail: non-url steps */}
            {!isUrl && ev.detail && (
              <div style={{ marginTop: 4, paddingLeft: 27, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                {ev.detail}
              </div>
            )}
            {!isUrl && ev.error && (
              <div style={{ marginTop: 4, paddingLeft: 27, fontSize: '0.72rem', color: 'var(--accent-danger)' }}>
                ⚠️ {ev.error}
              </div>
            )}

            {/* Detail: url steps */}
            {isUrl && (
              <div style={{ marginTop: 5, paddingLeft: 27, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {ev.original  && <StepRow icon="🔗" label="Original"  val={ev.original}  />}
                {ev.expanded  && <StepRow icon="🔄" label="Expandido"  val={ev.expanded}  />}
                {ev.affiliate && <StepRow icon="🏷️"  label="Afiliado"   val={ev.affiliate} truncate />}
                {ev.shortened && <StepRow icon="✂️"  label="Encurtado"  val={ev.shortened} highlight />}
                {ev.final && !ev.shortened && <StepRow icon="📤" label="Final" val={ev.final} highlight />}
                {ev.error && (
                  <div style={{ color: 'var(--accent-danger)', fontSize: '0.72rem', marginTop: 2 }}>
                    ⚠️ {ev.error}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function StepRow({
  icon, label, val, truncate, highlight,
}: {
  icon: string; label: string; val?: string | null; truncate?: boolean; highlight?: boolean
}) {
  const [copied, setCopied] = useState(false)
  if (!val) return null
  const copy = () => {
    navigator.clipboard.writeText(val).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 20 }}>
      <span style={{ width: 16, textAlign: 'center', flexShrink: 0 }}>{icon}</span>
      <span style={{ color: 'var(--text-muted)', width: 70, flexShrink: 0, fontSize: '0.7rem' }}>{label}</span>
      <span
        onClick={copy}
        title={val}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.7rem',
          color: highlight ? 'var(--accent-primary)' : 'var(--text-secondary)',
          fontWeight: highlight ? 600 : 400,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          maxWidth: truncate ? 260 : 380,
          cursor: 'pointer',
        }}
      >
        {copied ? '✓ Copiado!' : val}
      </span>
    </div>
  )
}

function ProcessingCard({ offer }: { offer: ProcessingOffer }) {
  const [open, setOpen] = useState(false)
  const status = offerProcStatus(offer)
  const style  = STATUS_COLORS[status] ?? STATUS_COLORS.nolink
  const events = offer.processingLog ?? []
  const preview = offer.text || offer.mediaCaption
  const deliveryOk = offer.deliveryLogs?.filter(d => d.status === 'SUCCESS').length ?? 0
  const deliveryFail = offer.deliveryLogs?.filter(d => d.status === 'FAILED').length ?? 0

  return (
    <div style={{
      background: 'var(--surface-1)',
      border: '1px solid var(--border)',
      borderLeft: `3px solid ${style.color}`,
      borderRadius: 10,
      overflow: 'hidden',
      transition: 'box-shadow 0.15s',
    }}>
      {/* Summary row */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        {/* Time */}
        <div style={{ flexShrink: 0, textAlign: 'right', minWidth: 80 }}>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-primary)', fontWeight: 600 }}>
            {fmtTime(offer.createdAt)}
          </div>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{timeAgo(offer.createdAt)}</div>
        </div>

        {/* Status badge */}
        <span style={{
          flexShrink: 0,
          padding: '3px 10px',
          borderRadius: 20,
          fontSize: '0.72rem',
          fontWeight: 700,
          background: style.bg,
          color: style.color,
          whiteSpace: 'nowrap',
        }}>
          {style.label}
        </span>

        {/* Group */}
        <div style={{ flexShrink: 0 }}>
          <span style={{
            fontSize: '0.75rem',
            color: 'var(--text-secondary)',
            background: 'var(--surface-2)',
            borderRadius: 4,
            padding: '2px 8px',
          }}>
            {offer.sourceGroup?.name ?? '—'}
          </span>
        </div>

        {/* Preview */}
        <div style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: '0.8rem',
          color: 'var(--text-muted)',
        }}>
          {preview ? preview.slice(0, 80) : (
            offer.mediaType !== 'NONE'
              ? `📎 ${offer.mediaType}`
              : '(sem texto)'
          )}
        </div>

        {/* Delivery summary */}
        {offer.deliveryLogs && offer.deliveryLogs.length > 0 && (
          <div style={{ flexShrink: 0, display: 'flex', gap: 6, fontSize: '0.72rem' }}>
            {deliveryOk > 0 && (
              <span style={{ color: 'var(--accent-success)', fontWeight: 700 }}>
                📤 {deliveryOk}
              </span>
            )}
            {deliveryFail > 0 && (
              <span style={{ color: 'var(--accent-danger)', fontWeight: 700 }}>
                ✗ {deliveryFail}
              </span>
            )}
          </div>
        )}

        {/* Toggle */}
        <span style={{ flexShrink: 0, color: 'var(--text-muted)', fontSize: '0.75rem' }}>
          {open ? '▲' : '▼'}
        </span>
      </div>

      {/* Expanded detail */}
      {open && (
        <div style={{
          borderTop: '1px solid var(--border)',
          padding: '14px 16px',
          background: 'rgba(0,0,0,0.15)',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}>
          {/* Processing timeline */}
          <div>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>
              🔍 Processamento de Links
            </div>
            <EventTimeline events={events} isNull={offer.processingLog === null || offer.processingLog === undefined} />
          </div>

          {/* Full text preview */}
          {preview && (
            <div>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 }}>
                📝 Texto Final Enviado
              </div>
              <div style={{
                fontSize: '0.8rem',
                color: 'var(--text-secondary)',
                background: 'var(--bg-glass)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 6,
                padding: '10px 12px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 120,
                overflowY: 'auto',
              }}>
                {preview}
              </div>
            </div>
          )}

          {/* Delivery logs */}
          {offer.deliveryLogs && offer.deliveryLogs.length > 0 && (
            <div>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 }}>
                📤 Entregas
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {offer.deliveryLogs.map(dl => (
                  <div key={dl.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.78rem',
                    padding: '5px 10px', borderRadius: 6,
                    background: 'var(--bg-glass)',
                    border: `1px solid ${dl.status === 'SUCCESS' ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
                  }}>
                    <span>{dl.status === 'SUCCESS' ? '✅' : '❌'}</span>
                    <span style={{ fontWeight: 600 }}>{dl.destinationGroup?.name ?? '—'}</span>
                    <span style={{
                      fontSize: '0.68rem', padding: '1px 6px', borderRadius: 3,
                      background: dl.destinationGroup?.type === 'WHATSAPP' ? 'rgba(34,197,94,0.15)' : 'rgba(59,130,246,0.15)',
                      color: dl.destinationGroup?.type === 'WHATSAPP' ? 'var(--accent-success)' : 'var(--accent-info)',
                    }}>
                      {dl.destinationGroup?.type === 'WHATSAPP' ? '💬 WA' : '✈️ TG'}
                    </span>
                    {dl.errorMessage && (
                      <span style={{ color: 'var(--accent-danger)', fontSize: '0.72rem' }}>— {dl.errorMessage}</span>
                    )}
                    <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                      {fmtTime(dl.sentAt)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ProcessingTab() {
  const [offers, setOffers]   = useState<ProcessingOffer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [filter, setFilter]   = useState<ProcFilter>('ALL')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetch = useCallback(async () => {
    try {
      const data = await api.getProcessingLogs()
      setOffers(data)
      setError('')
    } catch {
      setError('Erro ao carregar logs de processamento')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetch()
  }, [fetch])

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetch, 10000)
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [autoRefresh, fetch])

  const filtered = offers.filter(o => {
    if (filter === 'ALL') return true
    const s = offerProcStatus(o)
    if (filter === 'ok')     return s === 'ok'
    if (filter === 'error')  return s === 'error'
    if (filter === 'nolink') return s === 'nolink'
    return true
  })

  const stats = {
    ok:     offers.filter(o => offerProcStatus(o) === 'ok').length,
    error:  offers.filter(o => offerProcStatus(o) === 'error').length,
    nolink: offers.filter(o => offerProcStatus(o) === 'nolink').length,
  }

  return (
    <div>
      {/* Stats pills */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        {([
          ['ALL',    '📊 Todos',      offers.length,  'var(--text-primary)'],
          ['ok',     '✅ Convertido', stats.ok,       'var(--accent-success)'],
          ['error',  '❌ Com erro',   stats.error,    'var(--accent-danger)'],
          ['nolink', '💬 Sem link',   stats.nolink,   'var(--text-muted)'],
        ] as const).map(([f, label, count, color]) => (
          <button
            key={f}
            onClick={() => setFilter(f as ProcFilter)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 14px',
              borderRadius: 20,
              border: filter === f ? `1px solid ${color}` : '1px solid var(--border)',
              background: filter === f ? `${color}18` : 'var(--surface-1)',
              color: filter === f ? color : 'var(--text-secondary)',
              fontWeight: filter === f ? 700 : 400,
              fontSize: '0.8rem',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            {label}
            <span style={{
              background: 'var(--surface-2)', borderRadius: 10,
              padding: '0 7px', fontSize: '0.72rem', color: 'var(--text-muted)',
            }}>
              {count}
            </span>
          </button>
        ))}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {autoRefresh ? '🔄 Auto-refresh 10s' : '⏸ Pausado'}
          </span>
          <button
            onClick={() => setAutoRefresh(a => !a)}
            className="btn btn-secondary btn-sm"
          >
            {autoRefresh ? 'Pausar' : 'Retomar'}
          </button>
          <button onClick={fetch} className="btn btn-secondary btn-sm">🔄</button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[...Array(5)].map((_, i) => (
            <div key={i} style={{ height: 56, borderRadius: 10, background: 'var(--surface-1)', animation: 'pulse 1.5s infinite' }} />
          ))}
        </div>
      ) : error ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--accent-danger)' }}>{error}</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📭</div>
          <div>Nenhuma mensagem encontrada</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filtered.map(o => <ProcessingCard key={o.id} offer={o} />)}
        </div>
      )}
    </div>
  )
}

// ─── Delivery tab (existing Logs page content) ───────────────────────────────

function DeliveryTab() {
  const [logs, setLogs]       = useState<DeliveryLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [filter, setFilter]   = useState<'ALL' | 'SUCCESS' | 'FAILED'>('ALL')

  const fetch = useCallback(async () => {
    try {
      const data = await api.getDeliveryLogs()
      setLogs(data)
      setError('')
    } catch {
      setError('Erro ao carregar logs')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetch()
    const interval = setInterval(fetch, 15000)
    return () => clearInterval(interval)
  }, [fetch])

  const filtered = filter === 'ALL' ? logs : logs.filter(l => l.status === filter)

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, alignItems: 'center' }}>
        {(['ALL', 'SUCCESS', 'FAILED'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`btn ${filter === f ? 'btn-primary' : 'btn-secondary'} btn-sm`}
          >
            {f === 'ALL' ? 'Todos' : f === 'SUCCESS' ? '✅ Sucesso' : '❌ Falha'}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
          {filtered.length} {filtered.length === 1 ? 'registro' : 'registros'} · atualiza 15s
        </span>
        <button className="btn btn-secondary btn-sm" onClick={fetch}>🔄</button>
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[...Array(5)].map((_, i) => <div key={i} style={{ height: 48, borderRadius: 8, background: 'var(--surface-1)' }} />)}
        </div>
      ) : error ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--accent-danger)' }}>{error}</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📭</div>
          <div>{filter === 'ALL' ? 'Nenhuma entrega ainda.' : `Nenhum registro "${filter}".`}</div>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                {['Data/Hora', 'Oferta', 'Destino', 'Tipo', 'Status', 'Erro'].map(col => (
                  <th key={col} style={{
                    padding: '12px 16px', textAlign: 'left',
                    fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)',
                    textTransform: 'uppercase', letterSpacing: '0.08em', whiteSpace: 'nowrap',
                  }}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((log, index) => (
                <tr key={log.id} style={{
                  borderBottom: index < filtered.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                }}>
                  <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }}>
                    <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                      {new Date(log.sentAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{timeAgo(log.sentAt)}</div>
                  </td>
                  <td style={{ padding: '12px 16px', maxWidth: 180 }}>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {log.offerId.slice(0, 8)}...
                    </div>
                    {log.offer?.text && (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
                        {log.offer.text.slice(0, 40)}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <span style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{log.destinationGroup?.name ?? '—'}</span>
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    {log.destinationGroup?.type ? (
                      <span style={{
                        padding: '3px 8px', borderRadius: 4, fontSize: '11px', fontWeight: 600,
                        background: log.destinationGroup.type === 'WHATSAPP' ? 'rgba(34,197,94,0.15)' : 'rgba(59,130,246,0.15)',
                        color: log.destinationGroup.type === 'WHATSAPP' ? 'var(--accent-success)' : 'var(--accent-info)',
                      }}>
                        {log.destinationGroup.type === 'WHATSAPP' ? '💬 WA' : '✈️ TG'}
                      </span>
                    ) : '—'}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '4px 10px', borderRadius: 6, fontSize: '12px', fontWeight: 600,
                      background: log.status === 'SUCCESS' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                      color: log.status === 'SUCCESS' ? 'var(--accent-success)' : 'var(--accent-danger)',
                    }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />
                      {log.status === 'SUCCESS' ? 'Enviado' : 'Falha'}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', maxWidth: 200 }}>
                    {log.errorMessage ? (
                      <span title={log.errorMessage} style={{ fontSize: '11px', color: 'var(--accent-danger)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', maxWidth: 180, cursor: 'help' }}>
                        {log.errorMessage.slice(0, 50)}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Stats footer */}
      {!loading && filtered.length > 0 && (
        <div style={{ marginTop: 16, display: 'flex', gap: 24, padding: 16, background: 'var(--bg-glass)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            <span style={{ color: 'var(--accent-success)', fontWeight: 700 }}>{logs.filter(l => l.status === 'SUCCESS').length}</span> sucessos
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            <span style={{ color: 'var(--accent-danger)', fontWeight: 700 }}>{logs.filter(l => l.status === 'FAILED').length}</span> falhas
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            Taxa: <span style={{ color: 'var(--accent-primary)', fontWeight: 700 }}>
              {logs.length > 0 ? Math.round(logs.filter(l => l.status === 'SUCCESS').length / logs.length * 100) : 0}%
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main page ───────────────────────────────────────────────────────────────

type Tab = 'processing' | 'delivery'

export default function Logs() {
  const [tab, setTab] = useState<Tab>('processing')

  return (
    <div style={{ animation: 'fadeIn 0.3s ease' }}>
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">📊 Logs do Sistema</h1>
          <p className="page-subtitle">
            Acompanhe o processamento de cada mensagem e o histórico de entregas
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid var(--border)' }}>
        {([
          ['processing', '🔍 Processamento'],
          ['delivery',   '📡 Entregas'],
        ] as const).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 20px',
              fontSize: '0.88rem',
              fontWeight: tab === t ? 700 : 400,
              color: tab === t ? 'var(--accent-primary)' : 'var(--text-muted)',
              background: 'none',
              border: 'none',
              borderBottom: tab === t ? '2px solid var(--accent-primary)' : '2px solid transparent',
              cursor: 'pointer',
              transition: 'all 0.15s',
              marginBottom: -1,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === 'processing' ? <ProcessingTab /> : <DeliveryTab />}
    </div>
  )
}
