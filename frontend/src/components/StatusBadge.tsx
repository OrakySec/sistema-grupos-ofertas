import React from 'react'

type StatusType = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SENT' | 'FAILED'

interface StatusBadgeProps {
  status: StatusType
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

export default function StatusBadge({ status }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? {
    label: status,
    className: 'badge',
    dot: '●',
  }

  return (
    <span className={config.className}>
      <span style={{ fontSize: '0.55rem', verticalAlign: 'middle' }}>
        {config.dot}
      </span>
      {config.label}
    </span>
  )
}
