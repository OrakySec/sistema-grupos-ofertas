import React, { useState, type FormEvent } from 'react'
import { useAuth } from '../lib/auth'
import { useNavigate } from 'react-router-dom'
import Icon from '../components/Icon'

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
      setError(err instanceof Error ? err.message : 'Erro ao fazer login. Tente novamente.')
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
      <div className="login-bg" />
      <div className="login-bg-noise" />

      <div style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 400, animation: 'scaleIn 0.35s cubic-bezier(0.16,1,0.3,1) both' }}>
        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div
            className="brand-mark"
            style={{ width: 52, height: 52, borderRadius: 15, margin: '0 auto 18px', animation: 'pulse-glow 4s ease-in-out infinite' }}
          >
            <Icon name="zap" size={24} strokeWidth={2.2} />
          </div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 650, letterSpacing: '-0.035em', marginBottom: 6 }}>
            Bem-vindo de volta
          </h1>
          <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
            Entre para gerenciar seus grupos de ofertas
          </p>
        </div>

        {/* Card */}
        <div
          style={{
            background: 'rgba(16, 16, 20, 0.78)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-xl)',
            padding: '28px 28px 24px',
            boxShadow: 'var(--highlight-top), var(--shadow-lg)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
          }}
        >
          <form onSubmit={handleSubmit}>
            {error && (
              <div className="alert alert-error" style={{ marginBottom: 18 }}>
                <Icon name="alert" size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>{error}</span>
              </div>
            )}

            <div className="form-group">
              <label className="label" htmlFor="email">E-mail</label>
              <input
                id="email"
                type="email"
                className="input"
                placeholder="voce@empresa.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                disabled={loading}
                required
                autoFocus
              />
            </div>

            <div className="form-group" style={{ marginBottom: 22 }}>
              <label className="label" htmlFor="password">Senha</label>
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

            <button type="submit" className="btn btn-primary btn-lg" disabled={loading} style={{ width: '100%' }}>
              {loading ? (
                <>
                  <span className="spinner spinner-sm" />
                  Entrando…
                </>
              ) : (
                <>
                  Entrar
                  <Icon name="arrowRight" />
                </>
              )}
            </button>
          </form>
        </div>

        <p style={{ marginTop: 22, textAlign: 'center', fontSize: '0.76rem', color: 'var(--text-muted)' }}>
          Ofertas Manager · Telegram e WhatsApp
        </p>
      </div>
    </div>
  )
}
