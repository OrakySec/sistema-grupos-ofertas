import React, { useState, useEffect } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import api from '../lib/api'

interface NavItem {
  to: string
  icon: string
  label: string
  badge?: number
}

export default function Layout() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)

  // Fetch pending count for badge
  useEffect(() => {
    const fetchPending = async () => {
      try {
        const stats = await api.getStats()
        setPendingCount(stats.pending)
      } catch {
        // silently ignore
      }
    }
    fetchPending()
    const interval = setInterval(fetchPending, 30_000)
    return () => clearInterval(interval)
  }, [])

  // Close sidebar on route change (mobile)
  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname])

  const navItems: NavItem[] = [
    { to: '/dashboard', icon: '📊', label: 'Dashboard' },
    { to: '/queue', icon: '⏳', label: 'Aprovação', badge: pendingCount },
    { to: '/history', icon: '📋', label: 'Histórico' },
    { to: '/groups', icon: '👥', label: 'Grupos' },
    { to: '/settings', icon: '⚙️', label: 'Configurações' },
    { to: '/logs', icon: '📊', label: 'Logs & Debug' },
  ]

  return (
    <div className="layout">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="overlay"
          style={{ zIndex: 49 }}
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        {/* Brand */}
        <div
          style={{
            padding: '24px 20px 20px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                background: 'var(--accent-primary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1.1rem',
                boxShadow: 'var(--shadow-glow-sm)',
                flexShrink: 0,
              }}
            >
              ⚡
            </div>
            <div>
              <div
                style={{
                  fontSize: '1rem',
                  fontWeight: 700,
                  background: 'linear-gradient(135deg, #f1f1f3 0%, #8b83ff 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                  letterSpacing: '-0.02em',
                }}
              >
                Ofertas
              </div>
              <div
                style={{
                  fontSize: '0.68rem',
                  color: 'var(--text-muted)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  fontWeight: 600,
                  marginTop: -2,
                }}
              >
                Manager
              </div>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav
          style={{
            flex: 1,
            padding: '12px 10px',
            overflowY: 'auto',
          }}
        >
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 'var(--radius-md)',
                marginBottom: 2,
                fontSize: '0.875rem',
                fontWeight: isActive ? 600 : 500,
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                background: isActive ? 'var(--accent-primary-dim)' : 'transparent',
                borderLeft: isActive
                  ? '3px solid var(--accent-primary)'
                  : '3px solid transparent',
                transition: 'all var(--transition)',
                textDecoration: 'none',
              })}
            >
              <span style={{ fontSize: '1rem', flexShrink: 0 }}>{item.icon}</span>
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.badge !== undefined && item.badge > 0 && (
                <span
                  style={{
                    background: 'var(--accent-warning)',
                    color: '#000',
                    borderRadius: 'var(--radius-full)',
                    fontSize: '0.65rem',
                    fontWeight: 700,
                    minWidth: 18,
                    height: 18,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '0 5px',
                  }}
                >
                  {item.badge > 99 ? '99+' : item.badge}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        {/* User + Logout */}
        <div
          style={{
            padding: '16px 12px',
            borderTop: '1px solid var(--border-subtle)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-glass)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: '50%',
                background: 'var(--accent-primary-dim)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.75rem',
                fontWeight: 700,
                color: 'var(--text-accent)',
                flexShrink: 0,
                border: '1px solid rgba(108,99,255,0.3)',
              }}
            >
              {user?.email?.charAt(0).toUpperCase() ?? 'U'}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                className="truncate"
                style={{
                  fontSize: '0.78rem',
                  color: 'var(--text-secondary)',
                  fontWeight: 500,
                }}
              >
                {user?.email ?? 'Usuário'}
              </div>
            </div>
            <button
              className="icon-btn danger"
              onClick={logout}
              data-tooltip="Sair"
              title="Sair"
              style={{ width: 28, height: 28, fontSize: '0.85rem' }}
            >
              ↩
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="main-content">
        {/* Mobile top bar */}
        <div
          style={{
            display: 'none',
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-subtle)',
            alignItems: 'center',
            gap: 12,
            background: 'var(--bg-surface)',
            position: 'sticky',
            top: 0,
            zIndex: 40,
          }}
          className="mobile-topbar"
        >
          <button
            className="hamburger"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Toggle sidebar"
          >
            <span />
            <span />
            <span />
          </button>
          <span
            style={{
              fontWeight: 700,
              fontSize: '1rem',
              background: 'linear-gradient(135deg, #f1f1f3 0%, #8b83ff 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            ⚡ Ofertas Manager
          </span>
        </div>

        <div className="content-area">
          <Outlet />
        </div>
      </div>

      <style>{`
        @media (max-width: 768px) {
          .mobile-topbar { display: flex !important; }
        }
      `}</style>
    </div>
  )
}
