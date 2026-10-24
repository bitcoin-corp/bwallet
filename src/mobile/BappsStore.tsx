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

/** The bCorp flag-top b (as on every b*X site's logo.svg), in the product's colour. */
export const BMark = ({ color, size = 56 }: { color: string; size?: number }) => {
  const id = `bm${color.replace('#', '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" aria-hidden="true" style={{ display: 'block' }}>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.85" />
          <stop offset="1" stopColor={color} />
        </linearGradient>
        <mask id={`${id}m`}>
          <rect width="120" height="120" fill="#fff" />
          <circle cx="62" cy="70" r="12" fill="#000" />
        </mask>
      </defs>
      <rect
        x="0.75"
        y="0.75"
        width="118.5"
        height="118.5"
        rx="28"
        fill="#0B0B0C"
        stroke="var(--bw-line, #2b2f36)"
        strokeWidth="1.5"
      />
      <g fill={`url(#${id}g)`} mask={`url(#${id}m)`}>
        <polygon points="50,18 50,72 35,72 35,34" />
        <circle cx="62" cy="70" r="27" />
      </g>
    </svg>
  );
};

const Monogram = ({ name, color, size = 56 }: { name: string; color: string; size?: number }) => (
  <div
    className="flex items-center justify-center font-black"
    style={{
      width: size,
      height: size,
      borderRadius: size * 0.23,
      background: 'var(--bw-card2, var(--bw-card, var(--bw-surface)))',
      // Ink from the theme (a product colour such as gold fails on a white card); the product colour is the ring.
      color: 'var(--bw-text)',
      fontSize: size * 0.36,
      boxShadow: `inset 0 0 0 1.5px ${color}99`,
    }}
  >
    {name.replace(/[^A-Z0-9]/g, '').slice(0, 3) || name.slice(0, 2)}
  </div>
);

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

const Card = ({
  name,
  verb,
  art,
  standard,
  badge,
  onOpen,
  dim,
}: {
  name: string;
  verb?: string;
  art: React.ReactNode;
  standard?: BappStandard;
  badge?: string;
  onOpen: () => void;
  dim?: boolean;
}) => (
  <button
    type="button"
    onClick={onOpen}
    className="group flex items-center gap-3 rounded-2xl p-3 text-left w-full min-w-0 active:scale-[0.98] transition duration-150 hover:[border-color:rgb(var(--bw-accent-rgb)/0.55)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--bw-accent-hi)]"
    style={{
      // Themed card, hairline border, explicit ink: a <button> otherwise inherits the UA's black text.
      background: 'var(--bw-card, var(--bw-surface))',
      color: 'var(--bw-text)',
      border: '1px solid var(--bw-line)',
      boxShadow: 'inset 0 1px 0 rgb(var(--bw-accent-rgb) / 0.08)',
    }}
  >
    <div className="shrink-0" style={{ opacity: dim ? 0.75 : 1 }}>
      {art}
    </div>
    <div className="min-w-0 flex-1 flex flex-col gap-1">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-[15px] font-bold tracking-tight text-[color:var(--bw-text)] truncate">{name}</span>
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
      {verb && <span className="text-[12px] leading-snug text-[color:var(--bw-muted)] line-clamp-2">{verb}</span>}
      <Badges s={standard} />
    </div>
  </button>
);

const Header = ({ label, sub }: { label: string; sub?: string }) => (
  <div className="pt-1">
    <h2 className="m-0 text-[12px] font-bold uppercase tracking-wider" style={{ color: 'var(--bw-accent-hi)' }}>
      {label}
    </h2>
    {sub && <p className="m-0 text-[11px] text-[color:var(--bw-muted)]">{sub}</p>}
  </div>
);

const Grid = ({ children }: { children: React.ReactNode }) => (
  <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-2">{children}</div>
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
      <div
        className="flex h-14 w-14 items-center justify-center rounded-[13px]"
        style={{ background: 'var(--bw-card, var(--bw-surface))', boxShadow: 'inset 0 0 0 1.5px #ff3b3b88' }}
      >
        <span className="text-[15px] font-black text-[#ff5a5a]">18+</span>
      </div>
    ) : a.logo ? (
      <img
        src={a.logo}
        alt=""
        width={56}
        height={56}
        className="h-14 w-14 rounded-[13px] object-cover bg-[var(--bw-card,var(--bw-surface))]"
      />
    ) : a.tier === 'bx' ? (
      <BMark color={a.color} />
    ) : (
      <Monogram name={a.name} color={a.color} />
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
      art={
        i.icon ? (
          <img
            src={i.icon}
            alt=""
            width={56}
            height={56}
            loading="lazy"
            className="h-14 w-14 rounded-[13px] object-cover bg-[var(--bw-card,var(--bw-surface))]"
          />
        ) : (
          <Monogram name={i.name} color={i.color ?? '#FFD24D'} />
        )
      }
      standard={i.standard}
      badge={i.demo ? 'Demo' : undefined}
      onOpen={i.onOpen}
      dim={dim}
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
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[color:var(--bw-muted)]">
        <span className="inline-flex items-center gap-1">
          <Coins size={10} /> token
        </span>
        <span className="inline-flex items-center gap-1">
          <MessagesSquare size={10} /> bChatX room
        </span>
        <span className="inline-flex items-center gap-1">
          <Palette size={10} /> wallet theme
        </span>
        <span className="inline-flex items-center gap-1">
          <Smartphone size={10} /> runs in the wallet
        </span>
      </div>

      {bx.length > 0 && (
        <section className="flex flex-col gap-3">
          <Header label="Featured · b*X bApps" sub="Made by The Bitcoin Corporation" />
          {appCards(bx)}
        </section>
      )}
      {commercial.length > 0 && (
        <section className="flex flex-col gap-3">
          <Header label="Commercial apps" sub="Ventures and clients with their own tokens" />
          {appCards(commercial)}
        </section>
      )}
      {built.length > 0 && (
        <section className="flex flex-col gap-3">
          <Header label="In your wallet" sub="Built-in bApps and the bApps suite" />
          <Grid>{built.map((i) => itemCard(i))}</Grid>
        </section>
      )}
      {coming.length > 0 && (
        <section className="flex flex-col gap-2" aria-label="Coming bApps">
          <Header label="Coming" sub="Not live yet. Listed so you know it's on the way" />
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
          <Header label="Community bApps" sub="Other developers' apps that meet the bApp standard" />
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
              <span className="text-[11px] text-[color:var(--bw-muted)]">
                Other developers' apps without a token, room, theme or in-wallet sign-in
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
