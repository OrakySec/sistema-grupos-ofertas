import React, { useState, useEffect, useCallback, useRef } from 'react'
import api, {
  type SourceGroup,
  type DestinationGroup,
  type WhatsAppGroup,
  type Niche,
} from '../lib/api'
import Modal from '../components/Modal'
import Toggle from '../components/Toggle'
import { Skeleton } from '../components/LoadingSkeleton'
import { useToast } from '../lib/toast'

const BASE_URL = (import.meta.env.VITE_API_URL as string) || '/api'

/* ─── Link Destinations Modal ────────────── */
interface LinkDestinationsModalProps {
  isOpen: boolean
  sourceGroup: SourceGroup | null
  allDestinations: DestinationGroup[]
  onClose: () => void
  onSaved: () => void
}

function LinkDestinationsModal({
  isOpen,
  sourceGroup,
  allDestinations,
  onClose,
  onSaved,
}: LinkDestinationsModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()

  // Load currently linked destinations when modal opens
  useEffect(() => {
    if (!isOpen || !sourceGroup) return
    setLoading(true)
    api
      .getSourceGroupDestinations(sourceGroup.id)
      .then((linked) => setSelected(new Set(linked.map((d) => d.id))))
      .catch(() => setSelected(new Set()))
      .finally(() => setLoading(false))
  }, [isOpen, sourceGroup])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSave = async () => {
    if (!sourceGroup) return
    setSaving(true)
    try {
      await api.setSourceGroupDestinations(sourceGroup.id, [...selected])
      addToast('Vínculos salvos com sucesso!', 'success')
      onSaved()
      onClose()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao salvar vínculos.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const typeIcon = (t: 'TELEGRAM' | 'WHATSAPP') => (t === 'TELEGRAM' ? '✈️' : '💬')

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Vincular destinos — ${sourceGroup?.name ?? ''}`}
      width={480}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || loading}>
            {saving ? <span className="spinner spinner-sm" /> : null}
            Salvar vínculos
          </button>
        </>
      }
    >
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} height={44} />
          ))}
        </div>
      ) : allDestinations.length === 0 ? (
        <div className="empty-state" style={{ padding: '24px 0' }}>
          <span className="empty-state-icon">📤</span>
          <span className="empty-state-title">Nenhum grupo destino</span>
          <span className="empty-state-desc">
            Adicione grupos destino antes de criar vínculos.
          </span>
        </div>
      ) : (
        <div>
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--text-muted)',
              marginBottom: 14,
              lineHeight: 1.5,
            }}
          >
            Selecione quais grupos destino receberão as ofertas deste grupo fonte.
            {selected.size === 0 && (
              <span style={{ color: 'var(--color-error, #ef4444)', fontWeight: 600 }}>
                {' '}⚠️ Nenhum destino vinculado — as ofertas deste grupo NÃO serão enviadas até você vincular ao menos um.
              </span>
            )}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {allDestinations.map((d) => (
              <label
                key={d.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-md)',
                  border: `1.5px solid ${
                    selected.has(d.id) ? 'var(--accent-primary)' : 'var(--border-subtle)'
                  }`,
                  background: selected.has(d.id)
                    ? 'var(--accent-primary-dim, rgba(99,102,241,0.1))'
                    : 'transparent',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(d.id)}
                  onChange={() => toggle(d.id)}
                  style={{ accentColor: 'var(--accent-primary)', width: 16, height: 16 }}
                />
                <span style={{ fontSize: '1.1rem' }}>{typeIcon(d.type)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: '0.9rem',
                      color: 'var(--text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {d.name}
                  </div>
                  <div
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--text-muted)',
                      fontFamily: 'monospace',
                    }}
                  >
                    {d.chatId}
                  </div>
                </div>
                {!d.isActive && (
                  <span
                    style={{
                      fontSize: '0.7rem',
                      background: 'var(--color-error-dim, rgba(239,68,68,0.15))',
                      color: 'var(--color-error, #ef4444)',
                      padding: '2px 6px',
                      borderRadius: 4,
                      fontWeight: 600,
                    }}
                  >
                    inativo
                  </span>
                )}
              </label>
            ))}
          </div>
        </div>
      )}
    </Modal>
  )
}

/* ─── Mockup box editor ───────────────────── */
// Fractions of image width/height (0..1) for the editor's own drag math;
// PixelRect (below) is the same shape, but in the image's natural pixel
// space — what actually gets sent to the API / used by mockup_composer.py.
interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

const DEFAULT_FRAC_BOX: Rect = { left: 0.15, top: 0.15, right: 0.85, bottom: 0.85 }

interface MockupBoxEditorProps {
  imageUrl: string
  initialBox: Rect | null // natural pixel coordinates
  initialCornerRadius: number
  readOnly?: boolean
  onChange?: (box: Rect, cornerRadius: number) => void
}

function MockupBoxEditor({
  imageUrl,
  initialBox,
  initialCornerRadius,
  readOnly = false,
  onChange,
}: MockupBoxEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [displayWidth, setDisplayWidth] = useState(360)
  const [fracBox, setFracBox] = useState<Rect>(DEFAULT_FRAC_BOX)
  const [cornerRadius, setCornerRadius] = useState(initialCornerRadius)
  const [dragging, setDragging] = useState<'tl' | 'br' | null>(null)

  const handleImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const w = e.currentTarget.naturalWidth
    const h = e.currentTarget.naturalHeight
    setNatural({ w, h })
    setFracBox(
      initialBox
        ? {
            left: initialBox.left / w,
            top: initialBox.top / h,
            right: initialBox.right / w,
            bottom: initialBox.bottom / h,
          }
        : DEFAULT_FRAC_BOX
    )
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) setDisplayWidth(entry.contentRect.width)
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    if (!natural || !onChange) return
    onChange(
      {
        left: fracBox.left * natural.w,
        top: fracBox.top * natural.h,
        right: fracBox.right * natural.w,
        bottom: fracBox.bottom * natural.h,
      },
      cornerRadius
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fracBox, cornerRadius, natural])

  useEffect(() => {
    if (!dragging) return
    const handleMove = (e: PointerEvent) => {
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
      const fy = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
      setFracBox((prev) =>
        dragging === 'tl'
          ? { ...prev, left: Math.min(fx, prev.right - 0.05), top: Math.min(fy, prev.bottom - 0.05) }
          : { ...prev, right: Math.max(fx, prev.left + 0.05), bottom: Math.max(fy, prev.top + 0.05) }
      )
    }
    const handleUp = () => setDragging(null)
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [dragging])

  const scale = natural ? displayWidth / natural.w : 1
  const handleSize = 18

  return (
    <div>
      <div
        ref={containerRef}
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 360,
          userSelect: 'none',
          touchAction: 'none',
          border: '1px solid var(--border-subtle)',
          borderRadius: 8,
          overflow: 'hidden',
          background: '#111',
        }}
      >
        <img
          src={imageUrl}
          alt="Template do mockup"
          onLoad={handleImgLoad}
          style={{ display: 'block', width: '100%' }}
          draggable={false}
        />
        {natural && (
          <div
            style={{
              position: 'absolute',
              left: `${fracBox.left * 100}%`,
              top: `${fracBox.top * 100}%`,
              width: `${(fracBox.right - fracBox.left) * 100}%`,
              height: `${(fracBox.bottom - fracBox.top) * 100}%`,
              border: '2px dashed #ff5e00',
              background: 'rgba(255,94,0,0.15)',
              borderRadius: cornerRadius * scale,
              pointerEvents: 'none',
            }}
          />
        )}
        {natural &&
          !readOnly &&
          (['tl', 'br'] as const).map((corner) => (
            <div
              key={corner}
              onPointerDown={(e) => {
                e.preventDefault()
                setDragging(corner)
              }}
              style={{
                position: 'absolute',
                left: `calc(${(corner === 'tl' ? fracBox.left : fracBox.right) * 100}% - ${handleSize / 2}px)`,
                top: `calc(${(corner === 'tl' ? fracBox.top : fracBox.bottom) * 100}% - ${handleSize / 2}px)`,
                width: handleSize,
                height: handleSize,
                borderRadius: '50%',
                background: '#ff5e00',
                border: '2px solid #fff',
                cursor: 'nwse-resize',
                boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
              }}
            />
          ))}
      </div>
      {!readOnly && (
        <div style={{ marginTop: 10 }}>
          <label className="label" style={{ fontSize: '0.8rem' }}>
            Raio do canto: {cornerRadius}px
          </label>
          <input
            type="range"
            min={0}
            max={200}
            value={cornerRadius}
            onChange={(e) => setCornerRadius(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </div>
      )}
    </div>
  )
}

/* ─── Niche create modal ───────────────────── */
interface NicheModalProps {
  isOpen: boolean
  onClose: () => void
  onSaved: () => void
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function NicheModal({ isOpen, onClose, onSaved }: NicheModalProps) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isOpen) {
      setName('')
      setSlug('')
      setSlugTouched(false)
      setError('')
    }
  }, [isOpen])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name) {
      setError('Nome é obrigatório.')
      return
    }
    setLoading(true)
    setError('')
    try {
      await api.createNiche({ name, slug: slug.trim() || null })
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
      title="Adicionar Nicho"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={loading}>
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
          <label className="label" htmlFor="niche-name">
            Nome
          </label>
          <input
            id="niche-name"
            className="input"
            placeholder="Impressão 3D"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              if (!slugTouched) setSlug(slugify(e.target.value))
            }}
            required
          />
        </div>
        <div className="form-group">
          <label className="label" htmlFor="niche-slug-create">
            Slug (URL pública)
          </label>
          <input
            id="niche-slug-create"
            className="input font-mono"
            placeholder="impressao-3d"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true)
              setSlug(slugify(e.target.value))
            }}
          />
        </div>
      </form>
    </Modal>
  )
}

/* ─── Niche config modal ──────────────────── */
interface NicheConfigModalProps {
  isOpen: boolean
  niche: Niche | null
  onClose: () => void
  onSaved: () => void
}

function NicheConfigModal({ isOpen, niche, onClose, onSaved }: NicheConfigModalProps) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [footerText, setFooterText] = useState('')
  const [mlOwnListUrl, setMlOwnListUrl] = useState('')
  const [templateFile, setTemplateFile] = useState<File | null>(null)
  const [templatePreviewUrl, setTemplatePreviewUrl] = useState<string | null>(null)
  const [pendingBox, setPendingBox] = useState<Rect | null>(null)
  const [pendingRadius, setPendingRadius] = useState(50)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isOpen || !niche) return
    setName(niche.name)
    setSlug(niche.slug || slugify(niche.name))
    setFooterText(niche.footerText || '')
    setMlOwnListUrl(niche.mlOwnListUrl || '')
    setTemplateFile(null)
    setPendingBox(null)
    setPendingRadius(niche.mockupCornerRadius ?? 50)
    setTemplatePreviewUrl(
      niche.mockupTemplatePath ? `${BASE_URL}/media/${niche.mockupTemplatePath}` : null
    )
    setError('')
  }, [isOpen, niche])

  const existingBox: Rect | null =
    niche?.mockupBoxLeft != null &&
    niche?.mockupBoxTop != null &&
    niche?.mockupBoxRight != null &&
    niche?.mockupBoxBottom != null
      ? {
          left: niche.mockupBoxLeft,
          top: niche.mockupBoxTop,
          right: niche.mockupBoxRight,
          bottom: niche.mockupBoxBottom,
        }
      : null

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setTemplateFile(file)
    setTemplatePreviewUrl(URL.createObjectURL(file))
    setPendingBox(null)
    setPendingRadius(50)
  }

  const handleRemoveTemplate = async () => {
    if (!niche) return
    setSaving(true)
    setError('')
    try {
      await api.updateNiche(niche.id, { clearMockupTemplate: true })
      setTemplateFile(null)
      setTemplatePreviewUrl(null)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao remover template')
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async () => {
    if (!niche) return
    setSaving(true)
    setError('')
    try {
      await api.updateNiche(niche.id, {
        name: name.trim() || niche.name,
        slug: slug.trim() || null,
        footerText: footerText.trim() || null,
        mlOwnListUrl: mlOwnListUrl.trim() || null,
      })

      if (templateFile && pendingBox) {
        await api.uploadNicheMockupTemplate(niche.id, templateFile, pendingBox, pendingRadius)
      }

      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar configuração do nicho')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Configurar nicho — ${niche?.name ?? ''}`}
      width={480}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving || (!!templateFile && !pendingBox)}
          >
            {saving ? <span className="spinner spinner-sm" /> : null}
            Salvar
          </button>
        </>
      }
    >
      {error && (
        <div className="alert alert-error" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div className="form-group">
        <label className="label" htmlFor="niche-name-edit">
          Nome
        </label>
        <input
          id="niche-name-edit"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label className="label" htmlFor="niche-slug">
          Slug (URL pública)
        </label>
        <input
          id="niche-slug"
          className="input font-mono"
          placeholder="impressao-3d"
          value={slug}
          onChange={(e) => setSlug(slugify(e.target.value))}
        />
        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
          Página pública: ofertas.ykaromarques.com/ofertas/n/{slug || '...'}
        </p>
      </div>

      <div className="form-group">
        <label className="label" htmlFor="niche-footer">
          Texto de rodapé (deixe em branco para usar o padrão global)
        </label>
        <textarea
          id="niche-footer"
          className="input"
          rows={3}
          placeholder="Ex: 📲 Entre no nosso grupo: t.me/..."
          value={footerText}
          onChange={(e) => setFooterText(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label className="label" htmlFor="niche-ml-url">
          Link da lista própria do Mercado Livre (fallback)
        </label>
        <input
          id="niche-ml-url"
          className="input"
          placeholder="Deixe em branco para usar o padrão global"
          value={mlOwnListUrl}
          onChange={(e) => setMlOwnListUrl(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label className="label">Template do mockup</label>

        {!templatePreviewUrl && (
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 8 }}>
            Nenhum template customizado — usando o padrão do sistema.
          </p>
        )}

        {templatePreviewUrl && (
          <MockupBoxEditor
            key={templatePreviewUrl}
            imageUrl={templatePreviewUrl}
            initialBox={templateFile ? null : existingBox}
            initialCornerRadius={templateFile ? 50 : niche?.mockupCornerRadius ?? 50}
            readOnly={!templateFile}
            onChange={templateFile ? (box, radius) => { setPendingBox(box); setPendingRadius(radius) } : undefined}
          />
        )}

        {templatePreviewUrl && !templateFile && (
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 8 }}>
            Retângulo salvo atualmente (somente leitura) — escolha uma nova imagem pra ajustar.
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
            {templatePreviewUrl ? '🔄 Trocar imagem' : '📤 Enviar imagem'}
            <input type="file" accept="image/*" onChange={handleFileChange} style={{ display: 'none' }} />
          </label>
          {niche?.mockupTemplatePath && !templateFile && (
            <button className="btn btn-ghost btn-sm" onClick={handleRemoveTemplate} disabled={saving}>
              🗑 Remover (usar padrão)
            </button>
          )}
        </div>

        {templateFile && !pendingBox && (
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 8 }}>
            Carregando imagem…
          </p>
        )}
      </div>
    </Modal>
  )
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
  const { addToast } = useToast()
  const [sourceGroups, setSourceGroups] = useState<SourceGroup[]>([])
  const [destGroups, setDestGroups] = useState<DestinationGroup[]>([])
  const [niches, setNiches] = useState<Niche[]>([])
  const [loadingSrc, setLoadingSrc] = useState(true)
  const [loadingDest, setLoadingDest] = useState(true)
  const [loadingNiches, setLoadingNiches] = useState(true)
  const [showAddSrc, setShowAddSrc] = useState(false)
  const [showAddDest, setShowAddDest] = useState(false)
  const [showAddNiche, setShowAddNiche] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [assigningId, setAssigningId] = useState<string | null>(null)
  // Link destinations modal
  const [linkTarget, setLinkTarget] = useState<SourceGroup | null>(null)
  // Niche config modal (mockup/footer/ML link)
  const [nicheTarget, setNicheTarget] = useState<Niche | null>(null)
  // Track linked destination counts per source group
  const [linkedCounts, setLinkedCounts] = useState<Record<string, number>>({})

  const fetchAll = useCallback(async () => {
    try {
      const [src, dest, nch] = await Promise.all([
        api.getSourceGroups(),
        api.getDestinationGroups(),
        api.getNiches(),
      ])
      setSourceGroups(src)
      setDestGroups(dest)
      setNiches(nch)
      setLoadingNiches(false)
      // Fetch linked counts for each source group
      const counts = await Promise.all(
        src.map((s) =>
          api
            .getSourceGroupDestinations(s.id)
            .then((linked) => ({ id: s.id, count: linked.length }))
            .catch(() => ({ id: s.id, count: 0 }))
        )
      )
      setLinkedCounts(Object.fromEntries(counts.map((c) => [c.id, c.count])))
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
      addToast(err instanceof Error ? err.message : 'Erro', 'error')
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
      addToast(err instanceof Error ? err.message : 'Erro', 'error')
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
      addToast('Grupo de origem removido com sucesso.', 'success')
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro', 'error')
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
      addToast('Grupo de destino removido com sucesso.', 'success')
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro', 'error')
    } finally {
      setDeletingId(null)
    }
  }

  const deleteNiche = async (id: string) => {
    if (!confirm('Remover este nicho? Os grupos fonte vinculados voltam a usar os padrões globais.')) return
    setDeletingId(id)
    try {
      await api.deleteNiche(id)
      setNiches((prev) => prev.filter((n) => n.id !== id))
      addToast('Nicho removido com sucesso.', 'success')
      fetchAll()
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro', 'error')
    } finally {
      setDeletingId(null)
    }
  }

  const assignNiche = async (g: SourceGroup, nicheId: string) => {
    setAssigningId(g.id)
    try {
      const updated = await api.updateSourceGroup(g.id, { nicheId: nicheId || null })
      setSourceGroups((prev) => prev.map((s) => (s.id === g.id ? updated : s)))
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao atribuir nicho', 'error')
    } finally {
      setAssigningId(null)
    }
  }

  return (
    <div style={{ animation: 'fadeIn 0.3s ease' }}>
      <SourceGroupModal
        isOpen={showAddSrc}
        onClose={() => setShowAddSrc(false)}
        onSaved={() => { fetchAll(); addToast('Grupo de origem adicionado com sucesso!', 'success'); }}
      />
      <DestGroupModal
        isOpen={showAddDest}
        onClose={() => setShowAddDest(false)}
        onSaved={() => { fetchAll(); addToast('Grupo de destino adicionado com sucesso!', 'success'); }}
      />
      <LinkDestinationsModal
        isOpen={linkTarget !== null}
        sourceGroup={linkTarget}
        allDestinations={destGroups}
        onClose={() => setLinkTarget(null)}
        onSaved={() => { fetchAll(); }}
      />
      <NicheModal
        isOpen={showAddNiche}
        onClose={() => setShowAddNiche(false)}
        onSaved={() => { fetchAll(); addToast('Nicho adicionado com sucesso!', 'success'); }}
      />
      <NicheConfigModal
        isOpen={nicheTarget !== null}
        niche={nicheTarget}
        onClose={() => setNicheTarget(null)}
        onSaved={() => { fetchAll(); addToast('Configuração de nicho salva!', 'success'); }}
      />

      {/* Header */}
      <div className="page-header">
        <h1 className="page-title">Grupos</h1>
        <p className="page-subtitle">Gerencie grupos de origem e destino das ofertas</p>
      </div>

      {/* ── Niches ─────────────────────────── */}
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
            🏷️ Nichos
          </h2>
          <button className="btn btn-primary btn-sm" onClick={() => setShowAddNiche(true)}>
            + Adicionar
          </button>
        </div>

        {loadingNiches ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} height={40} />
            ))}
          </div>
        ) : niches.length === 0 ? (
          <div className="empty-state" style={{ padding: '32px 0' }}>
            <span className="empty-state-icon">🏷️</span>
            <span className="empty-state-title">Nenhum nicho criado</span>
            <span className="empty-state-desc">
              Crie um nicho pra agrupar mockup, rodapé e página pública compartilhados entre grupos fonte.
            </span>
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Slug</th>
                  <th>Grupos fonte</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {niches.map((n) => (
                  <tr key={n.id}>
                    <td className="primary">{n.name}</td>
                    <td>
                      {n.slug ? (
                        <span className="mono">{n.slug}</span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>— (não público)</span>
                      )}
                    </td>
                    <td>{n.sourceGroupCount ?? 0}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          className="icon-btn"
                          onClick={() => setNicheTarget(n)}
                          title="Configurar nicho (mockup, rodapé, link ML)"
                        >
                          ⚙️
                        </button>
                        <button
                          className="icon-btn danger"
                          onClick={() => deleteNiche(n.id)}
                          disabled={deletingId === n.id}
                          title="Remover"
                        >
                          {deletingId === n.id ? <span className="spinner spinner-sm" /> : '🗑'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
                  <th>Nicho</th>
                  <th>Destinos vinculados</th>
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
                      <select
                        className="input"
                        style={{ padding: '4px 8px', fontSize: '0.82rem', minWidth: 140 }}
                        value={g.nicheId ?? ''}
                        onChange={(e) => assignNiche(g, e.target.value)}
                        disabled={assigningId === g.id}
                      >
                        <option value="">Nenhum</option>
                        {niches.map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setLinkTarget(g)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                        title="Gerenciar grupos destino vinculados"
                      >
                        🔗
                        {(linkedCounts[g.id] ?? 0) > 0 ? (
                          <span
                            style={{
                              background: 'var(--accent-primary)',
                              color: '#fff',
                              borderRadius: '999px',
                              fontSize: '0.7rem',
                              fontWeight: 700,
                              padding: '1px 7px',
                              lineHeight: 1.4,
                            }}
                          >
                            {linkedCounts[g.id]}
                          </span>
                        ) : (
                          <span style={{ fontSize: '0.75rem', color: 'var(--color-error, #ef4444)', fontWeight: 600 }}>
                            ⚠️ Nenhum
                          </span>
                        )}
                      </button>
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
