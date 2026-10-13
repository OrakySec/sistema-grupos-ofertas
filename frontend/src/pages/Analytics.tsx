import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ResponsiveContainer,
  ComposedChart,
  BarChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts'
import api, { ApiError, type WaAnalytics, type WaWebhookStatus } from '../lib/api'
import { useToast } from '../lib/toast'
import Icon from '../components/Icon'
import { Skeleton } from '../components/LoadingSkeleton'
import GroupsHealthPanel from '../components/GroupsHealthPanel'

type Tab = 'overview' | 'retention' | 'engagement' | 'health'

const PERIODS: Array<[number, string]> = [
  [7, '7 dias'],
  [30, '30 dias'],
  [90, '90 dias'],
]

const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('pt-BR'))
const fmtPct = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? '—' : `${n.toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits })}%`
const fmtDec = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined ? '—' : n.toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits })

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'nunca'
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  return `há ${Math.floor(h / 24)} d`
}

const TOOLTIP_STYLE = {
  contentStyle: { background: '#16161b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, fontSize: 12 },
  labelStyle: { color: '#a3a3ae', marginBottom: 2 },
  itemStyle: { color: '#f4f4f6' },
  cursor: { fill: 'rgba(255,255,255,0.03)' },
}
const AXIS = { tick: { fill: '#6e6e7a', fontSize: 11 }, axisLine: false, tickLine: false } as const

// ── Small building blocks ───────────────────────────────────────────────────

function Kpi({ label, value, hint, color, icon }: { label: string; value: string; hint?: string; color: string; icon: string }) {
  return (
    <div className="metric-card" style={{ '--metric-accent': color } as React.CSSProperties}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
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
      <div className="metric-value" style={{ fontSize: '1.7rem' }}>{value}</div>
      {hint && <div className="metric-trend">{hint}</div>}
    </div>
  )
}

function Panel({ title, icon, meta, children }: { title: string; icon: string; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <Icon name={icon} size={16} style={{ color: 'var(--text-accent)' }} />
          {title}
        </div>
        {meta && <span className="panel-meta">{meta}</span>}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  )
}

/** Heat-map cell for a retention percentage. */
function RetentionCell({ value }: { value: number | null }) {
  if (value === null) return <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>—</td>
  const alpha = 0.08 + (value / 100) * 0.42
  return (
    <td style={{ textAlign: 'center', padding: 6 }}>
      <span
        style={{
          display: 'inline-block',
          minWidth: 64,
          padding: '6px 10px',
          borderRadius: 8,
          background: `rgba(124,108,255,${alpha.toFixed(2)})`,
          color: value > 55 ? '#fff' : 'var(--text-primary)',
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {fmtPct(value)}
      </span>
    </td>
  )
}

// ── Member-collection status (Evolution webhook) ────────────────────────────

function CollectionStatus({ onChanged }: { onChanged: () => void }) {
  const { addToast } = useToast()
  const [status, setStatus] = useState<WaWebhookStatus | null>(null)
  const [busy, setBusy] = useState<'setup' | 'snapshot' | null>(null)

  const load = useCallback(() => {
    api.getWaWebhookStatus().then(setStatus).catch((err) => setStatus({ state: 'ERROR', ourUrl: '', error: err instanceof Error ? err.message : String(err) }))
  }, [])
  useEffect(load, [load])

  const activate = async (force = false) => {
    if (force && !window.confirm(`Isso substitui o webhook atual da instância (${status?.currentUrl}). O sistema que recebe esse webhook hoje vai parar de receber eventos. Continuar?`)) return
    setBusy('setup')
    try {
      const s = await api.setupWaWebhook(force)
      setStatus(s)
      addToast(s.state === 'ACTIVE' ? 'Coleta de membros ativada!' : 'Webhook configurado, mas o status ainda não está ativo', s.state === 'ACTIVE' ? 'success' : 'error')
      if (s.state === 'ACTIVE') {
        // Baseline right away, so the member count shows up without waiting 6h.
        await api.snapshotWaGroups().catch(() => {})
        onChanged()
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        load()
        addToast(err.message, 'error')
      } else {
        addToast(err instanceof Error ? err.message : 'Erro ao ativar a coleta', 'error')
      }
    } finally {
      setBusy(null)
    }
  }

  const snapshot = async () => {
    setBusy('snapshot')
    try {
      const { results } = await api.snapshotWaGroups()
      const failed = results.filter((r) => r.error)
      const total = results.reduce((a, r) => a + (r.members ?? 0), 0)
      addToast(
        failed.length
          ? `Contagem com erro em ${failed.length} grupo(s): ${failed[0].error}`
          : `Membros contados: ${total.toLocaleString('pt-BR')} em ${results.length} grupo(s)`,
        failed.length ? 'error' : 'success',
      )
      onChanged()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao contar membros', 'error')
    } finally {
      setBusy(null)
    }
  }

  if (!status) return <Skeleton height={56} borderRadius={14} style={{ marginBottom: 16 }} />

  if (status.state === 'ACTIVE') {
    return (
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-body" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 16px' }}>
          <span className="status-dot online pulse" />
          <span style={{ fontSize: '0.86rem', color: 'var(--text-primary)', fontWeight: 550 }}>Coleta de membros ativa</span>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Último evento recebido {timeAgo(status.lastEventAt)} · contagem automática a cada 6 h
          </span>
          <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={snapshot} disabled={busy !== null}>
            {busy === 'snapshot' ? <span className="spinner spinner-sm" /> : <Icon name="refresh" />}
            Contar membros agora
          </button>
        </div>
      </div>
    )
  }

  const conflict = status.state === 'OTHER_URL'
  return (
    <div className={`alert ${status.state === 'ERROR' ? 'alert-error' : 'alert-warning'}`} style={{ marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
      <Icon name="alert" size={18} style={{ flexShrink: 0 }} />
      <div style={{ flex: '1 1 320px' }}>
        <strong>
          {status.state === 'ERROR'
            ? 'Não consegui consultar a Evolution API'
            : conflict
              ? 'A instância do WhatsApp já envia webhook para outro sistema'
              : 'A coleta de entradas e saídas ainda não está ativa'}
        </strong>
        <div style={{ fontSize: '0.8rem', opacity: 0.9, marginTop: 2 }}>
          {status.state === 'ERROR'
            ? status.error
            : conflict
              ? `Webhook atual: ${status.currentUrl}. A Evolution aceita só um webhook por instância — ativar aqui substitui esse.`
              : 'Ativando, a Evolution passa a avisar o sistema sempre que alguém entra ou sai dos seus grupos. Os números começam a contar a partir daí.'}
        </div>
      </div>
      {status.state !== 'ERROR' && (
        <button className={`btn ${conflict ? 'btn-danger' : 'btn-primary'} btn-sm`} onClick={() => activate(conflict)} disabled={busy !== null}>
          {busy === 'setup' ? <span className="spinner spinner-sm" /> : <Icon name="zap" />}
          {conflict ? 'Substituir e ativar' : 'Ativar coleta'}
        </button>
      )}
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function Analytics() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('overview')
  const [days, setDays] = useState(30)
  const [groupId, setGroupId] = useState('')
  const [data, setData] = useState<WaAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await api.getWaAnalytics(days, groupId || undefined))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar analytics')
    } finally {
      setLoading(false)
    }
  }, [days, groupId])

  useEffect(() => {
    load()
  }, [load])

  const t = data?.totals
  const noData = !!data && !data.trackingSince

  return (
    <div>
      {/* Header */}
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Analytics</h1>
          <p className="page-subtitle">Crescimento, retenção e engajamento dos seus grupos de WhatsApp.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="select" value={groupId} onChange={(e) => setGroupId(e.target.value)} style={{ width: 'auto', minWidth: 220 }}>
            <option value="">Todos os grupos</option>
            {data?.groupOptions.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
          <div className="tabs">
            {PERIODS.map(([d, label]) => (
              <button key={d} className={`tab${days === d ? ' active' : ''}`} onClick={() => setDays(d)}>{label}</button>
            ))}
          </div>
          <button className="btn btn-secondary" onClick={load} disabled={loading} title="Atualizar">
            {loading ? <span className="spinner spinner-sm" /> : <Icon name="refresh" />}
          </button>
        </div>
      </div>

      <CollectionStatus onChanged={load} />

      {/* Section tabs */}
      <div style={{ marginBottom: 18, overflowX: 'auto' }}>
        <div className="tabs">
          {([
            ['overview', 'dashboard', 'Visão geral'],
            ['retention', 'users', 'Retenção'],
            ['engagement', 'cursor', 'Engajamento'],
            ['health', 'shield', 'Saúde'],
          ] as const).map(([key, icon, label]) => (
            <button key={key} className={`tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
              <Icon name={icon} size={15} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'health' ? (
        <GroupsHealthPanel onOpenLogs={(id) => navigate(`/logs?tab=processing&group=${id}`)} />
      ) : error ? (
        <div className="alert alert-error"><Icon name="alert" size={16} /> {error}</div>
      ) : loading && !data ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Skeleton height={120} borderRadius={14} />
          <Skeleton height={320} borderRadius={14} />
        </div>
      ) : !data || !t ? null : noData ? (
        <div className="empty-state">
          <span className="empty-state-icon"><Icon name="activity" size={24} /></span>
          <span className="empty-state-title">Ainda não há dados de membros</span>
          <span className="empty-state-desc">
            Ative a coleta acima. A partir daí o sistema registra cada entrada e saída e conta os membros a cada 6 horas — o histórico
            anterior à ativação não existe no WhatsApp para ser importado.
          </span>
        </div>
      ) : tab === 'overview' ? (
        <>
          <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
            <Kpi label="Membros" value={fmtInt(t.membersNow)} hint={t.membersStart !== null ? `${fmtInt(t.membersStart)} no início do período` : undefined} color="#8b7bff" icon="users" />
            <Kpi label="Entraram" value={fmtInt(t.joins)} hint={`em ${days} dias`} color="#22c983" icon="trendUp" />
            <Kpi label="Saíram" value={fmtInt(t.leaves + t.kicks)} hint={t.kicks ? `${fmtInt(t.kicks)} removidos por admin` : 'saíram por conta própria'} color="#f2555a" icon="logout" />
            <Kpi label="Crescimento líquido" value={`${t.net > 0 ? '+' : ''}${fmtInt(t.net)}`} hint={t.churnPct !== null ? `${fmtPct(t.churnPct, 1)} de saída no período` : undefined} color="#4ea8ff" icon="activity" />
            <Kpi label="Retenção" value={fmtPct(t.retentionPct, 1)} hint="continuam no grupo" color="#f5a524" icon="shield" />
          </div>

          <div style={{ marginBottom: 16 }}>
            <Panel title="Membros, entradas e saídas por dia" icon="trendUp" meta={data.trackingSince ? `coletando desde ${new Date(data.trackingSince).toLocaleDateString('pt-BR')}` : undefined}>
              <div style={{ height: 300, marginLeft: -8 }}>
                <ResponsiveContainer>
                  <ComposedChart data={data.series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="date" {...AXIS} />
                    <YAxis yAxisId="flow" {...AXIS} width={34} allowDecimals={false} />
                    <YAxis yAxisId="members" orientation="right" {...AXIS} width={44} allowDecimals={false} domain={['auto', 'auto']} />
                    <Tooltip {...TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 12, color: '#a3a3ae' }} />
                    <Bar yAxisId="flow" dataKey="joins" name="Entraram" fill="#22c983" fillOpacity={0.75} radius={[4, 4, 0, 0]} maxBarSize={18} />
                    <Bar yAxisId="flow" dataKey="exits" name="Saíram" fill="#f2555a" fillOpacity={0.75} radius={[4, 4, 0, 0]} maxBarSize={18} />
                    <Line yAxisId="members" type="monotone" dataKey="members" name="Membros" stroke="#8b7bff" strokeWidth={2} dot={false} connectNulls={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Grupo</th>
                  <th style={{ textAlign: 'right' }}>Membros</th>
                  <th style={{ textAlign: 'right' }}>Entraram</th>
                  <th style={{ textAlign: 'right' }}>Saíram</th>
                  <th style={{ textAlign: 'right' }}>Líquido</th>
                  <th style={{ textAlign: 'right' }}>Retenção</th>
                  <th style={{ textAlign: 'right' }}>Ofertas</th>
                  <th style={{ textAlign: 'right' }}>Cliques/membro</th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((g) => (
                  <tr key={g.id} style={{ cursor: 'pointer' }} onClick={() => setGroupId(g.id)}>
                    <td className="primary">
                      {g.name}
                      {!g.trackingSince && <span className="badge" style={{ marginLeft: 8 }}>sem dados</span>}
                    </td>
                    <td className="tabular" style={{ textAlign: 'right' }}>{fmtInt(g.membersNow)}</td>
                    <td className="tabular" style={{ textAlign: 'right', color: '#4fe0a4' }}>{fmtInt(g.joins)}</td>
                    <td className="tabular" style={{ textAlign: 'right', color: '#ff8a8e' }}>{fmtInt(g.leaves + g.kicks)}</td>
                    <td className="tabular" style={{ textAlign: 'right' }}>{g.net > 0 ? '+' : ''}{fmtInt(g.net)}</td>
                    <td className="tabular" style={{ textAlign: 'right' }}>{fmtPct(g.retentionPct, 1)}</td>
                    <td className="tabular" style={{ textAlign: 'right' }}>{fmtInt(g.offersSent)}</td>
                    <td className="tabular" style={{ textAlign: 'right' }}>{fmtDec(g.clicksPerMember)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : tab === 'retention' ? (
        <>
          <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
            <Kpi label="Saídas rápidas" value={fmtInt(t.quickLeaves)} hint="saíram menos de 24 h depois de entrar" color="#f2555a" icon="clock" />
            <Kpi label="Tempo médio no grupo" value={t.avgTenureDays === null ? '—' : `${fmtDec(t.avgTenureDays, 1)} dias`} hint="de quem saiu no período" color="#8b7bff" icon="history" />
            <Kpi label="Removidos por admin" value={fmtInt(t.kicks)} hint="incluídos nas saídas e na taxa" color="#f5a524" icon="x" />
            <Kpi label="Taxa de saída" value={fmtPct(t.churnPct, 1)} hint="saídas ÷ membros no início" color="#4ea8ff" icon="logout" />
          </div>

          <div className="dash-grid">
            <Panel title="Retenção por semana de entrada" icon="users" meta="% que continua no grupo">
              <div className="table-wrapper" style={{ border: 'none', boxShadow: 'none', background: 'transparent' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Semana a partir de</th>
                      <th style={{ textAlign: 'right' }}>Entraram</th>
                      <th style={{ textAlign: 'center' }}>Após 1 dia</th>
                      <th style={{ textAlign: 'center' }}>Após 7 dias</th>
                      <th style={{ textAlign: 'center' }}>Após 30 dias</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.cohorts.map((c) => (
                      <tr key={c.label}>
                        <td className="primary">{c.label}</td>
                        <td className="tabular" style={{ textAlign: 'right' }}>{fmtInt(c.size)}</td>
                        <RetentionCell value={c.size ? c.d1 : null} />
                        <RetentionCell value={c.size ? c.d7 : null} />
                        <RetentionCell value={c.size ? c.d30 : null} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
                "—" = ainda não deu o tempo (ex.: quem entrou há 3 dias não tem retenção de 7 dias). Quem já estava no grupo antes da
                coleta começar não entra nessa conta, porque não se sabe quando entrou.
              </div>
            </Panel>

            <Panel title="Horário das saídas" icon="clock" meta="horário de Brasília">
              <div style={{ height: 260, marginLeft: -12 }}>
                <ResponsiveContainer>
                  <BarChart data={data.exitsByHour.map((v, h) => ({ hour: `${h}h`, exits: v, joins: data.joinsByHour[h] }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="hour" {...AXIS} interval={2} />
                    <YAxis {...AXIS} width={30} allowDecimals={false} />
                    <Tooltip {...TOOLTIP_STYLE} />
                    <Bar dataKey="joins" name="Entraram" fill="#22c983" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="exits" name="Saíram" fill="#f2555a" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>
        </>
      ) : (
        <>
          <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
            <Kpi label="Cliques" value={fmtInt(t.clicks)} hint="pessoas reais, links marcados por grupo" color="#4ea8ff" icon="cursor" />
            <Kpi label="Cliques por oferta" value={fmtDec(t.clicksPerOffer)} hint={`${fmtInt(t.offersSent)} ofertas enviadas`} color="#8b7bff" icon="send" />
            <Kpi label="Cliques por membro" value={fmtDec(t.clicksPerMember)} hint="compara grupos de tamanhos diferentes" color="#22c983" icon="users" />
            <Kpi label="Saídas a cada 100 ofertas" value={fmtDec(t.exitsPer100Offers, 1)} hint="sobe quando o volume cansa as pessoas" color="#f2555a" icon="alert" />
          </div>

          <div className="dash-grid">
            <Panel title="Ofertas enviadas × saídas por dia" icon="activity" meta="fadiga">
              <div style={{ height: 280, marginLeft: -8 }}>
                <ResponsiveContainer>
                  <ComposedChart data={data.series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="date" {...AXIS} />
                    <YAxis yAxisId="offers" {...AXIS} width={34} allowDecimals={false} />
                    <YAxis yAxisId="exits" orientation="right" {...AXIS} width={30} allowDecimals={false} />
                    <Tooltip {...TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 12, color: '#a3a3ae' }} />
                    <Bar yAxisId="offers" dataKey="offers" name="Ofertas enviadas" fill="rgba(124,108,255,0.55)" radius={[4, 4, 0, 0]} maxBarSize={18} />
                    <Line yAxisId="exits" type="monotone" dataKey="exits" name="Saídas" stroke="#f2555a" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </Panel>

            <Panel title="Cliques por horário" icon="clock" meta="horário de Brasília">
              <div style={{ height: 280, marginLeft: -12 }}>
                <ResponsiveContainer>
                  <BarChart data={data.clicksByHour.map((v, h) => ({ hour: `${h}h`, clicks: v }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="hour" {...AXIS} interval={2} />
                    <YAxis {...AXIS} width={30} allowDecimals={false} />
                    <Tooltip {...TOOLTIP_STYLE} />
                    <Bar dataKey="clicks" name="Cliques" fill="#4ea8ff" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>
          <p style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>
            Os cliques por grupo começam a contar a partir desta atualização: cada link enviado agora leva a marca do grupo
            (<code>?g=</code>). Ofertas da Amazon apontam para a página pública da oferta e não passam pelo encurtador, então não entram aqui.
          </p>
        </>
      )}
    </div>
  )
}
