import React, { useState, useEffect, useCallback } from 'react'
import api, { type Settings } from '../lib/api'
import Toggle from '../components/Toggle'
import { Skeleton } from '../components/LoadingSkeleton'

type TestStatus = 'idle' | 'loading' | 'success' | 'error'

function TestButton({
  label,
  onTest,
  status,
}: {
  label: string
  onTest: () => void
  status: TestStatus
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={onTest}
        disabled={status === 'loading'}
      >
        {status === 'loading' ? (
          <>
            <span className="spinner spinner-sm" /> Testando…
          </>
        ) : (
          `🔌 ${label}`
        )}
      </button>
      {status === 'success' && (
        <span style={{ color: 'var(--accent-success)', fontSize: '0.82rem', fontWeight: 600 }}>
          ✅ Conectado
        </span>
      )}
      {status === 'error' && (
        <span style={{ color: 'var(--accent-danger)', fontSize: '0.82rem', fontWeight: 600 }}>
          ❌ Falhou
        </span>
      )}
    </div>
  )
}

export default function Settings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  // Telegram auth flow
  const [tgPhone, setTgPhone] = useState('')
  const [tgCode, setTgCode] = useState('')
  const [authStep, setAuthStep] = useState<'idle' | 'code' | 'done'>('idle')
  const [authLoading, setAuthLoading] = useState(false)
  const [authMsg, setAuthMsg] = useState('')

  // Test statuses
  const [testTgBot, setTestTgBot] = useState<TestStatus>('idle')
  const [testWa, setTestWa] = useState<TestStatus>('idle')

  const fetchSettings = useCallback(async () => {
    try {
      const s = await api.getSettings()
      setSettings(s)
      setTgPhone(s.telegramPhone ?? '')
      if (s.telegramAuthenticated) setAuthStep('done')
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  const update = (key: keyof Settings, value: unknown) => {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  const save = async (fields: Partial<Settings>) => {
    setSaving(true)
    setSaveMsg('')
    try {
      const updated = await api.updateSettings(fields)
      setSettings(updated)
      setSaveMsg('✅ Salvo com sucesso!')
    } catch (err) {
      setSaveMsg(`❌ ${err instanceof Error ? err.message : 'Erro ao salvar'}`)
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(''), 3000)
    }
  }

  const handleTestTgBot = async () => {
    setTestTgBot('loading')
    try {
      const res = await api.testTelegram()
      setTestTgBot(res.success ? 'success' : 'error')
    } catch {
      setTestTgBot('error')
    }
    setTimeout(() => setTestTgBot('idle'), 5000)
  }

  const handleTestWa = async () => {
    setTestWa('loading')
    try {
      const res = await api.testWhatsApp()
      setTestWa(res.success ? 'success' : 'error')
    } catch {
      setTestWa('error')
    }
    setTimeout(() => setTestWa('idle'), 5000)
  }

  const handleStartAuth = async () => {
    if (!tgPhone) return
    setAuthLoading(true)
    setAuthMsg('')
    try {
      await api.startTelegramAuth(tgPhone)
      setAuthStep('code')
      setAuthMsg('Código enviado para o Telegram.')
    } catch (err) {
      setAuthMsg(`❌ ${err instanceof Error ? err.message : 'Erro'}`)
    } finally {
      setAuthLoading(false)
    }
  }

  const handleVerifyAuth = async () => {
    if (!tgCode) return
    setAuthLoading(true)
    setAuthMsg('')
    try {
      await api.verifyTelegramAuth(tgCode)
      setAuthStep('done')
      setAuthMsg('✅ Autenticado com sucesso!')
      fetchSettings()
    } catch (err) {
      setAuthMsg(`❌ ${err instanceof Error ? err.message : 'Código inválido'}`)
    } finally {
      setAuthLoading(false)
    }
  }

  if (loading) {
    return (
      <div style={{ animation: 'fadeIn 0.3s ease' }}>
        <div className="page-header">
          <h1 className="page-title">Configurações</h1>
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="settings-section" style={{ marginBottom: 16 }}>
            <Skeleton height={24} width={200} style={{ marginBottom: 16 }} />
            <Skeleton height={40} />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div style={{ animation: 'fadeIn 0.3s ease' }}>
      {/*
        DECOY: A hidden username+password pair at the very top of the page.
        Browsers scan for the first [type=password] to inject saved credentials into.
        This invisible decoy absorbs the autofill so real fields are left untouched.
      */}
      <input type="text" name="username_decoy" style={{ display: 'none' }} readOnly tabIndex={-1} aria-hidden="true" />
      <input type="password" name="password_decoy" style={{ display: 'none' }} readOnly tabIndex={-1} aria-hidden="true" />

      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 className="page-title">Configurações</h1>
          <p className="page-subtitle">Configure o comportamento e integrações do sistema</p>
        </div>
        {saveMsg && (
          <span
            style={{
              fontSize: '0.83rem',
              color: saveMsg.startsWith('✅') ? 'var(--accent-success)' : 'var(--accent-danger)',
              animation: 'fadeIn 0.2s ease',
              paddingTop: 8,
            }}
          >
            {saveMsg}
          </span>
        )}
      </div>

      {/* ── Seção 1: Comportamento ─────────── */}
      <div className="settings-section">
        <div className="settings-section-header">
          <div className="settings-section-title">⚡ Comportamento</div>
          <div className="settings-section-desc">
            Configure como o sistema processa as ofertas recebidas
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            background: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <div>
            <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>
              Aprovação Automática
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 3 }}>
              Aprova e envia ofertas automaticamente sem revisão manual
            </div>
          </div>
          <Toggle
            checked={settings?.autoApprove ?? false}
            onChange={(v) => {
              update('autoApprove', v)
              save({ autoApprove: v })
            }}
          />
        </div>
      </div>

      {/* ── Seção 2: Telegram Bot ──────────── */}
      {/* Each section is its own <form autoComplete="off"> to prevent cross-section autofill */}
      <div className="settings-section">
        <div className="settings-section-header">
          <div className="settings-section-title">🤖 Telegram Bot (Envio)</div>
          <div className="settings-section-desc">
            Bot do Telegram usado para enviar as ofertas aos grupos destino
          </div>
        </div>

        <form autoComplete="off" onSubmit={(e) => e.preventDefault()}>
          <div className="form-group">
            <label className="label">Bot Token</label>
            <input
              className="input font-mono"
              placeholder="1234567890:ABCDefGHIJKLMN..."
              type="text"
              autoComplete="new-password"
              value={settings?.telegramBotToken ?? ''}
              onChange={(e) => update('telegramBotToken', e.target.value)}
            />
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              marginTop: 16,
            }}
          >
            <TestButton
              label="Testar conexão"
              onTest={handleTestTgBot}
              status={testTgBot}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => save({ telegramBotToken: settings?.telegramBotToken })}
              disabled={saving}
            >
              {saving ? <span className="spinner spinner-sm" /> : null}
              Salvar
            </button>
          </div>
        </form>
      </div>

      {/* ── Seção 3: Telegram Conta Pessoal ── */}
      <div className="settings-section">
        <div className="settings-section-header">
          <div className="settings-section-title">📱 Telegram (Leitura — Conta Pessoal)</div>
          <div className="settings-section-desc">
            Conta pessoal Telegram usada para monitorar os grupos fonte via MTProto
          </div>
        </div>

        <form autoComplete="off" onSubmit={(e) => e.preventDefault()}>
          <div className="grid-2" style={{ marginBottom: 16 }}>
            <div className="form-group">
              <label className="label">API ID</label>
              <input
                className="input font-mono"
                placeholder="12345678"
                type="text"
                autoComplete="new-password"
                inputMode="numeric"
                value={settings?.telegramApiId ?? ''}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, '')
                  update('telegramApiId', val ? Number(val) : undefined)
                }}
              />
            </div>
            <div className="form-group">
              <label className="label">API Hash</label>
              <input
                className="input font-mono"
                placeholder="0a1b2c3d4e5f..."
                type="text"
                autoComplete="new-password"
                value={settings?.telegramApiHash ?? ''}
                onChange={(e) => update('telegramApiHash', e.target.value)}
              />
            </div>
          </div>

          <div className="form-group">
            <label className="label">Número de telefone</label>
            <input
              className="input"
              placeholder="+5511999999999"
              type="tel"
              autoComplete="tel"
              value={tgPhone}
              onChange={(e) => setTgPhone(e.target.value)}
            />
          </div>

          {/* Auth flow */}
          <div
            style={{
              padding: '16px 20px',
              background: 'var(--bg-elevated)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-subtle)',
              marginBottom: 16,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginBottom: authMsg ? 12 : 0,
              }}
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: '0.83rem',
                  fontWeight: 600,
                  color:
                    authStep === 'done'
                      ? 'var(--accent-success)'
                      : 'var(--text-secondary)',
                }}
              >
                {authStep === 'done' ? (
                  <>
                    <span className="status-dot online" />
                    Autenticado
                  </>
                ) : (
                  <>
                    <span className="status-dot offline" />
                    Não autenticado
                  </>
                )}
              </span>

              {authStep !== 'done' && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleStartAuth}
                  disabled={authLoading || !tgPhone}
                >
                  {authLoading && authStep === 'idle' ? (
                    <span className="spinner spinner-sm" />
                  ) : null}
                  🔑 Autenticar com Telegram
                </button>
              )}
            </div>

            {authMsg && (
              <div
                style={{
                  fontSize: '0.82rem',
                  color: authMsg.startsWith('✅')
                    ? 'var(--accent-success)'
                    : authMsg.startsWith('❌')
                    ? 'var(--accent-danger)'
                    : 'var(--accent-info)',
                  marginBottom: 8,
                }}
              >
                {authMsg}
              </div>
            )}

            {authStep === 'code' && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 8 }}>
                <div style={{ flex: 1 }}>
                  <label className="label">Código de verificação (5 dígitos)</label>
                  <input
                    className="input font-mono"
                    placeholder="12345"
                    type="text"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={5}
                    value={tgCode}
                    onChange={(e) => setTgCode(e.target.value.replace(/\D/g, ''))}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleVerifyAuth}
                  disabled={authLoading || tgCode.length < 5}
                >
                  {authLoading ? <span className="spinner spinner-sm" /> : null}
                  Confirmar código
                </button>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() =>
                save({
                  telegramApiId: settings?.telegramApiId,
                  telegramApiHash: settings?.telegramApiHash,
                  telegramPhone: tgPhone,
                })
              }
              disabled={saving}
            >
              {saving ? <span className="spinner spinner-sm" /> : null}
              Salvar
            </button>
          </div>
        </form>
      </div>

      {/* ── Seção 4: WhatsApp ──────────────── */}
      <div className="settings-section">
        <div className="settings-section-header">
          <div className="settings-section-title">💬 WhatsApp (Evolution API)</div>
          <div className="settings-section-desc">
            Integração com Evolution API para envio de mensagens WhatsApp
          </div>
        </div>

        <form autoComplete="off" onSubmit={(e) => e.preventDefault()}>
          <div className="form-group">
            <label className="label">URL da Evolution API</label>
            <input
              className="input"
              placeholder="https://api.seudominio.com"
              type="url"
              autoComplete="off"
              value={settings?.evolutionApiUrl ?? ''}
              onChange={(e) => update('evolutionApiUrl', e.target.value)}
            />
          </div>

          <div className="grid-2">
            <div className="form-group">
              <label className="label">API Key</label>
              <input
                className="input font-mono"
                placeholder="sua-api-key"
                type="text"
                autoComplete="new-password"
                value={settings?.evolutionApiKey ?? ''}
                onChange={(e) => update('evolutionApiKey', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="label">Nome da Instância</label>
              <input
                className="input"
                placeholder="minha-instancia"
                type="text"
                autoComplete="off"
                value={settings?.evolutionInstance ?? ''}
                onChange={(e) => update('evolutionInstance', e.target.value)}
              />
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              marginTop: 16,
            }}
          >
            <TestButton
              label="Testar conexão"
              onTest={handleTestWa}
              status={testWa}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() =>
                save({
                  evolutionApiUrl: settings?.evolutionApiUrl,
                  evolutionApiKey: settings?.evolutionApiKey,
                  evolutionInstance: settings?.evolutionInstance,
                })
              }
              disabled={saving}
            >
              {saving ? <span className="spinner spinner-sm" /> : null}
              Salvar
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
