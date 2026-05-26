import React, { useState, useEffect, useCallback, useRef } from 'react'
import api from '../lib/api'
import Toggle from '../components/Toggle'
import { Skeleton } from '../components/LoadingSkeleton'
import { useToast } from '../lib/toast'

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
          <><span className="spinner spinner-sm" /> Testando…</>
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
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [autoApprove, setAutoApprove] = useState(false)
  const [testTgBot, setTestTgBot] = useState<TestStatus>('idle')
  const [testWa, setTestWa] = useState<TestStatus>('idle')
  const [settingsData, setSettingsData] = useState<any>(null)
  
  const { addToast } = useToast()

  // Telegram auth flow
  const [tgPhone, setTgPhone] = useState('')
  const [tgCode, setTgCode] = useState('')
  const [authStep, setAuthStep] = useState<'idle' | 'code' | 'done'>('idle')
  const [authLoading, setAuthLoading] = useState(false)
  const [authMsg, setAuthMsg] = useState('')

  // Uncontrolled refs — browser cannot lock these via autofill
  const refBotToken      = useRef<HTMLInputElement>(null)
  const refApiId         = useRef<HTMLInputElement>(null)
  const refApiHash       = useRef<HTMLInputElement>(null)
  const refEvolutionUrl  = useRef<HTMLInputElement>(null)
  const refEvolutionKey  = useRef<HTMLInputElement>(null)
  const refEvolutionInst = useRef<HTMLInputElement>(null)

  const fetchSettings = useCallback(async () => {
    try {
      const s = await api.getSettings()
      setSettingsData(s)
      setAutoApprove(s.autoApprove ?? false)
      setTgPhone(s.telegramPhone ?? '')
      if (s.telegramAuthenticated) setAuthStep('done')
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSettings() }, [fetchSettings])

  const save = async (fields: Record<string, unknown>) => {
    setSaving(true)
    try {
      const updated = await api.updateSettings(fields as any)
      setSettingsData(updated)
      setAutoApprove(updated.autoApprove ?? false)
      setTgPhone(updated.telegramPhone ?? '')
      addToast('Configurações salvas com sucesso!', 'success')
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Erro ao salvar configurações', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleTestTgBot = async () => {
    setTestTgBot('loading')
    try {
      const res = await api.testTelegram()
      if (res.success) {
        setTestTgBot('success')
        addToast('Conexão com o Telegram Bot API realizada com sucesso!', 'success')
      } else {
        setTestTgBot('error')
        addToast('Falha na conexão com o Telegram Bot API.', 'error')
      }
    } catch (err) {
      setTestTgBot('error')
      addToast(err instanceof Error ? err.message : 'Erro ao testar conexão com Telegram Bot API', 'error')
    }
    setTimeout(() => setTestTgBot('idle'), 5000)
  }

  const handleTestWa = async () => {
    setTestWa('loading')
    try {
      const res = await api.testWhatsApp()
      if (res.success) {
        setTestWa('success')
        addToast('Conexão com a Evolution API (WhatsApp) realizada com sucesso!', 'success')
      } else {
        setTestWa('error')
        addToast('Falha na conexão com a Evolution API.', 'error')
      }
    } catch (err) {
      setTestWa('error')
      addToast(err instanceof Error ? err.message : 'Erro ao testar conexão com a Evolution API', 'error')
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
      addToast('Código de verificação enviado para o seu Telegram!', 'success')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro'
      setAuthMsg(`❌ ${msg}`)
      addToast(msg, 'error')
    } finally { setAuthLoading(false) }
  }

  const handleVerifyAuth = async () => {
    if (!tgCode) return
    setAuthLoading(true)
    setAuthMsg('')
    try {
      await api.verifyTelegramAuth(tgCode)
      setAuthStep('done')
      setAuthMsg('✅ Autenticado com sucesso!')
      addToast('Telegram autenticado com sucesso!', 'success')
      fetchSettings()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Código inválido'
      setAuthMsg(`❌ ${msg}`)
      addToast(msg, 'error')
    } finally { setAuthLoading(false) }
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
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 className="page-title">Configurações</h1>
          <p className="page-subtitle">Configure o comportamento e integrações do sistema</p>
        </div>
      </div>

      {/* ── Seção 1: Comportamento ─────────── */}
      <div className="settings-section">
        <div className="settings-section-header">
          <div className="settings-section-title">⚡ Comportamento</div>
          <div className="settings-section-desc">Configure como o sistema processa as ofertas recebidas</div>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', background: 'var(--bg-elevated)',
          borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)',
        }}>
          <div>
            <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>Aprovação Automática</div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 3 }}>Aprova e envia ofertas automaticamente sem revisão manual</div>
          </div>
          <Toggle checked={autoApprove} onChange={(v) => { setAutoApprove(v); save({ autoApprove: v }) }} />
        </div>
      </div>

      {/* ── Seção 2: Telegram Bot ──────────── */}
      <div className="settings-section">
        <div className="settings-section-header">
          <div className="settings-section-title">🤖 Telegram Bot (Envio)</div>
          <div className="settings-section-desc">Bot do Telegram usado para enviar as ofertas aos grupos destino</div>
        </div>

        <div className="form-group">
          <label className="label">Bot Token</label>
          {/* data-lpignore and data-form-type tell LastPass, Bitwarden, and Chrome not to autofill */}
          <input
            ref={refBotToken}
            defaultValue={settingsData?.telegramBotToken && settingsData.telegramBotToken !== '***' ? settingsData.telegramBotToken : ''}
            className="input font-mono"
            placeholder="1234567890:ABCDefGHIJKLMN..."
            type="text"
            autoComplete="new-password"
            data-lpignore="true"
            data-form-type="other"
            name={`tg-bot-token-${Date.now()}`}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 16 }}>
          <TestButton label="Testar conexão" onTest={handleTestTgBot} status={testTgBot} />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => save({ telegramBotToken: refBotToken.current?.value })}
            disabled={saving}
          >
            {saving ? <span className="spinner spinner-sm" /> : null}
            Salvar
          </button>
        </div>
      </div>

      {/* ── Seção 3: Telegram Conta Pessoal ── */}
      <div className="settings-section">
        <div className="settings-section-header">
          <div className="settings-section-title">📱 Telegram (Leitura — Conta Pessoal)</div>
          <div className="settings-section-desc">Conta pessoal Telegram usada para monitorar os grupos fonte via MTProto</div>
        </div>

        <div className="grid-2" style={{ marginBottom: 16 }}>
          <div className="form-group">
            <label className="label">API ID</label>
            <input
              ref={refApiId}
              defaultValue={settingsData?.telegramApiId ? String(settingsData.telegramApiId) : ''}
              className="input font-mono"
              placeholder="12345678"
              type="text"
              autoComplete="new-password"
              data-lpignore="true"
              data-form-type="other"
              name={`tg-api-id-${Date.now()}`}
              inputMode="numeric"
              onInput={(e) => {
                // strip anything that is not a digit AFTER the browser places it
                const el = e.currentTarget
                el.value = el.value.replace(/\D/g, '')
              }}
            />
          </div>
          <div className="form-group">
            <label className="label">API Hash</label>
            <input
              ref={refApiHash}
              defaultValue={settingsData?.telegramApiHash ?? ''}
              className="input font-mono"
              placeholder="0a1b2c3d4e5f..."
              type="text"
              autoComplete="new-password"
              data-lpignore="true"
              data-form-type="other"
              name={`tg-api-hash-${Date.now()}`}
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
        <div style={{
          padding: '16px 20px', background: 'var(--bg-elevated)',
          borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', marginBottom: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: authMsg ? 12 : 0 }}>
            <span style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.83rem', fontWeight: 600,
              color: authStep === 'done' ? 'var(--accent-success)' : 'var(--text-secondary)',
            }}>
              {authStep === 'done' ? (
                <><span className="status-dot online" />Autenticado</>
              ) : (
                <><span className="status-dot offline" />Não autenticado</>
              )}
            </span>
            {authStep !== 'done' && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleStartAuth}
                disabled={authLoading || !tgPhone}
              >
                {authLoading && authStep === 'idle' ? <span className="spinner spinner-sm" /> : null}
                🔑 Autenticar com Telegram
              </button>
            )}
          </div>

          {authMsg && (
            <div style={{
              fontSize: '0.82rem',
              color: authMsg.startsWith('✅') ? 'var(--accent-success)'
                   : authMsg.startsWith('❌') ? 'var(--accent-danger)'
                   : 'var(--accent-info)',
              marginBottom: 8,
            }}>
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
            onClick={() => save({
              telegramApiId: refApiId.current?.value ? Number(refApiId.current.value) : undefined,
              telegramApiHash: refApiHash.current?.value,
              telegramPhone: tgPhone,
            })}
            disabled={saving}
          >
            {saving ? <span className="spinner spinner-sm" /> : null}
            Salvar
          </button>
        </div>
      </div>

      {/* ── Seção 4: WhatsApp ──────────────── */}
      <div className="settings-section">
        <div className="settings-section-header">
          <div className="settings-section-title">💬 WhatsApp (Evolution API)</div>
          <div className="settings-section-desc">Integração com Evolution API para envio de mensagens WhatsApp</div>
        </div>

        <div className="form-group">
          <label className="label">URL da Evolution API</label>
          <input
            ref={refEvolutionUrl}
            defaultValue={settingsData?.evolutionApiUrl ?? ''}
            className="input"
            placeholder="https://api.seudominio.com"
            type="text"
            autoComplete="off"
            data-lpignore="true"
            data-form-type="other"
            name={`ev-url-${Date.now()}`}
          />
        </div>

        <div className="grid-2">
          <div className="form-group">
            <label className="label">API Key</label>
            <input
              ref={refEvolutionKey}
              defaultValue={settingsData?.evolutionApiKey && settingsData.evolutionApiKey !== '***' ? settingsData.evolutionApiKey : ''}
              className="input font-mono"
              placeholder="sua-api-key"
              type="text"
              autoComplete="new-password"
              data-lpignore="true"
              data-form-type="other"
              name={`ev-key-${Date.now()}`}
            />
          </div>
          <div className="form-group">
            <label className="label">Nome da Instância</label>
            <input
              ref={refEvolutionInst}
              defaultValue={settingsData?.evolutionInstance ?? ''}
              className="input"
              placeholder="minha-instancia"
              type="text"
              autoComplete="off"
              data-lpignore="true"
              data-form-type="other"
              name={`ev-inst-${Date.now()}`}
            />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 16 }}>
          <TestButton label="Testar conexão" onTest={handleTestWa} status={testWa} />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => save({
              evolutionApiUrl:  refEvolutionUrl.current?.value,
              evolutionApiKey:  refEvolutionKey.current?.value,
              evolutionInstance: refEvolutionInst.current?.value,
            })}
            disabled={saving}
          >
            {saving ? <span className="spinner spinner-sm" /> : null}
            Salvar
          </button>
        </div>
      </div>
    </div>
  )
}
