import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ringProgress, statusLine } from './generating';

/**
 * The "making your card" state (owner, 23 Oct 2026): a blank card frame with a gold scan sweeping it, gold specks
 * swirling in to the middle, a pulsing b, friendly lines on a timer, an elapsed counter and a soft ring that eases
 * to 90% over ~60 s. When the image arrives (`done`) the ring completes, a small confetti burst plays and the
 * image fades and scales in. prefers-reduced-motion: a still frame with the same words and counter.
 *
 * Colours are theme tokens only (--bw-surface / --bw-accent-rgb / --bw-text / --bw-muted): gold on black in Gold,
 * black ink on white in White, so there is no dark card on a light pack.
 */

const reducedMotion = () => {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
};

const GOLD = 'rgb(var(--bw-accent-rgb, 245 184 0))';
const goldA = (a: number) => `rgb(var(--bw-accent-rgb, 245 184 0) / ${a})`;

const CSS = `
@keyframes bwcg-scan { 0% { transform: translateY(-120%); } 100% { transform: translateY(420%); } }
@keyframes bwcg-pulse { 0%, 100% { transform: scale(1); opacity: .85; } 50% { transform: scale(1.08); opacity: 1; } }
@keyframes bwcg-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
@keyframes bwcg-line { 0% { opacity: 0; transform: translateY(4px); } 100% { opacity: 1; transform: none; } }
@keyframes bwcg-in { 0% { opacity: 0; transform: scale(.94); } 100% { opacity: 1; transform: none; } }
@keyframes bwcg-confetti { 0% { opacity: 1; transform: translate(0, 0) rotate(0); } 100% { opacity: 0; transform: translate(var(--dx), var(--dy)) rotate(var(--r)); } }
.bwcg-motion .bwcg-scan { animation: bwcg-scan 2.4s cubic-bezier(.45,0,.55,1) infinite; }
.bwcg-motion .bwcg-b { animation: bwcg-pulse 1.8s ease-in-out infinite; }
.bwcg-motion .bwcg-shimmer { animation: bwcg-shimmer 3s linear infinite; }
.bwcg-motion .bwcg-line { animation: bwcg-line .5s ease-out both; }
.bwcg-motion .bwcg-img { animation: bwcg-in .7s cubic-bezier(.2,.8,.2,1) both; }
.bwcg-motion .bwcg-bit { animation: bwcg-confetti 1.1s cubic-bezier(.15,.7,.3,1) forwards; }
@media (prefers-reduced-motion: reduce) { .bwcg-motion * { animation: none !important; } }
`;

/** Gold specks spiralling in to the middle of the card (canvas; skipped for reduced motion). */
function Swirl({ gold }: { gold: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext?.('2d');
    if (!c || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = () => {
      c.width = c.clientWidth * dpr;
      c.height = c.clientHeight * dpr;
    };
    size();
    const N = 70;
    const ps = Array.from({ length: N }, () => ({
      a: Math.random() * Math.PI * 2,
      r: 0.35 + Math.random() * 0.65,
      v: 0.004 + Math.random() * 0.01,
      s: 0.6 + Math.random() * 1.8,
    }));
    let raf = 0;
    const tick = () => {
      const w = c.width;
      const h = c.height;
      ctx.clearRect(0, 0, w, h);
      const R = Math.min(w, h) * 0.5;
      for (const p of ps) {
        p.a += p.v * 3;
        p.r -= p.v * 0.6;
        if (p.r < 0.06) {
          p.r = 0.9 + Math.random() * 0.2;
          p.a = Math.random() * Math.PI * 2;
        }
        const x = w / 2 + Math.cos(p.a) * p.r * R;
        const y = h / 2 + Math.sin(p.a) * p.r * R * 1.25;
        ctx.globalAlpha = Math.min(1, (1 - p.r) * 1.6);
        ctx.fillStyle = gold;
        ctx.beginPath();
        ctx.arc(x, y, p.s * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    window.addEventListener('resize', size);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', size);
    };
  }, [gold]);
  return <canvas ref={ref} aria-hidden className="absolute inset-0 w-full h-full pointer-events-none" />;
}

const CONFETTI = Array.from({ length: 18 }, (_, i) => {
  const a = (i / 18) * Math.PI * 2;
  const d = 70 + (i % 3) * 30;
  return { dx: `${Math.cos(a) * d}px`, dy: `${Math.sin(a) * d - 20}px`, r: `${(i % 2 ? 1 : -1) * (180 + i * 20)}deg` };
});

export default function CardGenerating({
  imageUrl,
  alt,
  startedAt,
  children,
  blurred,
}: {
  /** Set when the card has arrived: the ring completes and the image comes in. */
  imageUrl?: string;
  alt?: string;
  startedAt?: number;
  /** Shown over the arrived image (the 18+ blur/reveal lives in the maker). */
  children?: ReactNode;
  /** 18+ before reveal: the image comes in blurred. */
  blurred?: boolean;
}) {
  const [t0] = useState(() => startedAt ?? Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [still] = useState(reducedMotion);
  const [gold, setGold] = useState('#F5C542');
  const root = useRef<HTMLDivElement>(null);
  const done = !!imageUrl;

  useEffect(() => {
    if (done) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [done]);

  useEffect(() => {
    // The canvas needs a real colour: read the themed accent off the frame.
    const el = root.current;
    if (!el) return;
    const c = getComputedStyle(el).color;
    if (c) setGold(c);
  }, []);

  const s = (now - t0) / 1000;
  const prog = ringProgress(s, done);
  const line = statusLine(s);
  const R = 26;
  const C = 2 * Math.PI * R;

  return (
    <div
      ref={root}
      className={`relative w-full overflow-hidden rounded-2xl border ${still ? '' : 'bwcg-motion'}`}
      data-testid={done ? 'card-arrived' : 'card-generating'}
      role="status"
      aria-live="polite"
      style={{
        aspectRatio: '4 / 5',
        maxHeight: 440,
        borderColor: goldA(0.45),
        background: 'var(--bw-surface)',
        color: GOLD,
        boxShadow: `0 0 0 1px ${goldA(0.08)} inset, 0 10px 40px ${goldA(0.12)}`,
      }}
    >
      <style>{CSS}</style>
      {done ? (
        <>
          <img
            src={imageUrl}
            alt={alt ?? 'Your card'}
            className="bwcg-img absolute inset-0 w-full h-full object-contain"
            style={blurred ? { filter: 'blur(28px)' } : undefined}
          />
          {children}
          {!still && (
            <div aria-hidden className="absolute left-1/2 top-1/2 pointer-events-none">
              {CONFETTI.map((c, i) => (
                <span
                  key={i}
                  className="bwcg-bit absolute block"
                  style={
                    {
                      width: 6,
                      height: i % 3 ? 10 : 6,
                      borderRadius: i % 3 ? 2 : 6,
                      background: i % 4 === 0 ? 'var(--bw-text)' : GOLD,
                      '--dx': c.dx,
                      '--dy': c.dy,
                      '--r': c.r,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {/* Blank card: a gold hairline frame inset like a printed card, with a shimmer on its edge. */}
          <div
            aria-hidden
            className="bwcg-shimmer absolute rounded-xl"
            style={{
              inset: 14,
              border: `1px solid ${goldA(0.35)}`,
              backgroundImage: `linear-gradient(110deg, transparent 30%, ${goldA(0.1)} 50%, transparent 70%)`,
              backgroundSize: '200% 100%',
            }}
          />
          {!still && <Swirl gold={gold} />}
          {!still && (
            <div
              aria-hidden
              className="bwcg-scan absolute left-0 right-0 pointer-events-none"
              style={{
                top: 0,
                height: '25%',
                background: `linear-gradient(180deg, transparent, ${goldA(0.18)} 70%, ${goldA(0.55)} 98%, transparent)`,
              }}
            />
          )}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
            <div className="relative" style={{ width: 76, height: 76 }}>
              <svg width="76" height="76" viewBox="0 0 76 76" aria-hidden className="absolute inset-0">
                <circle cx="38" cy="38" r={R} fill="none" stroke={goldA(0.18)} strokeWidth="4" />
                <circle
                  cx="38"
                  cy="38"
                  r={R}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray={C}
                  strokeDashoffset={C * (1 - prog)}
                  transform="rotate(-90 38 38)"
                  style={{ transition: 'stroke-dashoffset .4s ease-out' }}
                />
              </svg>
              <span
                className="bwcg-b absolute inset-0 flex items-center justify-center font-black"
                style={{ fontSize: 34, lineHeight: 1, textShadow: `0 0 18px ${goldA(0.6)}` }}
                aria-hidden
              >
                b
              </span>
            </div>
            <div
              key={still ? 'still' : line}
              className="bwcg-line text-sm font-bold"
              style={{ color: 'var(--bw-text)' }}
              data-testid="card-generating-line"
            >
              {still ? 'Making your card…' : line}
            </div>
            <div className="text-xs" style={{ color: 'var(--bw-muted)' }}>
              Paid. This takes up to a minute · <span data-testid="card-generating-secs">{Math.floor(s)}s</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
