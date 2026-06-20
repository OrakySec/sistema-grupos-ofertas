import React, { useEffect, useState } from 'react';

export default function Landing3D() {
  const [spotsLeft, setSpotsLeft] = useState(12);
  const [progress, setProgress] = useState(88); // 88% full

  // Simulate scarcity drop
  useEffect(() => {
    const timer = setTimeout(() => {
      setSpotsLeft(9);
      setProgress(91);
    }, 8500);

    const timer2 = setTimeout(() => {
      setSpotsLeft(7);
      setProgress(93);
    }, 22000);

    return () => {
      clearTimeout(timer);
      clearTimeout(timer2);
    };
  }, []);

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#0a0a0c', // Dark modern tech background
        color: '#f0f0f5',
        fontFamily: "'Inter', system-ui, sans-serif",
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '2rem 1rem',
        overflowX: 'hidden',
      }}
    >
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

          <a
            href="https://t.me/ferreira3d"
            target="_blank"
            rel="noopener noreferrer"
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
          </a>
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
      
      {/* Pulse Keyframe injected directly for simplicity */}
      <style>
        {`
          @keyframes pulse {
            0% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.8; transform: scale(1.02); }
            100% { opacity: 1; transform: scale(1); }
          }
        `}
      </style>
    </div>
  );
}
