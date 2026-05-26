import React, { useEffect, useRef, type ReactNode } from 'react'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  width?: number | string
  footer?: ReactNode
}

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  width = 480,
  footer,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)

  // Close on ESC
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    // Prevent body scroll
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handler)
      document.body.style.overflow = ''
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          animation: 'fadeInFast 0.2s ease',
        }}
      />

      {/* Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: width,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: 'calc(100vh - 80px)',
          animation: 'scaleIn 0.25s cubic-bezier(0.34,1.56,0.64,1) both',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        {title && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '20px 24px 16px',
              borderBottom: '1px solid var(--border-subtle)',
              flexShrink: 0,
            }}
          >
            <h2
              style={{
                fontSize: '1rem',
                fontWeight: 700,
                color: 'var(--text-primary)',
                letterSpacing: '-0.01em',
              }}
            >
              {title}
            </h2>
            <button
              onClick={onClose}
              className="icon-btn"
              aria-label="Fechar"
              style={{ fontSize: '1.1rem' }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Body */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: title ? '20px 24px' : '24px',
          }}
        >
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div
            style={{
              padding: '16px 24px 20px',
              borderTop: '1px solid var(--border-subtle)',
              display: 'flex',
              gap: 8,
              justifyContent: 'flex-end',
              flexShrink: 0,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
