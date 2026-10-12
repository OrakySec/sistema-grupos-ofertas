import React, { useEffect, useState } from 'react'
import api, { type ClickStats } from '../lib/api'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from 'recharts'
import { useToast } from '../lib/toast'
import Icon from '../components/Icon'
import { Skeleton } from '../components/LoadingSkeleton'

const PERIODS: Array<[string, string]> = [
  ['today', 'Hoje'],
  ['yesterday', 'Ontem'],
  ['7d', '7 dias'],
  ['30d', '30 dias'],
  ['all', 'Tudo'],
]

function MiniStat({ label, value, hint, color }: { label: string; value: number; hint?: string; color?: string }) {
  return (
    <div style={{ padding: '14px 16px', borderRadius: 12, background: 'rgba(255,255,255,0.025)', border: '1px solid var(--border-subtle)' }}>
      <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: '1.35rem', fontWeight: 650, letterSpacing: '-0.03em', color: color ?? 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
        {value.toLocaleString('pt-BR')}
      </div>
      {hint && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{hint}</div>}
    </div>
  )
}

export default function Clicks() {
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState('today')
  const [stats, setStats] = useState<ClickStats | null>(null)
  const { addToast } = useToast()

  const fetchStats = async (selectedPeriod: string) => {
    try {
      setLoading(true)
      const data = await api.getClicksStats(selectedPeriod)
      setStats(data)
    } catch (err) {
      addToast('Erro ao carregar estatísticas de cliques', 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStats(period)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period])

  const maxTop = Math.max(1, ...(stats?.topLinks ?? []).map((l) => l.count))

  return (
    <div>
      {/* Header */}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Cliques</h1>
          <p className="page-subtitle">Quantas pessoas reais abriram os links das suas ofertas.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="tabs">
            {PERIODS.map(([value, label]) => (
              <button key={value} className={`tab${period === value ? ' active' : ''}`} onClick={() => setPeriod(value)}>
                {label}
              </button>
            ))}
          </div>
          <button className="btn btn-secondary" onClick={() => fetchStats(period)} disabled={loading} title="Atualizar">
            {loading ? <span className="spinner spinner-sm" /> : <Icon name="refresh" />}
          </button>
        </div>
      </div>

      {loading && !stats ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Skeleton height={140} borderRadius={14} />
          <Skeleton height={360} borderRadius={14} />
        </div>
      ) : stats ? (
        <>
          {/* Summary */}
          <section className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-body" style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: '1 1 200px' }}>
                <span className="icon-chip lg" style={{ '--chip-color': '#4ea8ff', '--chip-bg': 'rgba(78,168,255,0.13)', '--chip-ring': 'rgba(78,168,255,0.28)' } as React.CSSProperties}>
                  <Icon name="cursor" />
                </span>
                <div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Cliques reais</div>
                  <div className="metric-value" style={{ fontSize: '2.1rem' }}>{stats.total.toLocaleString('pt-BR')}</div>
                </div>
              </div>
              {stats.breakdown && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, flex: '3 1 420px' }}>
                  <MiniStat label="Acessos ao link (tudo)" value={stats.breakdown.allRequests} />
                  <MiniStat label="Visitantes únicos" value={stats.breakdown.uniqueVisitors} hint="pessoa + link" />
                  <MiniStat label="Robôs e prévias" value={stats.breakdown.bot} hint="não contados" color={stats.breakdown.bot > 0 ? '#ffc15e' : undefined} />
                  <MiniStat label="Repetidos" value={stats.breakdown.duplicate} hint="mesma pessoa em 10 min" />
                </div>
              )}
            </div>

            {stats.breakdown && (
              <div style={{ padding: '0 18px 18px' }}>
                {stats.botAgents && stats.botAgents.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
                    <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginRight: 2 }}>Quem são os robôs:</span>
                    {stats.botAgents.map((b) => (
                      <span key={b.agent} className="badge">
                        {b.agent} <strong style={{ color: 'var(--text-primary)' }}>{b.count}</strong>
                      </span>
                    ))}
                  </div>
                )}

                {stats.botSamples && stats.botSamples.length > 0 && (
                  <details style={{ marginBottom: 12 }}>
                    <summary style={{ fontSize: '0.76rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
                      Ver exemplos de "Outros robôs" (pra conferir se alguma pessoa foi classificada errado)
                    </summary>
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {stats.botSamples.map((b) => (
                        <div key={b.userAgent} className="font-mono" style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                          <strong>{b.count}×</strong> {b.userAgent}
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {stats.breakdown.legacy > 0 && (
                  <div className="alert alert-warning" style={{ marginBottom: 12 }}>
                    <Icon name="alert" size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                    <span>
                      {stats.breakdown.legacy.toLocaleString('pt-BR')} dos cliques acima são de <strong>antes</strong> da atualização que separa
                      pessoas de robôs — esses não dá pra filtrar e podem incluir prévias de link e verificações automáticas.
                    </span>
                  </div>
                )}

                <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.55 }}>
                  Horários em Brasília. O painel de afiliados do Mercado Livre conta só cliques nos links <strong>do Mercado Livre</strong>, depois de
                  filtrar tráfego automático e com algum atraso — então o número dele tende a ficar abaixo do nosso mesmo com os robôs
                  já descontados (aqui entram também Amazon, Shopee etc.).
                </div>
              </div>
            )}
          </section>

          {/* Chart + top links */}
          <div className="dash-grid">
            <section className="panel">
              <div className="panel-header">
                <div className="panel-title">
                  <Icon name="trendUp" size={16} style={{ color: 'var(--text-accent)' }} />
                  Evolução de cliques
                </div>
                {loading && <span className="spinner spinner-sm" />}
              </div>
              <div className="panel-body" style={{ height: 360, paddingLeft: 6 }}>
                <ResponsiveContainer>
                  <AreaChart data={stats.chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorClicks" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#7c6cff" stopOpacity={0.45} />
                        <stop offset="100%" stopColor="#7c6cff" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: '#6e6e7a', fontSize: 11 }} tickLine={false} axisLine={false} dy={8} />
                    <YAxis tick={{ fill: '#6e6e7a', fontSize: 11 }} tickLine={false} axisLine={false} width={40} allowDecimals={false} tickFormatter={(value) => (value > 0 ? value : '')} />
                    <Tooltip
                      cursor={{ stroke: 'rgba(124,108,255,0.4)', strokeWidth: 1 }}
                      contentStyle={{ background: '#16161b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, fontSize: 12 }}
                      labelStyle={{ color: '#a3a3ae' }}
                      itemStyle={{ color: '#f4f4f6' }}
                    />
                    <Area type="monotone" dataKey="clicks" name="Cliques" stroke="#8b7bff" strokeWidth={2} fill="url(#colorClicks)" activeDot={{ r: 4, fill: '#8b7bff', stroke: '#08080a', strokeWidth: 2 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header">
                <div className="panel-title">
                  <Icon name="link" size={16} style={{ color: 'var(--text-accent)' }} />
                  Links mais clicados
                </div>
                <span className="panel-meta">top 5</span>
              </div>
              <div className="panel-body">
                {stats.topLinks.length === 0 ? (
                  <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '28px 0', fontSize: '0.85rem' }}>
                    Nenhum clique registrado neste período.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {stats.topLinks.map((link, idx) => (
                      <div key={idx}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                          <span style={{ width: 20, fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{idx + 1}</span>
                          <a
                            href={link.originalUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="truncate"
                            style={{ flex: 1, fontSize: '0.84rem', color: 'var(--text-primary)' }}
                            title={link.originalUrl}
                          >
                            {link.title || link.originalUrl}
                          </a>
                          <span style={{ fontSize: '0.84rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{link.count}</span>
                        </div>
                        <div style={{ marginLeft: 30, height: 5, borderRadius: 99, background: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
                          <div style={{ width: `${(link.count / maxTop) * 100}%`, height: '100%', borderRadius: 99, background: 'var(--accent-gradient)' }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        </>
      ) : null}
    </div>
  )
}
