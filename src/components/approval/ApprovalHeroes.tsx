import type { ReactNode } from 'react';
import { SiteTile } from './ApprovalCard';
import { CARD } from './cardTheme';

/** Hero art panels, one per card kind. Sized to fit both a phone and the 540px extension box. */

const PANEL_H = 'clamp(170px, 36vh, 300px)';
const art = (px: number) => `min(${px}px, ${Math.round((px / 300) * 36)}vh)`;

const Badge = ({ label, red }: { label: string; red?: boolean }) => (
  <div
    className="absolute"
    style={{
      left: 16,
      bottom: 14,
      padding: '6px 12px',
      borderRadius: 999,
      background: red ? CARD.red : CARD.gold,
      color: red ? '#FFFFFF' : CARD.bg,
      fontSize: 13,
      fontWeight: 800,
    }}
  >
    {label}
  </div>
);

const Contours = ({ lines = 'full' }: { lines?: 'full' | 'two' }) => (
  <svg aria-hidden="true" viewBox="0 0 362 300" preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
    <g fill="none" stroke={CARD.gold} strokeOpacity={lines === 'two' ? 0.18 : 0.22} strokeWidth="1.2">
      {lines === 'two' ? (
        <>
          <path d="M-10 70 C 90 30, 170 120, 380 50" />
          <path d="M-10 250 C 110 210, 200 290, 380 230" />
        </>
      ) : (
        <>
          <path d="M-10 60 C 80 20, 160 110, 380 40" />
          <path d="M-10 100 C 90 60, 170 150, 380 80" />
          <path d="M-10 140 C 100 100, 180 190, 380 120" />
          <path d="M-10 230 C 110 190, 200 270, 380 210" />
          <path d="M-10 270 C 120 230, 210 310, 380 250" />
        </>
      )}
    </g>
  </svg>
);

const Panel = (p: { glow: number; children: ReactNode; red?: boolean; column?: boolean }) => (
  <div
    className={`relative flex items-center justify-center overflow-hidden flex-shrink-0 ${p.column ? 'flex-col' : ''}`}
    style={{
      height: PANEL_H,
      margin: '0 14px',
      borderRadius: 22,
      background: p.red
        ? 'repeating-linear-gradient(135deg, #1A0808 0px, #1A0808 18px, #230B0B 18px, #230B0B 36px)'
        : `radial-gradient(circle at 50% 45%, rgba(245,197,66,${p.glow}) 0%, rgba(245,197,66,0) 60%), #050505`,
    }}
  >
    {p.children}
  </div>
);

const GoldRing = ({ px, children, glow = 0.45 }: { px: number; children: ReactNode; glow?: number }) => (
  <div
    className="relative"
    style={{
      width: art(px),
      height: art(px),
      borderRadius: '50%',
      padding: 7,
      boxSizing: 'border-box',
      background: `linear-gradient(145deg, ${CARD.goldHi} 0%, ${CARD.gold} 45%, ${CARD.goldLo} 100%)`,
      boxShadow: `0 0 70px rgba(245,197,66,${glow})`,
    }}
  >
    <div
      className="w-full h-full flex items-center justify-center overflow-hidden"
      style={{ borderRadius: '50%', background: CARD.bg }}
    >
      {children}
    </div>
  </div>
);

export const SignInHero = () => (
  <Panel glow={0.3}>
    <Contours />
    <GoldRing px={168}>
      <svg
        role="img"
        aria-label="Key"
        width="50%"
        height="50%"
        viewBox="0 0 24 24"
        fill="none"
        stroke={CARD.gold}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="8" cy="15" r="4" />
        <path d="M10.8 12.2 20 3" />
        <path d="m16 7 3 3" />
        <path d="m18.5 4.5 2 2" />
      </svg>
    </GoldRing>
    <Badge label="SIGN IN" />
  </Panel>
);

export const ConnectHero = ({ site }: { site: string }) => {
  const coin = art(104);
  return (
    <Panel glow={0.22}>
      <div
        aria-hidden="true"
        className="flex items-center justify-center"
        style={{
          width: coin,
          height: coin,
          borderRadius: '50%',
          background: `linear-gradient(145deg, ${CARD.goldHi}, ${CARD.gold} 45%, ${CARD.goldLo})`,
          color: CARD.bg,
          fontSize: 'min(54px, 6.5vh)',
          fontWeight: 800,
          boxShadow: '0 0 50px rgba(245,197,66,0.4)',
        }}
      >
        b
      </div>
      <div aria-hidden="true" className="flex items-center" style={{ gap: 6, margin: '0 10px' }}>
        {[1, 0.7, 0.4].map((o) => (
          <div key={o} style={{ width: 10, height: 10, borderRadius: 5, background: CARD.gold, opacity: o }} />
        ))}
      </div>
      <div style={{ width: coin, height: coin }} className="flex items-center justify-center">
        <SiteTile site={site} size={104} />
      </div>
      <Badge label="CONNECT" />
    </Panel>
  );
};

export const PayHero = ({ amount, sub, badge = 'PAY' }: { amount: string; sub?: string; badge?: string }) => (
  <Panel glow={0.26} column>
    <Contours lines="two" />
    <div
      className="relative"
      style={{
        // "Price loading…" / "3,412 sats" (no price yet) are words, not the dollar figure: smaller.
        fontSize: amount.length > 10 ? 'min(44px, 6vh)' : amount.length > 6 ? 'min(84px, 10vh)' : 'min(112px, 13vh)',
        letterSpacing: amount.length > 10 ? -1 : -5,
        lineHeight: 1,
        fontWeight: 800,
        color: CARD.gold,
        textShadow: '0 0 40px rgba(245,197,66,0.45)',
      }}
    >
      {amount}
    </div>
    {sub && (
      <div className="relative" style={{ marginTop: 10, fontSize: 16, fontWeight: 600, color: CARD.soft }}>
        {sub}
      </div>
    )}
    <Badge label={badge} />
  </Panel>
);

export const MintHero = ({
  image,
  alt,
  number,
  badge = 'MINT',
}: {
  image?: string;
  alt: string;
  number?: string;
  badge?: string;
}) => (
  <Panel glow={0.34}>
    <GoldRing px={190} glow={0.5}>
      {image ? (
        <img src={image} alt={alt} className="w-full h-full" style={{ objectFit: 'cover' }} />
      ) : (
        <svg role="img" aria-label={alt} width="100%" height="100%" viewBox="0 0 176 176">
          <g fill="none" strokeLinecap="round">
            <circle cx="88" cy="88" r="62" stroke={CARD.gold} strokeWidth="8" strokeDasharray="120 40" />
            <circle cx="88" cy="88" r="44" stroke="#C58B12" strokeWidth="8" strokeDasharray="90 50" />
            <circle cx="88" cy="88" r="26" stroke="var(--bw-accent-hi)" strokeWidth="7" strokeDasharray="60 30" />
          </g>
          <circle cx="88" cy="88" r="9" fill="var(--bw-accent-hi)" />
        </svg>
      )}
    </GoldRing>
    {number && (
      <div
        className="absolute"
        style={{
          right: 18,
          top: 16,
          padding: '6px 12px',
          borderRadius: 999,
          background: CARD.bg,
          border: `1px solid ${CARD.gold}`,
          color: CARD.gold,
          fontSize: 18,
          fontWeight: 800,
        }}
      >
        {number}
      </div>
    )}
    <Badge label={badge} />
  </Panel>
);

export const CarefulHero = () => (
  <Panel glow={0} red>
    <div
      className="flex items-center justify-center"
      style={{
        width: art(168),
        height: art(168),
        borderRadius: '50%',
        background: CARD.red,
        boxShadow: '0 0 70px rgba(229,72,77,0.5)',
      }}
    >
      <svg
        role="img"
        aria-label="Warning"
        width="55%"
        height="55%"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3 2 20h20Z" />
        <path d="M12 10v4" />
        <path d="M12 17.5v.01" />
      </svg>
    </div>
    <Badge label="CAREFUL" red />
  </Panel>
);
