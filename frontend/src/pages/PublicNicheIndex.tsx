import React, { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'

const BASE_URL = (import.meta.env.VITE_API_URL as string) || '/api'

interface Niche {
  slug: string | null
  name: string
  offerCount: number
}

/**
 * Root of the public offers site (/ofertas). With a single active niche this
 * redirects straight into its feed — same one-click UX as before niches
 * existed. With 2+ niches, shows a chooser instead of mixing every niche's
 * offers into one feed.
 */
export default function PublicNicheIndex() {
  const [niches, setNiches] = useState<Niche[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`${BASE_URL}/public/niches`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<Niche[]>
      })
      .then((json) => {
        if (!cancelled) setNiches(json)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    return (
      <div style={styles.page}>
        <p style={styles.status}>Não foi possível carregar as ofertas no momento.</p>
      </div>
    )
  }

  if (niches === null) {
    return (
      <div style={styles.page}>
        <p style={styles.status}>Carregando…</p>
      </div>
    )
  }

  const withSlug = niches.filter((n): n is Niche & { slug: string } => !!n.slug)

  if (withSlug.length === 1) {
    return <Navigate to={`/ofertas/n/${withSlug[0].slug}`} replace />
  }

  if (withSlug.length === 0) {
    return (
      <div style={styles.page}>
        <p style={styles.status}>Nenhuma oferta publicada ainda.</p>
      </div>
    )
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <h1 style={styles.logo}>🔥 Ofertas</h1>
          <p style={styles.tagline}>Escolha um catálogo pra ver as promoções</p>
        </div>
      </header>
      <main style={styles.main}>
        <div style={styles.grid}>
          {withSlug.map((n) => (
            <Link key={n.slug} to={`/ofertas/n/${n.slug}`} style={styles.card}>
              <span style={styles.cardTitle}>{n.name}</span>
              <span style={styles.cardCount}>{n.offerCount} ofertas</span>
            </Link>
          ))}
        </div>
      </main>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    backgroundColor: '#0a0a0c',
    color: '#f0f0f5',
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  header: {
    borderBottom: '1px solid #27272a',
    padding: '2.5rem 1rem 2rem',
  },
  headerInner: {
    maxWidth: 800,
    margin: '0 auto',
    textAlign: 'center',
  },
  logo: {
    fontSize: '2rem',
    fontWeight: 900,
    margin: 0,
  },
  tagline: {
    color: '#a1a1aa',
    marginTop: '0.5rem',
    fontSize: '1rem',
  },
  main: {
    maxWidth: 800,
    margin: '0 auto',
    padding: '2rem 1rem 3rem',
  },
  status: {
    textAlign: 'center',
    color: '#a1a1aa',
    padding: '4rem 1rem',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: '1.25rem',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.4rem',
    backgroundColor: '#18181b',
    border: '1px solid #27272a',
    borderRadius: 14,
    padding: '1.5rem',
    textDecoration: 'none',
    color: '#f0f0f5',
  },
  cardTitle: {
    fontSize: '1.1rem',
    fontWeight: 700,
  },
  cardCount: {
    fontSize: '0.8rem',
    color: '#71717a',
  },
}
