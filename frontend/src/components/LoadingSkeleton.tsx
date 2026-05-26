import React from 'react'

interface LoadingSkeletonProps {
  width?: string | number
  height?: string | number
  borderRadius?: string | number
  style?: React.CSSProperties
}

export function Skeleton({
  width = '100%',
  height = 16,
  borderRadius = 8,
  style,
}: LoadingSkeletonProps) {
  return (
    <span
      className="skeleton"
      style={{
        display: 'block',
        width,
        height,
        borderRadius,
        ...style,
      }}
    />
  )
}

// Pre-built skeletons for common patterns
export function SkeletonCard() {
  return (
    <div
      style={{
        background: 'var(--bg-glass)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Skeleton width={120} height={12} />
        <Skeleton width={60} height={20} borderRadius={99} />
      </div>
      <Skeleton height={12} />
      <Skeleton width="80%" height={12} />
      <Skeleton width="60%" height={12} />
    </div>
  )
}

export function SkeletonMetricCard() {
  return (
    <div
      style={{
        background: 'var(--bg-glass)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <Skeleton width={100} height={10} />
      <Skeleton width={70} height={32} borderRadius={6} />
      <Skeleton width={80} height={10} />
    </div>
  )
}

export function SkeletonRow() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '12px 16px',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      <Skeleton width={120} height={12} />
      <Skeleton width={200} height={12} />
      <Skeleton width={80} height={12} />
      <Skeleton width={60} height={20} borderRadius={99} />
    </div>
  )
}

export default Skeleton
