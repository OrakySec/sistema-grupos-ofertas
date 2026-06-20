import React, { useState, useEffect, useCallback } from 'react'
import api, { type Offer, type DeliveryLog } from '../lib/api'
import StatusBadge from '../components/StatusBadge'
import { SkeletonRow } from '../components/LoadingSkeleton'

type DateRange = 'today' | 'week' | 'month' | 'all'

const PAGE_SIZE = 20

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function History() {
  const [offers, setOffers] = useState<Offer[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [dateRange, setDateRange] = useState<DateRange>('all')
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [expandedOffer, setExpandedOffer] = useState<Offer | null>(null)
  const [expandLoading, setExpandLoading] = useState(false)

  const fetchOffers = useCallback(async () => {
    setLoading(true)
    try {
      const params: { page: number; limit: number; status?: string; dateRange?: string } = {
        page,
        limit: PAGE_SIZE,
      }
      if (statusFilter !== 'ALL') params.status = statusFilter
      if (dateRange !== 'all') params.dateRange = dateRange

      const res = await api.getOffers(params)
      setOffers(res.data)
      setTotal(res.total)
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter, dateRange])

  useEffect(() => {
    fetchOffers()
  }, [fetchOffers])

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1)
  }, [statusFilter, dateRange])

  const handleExpand = async (offer: Offer) => {
    if (expandedId === offer.id) {
      setExpandedId(null)
      setExpandedOffer(null)
      return
    }
    setExpandedId(offer.id)
    setExpandLoading(true)
    try {
      const full = await api.getOffer(offer.id)
      setExpandedOffer(full)
    } catch {
      setExpandedOffer(offer)
    } finally {
      setExpandLoading(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div style={{ animation: 'fadeIn 0.3s ease' }}>
      {/* Header */}
      <div className="page-header">
        <h1 className="page-title">Histórico</h1>
        <p className="page-subtitle">
          {total.toLocaleString('pt-BR')} oferta{total !== 1 ? 's' : ''} no total
        </p>
      </div>

      {/* Filters */}
      <div className="filter-bar">
        <select
          className="select"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{ width: 'auto' }}
        >
          <option value="ALL">Todos os status</option>
          <option value="PENDING">Pendente</option>
          <option value="APPROVED">Aprovado</option>
          <option value="REJECTED">Rejeitado</option>
          <option value="SENT">Enviado</option>
          <option value="FAILED">Falha</option>
        </select>

        <select
          className="select"
          value={dateRange}
          onChange={(e) => setDateRange(e.target.value as DateRange)}
          style={{ width: 'auto' }}
        >
          <option value="all">Todo o período</option>
          <option value="today">Hoje</option>
          <option value="week">Esta semana</option>
          <option value="month">Este mês</option>
        </select>
      </div>

      {/* Table */}
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>Origem</th>
              <th>Texto</th>
              <th>Status</th>
              <th>Destinos</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={6} style={{ padding: 0 }}>
                      <SkeletonRow />
                    </td>
                  </tr>
                ))
              : offers.length === 0
              ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '40px 16px' }}>
                    <div className="empty-state" style={{ padding: 0 }}>
                      <span className="empty-state-icon">📭</span>
                      <span className="empty-state-title">Nenhuma oferta encontrada</span>
                    </div>
                  </td>
                </tr>
              )
              : offers.map((offer) => (
                  <React.Fragment key={offer.id}>
                    <tr
                      style={{ cursor: 'pointer' }}
                      onClick={() => handleExpand(offer)}
                    >
                      <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                        {formatDate(offer.createdAt)}
                      </td>
                      <td className="primary">{offer.sourceGroup?.name || 'Desconhecido'}</td>
                      <td>
                        <span
                          style={{
                            maxWidth: 280,
                            display: 'block',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {offer.text
                            ? offer.text.slice(0, 60) + (offer.text.length > 60 ? '…' : '')
                            : <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>{offer.mediaType === 'PHOTO' ? '📷 Foto' : offer.mediaType === 'VIDEO' ? '🎬 Vídeo' : '📎 Arquivo'}</span>
                          }
                        </span>
                      </td>
                      <td>
                        <StatusBadge status={offer.status} />
                      </td>
                      <td>
                        <span
                          style={{
                            fontSize: '0.78rem',
                            color: 'var(--text-muted)',
                          }}
                        >
                          {offer.deliveryLogs?.length ?? '—'}
                        </span>
                      </td>
                      <td>
                        <span
                          style={{
                            fontSize: '0.75rem',
                            color: 'var(--text-muted)',
                            cursor: 'pointer',
                          }}
                        >
                          {expandedId === offer.id ? '▲' : '▼'} detalhes
                        </span>
                      </td>
                    </tr>

                    {/* Expanded delivery logs */}
                    {expandedId === offer.id && (
                      <tr>
                        <td
                          colSpan={6}
                          style={{
                            background: 'rgba(0,0,0,0.2)',
                            padding: '16px 20px',
                            borderBottom: '1px solid var(--border-subtle)',
                          }}
                        >
                          {expandLoading ? (
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-muted)', fontSize: '0.83rem' }}>
                              <span className="spinner spinner-sm" /> Carregando logs…
                            </div>
                          ) : (
                            <div>
                              {/* Full text */}
                              <div
                                style={{
                                  fontSize: '0.83rem',
                                  color: 'var(--text-secondary)',
                                  marginBottom: 14,
                                  padding: '10px 14px',
                                  background: 'var(--bg-glass)',
                                  borderRadius: 'var(--radius-md)',
                                  border: '1px solid var(--border-subtle)',
                                  whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-word',
                                  maxHeight: 120,
                                  overflowY: 'auto',
                                }}
                              >
                                {expandedOffer?.text ?? offer.text}
                              </div>

                              {/* Delivery logs */}
                              {expandedOffer?.deliveryLogs && expandedOffer.deliveryLogs.length > 0 ? (
                                <div>
                                  <div
                                    style={{
                                      fontSize: '0.72rem',
                                      fontWeight: 600,
                                      letterSpacing: '0.06em',
                                      textTransform: 'uppercase',
                                      color: 'var(--text-muted)',
                                      marginBottom: 8,
                                    }}
                                  >
                                    Logs de entrega
                                  </div>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    {expandedOffer.deliveryLogs.map((log: DeliveryLog) => (
                                      <div
                                        key={log.id}
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: 10,
                                          fontSize: '0.82rem',
                                          padding: '6px 10px',
                                          background: 'var(--bg-glass)',
                                          borderRadius: 'var(--radius-sm)',
                                          border: `1px solid ${log.status === 'SUCCESS' ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
                                        }}
                                      >
                                        <span
                                          className={`status-dot ${log.status === 'SUCCESS' ? 'online' : 'error'}`}
                                        />
                                        <span className="mono" style={{ color: 'var(--text-secondary)' }}>
                                          {log.destinationGroup?.type}
                                        </span>
                                        <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                                          {log.destinationGroup?.name}
                                        </span>
                                        {log.errorMessage && (
                                          <span style={{ color: 'var(--accent-danger)', fontSize: '0.78rem' }}>
                                            — {log.errorMessage}
                                          </span>
                                        )}
                                        <span
                                          style={{
                                            marginLeft: 'auto',
                                            color: 'var(--text-muted)',
                                            fontSize: '0.75rem',
                                          }}
                                        >
                                          {new Date(log.sentAt).toLocaleTimeString('pt-BR')}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ) : (
                                <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                                  Nenhum log de entrega disponível.
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="pagination">
          <button
            className="page-btn"
            onClick={() => setPage(1)}
            disabled={page === 1}
          >
            «
          </button>
          <button
            className="page-btn"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            ‹
          </button>

          {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
            const start = Math.max(1, Math.min(page - 2, totalPages - 4))
            const p = start + i
            return p <= totalPages ? (
              <button
                key={p}
                className={`page-btn${page === p ? ' active' : ''}`}
                onClick={() => setPage(p)}
              >
                {p}
              </button>
            ) : null
          })}

          <button
            className="page-btn"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
          >
            ›
          </button>
          <button
            className="page-btn"
            onClick={() => setPage(totalPages)}
            disabled={page === totalPages}
          >
            »
          </button>
        </div>
      )}
    </div>
  )
}
