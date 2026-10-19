import React, { useCallback, useEffect, useState } from 'react'
import api, { type AdLevel, type AdLinkItem, type AdMetrics, type AdRow, type AdsConfig, type MetaRule, type ShopeeSale } from '../lib/api'
import { useToast } from '../lib/toast'
import Icon from '../components/Icon'
import Modal from '../components/Modal'
import Toggle from '../components/Toggle'
import { Skeleton } from '../components/LoadingSkeleton'

type Tab = 'campaigns' | 'sales' | 'links' | 'history' | 'config'

const brl = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const int = (v: number) => v.toLocaleString('pt-BR')
const brtToday = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10)
const shiftDay = (ymd: string, n: number) => new Date(Date.parse(ymd + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10)
const ago = (iso?: string | null) => {
  if (!iso) return 'nunca'
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  return h < 24 ? `há ${h} h` : `há ${Math.floor(h / 24)} d`
}

const LEVEL_LABEL: Record<AdLevel, string> = { CAMPAIGN: 'Campanhas', ADSET: 'Conjuntos', AD: 'Anúncios' }
const STATUS_BADGE = (s: string) =>
  s === 'ACTIVE' ? <span className="badge badge-sent">Ativa</span>
    : s === 'PAUSED' || s.endsWith('_PAUSED') ? <span className="badge">Pausada</span>
    : <span className="badge" title={s}>{s.toLowerCase().replace(/_/g, ' ')}</span>

const profitColor = (v: number) => (v > 0 ? '#4fe0a4' : v < 0 ? '#ff8a8e' : 'var(--text-secondary)')

// ── Rule editor ─────────────────────────────────────────────────────────────

function RuleModal({ row, defaults, onClose, onSaved }: { row: AdRow; defaults: AdsConfig['ruleDefaults']; onClose: () => void; onSaved: () => void }) {
  const { addToast } = useToast()
  const base = row.rule ?? ({ ...defaults, enabled: true } as Partial<MetaRule>)
  const [r, setR] = useState({
    enabled: base.enabled ?? true,
    maxCpc: base.maxCpc ?? defaults.maxCpc,
    days: base.days ?? defaults.days,
    mode: base.mode ?? defaults.mode,
    minSpend: base.minSpend ?? defaults.minSpend,
    action: base.action ?? defaults.action,
  })
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      await api.saveAdRule(row.id, r)
      addToast('Regra salva', 'success')
      onSaved()
      onClose()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao salvar', 'error')
    } finally {
      setSaving(false)
    }
  }
  const levelName = row.level === 'CAMPAIGN' ? 'a campanha' : row.level === 'ADSET' ? 'o conjunto' : 'o anúncio'
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Regra · ${row.name}`}
      width={520}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? <span className="spinner spinner-sm" /> : <Icon name="check" />} Salvar</button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Toggle checked={r.enabled} onChange={(v) => setR({ ...r, enabled: v })} label="Monitorar" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Custo por clique no link acima de</label>
            <input className="input" type="number" step="0.01" value={r.maxCpc} onChange={(e) => setR({ ...r, maxCpc: Number(e.target.value) })} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Por quantos dias</label>
            <input className="input" type="number" min={1} max={30} value={r.days} onChange={(e) => setR({ ...r, days: Number(e.target.value) })} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Como contar os dias</label>
            <select className="select" value={r.mode} onChange={(e) => setR({ ...r, mode: e.target.value as MetaRule['mode'] })}>
              <option value="CONSECUTIVE">Dias seguidos (cada dia acima)</option>
              <option value="AVERAGE">Média dos dias</option>
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Gasto mínimo por dia p/ contar</label>
            <input className="input" type="number" step="1" value={r.minSpend} onChange={(e) => setR({ ...r, minSpend: Number(e.target.value) })} />
          </div>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="label">Quando passar do limite</label>
          <div className="tabs">
            <button className={`tab${r.action === 'NOTIFY' ? ' active' : ''}`} onClick={() => setR({ ...r, action: 'NOTIFY' })}><Icon name="message" size={15} /> Só avisar</button>
            <button className={`tab${r.action === 'PAUSE' ? ' active' : ''}`} onClick={() => setR({ ...r, action: 'PAUSE' })}><Icon name="pause" size={15} /> Pausar e avisar</button>
          </div>
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.55, padding: '10px 12px', borderRadius: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}>
          {r.action === 'PAUSE' ? 'Pausa' : 'Avisa sobre'} {levelName} se o custo por clique no link da Meta passar de <strong>{brl(r.maxCpc)}</strong>{' '}
          {r.mode === 'CONSECUTIVE' ? <>em <strong>cada um</strong> dos últimos {r.days} dias completos</> : <>na <strong>média</strong> dos últimos {r.days} dias completos</>}
          , contando só dias com pelo menos {brl(r.minSpend)} gastos. O aviso vai para o número do Monitor de Link. O sistema nunca reativa sozinho.
        </div>
        {row.rule?.lastCheck && (
          <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
            Última verificação {ago(row.rule.lastCheck.at)}: {row.rule.lastCheck.skipped ?? row.rule.lastCheck.reason ?? '—'}
          </div>
        )}
      </div>
    </Modal>
  )
}

// ── Campaigns / ad sets / ads ───────────────────────────────────────────────

function MetricsCells({ m }: { m: AdMetrics }) {
  return (
    <>
      <td className="tabular" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{brl(m.spend)}</td>
      <td className="tabular" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{int(m.linkClicks)}{m.realClicks > 0 && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }} title="Cliques que chegaram ao nosso link vindos do anúncio (com fbclid), sem robôs">{int(m.realClicks)} do anúncio</div>}</td>
      <td className="tabular" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{brl(m.cpcLink)}</td>
      <td className="tabular" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{int(m.orders)}</td>
      <td className="tabular" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        {brl(m.commissionPending + m.commissionConfirmed)}
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{brl(m.commissionConfirmed)} confirm.</div>
      </td>
      <td className="tabular" style={{ textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600, color: profitColor(m.profitProjected) }}>
        {brl(m.profitProjected)}
        <div style={{ fontSize: '0.7rem', fontWeight: 400, color: profitColor(m.profitConfirmed) }}>{brl(m.profitConfirmed)} confirm.</div>
      </td>
      <td className="tabular" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{m.roas === null ? '—' : `${m.roas.toLocaleString('pt-BR')}x`}</td>
    </>
  )
}

function CampaignPicker({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { addToast } = useToast()
  const [filter, setFilter] = useState('')
  const [rows, setRows] = useState<Array<{ id: string; name: string; status: string; shown: boolean | null; visible: boolean }> | null>(null)
  const [choice, setChoice] = useState<Record<string, boolean | null>>({})
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    api.getCampaignVisibility().then((d) => {
      setFilter(d.filter)
      setRows(d.campaigns)
      setChoice(Object.fromEntries(d.campaigns.map((c) => [c.id, c.shown])))
    }).catch(() => setRows([]))
  }, [])

  const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const terms = filter.split(',').map((t) => fold(t.trim())).filter(Boolean)
  const effective = (c: { id: string; name: string }) => {
    const v = choice[c.id]
    if (v === true || v === false) return v
    return terms.length === 0 || terms.some((t) => fold(c.name).includes(t))
  }
  const visibleCount = (rows ?? []).filter(effective).length
  const shownRows = (rows ?? []).filter((c) => !search || fold(c.name).includes(fold(search)))

  const save = async () => {
    setSaving(true)
    try {
      await api.saveCampaignVisibility({ filter, shown: choice })
      addToast('Campanhas atualizadas', 'success')
      onSaved()
      onClose()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao salvar', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Escolher campanhas"
      width={640}
      footer={
        <>
          <span style={{ marginRight: 'auto', fontSize: '0.8rem', color: 'var(--text-muted)' }}>{visibleCount} de {rows?.length ?? 0} aparecendo</span>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !rows}>{saving ? <span className="spinner spinner-sm" /> : <Icon name="check" />} Salvar</button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="label">Mostrar automaticamente campanhas com este texto no nome</label>
          <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="ex.: SHOPEE, TRAFEGO DIRETO  (vazio = mostrar todas)" />
          <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 6 }}>
            Separe por vírgula. Vale também para campanhas novas. A escolha manual abaixo tem prioridade sobre o filtro.
          </div>
        </div>
        <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Procurar na lista…" />
        {!rows ? <Skeleton height={160} /> : rows.length === 0 ? (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Nenhuma campanha sincronizada ainda.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 360, overflowY: 'auto' }}>
            {shownRows.map((c) => {
              const v = choice[c.id]
              const on = effective(c)
              return (
                <div key={c.id} className="list-row" style={{ padding: '8px 4px' }}>
                  <input type="checkbox" checked={on} onChange={(e) => setChoice({ ...choice, [c.id]: e.target.checked })} style={{ accentColor: 'var(--accent-primary)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="truncate" style={{ fontSize: '0.85rem', color: on ? 'var(--text-primary)' : 'var(--text-muted)' }}>{c.name}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      {c.status === 'ACTIVE' ? 'ativa' : c.status.toLowerCase().replace(/_/g, ' ')} · {v === null || v === undefined ? 'pelo filtro' : 'escolha manual'}
                    </div>
                  </div>
                  {(v === true || v === false) && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setChoice({ ...choice, [c.id]: null })} title="Voltar a seguir o filtro por nome">usar filtro</button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Modal>
  )
}

function CampaignsTab({ from, to, config, reloadKey }: { from: string; to: string; config: AdsConfig; reloadKey: number }) {
  const { addToast } = useToast()
  const [level, setLevel] = useState<AdLevel>('CAMPAIGN')
  const [trail, setTrail] = useState<Array<{ id: string; name: string; level: AdLevel }>>([])
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getAdsOverview>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<AdRow | null>(null)
  const [picking, setPicking] = useState(false)
  const parent = trail[trail.length - 1]

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.getAdsOverview({ level, parentId: parent?.id, from, to }))
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao carregar', 'error')
    } finally {
      setLoading(false)
    }
  }, [level, parent?.id, from, to, addToast])
  useEffect(() => { load() }, [load, reloadKey])

  const drill = (row: AdRow) => {
    if (row.level === 'AD') return
    setTrail([...trail, { id: row.id, name: row.name, level: row.level }])
    setLevel(row.level === 'CAMPAIGN' ? 'ADSET' : 'AD')
  }
  const goLevel = (l: AdLevel) => { setTrail([]); setLevel(l) }
  const goTrail = (i: number) => {
    const t = trail.slice(0, i + 1)
    setTrail(t)
    setLevel(t[t.length - 1].level === 'CAMPAIGN' ? 'ADSET' : 'AD')
  }
  const toggleMonitor = async (row: AdRow, enabled: boolean) => {
    try {
      await api.saveAdRule(row.id, row.rule ? { enabled } : { ...config.ruleDefaults, enabled })
      await load()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro', 'error')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="tabs">
          {(['CAMPAIGN', 'ADSET', 'AD'] as AdLevel[]).map((l) => (
            <button key={l} className={`tab${level === l && trail.length === 0 ? ' active' : ''}`} onClick={() => goLevel(l)}>{LEVEL_LABEL[l]}</button>
          ))}
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => setPicking(true)} title="Escolher quais campanhas aparecem aqui">
          <Icon name="target" /> Escolher campanhas
        </button>
        {trail.length > 0 && (
          <div className="breadcrumb" style={{ fontSize: '0.82rem' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => goLevel('CAMPAIGN')}>Todas</button>
            {trail.map((t, i) => (
              <React.Fragment key={t.id}>
                <Icon name="chevronRight" />
                <button className="btn btn-ghost btn-sm" onClick={() => goTrail(i)} style={{ maxWidth: 260 }}><span className="truncate">{t.name}</span></button>
              </React.Fragment>
            ))}
            <Icon name="chevronRight" />
            <strong>{LEVEL_LABEL[level]}</strong>
          </div>
        )}
      </div>

      {loading && !data ? (
        <Skeleton height={300} borderRadius={14} />
      ) : !data || data.rows.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon"><Icon name="target" size={24} /></span>
          <span className="empty-state-title">Nada por aqui ainda</span>
          <span className="empty-state-desc">Configure o token da Meta na aba Configuração e clique em "Sincronizar agora". Se já sincronizou, confira em "Escolher campanhas" quais estão aparecendo.</span>
        </div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th style={{ width: 70 }}>Monitorar</th>
                <th>{LEVEL_LABEL[level].slice(0, -1)}</th>
                <th style={{ textAlign: 'right' }}>Gasto</th>
                <th style={{ textAlign: 'right' }}>Cliques no link</th>
                <th style={{ textAlign: 'right' }}>Custo/clique</th>
                <th style={{ textAlign: 'right' }}>Vendas</th>
                <th style={{ textAlign: 'right' }}>Comissão</th>
                <th style={{ textAlign: 'right' }}>Lucro</th>
                <th style={{ textAlign: 'right' }}>ROAS</th>
                <th>Regra</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => {
                const rule = row.rule
                const breach = rule?.enabled && rule.lastCheck?.breach
                return (
                  <tr key={row.id}>
                    <td><Toggle checked={!!rule?.enabled} onChange={(v) => toggleMonitor(row, v)} /></td>
                    <td className="primary" style={{ maxWidth: 320 }}>
                      <button onClick={() => drill(row)} style={{ textAlign: 'left', color: 'inherit', cursor: row.level === 'AD' ? 'default' : 'pointer' }} title={row.level === 'AD' ? row.name : `Ver ${row.level === 'CAMPAIGN' ? 'conjuntos' : 'anúncios'}`}>
                        <div className="truncate">{row.name}</div>
                      </button>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 3 }}>
                        {STATUS_BADGE(row.status)}
                        {row.level !== 'AD' && <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{row.children} {row.level === 'CAMPAIGN' ? 'conjuntos' : 'anúncios'}</span>}
                        {row.level === 'AD' && !row.links && <span className="badge badge-pending" title="Sem link com código — as vendas deste anúncio não aparecem">sem link</span>}
                      </div>
                    </td>
                    <MetricsCells m={row.metrics} />
                    <td>
                      <button className={`btn btn-sm ${breach ? 'btn-danger' : 'btn-ghost'}`} onClick={() => setEditing(row)}>
                        {rule?.enabled ? `${rule.action === 'PAUSE' ? 'Pausar' : 'Avisar'} > ${brl(rule.maxCpc)} · ${rule.days}d` : 'Configurar'}
                      </button>
                    </td>
                  </tr>
                )
              })}
              <tr style={{ background: 'rgba(255,255,255,0.025)' }}>
                <td></td>
                <td className="primary">Total</td>
                <MetricsCells m={data.totals} />
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Comissão e lucro "previstos" incluem vendas pendentes; "confirm." só as que a Shopee já concluiu (cancelamentos ficam de fora).
        Para as vendas aparecerem num anúncio, ele precisa usar um link criado na aba <strong>Links de anúncio</strong>.
      </div>
      {editing && <RuleModal row={editing} defaults={config.ruleDefaults} onClose={() => setEditing(null)} onSaved={load} />}
      {picking && <CampaignPicker onClose={() => setPicking(false)} onSaved={load} />}
    </div>
  )
}

// ── Sales by sub-ID ─────────────────────────────────────────────────────────

function RawSales({ reloadKey }: { reloadKey: number }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getAdSalesRaw>> | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => { if (open) api.getAdSalesRaw().then(setData).catch(() => setData({ lastSync: null, rows: [] })) }, [open, reloadKey])
  const fmt = (v: string | null) => (v ? new Date(v).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—')
  return (
    <section className="panel">
      <button className="panel-header" style={{ width: '100%', textAlign: 'left' }} onClick={() => setOpen(!open)}>
        <div className="panel-title"><Icon name="activity" size={16} style={{ color: 'var(--text-accent)' }} />Dados brutos das últimas vendas</div>
        <span className="panel-meta">{open ? 'fechar' : 'conferir o que a Shopee devolve (ex.: horário do clique)'}</span>
      </button>
      {open && (
        !data ? <div className="panel-body"><Skeleton height={80} /></div> : data.rows.length === 0 ? (
          <div className="panel-body" style={{ fontSize: '0.84rem', color: 'var(--text-muted)' }}>
            Nenhuma venda importada ainda.{data.lastSync?.error ? ` Último erro da sincronização: ${data.lastSync.error}` : ''}
          </div>
        ) : (
          <div className="table-wrapper" style={{ border: 'none', borderRadius: 0, boxShadow: 'none' }}>
            <table>
              <thead><tr><th>Compra</th><th>Clique (clickTime)</th><th>Sub-ID</th><th>Status</th><th>Campos recebidos</th></tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="tabular">{fmt(r.purchaseTime)}</td>
                    <td className="tabular">{r.clickTime ? fmt(r.clickTime) : <span style={{ color: '#ff8a8e' }}>vazio{r.rawClickTime !== null ? ` (${JSON.stringify(r.rawClickTime)})` : ''}</span>}</td>
                    <td className="mono">{r.utmContent || '—'}</td>
                    <td>{r.status}</td>
                    <td style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{r.fields.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </section>
  )
}

const SALE_STATUS: Record<string, [string, string]> = {
  PENDING: ['Pendente', 'badge-pending'],
  UNPAID: ['Não pago', 'badge-pending'],
  COMPLETED: ['Concluída', 'badge-sent'],
  CANCELLED: ['Cancelada', 'badge-failed'],
  MIXED: ['Mista', ''],
}

const PURCHASE_TAG: Record<string, [string, string]> = {
  SENT: ['Compra enviada à Meta', '#4fe0a4'],
  FAILED: ['Meta recusou a compra', '#ff8a8e'],
  NO_MATCH: ['Sem clique para enviar', 'var(--text-muted)'],
  TOO_OLD: ['Antiga demais p/ Meta', 'var(--text-muted)'],
  SKIPPED: ['Não enviada', 'var(--text-muted)'],
}

function PurchaseEventTag({ ev }: { ev: NonNullable<ShopeeSale['purchaseEvent']> }) {
  const [text, color] = PURCHASE_TAG[ev.status] ?? [ev.status, 'var(--text-muted)']
  return <div style={{ fontSize: '0.68rem', color, marginTop: 4, whiteSpace: 'nowrap', cursor: 'help' }} title={ev.detail ?? ''}>{text}</div>
}

function AllSales({ from, to, reloadKey }: { from: string; to: string; reloadKey: number }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getAdSalesList>> | null>(null)
  const [q, setQ] = useState('')
  const [source, setSource] = useState('')
  useEffect(() => { setData(null); api.getAdSalesList(from, to).then(setData).catch(() => setData({ truncated: false, rows: [] })) }, [from, to, reloadKey])
  if (!data) return <Skeleton height={260} borderRadius={14} />
  const term = q.trim().toLowerCase()
  const rows = data.rows.filter((r) =>
    (!source || r.source === source) &&
    (!term || [r.utmContent, r.subCode, r.label, ...r.products, ...r.orderIds].some((v) => v && v.toLowerCase().includes(term))))
  const sum = rows.reduce((a, r) => ({ gmv: a.gmv + r.gmv, pending: a.pending + r.pending, confirmed: a.confirmed + r.confirmed }), { gmv: 0, pending: 0, confirmed: 0 })
  const sources = [...new Set(data.rows.map((r) => r.source))]
  const fmt = (v: string) => new Date(v).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input className="input" placeholder="Buscar sub-ID, produto ou nº do pedido" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
        <select className="select" value={source} onChange={(e) => setSource(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">Todas as origens</option>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          {int(rows.length)} {rows.length === 1 ? 'venda' : 'vendas'} · vendido {brl(sum.gmv)} · comissão {brl(sum.pending + sum.confirmed)}
          {data.truncated ? ' · mostrando as 2.000 mais recentes' : ''}
        </span>
      </div>
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Compra</th><th>Sub-ID</th><th>Origem</th><th>Produto</th>
              <th style={{ textAlign: 'right' }}>Vendido</th><th style={{ textAlign: 'right' }}>Comissão</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 28, color: 'var(--text-muted)' }}>Nenhuma venda {data.rows.length ? 'com esse filtro' : 'no período'}.</td></tr>
            ) : rows.map((r) => {
              const [label, cls] = SALE_STATUS[r.status] ?? [r.status, '']
              const commission = r.status === 'CANCELLED' || r.fraud ? r.cancelled : r.pending + r.confirmed
              return (
                <tr key={r.id}>
                  <td className="tabular" style={{ whiteSpace: 'nowrap' }}>
                    {fmt(r.purchaseTime)}
                    {r.clickTime && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }} title="Horário do clique no link">clique {fmt(r.clickTime)}</div>}
                  </td>
                  <td className="mono" style={{ wordBreak: 'break-all' }}>{r.utmContent || '—'}</td>
                  <td>{r.source}{r.label && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{r.label}</div>}</td>
                  <td style={{ fontSize: '0.8rem', maxWidth: 320 }}>
                    {r.products.length ? r.products.join(' · ') : <span style={{ color: 'var(--text-muted)' }}>{int(r.items)} {r.items === 1 ? 'item' : 'itens'}</span>}
                    {r.orderIds.length > 0 && <div className="mono" style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>pedido {r.orderIds.join(', ')}</div>}
                  </td>
                  <td className="tabular" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{brl(r.gmv)}</td>
                  <td className="tabular" style={{ textAlign: 'right', whiteSpace: 'nowrap', color: r.status === 'COMPLETED' ? '#4fe0a4' : r.status === 'CANCELLED' || r.fraud ? 'var(--text-muted)' : undefined, textDecoration: r.status === 'CANCELLED' || r.fraud ? 'line-through' : undefined }}>{brl(commission)}</td>
                  <td>
                    <span className={`badge ${cls}`}>{r.fraud ? 'Fraude' : label}</span>
                    {r.purchaseEvent && <PurchaseEventTag ev={r.purchaseEvent} />}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SalesTab({ from, to, reloadKey }: { from: string; to: string; reloadKey: number }) {
  const [view, setView] = useState<'list' | 'grouped'>('list')
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.getAdSales>>['rows'] | null>(null)
  useEffect(() => { if (view !== 'grouped') return; setRows(null); api.getAdSales(from, to).then((d) => setRows(d.rows)).catch(() => setRows([])) }, [from, to, reloadKey, view])
  const switcher = (
    <div className="tabs" style={{ alignSelf: 'flex-start' }}>
      <button className={`tab${view === 'list' ? ' active' : ''}`} onClick={() => setView('list')}>Todas as vendas</button>
      <button className={`tab${view === 'grouped' ? ' active' : ''}`} onClick={() => setView('grouped')}>Por sub-ID</button>
    </div>
  )
  if (view === 'list') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {switcher}
        <AllSales from={from} to={to} reloadKey={reloadKey} />
        <RawSales reloadKey={reloadKey} />
      </div>
    )
  }
  if (!rows) return <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>{switcher}<Skeleton height={260} borderRadius={14} /></div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    {switcher}
    <div className="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>Origem</th><th>Sub-ID</th>
            <th style={{ textAlign: 'right' }}>Pedidos</th><th style={{ textAlign: 'right' }}>Vendido</th>
            <th style={{ textAlign: 'right' }}>Pendente</th><th style={{ textAlign: 'right' }}>Confirmada</th><th style={{ textAlign: 'right' }}>Cancelada</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={7} style={{ textAlign: 'center', padding: 28, color: 'var(--text-muted)' }}>Nenhuma venda no período (ou a sincronização com a Shopee ainda não rodou).</td></tr>
          ) : rows.map((r) => (
            <tr key={r.subCode}>
              <td className="primary">{r.label}<div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{r.source}</div></td>
              <td className="mono">{r.subCode || '—'}</td>
              <td className="tabular" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{int(r.orders)}</td>
              <td className="tabular" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{brl(r.gmv)}</td>
              <td className="tabular" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{brl(r.pending)}</td>
              <td className="tabular" style={{ textAlign: 'right', color: '#4fe0a4' }}>{brl(r.confirmed)}</td>
              <td className="tabular" style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{brl(r.cancelled)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </div>
  )
}

// ── Ad links ────────────────────────────────────────────────────────────────

function LinkClicksModal({ link, onClose }: { link: AdLinkItem; onClose: () => void }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.getAdLinkClicks>> | null>(null)
  useEffect(() => { api.getAdLinkClicks(link.id).then(setRows).catch(() => setRows([])) }, [link.id])
  const label = (r: { kind: string; fromAd: boolean; agent: string | null }) =>
    r.kind !== 'HUMAN' ? <span className="badge">{r.agent ?? 'robô'}</span>
      : r.fromAd ? <span className="badge badge-sent">Anúncio</span>
      : <span className="badge badge-pending" title="Sem fbclid: revisão da Meta, teste manual ou link aberto fora do anúncio">Fora do anúncio</span>
  return (
    <Modal isOpen onClose={onClose} title={`Cliques · ${link.label || link.code}`} width={720}>
      {!rows ? <Skeleton height={120} /> : rows.length === 0 ? (
        <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Ninguém abriu este link ainda.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Só os marcados como <strong>Anúncio</strong> contam como clique e disparam o ViewContent. "Fora do anúncio" são aberturas sem o
            fbclid da Meta — normalmente a revisão do anúncio pela própria Meta ou testes seus.
          </div>
          <div className="table-wrapper">
            <table>
              <thead><tr><th>Quando</th><th>Tipo</th><th>Navegador</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="tabular" style={{ whiteSpace: 'nowrap' }}>{new Date(r.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                    <td>{label(r)}</td>
                    <td className="mono" style={{ fontSize: '0.7rem', wordBreak: 'break-all' }}>{r.userAgent ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  )
}

function LinksTab() {
  const { addToast } = useToast()
  const [links, setLinks] = useState<AdLinkItem[] | null>(null)
  const [ads, setAds] = useState<Array<{ id: string; name: string; status: string; campaign: string }>>([])
  const [form, setForm] = useState({ productUrl: '', metaAdId: '', label: '', viaOurLink: true })
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<AdLinkItem | null>(null)
  const load = useCallback(() => {
    api.getAdLinks().then(setLinks).catch(() => setLinks([]))
    api.getAdsList().then(setAds).catch(() => {})
  }, [])
  useEffect(load, [load])

  const create = async () => {
    setBusy(true)
    try {
      const l = await api.createAdLink({ productUrl: form.productUrl, metaAdId: form.metaAdId || null, label: form.label, viaOurLink: form.viaOurLink })
      await navigator.clipboard?.writeText(l.finalLink).catch(() => {})
      addToast('Link criado e copiado — cole no anúncio', 'success')
      setForm({ ...form, productUrl: '', label: '' })
      load()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao criar', 'error')
    } finally {
      setBusy(false)
    }
  }
  const assign = async (id: string, metaAdId: string) => {
    try {
      await api.updateAdLink(id, { metaAdId: metaAdId || null })
      load()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro', 'error')
    }
  }
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => addToast('Copiado', 'success')).catch(() => {})

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section className="panel">
        <div className="panel-header"><div className="panel-title"><Icon name="link" size={16} style={{ color: 'var(--text-accent)' }} />Criar link para um anúncio</div></div>
        <div className="panel-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, alignItems: 'end' }}>
          <div className="form-group" style={{ marginBottom: 0, gridColumn: '1 / -1' }}>
            <label className="label">Link do produto na Shopee</label>
            <input className="input" value={form.productUrl} onChange={(e) => setForm({ ...form, productUrl: e.target.value })} placeholder="https://shopee.com.br/…" />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Anúncio da Meta (pode escolher depois)</label>
            <select className="select" value={form.metaAdId} onChange={(e) => setForm({ ...form, metaAdId: e.target.value })}>
              <option value="">— escolher depois —</option>
              {ads.map((a) => <option key={a.id} value={a.id}>{a.campaign ? `${a.campaign} › ` : ''}{a.name}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Nome (opcional)</label>
            <input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="ex.: Fone JBL · vídeo 1" />
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', gridColumn: '1 / -1', flexWrap: 'wrap' }}>
            <Toggle checked={form.viaOurLink} onChange={(v) => setForm({ ...form, viaOurLink: v })} label="Passar pelo nosso link (conta os cliques reais, sem robôs)" />
            <button className="btn btn-primary" onClick={create} disabled={busy || !form.productUrl}>{busy ? <span className="spinner spinner-sm" /> : <Icon name="link" />} Gerar link</button>
          </div>
        </div>
      </section>

      <div className="table-wrapper">
        <table>
          <thead><tr><th>Link</th><th>Anúncio</th><th>Código</th><th>Criado</th></tr></thead>
          <tbody>
            {!links ? (
              <tr><td colSpan={4}><Skeleton height={16} /></td></tr>
            ) : links.length === 0 ? (
              <tr><td colSpan={4} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>Nenhum link criado ainda.</td></tr>
            ) : links.map((l) => (
              <tr key={l.id}>
                <td style={{ maxWidth: 340 }}>
                  <div className="primary truncate">{l.label || l.productUrl}</div>
                  <button className="btn btn-ghost btn-sm" onClick={() => copy(l.finalLink)} style={{ paddingLeft: 0 }}><Icon name="copy" /> <span className="mono truncate">{l.finalLink}</span></button>
                </td>
                <td>
                  <select className="select" value={l.metaAdId ?? ''} onChange={(e) => assign(l.id, e.target.value)} style={{ minWidth: 220 }}>
                    <option value="">— sem anúncio —</option>
                    {ads.map((a) => <option key={a.id} value={a.id}>{a.campaign ? `${a.campaign} › ` : ''}{a.name}</option>)}
                  </select>
                </td>
                <td className="mono">{l.code}</td>
                <td>
                  {new Date(l.createdAt).toLocaleDateString('pt-BR')}
                  <div><button className="btn btn-ghost btn-sm" style={{ paddingLeft: 0 }} onClick={() => setViewing(l)}><Icon name="cursor" /> Ver cliques</button></div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {viewing && <LinkClicksModal link={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

// ── History ─────────────────────────────────────────────────────────────────

function HistoryTab({ reloadKey }: { reloadKey: number }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.getAdActions>> | null>(null)
  useEffect(() => { api.getAdActions().then(setRows).catch(() => setRows([])) }, [reloadKey])
  if (!rows) return <Skeleton height={200} borderRadius={14} />
  return (
    <div className="table-wrapper">
      <table>
        <thead><tr><th>Quando</th><th>Onde</th><th>Ação</th><th>Detalhe</th></tr></thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={4} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>Nenhuma regra disparou ainda.</td></tr>
          ) : rows.map((a) => (
            <tr key={a.id}>
              <td>{new Date(a.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
              <td className="primary">{a.name}<div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{a.level === 'CAMPAIGN' ? 'campanha' : a.level === 'ADSET' ? 'conjunto' : 'anúncio'}</div></td>
              <td>{!a.success ? <span className="badge badge-rejected">Erro</span> : a.action === 'PAUSE' ? <span className="badge badge-pending">Pausado</span> : <span className="badge badge-approved">Aviso</span>}</td>
              <td style={{ fontSize: '0.8rem' }}>{a.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Config ──────────────────────────────────────────────────────────────────

function ConfigTab({ config, onSaved }: { config: AdsConfig; onSaved: () => void }) {
  const { addToast } = useToast()
  const [token, setToken] = useState(config.tokenSet ? '***' : '')
  const [accounts, setAccounts] = useState(config.accounts)
  const [defaults, setDefaults] = useState(config.ruleDefaults)
  const [pixelId, setPixelId] = useState(config.pixel.pixelId)
  const [pixelToken, setPixelToken] = useState(config.pixel.tokenSet ? '***' : '')
  const [testCode, setTestCode] = useState(config.pixel.testCode)
  const [busy, setBusy] = useState<'save' | 'test' | 'pixel' | 'pixelTest' | 'defaults' | null>(null)
  const saveDefaults = async () => {
    setBusy('defaults')
    try {
      await api.saveAdsConfig({ ruleDefaults: defaults })
      addToast('Regra padrão salva', 'success')
      onSaved()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro', 'error')
    } finally {
      setBusy(null)
    }
  }
  const savePixel = async (thenTest: boolean) => {
    setBusy(thenTest ? 'pixelTest' : 'pixel')
    try {
      await api.saveAdsConfig({ pixelId, pixelToken, testCode })
      if (thenTest) {
        const r = await api.testShopeePixel()
        addToast(r.ok ? `Evento de teste: ${r.detail}` : `Falhou: ${r.detail}`, r.ok ? 'success' : 'error')
      } else {
        addToast('Pixel salvo', 'success')
      }
      onSaved()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro', 'error')
    } finally {
      setBusy(null)
    }
  }
  const save = async () => {
    setBusy('save')
    try {
      await api.saveAdsConfig({ token, accounts, ruleDefaults: defaults })
      addToast('Configuração salva', 'success')
      onSaved()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro', 'error')
    } finally {
      setBusy(null)
    }
  }
  const test = async () => {
    setBusy('test')
    try {
      await api.saveAdsConfig({ token, accounts })
      const r = await api.testAds()
      addToast(r.message, r.ok ? 'success' : 'error')
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro', 'error')
    } finally {
      setBusy(null)
    }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section className="settings-section">
        <div className="settings-section-header">
          <div className="settings-section-title"><span className="icon-chip"><Icon name="target" /></span>Meta Ads</div>
          <div className="settings-section-desc">Token de usuário do sistema do Business Manager com <code>ads_read</code> (e <code>ads_management</code> para poder pausar).</div>
        </div>
        <div className="form-group">
          <label className="label">Token de acesso</label>
          <input className="input font-mono" type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="EAAB…" />
        </div>
        <div className="form-group">
          <label className="label">Contas de anúncio (separe por vírgula)</label>
          <input className="input font-mono" value={accounts} onChange={(e) => setAccounts(e.target.value)} placeholder="act_1234567890, act_9876543210" />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={test} disabled={busy !== null}>{busy === 'test' ? <span className="spinner spinner-sm" /> : <Icon name="activity" />} Testar conexão</button>
          <button className="btn btn-primary" onClick={save} disabled={busy !== null}>{busy === 'save' ? <span className="spinner spinner-sm" /> : <Icon name="check" />} Salvar</button>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-header">
          <div className="settings-section-title"><span className="icon-chip"><Icon name="zap" /></span>Pixel do tráfego Shopee</div>
          <div className="settings-section-desc">
            Cada clique de pessoa real num link de anúncio envia um <strong>ViewContent</strong> pelo servidor (API de Conversões), com fbc, fbp,
            IP, navegador, ID externo e o produto. Robôs, prévias de link e cliques repetidos não contam.
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">ID do pixel</label>
            <input className="input font-mono" value={pixelId} onChange={(e) => setPixelId(e.target.value)} placeholder="1234567890123456" />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Token da API de Conversões</label>
            <input className="input font-mono" type="password" autoComplete="new-password" value={pixelToken} onChange={(e) => setPixelToken(e.target.value)} placeholder="EAAB…" />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Código de teste (opcional)</label>
            <input className="input font-mono" value={testCode} onChange={(e) => setTestCode(e.target.value)} placeholder="TEST12345" />
          </div>
        </div>
        <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
          Com o código de teste preenchido, os eventos aparecem em Gerenciador de Eventos → Eventos de teste. <strong>Apague o código</strong> quando
          terminar de testar, senão os eventos reais não contam para as campanhas.
          {config.pixel.stats && (
            <div style={{ marginTop: 6, color: 'var(--text-secondary)' }}>
              Hoje: {config.pixel.stats.sent} enviados · {config.pixel.stats.failed} com erro
              {config.pixel.stats.last && <> · último {ago(config.pixel.stats.last.at)}: {config.pixel.stats.last.detail}{config.pixel.stats.last.ok && !config.pixel.stats.last.fbc ? ' (sem fbc — clique não veio de anúncio)' : ''}</>}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn btn-secondary" onClick={() => savePixel(true)} disabled={busy !== null || !pixelId}>{busy === 'pixelTest' ? <span className="spinner spinner-sm" /> : <Icon name="send" />} Salvar e enviar evento de teste</button>
          <button className="btn btn-primary" onClick={() => savePixel(false)} disabled={busy !== null}>{busy === 'pixel' ? <span className="spinner spinner-sm" /> : <Icon name="check" />} Salvar</button>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-header">
          <div className="settings-section-title"><span className="icon-chip"><Icon name="shield" /></span>Regra padrão</div>
          <div className="settings-section-desc">Usada quando você liga "Monitorar" num item sem regra própria. Cada item pode ter a sua.</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Custo/clique acima de (R$)</label>
            <input className="input" type="number" step="0.01" value={defaults.maxCpc} onChange={(e) => setDefaults({ ...defaults, maxCpc: Number(e.target.value) })} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Dias</label>
            <input className="input" type="number" min={1} value={defaults.days} onChange={(e) => setDefaults({ ...defaults, days: Number(e.target.value) })} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Como contar</label>
            <select className="select" value={defaults.mode} onChange={(e) => setDefaults({ ...defaults, mode: e.target.value as 'CONSECUTIVE' | 'AVERAGE' })}>
              <option value="CONSECUTIVE">Dias seguidos</option>
              <option value="AVERAGE">Média</option>
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Gasto mínimo/dia (R$)</label>
            <input className="input" type="number" value={defaults.minSpend} onChange={(e) => setDefaults({ ...defaults, minSpend: Number(e.target.value) })} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Ação</label>
            <select className="select" value={defaults.action} onChange={(e) => setDefaults({ ...defaults, action: e.target.value as 'NOTIFY' | 'PAUSE' })}>
              <option value="NOTIFY">Só avisar</option>
              <option value="PAUSE">Pausar e avisar</option>
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn btn-primary" onClick={saveDefaults} disabled={busy !== null}>
            {busy === 'defaults' ? <span className="spinner spinner-sm" /> : <Icon name="check" />} Salvar regra padrão
          </button>
        </div>
      </section>
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function Ads() {
  const { addToast } = useToast()
  const [tab, setTab] = useState<Tab>('campaigns')
  const [config, setConfig] = useState<AdsConfig | null>(null)
  const [to, setTo] = useState(brtToday())
  const [from, setFrom] = useState(shiftDay(brtToday(), -6))
  const [syncing, setSyncing] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const loadConfig = useCallback(() => api.getAdsConfig().then(setConfig).catch(() => {}), [])
  useEffect(() => { loadConfig() }, [loadConfig])

  const preset = (days: number) => { const t = brtToday(); setTo(t); setFrom(shiftDay(t, -(days - 1))) }
  const sync = async () => {
    setSyncing(true)
    try {
      const r = await api.syncAds()
      const metaErr = r.meta.find((x) => x.error)
      addToast(
        metaErr ? `Meta: ${metaErr.error}` : r.shopee.error ? `Shopee: ${r.shopee.error}` : `Sincronizado · ${r.shopee.saved} vendas da Shopee`,
        metaErr || r.shopee.error ? 'error' : 'success',
      )
      await loadConfig()
      setReloadKey((k) => k + 1)
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao sincronizar', 'error')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Tráfego pago</h1>
          <p className="page-subtitle">Gasto da Meta × comissão da Shopee, por campanha, conjunto e anúncio.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="tabs">
            <button className="tab" onClick={() => { setFrom(brtToday()); setTo(brtToday()) }}>Hoje</button>
            <button className="tab" onClick={() => preset(7)}>7 dias</button>
            <button className="tab" onClick={() => preset(30)}>30 dias</button>
          </div>
          <input className="input" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} style={{ width: 'auto', colorScheme: 'dark' }} />
          <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>até</span>
          <input className="input" type="date" value={to} min={from} max={brtToday()} onChange={(e) => e.target.value && setTo(e.target.value)} style={{ width: 'auto', colorScheme: 'dark' }} />
          <button className="btn btn-secondary" onClick={sync} disabled={syncing}>{syncing ? <span className="spinner spinner-sm" /> : <Icon name="refresh" />} Sincronizar agora</button>
        </div>
      </div>

      {config && (
        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: 14, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <span>
            Meta: {config.tokenSet ? `sincronizado ${ago(config.lastMetaSync?.at)}` : 'token não configurado'}
            {config.tokenSet && !config.accounts && ' · falta a conta de anúncio (aba Configuração)'}
            {config.lastMetaSync?.results?.map((r) => (
              <span key={r.account} style={{ color: r.error ? '#ff8a8e' : 'var(--text-secondary)' }}>
                {' · '}{r.account}: {r.error ? `erro — ${r.error}` : `${r.campaigns ?? 0} campanhas, ${r.adsets ?? 0} conjuntos, ${r.ads ?? 0} anúncios`}
              </span>
            ))}
          </span>
          <span>Vendas Shopee: {config.lastShopeeSync ? `sincronizado ${ago(config.lastShopeeSync.at)}${config.lastShopeeSync.error ? ` · erro: ${config.lastShopeeSync.error}` : ''}` : 'ainda não sincronizado'}</span>
          <span>Atualiza sozinho a cada hora; as regras rodam logo depois.</span>
        </div>
      )}

      <div style={{ marginBottom: 16, overflowX: 'auto' }}>
        <div className="tabs">
          {([
            ['campaigns', 'target', 'Campanhas'],
            ['sales', 'bag', 'Vendas Shopee'],
            ['links', 'link', 'Links de anúncio'],
            ['history', 'history', 'Histórico de ações'],
            ['config', 'settings', 'Configuração'],
          ] as const).map(([key, icon, label]) => (
            <button key={key} className={`tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}><Icon name={icon} size={15} /> {label}</button>
          ))}
        </div>
      </div>

      {!config ? (
        <Skeleton height={300} borderRadius={14} />
      ) : tab === 'campaigns' ? (
        <CampaignsTab from={from} to={to} config={config} reloadKey={reloadKey} />
      ) : tab === 'sales' ? (
        <SalesTab from={from} to={to} reloadKey={reloadKey} />
      ) : tab === 'links' ? (
        <LinksTab />
      ) : tab === 'history' ? (
        <HistoryTab reloadKey={reloadKey} />
      ) : (
        <ConfigTab config={config} onSaved={loadConfig} />
      )}
    </div>
  )
}
