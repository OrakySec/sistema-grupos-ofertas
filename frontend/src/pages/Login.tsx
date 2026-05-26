import React, { useState, type FormEvent } from 'react'
import { useAuth } from '../lib/auth'
import { useNavigate } from 'react-router-dom'

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!email || !password) {
      setError('Preencha todos os campos.')
      return
    }
    setLoading(true)
    setError('')
    try {
      await login(email, password)
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Erro ao fazer login. Tente novamente.'
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        padding: 16,
      }}
    >
      {/* Animated background */}
      <div className="login-bg" />
      <div className="login-bg-noise" />

      {/* Decorative orbs */}
      <div
        style={{
          position: 'fixed',
          top: '15%',
          left: '10%',
          width: 300,
          height: 300,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(108,99,255,0.08) 0%, transparent 70%)',
          animation: 'float 8s ease-in-out infinite',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      <div
        style={{
          position: 'fixed',
          bottom: '20%',
          right: '8%',
          width: 250,
          height: 250,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(59,130,246,0.06) 0%, transparent 70%)',
          animation: 'float 10s ease-in-out infinite 2s',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />

      {/* Login card */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          maxWidth: 420,
          background: 'rgba(17, 17, 24, 0.9)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-xl)',
          padding: '40px 36px',
          boxShadow: 'var(--shadow-lg), var(--shadow-glow)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          animation: 'scaleIn 0.4s cubic-bezier(0.34,1.56,0.64,1) both',
        }}
      >
        {/* Brand */}
        <div
          style={{
            textAlign: 'center',
            marginBottom: 36,
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              background: 'var(--accent-primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.6rem',
              margin: '0 auto 16px',
              boxShadow: 'var(--shadow-glow)',
              animation: 'pulse-glow 3s ease-in-out infinite',
            }}
          >
            ⚡
          </div>
          <h1
            style={{
              fontSize: '1.5rem',
              fontWeight: 700,
              letterSpacing: '-0.03em',
              background: 'linear-gradient(135deg, #f1f1f3 0%, #8b83ff 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
              marginBottom: 6,
            }}
          >
            Ofertas Manager
          </h1>
          <p
            style={{
              fontSize: '0.83rem',
              color: 'var(--text-muted)',
              letterSpacing: '0.02em',
            }}
          >
            Acesse sua conta para continuar
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          {error && (
            <div className="alert alert-error" style={{ marginBottom: 20 }}>
              <span>⚠</span>
              <span>{error}</span>
            </div>
          )}

          <div className="form-group">
            <label className="label" htmlFor="email">
              E-mail
            </label>
            <input
              id="email"
              type="email"
              className="input"
              placeholder="seu@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              disabled={loading}
              required
            />
          </div>

          <div className="form-group" style={{ marginBottom: 24 }}>
            <label className="label" htmlFor="password">
              Senha
            </label>
            <input
              id="password"
              type="password"
              className="input"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={loading}
              required
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-lg w-full"
            disabled={loading}
            style={{ width: '100%' }}
          >
            {loading ? (
              <>
                <span className="spinner spinner-sm" />
                Entrando…
              </>
            ) : (
              'Entrar'
            )}
          </button>
        </form>

        <div
          style={{
            marginTop: 28,
            paddingTop: 20,
            borderTop: '1px solid var(--border-subtle)',
            textAlign: 'center',
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
          }}
        >
          Sistema de gerenciamento de ofertas Telegram
        </div>
      </div>
    </div>
  )
}
