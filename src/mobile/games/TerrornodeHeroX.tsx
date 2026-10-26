/**
 * TERRORNODE hero at the top of the bApps page (owner P0, 26 Oct 2026: the crown jewel of the stress test, not a
 * tiny icon). bWalletX only: a store build swaps this file for TerrornodeHeroX.store.tsx (vite.config.mobile.ts),
 * so neither the art nor the name is in the App Store / Play bundle. Art is the game's own /brand store shot and eye mark.
 * Motion is compositor-only (opacity/transform), off under prefers-reduced-motion.
 */
import banner from './terrornode-hero.webp';
import logo from '../wallet/editionArt/terrornode-logo.webp';

export const TERRORNODE_URL = 'https://www.tokenblaster.lol/arcade/terrornode';

const CSS = `
@keyframes tn-glow { 0%, 100% { opacity: .35 } 50% { opacity: .85 } }
@keyframes tn-scan { from { transform: translateY(-100%) } to { transform: translateY(100%) } }
@keyframes tn-drift { 0%, 100% { transform: scale(1.06) translateX(-1.5%) } 50% { transform: scale(1.06) translateX(1.5%) } }
.tn-hero .tn-art { animation: tn-drift 18s ease-in-out infinite; will-change: transform }
.tn-hero .tn-glow { animation: tn-glow 3.2s ease-in-out infinite }
.tn-hero .tn-scan { animation: tn-scan 4.5s linear infinite }
@media (prefers-reduced-motion: reduce) {
  .tn-hero .tn-art, .tn-hero .tn-glow, .tn-hero .tn-scan { animation: none }
  .tn-hero .tn-scan { display: none }
}
`;

export const TerrornodeHero = ({ onPlay }: { onPlay: (url: string) => void }) => (
  <section
    className="tn-hero relative w-full overflow-hidden rounded-2xl"
    style={{ height: 'clamp(200px, 30vh, 240px)', background: '#000', isolation: 'isolate' }}
    aria-label="TERRORNODE"
  >
    <style>{CSS}</style>
    <img
      src={banner}
      alt=""
      aria-hidden
      className="tn-art absolute inset-0 h-full w-full object-cover"
      style={{ transform: 'scale(1.06)' }}
    />
    {/* Neon glow pulse: a coloured wash whose opacity breathes. */}
    <div
      aria-hidden
      className="tn-glow absolute inset-0"
      style={{
        background:
          'radial-gradient(120% 80% at 20% 100%, rgba(255,0,92,.55), transparent 60%), radial-gradient(90% 70% at 100% 0%, rgba(0,229,255,.45), transparent 60%)',
        mixBlendMode: 'screen',
      }}
    />
    {/* CRT lines plus one slow scan bar. */}
    <div
      aria-hidden
      className="absolute inset-0"
      style={{ background: 'repeating-linear-gradient(0deg, rgba(0,0,0,.28) 0 1px, transparent 1px 3px)' }}
    />
    <div
      aria-hidden
      className="tn-scan absolute inset-x-0 top-0 h-full"
      style={{ background: 'linear-gradient(180deg, transparent 0%, rgba(0,229,255,.16) 48%, transparent 56%)' }}
    />
    <div
      aria-hidden
      className="absolute inset-0"
      style={{ background: 'linear-gradient(180deg, rgba(0,0,0,.15) 0%, rgba(0,0,0,.25) 45%, rgba(0,0,0,.82) 100%)' }}
    />
    <div className="relative flex h-full w-full flex-col items-center justify-end gap-2 px-4 pb-4 text-center">
      <div className="flex items-center gap-2">
        <img src={logo} alt="" aria-hidden style={{ width: 44, height: 44 }} />
        <h2
          className="m-0 text-[clamp(22px,7.5vw,30px)] font-black italic leading-none text-white"
          style={{ letterSpacing: '0.08em', textShadow: '0 0 6px #ff2a2a, 0 0 18px rgba(255,0,60,.85), 0 2px 0 #000' }}
        >
          TERRORNODE
        </h2>
      </div>
      <p className="m-0 text-[13px] font-semibold text-white" style={{ textShadow: '0 1px 4px #000' }}>
        The arcade shooter on b. Play now.
      </p>
      <button
        type="button"
        onClick={() => onPlay(TERRORNODE_URL)}
        className="w-full max-w-[320px] rounded-xl border-0 py-3 text-[17px] font-black tracking-[0.2em] cursor-pointer"
        style={{ background: '#ff005c', color: '#fff', boxShadow: '0 0 18px rgba(255,0,92,.7)' }}
      >
        PLAY
      </button>
    </div>
  </section>
);
