import React, { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import api, { type Offer, type Stats, type ClickStats, type GroupsHealth } from '../lib/api'
import StatusBadge from '../components/StatusBadge'
import Icon from '../components/Icon'
import { Skeleton, SkeletonMetricCard } from '../components/LoadingSkeleton'

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const min = Math.floor(diff / 60000)
  const hr = Math.floor(min / 60)
  const day = Math.floor(hr / 24)
  if (min < 1) return 'agora'
  if (min < 60) return `${min} min`
  if (hr < 24) return `${hr} h`
  return `${day} d`
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Bom dia'
  if (h < 18) return 'Boa tarde'
  return 'Boa noite'
}

// ── KPI card ────────────────────────────────────────────────────────────────
interface MetricCardProps {
  label: string
  value: number
  icon: string
  color: string
  hint?: string
  loading: boolean
}

function MetricCard({ label, value, icon, color, hint, loading }: MetricCardProps) {
  if (loading) return <SkeletonMetricCard />
  return (
    <div className="metric-card" style={{ '--metric-accent': color } as React.CSSProperties}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <span className="metric-label">{label}</span>
        <span
          className="icon-chip"
          style={{
            '--chip-color': color,
            '--chip-bg': `color-mix(in srgb, ${color} 14%, transparent)`,
            '--chip-ring': `color-mix(in srgb, ${color} 26%, transparent)`,
          } as React.CSSProperties}
        >
          <Icon name={icon} />
        </span>
      </div>
      <div className="metric-value">{value.toLocaleString('pt-BR')}</div>
      {hint && <div className="metric-trend">{hint}</div>}
    </div>
  )
}

// ── System status row ───────────────────────────────────────────────────────
function StatusRow({ label, ok, okText, badText, icon }: { label: string; ok: boolean | null; okText: string; badText: string; icon: string }) {
  const state = ok === null ? 'offline' : ok ? 'online' : 'error'
  return (
    <div className="status-row">
      <Icon name={icon} size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
      <span style={{ flex: 1, color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', color: ok ? 'var(--text-primary)' : ok === null ? 'var(--text-muted)' : '#ff8a8e' }}>
        <span className={`status-dot ${state}${ok ? ' pulse' : ''}`} />
        {ok === null ? 'Desconhecido' : ok ? okText : badText}
      </span>
    </div>
  )
}

const LEVEL_COLOR: Record<string, string> = {
  ok: 'var(--accent-success)',
  warning: 'var(--accent-warning)',
  critical: 'var(--accent-danger)',
  inactive: 'var(--text-muted)',
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [offers, setOffers] = useState<Offer[]>([])
  const [clicks, setClicks] = useState<ClickStats | null>(null)
  const [health, setHealth] = useState<GroupsHealth | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setRefreshing(true)
    // Each block loads on its own — one slow/broken endpoint never blanks the page.
    await Promise.allSettled([
      api.getStats().then(setStats),
      api.getOffers({ limit: 8 }).then((o) => setOffers(o.data)),
      api.getClicksStats('7d').then(setClicks),
      api.getGroupsHealth(24).then(setHealth),
    ])
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 60_000)
    return () => clearInterval(interval)
  }, [fetchData])

  const act = async (id: string, kind: 'approve' | 'reject') => {
    setActionLoadingId(id)
    try {
      if (kind === 'approve') await api.approveOffer(id)
      else await api.rejectOffer(id)
      setOffers((prev) => prev.map((o) => (o.id === id ? { ...o, status: (kind === 'approve' ? 'APPROVED' : 'REJECTED') as Offer['status'] } : o)))
      if (stats) setStats({ ...stats, pending: Math.max(0, stats.pending - 1) })
    } catch {
      // silent
    } finally {
      setActionLoadingId(null)
    }
  }

  const sources = health?.sourceGroups ?? []
  const byLevel = (lvl: string) => sources.filter((g) => g.level === lvl).length
  const attention = sources
    .filter((g) => g.level === 'critical' || g.level === 'warning')
    .sort((a, b) => (a.level === 'critical' ? -1 : 1) - (b.level === 'critical' ? -1 : 1))
    .slice(0, 4)
  const clicksWeek = clicks?.chartData.reduce((sum, d) => sum + d.clicks, 0) ?? 0
  const sys = health?.system

  return (
    <div>
      {/* Header */}
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div className="page-eyebrow">
            <Icon name="sparkles" size={13} />
            {greeting()}
          </div>
          <h1 className="page-title">Visão geral</h1>
          <p className="page-subtitle">Como estão suas ofertas, grupos e cliques hoje.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={fetchData} disabled={refreshing}>
            {refreshing ? <span className="spinner spinner-sm" /> : <Icon name="refresh" />}
            Atualizar
          </button>
          {(stats?.pending ?? 0) > 0 && (
            <Link to="/queue" className="btn btn-primary">
              Revisar {stats?.pending} pendente{stats?.pending === 1 ? '' : 's'}
              <Icon name="arrowRight" />
            </Link>
          )}
        </div>
      </div>

      {/* KPIs */}
      <div className="kpi-grid">
        <MetricCard label="Pendentes" value={stats?.pending ?? 0} icon="inbox" color="#f5a524" hint="Aguardando aprovação" loading={loading} />
        <MetricCard label="Aprovadas hoje" value={stats?.approvedToday ?? 0} icon="check" color="#8b7bff" hint="Prontas para envio" loading={loading} />
        <MetricCard label="Enviadas hoje" value={stats?.sentToday ?? 0} icon="send" color="#22c983" hint="Entregues nos grupos" loading={loading} />
        <MetricCard label="Falhas hoje" value={stats?.failedToday ?? 0} icon="alert" color="#f2555a" hint="Envios com erro" loading={loading} />
        <MetricCard label="Cliques hoje" value={stats?.clicksToday ?? 0} icon="cursor" color="#4ea8ff" hint="Pessoas reais" loading={loading} />
      </div>

      {/* Clicks chart + system status */}
      <div className="dash-grid" style={{ marginBottom: 16 }}>
        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <Icon name="trendUp" size={16} style={{ color: 'var(--text-accent)' }} />
              Cliques nos últimos 7 dias
            </div>
            <Link to="/clicks" className="btn btn-ghost btn-sm">
              Detalhes <Icon name="chevronRight" />
            </Link>
          </div>
          <div className="panel-body" style={{ paddingBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
              <span className="metric-value" style={{ fontSize: '1.6rem' }}>{clicksWeek.toLocaleString('pt-BR')}</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>cliques na semana</span>
            </div>
            <div style={{ height: 210, marginLeft: -12 }}>
              {loading ? (
                <Skeleton height={200} borderRadius={12} />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={clicks?.chartData ?? []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="dashClicks" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#7c6cff" stopOpacity={0.45} />
                        <stop offset="100%" stopColor="#7c6cff" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: '#6e6e7a', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#6e6e7a', fontSize: 11 }} axisLine={false} tickLine={false} width={40} allowDecimals={false} />
                    <Tooltip
                      cursor={{ stroke: 'rgba(124,108,255,0.4)', strokeWidth: 1 }}
                      contentStyle={{ background: '#16161b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, fontSize: 12, boxShadow: '0 12px 30px -10px rgba(0,0,0,0.8)' }}
                      labelStyle={{ color: '#a3a3ae', marginBottom: 2 }}
                      itemStyle={{ color: '#f4f4f6' }}
                      formatter={(v) => [Number(v ?? 0).toLocaleString('pt-BR'), 'Cliques']}
                    />
                    <Area type="monotone" dataKey="clicks" stroke="#8b7bff" strokeWidth={2} fill="url(#dashClicks)" dot={false} activeDot={{ r: 4, fill: '#8b7bff', stroke: '#08080a', strokeWidth: 2 }} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <Icon name="shield" size={16} style={{ color: 'var(--text-accent)' }} />
              Status do sistema
            </div>
            <Link to="/logs" className="btn btn-ghost btn-sm">
              Logs <Icon name="chevronRight" />
            </Link>
          </div>
          <div className="panel-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '14px 0' }}>
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} height={14} />)}
              </div>
            ) : (
              <>
                <StatusRow icon="telegram" label="Telegram listener" ok={sys ? sys.listener.reachable && sys.listener.authenticated !== false : null} okText="Conectado" badText={sys?.listener.reachable ? 'Não autenticado' : 'Offline'} />
                <StatusRow icon="bag" label="Sessão Mercado Livre" ok={sys ? sys.listener.mlSessionActive : null} okText="Ativa" badText="Expirada" />
                <StatusRow icon="message" label="WhatsApp (Evolution)" ok={sys ? sys.evolutionConnected : null} okText="Conectado" badText="Desconectado" />
                <StatusRow icon="zap" label="Aprovação automática" ok={sys ? sys.autoApprove : null} okText="Ligada" badText="Desligada" />
              </>
            )}
          </div>
        </section>
      </div>

      {/* Recent offers + groups health */}
      <div className="dash-grid">
        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <Icon name="inbox" size={16} style={{ color: 'var(--text-accent)' }} />
              Ofertas recentes
            </div>
            <Link to="/history" className="btn btn-ghost btn-sm">
              Histórico <Icon name="chevronRight" />
            </Link>
          </div>
          {loading ? (
            <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} height={18} />)}
            </div>
          ) : offers.length === 0 ? (
            <div style={{ padding: 18 }}>
              <div className="empty-state" style={{ padding: '40px 20px' }}>
                <span className="empty-state-icon"><Icon name="inboxEmpty" size={24} /></span>
                <span className="empty-state-title">Nenhuma oferta ainda</span>
                <span className="empty-state-desc">Quando ofertas chegarem dos grupos monitorados, elas aparecem aqui.</span>
              </div>
            </div>
          ) : (
            <div>
              {offers.map((offer) => {
                const text = offer.text ?? offer.mediaCaption ?? ''
                const group = offer.sourceGroup?.name || 'Desconhecido'
                return (
                  <div key={offer.id} className="list-row">
                    <div className="avatar" style={{ width: 30, height: 30, fontSize: '0.72rem', background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)', boxShadow: 'inset 0 0 0 1px var(--border-default)' }}>
                      {group.charAt(0).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="truncate" style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                        {text.split('\n').find((l) => l.trim()) || 'Oferta sem texto'}
                      </div>
                      <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 2 }}>
                        {group} · há {timeAgo(offer.createdAt)}
                      </div>
                    </div>
                    <StatusBadge status={offer.status} />
                    {offer.status === 'PENDING' && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="icon-btn" title="Aprovar" onClick={() => act(offer.id, 'approve')} disabled={actionLoadingId === offer.id} style={{ width: 30, height: 30, color: '#4fe0a4' }}>
                          <Icon name="check" size={15} />
                        </button>
                        <button className="icon-btn danger" title="Rejeitar" onClick={() => act(offer.id, 'reject')} disabled={actionLoadingId === offer.id} style={{ width: 30, height: 30 }}>
                          <Icon name="x" size={15} />
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <Icon name="activity" size={16} style={{ color: 'var(--text-accent)' }} />
              Saúde dos grupos
            </div>
            <span className="panel-meta">últimas 24h</span>
          </div>
          <div className="panel-body">
            {loading ? (
              <Skeleton height={120} borderRadius={12} />
            ) : !health ? (
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Não foi possível carregar a saúde dos grupos.</div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
                  {([['ok', 'Saudáveis'], ['warning', 'Atenção'], ['critical', 'Críticos']] as const).map(([lvl, label]) => (
                    <div key={lvl} style={{ padding: '10px 12px', borderRadius: 11, background: 'rgba(255,255,255,0.025)', border: '1px solid var(--border-subtle)' }}>
                      <div style={{ fontSize: '1.3rem', fontWeight: 650, letterSpacing: '-0.03em', color: LEVEL_COLOR[lvl] }}>{byLevel(lvl)}</div>
                      <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{label}</div>
                    </div>
                  ))}
                </div>
                {sources.length > 0 && (
                  <div className="health-bar" style={{ marginBottom: 16 }}>
                    {(['ok', 'warning', 'critical', 'inactive'] as const).map((lvl) =>
                      byLevel(lvl) > 0 ? <span key={lvl} style={{ flex: byLevel(lvl), background: LEVEL_COLOR[lvl] }} /> : null,
                    )}
                  </div>
                )}
                {attention.length === 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    <Icon name="checkCircle" size={16} style={{ color: 'var(--accent-success)' }} />
                    Todos os grupos de origem estão funcionando.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {attention.map((g) => (
                      <Link key={g.id} to="/logs" style={{ display: 'flex', gap: 10, padding: '10px 12px', borderRadius: 11, border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}>
                        <span className={`status-dot ${g.level === 'critical' ? 'error' : 'warning'}`} style={{ marginTop: 6 }} />
                        <div style={{ minWidth: 0 }}>
                          <div className="truncate" style={{ fontSize: '0.84rem', fontWeight: 550, color: 'var(--text-primary)' }}>{g.name}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>{g.issues[0] ?? 'Verifique os logs'}</div>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
