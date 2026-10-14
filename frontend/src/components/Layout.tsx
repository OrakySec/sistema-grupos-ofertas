import React, { useState, useEffect } from 'react'
import { NavLink, Link, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import api from '../lib/api'
import Icon from './Icon'

interface NavItem {
  to: string
  icon: string
  label: string
  badge?: number
}

interface NavSection {
  title: string
  items: NavItem[]
}

const TODAY_FMT = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })

export default function Layout() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)

  // Pending count for the "Aprovação" badge
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

  const sections: NavSection[] = [
    {
      title: 'Operação',
      items: [
        { to: '/dashboard', icon: 'dashboard', label: 'Dashboard' },
        { to: '/queue', icon: 'inbox', label: 'Aprovação', badge: pendingCount },
        { to: '/history', icon: 'history', label: 'Histórico' },
      ],
    },
    {
      title: 'Gestão',
      items: [
        { to: '/analytics', icon: 'trendUp', label: 'Analytics' },
        { to: '/groups', icon: 'users', label: 'Grupos' },
        { to: '/shopee', icon: 'bag', label: 'Busca Shopee' },
        { to: '/clicks', icon: 'cursor', label: 'Cliques' },
      ],
    },
    {
      title: 'Sistema',
      items: [
        { to: '/settings', icon: 'settings', label: 'Configurações' },
        { to: '/logs', icon: 'activity', label: 'Logs & Debug' },
      ],
    },
  ]

  const current = sections.flatMap((s) => s.items).find((i) => location.pathname.startsWith(i.to))
  const initial = user?.email?.charAt(0).toUpperCase() ?? 'U'

  return (
    <div className="layout">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="overlay" style={{ zIndex: 49 }} onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sidebar-brand">
          <div className="brand-mark">
            <Icon name="zap" strokeWidth={2.2} />
          </div>
          <div>
            <div className="brand-name">Ofertas</div>
            <div className="brand-sub">Manager</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {sections.map((section) => (
            <div key={section.title}>
              <div className="nav-section">{section.title}</div>
              {section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="nav-badge">{item.badge > 99 ? '99+' : item.badge}</span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="user-card">
            <div className="avatar">{initial}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="truncate" style={{ fontSize: '0.8rem', color: 'var(--text-primary)', fontWeight: 550 }}>
                {user?.email?.split('@')[0] ?? 'Usuário'}
              </div>
              <div className="truncate" style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                {user?.email ?? ''}
              </div>
            </div>
            <button className="icon-btn danger" onClick={logout} title="Sair" aria-label="Sair" style={{ width: 30, height: 30 }}>
              <Icon name="logout" size={15} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="main-content">
        <header className="topbar">
          <button className="hamburger" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Abrir menu">
            <Icon name="menu" />
          </button>
          <div className="breadcrumb">
            <span>Ofertas</span>
            <Icon name="chevronRight" />
            <strong className="truncate">{current?.label ?? 'Painel'}</strong>
          </div>
          <div className="topbar-right">
            {pendingCount > 0 && !location.pathname.startsWith('/queue') && (
              <Link to="/queue" className="topbar-pill" style={{ color: '#ffc15e', borderColor: 'rgba(245,165,36,0.25)' }}>
                <span className="status-dot warning" />
                {pendingCount}<span className="pill-label"> aguardando aprovação</span>
              </Link>
            )}
            <span className="topbar-pill hide-mobile" style={{ textTransform: 'capitalize' }}>
              <Icon name="clock" size={13} />
              {TODAY_FMT.format(new Date()).replace('.', '')}
            </span>
          </div>
        </header>

        <main className="content-area" key={location.pathname}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
