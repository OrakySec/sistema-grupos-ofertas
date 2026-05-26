import React, { useEffect, useState, useCallback } from 'react'
import api, { type DeliveryLog } from '../lib/api'

function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'agora'
  if (mins < 60) return `${mins}m atrás`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h atrás`
  return `${Math.floor(hrs / 24)}d atrás`
}

export default function Logs() {
  const [logs, setLogs] = useState<DeliveryLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<'ALL' | 'SUCCESS' | 'FAILED'>('ALL')

  const fetchLogs = useCallback(async () => {
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
    fetchLogs()
    const interval = setInterval(fetchLogs, 15000)
    return () => clearInterval(interval)
  }, [fetchLogs])

  const filtered = filter === 'ALL' ? logs : logs.filter(l => l.status === filter)

  return (
    <div style={{ padding: '32px', animation: 'fadeIn 0.3s ease' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '32px' }}>
        <div>
          <h1 style={{ fontSize: '28px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            📡 Logs de Entrega
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '4px', fontSize: '14px' }}>
            Histórico de todas as entregas realizadas • atualiza a cada 15s
          </p>
        </div>
        <button className="btn btn-secondary" onClick={fetchLogs} style={{ gap: '8px', display: 'flex', alignItems: 'center' }}>
          🔄 Atualizar
        </button>
      </div>

      {/* Filter Bar */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
        {(['ALL', 'SUCCESS', 'FAILED'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`btn ${filter === f ? 'btn-primary' : 'btn-secondary'} btn-sm`}
          >
            {f === 'ALL' ? 'Todos' : f === 'SUCCESS' ? '✅ Sucesso' : '❌ Falha'}
          </button>
        ))}
        <span style={{
          marginLeft: 'auto',
          color: 'var(--text-muted)',
          fontSize: '13px',
          alignSelf: 'center'
        }}>
          {filtered.length} {filtered.length === 1 ? 'registro' : 'registros'}
        </span>
      </div>

      {/* Content */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {[...Array(6)].map((_, i) => (
            <div key={i} className="card skeleton" style={{ height: '72px' }} />
          ))}
        </div>
      ) : error ? (
        <div className="card" style={{ padding: '48px', textAlign: 'center' }}>
          <p style={{ color: 'var(--accent-danger)', fontSize: '15px' }}>{error}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state card">
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>📭</div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '16px' }}>
            {filter === 'ALL' ? 'Nenhum log de entrega ainda.' : `Nenhum registro com status "${filter}".`}
          </p>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                {['Data/Hora', 'Oferta', 'Destino', 'Tipo', 'Status', 'Erro'].map(col => (
                  <th
                    key={col}
                    style={{
                      padding: '12px 16px',
                      textAlign: 'left',
                      fontSize: '11px',
                      fontWeight: 600,
                      color: 'var(--text-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((log, index) => (
                <tr
                  key={log.id}
                  style={{
                    borderBottom: index < filtered.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                    transition: 'background var(--transition)',
                    background: 'transparent',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-glass)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {/* Data */}
                  <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                    <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                      {new Date(log.sentAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      {timeAgo(log.sentAt)}
                    </div>
                  </td>

                  {/* Oferta */}
                  <td style={{ padding: '14px 16px', maxWidth: '180px' }}>
                    <div style={{
                      fontSize: '12px',
                      color: 'var(--text-secondary)',
                      fontFamily: 'var(--font-mono)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {log.offerId.slice(0, 8)}...
                    </div>
                    {log.offer?.text && (
                      <div style={{
                        fontSize: '11px',
                        color: 'var(--text-muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        maxWidth: '160px',
                        marginTop: '2px',
                      }}>
                        {log.offer.text.slice(0, 40)}
                      </div>
                    )}
                  </td>

                  {/* Destino */}
                  <td style={{ padding: '14px 16px' }}>
                    <span style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                      {log.destinationGroup?.name ?? '—'}
                    </span>
                  </td>

                  {/* Tipo */}
                  <td style={{ padding: '14px 16px' }}>
                    {log.destinationGroup?.type ? (
                      <span style={{
                        padding: '3px 8px',
                        borderRadius: '4px',
                        fontSize: '11px',
                        fontWeight: 600,
                        letterSpacing: '0.05em',
                        background: log.destinationGroup.type === 'WHATSAPP'
                          ? 'rgba(34, 197, 94, 0.15)'
                          : 'rgba(59, 130, 246, 0.15)',
                        color: log.destinationGroup.type === 'WHATSAPP'
                          ? 'var(--accent-success)'
                          : 'var(--accent-info)',
                      }}>
                        {log.destinationGroup.type === 'WHATSAPP' ? '💬 WA' : '✈️ TG'}
                      </span>
                    ) : '—'}
                  </td>

                  {/* Status */}
                  <td style={{ padding: '14px 16px' }}>
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '4px 10px',
                      borderRadius: '6px',
                      fontSize: '12px',
                      fontWeight: 600,
                      background: log.status === 'SUCCESS'
                        ? 'rgba(34, 197, 94, 0.15)'
                        : 'rgba(239, 68, 68, 0.15)',
                      color: log.status === 'SUCCESS'
                        ? 'var(--accent-success)'
                        : 'var(--accent-danger)',
                    }}>
                      <span style={{
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        background: 'currentColor',
                        flexShrink: 0,
                      }} />
                      {log.status === 'SUCCESS' ? 'Enviado' : 'Falha'}
                    </span>
                  </td>

                  {/* Erro */}
                  <td style={{ padding: '14px 16px', maxWidth: '200px' }}>
                    {log.errorMessage ? (
                      <span
                        style={{
                          fontSize: '11px',
                          color: 'var(--accent-danger)',
                          fontFamily: 'var(--font-mono)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          display: 'block',
                          maxWidth: '180px',
                          cursor: 'help',
                        }}
                        title={log.errorMessage}
                      >
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
        <div style={{
          marginTop: '16px',
          display: 'flex',
          gap: '24px',
          padding: '16px',
          background: 'var(--bg-glass)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-subtle)',
        }}>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            <span style={{ color: 'var(--accent-success)', fontWeight: 700 }}>
              {logs.filter(l => l.status === 'SUCCESS').length}
            </span>{' '}
            sucessos
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            <span style={{ color: 'var(--accent-danger)', fontWeight: 700 }}>
              {logs.filter(l => l.status === 'FAILED').length}
            </span>{' '}
            falhas
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            Taxa de sucesso:{' '}
            <span style={{ color: 'var(--accent-primary)', fontWeight: 700 }}>
              {logs.length > 0
                ? Math.round((logs.filter(l => l.status === 'SUCCESS').length / logs.length) * 100)
                : 0}%
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
