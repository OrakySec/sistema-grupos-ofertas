import React, { useCallback, useEffect, useRef, useState } from 'react'
import api, { type UnidentifiedLinkDomain, type UnidentifiedLinks } from '../lib/api'
import { useToast } from '../lib/toast'

const WINDOWS = [
  { hours: 24, label: '24h' },
  { hours: 72, label: '3 dias' },
  { hours: 168, label: '7 dias' },
]

function ago(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'agora'
  if (mins < 60) return `há ${mins}min`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `há ${hrs}h`
  return `há ${Math.floor(hrs / 24)}d`
}

function DomainCard({
  d,
  busy,
  onBlock,
  onUnblock,
}: {
  d: UnidentifiedLinkDomain
  busy: boolean
  onBlock: (d: UnidentifiedLinkDomain) => void
  onUnblock: (domain: string) => void
}) {
  const color = d.blocked ? 'var(--accent-success)' : d.rejectedOffers > 0 ? 'var(--accent-danger)' : '#eab308'
  return (
    <div
      style={{
        background: 'var(--surface-1)', border: '1px solid var(--border)', borderLeft: `3px solid ${color}`,
        borderRadius: 10, padding: '14px 16px', opacity: d.blocked ? 0.75 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="font-mono" style={{ fontWeight: 700, fontSize: '0.95rem' }}>
            {d.domain}
            {d.blocked && (
              <span style={{ marginLeft: 8, fontSize: '0.7rem', color: 'var(--accent-success)', fontFamily: 'inherit', fontWeight: 600 }}>
                🧹 sendo removido dos textos
              </span>
            )}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>
            visto pela última vez {ago(d.lastSeenAt)}
            {d.resolvesTo && <> · redireciona pra <span className="font-mono">{d.resolvesTo}</span></>}
          </div>
        </div>

        {d.blocked ? (
          <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onUnblock(d.domain)}>
            ↩️ Parar de remover
          </button>
        ) : (
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => onBlock(d)}>
            {busy ? <span className="spinner spinner-sm" /> : '🧹'} Remover dos textos
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        <span style={{ fontSize: '0.72rem', padding: '2px 9px', borderRadius: 12, background: 'var(--surface-2)' }}>
          Aparições <strong>{d.occurrences}</strong>
        </span>
        <span style={{ fontSize: '0.72rem', padding: '2px 9px', borderRadius: 12, background: 'var(--surface-2)' }}>
          Mensagens <strong>{d.offers}</strong>
        </span>
        <span
          style={{
            fontSize: '0.72rem', padding: '2px 9px', borderRadius: 12, background: 'var(--surface-2)',
            color: d.rejectedOffers > 0 && !d.blocked ? 'var(--accent-danger)' : undefined,
            fontWeight: d.rejectedOffers > 0 ? 700 : 400,
          }}
        >
          Rejeitadas por causa dele <strong>{d.rejectedOffers}</strong>
        </span>
        {d.stripped > 0 && (
          <span style={{ fontSize: '0.72rem', padding: '2px 9px', borderRadius: 12, background: 'var(--surface-2)', color: 'var(--accent-success)' }}>
            Já removidos <strong>{d.stripped}</strong>
          </span>
        )}
      </div>

      {d.looksLikeShortener && !d.blocked && (
        <div
          style={{
            marginTop: 10, fontSize: '0.78rem', padding: '8px 10px', borderRadius: 6,
            background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.25)',
          }}
        >
          ⚠️ Esse link tem cara de <strong>encurtador de loja</strong> (<span className="font-mono">/s/xxxxxx</span>
          {d.resolvesTo ? <>, que leva pra {d.resolvesTo}</> : null}). Se ele esconde uma oferta de verdade, <strong>não remova</strong> —
          você perderia a oferta. O listener já tenta resolver esse tipo de link com um navegador.
        </div>
      )}

      {d.groups.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Vem de:</span>
          {d.groups.map((g) => (
            <span key={g.id} style={{ fontSize: '0.72rem', padding: '2px 8px', borderRadius: 4, background: 'var(--surface-2)' }}>
              {g.name} <strong>{g.count}</strong>
            </span>
          ))}
        </div>
      )}

      {d.samples.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 4 }}>
            Exemplos
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {d.samples.map((s) => (
              <div
                key={s.url}
                className="font-mono"
                title={s.url}
                style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {s.url}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default function UnidentifiedLinksPanel() {
  const { addToast } = useToast()
  const [data, setData] = useState<UnidentifiedLinks | null>(null)
  const [hours, setHours] = useState(72)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyDomain, setBusyDomain] = useState<string | null>(null)
  const [showBlocked, setShowBlocked] = useState(true)
  const requestIdRef = useRef(0)

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    try {
      const res = await api.getUnidentifiedLinks(hours)
      if (requestId !== requestIdRef.current) return
      setData(res)
      setError('')
    } catch (err) {
      if (requestId !== requestIdRef.current) return
      setError(err instanceof Error ? err.message : 'Erro ao carregar os links')
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [hours])

  useEffect(() => {
    load()
    const interval = setInterval(load, 60000)
    return () => clearInterval(interval)
  }, [load])

  const block = async (d: UnidentifiedLinkDomain) => {
    const warning = d.looksLikeShortener
      ? `ATENÇÃO: "${d.domain}" parece um encurtador de loja. Se ele esconde ofertas de verdade, elas serão perdidas.\n\n`
      : ''
    if (
      !confirm(
        `${warning}Remover os links de "${d.domain}" das mensagens?\n\nEles somem do texto (junto com a linha que os apresenta, tipo "Review no link abaixo:") e deixam de causar rejeição. Vale pra todos os grupos.`,
      )
    )
      return
    setBusyDomain(d.domain)
    try {
      await api.addStripDomain(d.domain)
      addToast(`Links de ${d.domain} serão removidos das próximas mensagens.`, 'success')
      await load()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao bloquear o domínio', 'error')
    } finally {
      setBusyDomain(null)
    }
  }

  const unblock = async (domain: string) => {
    setBusyDomain(domain)
    try {
      await api.removeStripDomain(domain)
      addToast(`${domain} voltou a ser tratado normalmente.`, 'success')
      await load()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao desbloquear o domínio', 'error')
    } finally {
      setBusyDomain(null)
    }
  }

  if (!data) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: error ? 'var(--accent-danger)' : 'var(--text-muted)' }}>
        {error || (loading ? 'Carregando links…' : '')}
      </div>
    )
  }

  const active = data.domains.filter((d) => !d.blocked)
  const blocked = data.domains.filter((d) => d.blocked)
  // Blocked domains that weren't seen in this window still need to be manageable.
  const seen = new Set(data.domains.map((d) => d.domain))
  const unseenBlocked = data.blockedDomains.filter((d) => !seen.has(d))

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: '0.85rem' }}>
          <strong style={{ color: data.totals.domains > 0 ? '#eab308' : 'var(--accent-success)' }}>{data.totals.domains}</strong> domínio(s) não
          identificado(s) · <strong style={{ color: data.totals.affectedOffers > 0 ? 'var(--accent-danger)' : 'var(--accent-success)' }}>{data.totals.affectedOffers}</strong>{' '}
          mensagem(ns) rejeitada(s) por causa deles
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {WINDOWS.map((w) => (
            <button key={w.hours} className={`btn btn-sm ${hours === w.hours ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setHours(w.hours)}>
              {w.label}
            </button>
          ))}
          <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>
            {loading ? <span className="spinner spinner-sm" /> : '🔄'}
          </button>
        </div>
      </div>
      <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0 0 16px' }}>
        Links que o sistema não conseguiu ligar a nenhuma loja (Amazon, Shopee, AliExpress, Magalu, Mercado Livre). Cada um faz a mensagem inteira ser
        rejeitada. Se for só um link de review, Instagram ou site do canal, use <strong>Remover dos textos</strong>.
      </p>

      {active.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🎉</div>
          Nenhum link não identificado nas últimas {data.windowHours}h.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {active.map((d) => (
            <DomainCard key={d.domain} d={d} busy={busyDomain === d.domain} onBlock={block} onUnblock={unblock} />
          ))}
        </div>
      )}

      {(blocked.length > 0 || unseenBlocked.length > 0) && (
        <div style={{ marginTop: 28 }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setShowBlocked((v) => !v)}
            style={{ marginBottom: 10 }}
          >
            {showBlocked ? '▼' : '▶'} 🧹 Domínios sendo removidos ({data.blockedDomains.length})
          </button>
          {showBlocked && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {blocked.map((d) => (
                <DomainCard key={d.domain} d={d} busy={busyDomain === d.domain} onBlock={block} onUnblock={unblock} />
              ))}
              {unseenBlocked.map((domain) => (
                <div
                  key={domain}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderRadius: 10,
                    background: 'var(--surface-1)', border: '1px solid var(--border)',
                  }}
                >
                  <span className="font-mono" style={{ flex: 1, fontSize: '0.85rem' }}>{domain}</span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>não apareceu nesse período</span>
                  <button className="btn btn-secondary btn-sm" disabled={busyDomain === domain} onClick={() => unblock(domain)}>
                    ↩️ Parar de remover
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 18, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
        Atualizado {ago(data.generatedAt)} · o histórico de ofertas é apagado após 7 dias, então a janela máxima é 7 dias.
      </div>
    </div>
  )
}
