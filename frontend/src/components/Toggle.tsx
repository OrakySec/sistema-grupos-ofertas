import React from 'react'

interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
  id?: string
}

export default function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
  id,
}: ToggleProps) {
  const inputId = id ?? `toggle-${Math.random().toString(36).slice(2)}`

  return (
    <label
      htmlFor={inputId}
      className="toggle-wrapper"
      style={{
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <input
        id={inputId}
        type="checkbox"
        className="toggle-input sr-only"
        checked={checked}
        onChange={(e) => !disabled && onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className="toggle" aria-hidden="true" />
      {label && (
        <span
          style={{
            fontSize: '0.875rem',
            color: 'var(--text-secondary)',
            fontWeight: 500,
          }}
        >
          {label}
        </span>
      )}
    </label>
  )
}
