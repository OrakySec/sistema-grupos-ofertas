import React, { useState, useEffect, useCallback } from 'react'
import api, { type Offer, type Stats } from '../lib/api'
import StatusBadge from '../components/StatusBadge'
import { SkeletonMetricCard, SkeletonCard } from '../components/LoadingSkeleton'

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const min = Math.floor(diff / 60000)
  const hr = Math.floor(min / 60)
  const day = Math.floor(hr / 24)
  if (min < 1) return 'agora'
  if (min < 60) return `${min}m`
  if (hr < 24) return `${hr}h`
  return `${day}d`
}

interface MetricCardProps {
  label: string
  value: number
  icon: string
  accentColor: string
  loading: boolean
}

function MetricCard({ label, value, icon, accentColor, loading }: MetricCardProps) {
  if (loading) return <SkeletonMetricCard />

  return (
    <div
      className="metric-card"
      style={{ '--metric-accent': accentColor } as React.CSSProperties}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <span className="metric-label">{label}</span>
        <span
          style={{
            fontSize: '1.4rem',
            background: 'var(--bg-elevated)',
            padding: '6px 8px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          {icon}
        </span>
      </div>
      <div className="metric-value">{value.toLocaleString('pt-BR')}</div>
    </div>
  )
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [offers, setOffers] = useState<Offer[]>([])
  const [loadingStats, setLoadingStats] = useState(true)
  const [loadingOffers, setLoadingOffers] = useState(true)
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const [s, o] = await Promise.all([
        api.getStats(),
        api.getOffers({ limit: 10 }),
      ])
      setStats(s)
      setOffers(o.data)
    } catch {
      // silent
    } finally {
      setLoadingStats(false)
      setLoadingOffers(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 30_000)
    return () => clearInterval(interval)
  }, [fetchData])

  const handleApprove = async (id: string) => {
    setActionLoadingId(id)
    try {
      await api.approveOffer(id)
      setOffers((prev) =>
        prev.map((o) => (o.id === id ? { ...o, status: 'APPROVED' as const } : o))
      )
      if (stats) setStats({ ...stats, pending: Math.max(0, stats.pending - 1) })
    } catch {
      // silent
    } finally {
      setActionLoadingId(null)
    }
  }

  const handleReject = async (id: string) => {
    setActionLoadingId(id)
    try {
      await api.rejectOffer(id)
      setOffers((prev) =>
        prev.map((o) => (o.id === id ? { ...o, status: 'REJECTED' as const } : o))
      )
      if (stats) setStats({ ...stats, pending: Math.max(0, stats.pending - 1) })
    } catch {
      // silent
    } finally {
      setActionLoadingId(null)
    }
  }

  return (
    <div style={{ animation: 'fadeIn 0.3s ease' }}>
      {/* Header */}
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">Visão geral do sistema de ofertas</p>
      </div>

      {/* Metrics Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '20px', marginBottom: 40 }}>
        <MetricCard
          label="Pendentes"
          value={stats?.pending ?? 0}
          icon="⏳"
          accentColor="var(--accent-warning)"
          loading={loadingStats}
        />
        <MetricCard
          label="Aprovadas Hoje"
          value={stats?.approvedToday ?? 0}
          icon="✅"
          accentColor="var(--accent-primary)"
          loading={loadingStats}
        />
        <MetricCard
          label="Enviadas Hoje"
          value={stats?.sentToday ?? 0}
          icon="📤"
          accentColor="var(--accent-success)"
          loading={loadingStats}
        />
        <MetricCard
          label="Falhas Hoje"
          value={stats?.failedToday ?? 0}
          icon="❌"
          accentColor="var(--accent-danger)"
          loading={loadingStats}
        />
        <MetricCard
          label="Cliques (Hoje)"
          value={stats?.clicksToday ?? 0}
          icon="🖱️"
          accentColor="#0088cc"
          loading={loadingStats}
        />
      </div>

      {/* Recent Offers */}
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 20,
          }}
        >
          <h2 className="section-title">📋 Ofertas Recentes</h2>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            Atualiza a cada 30s
          </span>
        </div>

        {loadingOffers ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : offers.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state-icon">📭</span>
            <span className="empty-state-title">Nenhuma oferta ainda</span>
            <span className="empty-state-desc">
              Quando ofertas chegarem dos grupos monitorados, elas aparecerão aqui.
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {offers.map((offer) => (
              <div
                key={offer.id}
                className="offer-card"
                style={{ animation: 'none' }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  {/* Group + time */}
                  <div style={{ flex: '0 0 auto', minWidth: 0 }}>
                    <span
                      style={{
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                      }}
                    >
                      {offer.sourceGroup?.name || 'Desconhecido'}
                    </span>
                    <span
                      style={{
                        fontSize: '0.72rem',
                        color: 'var(--text-muted)',
                        marginLeft: 6,
                      }}
                    >
                      {timeAgo(offer.createdAt)}
                    </span>
                  </div>

                  {/* Text */}
                  <div
                    style={{
                      flex: 1,
                      fontSize: '0.85rem',
                      color: 'var(--text-secondary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0,
                    }}
                  >
                    {(offer.text ?? offer.mediaCaption ?? '').slice(0, 80)}
                    {((offer.text ?? offer.mediaCaption ?? '').length > 80) ? '…' : ''}
                  </div>

                  {/* Status + actions */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexShrink: 0,
                    }}
                  >
                    <StatusBadge status={offer.status} />
                    {offer.status === 'PENDING' && (
                      <>
                        <button
                          className="btn btn-success btn-sm"
                          onClick={() => handleApprove(offer.id)}
                          disabled={actionLoadingId === offer.id}
                        >
                          ✅
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => handleReject(offer.id)}
                          disabled={actionLoadingId === offer.id}
                        >
                          ❌
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
