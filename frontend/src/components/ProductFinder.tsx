import React, { useCallback, useEffect, useRef, useState } from 'react'
import api, {
  type FinderFilters, type FinderInfo, type FinderProduct, type FinderResult, type TestedProduct, type FinderReal,
  type FavoritesResult, type FavoriteRow, type FavoriteStatus, type FinderDropReason,
} from '../lib/api'
import { useToast } from '../lib/toast'
import Icon from './Icon'
import Modal from './Modal'
import Toggle from './Toggle'
import { Skeleton } from './LoadingSkeleton'

/* Product finder for direct traffic — Tráfego pago → Produtos para anúncio (api/src/lib/productFinder.ts). */

const brl = (v: number | null | undefined, digits = 2) =>
  v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: digits, maximumFractionDigits: digits })
const int = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString('pt-BR'))
const pct = (v: number | null | undefined, digits = 1) => (v == null ? '—' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: digits })}%`)
const toNum = (s: string) => { const n = Number(String(s).replace(',', '.')); return s.trim() === '' || !Number.isFinite(n) ? null : n }
const fmtNum = (v: number | null | undefined) => (v == null ? '' : String(v).replace('.', ','))
const ago = (iso?: string) => {
  if (!iso) return 'nunca'
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
  return m < 1 ? 'agora' : m < 60 ? `há ${m} min` : m < 1440 ? `há ${Math.round(m / 60)} h` : `há ${Math.round(m / 1440)} d`
}
const signColor = (v: number | null | undefined) => (v == null ? 'var(--text-muted)' : v > 0 ? '#4fe0a4' : v < 0 ? '#ff8a8e' : 'var(--text-secondary)')
const signed = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${brl(v)}`)

const SORTS: Array<[FinderFilters['sort'], string]> = [
  ['salesPerDay', 'Mais vendas por dia'],
  ['trend', 'Vendas subindo'],
  ['profit', 'Maior lucro no dia 1'],
  ['commission', 'Maior comissão (R$)'],
  ['sales', 'Mais vendidos (total)'],
]

const DROP_LABEL: Record<FinderDropReason, string> = {
  price: 'fora da faixa de preço',
  commissionLow: 'comissão abaixo do mínimo',
  commissionHigh: 'comissão acima do máximo',
  rating: 'nota baixa',
  sales: 'poucas vendas no total',
  salesPerDay: 'poucas vendas por dia (ou ainda coletando)',
  official: 'não são loja oficial',
  noCommission: 'sem comissão informada',
  notProfitable: 'não dão lucro no dia 1',
  excluded: 'com palavra escondida',
  name: 'não batem com o nome buscado',
}

const FAV_STATUS: Record<FavoriteStatus, { label: string; badge: string }> = {
  QUEUE: { label: 'Para testar', badge: 'badge-pending' },
  TESTING: { label: 'Testando', badge: 'badge-telegram' },
  WINNER: { label: 'Deu certo', badge: 'badge-sent' },
  LOSER: { label: 'Não deu certo', badge: 'badge-failed' },
}

const PAGE_SIZES = [100, 200, 500]

function Panel({ title, hint, right, children }: { title: string; hint?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
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

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label className="label">{label}</label>
      {children}
      {hint && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

/** Day-1 profit for R$100 of budget, recomputed on the client while the assumptions are edited. */
function profitPer100(commission: number, cpc: number | null, cvrPct: number | null, taxes: FinderInfo['taxes']) {
  if (!cpc || cpc <= 0 || cvrPct == null) return null
  const factor = taxes.metaTaxPct > 0 && taxes.metaTaxPct < 100 ? 1 / (1 - taxes.metaTaxPct / 100) : 1
  const perClick = commission * (1 - taxes.revenueTaxPct / 100) * (cvrPct / 100)
  return Math.round(((100 / cpc) * perClick - 100 * factor) * 100) / 100
}

/* ─── Terms ─── */
function TermsModal({ terms, defaults, onClose, onSaved }: { terms: string[]; defaults: string[]; onClose: () => void; onSaved: () => void }) {
  const { addToast } = useToast()
  const [text, setText] = useState(terms.join('\n'))
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await api.saveFinderSettings({ terms: text })
      addToast('Termos salvos — valem a partir da próxima busca', 'success'); onSaved(); onClose()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao salvar', 'error')
    } finally { setBusy(false) }
  }
  return (
    <Modal isOpen onClose={onClose} title="Termos da busca" width={520}
      footer={<><button className="btn btn-ghost" onClick={() => setText(defaults.join('\n'))}>Restaurar padrão</button><button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? <span className="spinner spinner-sm" /> : null} Salvar</button></>}>
      <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginTop: 0 }}>
        Além dos mais vendidos da Shopee em geral, a busca procura os mais vendidos de cada termo abaixo, um por linha.
        Use termos amplos e variados, porque o buscador não é preso a um nicho.
      </p>
      <textarea className="input" rows={12} value={text} onChange={(e) => setText(e.target.value)} style={{ fontFamily: 'inherit', resize: 'vertical' }} />
    </Modal>
  )
}

/* ─── Ad link ─── */
type LinkProduct = { name: string; imageUrl: string | null; link: string; price: number; commission: number | null }

function LinkModal({ product, onClose }: { product: LinkProduct; onClose: () => void }) {
  const { addToast } = useToast()
  const [ads, setAds] = useState<Array<{ id: string; name: string; campaign: string }>>([])
  const [metaAdId, setMetaAdId] = useState('')
  const [label, setLabel] = useState(product.name.slice(0, 60))
  const [viaOurLink, setViaOurLink] = useState(true)
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  useEffect(() => { api.getAdsList().then(setAds).catch(() => {}) }, [])
  const create = async () => {
    setBusy(true)
    try {
      const l = await api.createAdLink({ productUrl: product.link, metaAdId: metaAdId || null, label, viaOurLink })
      setLink(l.finalLink)
      await navigator.clipboard?.writeText(l.finalLink).catch(() => {})
      addToast('Link criado e copiado — cole no anúncio', 'success')
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao criar o link', 'error')
    } finally { setBusy(false) }
  }
  return (
    <Modal isOpen onClose={onClose} title="Criar link de anúncio" width={520}
      footer={link
        ? <button className="btn btn-primary" onClick={onClose}>Pronto</button>
        : <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button><button className="btn btn-primary" onClick={create} disabled={busy}>{busy ? <span className="spinner spinner-sm" /> : <Icon name="link" />} Gerar link</button></>}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14 }}>
        {product.imageUrl && <img src={product.imageUrl} alt="" width={56} height={56} style={{ borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{product.name}</div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{brl(product.price)} · comissão {brl(product.commission)}</div>
        </div>
      </div>
      {link ? (
        <div>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
            Cole este link no anúncio. As vendas dele aparecem em <b>Análise de vendas</b> e em <b>Produtos que você já testou</b>, logo abaixo.
          </div>
          <button className="btn btn-secondary" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => navigator.clipboard?.writeText(link).then(() => addToast('Copiado', 'success'))}>
            <Icon name="copy" /> <span className="mono truncate">{link}</span>
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Nome do link"><input className="input" value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
          <Field label="Anúncio da Meta (pode escolher depois, em Links de anúncio)">
            <select className="select" value={metaAdId} onChange={(e) => setMetaAdId(e.target.value)}>
              <option value="">— escolher depois —</option>
              {ads.map((a) => <option key={a.id} value={a.id}>{a.campaign ? `${a.campaign} › ` : ''}{a.name}</option>)}
            </select>
          </Field>
          <Toggle checked={viaOurLink} onChange={setViaOurLink} label="Passar pelo nosso link (conta os cliques reais, sem robôs)" />
        </div>
      )}
    </Modal>
  )
}

function Star({ on, busy, onClick }: { on: boolean; busy?: boolean; onClick: () => void }) {
  return (
    <button className="btn btn-ghost btn-sm" onClick={onClick} disabled={busy} title={on ? 'Tirar dos favoritos' : 'Adicionar aos favoritos para testar'}
      aria-label={on ? 'Tirar dos favoritos' : 'Adicionar aos favoritos'} style={{ padding: '4px 6px', fontSize: '1.1rem', lineHeight: 1, color: on ? '#f5c451' : 'var(--text-muted)' }}>
      {on ? '★' : '☆'}
    </button>
  )
}

/* ─── Favorites ─── */
function FavoritesPanel({ data, onChanged, onLink }: { data: FavoritesResult | null; onChanged: () => void; onLink: (p: LinkProduct) => void }) {
  const { addToast } = useToast()
  const [filter, setFilter] = useState<FavoriteStatus | 'ALL'>('ALL')
  const setStatus = async (row: FavoriteRow, status: FavoriteStatus) => {
    try { await api.updateFavorite(row.id, { status }); onChanged() } catch (err) { addToast(err instanceof Error ? err.message : 'Erro', 'error') }
  }
  const editNote = async (row: FavoriteRow) => {
    const note = window.prompt('Anotação deste produto (ex.: criativo usado, público, o que aprendeu):', row.note ?? '')
    if (note === null) return
    try { await api.updateFavorite(row.id, { note }); onChanged() } catch (err) { addToast(err instanceof Error ? err.message : 'Erro', 'error') }
  }
  const remove = async (row: FavoriteRow) => {
    if (!window.confirm(`Tirar "${row.product.name}" dos favoritos?`)) return
    try { await api.removeFavorite(row.id); onChanged() } catch (err) { addToast(err instanceof Error ? err.message : 'Erro', 'error') }
  }
  if (!data) return <Skeleton height={240} borderRadius={14} />
  const rows = data.rows.filter((r) => filter === 'ALL' || r.status === filter)
  const next = data.rows.find((r) => r.status === 'QUEUE')
  return (
    <Panel title="Favoritos para testar"
      hint="Marque com ☆ na lista de produtos. Teste um por vez: crie o link, coloque no anúncio e acompanhe aqui o resultado real. Ao criar o link, o produto passa para Testando."
      right={
        <div style={{ overflowX: 'auto', maxWidth: '100%' }}><div className="tabs">
          <button className={`tab${filter === 'ALL' ? ' active' : ''}`} onClick={() => setFilter('ALL')}>Todos ({data.rows.length})</button>
          {(Object.keys(FAV_STATUS) as FavoriteStatus[]).map((st) => (
            <button key={st} className={`tab${filter === st ? ' active' : ''}`} onClick={() => setFilter(st)}>{FAV_STATUS[st].label} ({data.counts[st] ?? 0})</button>
          ))}
        </div></div>
      }>
      {next && (data.counts.TESTING ?? 0) === 0 && (
        <div style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(59,143,230,0.08)', border: '1px solid rgba(59,143,230,0.25)', fontSize: '0.85rem', display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span>Nenhum produto em teste agora. O próximo da fila é <b>{next.product.name}</b>.</span>
          <button className="btn btn-primary btn-sm" onClick={() => onLink(next.product)}><Icon name="link" size={14} /> Criar link do próximo</button>
        </div>
      )}
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>#</th><th>Produto</th><th className="num">Preço</th><th className="num">Comissão</th><th className="num">Vendas/dia</th>
              <th className="num">CPC máx. dia 1</th><th>Status</th><th className="num">Gasto</th><th className="num">Lucro dia 1</th><th className="num">Lucro total</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={11} style={{ textAlign: 'center', padding: 28, color: 'var(--text-muted)' }}>
                {data.rows.length === 0 ? <>Nenhum favorito ainda. Clique na estrela <b>☆</b> dos produtos que quer testar.</> : 'Nenhum produto com esse status.'}
              </td></tr>
            ) : rows.map((r) => {
              const p = r.product
              const res = r.result
              return (
                <tr key={r.id}>
                  <td className="tabular" style={{ color: 'var(--text-muted)' }}>{r.position}</td>
                  <td style={{ maxWidth: 320 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      {p.imageUrl ? <img src={p.imageUrl} alt="" width={40} height={40} loading="lazy" style={{ borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} /> : <div style={{ width: 40, height: 40, borderRadius: 8, background: 'rgba(255,255,255,0.05)', flexShrink: 0 }} />}
                      <div style={{ minWidth: 0 }}>
                        <a className="primary truncate" href={p.link} target="_blank" rel="noreferrer" style={{ display: 'block', color: 'inherit' }} title={p.name}>{p.name}</a>
                        <button className="btn btn-ghost btn-sm" style={{ padding: 0, fontSize: '0.72rem', color: 'var(--text-muted)' }} onClick={() => editNote(r)}>
                          {r.note ? <span className="truncate" style={{ maxWidth: 240 }}>📝 {r.note}</span> : '+ anotação'}
                        </button>
                      </div>
                    </div>
                  </td>
                  <td className="num tabular">{brl(p.price)}</td>
                  <td className="num tabular">{brl(p.commission)}</td>
                  <td className="num tabular">{p.salesPerDay == null ? <span style={{ color: 'var(--text-muted)' }}>coletando</span> : int(p.salesPerDay)}</td>
                  <td className="num tabular">{brl(p.maxCpc, 3)}</td>
                  <td>
                    <select className="select" value={r.status} onChange={(e) => setStatus(r, e.target.value as FavoriteStatus)} style={{ minWidth: 140, padding: '4px 8px' }}>
                      {(Object.keys(FAV_STATUS) as FavoriteStatus[]).map((st) => <option key={st} value={st}>{FAV_STATUS[st].label}</option>)}
                    </select>
                  </td>
                  <td className="num tabular">{res ? brl(res.spend) : '—'}</td>
                  <td className="num tabular" style={{ color: signColor(res && res.spend > 0 ? res.day1Profit : null), fontWeight: 600 }}>{res && res.spend > 0 ? signed(res.day1Profit) : '—'}</td>
                  <td className="num tabular" style={{ color: signColor(res && res.spend > 0 ? res.profit : null), fontWeight: 600 }}>{res && res.spend > 0 ? signed(res.profit) : '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => onLink(p)}><Icon name="link" size={14} /> Criar link</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => remove(r)} title="Tirar dos favoritos" style={{ color: '#ff8a8e' }}><Icon name="trash" size={14} /></button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
        Gasto e lucro vêm dos anúncios com link deste produto nos últimos 90 dias (lucro já sem o imposto da Meta). Para aparecer, vincule o link ao anúncio em <b>Links de anúncio</b>.
      </div>
    </Panel>
  )
}

/* ─── Tested products ─── */
function TestedPanel({ rows, real }: { rows: TestedProduct[] | null; real: FinderReal | null }) {
  return (
    <Panel title="Produtos que você já testou"
      hint="Últimos 30 dias dos produtos com link de anúncio. Dia 1 = vendas no mesmo dia do clique; o total inclui os outros dias do cookie de 7 dias. Lucro já desconta o imposto da Meta.">
      {real && real.cvrClicks > 0 && (
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          No total: <b>{int(real.cvrClicks)}</b> cliques no link, <b>{int(real.day1Orders)}</b> pedidos no mesmo dia
          {real.cvrPct != null && <> · conversão no dia 1 de <b>{pct(real.cvrPct, 2)}</b></>}
          {real.day1PerClick != null && <> · cada clique rendeu <b>{brl(real.day1PerClick, 3)}</b> de comissão no dia 1</>}
        </div>
      )}
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Produto</th><th className="num">Gasto</th><th className="num">Cliques</th><th className="num">CPC</th>
              <th className="num">Pedidos dia 1</th><th className="num">Conv. dia 1</th><th className="num">Comissão dia 1</th><th className="num">Lucro dia 1</th>
              <th className="num">Pedidos total</th><th className="num">Comissão total</th><th className="num">Lucro total</th>
            </tr>
          </thead>
          <tbody>
            {!rows ? (
              <tr><td colSpan={11}><Skeleton height={16} /></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={11} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>
                Nenhum produto testado ainda. Crie o link de um produto da lista acima e use no anúncio.
              </td></tr>
            ) : rows.map((r, i) => (
              <tr key={(r.itemId ?? '') + i}>
                <td style={{ maxWidth: 300 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    {r.imageUrl ? <img src={r.imageUrl} alt="" width={36} height={36} style={{ borderRadius: 6, objectFit: 'cover', flexShrink: 0 }} /> : <div style={{ width: 36, height: 36, borderRadius: 6, background: 'rgba(255,255,255,0.05)', flexShrink: 0 }} />}
                    <div style={{ minWidth: 0 }}>
                      <div className="primary truncate">{r.name}</div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{r.links} link{r.links > 1 ? 's' : ''} · {r.ads} anúncio{r.ads === 1 ? '' : 's'}{r.ads === 0 && ' (vincule em Links de anúncio)'}</div>
                    </div>
                  </div>
                </td>
                <td className="num tabular">{brl(r.spend)}</td>
                <td className="num tabular">{int(r.clicks)}</td>
                <td className="num tabular">{brl(r.cpc, 3)}</td>
                <td className="num tabular">{int(r.day1Orders)}</td>
                <td className="num tabular">{pct(r.day1CvrPct, 2)}</td>
                <td className="num tabular">{brl(r.day1Commission)}</td>
                <td className="num tabular" style={{ color: signColor(r.spend > 0 ? r.day1Profit : null), fontWeight: 600 }}>{r.spend > 0 ? signed(r.day1Profit) : '—'}</td>
                <td className="num tabular">{int(r.orders)}</td>
                <td className="num tabular">{brl(r.commission)}</td>
                <td className="num tabular" style={{ color: signColor(r.spend > 0 ? r.profit : null), fontWeight: 600 }}>{r.spend > 0 ? signed(r.profit) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

/* ─── Main ─── */
export default function ProductFinder() {
  const { addToast } = useToast()
  const [info, setInfo] = useState<FinderInfo | null>(null)
  const [result, setResult] = useState<FinderResult | null>(null)
  const [tested, setTested] = useState<{ rows: TestedProduct[]; real: FinderReal } | null>(null)
  const [cpc, setCpc] = useState('')
  const [cvr, setCvr] = useState('')
  const [f, setF] = useState<FinderFilters | null>(null)
  const [loading, setLoading] = useState(false)
  const [savingDefaults, setSavingDefaults] = useState(false)
  const [editingTerms, setEditingTerms] = useState(false)
  const [linkFor, setLinkFor] = useState<LinkProduct | null>(null)
  const [view, setView] = useState<'all' | 'fav'>('all')
  const [favorites, setFavorites] = useState<FavoritesResult | null>(null)
  const [favBusy, setFavBusy] = useState<string | null>(null)
  const [pageSize, setPageSize] = useState(200)
  const [offset, setOffset] = useState(0)
  const wasRunning = useRef(false)
  const loadFavorites = useCallback(() => api.getFavorites().then(setFavorites).catch(() => {}), [])

  const loadInfo = useCallback(async () => {
    const i = await api.getFinderSettings()
    setInfo(i)
    return i
  }, [])

  const search = useCallback(async (filters: FinderFilters, cpcV: number | null, cvrV: number | null, page = { limit: 200, offset: 0 }) => {
    setLoading(true)
    try {
      setResult(await api.getFinderProducts({ ...filters, ...(cpcV != null && { cpc: cpcV }), ...(cvrV != null && { cvrPct: cvrV }), ...page }))
      setOffset(page.offset)
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao buscar produtos', 'error')
    } finally { setLoading(false) }
  }, [addToast])

  useEffect(() => {
    loadInfo().then((i) => {
      setCpc(fmtNum(i.settings.cpc)); setCvr(fmtNum(i.settings.cvrPct)); setF(i.settings.filters)
      search(i.settings.filters, i.settings.cpc, i.settings.cvrPct)
    }).catch((err) => addToast(err instanceof Error ? err.message : 'Erro ao carregar', 'error'))
    api.getTestedProducts().then(setTested).catch(() => setTested({ rows: [], real: null as unknown as FinderReal }))
    loadFavorites()
  }, [loadInfo, search, addToast, loadFavorites])

  // While a scan runs, check every 10 s; refresh the list when it ends.
  const running = !!info?.scan.running
  useEffect(() => {
    if (!running) {
      if (wasRunning.current && f) search(f, toNum(cpc), toNum(cvr), { limit: pageSize, offset: 0 })
      wasRunning.current = false
      return
    }
    wasRunning.current = true
    const t = setInterval(() => { loadInfo().catch(() => {}) }, 10000)
    return () => clearInterval(t)
  }, [running]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!info || !f) return <Skeleton height={400} borderRadius={14} />

  const cpcN = toNum(cpc)
  const cvrN = toNum(cvr)
  const taxes = info.taxes
  const factor = taxes.metaTaxPct > 0 && taxes.metaTaxPct < 100 ? 1 / (1 - taxes.metaTaxPct / 100) : 1
  const breakEven = cpcN && cvrN ? (cpcN * factor) / (cvrN / 100) / (1 - taxes.revenueTaxPct / 100) : null
  const real = tested?.real ?? info.real
  const set = <K extends keyof FinderFilters>(k: K, v: FinderFilters[K]) => setF({ ...f, [k]: v })
  const numInput = (k: 'minPrice' | 'maxPrice' | 'minCommission' | 'maxCommission', placeholder: string) => (
    <input className="input" inputMode="decimal" value={fmtNum(f[k])} placeholder={placeholder}
      onChange={(e) => set(k, toNum(e.target.value))} />
  )
  const apply = (next = f, page = { limit: pageSize, offset: 0 }) => search(next, cpcN, cvrN, page)
  const toggleFavorite = async (p: FinderProduct) => {
    setFavBusy(p.id)
    try {
      if (p.favoriteId) {
        await api.removeFavorite(p.favoriteId)
        setResult((r) => r && { ...r, items: r.items.map((x) => (x.id === p.id ? { ...x, favoriteId: null } : x)) })
      } else {
        const fav = await api.addFavorite(p.id)
        setResult((r) => r && { ...r, items: r.items.map((x) => (x.id === p.id ? { ...x, favoriteId: fav.id } : x)) })
        addToast('Adicionado aos favoritos', 'success')
      }
      loadFavorites()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro', 'error')
    } finally { setFavBusy(null) }
  }
  const dropped = result ? (Object.entries(result.dropped) as Array<[FinderDropReason, number]>).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]) : []
  const saveDefaults = async () => {
    if (!cpcN || !cvrN) { addToast('Preencha o CPC e a conversão', 'error'); return }
    setSavingDefaults(true)
    try {
      await api.saveFinderSettings({ cpc: cpcN, cvrPct: cvrN, filters: f })
      addToast('Salvo como padrão', 'success'); loadInfo().catch(() => {})
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao salvar', 'error')
    } finally { setSavingDefaults(false) }
  }
  const scanNow = async () => {
    try {
      const r = await api.runFinderScan()
      addToast(r.queued ? 'Busca iniciada — leva de 10 a 15 minutos' : 'Já tem uma busca rodando', 'success')
      await loadInfo()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao iniciar a busca', 'error')
    }
  }
  const scan = info.scan

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Assumptions */}
      <Panel title="Contas do dia 1"
        hint={`Quanto custa o clique e quantos compram no mesmo dia. O imposto da Meta (${pct(taxes.metaTaxPct, 2)} da fatura) já entra na conta.`}
        right={<button className="btn btn-secondary btn-sm" onClick={saveDefaults} disabled={savingDefaults}>{savingDefaults ? <span className="spinner spinner-sm" /> : <Icon name="check" />} Salvar como padrão</button>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 12 }}>
          <Field label="CPC — custo por clique no link (R$)"
            hint={real?.cpc != null
              ? <>Seu CPC real ({real.days} dias): <b>{brl(real.cpc, 3)}</b>{' '}<button className="btn btn-ghost btn-sm" style={{ padding: '0 4px' }} onClick={() => setCpc(fmtNum(real.cpc))}>usar</button></>
              : 'Quando seus anúncios tiverem cliques, o CPC real aparece aqui.'}>
            <input className="input" inputMode="decimal" value={cpc} onChange={(e) => setCpc(e.target.value)} onBlur={() => apply()} />
          </Field>
          <Field label="Conversão no mesmo dia (% dos cliques que compram)"
            hint={real?.cvrPct != null
              ? <>Sua conversão real: <b>{pct(real.cvrPct, 2)}</b> em {int(real.cvrClicks)} cliques{' '}<button className="btn btn-ghost btn-sm" style={{ padding: '0 4px' }} onClick={() => setCvr(fmtNum(real.cvrPct))}>usar</button></>
              : `Estimativa. A real aparece depois de 100 cliques em links de anúncio${real && real.cvrClicks > 0 ? ` (agora ${int(real.cvrClicks)})` : ''}.`}>
            <input className="input" inputMode="decimal" value={cvr} onChange={(e) => setCvr(e.target.value)} onBlur={() => apply()} />
          </Field>
        </div>
        {breakEven != null && (
          <div style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(59,143,230,0.08)', border: '1px solid rgba(59,143,230,0.25)', fontSize: '0.85rem' }}>
            Com clique a <b>{brl(cpcN, 3)}</b> e <b>{pct(cvrN, 2)}</b> comprando no mesmo dia, o produto precisa pagar pelo menos{' '}
            <b>{brl(breakEven)}</b> de comissão para <b>não dar prejuízo no dia 1</b>. O que vier nos outros 6 dias do cookie é lucro a mais.
          </div>
        )}
      </Panel>

      {/* Filters */}
      <Panel title="Filtros"
        hint="Começa na dica de quem já faz isso: produtos de R$ 20 a 30 com R$ 2 a 5 de comissão. Mude à vontade."
        right={<button className="btn btn-primary btn-sm" onClick={() => apply()} disabled={loading}>{loading ? <span className="spinner spinner-sm" /> : <Icon name="refresh" />} Aplicar</button>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', gap: 12 }}>
          <Field label="Preço de (R$)">{numInput('minPrice', 'qualquer')}</Field>
          <Field label="Preço até (R$)">{numInput('maxPrice', 'qualquer')}</Field>
          <Field label="Comissão de (R$)">{numInput('minCommission', 'qualquer')}</Field>
          <Field label="Comissão até (R$)">{numInput('maxCommission', 'qualquer')}</Field>
          <Field label="Nota mínima">
            <input className="input" inputMode="decimal" value={fmtNum(f.minRating)} onChange={(e) => set('minRating', toNum(e.target.value) ?? 0)} />
          </Field>
          <Field label="Vendidos (total) mín.">
            <input className="input" inputMode="numeric" value={fmtNum(f.minSales)} onChange={(e) => set('minSales', toNum(e.target.value) ?? 0)} />
          </Field>
          <Field label="Vendas por dia mín.">
            <input className="input" inputMode="numeric" value={fmtNum(f.minSalesPerDay)} onChange={(e) => set('minSalesPerDay', toNum(e.target.value) ?? 0)} />
          </Field>
          <Field label="Ordenar por">
            <select className="select" value={f.sort} onChange={(e) => { const next = { ...f, sort: e.target.value as FinderFilters['sort'] }; setF(next); apply(next) }}>
              {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 12 }}>
          <Field label="Nome contém"><input className="input" value={f.q} placeholder="ex.: garrafa" onChange={(e) => set('q', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} /></Field>
          <Field label="Esconder produtos com estas palavras"><input className="input" value={f.exclude} placeholder="separe por vírgula" onChange={(e) => set('exclude', e.target.value)} /></Field>
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <Toggle checked={f.onlyProfitable} onChange={(v) => { const next = { ...f, onlyProfitable: v }; setF(next); apply(next) }} label="Só os que dão lucro no dia 1" />
          <Toggle checked={f.officialOnly} onChange={(v) => { const next = { ...f, officialOnly: v }; setF(next); apply(next) }} label="Só lojas oficiais" />
        </div>
      </Panel>

      {/* Scan status */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <span>
            {running
              ? <><span className="spinner spinner-sm" /> Buscando produtos na Shopee… {scan.calls ? `${int(scan.calls)} consultas, ${int(scan.saved ?? 0)} produtos até agora` : ''} (leva de 10 a 15 minutos)</>
              : <>Última busca na Shopee: {ago(scan.at)}{scan.saved != null && ` · ${int(scan.saved)} produtos lidos`}</>}
          </span>
          {result && <span>Catálogo: {int(result.catalog)} produtos · {int(result.withRate)} já com vendas por dia</span>}
          <span>Busca sozinha a cada 6 horas.</span>
          {scan.fields && <span>A Shopee não enviou: {scan.fields.replace(/^sem /, '')}</span>}
          {scan.errors && scan.errors.length > 0 && !running && <span style={{ color: '#ff8a8e' }}>Erro: {scan.errors[0]}</span>}
          {scan.warnings && scan.warnings.length > 0 && !running && <span title={scan.warnings.slice(1).join('\n')}>{scan.warnings[0]}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setEditingTerms(true)}><Icon name="settings" size={14} /> Termos da busca</button>
          <button className="btn btn-secondary btn-sm" onClick={scanNow} disabled={running}><Icon name="refresh" size={14} /> Buscar na Shopee agora</button>
        </div>
      </div>

      <div className="tabs" style={{ alignSelf: 'flex-start' }}>
        <button className={`tab${view === 'all' ? ' active' : ''}`} onClick={() => setView('all')}><Icon name="bag" size={15} /> Todos os produtos{result ? ` (${int(result.total)})` : ''}</button>
        <button className={`tab${view === 'fav' ? ' active' : ''}`} onClick={() => { setView('fav'); loadFavorites() }}>★ Favoritos{favorites ? ` (${favorites.rows.length})` : ''}</button>
      </div>

      {view === 'fav' ? (
        <FavoritesPanel data={favorites} onChanged={loadFavorites} onLink={setLinkFor} />
      ) : (<>
      {/* Results */}
      <Panel title={result ? `${int(result.total)} produtos passam nos filtros${result.total > result.items.length ? ` · mostrando ${int(result.offset + 1)}–${int(result.offset + result.items.length)}` : ''}` : 'Produtos'}
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Por página</span>
            <select className="select" value={pageSize} onChange={(e) => { const n = Number(e.target.value); setPageSize(n); apply(f, { limit: n, offset: 0 }) }} style={{ width: 'auto', padding: '4px 8px' }}>
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        }
        hint={<>
          <b>Vendas/dia</b> vem de duas leituras com 1 dia de diferença, porque a Shopee só informa o total vendido. Na primeira busca essa coluna fica vazia.{' '}
          <b>CPC máx.</b> é o maior custo por clique que ainda empata no dia 1. <b>Lucro dia 1</b> é a cada R$ 100 de orçamento, já com o imposto.
        </>}>
        {result && result.catalog > 0 && (
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            De <b>{int(result.catalog)}</b> produtos no catálogo, <b>{int(result.total)}</b> passam.
            {dropped.length > 0 && <> Ficaram de fora: {dropped.map(([k, n], i) => <span key={k}>{i > 0 && ' · '}<b>{int(n)}</b> {DROP_LABEL[k]}</span>)}.</>}
            {dropped[0] && result.total < 50 && <span style={{ color: 'var(--text-muted)' }}> Para ver mais, afrouxe o filtro que mais corta ({DROP_LABEL[dropped[0][0]]}).</span>}
          </div>
        )}
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th /><th>Produto</th><th className="num">Preço</th><th className="num">Comissão</th><th className="num">Vendidos</th>
                <th className="num">Vendas/dia</th><th className="num">Nota</th><th className="num">CPC máx. dia 1</th><th className="num">Lucro dia 1 / R$100</th><th />
              </tr>
            </thead>
            <tbody>
              {!result || (loading && result.items.length === 0) ? (
                <tr><td colSpan={10}><Skeleton height={16} /></td></tr>
              ) : result.items.length === 0 ? (
                <tr><td colSpan={10} style={{ textAlign: 'center', padding: 28, color: 'var(--text-muted)' }}>
                  {result.catalog === 0
                    ? <>Ainda não há produtos. Clique em <b>Buscar na Shopee agora</b>. A primeira busca leva de 1 a 3 minutos.</>
                    : 'Nenhum produto passa nesses filtros. Afrouxe a faixa de preço ou de comissão.'}
                </td></tr>
              ) : result.items.map((p) => {
                const profit = profitPer100(p.commission, cpcN, cvrN, taxes)
                const trendUp = p.trend != null && p.trend >= 1.3
                const trendDown = p.trend != null && p.trend <= 0.7
                return (
                  <tr key={p.id} style={{ opacity: loading ? 0.6 : 1 }}>
                    <td style={{ width: 36, paddingRight: 0 }}><Star on={!!p.favoriteId} busy={favBusy === p.id} onClick={() => toggleFavorite(p)} /></td>
                    <td style={{ maxWidth: 340 }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        {p.imageUrl ? <img src={p.imageUrl} alt="" width={44} height={44} loading="lazy" style={{ borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} /> : <div style={{ width: 44, height: 44, borderRadius: 8, background: 'rgba(255,255,255,0.05)', flexShrink: 0 }} />}
                        <div style={{ minWidth: 0 }}>
                          <a className="primary truncate" href={p.link} target="_blank" rel="noreferrer" style={{ display: 'block', color: 'inherit' }} title={p.name}>{p.name}</a>
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <span className="truncate" style={{ maxWidth: 160 }}>{p.shopName ?? 'Loja'}</span>
                            {p.isOfficial && <span className="badge" style={{ fontSize: '0.66rem' }}>Oficial</span>}
                            {p.tested && <span className="badge badge-sent" style={{ fontSize: '0.66rem' }}>Já testado</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="num tabular">{brl(p.price)}</td>
                    <td className="num tabular">
                      <div style={{ fontWeight: 600 }}>{brl(p.commission)}</div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{pct(p.commissionPct)}</div>
                    </td>
                    <td className="num tabular">{int(p.sales)}</td>
                    <td className="num tabular">
                      {p.salesPerDay == null ? <span style={{ color: 'var(--text-muted)' }} title="Precisa de duas leituras com 1 dia de diferença">coletando</span> : (
                        <span title={p.trend != null ? `Últimos dias ${p.trend.toLocaleString('pt-BR')}× a média da semana` : undefined}>
                          {int(p.salesPerDay)}
                          {trendUp && <span style={{ color: '#4fe0a4', marginLeft: 4 }}>▲ subindo</span>}
                          {trendDown && <span style={{ color: '#ff8a8e', marginLeft: 4 }}>▼ caindo</span>}
                        </span>
                      )}
                    </td>
                    <td className="num tabular">{p.rating != null ? p.rating.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : '—'}</td>
                    <td className="num tabular">{brl(p.maxCpc, 3)}</td>
                    <td className="num tabular" style={{ color: signColor(profit), fontWeight: 600 }}>{signed(profit)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => setLinkFor(p)}><Icon name="link" size={14} /> Criar link</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {result && result.total > pageSize && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-secondary btn-sm" disabled={loading || offset === 0} onClick={() => apply(f, { limit: pageSize, offset: Math.max(0, offset - pageSize) })}>← Anterior</button>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Página {int(Math.floor(offset / pageSize) + 1)} de {int(Math.ceil(result.total / pageSize))}</span>
            <button className="btn btn-secondary btn-sm" disabled={loading || offset + pageSize >= result.total} onClick={() => apply(f, { limit: pageSize, offset: offset + pageSize })}>Próxima →</button>
          </div>
        )}
      </Panel>

      <TestedPanel rows={tested?.rows ?? null} real={tested?.real ?? null} />
      </>)}

      {editingTerms && <TermsModal terms={info.settings.terms} defaults={info.defaults.terms} onClose={() => setEditingTerms(false)} onSaved={() => loadInfo().catch(() => {})} />}
      {linkFor && <LinkModal product={linkFor} onClose={() => { setLinkFor(null); api.getTestedProducts().then(setTested).catch(() => {}); loadFavorites() }} />}
    </div>
  )
}
