import React, { useCallback, useEffect, useState } from 'react'
import { ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts'
import api, { type LeadResults as Results, type LeadResultsSummary } from '../lib/api'
import Icon from './Icon'
import { Skeleton } from './LoadingSkeleton'

type PeriodKey = 'today' | 'yesterday' | '7' | '30' | '90' | 'custom'
const PERIODS: Array<[PeriodKey, string]> = [['today', 'Hoje'], ['yesterday', 'Ontem'], ['7', '7 dias'], ['30', '30 dias'], ['90', '90 dias'], ['custom', 'Período']]
const brtToday = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10)
const shiftDay = (ymd: string, n: number) => new Date(Date.parse(ymd + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10)
function periodQuery(key: PeriodKey, from: string, to: string): { days?: number; from?: string; to?: string } {
  if (key === 'today') return { from: brtToday(), to: brtToday() }
  if (key === 'yesterday') return { from: shiftDay(brtToday(), -1), to: shiftDay(brtToday(), -1) }
  if (key === 'custom') return { from, to: to < from ? from : to }
  return { days: Number(key) }
}

const int = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('pt-BR'))
const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`)
const TOOLTIP = {
  contentStyle: { background: '#16161b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, fontSize: 12 },
  labelStyle: { color: '#a3a3ae', marginBottom: 2 },
  itemStyle: { color: '#f4f4f6' },
  cursor: { fill: 'rgba(255,255,255,0.03)' },
}
const AXIS = { tick: { fill: '#6e6e7a', fontSize: 11 }, axisLine: false, tickLine: false } as const

function Kpi({ label, value, hint, color, icon }: { label: string; value: string; hint?: string; color: string; icon: string }) {
  return (
    <div className="metric-card" style={{ '--metric-accent': color } as React.CSSProperties}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span className="metric-label">{label}</span>
        <span className="icon-chip" style={{ '--chip-color': color, '--chip-bg': `color-mix(in srgb, ${color} 14%, transparent)`, '--chip-ring': `color-mix(in srgb, ${color} 26%, transparent)` } as React.CSSProperties}>
          <Icon name={icon} />
        </span>
      </div>
      <div className="metric-value" style={{ fontSize: '1.7rem' }}>{value}</div>
      {hint && <div className="metric-trend">{hint}</div>}
    </div>
  )
}

function RetentionCell({ v }: { v: { eligible: number; pct: number | null } }) {
  if (v.pct === null) return <td style={{ textAlign: 'center', color: 'var(--text-muted)' }} title="Ninguém completou esse tempo ainda">—</td>
  const alpha = 0.08 + (v.pct / 100) * 0.42
  return (
    <td style={{ textAlign: 'center', padding: 6 }} title={`${int(v.eligible)} pessoas já completaram esse tempo`}>
      <span style={{ display: 'inline-block', minWidth: 58, padding: '5px 9px', borderRadius: 8, background: `rgba(124,108,255,${alpha.toFixed(2)})`, color: v.pct > 55 ? '#fff' : 'var(--text-primary)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {pct(v.pct)}
      </span>
    </td>
  )
}

type View = 'byCampaign' | 'byGroup' | 'bySource' | 'byInstance'
const VIEWS: Array<[View, string]> = [['byCampaign', 'Por lista'], ['byGroup', 'Por grupo'], ['bySource', 'Por origem'], ['byInstance', 'Por número']]

export default function LeadResults() {
  const [period, setPeriod] = useState<PeriodKey>('30')
  const [customFrom, setCustomFrom] = useState(() => shiftDay(brtToday(), -6))
  const [customTo, setCustomTo] = useState(() => brtToday())
  const [campaignId, setCampaignId] = useState('')
  const [instanceId, setInstanceId] = useState('')
  const [view, setView] = useState<View>('byCampaign')
  const [data, setData] = useState<Results | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      setData(await api.getLeadResults({ ...periodQuery(period, customFrom, customTo), campaignId, instanceId }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar os resultados')
    } finally {
      setLoading(false)
    }
  }, [period, customFrom, customTo, campaignId, instanceId])
  useEffect(() => { load() }, [load])

  const t: LeadResultsSummary | undefined = data?.totals
  const hiddenGroups = data?.lastCheck?.results.filter((r) => r.skipped) ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select className="select" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} style={{ width: 'auto', minWidth: 200 }}>
          <option value="">Todas as listas</option>
          {data?.options.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="select" value={instanceId} onChange={(e) => setInstanceId(e.target.value)} style={{ width: 'auto', minWidth: 160 }}>
          <option value="">Todos os números</option>
          {data?.options.instances.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
        </select>
        <div className="tabs">
          {PERIODS.map(([k, l]) => <button key={k} className={`tab${period === k ? ' active' : ''}`} onClick={() => setPeriod(k)}>{l}</button>)}
        </div>
        {period === 'custom' && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input className="input" type="date" value={customFrom} max={brtToday()} onChange={(e) => e.target.value && setCustomFrom(e.target.value)} style={{ width: 'auto', colorScheme: 'dark' }} aria-label="De" />
            <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>até</span>
            <input className="input" type="date" value={customTo} min={customFrom} max={brtToday()} onChange={(e) => e.target.value && setCustomTo(e.target.value)} style={{ width: 'auto', colorScheme: 'dark' }} aria-label="Até" />
          </div>
        )}
        <button className="btn btn-secondary" onClick={load} disabled={loading} title="Atualizar">{loading ? <span className="spinner spinner-sm" /> : <Icon name="refresh" />}</button>
      </div>

      {error ? <div className="alert alert-error">{error}</div> : !data || !t ? <Skeleton height={320} borderRadius={14} /> : (
        <>
          <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: 0 }}>
            <Kpi label="Entraram pelo sistema" value={int(t.entered)} hint={`${int(t.added)} adicionados direto · ${int(t.invitesJoined)} pelo convite`} color="#22c983" icon="userPlus" />
            <Kpi label="Saíram depois" value={int(t.left)} hint={t.leftPct !== null ? `${pct(t.leftPct)} de quem entrou` : 'ninguém entrou no período'} color="#f2555a" icon="logout" />
            <Kpi label="Continuam no grupo" value={pct(t.retentionPct)} hint={`${int(t.stillIn)} pessoas`} color="#8b7bff" icon="users" />
            <Kpi label="Convites que viraram entrada" value={pct(t.inviteConversionPct)} hint={`${int(t.invitesJoined)} de ${int(t.invitesSent)} convites enviados`} color="#4ea8ff" icon="send" />
            <Kpi label="Saídas rápidas" value={int(t.quickLeaves)} hint={t.avgTenureDays !== null ? `saíram em menos de 24 h · média até sair ${t.avgTenureDays.toLocaleString('pt-BR')} dias` : 'saíram em menos de 24 h'} color="#f5a524" icon="clock" />
          </div>

          <section className="panel">
            <div className="panel-header">
              <div className="panel-title"><Icon name="trendUp" size={16} style={{ color: 'var(--text-accent)' }} />{data.bucket === 'hour' ? 'Entradas e saídas por hora' : 'Entradas e saídas por dia'}</div>
              <span className="panel-meta">quem o sistema colocou nos grupos</span>
            </div>
            <div className="panel-body">
              <div style={{ height: 280, marginLeft: -8 }}>
                <ResponsiveContainer>
                  <ComposedChart data={data.series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="date" {...AXIS} />
                    <YAxis {...AXIS} width={34} allowDecimals={false} />
                    <Tooltip {...TOOLTIP} />
                    <Legend wrapperStyle={{ fontSize: 12, color: '#a3a3ae' }} />
                    <Bar dataKey="entered" name="Entraram" fill="#22c983" fillOpacity={0.75} radius={[4, 4, 0, 0]} maxBarSize={18} />
                    <Bar dataKey="left" name="Saíram" fill="#f2555a" fillOpacity={0.75} radius={[4, 4, 0, 0]} maxBarSize={18} />
                    <Bar dataKey="invitesSent" name="Convites enviados" fill="#4ea8ff" fillOpacity={0.5} radius={[4, 4, 0, 0]} maxBarSize={18} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          </section>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
            <section className="panel">
              <div className="panel-header">
                <div className="panel-title"><Icon name="users" size={16} style={{ color: 'var(--text-accent)' }} />Continuam no grupo depois de…</div>
                <span className="panel-meta">de quem entrou no período</span>
              </div>
              <div className="panel-body">
                <table>
                  <thead><tr><th style={{ textAlign: 'center' }}>1 dia</th><th style={{ textAlign: 'center' }}>7 dias</th><th style={{ textAlign: 'center' }}>30 dias</th></tr></thead>
                  <tbody><tr><RetentionCell v={t.d1} /><RetentionCell v={t.d7} /><RetentionCell v={t.d30} /></tr></tbody>
                </table>
                <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>Conta só quem já completou aquele tempo desde que entrou. "—" = ninguém chegou lá ainda.</div>
              </div>
            </section>
            <section className="panel">
              <div className="panel-header">
                <div className="panel-title"><Icon name="activity" size={16} style={{ color: 'var(--text-accent)' }} />O que aconteceu com quem foi processado</div>
                <span className="panel-meta">{int(t.processed)} no período</span>
              </div>
              <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {([
                  ['Adicionados direto', t.added, '#4fe0a4'],
                  ['Convite enviado no privado', t.invitesSent, '#8fb4ff'],
                  ['Já estavam no grupo', t.alreadyMember, 'var(--text-muted)'],
                  ['Sem WhatsApp', t.noWhatsApp, 'var(--text-muted)'],
                  ['Já tinham saído de um grupo seu (bloqueados)', t.blocked, '#c9a0ff'],
                  ['Falharam', t.failed, '#ff8a8e'],
                ] as const).map(([label, n, color]) => (
                  <div key={label} className="status-row">
                    <span style={{ color, fontSize: '0.9rem' }}>●</span>
                    <span style={{ flex: 1 }}>{label}</span>
                    <span className="tabular" style={{ fontWeight: 600 }}>{int(n)}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div>
            <div className="tabs" style={{ marginBottom: 10 }}>
              {VIEWS.map(([k, l]) => <button key={k} className={`tab${view === k ? ' active' : ''}`} onClick={() => setView(k)}>{l}</button>)}
            </div>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>{VIEWS.find(([k]) => k === view)?.[1].replace('Por ', '').replace(/^./, (c) => c.toUpperCase())}</th>
                    <th style={{ textAlign: 'right' }}>Entraram</th>
                    <th style={{ textAlign: 'right' }}>Adicionados</th>
                    <th style={{ textAlign: 'right' }}>Convites → entraram</th>
                    <th style={{ textAlign: 'right' }}>Saíram</th>
                    <th style={{ textAlign: 'right' }}>Continuam</th>
                    <th style={{ textAlign: 'center' }}>Após 7 dias</th>
                  </tr>
                </thead>
                <tbody>
                  {data[view].length === 0 ? (
                    <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>Nada no período.</td></tr>
                  ) : data[view].map((r) => (
                    <tr key={r.key}>
                      <td className="primary">{r.label}</td>
                      <td className="tabular" style={{ textAlign: 'right', color: '#4fe0a4' }}>{int(r.entered)}</td>
                      <td className="tabular" style={{ textAlign: 'right' }}>{int(r.added)}</td>
                      <td className="tabular" style={{ textAlign: 'right' }}>{int(r.invitesJoined)}/{int(r.invitesSent)}{r.inviteConversionPct !== null ? <span style={{ color: 'var(--text-muted)' }}> ({pct(r.inviteConversionPct)})</span> : null}</td>
                      <td className="tabular" style={{ textAlign: 'right', color: '#ff8a8e' }}>{int(r.left)}{r.leftPct !== null ? <span style={{ color: 'var(--text-muted)' }}> ({pct(r.leftPct)})</span> : null}</td>
                      <td className="tabular" style={{ textAlign: 'right' }}>{pct(r.retentionPct)}</td>
                      <RetentionCell v={r.d7} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Saídas e entradas pelo convite são vistas na hora (webhook da Evolution) e conferidas a cada 6 horas
            {data.lastCheck ? ` — última conferência ${new Date(data.lastCheck.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}.
            Só dá para contar quem tem o número visível: o WhatsApp esconde o número de alguns membros.
            {hiddenGroups.length > 0 && (
              <span style={{ color: 'var(--accent-warning)' }}> Grupos que não puderam ser conferidos: {hiddenGroups.map((g) => g.group).join(', ')}.</span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
