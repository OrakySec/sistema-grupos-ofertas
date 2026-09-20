import React from 'react'

type StatusType = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SENT' | 'FAILED'

interface StatusBadgeProps {
  status: StatusType
  // Why a REJECTED/FAILED offer ended up that way (from the API's problemReason)
  reason?: string | null
}

const STATUS_CONFIG: Record<
  StatusType,
  { label: string; className: string; dot: string }
> = {
  PENDING: {
    label: 'Pendente',
    className: 'badge badge-pending',
    dot: '●',
  },
  APPROVED: {
    label: 'Aprovado',
    className: 'badge badge-approved',
    dot: '●',
  },
  REJECTED: {
    label: 'Rejeitado',
    className: 'badge badge-rejected',
    dot: '●',
  },
  SENT: {
    label: 'Enviado',
    className: 'badge badge-sent',
    dot: '●',
  },
  FAILED: {
    label: 'Falha',
    className: 'badge badge-failed',
    dot: '●',
  },
}

export default function StatusBadge({ status, reason }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? {
    label: status,
    className: 'badge',
    dot: '●',
  }

  const badge = (
    <span className={config.className} title={reason ?? undefined}>
      <span style={{ fontSize: '0.55rem', verticalAlign: 'middle' }}>
        {config.dot}
      </span>
      {config.label}
    </span>
  )

  if (!reason) return badge

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}>
      {badge}
      <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', maxWidth: 220, lineHeight: 1.3 }}>
        {reason}
      </span>
    </span>
  )
}
