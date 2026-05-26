import React, { useState, useEffect, useCallback } from 'react'
import api, { type Offer } from '../lib/api'
import OfferCard from '../components/OfferCard'
import { SkeletonCard } from '../components/LoadingSkeleton'

export default function Queue() {
  const [offers, setOffers] = useState<Offer[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null)
  const [batchLoading, setBatchLoading] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const fetchPending = useCallback(async () => {
    try {
      const res = await api.getOffers({ status: 'PENDING', limit: 50 })
      setOffers(res.data)
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchPending()
    const interval = setInterval(fetchPending, 10_000)
    return () => clearInterval(interval)
  }, [fetchPending])

  const handleApprove = async (id: string) => {
    setActionLoadingId(id)
    try {
      await api.approveOffer(id)
      setOffers((prev) => prev.filter((o) => o.id !== id))
      showToast('Oferta aprovada!', 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao aprovar', 'error')
    } finally {
      setActionLoadingId(null)
    }
  }

  const handleReject = async (id: string) => {
    setActionLoadingId(id)
    try {
      await api.rejectOffer(id)
      setOffers((prev) => prev.filter((o) => o.id !== id))
      showToast('Oferta rejeitada.', 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao rejeitar', 'error')
    } finally {
      setActionLoadingId(null)
    }
  }

  const handleBatchApprove = async () => {
    if (offers.length === 0) return
    setBatchLoading(true)
    try {
      const ids = offers.map((o) => o.id)
      const res = await api.batchApproveOffers(ids)
      setOffers([])
      showToast(`${res.count} ofertas aprovadas!`, 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro no lote', 'error')
    } finally {
      setBatchLoading(false)
    }
  }

  return (
    <div style={{ animation: 'fadeIn 0.3s ease' }}>
      {/* Toast */}
      {toast && (
        <div
          className={`alert alert-${toast.type === 'success' ? 'success' : 'error'}`}
          style={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            zIndex: 300,
            minWidth: 280,
            animation: 'slideIn 0.3s ease',
          }}
        >
          <span>{toast.type === 'success' ? '✅' : '⚠'}</span>
          <span>{toast.msg}</span>
        </div>
      )}

      {/* Header */}
      <div
        className="page-header"
        style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}
      >
        <div>
          <h1 className="page-title">Fila de Aprovação</h1>
          <p className="page-subtitle">
            {loading ? (
              'Carregando…'
            ) : (
              <>
                <span
                  style={{
                    fontWeight: 700,
                    color: offers.length > 0 ? 'var(--accent-warning)' : 'var(--text-muted)',
                  }}
                >
                  {offers.length}
                </span>{' '}
                oferta{offers.length !== 1 ? 's' : ''} pendente{offers.length !== 1 ? 's' : ''}
                {' · '}
                <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                  atualiza a cada 10s
                </span>
              </>
            )}
          </p>
        </div>

        {offers.length > 1 && (
          <button
            className="btn btn-primary"
            onClick={handleBatchApprove}
            disabled={batchLoading}
          >
            {batchLoading ? (
              <>
                <span className="spinner spinner-sm" /> Aprovando…
              </>
            ) : (
              <>✅ Aprovar todos ({offers.length})</>
            )}
          </button>
        )}
      </div>

      {/* List */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : offers.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon">🎉</span>
          <span className="empty-state-title">Fila limpa!</span>
          <span className="empty-state-desc">
            Não há ofertas aguardando aprovação. Bom trabalho!
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {offers.map((offer) => (
            <OfferCard
              key={offer.id}
              offer={offer}
              onApprove={handleApprove}
              onReject={handleReject}
              loading={actionLoadingId === offer.id}
            />
          ))}
        </div>
      )}
    </div>
  )
}
