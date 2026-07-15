import React, { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

const BASE_URL = (import.meta.env.VITE_API_URL as string) || '/api'

interface PublicOffer {
  id: string
  text: string | null
  mediaCaption: string | null
  mediaType: string
  mediaPath: string | null
  sentAt: string
  platform: string | null
  affiliateUrl: string | null
  niche: { slug: string | null; name: string } | null
}

interface PublicOffersResponse {
  data: PublicOffer[]
  pagination: { page: number; limit: number; total: number; pages: number }
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  })
}

export default function PublicOffers() {
  const { slug } = useParams<{ slug?: string }>()
  const [offers, setOffers] = useState<PublicOffer[]>([])
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    const qs = new URLSearchParams({ page: String(page), limit: '20' })
    if (slug) qs.set('slug', slug)
    fetch(`${BASE_URL}/public/offers?${qs.toString()}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<PublicOffersResponse>
      })
      .then((json) => {
        if (cancelled) return
        setOffers(json.data)
        setPages(json.pagination.pages)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [page, slug])

  const nicheName = offers[0]?.niche?.name

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <h1 style={styles.logo}>🔥 {nicheName || 'Ofertas'}</h1>
          <p style={styles.tagline}>Promoções e cupons selecionados diariamente</p>
        </div>
      </header>

      <main style={styles.main}>
        {loading && <p style={styles.status}>Carregando ofertas…</p>}
        {error && <p style={styles.status}>Não foi possível carregar as ofertas no momento.</p>}
        {!loading && !error && offers.length === 0 && (
          <p style={styles.status}>Nenhuma oferta publicada ainda.</p>
        )}

        {!loading && !error && offers.length > 0 && (
          <div style={styles.grid}>
            {offers.map((offer) => {
              const excerpt = (offer.mediaCaption ?? offer.text ?? '').slice(0, 160)
              return (
                <Link key={offer.id} to={`/ofertas/${offer.id}`} style={styles.card}>
                  {offer.mediaType === 'PHOTO' && offer.mediaPath && (
                    <img
                      src={`${BASE_URL}/media/${offer.mediaPath}`}
                      alt={excerpt || 'Oferta'}
                      style={styles.cardImage}
                      loading="lazy"
                    />
                  )}
                  <div style={styles.cardBody}>
                    {offer.platform && <span style={styles.badge}>{offer.platform}</span>}
                    <p style={styles.cardText}>
                      {excerpt}
                      {excerpt.length >= 160 ? '…' : ''}
                    </p>
                    <span style={styles.cardDate}>{formatDate(offer.sentAt)}</span>
                  </div>
                </Link>
              )
            })}
          </div>
        )}

        {!loading && !error && pages > 1 && (
          <div style={styles.pagination}>
            <button
              style={{ ...styles.pageBtn, opacity: page <= 1 ? 0.4 : 1 }}
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← Anteriores
            </button>
            <span style={styles.pageLabel}>
              Página {page} de {pages}
            </span>
            <button
              style={{ ...styles.pageBtn, opacity: page >= pages ? 0.4 : 1 }}
              disabled={page >= pages}
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
            >
              Mais recentes →
            </button>
          </div>
        )}
      </main>

      <footer style={styles.footer}>
        <p>
          Como Associados Amazon, ganhamos com compras qualificadas. Este site também pode
          participar de outros programas de afiliados e receber comissão por compras feitas através
          de nossos links, sem custo adicional para você.
        </p>
      </footer>
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
    maxWidth: 1000,
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
    maxWidth: 1000,
    margin: '0 auto',
    padding: '2rem 1rem 3rem',
  },
  status: {
    textAlign: 'center',
    color: '#a1a1aa',
    padding: '3rem 0',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: '1.25rem',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#18181b',
    border: '1px solid #27272a',
    borderRadius: 14,
    overflow: 'hidden',
    textDecoration: 'none',
    color: '#f0f0f5',
    transition: 'border-color 0.15s, transform 0.15s',
  },
  cardImage: {
    width: '100%',
    aspectRatio: '1 / 1',
    objectFit: 'cover',
    display: 'block',
    backgroundColor: '#0a0a0c',
  },
  cardBody: {
    padding: '0.9rem 1rem 1.1rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  badge: {
    alignSelf: 'flex-start',
    fontSize: '0.7rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#ff5e00',
    backgroundColor: 'rgba(255,94,0,0.1)',
    border: '1px solid rgba(255,94,0,0.3)',
    borderRadius: 6,
    padding: '2px 8px',
  },
  cardText: {
    fontSize: '0.85rem',
    lineHeight: 1.5,
    color: '#d4d4d8',
    margin: 0,
  },
  cardDate: {
    fontSize: '0.75rem',
    color: '#71717a',
  },
  pagination: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1.5rem',
    marginTop: '2.5rem',
  },
  pageBtn: {
    background: 'none',
    border: '1px solid #3f3f46',
    color: '#f0f0f5',
    borderRadius: 8,
    padding: '0.5rem 1rem',
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  pageLabel: {
    fontSize: '0.8rem',
    color: '#71717a',
  },
  footer: {
    borderTop: '1px solid #27272a',
    padding: '1.5rem 1rem',
    maxWidth: 1000,
    margin: '0 auto',
    fontSize: '0.75rem',
    color: '#71717a',
    lineHeight: 1.6,
    textAlign: 'center',
  },
}
