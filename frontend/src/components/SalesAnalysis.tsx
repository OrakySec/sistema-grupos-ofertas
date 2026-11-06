import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'
import api, { type SalesAnalysis as Data } from '../lib/api'
import { useToast } from '../lib/toast'
import Icon from './Icon'
import Modal from './Modal'
import { Skeleton } from './LoadingSkeleton'

/* Shopee sales analysis — Tráfego pago → Análise de vendas (api/src/lib/salesAnalysis.ts). */

const brl = (v: number | null | undefined) =>
  v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const int = (v: number) => v.toLocaleString('pt-BR')
const pct = (v: number | null | undefined, digits = 1) => (v == null ? '—' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: digits })}%`)
const fmtDate = (iso: string) => iso.split('-').reverse().join('/')

// Validated on the dark surface (#16161b): L 0.48–0.67, CVD ΔE 20.2.
const BLUE = '#3b8fe6'
const GREEN = '#1aae72'
const TOOLTIP = {
  contentStyle: { background: '#16161b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, fontSize: 12 },
  labelStyle: { color: '#a3a3ae', marginBottom: 2 },
  itemStyle: { color: '#f4f4f6' },
  cursor: { fill: 'rgba(255,255,255,0.04)' },
}
const AXIS = { tick: { fill: '#6e6e7a', fontSize: 11 }, axisLine: false, tickLine: false } as const
const STATUS_LABEL = { COMPLETED: 'Concluído', CANCELLED: 'Cancelado', PENDING: 'Pendente' } as const
const COOKIE_LABEL = ['Mesmo dia', '1 dia', '2 dias', '3 dias', '4 dias', '5 dias', '6 dias', '7 dias']
const ALL = '__all__'

function Panel({ title, hint, right, children }: { title: string; hint?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 600 }}>{title}</div>
            {hint && <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 2 }}>{hint}</div>}
          </div>
          {right}
        </div>
        {children}
      </div>
    </section>
  )
}

/** A thin inline bar (share of the biggest value in the table) next to a number. */
function Meter({ value, max }: { value: number; max: number }) {
  const w = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0
  return (
    <div style={{ height: 6, borderRadius: 4, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', minWidth: 60 }}>
      <div style={{ width: `${w}%`, height: '100%', borderRadius: 4, background: BLUE }} />
    </div>
  )
}

function Stat({ label, value, hint, big }: { label: string; value: string; hint?: string; big?: boolean }) {
  return (
    <div className="metric-card" style={{ '--metric-accent': BLUE } as React.CSSProperties}>
      <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{label}</div>
      <div className="tabular" style={{ fontSize: big ? '2rem' : '1.35rem', fontWeight: 700, marginTop: 4 }}>{value}</div>
      {hint && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

/* ─── Taxes ─── */
function TaxModal({ taxes, onClose, onSaved }: { taxes: Data['taxes']; onClose: () => void; onSaved: () => void }) {
  const { addToast } = useToast()
  const [meta, setMeta] = useState(String(taxes.metaTaxPct))
  const [rev, setRev] = useState(String(taxes.revenueTaxPct))
  const [busy, setBusy] = useState(false)
  const metaN = Number(meta.replace(',', '.'))
  const onAd = Number.isFinite(metaN) && metaN < 100 ? (100 / (100 - metaN) - 1) * 100 : null
  const save = async () => {
    setBusy(true)
    try {
      await api.saveAdTaxes({ metaTaxPct: metaN, revenueTaxPct: Number(rev.replace(',', '.')) })
      addToast('Impostos salvos', 'success'); onSaved(); onClose()
    } catch (err) { addToast(err instanceof Error ? err.message : 'Erro ao salvar', 'error') } finally { setBusy(false) }
  }
  return (
    <Modal isOpen onClose={onClose} title="Impostos" width={480}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancelar</button><button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? <span className="spinner spinner-sm" /> : null} Salvar</button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="label">Imposto da Meta (% do total da fatura)</label>
          <input className="input" inputMode="decimal" value={meta} onChange={(e) => setMeta(e.target.value)} style={{ maxWidth: 140 }} />
          <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
            Desde 01/01/2026 a Meta repassa PIS/Cofins (9,25%) + ISS (2,9%) = 12,15% do total da fatura{onAd != null ? `, o que dá +${onAd.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}% sobre o valor do anúncio` : ''} (R$ 100,00 de anúncio → R$ 113,83 pagos).
          </div>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="label">Seu imposto sobre o faturamento (%)</label>
          <input className="input" inputMode="decimal" value={rev} onChange={(e) => setRev(e.target.value)} style={{ maxWidth: 140 }} />
          <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 4 }}>Descontado da comissão quando "Com imposto" está ligado (ex.: Simples Nacional). 0 = não desconta.</div>
        </div>
      </div>
    </Modal>
  )
}

/* ─── Spend typed in by hand for a sub-ID ─── */
function SpendModal({ row, from, to, onClose, onSaved }: { row: Data['subIds'][number]; from: string; to: string; onClose: () => void; onSaved: () => void }) {
  const { addToast } = useToast()
  const [amount, setAmount] = useState('')
  const [start, setStart] = useState(from)
  const [end, setEnd] = useState(to)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await api.addManualSpend({ subCode: row.subCode, startDate: start, endDate: end, amount: Number(amount.replace(',', '.')) })
      addToast('Investimento adicionado', 'success'); onSaved(); onClose()
    } catch (err) { addToast(err instanceof Error ? err.message : 'Erro ao salvar', 'error') } finally { setBusy(false) }
  }
  const remove = async (id: string) => {
    try { await api.deleteManualSpend(id); addToast('Investimento removido', 'success'); onSaved(); onClose() } catch (err) { addToast(err instanceof Error ? err.message : 'Erro', 'error') }
  }
  return (
    <Modal isOpen onClose={onClose} title={`Investimento · ${row.label}`} width={500}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancelar</button><button className="btn btn-primary" onClick={save} disabled={busy || !amount}>{busy ? <span className="spinner spinner-sm" /> : null} Adicionar</button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Para o que não vem da Meta por aqui (outra conta, TikTok, post impulsionado…). O valor é dividido igualmente pelos dias do período.
          {row.metaSpend > 0 && <> Este sub-ID já tem <strong>{brl(row.metaSpend)}</strong> da Meta no período.</>}
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="label">Valor investido (sem imposto)</label>
          <input className="input" inputMode="decimal" placeholder="Ex.: 50,00" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ maxWidth: 160 }} autoFocus />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="input" type="date" value={start} max={end} onChange={(e) => e.target.value && setStart(e.target.value)} style={{ width: 'auto', colorScheme: 'dark' }} />
          <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>até</span>
          <input className="input" type="date" value={end} min={start} onChange={(e) => e.target.value && setEnd(e.target.value)} style={{ width: 'auto', colorScheme: 'dark' }} />
        </div>
        {row.manualEntries.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="label" style={{ marginBottom: 0 }}>Já lançados</div>
            {row.manualEntries.map((e) => (
              <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', gap: 8 }}>
                <span>{brl(e.amount)} · {fmtDate(e.startDate)} a {fmtDate(e.endDate)} <span style={{ color: 'var(--text-muted)' }}>({brl(e.inPeriod)} neste período)</span></span>
                <button className="btn btn-ghost btn-sm" style={{ color: '#ff8a8e' }} onClick={() => remove(e.id)}><Icon name="trash" size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

/* ─── Main ─── */
export default function SalesAnalysis({ from, to, reloadKey }: { from: string; to: string; reloadKey: number }) {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sub, setSub] = useState(ALL)
  const [subs, setSubs] = useState<Array<{ subCode: string; label: string }>>([])
  const [withTax, setWithTax] = useState(true)
  const [editTax, setEditTax] = useState(false)
  const [spendFor, setSpendFor] = useState<Data['subIds'][number] | null>(null)
  const [subFilter, setSubFilter] = useState('')
  const [allCats, setAllCats] = useState(false)
  const [investOverride, setInvestOverride] = useState<number | null>(null)
  const [receivedOverride, setReceivedOverride] = useState<number | null>(null)

  const load = useCallback(() => {
    setError(null)
    api.getSalesAnalysis(from, to, sub === ALL ? undefined : sub)
      .then((d) => {
        setData(d)
        if (sub === ALL) setSubs(d.subIds.map((s) => ({ subCode: s.subCode, label: s.label })))
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Erro ao carregar'))
  }, [from, to, sub])
  useEffect(() => { setData(null); load() }, [load, reloadKey])
  useEffect(() => { setInvestOverride(null); setReceivedOverride(null) }, [from, to, sub])

  // Taxes: Meta's on spend (share of the invoice), yours on the commission.
  const t = data?.taxes
  const spendOf = useCallback((v: number) => (withTax && t ? v / (1 - t.metaTaxPct / 100) : v), [withTax, t])
  const netOf = useCallback((v: number) => (withTax && t ? v * (1 - t.revenueTaxPct / 100) : v), [withTax, t])

  const subRows = useMemo(() => {
    if (!data) return []
    const q = subFilter.trim().toLowerCase()
    return data.subIds.filter((s) => !q || s.subCode.includes(q) || s.label.toLowerCase().includes(q))
  }, [data, subFilter])

  if (error) return <div className="alert alert-error"><div>{error}</div></div>
  if (!data) return <Skeleton height={420} borderRadius={14} />

  const s = data.summary
  const maxChannel = Math.max(0, ...data.channels.map((c) => c.commission))
  const maxCat = Math.max(0, ...data.categories.map((c) => c.commission))
  const maxBand = Math.max(0, ...data.priceBands.map((b) => b.commission))
  const cats = allCats ? data.categories : data.categories.slice(0, 15)
  const invested = investOverride ?? spendOf(data.investment.total)
  const received = receivedOverride ?? netOf(s.commission)
  const margin = received - invested
  const taxToggle = (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <div className="tabs">
        <button className={`tab${!withTax ? ' active' : ''}`} onClick={() => setWithTax(false)}>Sem imposto</button>
        <button className={`tab${withTax ? ' active' : ''}`} onClick={() => setWithTax(true)}>Com imposto</button>
      </div>
      <button className="btn btn-ghost btn-sm" onClick={() => setEditTax(true)} title="Configurar impostos"><Icon name="settings" size={15} /></button>
    </div>
  )
  const editNumber = (label: string, current: number, set: (v: number | null) => void) => {
    const v = prompt(`${label} (R$) — deixe vazio para voltar ao valor calculado`, current.toFixed(2).replace('.', ','))
    if (v === null) return
    const n = Number(v.replace(/\./g, '').replace(',', '.'))
    set(v.trim() === '' || !Number.isFinite(n) ? null : n)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Sub-ID</span>
          <select className="input" value={sub} onChange={(e) => setSub(e.target.value)} style={{ width: 'auto', minWidth: 200 }}>
            <option value={ALL}>Todos</option>
            {subs.map((o) => <option key={o.subCode} value={o.subCode}>{o.subCode ? `${o.label}${o.label !== o.subCode ? ` (${o.subCode})` : ''}` : 'Sem sub-ID'}</option>)}
          </select>
        </div>
        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
          {fmtDate(data.from)} a {fmtDate(data.to)} · {data.days} {data.days === 1 ? 'dia' : 'dias'} · pendentes + concluídos
          {data.lastSync?.fields && <span style={{ color: 'var(--accent-warning)' }}> · a Shopee não enviou: {data.lastSync.fields.replace(/^sem /, '')}</span>}
        </div>
      </div>

      {!data.hasItemDetail && s.orders > 0 && (
        <div className="alert alert-info" style={{ fontSize: '0.8rem' }}>
          <div>Categoria, produto, canal e direta/indireta aparecem depois da próxima sincronização com a Shopee (até 1 hora, ou "Sincronizar agora"). Na primeira vez o sistema busca os últimos 90 dias.</div>
        </div>
      )}

      {/* Headline */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
        <Stat big label="Comissão líquida" value={brl(netOf(s.commission))} hint={`Média por dia: ${brl(netOf(s.commissionPerDay))}${withTax && t?.revenueTaxPct ? ` · já sem ${pct(t.revenueTaxPct)} de imposto` : ''}`} />
        <Stat label="Total de pedidos" value={int(s.orders)} hint={`Média por dia: ${s.ordersPerDay.toLocaleString('pt-BR')} · ${brl(s.commissionPerOrder)} por pedido`} />
        <Stat label="Total em vendas" value={brl(s.gmv)} hint={`Média por dia: ${brl(s.gmvPerDay)} · valor dos pedidos, não a comissão`} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(360px, 100%), 1fr))', gap: 14 }}>
        <Panel title="Status dos pedidos">
          <div className="table-wrapper"><table>
            <thead><tr><th>Status</th><th style={{ textAlign: 'right' }}>Pedidos</th><th style={{ textAlign: 'right' }}>Comissão</th></tr></thead>
            <tbody>{data.status.map((r) => (
              <tr key={r.status}><td className="primary">{STATUS_LABEL[r.status]}</td><td className="tabular" style={{ textAlign: 'right' }}>{int(r.orders)}</td><td className="tabular" style={{ textAlign: 'right' }}>{brl(r.commission)}</td></tr>
            ))}</tbody>
          </table></div>
        </Panel>

        <Panel title="Pedidos diretos e indiretos" hint="Diretas: o próprio produto ou a mesma loja do link. Indiretas: a pessoa clicou e comprou outra coisa.">
          <div className="table-wrapper"><table>
            <thead><tr><th>Tipo</th><th style={{ textAlign: 'right' }}>Pedidos</th><th style={{ textAlign: 'right' }}>Comissão</th></tr></thead>
            <tbody>
              {([['Diretas', data.attribution.direct], ['Indiretas', data.attribution.indirect], ...(data.attribution.unknown.orders ? [['Sem informação', data.attribution.unknown] as const] : [])] as const).map(([l, r]) => (
                <tr key={l}><td className="primary">{l}</td><td className="tabular" style={{ textAlign: 'right' }}>{int(r.orders)}</td><td className="tabular" style={{ textAlign: 'right' }}>{brl(r.commission)}</td></tr>
              ))}
            </tbody>
          </table></div>
        </Panel>

        <Panel title="Pedidos por canal" hint="De onde veio o clique, segundo a Shopee.">
          <div className="table-wrapper"><table>
            <thead><tr><th>Canal</th><th style={{ textAlign: 'right' }}>Pedidos</th><th style={{ textAlign: 'right' }}>Comissão</th><th style={{ width: 90 }} /></tr></thead>
            <tbody>{data.channels.length === 0 ? (
              <tr><td colSpan={4} style={{ color: 'var(--text-muted)', textAlign: 'center' }}>Sem vendas no período.</td></tr>
            ) : data.channels.map((r) => (
              <tr key={r.channel}><td className="primary">{r.channel}</td><td className="tabular" style={{ textAlign: 'right' }}>{int(r.orders)}</td><td className="tabular" style={{ textAlign: 'right' }}>{brl(r.commission)}</td><td><Meter value={r.commission} max={maxChannel} /></td></tr>
            ))}</tbody>
          </table></div>
        </Panel>

        <Panel title="Comissão da Shopee × do vendedor" hint="A do vendedor é a comissão extra que a loja paga em cima da Shopee.">
          {!data.split || data.split.shopee + data.split.seller <= 0 ? (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>A Shopee não informou a divisão para estas vendas.</div>
          ) : (() => {
            const total = data.split.shopee + data.split.seller
            const sp = (data.split.shopee / total) * 100
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', height: 14, borderRadius: 4, overflow: 'hidden', gap: 2 }} title={`Shopee ${pct(sp)} · Vendedor ${pct(100 - sp)}`}>
                  <div style={{ width: `${sp}%`, background: BLUE }} />
                  <div style={{ flex: 1, background: GREEN }} />
                </div>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: '0.84rem' }}>
                  <div><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: BLUE, marginRight: 6 }} />Shopee: <strong>{brl(data.split.shopee)}</strong> <span style={{ color: 'var(--text-muted)' }}>({pct(sp)})</span></div>
                  <div><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: GREEN, marginRight: 6 }} />Vendedor: <strong>{brl(data.split.seller)}</strong> <span style={{ color: 'var(--text-muted)' }}>({pct(100 - sp)})</span></div>
                </div>
              </div>
            )
          })()}
        </Panel>
      </div>

      <Panel title="Média de pedidos por hora" hint="Pedidos em cada hora do dia (Brasília) divididos pelos dias do período — bom para saber quando o anúncio mais converte.">
        <div style={{ height: 220 }}>
          <ResponsiveContainer>
            <BarChart data={data.hourly.map((h) => ({ ...h, label: `${String(h.hour).padStart(2, '0')}h` }))} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="label" {...AXIS} interval={1} />
              <YAxis {...AXIS} allowDecimals />
              <Tooltip {...TOOLTIP} formatter={(v, _n, p: any) => [`${Number(v).toLocaleString('pt-BR')} por dia (${p.payload.orders} no total)`, 'Pedidos']} />
              <Bar dataKey="avg" name="Pedidos" fill={BLUE} radius={[4, 4, 0, 0]} maxBarSize={22} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <Panel title="Vendas por dia de cookie" hint="Dias entre o clique e o pedido — o cookie da Shopee dura 7 dias. O que cai no &quot;mesmo dia&quot; é o que paga o anúncio no dia 1.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10 }}>
          {data.cookieDays.map((c) => (
            <div key={c.day} style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{COOKIE_LABEL[c.day]} · {pct(c.share, 0)}</div>
              <div className="tabular" style={{ fontWeight: 600 }}>{brl(c.commission)}</div>
              <Meter value={c.share} max={100} />
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{int(c.orders)} {c.orders === 1 ? 'pedido' : 'pedidos'}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>% = parte da comissão do período (das vendas em que a Shopee informou o horário do clique).</div>
      </Panel>

      <Panel title="Comissão por faixa de preço" hint="Quanto cada faixa de preço do produto rendeu por pedido e quanto disso entrou no mesmo dia do clique — para ver se a regra dos produtos de R$ 20–30 vale para o seu público.">
        <div className="table-wrapper"><table>
          <thead><tr><th>Faixa</th><th style={{ textAlign: 'right' }}>Pedidos</th><th style={{ textAlign: 'right' }}>Comissão</th><th style={{ textAlign: 'right' }}>Por pedido</th><th style={{ textAlign: 'right' }}>No mesmo dia</th><th style={{ width: 110 }}>% da comissão</th></tr></thead>
          <tbody>{data.priceBands.map((b) => (
            <tr key={b.label} style={b.label === 'R$ 20–30' ? { background: 'rgba(59,143,230,0.06)' } : undefined}>
              <td className="primary">{b.label}</td>
              <td className="tabular" style={{ textAlign: 'right' }}>{int(b.orders)}</td>
              <td className="tabular" style={{ textAlign: 'right' }}>{brl(b.commission)}</td>
              <td className="tabular" style={{ textAlign: 'right' }}>{brl(b.perOrder)}</td>
              <td className="tabular" style={{ textAlign: 'right' }}>{pct(b.sameDayShare, 0)}</td>
              <td><div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Meter value={b.commission} max={maxBand} /><span className="tabular" style={{ fontSize: '0.74rem', color: 'var(--text-muted)', minWidth: 36 }}>{pct(b.shareOfCommission, 0)}</span></div></td>
            </tr>
          ))}</tbody>
        </table></div>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Pelo preço unitário de cada item. Um pedido com itens de faixas diferentes conta em cada uma.</div>
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gap: 14 }}>
        <Panel title="Pedidos por categoria" right={data.categories.length > 15 ? <button className="btn btn-ghost btn-sm" onClick={() => setAllCats((v) => !v)}>{allCats ? 'Ver menos' : `Ver todas (${data.categories.length})`}</button> : undefined}>
          <div className="table-wrapper"><table>
            <thead><tr><th>Categoria</th><th style={{ textAlign: 'right' }}>Pedidos</th><th style={{ textAlign: 'right' }}>Comissão</th><th style={{ width: 80 }} /></tr></thead>
            <tbody>{cats.length === 0 ? (
              <tr><td colSpan={4} style={{ color: 'var(--text-muted)', textAlign: 'center' }}>Sem vendas no período.</td></tr>
            ) : cats.map((r) => (
              <tr key={r.category}><td className="primary">{r.category}</td><td className="tabular" style={{ textAlign: 'right' }}>{int(r.orders)}</td><td className="tabular" style={{ textAlign: 'right' }}>{brl(r.commission)}</td><td><Meter value={r.commission} max={maxCat} /></td></tr>
            ))}</tbody>
          </table></div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Um pedido com itens de categorias diferentes conta em cada uma.</div>
        </Panel>

        <Panel title="Top 15 produtos por comissão">
          {data.topProducts.length === 0 ? (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Sem produtos no período.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {data.topProducts.map((p, i) => (
                <div key={`${p.shopId}-${p.itemId}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {p.image
                    ? <img src={p.image} alt="" width={36} height={36} loading="lazy" style={{ borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: '#fff' }} />
                    : <div style={{ width: 36, height: 36, borderRadius: 6, background: 'rgba(255,255,255,0.06)', flexShrink: 0 }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.name}>
                      {p.link ? <a href={p.link} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>{p.name} <Icon name="link" size={11} /></a> : p.name}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{int(p.orders)} {p.orders === 1 ? 'pedido' : 'pedidos'}</div>
                  </div>
                  <div className="tabular" style={{ fontWeight: 600, fontSize: '0.84rem' }}>{brl(p.commission)}</div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Pedidos e comissões por sub-ID" right={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="input" placeholder="Filtrar sub-ID…" value={subFilter} onChange={(e) => setSubFilter(e.target.value)} style={{ width: 170 }} />
          {taxToggle}
        </div>
      }>
        <div className="table-wrapper"><table>
          <thead><tr>
            <th>Sub-ID</th><th style={{ textAlign: 'right' }}>Pedidos</th><th style={{ textAlign: 'right' }}>Comissão</th>
            <th style={{ textAlign: 'right' }}>Investimento</th><th style={{ textAlign: 'right' }}>Margem</th><th style={{ textAlign: 'right' }}>ROAS / ROI</th>
          </tr></thead>
          <tbody>{subRows.length === 0 ? (
            <tr><td colSpan={6} style={{ color: 'var(--text-muted)', textAlign: 'center' }}>Nada no período.</td></tr>
          ) : subRows.map((r) => {
            const spentRaw = r.metaSpend + r.manualSpend
            const spent = spendOf(spentRaw)
            const net = netOf(r.commission)
            const m = net - spent
            return (
              <tr key={r.subCode || '(none)'}>
                <td className="primary">
                  {r.subCode ? r.label : 'Sem sub-ID'}
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{r.source}{r.subCode && r.label !== r.subCode ? ` · ${r.subCode}` : ''} · vendas {brl(r.gmv)}</div>
                </td>
                <td className="tabular" style={{ textAlign: 'right' }}>{int(r.orders)}<div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{r.orders ? `${brl(net / r.orders)} / pedido` : ''}</div></td>
                <td className="tabular" style={{ textAlign: 'right' }}>{brl(net)}<div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>dir. {brl(netOf(r.direct))} · ind. {brl(netOf(r.indirect))}</div></td>
                <td className="tabular" style={{ textAlign: 'right' }}>
                  {spentRaw > 0 ? <>{brl(spent)}<div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{r.orders ? `CPA ${brl(spent / r.orders)}` : 'sem venda'}</div></> : null}
                  {r.subCode && <button className="btn btn-ghost btn-sm" style={{ padding: '2px 6px', fontSize: '0.72rem' }} onClick={() => setSpendFor(r)}>{spentRaw > 0 ? '+ manual' : '+ Add'}</button>}
                </td>
                <td className="tabular" style={{ textAlign: 'right', color: spentRaw > 0 ? (m >= 0 ? 'var(--accent-success)' : '#ff8a8e') : 'var(--text-muted)' }}>{spentRaw > 0 ? brl(m) : '—'}</td>
                <td className="tabular" style={{ textAlign: 'right' }}>{spentRaw > 0 ? <>{(net / spent).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}x<div style={{ fontSize: '0.72rem', color: m >= 0 ? 'var(--accent-success)' : '#ff8a8e' }}>{pct((m / spent) * 100)}</div></> : '—'}</td>
              </tr>
            )
          })}</tbody>
        </table></div>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Investimento: gasto na Meta dos anúncios com link do sistema (sub-ID = código do link) + o que você lançou em "+ Add".
          {t && <> Com imposto: gasto × {(1 / (1 - t.metaTaxPct / 100)).toLocaleString('pt-BR', { maximumFractionDigits: 4 })} (Meta {pct(t.metaTaxPct, 2)} da fatura){t.revenueTaxPct ? ` e comissão − ${pct(t.revenueTaxPct, 2)}` : ''}.</>}
        </div>
      </Panel>

      <Panel title="Análise de investimento" hint="Calculadora simples do retorno do período — considera o gasto de todas as campanhas das contas de anúncio, não só as da Shopee." right={taxToggle}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <div className="metric-card">
            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>Valor total investido <button className="btn btn-ghost btn-sm" style={{ padding: 0 }} onClick={() => editNumber('Valor total investido', invested, setInvestOverride)} title="Editar"><Icon name="settings" size={13} /></button></div>
            <div className="tabular" style={{ fontSize: '1.35rem', fontWeight: 700, marginTop: 4 }}>{brl(invested)}</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{investOverride != null ? 'valor digitado por você' : `Meta ${brl(spendOf(data.investment.metaSpend))}${data.investment.manualSpend ? ` + manual ${brl(spendOf(data.investment.manualSpend))}` : ''}`}</div>
          </div>
          <div className="metric-card">
            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>Valor total recebido <button className="btn btn-ghost btn-sm" style={{ padding: 0 }} onClick={() => editNumber('Valor total recebido', received, setReceivedOverride)} title="Editar"><Icon name="settings" size={13} /></button></div>
            <div className="tabular" style={{ fontSize: '1.35rem', fontWeight: 700, marginTop: 4 }}>{brl(received)}</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{receivedOverride != null ? 'valor digitado por você' : 'comissão do período'}</div>
          </div>
          <div className="metric-card" style={{ '--metric-accent': margin >= 0 ? GREEN : '#f2555a' } as React.CSSProperties}>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Margem líquida</div>
            <div className="tabular" style={{ fontSize: '1.35rem', fontWeight: 700, marginTop: 4, color: margin >= 0 ? 'var(--accent-success)' : '#ff8a8e' }}>{brl(margin)}</div>
          </div>
          <div className="metric-card" style={{ '--metric-accent': margin >= 0 ? GREEN : '#f2555a' } as React.CSSProperties}>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>ROI</div>
            <div className="tabular" style={{ fontSize: '1.35rem', fontWeight: 700, marginTop: 4, color: margin >= 0 ? 'var(--accent-success)' : '#ff8a8e' }}>{invested > 0 ? pct((margin / invested) * 100) : '—'}</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{invested > 0 ? `ROAS ${(received / invested).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}x` : ''}</div>
          </div>
        </div>
      </Panel>

      {editTax && data.taxes && <TaxModal taxes={data.taxes} onClose={() => setEditTax(false)} onSaved={load} />}
      {spendFor && <SpendModal row={spendFor} from={from} to={to} onClose={() => setSpendFor(null)} onSaved={load} />}
    </div>
  )
}
