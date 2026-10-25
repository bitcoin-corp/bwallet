/**
 * The bApps screen (owner, 23 Oct 2026): search, then tiers as sections — our b*X bApps, commercial apps,
 * the wallet's built-ins, and other developers' apps only when they meet the bApp standard (docs/BAPP-STANDARD.md).
 * Apps that don't yet meet it sit in a collapsed "Not yet bApp-ready" section, so nothing disappears silently.
 * Each tile shows the standard as four small badges: token · room · theme · in-wallet.
 */
import { useMemo, useState } from 'react';
import { Coins, Lock, MessagesSquare, Palette, Search, Smartphone, ChevronDown } from 'lucide-react';
import { STORE_BUILD } from './storeBuild';
import { COMING_BAPPS } from './bapps';

/** Adult (18+) tiles never reach a store build; a literal env check so Rollup drops the age-gate text too (store grep). */
const ADULT_UI: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);
import {
  ADULT_OK_KEY,
  BX_APPS,
  COMMERCIAL_APPS,
  byCategory,
  productKey,
  withoutDuplicates,
  matchesQuery,
  meetsStandard,
  shortLine,
  tileColour,
  visibleApps,
  type BappStandard,
  type StoreApp,
} from './bappStandard';

export interface StoreItem {
  key: string;
  name: string;
  verb?: string;
  /** The site or wallet path it opens; used to drop repeats of a product already listed above. */
  url?: string;
  icon?: string;
  color?: string;
  standard?: BappStandard;
  demo?: boolean;
  onOpen: () => void;
}

const readAdultOk = () => {
  try {
    return localStorage.getItem(ADULT_OK_KEY) === '1';
  } catch {
    return false;
  }
};

/** The bCorp flag-top b (as on every b*X site's logo.svg), drawn in `ink` so it reads on a bold colour tile. */
export const BMark = ({ ink = '#0B0B0C', size = 56 }: { ink?: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 120 120" aria-hidden="true" style={{ display: 'block' }}>
    <path fill={ink} d="M50 18v54H35V34z" />
    <path
      fill={ink}
      fillRule="evenodd"
      d="M62 43a27 27 0 1 1 0 54a27 27 0 1 1 0-54zm0 15a12 12 0 1 0 0 24a12 12 0 1 0 0-24z"
    />
  </svg>
);

/** Black or white ink, whichever reads better on the tile colour. */
const inkOn = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 96 ? '#0B0B0C' : '#FFFFFF';
};

/**
 * The colour tile (owner, 25 Oct 2026: "more colourful, the dojoX one is GREAT"): like bDojoX's logo, a full-bleed
 * brand colour with one bold black mark. Apps with their own art show it full-bleed; the rest get the b-mark,
 * their initials or their icon on their own colour. Gold when nothing else is known, never grey.
 */
const ColourTile = ({ color, children, dim }: { color: string; children?: React.ReactNode; dim?: boolean }) => (
  <div
    className="relative flex w-full items-center justify-center overflow-hidden rounded-xl aspect-[16/11]"
    style={{
      background: `radial-gradient(120% 90% at 20% 10%, ${color} 0%, ${color} 45%, ${color}cc 100%), #0B0B0C`,
      boxShadow: `inset 0 -18px 30px rgb(0 0 0 / 0.18)`,
      opacity: dim ? 0.8 : 1,
    }}
  >
    {children}
  </div>
);

const Monogram = ({ name, ink }: { name: string; ink: string }) => (
  <span className="font-black leading-none tracking-tight" style={{ color: ink, fontSize: 30 }}>
    {name.replace(/[^A-Z0-9]/g, '').slice(0, 3) || name.slice(0, 2)}
  </span>
);

/** The tile art for an app: its own art full-bleed, else the b-mark (b*X), its icon or its initials on its colour. */
const TileArt = ({
  name,
  color,
  logo,
  icon,
  bx,
  dim,
}: {
  name: string;
  color: string;
  logo?: string;
  icon?: string;
  bx?: boolean;
  dim?: boolean;
}) => {
  const ink = inkOn(color);
  if (logo)
    return (
      <ColourTile color={color} dim={dim}>
        <img src={logo} alt="" loading="lazy" className="h-full w-auto max-w-full object-contain" />
      </ColourTile>
    );
  return (
    <ColourTile color={color} dim={dim}>
      {icon ? (
        <img
          src={icon}
          alt=""
          width={52}
          height={52}
          loading="lazy"
          className="h-[52px] w-[52px] rounded-[12px] object-cover"
          style={{ boxShadow: '0 6px 16px rgb(0 0 0 / 0.28)' }}
        />
      ) : bx ? (
        <BMark ink={ink} size={58} />
      ) : (
        <Monogram name={name} ink={ink} />
      )}
    </ColourTile>
  );
};

const Badges = ({ s }: { s?: BappStandard }) => {
  if (!s) return null;
  const items: [boolean, typeof Coins, string][] = [
    [!!s.token, Coins, s.token ? `Token $${s.token}` : 'No token yet'],
    [!!s.room, MessagesSquare, s.room ? `bChatX room $${s.room}` : 'No bChatX room yet'],
    [!!s.theme, Palette, s.theme ? 'Wallet theme' : 'No wallet theme yet'],
    [s.inWallet, Smartphone, s.inWallet ? 'Runs in the wallet' : 'Opens full screen'],
  ];
  return (
    <div className="flex gap-1" aria-label="bApp standard">
      {items.map(([on, Icon, label]) => (
        <span
          key={label}
          title={label}
          aria-label={label}
          className="inline-flex h-[16px] w-[16px] items-center justify-center rounded-full"
          style={{
            background: on ? 'var(--bw-accent-lo)' : 'transparent',
            border: on ? 'none' : '1px solid var(--bw-line)',
          }}
        >
          <Icon size={9} color={on ? 'var(--bw-accent-hi, #FFD24D)' : 'var(--bw-muted, #98A2B3)'} />
        </span>
      ))}
    </div>
  );
};

/** A half-width card on a phone: colour tile on top, a big name, one short line, the standard badges. */
const Card = ({
  name,
  verb,
  art,
  standard,
  badge,
  onOpen,
}: {
  name: string;
  verb?: string;
  art: React.ReactNode;
  standard?: BappStandard;
  badge?: string;
  onOpen: () => void;
}) => (
  <button
    type="button"
    onClick={onOpen}
    title={verb ? `${name}: ${verb}` : name}
    className="group flex flex-col gap-2 rounded-2xl p-2 text-left w-full min-w-0 active:scale-[0.98] transition duration-150 hover:[border-color:rgb(var(--bw-accent-rgb)/0.55)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--bw-accent-hi)]"
    style={{
      // Themed card, hairline border, explicit ink: a <button> otherwise inherits the UA's black text.
      background: 'var(--bw-card, var(--bw-surface))',
      color: 'var(--bw-text)',
      border: '1px solid var(--bw-line)',
    }}
  >
    {art}
    <div className="min-w-0 flex flex-col gap-1 px-1 pb-1">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-[16px] font-bold tracking-tight text-[color:var(--bw-text)] truncate">{name}</span>
        {badge && (
          <span
            className="shrink-0 rounded px-1 text-[9px] font-bold uppercase"
            style={{
              background: 'var(--bw-card2, var(--bw-line))',
              color: 'var(--bw-text)',
              border: '1px solid var(--bw-line)',
            }}
          >
            {badge}
          </span>
        )}
      </div>
      {verb && (
        <span className="text-[12px] leading-snug text-[color:var(--bw-muted)] truncate">{shortLine(verb)}</span>
      )}
      <Badges s={standard} />
    </div>
  </button>
);

const Header = ({ label }: { label: string }) => (
  <div className="pt-1">
    <h2 className="m-0 text-[12px] font-bold uppercase tracking-wider" style={{ color: 'var(--bw-accent-hi)' }}>
      {label}
    </h2>
  </div>
);

/** Two half-width cards per row on a phone, more on wider screens. Wraps; never scrolls sideways. */
const Grid = ({ children }: { children: React.ReactNode }) => (
  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">{children}</div>
);

export const BappsStore = ({
  open,
  builtins,
  community,
  store = STORE_BUILD,
}: {
  /** Opens a store app's site: the in-wallet frame on phones, a browser tab in the extension (BrowserPage go). */
  open: (url: string, name: string) => void;
  /** The wallet's own bApps (bapps.ts + wallet screens). */
  builtins: StoreItem[];
  /** Other developers' apps; only standard-meeting ones are listed, the rest collapse. */
  community: StoreItem[];
  store?: boolean;
}) => {
  const [q, setQ] = useState('');
  const [adultOk, setAdultOk] = useState(readAdultOk);
  const [confirming, setConfirming] = useState<StoreApp | null>(null);
  const [showNotReady, setShowNotReady] = useState(false);

  const bx = useMemo(() => visibleApps(BX_APPS, store).filter((a) => matchesQuery(a, q)), [q, store]);
  const commercial = useMemo(() => visibleApps(COMMERCIAL_APPS, store).filter((a) => matchesQuery(a, q)), [q, store]);
  // One entry per product: a built-in that repeats a b*X or commercial app (by name or site) is not listed again,
  // and community apps skip anything already listed above.
  const listed = useMemo(() => [...BX_APPS, ...COMMERCIAL_APPS], []);
  const uniqueBuilt = useMemo(() => withoutDuplicates(builtins, listed), [builtins, listed]);
  const uniqueCommunity = useMemo(
    () => withoutDuplicates(community, [...listed, ...uniqueBuilt]),
    [community, listed, uniqueBuilt],
  );
  const built = uniqueBuilt.filter((b) => matchesQuery(b, q));
  const coming = COMING_BAPPS.filter((c) => matchesQuery(c, q));
  const ready = uniqueCommunity.filter((c) => c.standard && meetsStandard(c.standard) && matchesQuery(c, q));
  const notReady = uniqueCommunity.filter((c) => !(c.standard && meetsStandard(c.standard)) && matchesQuery(c, q));
  const empty =
    !bx.length && !commercial.length && !built.length && !coming.length && !ready.length && !notReady.length;

  // A tile opens the tool that works: a b*X card whose product has an in-wallet screen (bMintX → /m/bmint) opens it.
  const inWallet = useMemo(
    () => new Map(builtins.filter((b) => b.url?.startsWith('/')).map((b) => [productKey(b.name), b])),
    [builtins],
  );
  const openApp = (a: StoreApp) => {
    if (a.adult && !adultOk) return setConfirming(a);
    const screen = inWallet.get(productKey(a.name));
    if (screen) return screen.onOpen();
    open(a.url, a.name);
  };
  const art = (a: StoreApp) =>
    a.adult && !adultOk ? (
      <ColourTile color="#3A0A0E">
        <span className="text-[26px] font-black text-[#ff5a5a]">18+</span>
      </ColourTile>
    ) : (
      <TileArt name={a.name} color={tileColour(a.name, a.color)} logo={a.logo} bx={a.tier === 'bx'} />
    );

  const appCards = (apps: StoreApp[]) =>
    byCategory(apps).map((g) => (
      <div key={g.category} className="flex flex-col gap-2">
        <h3 className="m-0 text-[12px] font-semibold text-[color:var(--bw-text)]">{g.category}</h3>
        <Grid>
          {g.apps.map((a) => (
            <Card
              key={a.id}
              name={a.adult && !adultOk ? 'Adults only' : a.name}
              verb={ADULT_UI && a.adult && !adultOk ? 'Confirm you are 18 or over to see this app' : a.verb}
              art={art(a)}
              standard={a.adult && !adultOk ? undefined : a.standard}
              badge={a.adult ? '18+' : undefined}
              onOpen={() => openApp(a)}
            />
          ))}
        </Grid>
      </div>
    ));

  const itemCard = (i: StoreItem, dim?: boolean) => (
    <Card
      key={i.key}
      name={i.name}
      verb={i.verb}
      art={<TileArt name={i.name} color={tileColour(i.name, i.color)} icon={i.icon} dim={dim} />}
      standard={i.standard}
      badge={i.demo ? 'Demo' : undefined}
      onOpen={i.onOpen}
    />
  );

  return (
    <div className="flex flex-col gap-4" data-testid="bapps-store">
      <label
        className="flex items-center gap-2 rounded-full px-3 py-2"
        style={{ background: 'var(--bw-card, var(--bw-surface))', border: '1px solid var(--bw-line)' }}
      >
        <Search size={15} color="var(--bw-muted, #98A2B3)" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search bApps, tokens…"
          aria-label="Search bApps"
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[14px] text-[color:var(--bw-text)] placeholder:text-[color:var(--bw-muted)]"
        />
      </label>
      {bx.length > 0 && (
        <section className="flex flex-col gap-3">
          <Header label="Featured · b*X bApps" />
          {appCards(bx)}
        </section>
      )}
      {commercial.length > 0 && (
        <section className="flex flex-col gap-3">
          <Header label="Commercial apps" />
          {appCards(commercial)}
        </section>
      )}
      {built.length > 0 && (
        <section className="flex flex-col gap-3">
          <Header label="In your wallet" />
          <Grid>{built.map((i) => itemCard(i))}</Grid>
        </section>
      )}
      {coming.length > 0 && (
        <section className="flex flex-col gap-2" aria-label="Coming bApps">
          <Header label="Coming" />
          <div className="flex flex-wrap gap-2">
            {coming.map((c) => (
              <span
                key={c.name}
                title={c.verb}
                className="inline-flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-[12px] font-semibold"
                style={{
                  background: 'var(--bw-card, var(--bw-surface))',
                  color: 'var(--bw-text)',
                  border: '1px solid var(--bw-line)',
                }}
              >
                <img src={c.icon} alt="" width={24} height={24} className="h-6 w-6 rounded-[7px] object-cover" />
                {c.name}
                <span
                  className="rounded px-1 text-[9px] font-bold uppercase"
                  style={{ background: 'rgb(var(--bw-accent-rgb) / 0.16)', color: 'var(--bw-accent-hi)' }}
                >
                  Coming
                </span>
              </span>
            ))}
          </div>
        </section>
      )}
      {ready.length > 0 && (
        <section className="flex flex-col gap-3">
          <Header label="Community bApps" />
          <Grid>{ready.map((i) => itemCard(i))}</Grid>
        </section>
      )}
      {notReady.length > 0 && (
        <section className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setShowNotReady((v) => !v)}
            aria-expanded={showNotReady || !!q.trim()}
            className="flex items-center justify-between rounded-xl px-3 py-2.5 text-left"
            style={{
              background: 'var(--bw-card, var(--bw-surface))',
              color: 'var(--bw-text)',
              border: '1px solid var(--bw-line)',
            }}
          >
            <span className="flex flex-col">
              <span className="text-[12px] font-bold text-[color:var(--bw-text)]">
                Not yet bApp-ready ({notReady.length})
              </span>
            </span>
            <ChevronDown
              size={16}
              color="var(--bw-muted, #98A2B3)"
              style={{ transform: showNotReady ? 'rotate(180deg)' : undefined }}
            />
          </button>
          {(showNotReady || !!q.trim()) && <Grid>{notReady.map((i) => itemCard(i, true))}</Grid>}
        </section>
      )}
      {empty && <p className="text-center text-[13px] text-[color:var(--bw-muted)] py-8">No bApps match “{q}”.</p>}

      {ADULT_UI && confirming && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Adults only"
          className="fixed inset-0 z-[120] flex items-end justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={() => setConfirming(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl p-5 flex flex-col gap-3"
            style={{ background: 'var(--bw-surface)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <Lock size={16} color="#ff5a5a" />
              <span className="text-[15px] font-bold text-[color:var(--bw-text)]">Adults only (18+)</span>
            </div>
            <p className="m-0 text-[12px] text-[color:var(--bw-muted)]">
              {confirming.name} has adult content. It is a separate brand from Ninja Punk Girls. Only continue if you
              are 18 or over.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="flex-1 rounded-full py-2 text-[13px] font-bold border-0"
                style={{ background: 'var(--bw-line)', color: 'var(--bw-text)' }}
              >
                Go back
              </button>
              <button
                type="button"
                onClick={() => {
                  try {
                    localStorage.setItem(ADULT_OK_KEY, '1');
                  } catch {
                    /* private mode: ask again next time */
                  }
                  setAdultOk(true);
                  setConfirming(null);
                }}
                className="flex-1 rounded-full py-2 text-[13px] font-bold border-0"
                style={{ background: '#ff3b3b', color: '#fff' }}
              >
                I am 18 or over
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BappsStore;
