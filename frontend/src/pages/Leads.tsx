import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api, { type LeadCampaignItem, type LeadImportResult, type LeadMode, type LeadQueueStatus, type LeadSafety, type LeadStatus, type ManualBatch } from '../lib/api'
import { useToast } from '../lib/toast'
import Icon from '../components/Icon'
import Modal from '../components/Modal'
import Toggle from '../components/Toggle'
import { Skeleton } from '../components/LoadingSkeleton'
import LeadResults from '../components/LeadResults'
import LeadHelpers from '../components/LeadHelpers'

const int = (v: number) => v.toLocaleString('pt-BR')
const when = (iso: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return d.toLocaleString('pt-BR', sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
const fmtPhone = (n: string) => {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(n)
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : n
}

const STATUS: Record<LeadStatus, { label: string; cls: string; color: string }> = {
  QUEUED: { label: 'Na fila', cls: 'badge-pending', color: 'var(--text-secondary)' },
  ADDED: { label: 'Adicionado', cls: 'badge-sent', color: '#4fe0a4' },
  INVITED: { label: 'Convite enviado', cls: 'badge-approved', color: '#8fb4ff' },
  INVITE_PENDING: { label: 'Convite amanhã', cls: 'badge-pending', color: 'var(--accent-warning)' },
  MANUAL_PENDING: { label: 'No lote (adicionar pelo celular)', cls: 'badge-pending', color: '#f5c26b' },
  ALREADY_MEMBER: { label: 'Já estava', cls: '', color: 'var(--text-muted)' },
  NO_WHATSAPP: { label: 'Sem WhatsApp', cls: '', color: 'var(--text-muted)' },
  BLOCKED: { label: 'Saiu antes', cls: '', color: '#c9a0ff' },
  DUPLICATE: { label: 'Já feito em outra lista', cls: '', color: 'var(--text-muted)' },
  FAILED: { label: 'Falhou', cls: 'badge-failed', color: '#ff8a8e' },
}
const STATUS_ORDER: LeadStatus[] = ['QUEUED', 'ADDED', 'INVITED', 'INVITE_PENDING', 'MANUAL_PENDING', 'ALREADY_MEMBER', 'NO_WHATSAPP', 'BLOCKED', 'DUPLICATE', 'FAILED']

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

/** Reads a .csv/.txt file into the textarea (the API parses phones/names). */
function FilePicker({ onText }: { onText: (t: string) => void }) {
  return (
    <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
      <Icon name="inbox" size={15} /> Importar arquivo (.csv / .txt)
      <input type="file" accept=".csv,.txt,text/csv,text/plain" style={{ display: 'none' }}
        onChange={async (e) => { const f = e.target.files?.[0]; if (f) onText(await f.text()); e.target.value = '' }} />
    </label>
  )
}

function ImportSummary({ r }: { r: LeadImportResult }) {
  return (
    <div className={`alert ${r.created ? 'alert-success' : 'alert-warning'}`} style={{ fontSize: '0.84rem', lineHeight: 1.6 }}>
      {r.fromGroup && (
        <div style={{ marginBottom: 4 }}>
          Grupo "{r.fromGroup.group}": {int(r.fromGroup.total)} membros
          {r.fromGroup.admins ? ` · ${int(r.fromGroup.admins)} admins ignorados` : ''}
          {r.fromGroup.own ? ` · ${int(r.fromGroup.own)} números seus ignorados` : ''}
          {r.fromGroup.hidden ? ` · ${int(r.fromGroup.hidden)} com o número oculto pelo WhatsApp (não dá para adicionar)` : ''}.
        </div>
      )}
      <strong>{int(r.created)}</strong> {r.created === 1 ? 'lead entrou' : 'leads entraram'} na fila.
      {r.blocked ? ` ${int(r.blocked)} já saíram de um grupo seu antes e não serão adicionados.` : ''}
      {r.alreadyInCampaign ? ` ${int(r.alreadyInCampaign)} já estavam nesta lista.` : ''}
      {r.duplicates ? ` ${int(r.duplicates)} repetidos na colagem.` : ''}
      {r.invalid ? ` ${int(r.invalid)} linhas sem telefone válido${r.invalidSamples.length ? ` (ex.: ${r.invalidSamples.slice(0, 3).join(' · ')})` : ''}.` : ''}
    </div>
  )
}

function ConsentBox({ checked, onChange, fromGroup = false }: { checked: boolean; onChange: (v: boolean) => void; fromGroup?: boolean }) {
  return (
    <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: '0.82rem', color: 'var(--text-secondary)', cursor: 'pointer', lineHeight: 1.5 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
      {fromGroup
        ? 'Confirmo que o grupo de origem é meu e assumo a responsabilidade por adicionar os membros dele em outros grupos. (Quem não escolheu entrar tende a denunciar — comece com poucos e acompanhe as saídas.)'
        : 'Confirmo que essas pessoas se cadastraram na minha página e aceitaram entrar no grupo. (Adicionar quem não pediu gera denúncias — e denúncia é o que mais derruba número.)'}
    </label>
  )
}

type NumberOption = { id: string; label: string; purpose: string; connected: boolean; number: string | null }

/** Private invite messages to non-contacts are what got the lead numbers logged out (401 device_removed). */
/** How the list puts people in the group. */
function ModePicker({ value, onChange }: { value: LeadMode; onChange: (m: LeadMode) => void }) {
  return (
    <div>
      <div className="label" style={{ marginBottom: 6 }}>Como colocar as pessoas no grupo</div>
      <div className="tabs">
        <button type="button" className={`tab${value === 'INVITE' ? ' active' : ''}`} onClick={() => onChange('INVITE')}><Icon name="send" size={15} /> Só convite (link no privado)</button>
        <button type="button" className={`tab${value === 'MANUAL' ? ' active' : ''}`} onClick={() => onChange('MANUAL')}><Icon name="smartphone" size={15} /> Adicionar pelo celular</button>
        <button type="button" className={`tab${value === 'ADD' ? ' active' : ''}`} onClick={() => onChange('ADD')}><Icon name="userPlus" size={15} /> Adicionar direto</button>
      </div>
      <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
        {value === 'INVITE'
          ? 'Ninguém é adicionado: cada pessoa recebe a mensagem de convite com o link do grupo (texto e limite por dia em Segurança → "Convites no privado"). Quem entrar pelo link aparece em Resultados.'
          : value === 'MANUAL'
            ? 'O sistema monta o lote do dia e o arquivo de contatos; você adiciona pelo app do celular (que não derruba o número) e o sistema confere sozinho quem entrou. Os números só leem a lista de membros.'
            : 'Tenta adicionar direto ao grupo. Atenção: tentar adicionar quem não tem você nos contatos derrubou os números (Evolution e WAHA).'}
      </div>
    </div>
  )
}

/* ─── "Adicionar pelo celular": today's batch ─── */
function ManualBatchModal({ campaign, onClose }: { campaign: LeadCampaignItem; onClose: () => void }) {
  const { addToast } = useToast()
  const [b, setB] = useState<ManualBatch | null>(null)
  const [size, setSize] = useState(10)
  const [busy, setBusy] = useState<string | null>(null)
  const reload = useCallback(() => api.getManualBatch(campaign.id).then(setB).catch((err) => addToast(err instanceof Error ? err.message : 'Erro', 'error')), [campaign.id, addToast])
  useEffect(() => { reload() }, [reload])

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key)
    try { const msg = await fn(); if (msg) addToast(msg, 'success'); await reload() }
    catch (err) { addToast(err instanceof Error ? err.message : 'Erro', 'error') }
    finally { setBusy(null) }
  }
  const make = () => run('make', async () => {
    const r = await api.makeManualBatch(campaign.id, size)
    const sk = r.skipped.blocked + r.skipped.member + r.skipped.duplicate
    return `${r.batch.length} pessoa(s) no lote${sk ? ` · ${sk} pulada(s) (saíram antes, já estão no grupo ou repetidas)` : ''}${r.groupsFull ? ' · os grupos da lista estão cheios' : ''}`
  })
  const download = () => run('vcf', async () => {
    const v = await api.getManualVcard(campaign.id)
    const url = URL.createObjectURL(new Blob([v.vcf], { type: 'text/vcard' }))
    const a = document.createElement('a')
    a.href = url; a.download = v.filename; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    return `${v.count} contatos no arquivo`
  })
  const check = () => run('check', async () => {
    const r = await api.checkManualBatch(campaign.id)
    const joined = r.results.reduce((s, x) => s + (x.joined ?? 0), 0)
    const skipped = r.results.find((x) => x.skipped)
    if (skipped) addToast(`${skipped.group}: ${skipped.skipped}`, 'error')
    return `${joined} pessoa(s) encontradas no grupo agora`
  })
  const copy = (phone: string) => { navigator.clipboard?.writeText(`+${phone}`).then(() => addToast('Número copiado', 'success')).catch(() => null) }

  return (
    <Modal isOpen onClose={onClose} title={`Lote do dia · ${campaign.name}`} width={680}>
      {!b ? <Skeleton height={160} /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {!b.pending.some((l) => !l.helper) ? (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="label">Quantas pessoas neste lote</label>
                <input className="input" type="number" min={1} max={100} value={size} onChange={(e) => setSize(Number(e.target.value))} style={{ width: 120 }} />
              </div>
              <button className="btn btn-primary" onClick={make} disabled={!!busy || !b.queued}>{busy === 'make' ? <span className="spinner spinner-sm" /> : <Icon name="users" size={15} />} Gerar lote</button>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{int(b.queued)} na fila</span>
            </div>
          ) : (
            <>
              <ol style={{ margin: 0, paddingLeft: 18, fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                <li>No grupo: <strong>Adicionar participantes</strong> → cole cada número na busca e adicione (de 5 em 5, com calma). Use o ícone de copiar ao lado de cada pessoa, ou <strong>"Copiar todos os números"</strong>.</li>
                <li>Prefere salvar os contatos? <strong>Baixe o arquivo</strong> e busque <strong className="mono">{b.prefix}</strong> no app.</li>
                <li>O sistema confere sozinho quem entrou (a cada 15 min) — ou clique em "Conferir agora".</li>
              </ol>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => {
                  const mine = b.pending.filter((l) => !l.helper).map((l) => `+${l.phone}`).join('\n')
                  navigator.clipboard?.writeText(mine).then(() => addToast('Números copiados — um por linha', 'success')).catch(() => addToast('Não consegui copiar', 'error'))
                }}><Icon name="copy" size={14} /> Copiar todos os números</button>
                <button className="btn btn-secondary btn-sm" onClick={download} disabled={!!busy || !b.pending.some((l) => !l.helper)} title="Só os seus — os celulares recebem a lista deles pelo WhatsApp">{busy === 'vcf' ? <span className="spinner spinner-sm" /> : <Icon name="download" size={14} />} Baixar contatos (.vcf)</button>
                <button className="btn btn-secondary btn-sm" onClick={check} disabled={!!busy}>{busy === 'check' ? <span className="spinner spinner-sm" /> : <Icon name="refresh" size={14} />} Conferir agora</button>
                <button className="btn btn-ghost btn-sm" onClick={() => confirm('Marcar todos os pendentes como adicionados? Use só se você adicionou e o sistema não consegue ver os números do grupo.') && run('mark', async () => `${(await api.markManualAdded(campaign.id)).marked} marcados como adicionados`)} disabled={!!busy}>Marcar todos como adicionados</button>
                <button className="btn btn-ghost btn-sm" onClick={() => confirm('Devolver os pendentes para a fila? Eles entram num próximo lote.') && run('requeue', async () => `${(await api.requeueManualBatch(campaign.id)).requeued} de volta para a fila`)} disabled={!!busy}>Devolver pendentes à fila</button>
              </div>
            </>
          )}

          {(b.pending.length > 0 || b.added.length > 0) && (
            <div className="table-wrapper" style={{ maxHeight: 340, overflow: 'auto' }}>
              <table>
                <thead><tr><th>Pessoa</th><th>Grupo</th><th>Situação</th><th></th></tr></thead>
                <tbody>
                  {[...b.pending, ...b.added].map((l) => (
                    <tr key={l.id}>
                      <td>
                        <div>{l.name || '—'}</div>
                        <div className="mono" style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{fmtPhone(l.phone)}</div>
                      </td>
                      <td style={{ fontSize: '0.8rem' }}>{l.group ?? '—'}{l.helper && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>lista do celular {l.helper}</div>}</td>
                      <td>{l.status === 'ADDED'
                        ? <span className="badge badge-sent">Entrou {when(l.at)}</span>
                        : <span className="badge badge-pending">Falta adicionar</span>}</td>
                      <td>{l.status === 'PENDING' && <button className="btn btn-ghost btn-sm" onClick={() => copy(l.phone)} title="Copiar número"><Icon name="copy" size={14} /></button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            O lote já vem sem quem saiu de um dos seus grupos antes, sem quem já está no grupo e sem quem outra lista já colocou. Adicione pelo app do celular — os números conectados só leem a lista de membros.
          </div>
        </div>
      )}
    </Modal>
  )
}

function InviteRiskNote() {
  return (
    <div style={{ fontSize: '0.74rem', color: 'var(--accent-warning)', lineHeight: 1.5 }}>
      Atenção: mensagem com link de grupo para quem não tem você nos contatos é a ação que mais faz o WhatsApp desconectar o número
      (foi o que derrubou os chips em 22/10). Use só com leads que pediram para entrar (página de captura).
    </div>
  )
}

/** Several numbers can work the same list — toggle chips. */
function NumberPicker({ instances, value, onChange }: { instances: NumberOption[]; value: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {instances.map((i) => {
        const on = value.includes(i.id)
        return (
          <button key={i.id} type="button" className={`btn btn-sm ${on ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => onChange(on ? value.filter((x) => x !== i.id) : [...value, i.id])}
            title={i.purpose === 'OFFERS' ? 'Este número posta as ofertas' : undefined}>
            <span className={`status-dot ${i.connected ? 'online' : 'offline'}`} />
            {i.label}{i.number ? ` · ${fmtPhone(i.number)}` : ''}{i.purpose === 'OFFERS' ? ' (ofertas)' : ''}
          </button>
        )
      })}
    </div>
  )
}

function NumbersModal({ campaign, onClose, onSaved }: { campaign: LeadCampaignItem; onClose: () => void; onSaved: () => void }) {
  const { addToast } = useToast()
  const [opts, setOpts] = useState<NumberOption[] | null>(null)
  const [ids, setIds] = useState<string[]>(campaign.instances.map((i) => i.id))
  const [invite, setInvite] = useState(campaign.inviteFallback)
  const [mode, setMode] = useState<LeadMode>(campaign.mode)
  const [follow, setFollow] = useState(campaign.source?.sync ?? false)
  const [srcPick, setSrcPick] = useState<{ jid: string; name: string } | null>(null)
  const [srcGroups, setSrcGroups] = useState<Array<{ jid: string; name: string }> | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.getLeadOptions().then((o) => setOpts(o.instances)).catch(() => setOpts([])) }, [])
  const loadSrcGroups = () => {
    setSrcGroups([])
    api.getLeadSourceGroups().then((r) => setSrcGroups(r.groups.map((g) => ({ jid: g.jid, name: g.name })))).catch((err) => { addToast(err instanceof Error ? err.message : 'Erro ao buscar os grupos', 'error'); setSrcGroups(null) })
  }
  const syncNow = async () => {
    setSyncing(true)
    try { const r = await api.syncLeadSource(campaign.id); addToast(r.result, 'success'); onSaved() }
    catch (err) { addToast(err instanceof Error ? err.message : 'Erro ao atualizar', 'error') }
    finally { setSyncing(false) }
  }
  const save = async () => {
    setBusy(true)
    try { await api.updateLeadCampaign(campaign.id, { instanceIds: ids, inviteFallback: invite, mode, sourceSync: follow, ...(srcPick ? { sourceGroupJid: srcPick.jid, sourceGroupName: srcPick.name } : {}) }); addToast('Ajustes da lista salvos', 'success'); onSaved(); onClose() }
    catch (err) { addToast(err instanceof Error ? err.message : 'Erro ao salvar', 'error') }
    finally { setBusy(false) }
  }
  return (
    <Modal isOpen onClose={onClose} title={`Ajustes · ${campaign.name}`} width={560}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancelar</button><button className="btn btn-primary" onClick={save} disabled={busy || !ids.length}>{busy ? <span className="spinner spinner-sm" /> : null} Salvar</button></>}>
      {!opts ? <Skeleton height={80} /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="label" style={{ marginBottom: -4 }}>Números que trabalham nesta lista</div>
          <NumberPicker instances={opts} value={ids} onChange={setIds} />
          <ModePicker value={mode} onChange={setMode} />
          {mode === 'ADD' && <Toggle checked={invite} onChange={setInvite} label="Mandar o link do grupo no privado para quem a privacidade não deixar adicionar" />}
          {(mode === 'INVITE' || (mode === 'ADD' && invite)) && <InviteRiskNote />}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="label" style={{ marginBottom: 0 }}>Grupo de origem</div>
            {campaign.source || srcPick ? (
              <>
                <div style={{ fontSize: '0.82rem' }}>{srcPick?.name ?? campaign.source?.name ?? 'Grupo'}</div>
                <Toggle checked={follow} onChange={setFollow} label="Acompanhar todo dia: quem entrar nesse grupo vai para a fila desta lista" />
                {campaign.source?.result && <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Última leitura: {campaign.source.result}</div>}
                {campaign.source && !srcPick && (
                  <div><button type="button" className="btn btn-secondary btn-sm" onClick={syncNow} disabled={syncing}>{syncing ? <span className="spinner spinner-sm" /> : <Icon name="refresh" size={14} />} Atualizar agora</button></div>
                )}
              </>
            ) : srcGroups === null ? (
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Esta lista não acompanha nenhum grupo. <button type="button" className="btn btn-ghost btn-sm" onClick={loadSrcGroups}>Escolher grupo de origem</button>
              </div>
            ) : srcGroups.length === 0 ? <Skeleton height={40} /> : (
              <select className="input" defaultValue="" onChange={(e) => { const g = srcGroups.find((x) => x.jid === e.target.value); if (g) { setSrcPick(g); setFollow(true) } }}>
                <option value="" disabled>Escolha o grupo de onde vêm as pessoas…</option>
                {srcGroups.map((g) => <option key={g.jid} value={g.jid}>{g.name}</option>)}
              </select>
            )}
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Os números marcados dividem a fila desta lista: cada pessoa é pega por um só, e cada número respeita os próprios limites (botão Segurança).
            Quem já foi adicionado ou convidado para o mesmo grupo por outra lista é pulado.
          </div>
        </div>
      )}
    </Modal>
  )
}

/* ─── New campaign ─── */
function NewCampaignModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { addToast } = useToast()
  const [opts, setOpts] = useState<Awaited<ReturnType<typeof api.getLeadOptions>> | null>(null)
  const [name, setName] = useState('')
  const [instanceIds, setInstanceIds] = useState<string[]>([])
  const [nicheId, setNicheId] = useState('')
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [inviteFallback, setInviteFallback] = useState(true)
  const [mode, setMode] = useState<LeadMode>('INVITE')
  const [phones, setPhones] = useState('')
  const [source, setSource] = useState<'LIST' | 'GROUP'>('LIST')
  const [sourceGroupId, setSourceGroupId] = useState('') // group JID
  const [srcGroups, setSrcGroups] = useState<Awaited<ReturnType<typeof api.getLeadSourceGroups>> | null>(null)
  const [srcLoading, setSrcLoading] = useState(false)
  const [srcFilter, setSrcFilter] = useState('')
  const [follow, setFollow] = useState(true) // keep following the source group
  const srcGroup = srcGroups?.groups.find((g) => g.jid === sourceGroupId) ?? null

  // Every group the connected numbers are in — fetched live when this source is picked.
  useEffect(() => {
    if (source !== 'GROUP' || srcGroups || srcLoading) return
    setSrcLoading(true)
    api.getLeadSourceGroups()
      .then(setSrcGroups)
      .catch((err) => { addToast(err instanceof Error ? err.message : 'Erro ao buscar os grupos', 'error'); setSrcGroups({ groups: [], errors: [] }) })
      .finally(() => setSrcLoading(false))
  }, [source, srcGroups, srcLoading, addToast])
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LeadImportResult | null>(null)

  useEffect(() => {
    api.getLeadOptions().then((o) => {
      setOpts(o)
      const leadsNumber = o.instances.find((i) => i.purpose === 'LEADS') ?? o.instances[0]
      if (leadsNumber) setInstanceIds([leadsNumber.id])
    }).catch((err) => addToast(err instanceof Error ? err.message : 'Erro', 'error'))
  }, [addToast])

  const niche = opts?.niches.find((n) => n.id === nicheId)
  const groupChoices = (niche ? niche.groups : opts?.groups ?? []).filter((g) => source !== 'GROUP' || !srcGroup || g.id !== srcGroup.registeredId)
  const toggleGroup = (id: string) => setGroupIds((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]))
  const chosenOffers = opts?.instances.some((i) => instanceIds.includes(i.id) && i.purpose === 'OFFERS')
  const lines = phones.split(/\r?\n/).filter((l) => l.trim()).length

  const save = async () => {
    setBusy(true)
    try {
      const r = await api.createLeadCampaign({
        name: name.trim(), nicheId: nicheId || null, instanceIds, groupIds, inviteFallback, mode, consent,
        ...(source === 'GROUP' ? { sourceGroupId, sourceGroupName: srcGroup?.name, sourceSync: follow } : { phones }),
      })
      setResult(r)
      onCreated()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao criar', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Nova lista de leads"
      width={640}
      footer={result ? <button className="btn btn-primary" onClick={onClose}>Fechar</button> : (
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !consent || !name.trim() || !instanceIds.length || !groupIds.length || (source === 'GROUP' && !sourceGroupId)}>
            {busy ? <span className="spinner spinner-sm" /> : <Icon name="userPlus" />} {busy && source === 'GROUP' ? 'Lendo os membros…' : 'Criar e colocar na fila'}
          </button>
        </>
      )}
    >
      {result ? <ImportSummary r={result} /> : !opts ? <Skeleton height={240} /> : opts.instances.length === 0 ? (
        <div className="alert alert-warning">Conecte primeiro um número em <Link to="/whatsapp">WhatsApp</Link> — é ele que vai adicionar as pessoas.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Nome da lista (nicho dos leads)</label>
            <input className="input" placeholder='Ex.: "Captura Casa — outubro"' value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Números que vão adicionar</label>
            <NumberPicker instances={opts.instances} value={instanceIds} onChange={setInstanceIds} />
            {chosenOffers && (
              <div style={{ fontSize: '0.76rem', color: 'var(--accent-warning)', marginTop: 6 }}>
                Este é o número que posta as ofertas. Se ele for bloqueado por adicionar gente, as ofertas param. O ideal é um número separado.
              </div>
            )}
            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
              Marque mais de um para a lista andar mais rápido: eles dividem a mesma fila, cada um com os próprios limites. Todos precisam ser <strong>admin</strong> dos grupos escolhidos abaixo.
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="label">Nicho de destino</label>
            <select className="select" value={nicheId} onChange={(e) => { setNicheId(e.target.value); setGroupIds([]) }}>
              <option value="">— todos os grupos de WhatsApp —</option>
              {opts.niches.filter((n) => n.groups.length).map((n) => <option key={n.id} value={n.id}>{n.name} ({n.groups.length} grupos)</option>)}
            </select>
          </div>

          <div>
            <div className="label" style={{ marginBottom: 6 }}>Grupos (na ordem em que vão encher)</div>
            {groupChoices.length === 0 ? (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Nenhum grupo de WhatsApp ativo{niche ? ' neste nicho' : ''}.</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {groupChoices.map((g) => {
                  const pos = groupIds.indexOf(g.id)
                  return (
                    <button key={g.id} className={`btn btn-sm ${pos >= 0 ? 'btn-primary' : 'btn-secondary'}`} onClick={() => toggleGroup(g.id)}>
                      {pos >= 0 && <span style={{ fontWeight: 700 }}>{pos + 1}.</span>} {g.name}
                    </button>
                  )
                })}
              </div>
            )}
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 6 }}>Quando o 1º grupo chega no limite de membros, o sistema passa para o 2º, e assim por diante.</div>
          </div>

          <ModePicker value={mode} onChange={setMode} />
          {mode === 'ADD' && <Toggle checked={inviteFallback} onChange={setInviteFallback} label="Se a privacidade da pessoa não deixar adicionar, mandar o link do grupo no privado" />}
          {(mode === 'INVITE' || (mode === 'ADD' && inviteFallback)) && <InviteRiskNote />}

          <div>
            <div className="label" style={{ marginBottom: 6 }}>De onde vêm os contatos</div>
            <div className="tabs">
              <button className={`tab${source === 'LIST' ? ' active' : ''}`} onClick={() => { setSource('LIST'); setConsent(false) }}><Icon name="inbox" size={15} /> Telefones / página de captura</button>
              <button className={`tab${source === 'GROUP' ? ' active' : ''}`} onClick={() => { setSource('GROUP'); setConsent(false); setInviteFallback(false) }}><Icon name="users" size={15} /> Membros de um grupo meu</button>
            </div>
          </div>

          {source === 'LIST' ? (
            <div className="form-group" style={{ marginBottom: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                <label className="label" style={{ margin: 0 }}>Telefones {lines ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {int(lines)} linhas</span> : null}</label>
                <FilePicker onText={(t) => setPhones((p) => (p.trim() ? `${p.trim()}\n${t}` : t))} />
              </div>
              <textarea className="textarea mono" rows={7} value={phones} onChange={(e) => setPhones(e.target.value)}
                placeholder={'Um por linha. Pode ter nome junto:\n(11) 91234-5678\nMaria Silva, 21987654321\nnome;telefone (CSV da sua página)'} />
              <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 6 }}>
                Pode deixar vazio e mandar os leads depois, sozinhos, pelo link de webhook da lista.
              </div>
            </div>
          ) : (
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="label">
                Grupo de origem
                {srcGroups && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {int(srcGroups.groups.length)} grupos dos seus números conectados</span>}
              </label>
              {srcLoading || !srcGroups ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', color: 'var(--text-muted)', padding: '8px 0' }}>
                  <span className="spinner spinner-sm" /> Buscando os grupos em que seus números estão…
                </div>
              ) : (
                <>
                  {srcGroups.groups.length > 12 && (
                    <input className="input" placeholder="Filtrar pelo nome do grupo" value={srcFilter} onChange={(e) => setSrcFilter(e.target.value)} style={{ marginBottom: 6 }} />
                  )}
                  <select
                    className="select"
                    value={sourceGroupId}
                    onChange={(e) => {
                      const jid = e.target.value
                      setSourceGroupId(jid)
                      const reg = srcGroups.groups.find((g) => g.jid === jid)?.registeredId
                      if (reg) setGroupIds((ids) => ids.filter((id) => id !== reg))
                    }}
                  >
                    <option value="">— escolha o grupo —</option>
                    {srcGroups.groups
                      .filter((g) => !srcFilter.trim() || g.name.toLowerCase().includes(srcFilter.trim().toLowerCase()) || g.jid === sourceGroupId)
                      .filter((g) => !g.registeredId || !groupIds.includes(g.registeredId))
                      .map((g) => (
                        <option key={g.jid} value={g.jid}>
                          {g.name}{g.size !== null ? ` (${int(g.size)} membros)` : ''}{g.announce ? ' · avisos da comunidade' : ''} · {g.via.join(', ')}
                        </option>
                      ))}
                  </select>
                  {srcGroups.errors.length > 0 && (
                    <div style={{ fontSize: '0.74rem', color: 'var(--accent-warning)', marginTop: 6 }}>Não consegui listar os grupos de: {srcGroups.errors.join(' · ')}</div>
                  )}
                  {srcGroups.groups.length === 0 && (
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 6 }}>Nenhum grupo encontrado. Confira se os números estão conectados em WhatsApp.</div>
                  )}
                </>
              )}
              <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
                O sistema lê os membros na hora de criar. Admins e os seus próprios números ficam de fora, e quem já saiu de algum grupo seu também.
                Membros com o número oculto pelo WhatsApp não têm como ser adicionados.
              </div>
              <div style={{ marginTop: 10 }}>
                <Toggle checked={follow} onChange={setFollow} label="Acompanhar este grupo: todo dia, quem entrar nele vai para a fila desta lista" />
              </div>
            </div>
          )}

          <ConsentBox checked={consent} onChange={setConsent} fromGroup={source === 'GROUP'} />
        </div>
      )}
    </Modal>
  )
}

function AddLeadsModal({ campaign, onClose, onDone }: { campaign: LeadCampaignItem; onClose: () => void; onDone: () => void }) {
  const { addToast } = useToast()
  const [phones, setPhones] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LeadImportResult | null>(null)
  const save = async () => {
    setBusy(true)
    try { setResult(await api.addLeads(campaign.id, phones, consent)); onDone() } catch (err) { addToast(err instanceof Error ? err.message : 'Erro', 'error') } finally { setBusy(false) }
  }
  return (
    <Modal isOpen onClose={onClose} title={`Adicionar leads · ${campaign.name}`} width={560}
      footer={result ? <button className="btn btn-primary" onClick={onClose}>Fechar</button> : (
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !consent || !phones.trim()}>{busy ? <span className="spinner spinner-sm" /> : null} Colocar na fila</button>
        </>
      )}>
      {result ? <ImportSummary r={result} /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}><FilePicker onText={(t) => setPhones((p) => (p.trim() ? `${p.trim()}\n${t}` : t))} /></div>
          <textarea className="textarea mono" rows={8} value={phones} onChange={(e) => setPhones(e.target.value)} placeholder="Um telefone por linha (pode ter nome junto)" />
          <ConsentBox checked={consent} onChange={setConsent} />
        </div>
      )}
    </Modal>
  )
}

function IntakeModal({ campaign, onClose }: { campaign: LeadCampaignItem; onClose: () => void }) {
  const { addToast } = useToast()
  const copy = () => navigator.clipboard.writeText(campaign.intakeUrl).then(() => addToast('Link copiado', 'success')).catch(() => {})
  return (
    <Modal isOpen onClose={onClose} title="Receber leads automaticamente" width={600}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: '0.84rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        <div>Se a sua página de captura (ou ferramenta de formulário) consegue enviar cada cadastro para um <strong>webhook</strong>, use este link. Cada pessoa cai direto na fila desta lista.</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input mono" readOnly value={campaign.intakeUrl} onFocus={(e) => e.target.select()} />
          <button className="btn btn-secondary" onClick={copy}><Icon name="copy" /> Copiar</button>
        </div>
        <div>Método <strong>POST</strong>, corpo em JSON:</div>
        <pre className="mono" style={{ background: 'var(--bg-elevated, rgba(255,255,255,0.04))', padding: 12, borderRadius: 10, margin: 0, fontSize: '0.8rem' }}>{'{ "telefone": "11912345678", "nome": "Maria" }'}</pre>
        <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Também aceita os campos phone, whatsapp ou celular, e name. Guarde o link: quem tiver ele consegue colocar números nesta lista.</div>
      </div>
    </Modal>
  )
}

function LeadsListModal({ campaign, onClose }: { campaign: LeadCampaignItem; onClose: () => void }) {
  const [status, setStatus] = useState<string>('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getCampaignLeads>> | null>(null)
  useEffect(() => {
    setData(null)
    const t = setTimeout(() => api.getCampaignLeads(campaign.id, { status, q, page }).then(setData).catch(() => setData({ total: 0, page: 1, pages: 1, rows: [] })), 250)
    return () => clearTimeout(t)
  }, [campaign.id, status, q, page])
  return (
    <Modal isOpen onClose={onClose} title={`Leads · ${campaign.name}`} width={860}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="input" placeholder="Buscar telefone" value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} style={{ maxWidth: 220 }} />
          <select className="select" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} style={{ maxWidth: 220 }}>
            <option value="">Todos ({int(campaign.total)})</option>
            {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS[s].label} ({int(campaign.counts[s] ?? 0)})</option>)}
            <option value="LEFT">Saíram depois de entrar ({int(campaign.left)})</option>
          </select>
        </div>
        {!data ? <Skeleton height={200} /> : (
          <div className="table-wrapper">
            <table>
              <thead><tr><th>Telefone</th><th>Status</th><th>Detalhe</th><th>Quando</th></tr></thead>
              <tbody>
                {data.rows.length === 0 ? (
                  <tr><td colSpan={4} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>Nenhum lead{status || q ? ' com esse filtro' : ''}.</td></tr>
                ) : data.rows.map((l) => (
                  <tr key={l.id}>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtPhone(l.phone)}{l.name && <div style={{ fontFamily: 'inherit', fontSize: '0.72rem', color: 'var(--text-muted)' }}>{l.name}</div>}</td>
                    <td>
                      <span className={`badge ${STATUS[l.status]?.cls ?? ''}`}>{STATUS[l.status]?.label ?? l.status}</span>
                      {l.leftAt && <div style={{ fontSize: '0.7rem', color: '#c9a0ff', marginTop: 3, whiteSpace: 'nowrap' }}>saiu {when(l.leftAt)} · bloqueado</div>}
                    </td>
                    <td style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                      {l.detail ?? (l.group ? l.group : '—')}
                      {l.number && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>por {l.number}</div>}
                    </td>
                    <td className="tabular" style={{ whiteSpace: 'nowrap', fontSize: '0.78rem' }}>{when(l.processedAt ?? l.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.pages > 1 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', fontSize: '0.8rem' }}>
            <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
            <span>{page} / {data.pages}</span>
            <button className="btn btn-ghost btn-sm" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>Próxima</button>
          </div>
        )}
      </div>
    </Modal>
  )
}

/* ─── Safety settings of a number ─── */
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

function SafetyModal({ instanceId, label, onClose, onSaved }: { instanceId: string; label: string; onClose: () => void; onSaved: () => void }) {
  const { addToast } = useToast()
  const [s, setS] = useState<LeadSafety | null>(null)
  const [defaults, setDefaults] = useState<LeadSafety | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.getLeadSafety(instanceId).then((r) => { setS(r.safety); setDefaults(r.defaults) }).catch(() => {}) }, [instanceId])
  const set = <K extends keyof LeadSafety>(k: K, v: LeadSafety[K]) => setS((x) => (x ? { ...x, [k]: v } : x))
  const save = async () => {
    if (!s) return
    setBusy(true)
    try {
      const r = await api.saveLeadSafety(instanceId, s)
      setS(r.safety)
      addToast('Regras de segurança salvas', 'success')
      onSaved(); onClose()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao salvar', 'error')
    } finally {
      setBusy(false)
    }
  }
  const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14 }
  return (
    <Modal isOpen onClose={onClose} title={`Segurança · ${label}`} width={720}
      footer={
        <>
          {defaults && <button className="btn btn-ghost" onClick={() => setS(defaults)} style={{ marginRight: 'auto' }}>Voltar ao padrão</button>}
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !s}>{busy ? <span className="spinner spinner-sm" /> : null} Salvar</button>
        </>
      }>
      {!s ? <Skeleton height={300} /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div className="alert alert-info" style={{ fontSize: '0.8rem', lineHeight: 1.5 }}>
            Não existe um número "oficialmente seguro" do WhatsApp. Comece baixo e vá subindo aos poucos, de olho em como o número reage.
          </div>

          <div>
            <div className="section-title" style={{ marginBottom: 10 }}>Ritmo</div>
            <div style={grid}>
              <NumField label="Limite por dia" value={s.dailyLimit} onChange={(v) => set('dailyLimit', v)} min={1} max={500} suffix="pessoas" />
              <NumField label="Intervalo mínimo" value={Math.round(s.minDelaySec / 60)} onChange={(v) => set('minDelaySec', v * 60)} min={1} max={360} suffix="min" />
              <NumField label="Intervalo máximo" value={Math.round(s.maxDelaySec / 60)} onChange={(v) => set('maxDelaySec', v * 60)} min={1} max={720} suffix="min" hint="Entre uma adição e outra o sistema sorteia um tempo entre o mínimo e o máximo." />
            </div>
          </div>

          <div>
            <div className="section-title" style={{ marginBottom: 10 }}>Descanso</div>
            <div style={grid}>
              <NumField label="A cada" value={s.restEvery} onChange={(v) => set('restEvery', v)} min={0} max={5000} suffix="adicionados" hint="0 = sem descanso" />
              <NumField label="Descansar" value={s.restDays} onChange={(v) => set('restDays', v)} min={0} max={30} suffix="dias" />
            </div>
          </div>

          <div>
            <div className="section-title" style={{ marginBottom: 10 }}>Horário (Brasília)</div>
            <div style={{ ...grid, alignItems: 'end' }}>
              <NumField label="Das" value={s.startHour} onChange={(v) => set('startHour', v)} min={0} max={23} suffix="h" />
              <NumField label="Até" value={s.endHour} onChange={(v) => set('endHour', v)} min={1} max={24} suffix="h" />
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              {WEEKDAYS.map((d, i) => (
                <button key={d} className={`btn btn-sm ${s.weekdays.includes(i) ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => set('weekdays', s.weekdays.includes(i) ? s.weekdays.filter((x) => x !== i) : [...s.weekdays, i].sort())}>{d}</button>
              ))}
            </div>
          </div>

          <div>
            <div className="section-title" style={{ marginBottom: 10 }}>Aquecimento (número novo)</div>
            <Toggle checked={s.warmup} onChange={(v) => set('warmup', v)} label="Começar devagar e aumentar a cada dia até o limite diário" />
            {s.warmup && (
              <div style={{ ...grid, marginTop: 10 }}>
                <NumField label="Começa com" value={s.warmupStart} onChange={(v) => set('warmupStart', v)} min={1} max={500} suffix="por dia" />
                <NumField label="Aumenta" value={s.warmupStep} onChange={(v) => set('warmupStep', v)} min={0} max={100} suffix="por dia" />
              </div>
            )}
          </div>

          <div>
            <div className="section-title" style={{ marginBottom: 10 }}>Grupos e convites</div>
            <div style={grid}>
              <NumField label="Limite por grupo" value={s.groupCap} onChange={(v) => set('groupCap', v)} min={10} max={1024} suffix="membros" hint="Chegou nisso, passa para o próximo grupo da lista." />
              <NumField label="Convites no privado" value={s.inviteDailyLimit} onChange={(v) => set('inviteDailyLimit', v)} min={0} max={500} suffix="por dia" hint="Para quem a privacidade não deixa adicionar direto." />
              <NumField label="Freio automático" value={s.maxFailStreak} onChange={(v) => set('maxFailStreak', v)} min={1} max={50} suffix="falhas seguidas" hint="Pausa a fila e te avisa no WhatsApp." />
            </div>
            <div className="form-group" style={{ marginTop: 14, marginBottom: 0 }}>
              <label className="label">Mensagem do convite</label>
              <textarea className="textarea" rows={4} value={s.inviteText} onChange={(e) => set('inviteText', e.target.value)} />
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                Use <span className="mono">{'{{nome}}'}</span>, <span className="mono">{'{{grupo}}'}</span> e <span className="mono">{'{{link}}'}</span> (obrigatório). Variações: <span className="mono">{'{Oi|Olá|Oie}'}</span> — o sistema sorteia uma em cada envio, para as mensagens não saírem iguais.
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

/* ─── Page ─── */
type Overview = Awaited<ReturnType<typeof api.getLeadsOverview>>
type Queue = Overview['queues'][number]

function waitingText(q: LeadQueueStatus): string {
  switch (q.waitingFor) {
    case 'paused': return q.pausedReason ?? 'Pausado'
    case 'rest': return `Em descanso até ${when(q.nextAt)}`
    case 'daily_limit': return `Limite de hoje atingido — volta ${when(q.nextAt)}`
    case 'window': return `Fora do horário — volta ${when(q.nextAt)}`
    case 'empty': return 'Fila vazia'
    default: return q.nextAt ? `Próxima ação às ${when(q.nextAt)}` : 'Trabalhando'
  }
}

export default function Leads() {
  const { addToast } = useToast()
  const [data, setData] = useState<Overview | null>(null)
  const [creating, setCreating] = useState(false)
  const [adding, setAdding] = useState<LeadCampaignItem | null>(null)
  const [viewing, setViewing] = useState<LeadCampaignItem | null>(null)
  const [manualFor, setManualFor] = useState<LeadCampaignItem | null>(null)
  const [intake, setIntake] = useState<LeadCampaignItem | null>(null)
  const [safety, setSafety] = useState<{ id: string; label: string } | null>(null)
  const [tab, setTab] = useState<'lists' | 'helpers' | 'results'>('lists')
  const [numbersFor, setNumbersFor] = useState<LeadCampaignItem | null>(null)

  const load = useCallback(() => api.getLeadsOverview().then(setData).catch((err) => addToast(err instanceof Error ? err.message : 'Erro ao carregar', 'error')), [addToast])
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t) }, [load])

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) addToast(ok, 'success'); await load() } catch (err) { addToast(err instanceof Error ? err.message : 'Erro', 'error') }
  }

  const queueCard = (q: Queue) => (
    <section key={q.instanceId} className="panel">
      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <div style={{ fontWeight: 600, display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className={`status-dot ${q.paused ? 'error' : q.instance?.connected ? 'online' : 'offline'}`} />
            {q.instance?.label ?? 'Número removido'}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setSafety({ id: q.instanceId, label: q.instance?.label ?? '' })}><Icon name="shield" size={15} /> Segurança</button>
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: '0.82rem' }}>
          <div><div style={{ fontSize: '1.3rem', fontWeight: 650 }} className="tabular">{q.addsToday}<span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>/{q.limit}</span></div><div style={{ color: 'var(--text-muted)' }}>adicionados hoje</div></div>
          <div><div style={{ fontSize: '1.3rem', fontWeight: 650 }} className="tabular">{q.invitesToday}<span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>/{q.inviteLimit}</span></div><div style={{ color: 'var(--text-muted)' }}>convites hoje</div></div>
          <div><div style={{ fontSize: '1.3rem', fontWeight: 650 }} className="tabular">{int(q.queued + q.invitePending)}</div><div style={{ color: 'var(--text-muted)' }}>na fila</div></div>
          {q.restEvery > 0 && <div><div style={{ fontSize: '1.3rem', fontWeight: 650 }} className="tabular">{q.sinceRest}<span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>/{q.restEvery}</span></div><div style={{ color: 'var(--text-muted)' }}>até o descanso</div></div>}
        </div>
        <div style={{ fontSize: '0.8rem', color: q.paused ? '#ff8a8e' : 'var(--text-secondary)' }}>
          {!q.instance?.connected && !q.paused ? 'Número desconectado — conecte em WhatsApp' : waitingText(q)}
        </div>
        {q.lastResult && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Última: {q.lastResult}</div>}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {q.paused
            ? <button className="btn btn-primary btn-sm" onClick={() => act(() => api.setLeadQueuePaused(q.instanceId, false), 'Fila retomada')}><Icon name="play" size={14} /> Retomar</button>
            : <button className="btn btn-secondary btn-sm" onClick={() => act(() => api.setLeadQueuePaused(q.instanceId, true), 'Fila pausada')}><Icon name="pause" size={14} /> Pausar</button>}
          {q.waitingFor === 'rest' && <button className="btn btn-ghost btn-sm" onClick={() => confirm('Encerrar o descanso agora? O número volta a adicionar pessoas.') && act(() => api.endLeadRest(q.instanceId), 'Descanso encerrado')}>Encerrar descanso</button>}
        </div>
      </div>
    </section>
  )

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Leads</h1>
          <p className="page-subtitle">Pessoas da sua página de captura adicionadas aos grupos aos poucos, sem queimar o número.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="userPlus" /> Nova lista de leads</button>
      </div>

      <div style={{ marginBottom: 16, overflowX: 'auto' }}>
        <div className="tabs">
          <button className={`tab${tab === 'lists' ? ' active' : ''}`} onClick={() => setTab('lists')}><Icon name="inbox" size={15} /> Listas</button>
          <button className={`tab${tab === 'helpers' ? ' active' : ''}`} onClick={() => setTab('helpers')}><Icon name="smartphone" size={15} /> Celulares que adicionam</button>
          <button className={`tab${tab === 'results' ? ' active' : ''}`} onClick={() => setTab('results')}><Icon name="trendUp" size={15} /> Resultados</button>
        </div>
      </div>

      {tab === 'results' ? <LeadResults /> : tab === 'helpers' ? (data ? <LeadHelpers lists={data.campaigns} /> : <Skeleton height={300} borderRadius={14} />) : !data ? <Skeleton height={300} borderRadius={14} /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {data.queues.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
              {data.queues.map(queueCard)}
            </div>
          )}

          {data.campaigns.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon"><Icon name="userPlus" size={28} /></div>
              <div className="empty-state-title">Nenhuma lista ainda</div>
              <div className="empty-state-desc">
                Conecte um número em <Link to="/whatsapp">WhatsApp</Link>, torne-o admin dos grupos e crie uma lista com os telefones da sua página de captura.
              </div>
            </div>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr><th>Lista</th><th>Destino</th><th>Número</th><th>Andamento</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>
                  {data.campaigns.map((c) => {
                    const done = c.total - c.counts.QUEUED - c.counts.INVITE_PENDING - (c.counts.MANUAL_PENDING ?? 0)
                    const pct = c.total ? Math.round((done / c.total) * 100) : 0
                    return (
                      <tr key={c.id}>
                        <td className="primary">
                          {c.name}
                          {c.mode === 'INVITE' && <span className="badge" style={{ marginLeft: 6 }} title="Ninguém é adicionado: cada pessoa recebe o link do grupo no privado">Só convite</span>}
                          {c.source?.sync && <span className="badge" style={{ marginLeft: 6 }} title={`Todo dia, quem entrar em "${c.source.name ?? 'grupo de origem'}" vai para a fila${c.source.result ? `\nÚltima leitura: ${c.source.result}` : ''}`}>↻ acompanha grupo</span>}
                          {c.mode === 'MANUAL' && <span className="badge" style={{ marginLeft: 6 }} title="Você adiciona pelo celular; o sistema prepara o lote e confere quem entrou">Pelo celular</span>}
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{int(c.total)} leads · criada {new Date(c.createdAt).toLocaleDateString('pt-BR')}</div>
                        </td>
                        <td style={{ fontSize: '0.8rem' }}>
                          {c.niche && <div>{c.niche}</div>}
                          <div style={{ color: 'var(--text-muted)', fontSize: '0.74rem' }}>{c.groups.map((g, i) => `${i + 1}. ${g.name}`).join(' · ')}</div>
                        </td>
                        <td style={{ fontSize: '0.8rem' }}>
                          {c.instances.map((i) => (
                            <div key={i.id} style={{ whiteSpace: 'nowrap' }}><span className={`status-dot ${i.connected ? 'online' : 'offline'}`} style={{ marginRight: 6 }} />{i.label}</div>
                          ))}
                          <button className="btn btn-ghost btn-sm" style={{ paddingLeft: 0, fontSize: '0.74rem' }} onClick={() => setNumbersFor(c)}>Ajustes</button>
                        </td>
                        <td style={{ minWidth: 220 }}>
                          <div className="health-bar" title={`${pct}% processados`}>
                            {STATUS_ORDER.filter((s) => s !== 'QUEUED' && c.counts[s]).map((s) => (
                              <span key={s} style={{ width: `${(c.counts[s] / Math.max(1, c.total)) * 100}%`, background: STATUS[s].color }} />
                            ))}
                          </div>
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 6, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                            {STATUS_ORDER.filter((s) => c.counts[s]).map((s) => (
                              <span key={s}><span style={{ color: STATUS[s].color }}>●</span> {STATUS[s].label} {int(c.counts[s])}</span>
                            ))}
                            {c.left > 0 && (
                              <span title="Entraram pelo sistema e depois saíram do grupo — nunca serão adicionados de novo" style={{ color: '#c9a0ff' }}>
                                ↩ Saíram depois {int(c.left)} ({Math.round((c.left / Math.max(1, c.counts.ADDED + c.counts.INVITED)) * 100)}%)
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          {c.status === 'ACTIVE' && c.total > 0 && done === c.total
                            ? <span className="badge">Concluída</span>
                            : <span className={`badge ${c.status === 'ACTIVE' ? 'badge-sent' : c.status === 'PAUSED' ? 'badge-pending' : ''}`}>{c.status === 'ACTIVE' ? 'Ativa' : c.status === 'PAUSED' ? 'Pausada' : 'Concluída'}</span>}
                          {c.pausedReason && <div style={{ fontSize: '0.72rem', color: 'var(--accent-warning)', marginTop: 4, maxWidth: 240 }}>{c.pausedReason}</div>}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            {c.status === 'ACTIVE'
                              ? <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.updateLeadCampaign(c.id, { status: 'PAUSED' }), 'Lista pausada')}><Icon name="pause" size={14} /></button>
                              : <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.updateLeadCampaign(c.id, { status: 'ACTIVE' }), 'Lista retomada')}><Icon name="play" size={14} /></button>}
                            {c.mode === 'MANUAL' && <button className="btn btn-primary btn-sm" onClick={() => setManualFor(c)}><Icon name="smartphone" size={14} /> Lote do dia</button>}
                            <button className="btn btn-ghost btn-sm" onClick={() => setViewing(c)}>Ver leads</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setAdding(c)}>+ Leads</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setIntake(c)} title="Link de webhook"><Icon name="link" size={14} /></button>
                            {c.counts.FAILED > 0 && <button className="btn btn-ghost btn-sm" onClick={() => act(async () => { const r = await api.retryLeads(c.id); addToast(`${r.requeued} de volta para a fila`, 'success') })}>Tentar falhas</button>}
                            <button className="btn btn-ghost btn-sm" style={{ color: '#ff8a8e' }} onClick={() => confirm(`Excluir a lista "${c.name}" e os ${c.total} leads dela?`) && act(() => api.deleteLeadCampaign(c.id), 'Lista excluída')}><Icon name="trash" size={14} /></button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Cada número faz no máximo uma ação por vez, com intervalos sorteados, só no horário configurado e com descanso. Quem não pode ser adicionado direto (privacidade) recebe o link do grupo no privado, se você deixou ligado.
          </div>
        </div>
      )}

      {creating && <NewCampaignModal onClose={() => setCreating(false)} onCreated={load} />}
      {adding && <AddLeadsModal campaign={adding} onClose={() => setAdding(null)} onDone={load} />}
      {viewing && <LeadsListModal campaign={viewing} onClose={() => setViewing(null)} />}
      {manualFor && <ManualBatchModal campaign={manualFor} onClose={() => { setManualFor(null); load() }} />}
      {intake && <IntakeModal campaign={intake} onClose={() => setIntake(null)} />}
      {numbersFor && <NumbersModal campaign={numbersFor} onClose={() => setNumbersFor(null)} onSaved={load} />}
      {safety && <SafetyModal instanceId={safety.id} label={safety.label} onClose={() => setSafety(null)} onSaved={load} />}
    </div>
  )
}
