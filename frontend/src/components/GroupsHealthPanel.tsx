import React, { useCallback, useEffect, useRef, useState } from 'react'
import api, {
  type GroupsHealth,
  type HealthLevel,
  type ReasonCount,
  type SourceGroupHealth,
  type DestinationGroupHealth,
} from '../lib/api'

const LEVEL_STYLE: Record<HealthLevel, { color: string; label: string; icon: string }> = {
  critical: { color: 'var(--accent-danger)', label: 'Crítico', icon: '🔴' },
  warning: { color: '#eab308', label: 'Atenção', icon: '🟡' },
  ok: { color: 'var(--accent-success)', label: 'Saudável', icon: '🟢' },
  inactive: { color: 'var(--text-muted)', label: 'Desativado', icon: '⚪' },
}

const WINDOWS = [
  { hours: 6, label: '6h' },
  { hours: 24, label: '24h' },
  { hours: 72, label: '3 dias' },
  { hours: 168, label: '7 dias' },
]

function ago(iso: string | null): string {
  if (!iso) return 'nunca'
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'agora'
  if (mins < 60) return `há ${mins}min`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `há ${hrs}h`
  return `há ${Math.floor(hrs / 24)}d`
}

function Chip({ ok, label, detail }: { ok: boolean | null; label: string; detail: string }) {
  const color = ok === null ? '#eab308' : ok ? 'var(--accent-success)' : 'var(--accent-danger)'
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 20,
        border: `1px solid ${color}`, background: 'var(--surface-1)', fontSize: '0.78rem',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      <span style={{ fontWeight: 600 }}>{label}</span>
      <span style={{ color: 'var(--text-muted)' }}>{detail}</span>
    </div>
  )
}

function Pill({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <span
      style={{
        fontSize: '0.72rem', padding: '2px 9px', borderRadius: 12, background: 'var(--surface-2)',
        color: value > 0 && color ? color : 'var(--text-secondary)', fontWeight: value > 0 && color ? 700 : 400,
      }}
    >
      {label} <strong>{value}</strong>
    </span>
  )
}

function Reasons({ title, items }: { title: string; items: ReasonCount[] }) {
  if (items.length === 0) return null
  const max = Math.max(...items.map((i) => i.count))
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {items.map((r) => (
          <div key={r.reason} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.78rem' }}>
            <div style={{ flex: 1, position: 'relative', background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
              <div
                style={{
                  position: 'absolute', inset: 0, width: `${(r.count / max) * 100}%`,
                  background: 'rgba(239,68,68,0.18)',
                }}
              />
              <span style={{ position: 'relative', padding: '3px 8px', display: 'block' }}>{r.reason}</span>
            </div>
            <strong style={{ minWidth: 26, textAlign: 'right' }}>{r.count}</strong>
          </div>
        ))}
      </div>
    </div>
  )
}

function Issues({ items }: { items: string[] }) {
  if (items.length === 0) return null
  return (
    <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: 3 }}>
      {items.map((i) => (
        <li key={i}>{i}</li>
      ))}
    </ul>
  )
}

function CardShell({ level, children }: { level: HealthLevel; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--surface-1)', border: '1px solid var(--border)', borderLeft: `3px solid ${LEVEL_STYLE[level].color}`,
        borderRadius: 10, padding: '14px 16px', opacity: level === 'inactive' ? 0.65 : 1,
      }}
    >
      {children}
    </div>
  )
}

function SourceCard({ g, hours, onOpenLogs }: { g: SourceGroupHealth; hours: number; onOpenLogs: (id: string) => void }) {
  const ls = LEVEL_STYLE[g.level]
  return (
    <CardShell level={g.level}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>
            {ls.icon} {g.name}
            {g.nicheName && (
              <span style={{ marginLeft: 8, fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 400 }}>nicho: {g.nicheName}</span>
            )}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>
            <span className="font-mono">{g.telegramId}</span> · última mensagem {ago(g.lastOfferAt)} · último envio {ago(g.lastSentAt)}
          </div>
        </div>
        <span style={{ fontSize: '0.72rem', fontWeight: 700, color: ls.color }}>{ls.label}</span>
        <button className="btn btn-secondary btn-sm" onClick={() => onOpenLogs(g.id)}>
          🔍 Ver logs
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        <Pill label={`Ofertas (${hours}h)`} value={g.counts.total} />
        <Pill label="Enviadas" value={g.counts.sent} color="var(--accent-success)" />
        <Pill label="Pendentes" value={g.counts.pending} color="#eab308" />
        <Pill label="Rejeitadas" value={g.counts.rejected} color="var(--accent-danger)" />
        <Pill label="Falhas" value={g.counts.failed} color="var(--accent-danger)" />
      </div>

      <Issues items={g.issues} />
      <Reasons title={`Motivos de rejeição/falha (${hours}h)`} items={g.problemReasons} />

      <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Envia para:</span>
        {g.destinations.length === 0 ? (
          <span style={{ fontSize: '0.75rem', color: 'var(--accent-danger)', fontWeight: 600 }}>⚠️ nenhum destino</span>
        ) : (
          g.destinations.map((d) => (
            <span
              key={d.id}
              style={{
                fontSize: '0.72rem', padding: '2px 8px', borderRadius: 4, background: 'var(--surface-2)',
                textDecoration: d.isActive ? 'none' : 'line-through', color: d.isActive ? 'var(--text-secondary)' : 'var(--text-muted)',
              }}
              title={d.isActive ? '' : 'Destino desativado'}
            >
              {d.type === 'WHATSAPP' ? '💬' : '✈️'} {d.name}
            </span>
          ))
        )}
      </div>
    </CardShell>
  )
}

function DestCard({ g, hours }: { g: DestinationGroupHealth; hours: number }) {
  const ls = LEVEL_STYLE[g.level]
  return (
    <CardShell level={g.level}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>
            {ls.icon} {g.type === 'WHATSAPP' ? '💬' : '✈️'} {g.name}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>
            <span className="font-mono">{g.chatId}</span> · última entrega com sucesso {ago(g.lastSuccessAt)} · {g.linkedSources}{' '}
            {g.linkedSources === 1 ? 'origem vinculada' : 'origens vinculadas'}
          </div>
        </div>
        <span style={{ fontSize: '0.72rem', fontWeight: 700, color: ls.color }}>{ls.label}</span>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        <Pill label={`Entregas ok (${hours}h)`} value={g.counts.success} color="var(--accent-success)" />
        <Pill label="Falhas" value={g.counts.failed} color="var(--accent-danger)" />
        {g.linkStatus && (
          <span style={{ fontSize: '0.72rem', padding: '2px 9px', borderRadius: 12, background: 'var(--surface-2)' }}>
            Link de convite:{' '}
            <strong style={{ color: g.linkStatus === 'INVALID' ? 'var(--accent-danger)' : g.linkStatus === 'VALID' ? 'var(--accent-success)' : 'var(--text-muted)' }}>
              {g.linkStatus === 'VALID' ? 'válido' : g.linkStatus === 'INVALID' ? 'expirado' : 'não checado'}
            </strong>
          </span>
        )}
      </div>

      <Issues items={g.issues} />
      <Reasons title={`Erros de entrega (${hours}h)`} items={g.failureReasons} />
    </CardShell>
  )
}

export default function GroupsHealthPanel({ onOpenLogs }: { onOpenLogs: (sourceGroupId: string) => void }) {
  const [data, setData] = useState<GroupsHealth | null>(null)
  const [hours, setHours] = useState(24)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [onlyProblems, setOnlyProblems] = useState(false)
  const requestIdRef = useRef(0)

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    try {
      const res = await api.getGroupsHealth(hours)
      if (requestId !== requestIdRef.current) return
      setData(res)
      setError('')
    } catch (err) {
      if (requestId !== requestIdRef.current) return
      setError(err instanceof Error ? err.message : 'Erro ao carregar a saúde dos grupos')
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [hours])

  useEffect(() => {
    load()
    const interval = setInterval(load, 60000)
    return () => clearInterval(interval)
  }, [load])

  if (!data) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: error ? 'var(--accent-danger)' : 'var(--text-muted)' }}>
        {error || (loading ? 'Carregando saúde dos grupos… (checa listener, Mercado Livre e Evolution API, pode levar alguns segundos)' : '')}
      </div>
    )
  }

  const visible = <T extends { level: HealthLevel }>(list: T[]) =>
    onlyProblems ? list.filter((g) => g.level === 'critical' || g.level === 'warning') : list

  const all = [...data.sourceGroups, ...data.destinationGroups]
  const critical = all.filter((g) => g.level === 'critical').length
  const warning = all.filter((g) => g.level === 'warning').length
  const okCount = all.filter((g) => g.level === 'ok').length
  const { listener } = data.system

  return (
    <div>
      {/* System status */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <Chip
          ok={listener.reachable ? !!listener.authenticated : false}
          label="Telegram listener"
          detail={!listener.reachable ? 'inacessível' : listener.authenticated ? 'conectado' : 'não autenticado'}
        />
        <Chip
          ok={listener.mlSessionActive}
          label="Sessão Mercado Livre"
          detail={listener.mlSessionActive === null ? 'desconhecida' : listener.mlSessionActive ? 'ativa' : 'expirada'}
        />
        <Chip ok={data.system.evolutionConnected} label="Evolution API (WhatsApp)" detail={data.system.evolutionConnected ? 'conectada' : 'offline'} />
        <Chip ok={data.system.autoApprove} label="Aprovação automática" detail={data.system.autoApprove ? 'ligada' : 'desligada — ofertas ficam pendentes'} />
      </div>

      {/* Summary + controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <span style={{ fontSize: '0.85rem' }}>
          <strong style={{ color: 'var(--accent-danger)' }}>{critical}</strong> críticos ·{' '}
          <strong style={{ color: '#eab308' }}>{warning}</strong> em atenção ·{' '}
          <strong style={{ color: 'var(--accent-success)' }}>{okCount}</strong> saudáveis
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              className={`btn btn-sm ${hours === w.hours ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setHours(w.hours)}
            >
              {w.label}
            </button>
          ))}
          <button className={`btn btn-sm ${onlyProblems ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setOnlyProblems((v) => !v)}>
            ⚠️ Só com problema
          </button>
          <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>
            {loading ? <span className="spinner spinner-sm" /> : '🔄'}
          </button>
        </div>
      </div>

      <h3 style={{ fontSize: '0.8rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', margin: '0 0 10px' }}>
        📡 Grupos de origem
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 26 }}>
        {visible(data.sourceGroups).map((g) => (
          <SourceCard key={g.id} g={g} hours={data.windowHours} onOpenLogs={onOpenLogs} />
        ))}
        {visible(data.sourceGroups).length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Nenhum grupo de origem {onlyProblems ? 'com problema 🎉' : 'cadastrado'}.</div>
        )}
      </div>

      <h3 style={{ fontSize: '0.8rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', margin: '0 0 10px' }}>
        📤 Grupos de destino
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {visible(data.destinationGroups).map((g) => (
          <DestCard key={g.id} g={g} hours={data.windowHours} />
        ))}
        {visible(data.destinationGroups).length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Nenhum grupo de destino {onlyProblems ? 'com problema 🎉' : 'cadastrado'}.</div>
        )}
      </div>

      <div style={{ marginTop: 18, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
        Atualizado {ago(data.generatedAt)} · limites de "grupo mudo": atenção após {data.thresholds.silentWarnHours}h, crítico após{' '}
        {data.thresholds.silentCritHours}h sem mensagem · o histórico de ofertas enviadas/rejeitadas/falhas é apagado após 7 dias.
      </div>
    </div>
  )
}
