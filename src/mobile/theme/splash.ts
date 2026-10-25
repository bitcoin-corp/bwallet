import { DEFAULT_ACCENT, RETIRED_PACKS, THEMES } from './accents';
import { B_OUTLINE_COUNTER, B_OUTLINE_OUTER, B_OUTLINE_VIEWBOX } from '../brand/bOutline';

/**
 * The in-app splash (owner, 15 Oct 2026: "splash screens should follow the theme"): an inline script injected
 * into the shell's <head> at build time (vite.config.mobile.ts). Before any module loads it reads the saved pack
 * (the same boot key as accent.ts) and paints the page and an outline b in that pack's colours, then removes
 * itself once React has drawn into #root. Gold paints nothing, so the default stays exactly as before (the black
 * page that follows the native launch screen). Native launch screens are static images and stay as they are.
 */
export const SPLASH_BOOT_KEY = 'bwx.accent.boot';

/** Pack id → [page, ink] for every pack but Gold; retired ids map to their replacement's colours. */
export function splashPalette(skip: readonly string[] = []): Record<string, [string, string]> {
  const out: Record<string, [string, string]> = {};
  for (const a of THEMES) {
    if (a.id === DEFAULT_ACCENT || skip.includes(a.id)) continue;
    out[a.id] = [a.bg, a.group === 'mono' ? a.text : a.accent];
  }
  for (const [old, now] of Object.entries(RETIRED_PACKS)) if (out[now]) out[old] = out[now];
  return out;
}

/** The clean outline b (src/assets/b-outline.svg, brand/bOutline.ts), not the old overlapping drawing. */
export const B_SVG = `<svg width="72" height="94" viewBox="${B_OUTLINE_VIEWBOX}" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="${B_OUTLINE_OUTER}"/><path d="${B_OUTLINE_COUNTER}"/></svg>`;

/** Edition entry pages (web.bwalletx.com/white …): their path names the pack, before any saved choice. */
export const SPLASH_EDITIONS = ['white', 'pink', 'blue', 'yellow', 'vexvoid', 'npg', 'npgx'];

/** Packs left out of the store build's splash (bWalletX only, tokenblasterX.ts). */
export const STORE_SPLASH_SKIP: readonly string[] = ['tokenblaster', 'terrornode'];

/** The inline <script> for the shell's <head>. Every storage access is guarded; failure leaves Gold's page. */
export function splashScript(skip: readonly string[] = []): string {
  const js = `(function(){try{var P=${JSON.stringify(splashPalette(skip))};var E=${JSON.stringify(SPLASH_EDITIONS)};var pth=(location.pathname||'').replace(/\\/+$/,'').slice(1).toLowerCase();var id=E.indexOf(pth)>=0?pth:localStorage.getItem(${JSON.stringify(
    SPLASH_BOOT_KEY,
  )});var c=id&&P[id];if(!c)return;var d=document,r=d.documentElement;r.style.background=c[0];var m=d.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',c[0]);var s=d.createElement('div');s.id='bw-splash';s.setAttribute('aria-hidden','true');s.style.cssText='position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;transition:opacity .25s ease;background:'+c[0]+';color:'+c[1];s.innerHTML=${JSON.stringify(
    B_SVG,
  )};var go=function(){var root=d.getElementById('root');if(!root)return;var done=function(){s.style.opacity='0';setTimeout(function(){s.remove()},300)};if(root.childElementCount){done();return}new MutationObserver(function(_,o){if(root.childElementCount){o.disconnect();done()}}).observe(root,{childList:true})};d.addEventListener('DOMContentLoaded',function(){d.body.appendChild(s);go()})}catch(e){}})();`;
  return `<script>${js}</script>`;
}
