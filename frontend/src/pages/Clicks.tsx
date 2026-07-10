import React, { useEffect, useState } from 'react'
import api from '../lib/api'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from 'recharts'
import { useToast } from '../lib/toast'

interface ClickStats {
  total: number
  chartData: { date: string; clicks: number }[]
  topLinks: { originalUrl: string; title?: string; count: number }[]
}

export default function Clicks() {
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState('today')
  const [stats, setStats] = useState<ClickStats | null>(null)
  const { addToast } = useToast()

  const fetchStats = async (selectedPeriod: string) => {
    try {
      setLoading(true)
      const data = await api.getClicksStats(selectedPeriod)
      setStats(data)
    } catch (err) {
      addToast('Erro ao carregar estatísticas de cliques', 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStats(period)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period])

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 30 }}>
        <h2>Estatísticas de Cliques</h2>
        <div style={{ display: 'flex', gap: '10px' }}>
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            style={{
              padding: '8px 12px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-glass)',
              color: 'var(--text-primary)',
              fontWeight: 500,
              outline: 'none',
              cursor: 'pointer'
            }}
          >
            <option value="today">Hoje</option>
            <option value="yesterday">Ontem</option>
            <option value="7d">Últimos 7 dias</option>
            <option value="30d">Últimos 30 dias</option>
            <option value="all">Todo o período</option>
          </select>
          <button className="btn" onClick={() => fetchStats(period)} disabled={loading}>
            {loading ? 'Atualizando...' : 'Atualizar'}
          </button>
        </div>
      </div>

      {loading && !stats ? (
        <div style={{ textAlign: 'center', padding: 50 }}>
          <div className="spinner spinner-lg"></div>
        </div>
      ) : stats ? (
        <>
          {/* Top Metric */}
          <div style={{ marginBottom: 30 }}>
            <div
              style={{
                background: 'var(--bg-glass)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-lg)',
                padding: '24px',
                display: 'flex',
                alignItems: 'center',
                gap: 20
              }}
            >
              <div
                style={{
                  width: 50,
                  height: 50,
                  borderRadius: 12,
                  background: 'rgba(108, 99, 255, 0.1)',
                  color: 'var(--accent-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '1.5rem'
                }}
              >
                🖱️
              </div>
              <div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
                  Total de Cliques
                </div>
                <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                  {stats.total.toLocaleString('pt-BR')}
                </div>
              </div>
            </div>
          </div>

          {/* Chart */}
          <div
            style={{
              background: 'var(--bg-glass)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: '24px',
              marginBottom: 30
            }}
          >
            <h3 style={{ marginBottom: 20, fontSize: '1.1rem' }}>Evolução de Cliques</h3>
            <div style={{ width: '100%', height: 350 }}>
              <ResponsiveContainer>
                <AreaChart data={stats.chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorClicks" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--accent-primary)" stopOpacity={0.4}/>
                      <stop offset="95%" stopColor="var(--accent-primary)" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                  <XAxis 
                    dataKey="date" 
                    stroke="var(--text-muted)" 
                    fontSize={12} 
                    tickLine={false}
                    axisLine={false}
                    dy={10}
                  />
                  <YAxis 
                    stroke="var(--text-muted)" 
                    fontSize={12} 
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => value > 0 ? value : ''}
                  />
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'var(--bg-surface)', 
                      borderColor: 'var(--border-subtle)',
                      borderRadius: 'var(--radius-md)'
                    }}
                    itemStyle={{ color: 'var(--accent-primary)' }}
                  />
                  <Area 
                    type="monotone" 
                    dataKey="clicks" 
                    name="Cliques"
                    stroke="var(--accent-primary)" 
                    strokeWidth={3}
                    fillOpacity={1} 
                    fill="url(#colorClicks)" 
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Top Links */}
          <div
            style={{
              background: 'var(--bg-glass)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: '24px',
            }}
          >
            <h3 style={{ marginBottom: 20, fontSize: '1.1rem' }}>Top 5 Links Mais Clicados</h3>
            
            {stats.topLinks.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '20px 0' }}>
                Nenhum clique registrado neste período.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                {stats.topLinks.map((link, idx) => (
                  <div 
                    key={idx}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 16px',
                      background: 'rgba(255,255,255,0.02)',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid rgba(255,255,255,0.05)'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '15px', overflow: 'hidden' }}>
                      <div style={{ 
                        width: 28, 
                        height: 28, 
                        borderRadius: '50%', 
                        background: 'var(--accent-primary-dim)', 
                        color: 'var(--accent-primary)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 'bold',
                        fontSize: '0.8rem'
                      }}>
                        {idx + 1}
                      </div>
                      <div className="truncate" style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', maxWidth: '400px' }}>
                        <a href={link.originalUrl} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
                          {link.title || link.originalUrl}
                        </a>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '1.1rem', fontWeight: 700 }}>{link.count}</span>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>cliques</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
