import React from 'react'
import type { Offer } from '../lib/api'
import StatusBadge from './StatusBadge'

interface OfferCardProps {
  offer: Offer
  onApprove?: (id: string) => void
  onReject?: (id: string) => void
  loading?: boolean
  compact?: boolean
}

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHr = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHr / 24)

  if (diffSec < 60) return 'agora'
  if (diffMin < 60) return `${diffMin}m atrás`
  if (diffHr < 24) return `${diffHr}h atrás`
  return `${diffDay}d atrás`
}

const BASE_URL = (import.meta.env.VITE_API_URL as string) || '/api'

export default function OfferCard({
  offer,
  onApprove,
  onReject,
  loading = false,
  compact = false,
}: OfferCardProps) {
  const rawText = offer.text ?? offer.mediaCaption ?? ''
  const text = compact ? rawText.slice(0, 80) + (rawText.length > 80 ? '…' : '') : rawText

  return (
    <div className="offer-card">
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span
            style={{
              fontSize: '1rem',
              background: 'var(--bg-elevated)',
              padding: '4px 8px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-subtle)',
              flexShrink: 0,
            }}
          >
            📦
          </span>
          <div style={{ minWidth: 0 }}>
            <div
              className="truncate"
              style={{
                fontSize: '0.82rem',
                fontWeight: 600,
                color: 'var(--text-primary)',
              }}
            >
              {offer.sourceGroupName}
            </div>
            <div
              style={{
                fontSize: '0.72rem',
                color: 'var(--text-muted)',
                marginTop: 1,
              }}
            >
              {timeAgo(offer.createdAt)}
            </div>
          </div>
        </div>
        <StatusBadge status={offer.status} />
      </div>

      {/* Message text */}
      <p className="offer-text">{text}</p>

      {/* Media preview */}
      {!compact && offer.mediaType === 'PHOTO' && offer.mediaPath && (
        <img
          src={`${BASE_URL}/media/${offer.mediaPath}`}
          alt="Imagem da oferta"
          className="offer-image"
          loading="lazy"
          onError={(e) => {
            ;(e.target as HTMLImageElement).style.display = 'none'
          }}
        />
      )}

      {/* Actions */}
      {offer.status === 'PENDING' && (onApprove || onReject) && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginTop: 14,
            paddingTop: 14,
            borderTop: '1px solid var(--border-subtle)',
          }}
        >
          {onApprove && (
            <button
              className="btn btn-success btn-sm"
              onClick={() => onApprove(offer.id)}
              disabled={loading}
              style={{ flex: 1 }}
            >
              {loading ? <span className="spinner spinner-sm" /> : '✅'} Aprovar
            </button>
          )}
          {onReject && (
            <button
              className="btn btn-danger btn-sm"
              onClick={() => onReject(offer.id)}
              disabled={loading}
              style={{ flex: 1 }}
            >
              {loading ? <span className="spinner spinner-sm" /> : '❌'} Rejeitar
            </button>
          )}
        </div>
      )}
    </div>
  )
}
