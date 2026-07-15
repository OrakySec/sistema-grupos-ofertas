import React, { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

const BASE_URL = (import.meta.env.VITE_API_URL as string) || '/api'

interface PublicOfferDetailData {
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

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function PublicOfferDetail() {
  const { id } = useParams<{ id: string }>()
  const [offer, setOffer] = useState<PublicOfferDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setNotFound(false)
    fetch(`${BASE_URL}/public/offers/${id}`)
      .then((res) => {
        if (res.status === 404) {
          if (!cancelled) setNotFound(true)
          return null
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<PublicOfferDetailData>
      })
      .then((json) => {
        if (!cancelled && json) setOffer(json)
      })
      .catch(() => {
        if (!cancelled) setNotFound(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  const backTo = offer?.niche?.slug ? `/ofertas/n/${offer.niche.slug}` : '/ofertas'

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <Link to={backTo} style={styles.logoLink}>
            🔥 {offer?.niche?.name || 'Ofertas'}
          </Link>
        </div>
      </header>

      <main style={styles.main}>
        <Link to={backTo} style={styles.backLink}>
          ← Todas as ofertas
        </Link>

        {loading && <p style={styles.status}>Carregando…</p>}

        {!loading && (notFound || !offer) && (
          <p style={styles.status}>Esta oferta não está mais disponível.</p>
        )}

        {!loading && offer && (
          <article style={styles.article}>
            {offer.platform && <span style={styles.badge}>{offer.platform}</span>}

            {offer.mediaType === 'PHOTO' && offer.mediaPath && (
              <img
                src={`${BASE_URL}/media/${offer.mediaPath}`}
                alt={offer.mediaCaption ?? 'Oferta'}
                style={styles.image}
              />
            )}

            <p style={styles.text}>{offer.mediaCaption ?? offer.text}</p>

            <time style={styles.date}>Publicado em {formatDate(offer.sentAt)}</time>

            {offer.affiliateUrl && (
              <a
                href={offer.affiliateUrl}
                target="_blank"
                rel="noopener noreferrer sponsored nofollow"
                style={styles.buyButton}
              >
                🛒 Ver oferta na loja
              </a>
            )}

            <p style={styles.disclosure}>
              Como Associados Amazon, ganhamos com compras qualificadas. Este site também pode
              participar de outros programas de afiliados e receber comissão por compras feitas
              através deste link, sem custo adicional para você.
            </p>
          </article>
        )}
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
    padding: '1.25rem 1rem',
  },
  headerInner: {
    maxWidth: 720,
    margin: '0 auto',
  },
  logoLink: {
    fontSize: '1.3rem',
    fontWeight: 900,
    color: '#f0f0f5',
    textDecoration: 'none',
  },
  main: {
    maxWidth: 720,
    margin: '0 auto',
    padding: '2rem 1rem 4rem',
  },
  backLink: {
    display: 'inline-block',
    color: '#a1a1aa',
    textDecoration: 'none',
    fontSize: '0.85rem',
    marginBottom: '1.5rem',
  },
  status: {
    textAlign: 'center',
    color: '#a1a1aa',
    padding: '3rem 0',
  },
  article: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
  },
  badge: {
    alignSelf: 'flex-start',
    fontSize: '0.75rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#ff5e00',
    backgroundColor: 'rgba(255,94,0,0.1)',
    border: '1px solid rgba(255,94,0,0.3)',
    borderRadius: 6,
    padding: '3px 10px',
  },
  image: {
    width: '100%',
    borderRadius: 16,
    display: 'block',
    border: '1px solid #27272a',
  },
  text: {
    fontSize: '1.05rem',
    lineHeight: 1.7,
    color: '#e4e4e7',
    whiteSpace: 'pre-wrap',
    margin: 0,
  },
  date: {
    fontSize: '0.8rem',
    color: '#71717a',
  },
  buyButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ff5e00',
    color: '#fff',
    fontWeight: 800,
    fontSize: '1.05rem',
    padding: '16px 24px',
    borderRadius: 12,
    textDecoration: 'none',
    boxShadow: '0 10px 25px -5px rgba(255,94,0,0.5)',
  },
  disclosure: {
    fontSize: '0.75rem',
    color: '#71717a',
    lineHeight: 1.6,
    borderTop: '1px solid #27272a',
    paddingTop: '1.25rem',
  },
}
