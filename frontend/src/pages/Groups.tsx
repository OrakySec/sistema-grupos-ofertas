import React, { useState, useEffect, useCallback } from 'react'
import api, {
  type SourceGroup,
  type DestinationGroup,
  type WhatsAppGroup,
} from '../lib/api'
import Modal from '../components/Modal'
import Toggle from '../components/Toggle'
import { Skeleton } from '../components/LoadingSkeleton'

/* ─── Helpers ────────────────────────────── */
function useToast() {
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const show = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }
  return { toast, show }
}

/* ─── Source Group Modal ─────────────────── */
interface SourceGroupModalProps {
  isOpen: boolean
  onClose: () => void
  onSaved: () => void
}

function SourceGroupModal({ isOpen, onClose, onSaved }: SourceGroupModalProps) {
  const [name, setName] = useState('')
  const [telegramId, setTelegramId] = useState('')
  const [username, setUsername] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isOpen) {
      setName('')
      setTelegramId('')
      setUsername('')
      setError('')
    }
  }, [isOpen])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name || !telegramId) {
      setError('Nome e Telegram ID são obrigatórios.')
      return
    }
    setLoading(true)
    setError('')
    try {
      await api.createSourceGroup({ name, telegramId, username: username || undefined })
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Adicionar Grupo Fonte"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={loading}
          >
            {loading ? <span className="spinner spinner-sm" /> : null}
            Salvar
          </button>
        </>
      }
    >
      <form onSubmit={handleSubmit}>
        {error && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}
        <div className="form-group">
          <label className="label" htmlFor="sg-name">
            Nome
          </label>
          <input
            id="sg-name"
            className="input"
            placeholder="Grupo de Ofertas BR"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="form-group">
          <label className="label" htmlFor="sg-tid">
            Telegram ID (BigInt)
          </label>
          <input
            id="sg-tid"
            className="input font-mono"
            placeholder="-1001234567890"
            value={telegramId}
            onChange={(e) => setTelegramId(e.target.value)}
            required
          />
        </div>
        <div className="form-group">
          <label className="label" htmlFor="sg-user">
            Username (@username)
          </label>
          <input
            id="sg-user"
            className="input"
            placeholder="@ofertas_brasil"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
      </form>
    </Modal>
  )
}

/* ─── Destination Group Modal ────────────── */
interface DestGroupModalProps {
  isOpen: boolean
  onClose: () => void
  onSaved: () => void
}

function DestGroupModal({ isOpen, onClose, onSaved }: DestGroupModalProps) {
  const [name, setName] = useState('')
  const [type, setType] = useState<'TELEGRAM' | 'WHATSAPP'>('TELEGRAM')
  const [chatId, setChatId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [waGroups, setWaGroups] = useState<WhatsAppGroup[]>([])
  const [waLoading, setWaLoading] = useState(false)
  const [waSearch, setWaSearch] = useState('')

  useEffect(() => {
    if (!isOpen) {
      setName('')
      setType('TELEGRAM')
      setChatId('')
      setError('')
      setWaGroups([])
      setWaSearch('')
    }
  }, [isOpen])

  const handleFetchWaGroups = async () => {
    setWaLoading(true)
    try {
      const groups = await api.getWhatsAppGroups()
      setWaGroups(groups)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao buscar grupos WhatsApp')
    } finally {
      setWaLoading(false)
    }
  }

  const handleSelectWaGroup = (g: WhatsAppGroup) => {
    setChatId(g.id)
    setName(name || g.name)
  }

  const filteredWa = waGroups.filter((g) =>
    g.name.toLowerCase().includes(waSearch.toLowerCase())
  )

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name || !chatId) {
      setError('Nome e Chat ID são obrigatórios.')
      return
    }
    setLoading(true)
    setError('')
    try {
      await api.createDestinationGroup({ name, type, chatId })
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Adicionar Grupo Destino"
      width={520}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={loading}
          >
            {loading ? <span className="spinner spinner-sm" /> : null}
            Salvar
          </button>
        </>
      }
    >
      <form onSubmit={handleSubmit}>
        {error && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}
        <div className="form-group">
          <label className="label" htmlFor="dg-name">
            Nome
          </label>
          <input
            id="dg-name"
            className="input"
            placeholder="Canal de Descontos"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="form-group">
          <label className="label">Tipo</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['TELEGRAM', 'WHATSAPP'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={`btn btn-sm ${type === t ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setType(t)}
                style={{ flex: 1 }}
              >
                {t === 'TELEGRAM' ? '✈️' : '💬'} {t}
              </button>
            ))}
          </div>
        </div>

        {type === 'WHATSAPP' && (
          <div className="form-group">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 8,
              }}
            >
              <label className="label" style={{ marginBottom: 0 }}>
                Grupos WhatsApp
              </label>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleFetchWaGroups}
                disabled={waLoading}
              >
                {waLoading ? <span className="spinner spinner-sm" /> : '🔍'} Buscar grupos
              </button>
            </div>

            {waGroups.length > 0 && (
              <div>
                <input
                  className="input"
                  placeholder="Pesquisar grupo..."
                  value={waSearch}
                  onChange={(e) => setWaSearch(e.target.value)}
                  style={{ marginBottom: 8 }}
                />
                <div
                  style={{
                    maxHeight: 160,
                    overflowY: 'auto',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-md)',
                  }}
                >
                  {filteredWa.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => handleSelectWaGroup(g)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        width: '100%',
                        padding: '8px 12px',
                        background: chatId === g.id ? 'var(--accent-primary-dim)' : 'transparent',
                        border: 'none',
                        borderBottom: '1px solid var(--border-subtle)',
                        cursor: 'pointer',
                        textAlign: 'left',
                        transition: 'background var(--transition)',
                        color: 'var(--text-secondary)',
                        fontSize: '0.83rem',
                      }}
                    >
                      <span>💬</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {g.name}
                      </span>
                      {g.participants && (
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                          {g.participants} membros
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="form-group">
          <label className="label" htmlFor="dg-chatid">
            Chat ID
          </label>
          <input
            id="dg-chatid"
            className="input font-mono"
            placeholder="-1001234567890"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            required
          />
        </div>
      </form>
    </Modal>
  )
}

/* ─── Main Groups Page ───────────────────── */
export default function Groups() {
  const { toast, show: showToast } = useToast()
  const [sourceGroups, setSourceGroups] = useState<SourceGroup[]>([])
  const [destGroups, setDestGroups] = useState<DestinationGroup[]>([])
  const [loadingSrc, setLoadingSrc] = useState(true)
  const [loadingDest, setLoadingDest] = useState(true)
  const [showAddSrc, setShowAddSrc] = useState(false)
  const [showAddDest, setShowAddDest] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    try {
      const [src, dest] = await Promise.all([
        api.getSourceGroups(),
        api.getDestinationGroups(),
      ])
      setSourceGroups(src)
      setDestGroups(dest)
    } catch {
      // silent
    } finally {
      setLoadingSrc(false)
      setLoadingDest(false)
    }
  }, [])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const toggleSource = async (g: SourceGroup) => {
    setTogglingId(g.id)
    try {
      const updated = await api.updateSourceGroup(g.id, { isActive: !g.isActive })
      setSourceGroups((prev) => prev.map((s) => (s.id === g.id ? updated : s)))
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro', 'error')
    } finally {
      setTogglingId(null)
    }
  }

  const toggleDest = async (g: DestinationGroup) => {
    setTogglingId(g.id)
    try {
      const updated = await api.updateDestinationGroup(g.id, { isActive: !g.isActive })
      setDestGroups((prev) => prev.map((d) => (d.id === g.id ? updated : d)))
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro', 'error')
    } finally {
      setTogglingId(null)
    }
  }

  const deleteSource = async (id: string) => {
    if (!confirm('Remover este grupo fonte?')) return
    setDeletingId(id)
    try {
      await api.deleteSourceGroup(id)
      setSourceGroups((prev) => prev.filter((g) => g.id !== id))
      showToast('Grupo removido.', 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro', 'error')
    } finally {
      setDeletingId(null)
    }
  }

  const deleteDest = async (id: string) => {
    if (!confirm('Remover este grupo destino?')) return
    setDeletingId(id)
    try {
      await api.deleteDestinationGroup(id)
      setDestGroups((prev) => prev.filter((g) => g.id !== id))
      showToast('Grupo removido.', 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro', 'error')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div style={{ animation: 'fadeIn 0.3s ease' }}>
      {/* Toast */}
      {toast && (
        <div
          className={`alert alert-${toast.type === 'success' ? 'success' : 'error'}`}
          style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 300, minWidth: 280, animation: 'slideIn 0.3s ease' }}
        >
          {toast.msg}
        </div>
      )}

      <SourceGroupModal
        isOpen={showAddSrc}
        onClose={() => setShowAddSrc(false)}
        onSaved={fetchAll}
      />
      <DestGroupModal
        isOpen={showAddDest}
        onClose={() => setShowAddDest(false)}
        onSaved={fetchAll}
      />

      {/* Header */}
      <div className="page-header">
        <h1 className="page-title">Grupos</h1>
        <p className="page-subtitle">Gerencie grupos de origem e destino das ofertas</p>
      </div>

      {/* ── Source Groups ─────────────────── */}
      <div className="card" style={{ marginBottom: 32 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 20,
          }}
        >
          <h2 className="section-title" style={{ marginBottom: 0 }}>
            📡 Grupos Fonte (Origem)
          </h2>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowAddSrc(true)}
          >
            + Adicionar
          </button>
        </div>

        {loadingSrc ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} height={40} />
            ))}
          </div>
        ) : sourceGroups.length === 0 ? (
          <div className="empty-state" style={{ padding: '32px 0' }}>
            <span className="empty-state-icon">📡</span>
            <span className="empty-state-title">Nenhum grupo fonte</span>
            <span className="empty-state-desc">
              Adicione grupos do Telegram para monitorar.
            </span>
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Username</th>
                  <th>Telegram ID</th>
                  <th>Status</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {sourceGroups.map((g) => (
                  <tr key={g.id}>
                    <td className="primary">{g.name}</td>
                    <td>
                      {g.username ? (
                        <span style={{ color: 'var(--text-accent)' }}>{g.username}</span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                    <td>
                      <span className="mono">{g.telegramId}</span>
                    </td>
                    <td>
                      <Toggle
                        checked={g.isActive}
                        onChange={() => toggleSource(g)}
                        disabled={togglingId === g.id}
                      />
                    </td>
                    <td>
                      <button
                        className="icon-btn danger"
                        onClick={() => deleteSource(g.id)}
                        disabled={deletingId === g.id}
                        title="Remover"
                      >
                        {deletingId === g.id ? <span className="spinner spinner-sm" /> : '🗑'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Destination Groups ────────────── */}
      <div className="card">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 20,
          }}
        >
          <h2 className="section-title" style={{ marginBottom: 0 }}>
            📤 Grupos Destino
          </h2>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowAddDest(true)}
          >
            + Adicionar
          </button>
        </div>

        {loadingDest ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} height={40} />
            ))}
          </div>
        ) : destGroups.length === 0 ? (
          <div className="empty-state" style={{ padding: '32px 0' }}>
            <span className="empty-state-icon">📤</span>
            <span className="empty-state-title">Nenhum grupo destino</span>
            <span className="empty-state-desc">
              Adicione grupos Telegram ou WhatsApp para enviar as ofertas.
            </span>
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Tipo</th>
                  <th>Chat ID</th>
                  <th>Status</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {destGroups.map((g) => (
                  <tr key={g.id}>
                    <td className="primary">{g.name}</td>
                    <td>
                      <span
                        className={`badge ${
                          g.type === 'TELEGRAM' ? 'badge-telegram' : 'badge-whatsapp'
                        }`}
                      >
                        {g.type === 'TELEGRAM' ? '✈️' : '💬'} {g.type}
                      </span>
                    </td>
                    <td>
                      <span className="mono">{g.chatId}</span>
                    </td>
                    <td>
                      <Toggle
                        checked={g.isActive}
                        onChange={() => toggleDest(g)}
                        disabled={togglingId === g.id}
                      />
                    </td>
                    <td>
                      <button
                        className="icon-btn danger"
                        onClick={() => deleteDest(g.id)}
                        disabled={deletingId === g.id}
                        title="Remover"
                      >
                        {deletingId === g.id ? <span className="spinner spinner-sm" /> : '🗑'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
