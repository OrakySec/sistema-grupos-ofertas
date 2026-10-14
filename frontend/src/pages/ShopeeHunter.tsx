import React, { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import api, {
  type Coupon,
  type DestinationGroup,
  type HunterCandidate,
  type HunterListItem,
  type HunterMode,
  type ShopeeHunterConfig,
} from '../lib/api'
import { useToast } from '../lib/toast'
import Icon from '../components/Icon'
import Toggle from '../components/Toggle'
import { Skeleton } from '../components/LoadingSkeleton'

const MODES: Array<{ value: HunterMode; label: string; hint: string }> = [
  { value: 'OFF', label: 'Desligada', hint: 'Não busca nada.' },
  { value: 'PREVIEW', label: 'Prévia', hint: 'Busca e mostra aqui o que enviaria, sem enviar nada. Use para calibrar os filtros.' },
  { value: 'APPROVAL', label: 'Com aprovação', hint: 'As ofertas encontradas vão para a fila de Aprovação.' },
  { value: 'AUTO', label: 'Automática', hint: 'Envia direto para os grupos, respeitando os limites.' },
  { value: 'AUTO_BEST', label: 'Automática nas melhores', hint: 'Envia direto quando a nota passa do mínimo automático; o resto vai para a Aprovação.' },
]

const MODE_BADGE: Record<HunterMode, { label: string; color: string }> = {
  OFF: { label: 'desligada', color: 'var(--text-muted)' },
  PREVIEW: { label: 'prévia', color: '#4ea8ff' },
  APPROVAL: { label: 'com aprovação', color: '#f5a524' },
  AUTO: { label: 'automática', color: '#22c983' },
  AUTO_BEST: { label: 'auto (melhores)', color: '#22c983' },
}

const STATUS_LABEL: Record<HunterCandidate['status'], { label: string; cls: string }> = {
  PREVIEW: { label: 'Prévia', cls: 'badge' },
  READY: { label: 'Aguardando vaga', cls: 'badge badge-pending' },
  QUEUED: { label: 'Na aprovação', cls: 'badge badge-approved' },
  SENT: { label: 'Enviada', cls: 'badge badge-sent' },
  EXPIRED: { label: 'Expirou', cls: 'badge' },
}

const brl = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

function ago(iso: string | null | undefined): string {
  if (!iso) return 'nunca'
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  return h < 24 ? `há ${h} h` : `há ${Math.floor(h / 24)} d`
}

// ── Field helpers ───────────────────────────────────────────────────────────

function NumField({ label, value, onChange, suffix, step = 1, placeholder }: { label: string; value: number | null; onChange: (v: number | null) => void; suffix?: string; step?: number; placeholder?: string }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label className="label">{label}</label>
      <div style={{ position: 'relative' }}>
        <input
          className="input"
          type="number"
          step={step}
          value={value ?? ''}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          style={suffix ? { paddingRight: 40 } : undefined}
        />
        {suffix && <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>{suffix}</span>}
      </div>
    </div>
  )
}

// ── Niche editor ────────────────────────────────────────────────────────────

function NicheEditor({ nicheId, destinations, onSaved }: { nicheId: string; destinations: DestinationGroup[]; onSaved: () => void }) {
  const { addToast } = useToast()
  const [cfg, setCfg] = useState<ShopeeHunterConfig | null>(null)
  const [destIds, setDestIds] = useState<string[]>([])
  const [candidates, setCandidates] = useState<HunterCandidate[]>([])
  const [nicheName, setNicheName] = useState('')
  const [busy, setBusy] = useState<'save' | 'run' | 'test' | null>(null)
  const [testKeyword, setTestKeyword] = useState('')
  const [testResult, setTestResult] = useState<Awaited<ReturnType<typeof api.testHunterSearch>> | null>(null)

  const load = useCallback(async () => {
    const d = await api.getHunter(nicheId)
    setCfg(d.hunter)
    setDestIds(d.destinationIds)
    setCandidates(d.candidates)
    setNicheName(d.niche.name)
  }, [nicheId])

  useEffect(() => {
    setCfg(null)
    setTestResult(null)
    load().catch((err) => addToast(err instanceof Error ? err.message : 'Erro ao carregar', 'error'))
  }, [load, addToast])

  if (!cfg) return <Skeleton height={420} borderRadius={14} />
  const set = <K extends keyof ShopeeHunterConfig>(k: K, v: ShopeeHunterConfig[K]) => setCfg({ ...cfg, [k]: v })

  const save = async () => {
    setBusy('save')
    try {
      await api.saveHunter(nicheId, { ...cfg, destinationIds: destIds })
      addToast('Busca salva', 'success')
      onSaved()
      await load()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao salvar', 'error')
    } finally {
      setBusy(null)
    }
  }

  const run = async () => {
    setBusy('run')
    try {
      await api.saveHunter(nicheId, { ...cfg, destinationIds: destIds })
      const s = await api.runHunter(nicheId)
      addToast(
        s.errors.length ? `Busca com erro: ${s.errors[0]}` : `${s.found} produtos analisados · ${s.passed} passaram nos filtros · ${s.newCandidates} novos`,
        s.errors.length ? 'error' : 'success',
      )
      onSaved()
      await load()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro na busca', 'error')
    } finally {
      setBusy(null)
    }
  }

  const test = async () => {
    if (!testKeyword.trim()) return
    setBusy('test')
    try {
      setTestResult(await api.testHunterSearch(testKeyword.trim()))
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  const sendCandidate = async (id: string) => {
    try {
      await api.sendHunterCandidate(id)
      addToast('Enviada para a fila de Aprovação', 'success')
      await load()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao enviar', 'error')
    }
  }

  const summary = cfg.lastRunSummary
  const modeInfo = MODES.find((m) => m.value === cfg.mode)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Mode */}
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title"><Icon name="zap" size={16} style={{ color: 'var(--text-accent)' }} />{nicheName}</div>
          <span className="panel-meta">última busca {ago(cfg.lastRunAt)}</span>
        </div>
        <div className="panel-body">
          <div style={{ overflowX: 'auto' }}>
            <div className="tabs">
              {MODES.map((m) => (
                <button key={m.value} className={`tab${cfg.mode === m.value ? ' active' : ''}`} onClick={() => set('mode', m.value)}>{m.label}</button>
              ))}
            </div>
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 10 }}>{modeInfo?.hint}</div>
          {summary && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14, alignItems: 'center' }}>
              <span className="badge">{summary.found} analisados</span>
              <span className="badge badge-sent">{summary.passed} passaram</span>
              <span className="badge badge-approved">{summary.newCandidates} novos</span>
              {Object.entries(summary.rejected).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, n]) => (
                <span key={r} className="badge" style={{ color: 'var(--text-muted)' }}>{n} × {r}</span>
              ))}
              {summary.errors.length > 0 && <span className="badge badge-rejected" title={summary.errors.join('\n')}>{summary.errors.length} erro(s): {summary.errors[0].slice(0, 60)}</span>}
            </div>
          )}
        </div>
      </section>

      {/* What to look for */}
      <section className="panel">
        <div className="panel-header"><div className="panel-title"><Icon name="sparkles" size={16} style={{ color: 'var(--text-accent)' }} />O que procurar</div></div>
        <div className="panel-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Palavras-chave (uma por linha)</label>
            <textarea className="textarea" rows={6} value={cfg.keywords} onChange={(e) => set('keywords', e.target.value)} placeholder={'perfume\nsérum facial\nprotetor solar'} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Palavras proibidas no título</label>
            <textarea className="textarea" rows={6} value={cfg.forbiddenWords} onChange={(e) => set('forbiddenWords', e.target.value)} placeholder={'réplica\ninspirado\ncontratipo'} />
          </div>
        </div>
        <div className="panel-body" style={{ paddingTop: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14 }}>
          <NumField label="Preço mínimo" value={cfg.minPrice} onChange={(v) => set('minPrice', v)} suffix="R$" placeholder="sem mínimo" />
          <NumField label="Preço máximo" value={cfg.maxPrice} onChange={(v) => set('maxPrice', v)} suffix="R$" placeholder="sem máximo" />
          <NumField label="Avaliação mínima" value={cfg.minRating} onChange={(v) => set('minRating', v ?? 0)} step={0.1} suffix="★" />
          <NumField label="Vendas mínimas" value={cfg.minSales} onChange={(v) => set('minSales', v ?? 0)} />
          <NumField label="Comissão mínima" value={cfg.minCommissionPct} onChange={(v) => set('minCommissionPct', v ?? 0)} suffix="%" />
          <NumField label="Desconto mínimo" value={cfg.minDiscountPct} onChange={(v) => set('minDiscountPct', v ?? 0)} suffix="%" />
          <NumField label="Nota mínima (0–100)" value={cfg.minScore} onChange={(v) => set('minScore', v ?? 0)} />
          {cfg.mode === 'AUTO_BEST' && <NumField label="Nota p/ enviar sozinha" value={cfg.autoMinScore} onChange={(v) => set('autoMinScore', v ?? 0)} />}
        </div>
        <div className="panel-body" style={{ paddingTop: 0 }}>
          <Toggle checked={cfg.officialOnly} onChange={(v) => set('officialOnly', v)} label="Só lojas oficiais (Shopee Mall)" />
        </div>
      </section>

      {/* Sending */}
      <section className="panel">
        <div className="panel-header"><div className="panel-title"><Icon name="send" size={16} style={{ color: 'var(--text-accent)' }} />Envio</div></div>
        <div className="panel-body">
          <label className="label">Enviar para</label>
          {destinations.length === 0 ? (
            <div style={{ fontSize: '0.84rem', color: 'var(--text-muted)' }}>Nenhum grupo de destino cadastrado (Grupos → Destino).</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {destinations.map((d) => {
                const on = destIds.includes(d.id)
                return (
                  <label key={d.id} className="badge" style={{ height: 32, padding: '0 12px', cursor: 'pointer', gap: 8, fontSize: '0.82rem', color: on ? 'var(--text-primary)' : 'var(--text-muted)', background: on ? 'var(--accent-primary-dim)' : 'rgba(255,255,255,0.03)', borderColor: on ? 'rgba(124,108,255,0.35)' : 'var(--border-subtle)' }}>
                    <input type="checkbox" checked={on} onChange={(e) => setDestIds(e.target.checked ? [...destIds, d.id] : destIds.filter((x) => x !== d.id))} style={{ accentColor: 'var(--accent-primary)' }} />
                    {d.name}
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{d.type === 'WHATSAPP' ? 'WhatsApp' : 'Telegram'}</span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
        <div className="panel-body" style={{ paddingTop: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14 }}>
          <NumField label="Ofertas por dia (máx.)" value={cfg.dailyLimit} onChange={(v) => set('dailyLimit', v ?? 0)} />
          <NumField label="Intervalo entre ofertas" value={cfg.minIntervalMin} onChange={(v) => set('minIntervalMin', v ?? 0)} suffix="min" />
          <NumField label="Silêncio a partir de" value={cfg.quietStart} onChange={(v) => set('quietStart', v ?? 0)} suffix="h" />
          <NumField label="Silêncio até" value={cfg.quietEnd} onChange={(v) => set('quietEnd', v ?? 0)} suffix="h" />
          <NumField label="Buscar a cada" value={cfg.intervalHours} onChange={(v) => set('intervalHours', v ?? 1)} suffix="h" />
        </div>
        <div className="panel-body" style={{ paddingTop: 0 }}>
          <Toggle checked={cfg.useCoupons} onChange={(v) => set('useCoupons', v)} label="Usar cupons neste nicho (quando os cupons estiverem ligados)" />
        </div>
        <div className="panel-body" style={{ paddingTop: 0, display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={run} disabled={busy !== null}>
            {busy === 'run' ? <span className="spinner spinner-sm" /> : <Icon name="refresh" />} Salvar e buscar agora
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy !== null}>
            {busy === 'save' ? <span className="spinner spinner-sm" /> : <Icon name="check" />} Salvar
          </button>
        </div>
      </section>

      {/* Quick API test */}
      <section className="panel">
        <div className="panel-header"><div className="panel-title"><Icon name="activity" size={16} style={{ color: 'var(--text-accent)' }} />Testar uma palavra-chave na API</div></div>
        <div className="panel-body">
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input" value={testKeyword} onChange={(e) => setTestKeyword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && test()} placeholder="ex.: perfume masculino" />
            <button className="btn btn-secondary" onClick={test} disabled={busy !== null}>{busy === 'test' ? <span className="spinner spinner-sm" /> : 'Testar'}</button>
          </div>
          {testResult && (
            testResult.ok ? (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{testResult.count} produtos · campos devolvidos: {testResult.fields?.join(', ')}</div>
                {testResult.products?.map((p, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: '0.82rem' }}>
                    {p.imageUrl && <img src={p.imageUrl} alt="" style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover' }} />}
                    <span className="truncate" style={{ flex: 1 }}>{p.name}</span>
                    <span className="tabular">{brl(p.priceMin)}</span>
                    <span className="tabular" style={{ width: 52, color: 'var(--text-muted)' }}>{p.discountPct ? `-${p.discountPct}%` : ''}</span>
                    <span className="tabular" style={{ width: 70, color: 'var(--text-muted)' }}>{p.rating ? `★ ${p.rating}` : ''}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="alert alert-error" style={{ marginTop: 12 }}><Icon name="alert" size={16} /> {testResult.message}</div>
            )
          )}
        </div>
      </section>

      {/* Found products */}
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title"><Icon name="bag" size={16} style={{ color: 'var(--text-accent)' }} />Produtos encontrados</div>
          <span className="panel-meta">últimos 3 dias</span>
        </div>
        {candidates.length === 0 ? (
          <div className="panel-body" style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Nada ainda. Coloque palavras-chave, deixe em <strong>Prévia</strong> e clique em "Salvar e buscar agora".
          </div>
        ) : (
          <div className="table-wrapper" style={{ border: 'none', borderRadius: 0, boxShadow: 'none' }}>
            <table>
              <thead>
                <tr>
                  <th>Produto</th>
                  <th style={{ textAlign: 'right' }}>Preço</th>
                  <th style={{ textAlign: 'right' }}>Desconto</th>
                  <th style={{ textAlign: 'right' }}>Nota</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={c.id}>
                    <td style={{ maxWidth: 380 }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        {c.product?.imageUrl && <img src={c.product.imageUrl} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />}
                        <div style={{ minWidth: 0 }}>
                          <a href={c.product?.productLink ?? '#'} target="_blank" rel="noreferrer" className="truncate" style={{ display: 'block', color: 'var(--text-primary)', fontSize: '0.84rem' }}>{c.product?.name}</a>
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                            "{c.keyword}" · ★ {c.product?.ratingStar ?? '—'} · {c.product?.sales?.toLocaleString('pt-BR') ?? '—'} vendidos · {c.product?.commissionPct ? `${c.product.commissionPct.toFixed(1)}% comissão` : ''}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="tabular" style={{ textAlign: 'right' }}>
                      {brl(c.price)}
                      {c.originalPrice && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textDecoration: 'line-through' }}>{brl(c.originalPrice)}</div>}
                    </td>
                    <td className="tabular" style={{ textAlign: 'right' }} title={c.discountSource === 'HISTORY' ? 'Comparado com o preço normal no nosso histórico' : 'Desconto anunciado pela Shopee'}>
                      {c.discountPct ? `-${Math.round(c.discountPct)}%` : '—'}
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{c.discountSource === 'HISTORY' ? 'histórico' : 'anunciado'}</div>
                    </td>
                    <td className="tabular" style={{ textAlign: 'right', fontWeight: 600 }} title={c.scoreDetail ? Object.entries(c.scoreDetail).map(([k, v]) => `${k}: ${v}`).join(' · ') : ''}>{c.score}</td>
                    <td><span className={STATUS_LABEL[c.status].cls}>{STATUS_LABEL[c.status].label}</span></td>
                    <td style={{ textAlign: 'right' }}>
                      {(c.status === 'PREVIEW' || c.status === 'READY') && (
                        <button className="btn btn-ghost btn-sm" onClick={() => sendCandidate(c.id)} title="Mandar para a fila de Aprovação agora">
                          <Icon name="send" /> Aprovação
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

// ── Coupons tab ─────────────────────────────────────────────────────────────

function CouponsTab() {
  const { addToast } = useToast()
  const [data, setData] = useState<{ enabled: boolean; coupons: Coupon[] } | null>(null)

  const load = useCallback(() => {
    api.getCoupons().then(setData).catch((err) => addToast(err instanceof Error ? err.message : 'Erro', 'error'))
  }, [addToast])
  useEffect(load, [load])

  if (!data) return <Skeleton height={300} borderRadius={14} />
  const toggle = async (v: boolean) => {
    setData({ ...data, enabled: v })
    try {
      await api.setCouponsEnabled(v)
      addToast(v ? 'Cupons ligados — entram nas próximas ofertas' : 'Cupons desligados', 'success')
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro', 'error')
      load()
    }
  }
  const desc = (c: Coupon) =>
    c.discountType === 'FIXED' ? `${brl(c.value)} OFF` : `${c.value}% OFF${c.maxDiscount ? ` (máx. ${brl(c.maxDiscount)})` : ''}`
  const statusBadge = (c: Coupon) =>
    c.status === 'ACTIVE' ? <span className="badge badge-sent">Ativo</span> : c.status === 'EXHAUSTED' ? <span className="badge badge-rejected">Esgotado</span> : <span className="badge">Expirado</span>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section className="panel">
        <div className="panel-body" style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <Toggle checked={data.enabled} onChange={toggle} />
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Usar cupons nas ofertas da busca</div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              Os cupons são lidos sozinhos das mensagens da Shopee nos seus grupos de origem. Mesmo desligado, a lista continua sendo
              atualizada — ao ligar, o melhor cupom ativo entra como "🎟️ Com o cupom X: R$ Y".
            </div>
          </div>
        </div>
      </section>

      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Cupom</th>
              <th>Desconto</th>
              <th style={{ textAlign: 'right' }}>Compra mínima</th>
              <th>Validade</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Canais</th>
              <th style={{ textAlign: 'right' }}>Usado</th>
              <th>Visto por último</th>
            </tr>
          </thead>
          <tbody>
            {data.coupons.length === 0 ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 28, color: 'var(--text-muted)' }}>Nenhum cupom detectado ainda — eles aparecem conforme os canais postam cupons da Shopee.</td></tr>
            ) : (
              data.coupons.map((c) => (
                <tr key={c.id} title={c.sample ?? ''}>
                  <td className="primary mono">{c.code}</td>
                  <td>{desc(c)}</td>
                  <td className="tabular" style={{ textAlign: 'right' }}>{brl(c.minSpend)}</td>
                  <td>{c.validUntil ? new Date(c.validUntil).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'não informada'}</td>
                  <td>{statusBadge(c)}{c.endReason && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{c.endReason}</div>}</td>
                  <td className="tabular" style={{ textAlign: 'right' }}>{c.sourceCount}</td>
                  <td className="tabular" style={{ textAlign: 'right' }}>{c.usedCount}</td>
                  <td>{ago(c.lastSeenAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function ShopeeHunter() {
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<'niches' | 'coupons'>(params.get('tab') === 'coupons' ? 'coupons' : 'niches')
  const [list, setList] = useState<HunterListItem[] | null>(null)
  const [destinations, setDestinations] = useState<DestinationGroup[]>([])
  const selected = params.get('niche') ?? ''

  const loadList = useCallback(() => {
    api.getHunters().then((l) => {
      setList(l)
      if (!params.get('niche') && l.length) setParams({ niche: l[0].nicheId }, { replace: true })
    }).catch(() => setList([]))
  }, [params, setParams])

  useEffect(() => {
    loadList()
    api.getDestinationGroups().then(setDestinations).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Busca Shopee</h1>
          <p className="page-subtitle">Encontra produtos com preço bom na Shopee e envia para os grupos de cada nicho.</p>
        </div>
        <div className="tabs">
          <button className={`tab${tab === 'niches' ? ' active' : ''}`} onClick={() => setTab('niches')}><Icon name="users" size={15} /> Nichos</button>
          <button className={`tab${tab === 'coupons' ? ' active' : ''}`} onClick={() => setTab('coupons')}><Icon name="bag" size={15} /> Cupons</button>
        </div>
      </div>

      {tab === 'coupons' ? (
        <CouponsTab />
      ) : list === null ? (
        <Skeleton height={400} borderRadius={14} />
      ) : list.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon"><Icon name="users" size={24} /></span>
          <span className="empty-state-title">Nenhum nicho criado</span>
          <span className="empty-state-desc">Crie um nicho em Grupos → Nichos e volte aqui para configurar a busca dele.</span>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }} className="hunter-grid">
          <section className="panel">
            <div className="panel-header"><div className="panel-title">Nichos</div></div>
            <div>
              {list.map((n) => (
                <button
                  key={n.nicheId}
                  className="list-row"
                  onClick={() => setParams({ niche: n.nicheId })}
                  style={{ width: '100%', textAlign: 'left', background: selected === n.nicheId ? 'var(--accent-primary-dim)' : undefined }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="truncate" style={{ fontSize: '0.86rem', fontWeight: 550, color: 'var(--text-primary)' }}>{n.nicheName}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      {n.keywords} palavra{n.keywords === 1 ? '' : 's'}-chave · {n.last24h.sent + n.last24h.queued} ofertas em 24h
                    </div>
                  </div>
                  <span className="badge" style={{ color: MODE_BADGE[n.mode].color }}>{MODE_BADGE[n.mode].label}</span>
                </button>
              ))}
            </div>
          </section>
          {selected ? <NicheEditor key={selected} nicheId={selected} destinations={destinations} onSaved={loadList} /> : <div />}
        </div>
      )}
      <style>{`@media (max-width: 900px) { .hunter-grid { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  )
}
