import React, { useCallback, useEffect, useRef, useState } from 'react'
import api, { type WaNumber, type WaProvider } from '../lib/api'
import { useToast } from '../lib/toast'
import Icon from '../components/Icon'
import Modal from '../components/Modal'
import Toggle from '../components/Toggle'
import { Skeleton } from '../components/LoadingSkeleton'

const POLL_MS = 3000

const fmtPhone = (n: string | null) => {
  if (!n) return null
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(n)
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : `+${n}`
}

const PURPOSE_LABEL: Record<WaNumber['purpose'], string> = { OFFERS: 'Principal', LEADS: 'Adiciona leads' }
const PROVIDER_LABEL: Record<WaProvider, string> = { EVOLUTION: 'Evolution', WAHA: 'WAHA' }
const PROVIDERS: WaProvider[] = ['EVOLUTION', 'WAHA']

/* ─── QR code flow (whatsapp-qrcode skill): loading → qrcode → connected | error ─── */
type QrStatus = 'loading' | 'qrcode' | 'connected' | 'error'

function QrModal({ number, initialQr, onClose, onConnected }: {
  number: WaNumber
  initialQr?: string | null
  onClose: () => void
  onConnected: () => void
}) {
  const [status, setStatus] = useState<QrStatus>(initialQr ? 'qrcode' : 'loading')
  const [qr, setQr] = useState<string | null>(initialQr ?? null)
  const [error, setError] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)
  const started = useRef(false)

  const fail = (msg: string) => { setError(msg); setStatus('error') }

  // fresh = false: the server first tries to bring the session back without a QR.
  const connect = useCallback(async (confirm = false, fresh = false) => {
    setStatus('loading'); setError(null); setResuming(!fresh && !number.connected)
    try {
      const r = await api.connectWaNumber(number.id, confirm, fresh)
      if (r.connected) { setQr(null); setStatus('connected'); onConnected(); return }
      if (r.qrcode) { setQr(r.qrcode); setStatus('qrcode') }
      else fail(`O ${PROVIDER_LABEL[number.provider]} não devolveu o QR Code. Tente "Novo QR" ou "Resetar".`)
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Não foi possível conectar.')
    }
  }, [number.id, number.provider, number.connected, onConnected])

  // Opened without a QR in hand ("Conectar" on an existing number): (re)create it now.
  useEffect(() => {
    if (started.current) return
    started.current = true
    if (!initialQr) connect(number.purpose === 'OFFERS')
  }, [connect, initialQr, number.purpose])

  // While the QR is on screen, check every 3 s whether the phone scanned it.
  useEffect(() => {
    if (status !== 'qrcode') return
    const id = setInterval(async () => {
      try {
        const r = await api.getWaNumberState(number.id)
        if (r.status === 'connected') { setQr(null); setStatus('connected'); onConnected() }
      } catch { /* keep polling */ }
    }, POLL_MS)
    return () => clearInterval(id)
  }, [status, number.id, onConnected])

  const newQr = async () => {
    setStatus('loading')
    try {
      const r = await api.getWaNumberQr(number.id)
      if (r.state === 'open') { setStatus('connected'); onConnected(); return }
      if (r.qrcode) { setQr(r.qrcode); setStatus('qrcode'); return }
      fail(r.error ?? 'Não consegui um QR novo. Use "Resetar" e tente de novo.')
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Erro ao buscar o QR Code.')
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={`Conectar · ${number.label}`} width={460}>
      {status === 'loading' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '36px 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          <span className="spinner" /> {resuming ? 'Tentando reconectar sem QR Code… (se não der, aparece um QR novo)' : 'Preparando a conexão…'}
        </div>
      )}

      {status === 'qrcode' && qr && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          <div style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', textAlign: 'center', lineHeight: 1.5 }}>
            No celular: <strong>WhatsApp → Configurações → Dispositivos conectados → Conectar dispositivo</strong> e aponte para o código.
          </div>
          <img src={qr} alt="QR Code do WhatsApp" width={240} height={240} style={{ background: '#fff', padding: 12, borderRadius: 14 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            <span className="spinner spinner-sm" /> Aguardando a leitura… o código expira em cerca de 60 s.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={newQr}><Icon name="refresh" /> Novo QR</button>
            <button className="btn btn-ghost btn-sm" onClick={() => connect(true, true)}>Resetar conexão</button>
          </div>
        </div>
      )}

      {status === 'connected' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '24px 0', textAlign: 'center' }}>
          <Icon name="checkCircle" size={40} style={{ color: 'var(--accent-success)' }} />
          <div style={{ fontWeight: 600 }}>WhatsApp conectado!</div>
          <button className="btn btn-primary" onClick={onClose}>Fechar</button>
        </div>
      )}

      {status === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="alert alert-error">{error}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => connect(true, true)}>Tentar de novo</button>
            <button className="btn btn-ghost" onClick={onClose}>Fechar</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function NewNumberModal({ hasOffers, providers, defaultProvider, onClose, onCreated }: {
  hasOffers: boolean
  providers: Record<WaProvider, boolean>
  defaultProvider: WaProvider
  onClose: () => void
  onCreated: (n: WaNumber, qr: string | null) => void
}) {
  const { addToast } = useToast()
  const [label, setLabel] = useState('')
  const [purpose, setPurpose] = useState<'OFFERS' | 'LEADS'>(hasOffers ? 'LEADS' : 'OFFERS')
  const [alsoOffers, setAlsoOffers] = useState(true)
  const [provider, setProvider] = useState<WaProvider>(providers[defaultProvider] ? defaultProvider : PROVIDERS.find((p) => providers[p]) ?? defaultProvider)
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    try {
      const r = await api.createWaNumber(label.trim(), purpose, purpose === 'OFFERS' || alsoOffers, provider)
      onCreated(r.instance, r.qrcode)
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao criar a conexão', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Conectar novo número"
      width={480}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={create} disabled={busy}>{busy ? <span className="spinner spinner-sm" /> : <Icon name="qr" />} Gerar QR Code</button>
        </>
      }
    >
      <div className="form-group">
        <label className="label">Nome para identificar</label>
        <input className="input" placeholder='Ex.: "Chip leads 1"' value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} autoFocus />
      </div>
      <div className="form-group">
        <label className="label">API de conexão</label>
        <div className="tabs">
          {PROVIDERS.map((p) => (
            <button key={p} className={`tab${provider === p ? ' active' : ''}`} onClick={() => setProvider(p)} disabled={!providers[p]} title={providers[p] ? undefined : 'Configure em Configurações → WhatsApp'}>
              {PROVIDER_LABEL[p]}{p === defaultProvider ? ' (padrão)' : ''}
            </button>
          ))}
        </div>
        {!providers.WAHA && (
          <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 8 }}>Para usar o WAHA, preencha a URL e a chave dele em Configurações → WhatsApp.</div>
        )}
      </div>
      <div className="form-group" style={{ marginBottom: 0 }}>
        <label className="label">Função deste número</label>
        <div className="tabs">
          <button className={`tab${purpose === 'LEADS' ? ' active' : ''}`} onClick={() => setPurpose('LEADS')}><Icon name="userPlus" size={15} /> Adicionar leads</button>
          <button className={`tab${purpose === 'OFFERS' ? ' active' : ''}`} onClick={() => setPurpose('OFFERS')}><Icon name="send" size={15} /> Número principal</button>
        </div>
        <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
          {purpose === 'LEADS'
            ? 'Recomendado: um número separado do principal. Se ele for bloqueado, as ofertas continuam saindo. Ele precisa ser admin dos grupos.'
            : hasOffers
              ? 'Este número passa a ser o principal (posta ofertas, manda os alertas e coleta o Analytics) no lugar do atual.'
              : 'O número principal posta as ofertas, manda os alertas e coleta o Analytics.'}
        </div>
        {purpose === 'LEADS' && (
          <div style={{ marginTop: 12 }}>
            <Toggle checked={alsoOffers} onChange={setAlsoOffers} label="Também postar ofertas nos grupos em que for admin (aquece o número)" />
          </div>
        )}
      </div>
    </Modal>
  )
}

export default function WhatsApp() {
  const { addToast } = useToast()
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getWaNumbers>> | null>(null)
  const [creating, setCreating] = useState(false)
  const [qrFor, setQrFor] = useState<{ number: WaNumber; qr?: string | null } | null>(null)
  const [checking, setChecking] = useState(false)

  const load = useCallback(() => api.getWaNumbers().then(setData).catch((err) => addToast(err instanceof Error ? err.message : 'Erro ao carregar', 'error')), [addToast])
  useEffect(() => { load() }, [load])

  const check = async () => {
    setChecking(true)
    try {
      const list = PROVIDERS.filter((p) => data?.providers?.[p])
      for (const p of list.length ? list : [undefined]) {
        const r = await api.checkEvolution(p)
        addToast(r.message, r.ok ? 'success' : 'error')
      }
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao testar', 'error')
    } finally {
      setChecking(false)
    }
  }

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); addToast(ok, 'success'); await load() } catch (err) { addToast(err instanceof Error ? err.message : 'Erro', 'error') }
  }

  const logout = (n: WaNumber) => {
    if (!confirm(`Desconectar "${n.label}"? Será preciso escanear o QR Code de novo.${n.purpose === 'OFFERS' ? '\n\nATENÇÃO: este número posta as ofertas — os envios para o WhatsApp param até reconectar.' : ''}`)) return
    act(() => api.logoutWaNumber(n.id), 'Número desconectado')
  }
  const remove = (n: WaNumber) => {
    if (!confirm(`Remover "${n.label}" do sistema e do ${PROVIDER_LABEL[n.provider]}?`)) return
    if (n.purpose === 'OFFERS' && !confirm('Este número posta as ofertas. Remover PARA os envios para o WhatsApp. Confirmar mesmo assim?')) return
    act(() => api.deleteWaNumber(n.id, n.purpose === 'OFFERS'), 'Número removido')
  }
  const makeOffers = (n: WaNumber) => {
    if (!confirm(`Tornar "${n.label}" o número principal (alertas, Analytics e reserva das ofertas)? O principal atual passa a ser de leads.`)) return
    act(() => api.updateWaNumber(n.id, { purpose: 'OFFERS' }), 'Este número agora é o principal')
  }
  const switchProvider = async (n: WaNumber) => {
    const to: WaProvider = n.provider === 'WAHA' ? 'EVOLUTION' : 'WAHA'
    if (!confirm(`Passar "${n.label}" do ${PROVIDER_LABEL[n.provider]} para o ${PROVIDER_LABEL[to]}?\n\nA conexão atual é apagada e você escaneia um QR Code novo com o mesmo celular. As listas, regras e histórico do número continuam.${n.purpose === 'OFFERS' ? '\n\nATENÇÃO: este é o número principal — os envios param até escanear o QR.' : ''}`)) return
    try {
      const r = await api.switchWaProvider(n.id, to, true)
      await load()
      setQrFor({ number: r.instance, qr: r.qrcode })
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao trocar de API', 'error')
    }
  }
  const reconnect = (n: WaNumber) => {
    if (n.purpose === 'OFFERS' && n.connected && !confirm('Este número posta as ofertas. Reconectar derruba os envios até escanear o QR de novo. Continuar?')) return
    setQrFor({ number: n })
  }

  const instances = data?.instances ?? []
  const hasOffers = instances.some((i) => i.purpose === 'OFFERS')

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">WhatsApp</h1>
          <p className="page-subtitle">Números conectados por QR Code. As ofertas saem por um número sorteado entre os que têm "Envia ofertas" e são admin do grupo.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={check} disabled={checking}>{checking ? <span className="spinner spinner-sm" /> : <Icon name="activity" />} Testar APIs</button>
          <button className="btn btn-primary" onClick={() => setCreating(true)} disabled={!data || !data.configured || instances.length >= data.max}>
            <Icon name="qr" /> Conectar novo número
          </button>
        </div>
      </div>

      {!data ? (
        <Skeleton height={220} borderRadius={14} />
      ) : (
        <>
          {!data.configured && (
            <div className="alert alert-warning" style={{ marginBottom: 16 }}>
              Nenhuma API de WhatsApp configurada. Preencha em Configurações → WhatsApp a URL e a chave <strong>global</strong> da Evolution ou a URL e a chave do WAHA (ou as variáveis EVOLUTION_API_URL/KEY ou WAHA_API_URL/KEY do servidor).
            </div>
          )}

          {instances.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon"><Icon name="smartphone" size={28} /></div>
              <div className="empty-state-title">Nenhum número conectado</div>
              <div className="empty-state-desc">Clique em "Conectar novo número" e escaneie o QR Code com o WhatsApp do celular.</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
              {instances.map((n) => (
                <section key={n.id} className="panel">
                  <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className={`status-dot ${n.connected ? 'online pulse' : n.lastState === 'connecting' ? 'warning' : 'offline'}`} />
                          {n.label}
                        </div>
                        <div className="mono" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                          {fmtPhone(n.number) ?? 'número ainda não lido'}
                          {n.profileName && <span style={{ color: 'var(--text-muted)' }}> · {n.profileName}</span>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                        <span className={`badge ${n.purpose === 'OFFERS' ? 'badge-whatsapp' : 'badge-approved'}`}>{PURPOSE_LABEL[n.purpose]}</span>
                        <span className="badge" title="API por onde este número está conectado">{PROVIDER_LABEL[n.provider]}</span>
                      </div>
                    </div>
                    <div style={{ fontSize: '0.78rem', color: n.connected ? 'var(--accent-success)' : 'var(--text-muted)' }}>
                      {n.connected ? 'Online' : n.lastState === 'not_found' ? `Conexão apagada no ${PROVIDER_LABEL[n.provider]} — conecte de novo` : n.lastState === 'connecting' ? 'Aguardando leitura do QR Code' : 'Desconectado'}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <Toggle checked={n.sendsOffers} onChange={(v) => act(() => api.updateWaNumber(n.id, { sendsOffers: v }), v ? 'Este número passa a postar ofertas' : 'Este número não posta mais ofertas')} label="Envia ofertas" />
                      {n.sendsOffers && <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{n.offersToday} {n.offersToday === 1 ? 'oferta' : 'ofertas'} hoje</span>}
                    </div>
                    {n.lastDisconnectAt && (
                      <div style={{ fontSize: '0.74rem', color: [401, 402, 403, 406].includes(n.lastDisconnectCode ?? 0) ? '#ff8a8e' : 'var(--text-muted)', lineHeight: 1.45 }}>
                        Última queda: {new Date(n.lastDisconnectAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} — {n.lastDisconnectText}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {n.connected ? (
                        <button className="btn btn-secondary btn-sm" onClick={() => logout(n)}>Desconectar</button>
                      ) : (
                        <button className="btn btn-primary btn-sm" onClick={() => reconnect(n)}><Icon name="qr" size={15} /> Conectar</button>
                      )}
                      {n.connected && <button className="btn btn-ghost btn-sm" onClick={() => reconnect(n)}>Reconectar</button>}
                      {n.purpose === 'LEADS' && <button className="btn btn-ghost btn-sm" onClick={() => makeOffers(n)} title="Principal: manda os alertas e coleta o Analytics">Tornar principal</button>}
                      {data.providers[n.provider === 'WAHA' ? 'EVOLUTION' : 'WAHA'] && (
                        <button className="btn btn-ghost btn-sm" onClick={() => switchProvider(n)} title="Apaga a conexão atual e gera um QR Code na outra API">
                          Mudar para {PROVIDER_LABEL[n.provider === 'WAHA' ? 'EVOLUTION' : 'WAHA']}
                        </button>
                      )}
                      <button className="btn btn-ghost btn-sm" onClick={() => remove(n)} style={{ color: '#ff8a8e' }}><Icon name="trash" size={15} /></button>
                    </div>
                  </div>
                </section>
              ))}
            </div>
          )}

          <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.6 }}>
            {instances.length} de {data.max} números usados. Para cada grupo, a oferta sai por um número sorteado entre os conectados com "Envia ofertas" que são <strong>admin</strong> daquele grupo; sem nenhum, sai pelo principal.
            Um número novo pode ficar só postando ofertas por um tempo (aquecendo) antes de ir para a adição de leads. As regras de segurança da adição ficam na aba <strong>Leads</strong>.
          </div>
        </>
      )}

      {creating && (
        <NewNumberModal
          hasOffers={hasOffers}
          providers={data?.providers ?? { EVOLUTION: true, WAHA: false }}
          defaultProvider={data?.defaultProvider ?? 'EVOLUTION'}
          onClose={() => setCreating(false)}
          onCreated={(n, qr) => { setCreating(false); load(); setQrFor({ number: n, qr }) }}
        />
      )}
      {qrFor && (
        <QrModal
          number={qrFor.number}
          initialQr={qrFor.qr}
          onClose={() => { setQrFor(null); load() }}
          onConnected={load}
        />
      )}
    </div>
  )
}
