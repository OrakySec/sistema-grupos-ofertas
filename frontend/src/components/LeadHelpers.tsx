import React, { useCallback, useEffect, useState } from 'react'
import api, { type HelperSafety, type LeadCampaignItem, type LeadHelperItem } from '../lib/api'
import { useToast } from '../lib/toast'
import Icon from './Icon'
import Modal from './Modal'
import Toggle from './Toggle'
import { Skeleton } from './LoadingSkeleton'

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const int = (v: number) => v.toLocaleString('pt-BR')
const fmtPhone = (n: string) => {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(n)
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : n
}
const when = (iso: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  const sameDay = d.toDateString() === new Date().toDateString()
  return d.toLocaleString('pt-BR', sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function NumField({ label, value, onChange, min, max, suffix, hint }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; suffix?: string; hint?: string }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label className="label">{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input className="input" type="number" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ maxWidth: 110 }} />
        {suffix && <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{suffix}</span>}
      </div>
      {hint && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  )
}

/* ─── Create / edit a phone ─── */
function HelperModal({ helper, defaults, lists, onClose, onSaved }: {
  helper: LeadHelperItem | null
  defaults: HelperSafety
  lists: LeadCampaignItem[]
  onClose: () => void
  onSaved: () => void
}) {
  const { addToast } = useToast()
  const [label, setLabel] = useState(helper?.label ?? '')
  const [phone, setPhone] = useState(helper?.phone ?? '')
  const [ids, setIds] = useState<string[]>(helper?.campaigns.map((c) => c.id) ?? lists.map((l) => l.id).slice(0, 1))
  const [s, setS] = useState<HelperSafety>(helper?.safety ?? defaults)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof HelperSafety>(k: K, v: HelperSafety[K]) => setS((x) => ({ ...x, [k]: v }))
  const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14 }

  const save = async () => {
    setBusy(true)
    try {
      if (helper) await api.updateLeadHelper(helper.id, { label: label.trim(), phone, campaignIds: ids, safety: s })
      else await api.createLeadHelper({ label: label.trim(), phone, campaignIds: ids, safety: s })
      addToast(helper ? 'Celular atualizado' : 'Celular cadastrado', 'success')
      onSaved(); onClose()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao salvar', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={helper ? `Ajustes · ${helper.label}` : 'Novo celular que adiciona'} width={720}
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => setS(defaults)} style={{ marginRight: 'auto' }}>Voltar ao padrão</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !phone.trim()}>{busy ? <span className="spinner spinner-sm" /> : null} Salvar</button>
        </>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div className="grid-2">
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Nome</label>
            <input className="input" placeholder='Ex.: "Chip 2" ou "Ana"' value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">WhatsApp que recebe a lista</label>
            <input className="input mono" placeholder="(81) 99999-9999" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
        </div>

        <div>
          <div className="label" style={{ marginBottom: 6 }}>Listas que este celular trabalha</div>
          {lists.length === 0 ? (
            <div style={{ fontSize: '0.8rem', color: 'var(--accent-warning)' }}>Nenhuma lista "Adicionar pelo celular" ainda — crie uma em Listas (ou mude uma em Ajustes).</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {lists.map((l) => {
                const on = ids.includes(l.id)
                return (
                  <button key={l.id} type="button" className={`btn btn-sm ${on ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setIds(on ? ids.filter((x) => x !== l.id) : [...ids, l.id])}>
                    {l.name} · {int(l.counts.QUEUED)} na fila
                  </button>
                )
              })}
            </div>
          )}
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
            Ninguém vai para dois celulares: cada pessoa entra em um só lote. O celular precisa ser <strong>admin</strong> dos grupos dessas listas.
          </div>
        </div>

        <div>
          <div className="section-title" style={{ marginBottom: 10 }}>Ritmo</div>
          <div style={grid}>
            <NumField label="Pessoas por dia" value={s.dailyLimit} onChange={(v) => set('dailyLimit', v)} min={1} max={200} suffix="pessoas" />
            <NumField label="Horário do envio" value={s.sendHour} onChange={(v) => set('sendHour', v)} min={0} max={23} suffix="h (Brasília)" hint="A lista do dia chega neste horário." />
            <NumField label="Prazo para adicionar" value={s.expireDays} onChange={(v) => set('expireDays', v)} min={1} max={30} suffix="dias" hint="Quem não for adicionado nesse prazo volta para a fila." />
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {WEEKDAYS.map((d, i) => (
              <button key={d} type="button" className={`btn btn-sm ${s.weekdays.includes(i) ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => set('weekdays', s.weekdays.includes(i) ? s.weekdays.filter((x) => x !== i) : [...s.weekdays, i].sort())}>{d}</button>
            ))}
          </div>
        </div>

        <div>
          <div className="section-title" style={{ marginBottom: 10 }}>Descanso</div>
          <div style={grid}>
            <NumField label="A cada" value={s.restEvery} onChange={(v) => set('restEvery', v)} min={0} max={5000} suffix="pessoas enviadas" hint="0 = sem descanso" />
            <NumField label="Descansar" value={s.restDays} onChange={(v) => set('restDays', v)} min={0} max={30} suffix="dias" />
          </div>
        </div>

        <div>
          <div className="section-title" style={{ marginBottom: 10 }}>Aquecimento</div>
          <Toggle checked={s.warmup} onChange={(v) => set('warmup', v)} label="Começar devagar e aumentar a cada dia até o limite diário" />
          {s.warmup && (
            <div style={{ ...grid, marginTop: 10 }}>
              <NumField label="Começa com" value={s.warmupStart} onChange={(v) => set('warmupStart', v)} min={1} max={200} suffix="por dia" />
              <NumField label="Aumenta" value={s.warmupStep} onChange={(v) => set('warmupStep', v)} min={0} max={100} suffix="por dia" />
            </div>
          )}
        </div>

        <div>
          <div className="label" style={{ marginBottom: 6 }}>Como mandar a lista</div>
          <div className="tabs">
            <button type="button" className={`tab${s.delivery === 'LIST' ? ' active' : ''}`} onClick={() => set('delivery', 'LIST')}>Números na mensagem</button>
            <button type="button" className={`tab${s.delivery === 'EACH' ? ' active' : ''}`} onClick={() => set('delivery', 'EACH')}>Um número por mensagem</button>
            <button type="button" className={`tab${s.delivery === 'VCF' ? ' active' : ''}`} onClick={() => set('delivery', 'VCF')}>Arquivo de contatos</button>
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
            {s.delivery === 'LIST'
              ? 'Uma mensagem com os telefones um embaixo do outro, separados por grupo — copia e cola na busca de "Adicionar participantes", sem salvar contato.'
              : s.delivery === 'EACH'
                ? 'Cada telefone numa mensagem separada: é só tocar e segurar para copiar um por vez (no celular, copiar copia a mensagem inteira).'
                : 'Um arquivo .vcf para salvar todos os contatos de uma vez; depois busca pelo nome do lote.'}
          </div>
        </div>

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="label">Mensagem que acompanha a lista</label>
          <textarea className="textarea" rows={7} value={s.message} onChange={(e) => set('message', e.target.value)} />
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
            Use <span className="mono">{'{{nome}}'}</span>, <span className="mono">{'{{quantidade}}'}</span>, <span className="mono">{'{{instrucoes}}'}</span> (o passo a passo do jeito escolhido acima) e <span className="mono">{'{{grupos}}'}</span> (os grupos com os telefones). Tudo sai pelo número principal.
          </div>
        </div>
      </div>
    </Modal>
  )
}

/* ─── Tab ─── */
export default function LeadHelpers({ lists }: { lists: LeadCampaignItem[] }) {
  const { addToast } = useToast()
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getLeadHelpers>> | null>(null)
  const [editing, setEditing] = useState<LeadHelperItem | 'new' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const manualLists = lists.filter((l) => l.mode === 'MANUAL')

  const load = useCallback(() => api.getLeadHelpers().then(setData).catch((err) => addToast(err instanceof Error ? err.message : 'Erro ao carregar', 'error')), [addToast])
  useEffect(() => { load() }, [load])

  const act = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key)
    try { const msg = await fn(); if (msg) addToast(msg, 'success'); await load() }
    catch (err) { addToast(err instanceof Error ? err.message : 'Erro', 'error') }
    finally { setBusy(null) }
  }

  const statusText = (h: LeadHelperItem) => {
    if (h.paused) return h.pausedReason ?? 'Pausado'
    if (h.restUntil) return `Descansando até ${when(h.restUntil)}`
    if (h.nextAt && new Date(h.nextAt).getTime() <= Date.now() + 60_000) return 'Envia nos próximos minutos'
    return `Próxima lista ${when(h.nextAt)}`
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="alert alert-info" style={{ fontSize: '0.8rem', lineHeight: 1.6 }}>
        <div>
          Todo dia, no horário de cada celular, o <strong>número principal</strong> manda para ele a lista do dia: uma mensagem com as instruções e o <strong>arquivo de contatos</strong>.
          A pessoa salva os contatos e adiciona pelo app do WhatsApp; o sistema confere sozinho quem entrou. Peça para cada celular mandar um <strong>"oi"</strong> para o número principal uma vez antes de começar.
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-primary" onClick={() => setEditing('new')} disabled={!data}><Icon name="smartphone" /> Novo celular</button>
      </div>

      {!data ? <Skeleton height={200} borderRadius={14} /> : data.helpers.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><Icon name="smartphone" size={28} /></div>
          <div className="empty-state-title">Nenhum celular cadastrado</div>
          <div className="empty-state-desc">Cadastre os celulares (seus chips ou pessoas te ajudando) que vão receber as listas para adicionar.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
          {data.helpers.map((h) => (
            <section key={h.id} className="panel">
              <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{h.label}</div>
                    <div className="mono" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{fmtPhone(h.phone)}</div>
                  </div>
                  <span className={`badge ${h.paused ? 'badge-pending' : h.restUntil ? '' : 'badge-sent'}`}>{h.paused ? 'Pausado' : h.restUntil ? 'Descansando' : 'Ativo'}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, fontSize: '0.78rem' }}>
                  <div><div style={{ color: 'var(--text-muted)' }}>Hoje</div><strong>{int(h.sentToday)}/{int(h.limit)}</strong> enviadas</div>
                  <div><div style={{ color: 'var(--text-muted)' }}>Faltam adicionar</div><strong>{int(h.pending)}</strong></div>
                  <div><div style={{ color: 'var(--text-muted)' }}>Entraram</div><strong>{int(h.added)}</strong>{h.addedToday > 0 && <span style={{ color: 'var(--accent-success)' }}> (+{h.addedToday} hoje)</span>}</div>
                </div>
                <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>{statusText(h)}</div>
                {h.lastResult && <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Último: {h.lastResult}</div>}
                <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                  {h.campaigns.length ? h.campaigns.map((c) => c.name).join(' · ') : <span style={{ color: 'var(--accent-warning)' }}>Sem listas — clique em Ajustes</span>}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary btn-sm" disabled={!!busy || h.paused} onClick={() => act(`send-${h.id}`, async () => (await api.sendLeadHelperNow(h.id)).result)}>
                    {busy === `send-${h.id}` ? <span className="spinner spinner-sm" /> : <Icon name="send" size={14} />} Enviar agora
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(h)}>Ajustes</button>
                  {h.paused
                    ? <button className="btn btn-ghost btn-sm" onClick={() => act(`p-${h.id}`, async () => { await api.updateLeadHelper(h.id, { paused: false }); return 'Celular retomado' })}><Icon name="play" size={14} /></button>
                    : <button className="btn btn-ghost btn-sm" onClick={() => act(`p-${h.id}`, async () => { await api.updateLeadHelper(h.id, { paused: true }); return 'Celular pausado' })}><Icon name="pause" size={14} /></button>}
                  {h.restUntil && <button className="btn btn-ghost btn-sm" onClick={() => act(`r-${h.id}`, async () => { await api.endLeadHelperRest(h.id); return 'Descanso encerrado' })}>Encerrar descanso</button>}
                  <button className="btn btn-ghost btn-sm" style={{ color: '#ff8a8e' }} onClick={() => confirm(`Remover "${h.label}"? Quem está na lista dele e ainda não foi adicionado volta para a fila.`) && act(`d-${h.id}`, async () => { await api.deleteLeadHelper(h.id); return 'Celular removido' })}><Icon name="trash" size={14} /></button>
                </div>
              </div>
            </section>
          ))}
        </div>
      )}

      {editing && data && (
        <HelperModal
          helper={editing === 'new' ? null : editing}
          defaults={data.defaults}
          lists={manualLists}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
    </div>
  )
}
