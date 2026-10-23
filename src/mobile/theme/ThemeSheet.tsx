import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Check, Dices, Moon, Palette, Shuffle, SlidersHorizontal, Sun, X } from 'lucide-react';
import {
  DEFAULT_ACCENT,
  DUO_PACKS,
  EDITION_PACKS,
  MORE_COLOURS,
  MONO_PACKS,
  TRI_PACKS,
  THEMES,
  accentById,
  type Accent,
  type AccentId,
  PAID_EDITIONS,
} from './accents';
import { loadAccent, loadMix, loadStorePack, previewMix, saveAccent, saveMix, wearSiteTheme } from './accent';
import { forgetSiteTheme, wornSiteThemes } from './siteTheme';
import { setSiteThemesOn, siteThemesOn } from './connectSiteTheme';
import { accentOfPack } from './themePack';
import { deriveMix, mixFromPack, nextMixerOpen, type MixSpec } from './mixer';
import { THEME_ORDERS_ENABLED, THEME_STORE_PAID_ENABLED } from '../storeBuild';
import { useOwnedThemes } from '../themeStore/useOwnedThemes';
import { patternUri } from '../wallet/cardPatterns';
import { yourThemes } from './yourThemes';

// Get your own theme ($99 a year): bWalletX only, a lazy chunk never in a store build.
const ThemeOrderSheet = THEME_ORDERS_ENABLED ? lazy(() => import('../themeOrder/ThemeOrderSheet')) : null;

// Mix your own is open by default (owner, 15 Oct 2026: found it by accident when collapsed) and remembers the
// user's own collapse for this session, so a remount of the sheet never snaps it shut mid-edit.
let mixerOpen = true;

type ThemeTab = 'colours' | 'card' | 'themes';

// Corners for a mix (owner, 15 Oct 2026: fill the Theme page with real options). Buttons · cards.
const CORNERS = [
  { id: 'sharp', label: 'Sharp', radius: '3px', radiusCard: '6px' },
  { id: 'soft', label: 'Soft', radius: '12px', radiusCard: '16px' },
  { id: 'round', label: 'Round', radius: '999px', radiusCard: '22px' },
] as const;
const rnd = (lo: number, hi: number) => Math.round(lo + Math.random() * (hi - lo));
/** A random mix: any hues, colour and depth kept in ranges that look designed. Contrast is still enforced by deriveMix. */
const surpriseMix = (prev: MixSpec): MixSpec => ({
  ...prev,
  base: Math.random() < 0.7 ? 'dark' : 'light',
  sh: rnd(0, 360),
  ss: rnd(0, 45),
  sd: rnd(0, 60),
  ah: rnd(0, 360),
  as: rnd(55, 100),
  al: rnd(35, 75),
});

/**
 * Theme (owner, 14 Oct 2026): the page behind the sliders icon on the card back, which was "Design your card".
 * Two tabs: App colours (the accent, below) and Design your card (the existing CardDesigner, unchanged apart from
 * its title and these tabs). Where the card has no designer (bWallet's yellow card), only App colours shows.
 */
export function ThemeSheet({
  account,
  onClose,
  card,
  initialTab = 'card',
  offer = null,
}: {
  /** The account's identity key: the accent is kept per account on this device. */
  account: string;
  onClose: () => void;
  /** Renders the card designer with the shared tab bar; absent where the card can't be designed. */
  card?: (tabs: ReactNode) => ReactNode;
  initialTab?: ThemeTab;
  /** A pack an install link offers (theme/themeLink.ts): shown first, applied only on Use it. */
  offer?: AccentId | null;
}) {
  const [tab, setTab] = useState<ThemeTab>(card ? initialTab : 'colours');
  const tabs = card ? (
    <div className="bw-cdes-seg bw-theme-tabs" role="tablist" aria-label="Theme">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'colours'}
        className={tab === 'colours' ? 'on' : ''}
        onClick={() => setTab('colours')}
      >
        App colours
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'card'}
        className={tab === 'card' ? 'on' : ''}
        onClick={() => setTab('card')}
      >
        Design your card
      </button>
      {/* Owner 18 Oct 2026: a third tab for the themes this wallet bought. Paid themes never show in store builds. */}
      {THEME_STORE_PAID_ENABLED && (
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'themes'}
          className={tab === 'themes' ? 'on' : ''}
          onClick={() => setTab('themes')}
        >
          Themes
        </button>
      )}
    </div>
  ) : null;
  if (card && tab === 'card') return <>{card(tabs)}</>;
  if (card && tab === 'themes' && THEME_STORE_PAID_ENABLED)
    return <YourThemes account={account} tabs={tabs} onClose={onClose} />;
  return <AppColours account={account} tabs={tabs} onClose={onClose} offer={offer} />;
}

function AppColours({
  account,
  tabs,
  onClose,
  offer,
}: {
  account: string;
  tabs: ReactNode;
  onClose: () => void;
  offer: AccentId | null;
}) {
  const [current, setCurrent] = useState<AccentId>(() => loadAccent(account));
  const [offered, setOffered] = useState<AccentId | null>(offer);
  const [mix, setMix] = useState<MixSpec>(() => loadMix(account) ?? mixFromPack(accentById(loadAccent(account))));
  const [mixing, setMixingState] = useState(() => mixerOpen);
  const setMixing = (act: Parameters<typeof nextMixerOpen>[1]) =>
    setMixingState((open) => (mixerOpen = nextMixerOpen(open, act)));
  const closeRef = useRef<HTMLButtonElement>(null);
  const [ordering, setOrdering] = useState(false);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const pick = (id: AccentId) => {
    saveAccent(account, id);
    setCurrent(id);
    if (id !== 'custom') setMix(mixFromPack(accentById(id)));
  };
  // Sliders paint live; the mix is saved when the finger lifts (and on Done), not on every frame.
  const slide = (next: MixSpec, commit: boolean) => {
    setMix(next);
    setCurrent('custom');
    setSitePackId(null);
    if (commit) saveMix(account, next);
    else previewMix(next);
  };
  const derived = useMemo(() => deriveMix(mix), [mix]);
  // From sites: family sites' themes this device has worn (theme/siteTheme.ts). They paint as the 'custom' pack.
  const [sites, setSites] = useState(() => wornSiteThemes());
  // Connected sites' themes on their approval sheets (connectSiteTheme.ts, docs/SITE-THEME.md); on by default.
  const [connectThemes, setConnectThemes] = useState(() => siteThemesOn());
  const [sitePackId, setSitePackId] = useState(() => loadStorePack(account)?.id ?? null);
  const siteOn = (id: string) => current === 'custom' && sitePackId === id;
  const mixOn = current === 'custom' && !sites.some((p) => p.id === sitePackId);
  // Shuffle: another pack at random (never the one on). Surprise: a random mix, opened so it can be tuned.
  // Paid editions (Store, $1): only the ones this account bought, plus the one already on, so nobody loses theirs.
  const { owned } = useOwnedThemes();
  const mayUse = (id: string) => !PAID_EDITIONS.includes(id) || owned.has(id) || id === current;
  const editions = THEME_STORE_PAID_ENABLED ? EDITION_PACKS.filter((a) => mayUse(a.id)) : [];
  const shuffle = () => {
    const others = THEMES.filter((a) => a.id !== current && !PAID_EDITIONS.includes(a.id));
    pick(others[Math.floor(Math.random() * others.length)].id);
  };
  const surprise = () => {
    setMixing('open');
    slide(surpriseMix(mix), true);
  };
  const corner = CORNERS.find((c) => c.radiusCard === derived.radiusCard)?.id;

  return createPortal(
    <div className="bw-cdes bw-theme" role="dialog" aria-modal="true" aria-label="Theme">
      <div className="bw-cdes-top">
        <b>Theme</b>
        <button ref={closeRef} type="button" className="bw-cdes-x" aria-label="Close theme" onClick={onClose}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      {tabs}
      {offered && offered !== current && (
        <div className="bw-theme-offer" role="group" aria-label="Theme from a link">
          <span>
            <b>{accentById(offered).label}</b>
            <small>{accentById(offered).blurb}</small>
          </span>
          <button
            type="button"
            className="bw-theme-chip on"
            onClick={() => {
              pick(offered);
              setOffered(null);
            }}
          >
            <Check size={14} aria-hidden="true" />
            Use it
          </button>
          <button type="button" className="bw-theme-chip" onClick={() => setOffered(null)}>
            Not now
          </button>
        </div>
      )}
      <div className="bw-theme-head">
        <p className="bw-theme-more">Theme packs</p>
        <button type="button" className="bw-theme-chip" onClick={shuffle}>
          <Shuffle size={14} aria-hidden="true" />
          Shuffle
        </button>
        <button type="button" className="bw-theme-chip" onClick={surprise}>
          <Dices size={14} aria-hidden="true" />
          Surprise me
        </button>
      </div>
      {/* Owner 17 Oct 2026: bought themes were buried under Mono/Duo/Tri. They come first. */}
      {editions.length > 0 && (
        <>
          <p className="bw-theme-group">Your themes</p>
          <div className="bw-pack-grid" role="radiogroup" aria-label="Your themes">
            {editions.map((a) => (
              <PackTile key={a.id} a={a} on={current === a.id} onPick={() => pick(a.id)} />
            ))}
          </div>
        </>
      )}
      {sites.length > 0 && (
        <>
          <p className="bw-theme-group">From sites</p>
          <div className="bw-pack-grid" role="radiogroup" aria-label="From sites">
            {sites.map((p) => (
              <PackTile
                key={p.id}
                a={accentOfPack(p)}
                on={siteOn(p.id)}
                onPick={() => {
                  wearSiteTheme(account, p);
                  setCurrent('custom');
                  setSitePackId(p.id);
                  setSites(wornSiteThemes());
                }}
              />
            ))}
          </div>
          <div className="bw-theme-head">
            {sites.map((p) => (
              <button
                key={p.id}
                type="button"
                className="bw-theme-chip"
                aria-label={`Remove ${p.label} from From sites`}
                onClick={() => {
                  forgetSiteTheme(p.id);
                  setSites(wornSiteThemes());
                  if (siteOn(p.id)) pick(DEFAULT_ACCENT);
                }}
              >
                <X size={12} aria-hidden="true" />
                {p.label}
              </button>
            ))}
          </div>
        </>
      )}
      <p className="bw-theme-group">Connected sites</p>
      <label className="flex items-center gap-3 text-sm" style={{ padding: '4px 0 12px' }}>
        <input
          type="checkbox"
          checked={connectThemes}
          onChange={(e) => {
            setSiteThemesOn(e.target.checked);
            setConnectThemes(e.target.checked);
          }}
        />
        <span>
          Wear a connected site&apos;s theme on its approval sheets. The site and amounts always show in bWalletX&apos;s
          own colours.
        </span>
      </label>
      <p className="bw-theme-group">Mono</p>
      <div className="bw-pack-grid" role="radiogroup" aria-label="Mono">
        {MONO_PACKS.map((a) => (
          <PackTile key={a.id} a={a} on={current === a.id} onPick={() => pick(a.id)} />
        ))}
      </div>
      <p className="bw-theme-group">Duo</p>
      <div className="bw-pack-grid" role="radiogroup" aria-label="Duo">
        {DUO_PACKS.map((a) => (
          <PackTile key={a.id} a={a} on={current === a.id} onPick={() => pick(a.id)} />
        ))}
        <PackTile
          a={derived}
          on={mixOn}
          onPick={() => {
            setMixing('open');
            slide(mix, true);
          }}
        />
      </div>
      <p className="bw-theme-group">Tri</p>
      <div className="bw-pack-grid" role="radiogroup" aria-label="Tri">
        {TRI_PACKS.map((a) => (
          <PackTile key={a.id} a={a} on={current === a.id} onPick={() => pick(a.id)} />
        ))}
      </div>
      {THEME_STORE_PAID_ENABLED && (
        <p className="bw-theme-more">
          <Link to="/m/store" onClick={onClose} style={{ color: 'var(--bw-accent)' }}>
            VexVoid, NPG, NPGX and more: get them in the Store
          </Link>
        </p>
      )}
      <div className="bw-mixer" data-open={mixing ? '' : undefined}>
        <button type="button" className="bw-mixer-head" aria-expanded={mixing} onClick={() => setMixing('toggle')}>
          <SlidersHorizontal size={18} aria-hidden="true" />
          <span>
            <b>Mix your own</b>
            <small>Starts from the pack you have on; every colour stays readable</small>
          </span>
        </button>
        {mixing && (
          <div className="bw-mixer-body">
            <div className="bw-mixer-base" role="radiogroup" aria-label="Base">
              {(['dark', 'light'] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  role="radio"
                  aria-checked={mix.base === b}
                  className={mix.base === b ? 'on' : ''}
                  onClick={() => slide({ ...mix, base: b }, true)}
                >
                  {b === 'dark' ? <Moon size={16} aria-hidden="true" /> : <Sun size={16} aria-hidden="true" />}
                  {b === 'dark' ? 'Dark' : 'Light'}
                </button>
              ))}
            </div>
            <div className="bw-mixer-base bw-mixer-corners" role="radiogroup" aria-label="Corners">
              {CORNERS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={corner === c.id}
                  className={corner === c.id ? 'on' : ''}
                  onClick={() => slide({ ...mix, radius: c.radius, radiusCard: c.radiusCard }, true)}
                >
                  <i aria-hidden="true" style={{ borderRadius: c.id === 'round' ? 9 : c.id === 'soft' ? 5 : 1 }} />
                  {c.label}
                </button>
              ))}
            </div>
            <MixGroup
              title="Surfaces"
              hint="Page, cards, fills, text"
              swatch={[derived.bg, derived.surface, derived.surface2]}
              rows={[
                { k: 'sh', label: 'Hue', max: 360, kind: 'hue' },
                { k: 'ss', label: 'Colour', max: 100, kind: 'sat' },
                { k: 'sd', label: 'Depth', max: 100, kind: 'depth' },
              ]}
              mix={mix}
              hue={mix.sh}
              slide={slide}
            />
            <MixGroup
              title="Lines & actions"
              hint="Buttons, accent, outlines"
              swatch={[derived.lo, derived.accent, derived.hi]}
              rows={[
                { k: 'ah', label: 'Hue', max: 360, kind: 'hue' },
                { k: 'as', label: 'Colour', max: 100, kind: 'sat' },
                { k: 'al', label: 'Brightness', max: 100, kind: 'depth' },
              ]}
              mix={mix}
              hue={mix.ah}
              slide={slide}
            />
            <p className="bw-mixer-note">
              Text and buttons are checked as you slide and nudged lighter or darker until they read clearly (WCAG AA).
            </p>
          </div>
        )}
      </div>
      <p className="bw-theme-more">Accent only</p>
      <div className="bw-theme-swatches" role="radiogroup" aria-label="Accent colours">
        {MORE_COLOURS.map((a) => (
          <Swatch key={a.id} a={a} on={current === a.id} pick={pick} />
        ))}
      </div>
      <p className="bw-cdes-note">
        Packs restyle the whole app; Accent only keeps Gold&apos;s black. Kept for this account on this device.
      </p>
      {THEME_STORE_PAID_ENABLED && (
        <p className="bw-theme-more">
          <Link to="/m/store" onClick={onClose} style={{ color: 'var(--bw-accent)' }}>
            More in the Store
          </Link>
        </p>
      )}
      {THEME_ORDERS_ENABLED && ThemeOrderSheet && (
        <p className="bw-theme-more">
          <button
            type="button"
            onClick={() => setOrdering(true)}
            style={{
              background: 'none',
              border: 0,
              padding: 0,
              color: 'var(--bw-accent)',
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            Get your own edition · $99 a year
          </button>
        </p>
      )}
      {THEME_ORDERS_ENABLED && ThemeOrderSheet && ordering && (
        <Suspense fallback={null}>
          <ThemeOrderSheet onClose={() => setOrdering(false)} />
        </Suspense>
      )}
      <div className="bw-cdes-actions">
        <button
          type="button"
          className="bw-cdes-reset"
          onClick={() => pick(DEFAULT_ACCENT)}
          disabled={current === DEFAULT_ACCENT}
        >
          Reset to Gold
        </button>
        <button type="button" className="bw-cdes-done bw-theme-done" onClick={onClose}>
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}

type MixKey = 'sh' | 'ss' | 'sd' | 'ah' | 'as' | 'al';
function MixGroup({
  title,
  hint,
  swatch,
  rows,
  mix,
  hue,
  slide,
}: {
  title: string;
  hint: string;
  swatch: string[];
  rows: { k: MixKey; label: string; max: number; kind: 'hue' | 'sat' | 'depth' }[];
  mix: MixSpec;
  hue: number;
  slide: (m: MixSpec, commit: boolean) => void;
}) {
  const track = (kind: 'hue' | 'sat' | 'depth') =>
    kind === 'hue'
      ? 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)'
      : kind === 'sat'
        ? `linear-gradient(90deg,hsl(${hue} 0% 50%),hsl(${hue} 100% 50%))`
        : `linear-gradient(90deg,hsl(${hue} 60% 8%),hsl(${hue} 60% 50%),hsl(${hue} 60% 92%))`;
  return (
    <fieldset className="bw-mixer-group">
      <legend>
        <span className="bw-mixer-sw" aria-hidden="true">
          {swatch.map((c, i) => (
            <i key={i} style={{ background: c }} />
          ))}
        </span>
        <b>{title}</b>
        <small>{hint}</small>
      </legend>
      {rows.map((r) => (
        <label key={r.k} className="bw-mixer-row">
          <span>{r.label}</span>
          <input
            type="range"
            min={0}
            max={r.max}
            value={Math.round(mix[r.k])}
            style={{ background: track(r.kind) }}
            onChange={(e) => slide({ ...mix, [r.k]: Number(e.target.value) }, false)}
            onPointerUp={(e) => slide({ ...mix, [r.k]: Number((e.target as HTMLInputElement).value) }, true)}
            onKeyUp={(e) => slide({ ...mix, [r.k]: Number((e.target as HTMLInputElement).value) }, true)}
          />
        </label>
      ))}
    </fieldset>
  );
}

/** A tappable pack preview: a mini wallet screen drawn in that pack's own colours. */
function PackTile({ a, on, onPick }: { a: Accent; on: boolean; onPick: () => void }) {
  // Mono packs preview as they paint: a white card and a tinted button, no dark fills.
  const mono = a.group === 'mono';
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      aria-label={`${a.label}: ${a.blurb ?? ''}`}
      className={`bw-pack${on ? ' is-on' : ''}`}
      style={{
        background: a.bg,
        color: a.text,
        borderColor: on ? a.accent : a.line,
        borderRadius: Math.min(parseInt(a.radiusCard) || 16, 18),
        boxShadow: on ? `0 0 0 2px ${a.accent}` : undefined,
      }}
      onClick={onPick}
    >
      <span className="bw-pack-screen" aria-hidden="true">
        <span className="bw-pack-bar">
          <i style={{ background: a.accent }} />
          <i style={{ background: a.muted, opacity: 0.6 }} />
        </span>
        <span
          className="bw-pack-card"
          style={{
            background: mono
              ? `linear-gradient(135deg, #FFFFFF, ${a.tint ?? a.surface2})`
              : `linear-gradient(135deg, ${a.hi}, ${a.accent} 50%, ${a.lo})`,
            color: mono ? a.accent : a.on,
            border: mono ? `1px solid ${a.line}` : undefined,
            borderRadius: Math.min(parseInt(a.radiusCard) || 12, 10),
            boxShadow: a.glow !== 'none' ? a.glow : undefined,
          }}
        >
          <b style={{ fontFamily: a.fontNum }}>$128.40</b>
        </span>
        <span className="bw-pack-row" style={{ background: a.surface, borderColor: a.line }}>
          <i style={{ background: a.accent }} />
          <span>
            <em style={{ background: a.text }} />
            <em style={{ background: a.muted, width: '55%' }} />
          </span>
          <small style={{ color: a.success }}>+2.4%</small>
        </span>
        <span className="bw-pack-btns">
          <span
            style={
              mono
                ? { background: a.tint, color: a.accent, borderColor: a.trim, borderRadius: a.radius }
                : { background: a.accent, color: a.on, borderRadius: a.radius }
            }
          >
            Send
          </span>
          <span style={{ borderColor: a.line, color: a.text, borderRadius: a.radius, background: a.surface2 }}>
            Receive
          </span>
        </span>
        <span className="bw-pack-nav" style={{ background: a.nav, borderColor: a.line }}>
          {[0, 1, 2, 3].map((n) => (
            <i key={n} style={{ background: n === 0 ? a.accent : a.muted }} />
          ))}
        </span>
      </span>
      <span className="bw-pack-name" style={{ fontFamily: a.fontHead, fontWeight: a.weightHead }}>
        {a.kind === 'custom' && <Palette size={13} aria-hidden="true" />}
        {a.label}
        {on && <Check size={14} aria-hidden="true" />}
      </span>
      <small className="bw-pack-blurb" style={{ color: a.muted }}>
        {a.blurb}
      </small>
      {a.edition && (
        <small className="bw-pack-credit" style={{ color: a.muted, fontSize: 10, letterSpacing: '0.04em' }}>
          {a.edition}
        </small>
      )}
    </button>
  );
}
function Swatch({ a, on, pick }: { a: Accent; on: boolean; pick: (id: AccentId) => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      className={`bw-theme-swatch${on ? ' is-on' : ''}`}
      onClick={() => pick(a.id)}
    >
      <span
        className="bw-theme-dot"
        style={{ background: `linear-gradient(135deg, ${a.hi}, ${a.accent} 55%, ${a.lo})`, color: a.on }}
      >
        {on && <Check size={16} aria-hidden="true" />}
      </span>
      <span className="bw-theme-name">{a.label}</span>
    </button>
  );
}

/** Themes tab: every theme this wallet owns (any of its accounts), each previewed with its own card art. */
function YourThemes({ account, tabs, onClose }: { account: string; tabs: ReactNode; onClose: () => void }) {
  const [current, setCurrent] = useState<AccentId>(() => loadAccent(account));
  const { boughtOn } = useOwnedThemes();
  const list = yourThemes(boughtOn);
  const pick = (id: AccentId) => {
    saveAccent(account, id);
    setCurrent(id);
  };
  return createPortal(
    <div className="bw-cdes bw-theme" role="dialog" aria-modal="true" aria-label="Theme">
      <div className="bw-cdes-top">
        <b>Theme</b>
        <button type="button" className="bw-cdes-x" aria-label="Close theme" onClick={onClose}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      {tabs}
      <p className="bw-theme-group">Your themes</p>
      {list.length === 0 ? (
        <p className="bw-cdes-note">No themes bought yet. Artist editions are $1 each in the Store.</p>
      ) : (
        <div className="bw-yt-grid" role="radiogroup" aria-label="Your themes">
          {list.map(({ a, from }) => {
            const on = current === a.id;
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={on}
                className={`bw-yt${on ? ' is-on' : ''}`}
                style={{ borderColor: on ? a.accent : a.line, background: a.bg, color: a.text }}
                onClick={() => pick(a.id)}
              >
                <img
                  className="bw-yt-art"
                  src={patternUri(a.pattern, a.accent, account)}
                  alt=""
                  style={{ borderRadius: a.radiusCard, boxShadow: a.glow !== 'none' ? a.glow : undefined }}
                />
                <span className="bw-yt-name" style={{ fontFamily: a.fontHead, fontWeight: a.weightHead }}>
                  {a.label}
                  {on && <Check size={14} aria-hidden="true" />}
                </span>
                <small style={{ color: a.muted }}>{from ? `Bought on ${from}` : (a.edition ?? a.blurb)}</small>
              </button>
            );
          })}
        </div>
      )}
      <p className="bw-cdes-note">Tap one to wear it: app colours and its card art. Kept for this account.</p>
      <p className="bw-theme-more">
        <Link to="/m/store" onClick={onClose} style={{ color: 'var(--bw-accent)' }}>
          More themes in the Store
        </Link>
      </p>
      <div className="bw-cdes-actions">
        <button type="button" className="bw-cdes-done bw-theme-done" onClick={onClose}>
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}
