import React, { useEffect, useState } from 'react';

const TELEGRAM_URL = 'https://t.me/ferreira3d';
const WHATSAPP_URL = 'https://chat.whatsapp.com/C0cPDxI9ViB25Y6NUVUmyL?mode=gi_t';

/** Fire a Meta Pixel custom event safely (works even before fbq is fully loaded). */
function trackEvent(eventName: string, params?: Record<string, unknown>) {
  try {
    const w = window as any;
    if (typeof w.fbq === 'function') {
      w.fbq('trackCustom', eventName, params ?? {});
    }
  } catch (_) {}
}

export default function Landing3D() {
  const [spotsLeft, setSpotsLeft] = useState(12);
  const [progress, setProgress] = useState(88);
  const [showModal, setShowModal] = useState(false);

  // Simulate scarcity drop
  useEffect(() => {
    const timer = setTimeout(() => { setSpotsLeft(9); setProgress(91); }, 8500);
    const timer2 = setTimeout(() => { setSpotsLeft(7); setProgress(93); }, 22000);
    return () => { clearTimeout(timer); clearTimeout(timer2); };
  }, []);

  // Facebook Pixel
  useEffect(() => {
    const script = document.createElement('script');
    script.innerHTML = `
      !function(f,b,e,v,n,t,s)
      {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
      n.callMethod.apply(n,arguments):n.queue.push(arguments)};
      if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
      n.queue=[];t=b.createElement(e);t.async=!0;
      t.src=v;s=b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t,s)}(window, document,'script',
      'https://connect.facebook.net/en_US/fbevents.js');
      fbq('init', '1036050992396935');
      fbq('track', 'PageView');
    `;
    document.head.appendChild(script);
  }, []);

  // Lock body scroll when modal is open
  useEffect(() => {
    if (showModal) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [showModal]);

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#0a0a0c',
        color: '#f0f0f5',
        fontFamily: "'Inter', system-ui, sans-serif",
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '2rem 1rem',
        overflowX: 'hidden',
      }}
    >
      <noscript>
        <img height="1" width="1" style={{ display: 'none' }} src="https://www.facebook.com/tr?id=1036050992396935&ev=PageView&noscript=1" />
      </noscript>

      <div style={{ maxWidth: 800, width: '100%', margin: '0 auto', textAlign: 'center' }}>
        {/* Header Badge */}
        <div
          style={{
            display: 'inline-block',
            backgroundColor: 'rgba(255, 94, 0, 0.1)',
            border: '1px solid rgba(255, 94, 0, 0.3)',
            color: '#ff5e00',
            padding: '6px 16px',
            borderRadius: '20px',
            fontSize: '0.85rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 1,
            marginBottom: '1.5rem',
            animation: 'pulse 2s infinite',
          }}
        >
          🔥 Acesso Vip Temporariamente Aberto
        </div>

        {/* Title */}
        <h1
          style={{
            fontSize: 'clamp(2.2rem, 5vw, 3.5rem)',
            fontWeight: 900,
            lineHeight: 1.1,
            marginBottom: '1rem',
            letterSpacing: '-1px',
          }}
        >
          As Melhores Ofertas de <br />
          <span
            style={{
              background: 'linear-gradient(90deg, #ff5e00, #ff9100)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              textShadow: '0px 2px 10px rgba(255,94,0,0.3)',
            }}
          >
            Impressão 3D
          </span>{' '}
          do Brasil
        </h1>

        <p
          style={{
            fontSize: '1.1rem',
            color: '#a1a1aa',
            lineHeight: 1.6,
            marginBottom: '2rem',
            maxWidth: 600,
            margin: '0 auto 2.5rem',
          }}
        >
          Receba diariamente ofertas selecionadas de <strong>filamentos, impressoras de resina/FDM e peças de reposição</strong>. Direto no seu celular, antes que os estoques acabem.
        </p>

        {/* Scarcity Box */}
        <div
          style={{
            backgroundColor: '#18181b',
            border: '1px solid #3f3f46',
            borderRadius: 16,
            padding: '2rem',
            marginBottom: '2.5rem',
            position: 'relative',
            overflow: 'hidden',
            boxShadow: '0 20px 40px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,94,0,0.1)',
          }}
        >
          {/* Top orange glow */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: 4,
              background: 'linear-gradient(90deg, #ff5e00, #ff9100)',
            }}
          />

          <h3 style={{ fontSize: '1.3rem', fontWeight: 700, marginBottom: '0.5rem' }}>
            Lote VIP #04
          </h3>
          <p style={{ color: '#d4d4d8', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
            Nós limitamos a entrada para evitar que ofertas relâmpago esgotem em segundos.
          </p>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontWeight: 600 }}>
            <span style={{ color: '#ff5e00' }}>Vagas preenchidas</span>
            <span style={{ color: '#ef4444' }}>Restam apenas {spotsLeft}</span>
          </div>

          <div
            style={{
              height: 12,
              backgroundColor: '#27272a',
              borderRadius: 6,
              overflow: 'hidden',
              marginBottom: '2rem',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${progress}%`,
                backgroundColor: '#ff5e00',
                borderRadius: 6,
                transition: 'width 1s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: '0 0 10px rgba(255,94,0,0.8)',
              }}
            />
          </div>

          {/* CTA Button — triggers modal */}
          <button
            onClick={() => {
              trackEvent('CliqueGrupo', { source: 'cta_button' });
              setShowModal(true);
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
              backgroundColor: '#ff5e00',
              color: '#fff',
              fontWeight: 800,
              fontSize: '1.1rem',
              padding: '16px 24px',
              borderRadius: 12,
              textDecoration: 'none',
              textTransform: 'uppercase',
              letterSpacing: 1,
              transition: 'all 0.2s',
              boxShadow: '0 10px 25px -5px rgba(255,94,0,0.5)',
              border: 'none',
              cursor: 'pointer',
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = '0 15px 35px -5px rgba(255,94,0,0.6)';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 10px 25px -5px rgba(255,94,0,0.5)';
            }}
          >
            👉 Quero Minha Vaga no Grupo
          </button>
          <p style={{ marginTop: '1rem', fontSize: '0.75rem', color: '#71717a' }}>
            Acesso 100% Gratuito. Cancele quando quiser.
          </p>
        </div>

        {/* Features / Social Proof */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '1rem',
            textAlign: 'left',
          }}
        >
          <div style={{ backgroundColor: '#18181b', padding: '1.5rem', borderRadius: 12 }}>
            <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>🧵</div>
            <h4 style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Filamentos Baratos</h4>
            <p style={{ fontSize: '0.85rem', color: '#a1a1aa' }}>PLA, PETG e ABS com os menores preços da internet.</p>
          </div>
          <div style={{ backgroundColor: '#18181b', padding: '1.5rem', borderRadius: 12 }}>
            <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>🖨️</div>
            <h4 style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Cupons Exclusivos</h4>
            <p style={{ fontSize: '0.85rem', color: '#a1a1aa' }}>Descontos em Creality, Bambu Lab, Anycubic e Elegoo.</p>
          </div>
          <div style={{ backgroundColor: '#18181b', padding: '1.5rem', borderRadius: 12 }}>
            <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>⚡</div>
            <h4 style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Peças & Upgrades</h4>
            <p style={{ fontSize: '0.85rem', color: '#a1a1aa' }}>Extrusoras, bicos, hotends e resinas em promoção.</p>
          </div>
        </div>
      </div>

      {/* ── Channel Picker Modal ─────────────────────────────────── */}
      {showModal && (
        <div
          onClick={() => setShowModal(false)}
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
            animation: 'fadeIn 0.2s ease',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: '#18181b',
              border: '1px solid #3f3f46',
              borderRadius: 20,
              padding: '2.5rem 2rem',
              maxWidth: 480,
              width: '100%',
              position: 'relative',
              boxShadow: '0 30px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,94,0,0.15)',
              animation: 'slideUp 0.25s cubic-bezier(0.34,1.56,0.64,1)',
            }}
          >
            {/* Orange top bar */}
            <div style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: 4,
              background: 'linear-gradient(90deg, #ff5e00, #ff9100)',
              borderRadius: '20px 20px 0 0',
            }} />

            {/* Close button */}
            <button
              onClick={() => setShowModal(false)}
              style={{
                position: 'absolute', top: 16, right: 16,
                background: 'rgba(255,255,255,0.06)',
                border: 'none', borderRadius: 8,
                color: '#a1a1aa', cursor: 'pointer',
                width: 32, height: 32, fontSize: '1.1rem',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'background 0.15s',
              }}
              onMouseOver={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
              onMouseOut={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
            >
              ✕
            </button>

            <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🎯</div>
              <h2 style={{ fontSize: '1.4rem', fontWeight: 800, marginBottom: '0.5rem' }}>
                Escolha seu canal favorito
              </h2>
              <p style={{ fontSize: '0.9rem', color: '#a1a1aa', lineHeight: 1.5 }}>
                As mesmas ofertas exclusivas, você decide onde receber.
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

              {/* Telegram Option */}
              <a
                href={TELEGRAM_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  trackEvent('CliqueTelegram', { canal: 'telegram' });
                  trackEvent('CliqueGrupo', { canal: 'telegram' });
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '1rem',
                  padding: '1.25rem 1.5rem',
                  backgroundColor: 'rgba(0,136,204,0.1)',
                  border: '1.5px solid rgba(0,136,204,0.35)',
                  borderRadius: 14,
                  textDecoration: 'none',
                  color: '#f0f0f5',
                  transition: 'all 0.18s ease',
                  cursor: 'pointer',
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgba(0,136,204,0.2)';
                  e.currentTarget.style.borderColor = 'rgba(0,136,204,0.7)';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,136,204,0.2)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgba(0,136,204,0.1)';
                  e.currentTarget.style.borderColor = 'rgba(0,136,204,0.35)';
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                <div style={{
                  width: 52, height: 52, borderRadius: 14,
                  backgroundColor: '#0088cc',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, fontSize: '1.6rem',
                }}>
                  ✈️
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 2 }}>
                    Grupo do Telegram
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#71717a' }}>
                    @ferreira3d · Notificações instantâneas
                  </div>
                </div>
                <div style={{ color: '#0088cc', fontSize: '1.2rem', flexShrink: 0 }}>→</div>
              </a>

              {/* WhatsApp Option */}
              <a
                href={WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  trackEvent('CliqueWhatsApp', { canal: 'whatsapp' });
                  trackEvent('CliqueGrupo', { canal: 'whatsapp' });
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '1rem',
                  padding: '1.25rem 1.5rem',
                  backgroundColor: 'rgba(37,211,102,0.08)',
                  border: '1.5px solid rgba(37,211,102,0.3)',
                  borderRadius: 14,
                  textDecoration: 'none',
                  color: '#f0f0f5',
                  transition: 'all 0.18s ease',
                  cursor: 'pointer',
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgba(37,211,102,0.18)';
                  e.currentTarget.style.borderColor = 'rgba(37,211,102,0.65)';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 8px 24px rgba(37,211,102,0.15)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgba(37,211,102,0.08)';
                  e.currentTarget.style.borderColor = 'rgba(37,211,102,0.3)';
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                <div style={{
                  width: 52, height: 52, borderRadius: 14,
                  backgroundColor: '#25d366',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, fontSize: '1.6rem',
                }}>
                  💬
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 2 }}>
                    Grupo do WhatsApp
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#71717a' }}>
                    Comunidade · Direto no seu app
                  </div>
                </div>
                <div style={{ color: '#25d366', fontSize: '1.2rem', flexShrink: 0 }}>→</div>
              </a>
            </div>

            <p style={{ textAlign: 'center', marginTop: '1.5rem', fontSize: '0.75rem', color: '#52525b' }}>
              🔒 Acesso 100% gratuito. Saia quando quiser.
            </p>
          </div>
        </div>
      )}

      {/* Keyframes */}
      <style>
        {`
          @keyframes pulse {
            0% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.8; transform: scale(1.02); }
            100% { opacity: 1; transform: scale(1); }
          }
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @keyframes slideUp {
            from { opacity: 0; transform: translateY(24px) scale(0.96); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
          }
        `}
      </style>
    </div>
  );
}
