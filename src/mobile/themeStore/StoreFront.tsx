import { lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  Circle,
  BookOpen,
  Brush,
  Clapperboard,
  DoorOpen,
  ExternalLink,
  Palette,
  Repeat,
  ShoppingBag,
  Search,
  Smile,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { TopNav } from '../../components/TopNav';
import { THEME_ORDERS_ENABLED } from '../storeBuild';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useAccentId } from '../theme/useAccent';
import { BUNDLED_PACKS, bundledId, type ThemePack } from '../theme/themePack';
import { applyPack } from './catalog';
import { PackCard, PreviewSheet } from './ui';
import { BuySheet } from './StoreBuy';
import { useOwnedThemes } from './useOwnedThemes';
import { SHOPS, shopById, type Shop } from './shops';
import { priceLabel, visible, type Listing } from './bstore';
import { EMOJI_PACK_IDS } from '../theme/emojiThemes';
import { openExternal } from '../exchange/useTokenRowActions';

// The existing "Get your own edition" order flow ($99 a year), bWalletX only.
const ThemeOrderSheet = THEME_ORDERS_ENABLED ? lazy(() => import('../themeOrder/ThemeOrderSheet')) : null;

type DeptId = 'themes' | 'subscriptions' | 'stickers' | 'art' | 'media' | 'learning' | 'rooms' | 'services';
interface Dept {
  id: DeptId;
  name: string;
  blurb: string;
  sell: string;
  Icon: LucideIcon;
  has: (l: Listing) => boolean;
}

/**
 * bStore departments (owner, 17 Oct 2026): the store is organised into departments and Themes is one of them.
 * Themes means themes people make and sell; the built-in themes stay in Settings › Theme, never here.
 */
const DEPTS: readonly Dept[] = [
  {
    id: 'themes',
    name: 'Themes',
    blurb: 'Looks for the whole app, made by people',
    sell: 'Sell your theme',
    Icon: Palette,
    has: (l) => l.category === 'themes',
  },
  {
    id: 'subscriptions',
    name: 'Subscriptions',
    blurb: 'Pay by the day, week or month',
    sell: 'Sell a subscription',
    Icon: Repeat,
    has: (l) => l.type === 'subscription',
  },
  {
    id: 'stickers',
    name: 'Stickers & emoji',
    blurb: 'Packs for chats and posts',
    sell: 'Sell a pack',
    Icon: Smile,
    has: (l) => l.category === 'stickers',
  },
  {
    id: 'art',
    name: 'Art & editions',
    blurb: 'Pictures and numbered editions',
    sell: 'Sell your art',
    Icon: Brush,
    has: (l) => l.category === 'art',
  },
  {
    id: 'media',
    name: 'Music & video',
    blurb: 'Albums, films and fan access',
    sell: 'Sell music or video',
    Icon: Clapperboard,
    has: (l) => l.category === 'media',
  },
  {
    id: 'learning',
    name: 'Courses & books',
    blurb: 'Learn something, read something',
    sell: 'Sell a course or book',
    Icon: BookOpen,
    has: (l) => l.category === 'learning',
  },
  {
    id: 'rooms',
    name: 'Rooms & memberships',
    blurb: 'Join a room without holding its token',
    sell: 'Sell memberships',
    Icon: DoorOpen,
    has: (l) => l.category === 'rooms',
  },
  {
    id: 'services',
    name: 'Services',
    blurb: 'Design, dev and help from people',
    sell: 'Offer a service',
    Icon: Wrench,
    has: (l) => l.category === 'services',
  },
];

// Real listings only. None are live yet, so each department shows an honest empty state (no examples).
const LISTINGS: readonly Listing[] = visible([]);

const matches = (l: Listing, q: string) =>
  !q || `${l.title} ${l.description} ${l.seller}`.toLowerCase().includes(q.toLowerCase());

// Same frame, type and colours as the Exchange page (market/MarketPage.tsx), so the Store looks like the rest of the app.
const MUTED = '#98A2B3';
const TILE = 'rounded-xl bg-[var(--bw-surface)] border border-[#2b2f36]';
const BACK =
  'flex items-center gap-1.5 self-start rounded-xl bg-[var(--bw-surface)] border border-[#2b2f36] px-3 py-2 text-xs font-bold text-white cursor-pointer';

// Our edition themes, listed in Themes (owner, 17 Oct 2026). They apply today, so they show their real state.
const EDITION_IDS: readonly string[] = ['vexvoid', 'npg', 'npgx', 'tokenblaster', 'terrornode']; // Scammers Cartel hidden until ready (19 Oct)
// The Emoji collection (owner, 18 Oct 2026): twelve $1 themes with Twemoji art, sold the same way.
const EMOJI_IDS: readonly string[] = EMOJI_PACK_IDS;
const EDITIONS: readonly ThemePack[] = [...EDITION_IDS, ...EMOJI_IDS]
  .map((id) => BUNDLED_PACKS.find((p) => p.id === id))
  .filter((p): p is ThemePack => !!p);

/** The editions as products ($1 each, owner 17 Oct 2026): live mini wallet, tap for the big preview, then Buy,
 *  Apply or In use. Buying is real (StoreBuy.tsx); until the server is set up it says buying opens soon. */
function Editions({ ids = EDITION_IDS }: { ids?: readonly string[] }) {
  const { chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account?.pubKeys?.identityPubKey ?? '';
  const current = useAccentId();
  const { owned, open: buyingOpen, add } = useOwnedThemes();
  const [preview, setPreview] = useState<ThemePack | null>(null);
  const [buying, setBuying] = useState<ThemePack | null>(null);
  const [soon, setSoon] = useState(false);
  const inUse = (p: ThemePack) => bundledId(p) === current;
  const action = (p: ThemePack) => {
    if (inUse(p))
      return (
        <button
          type="button"
          disabled
          aria-pressed
          className="rounded-xl border border-[#2b2f36] py-2 text-xs font-bold"
          style={{ color: MUTED, background: 'transparent' }}
        >
          In use
        </button>
      );
    const mine = owned.has(p.id);
    return (
      <button
        type="button"
        onClick={() => (mine ? applyPack(account, p) : buyingOpen ? setBuying(p) : setSoon(true))}
        className="bw-pill bw-pill-gold flex min-h-[36px] items-center justify-center py-2 text-xs font-bold"
      >
        {mine ? 'Apply' : 'Buy · $1'}
      </button>
    );
  };
  // The Buy button carries the price; the pill only marks what you own (no second "$1", owner 19 Oct 2026).
  const price = (p: ThemePack) => (owned.has(p.id) ? 'Owned' : undefined);
  return (
    <>
      <div className="bw-pack-grid grid grid-cols-2 gap-1.5">
        {EDITIONS.filter((p) => ids.includes(p.id)).map((p) => (
          <PackCard key={p.id} p={p} inUse={inUse(p)} price={price(p)} onOpen={() => setPreview(p)}>
            {action(p)}
          </PackCard>
        ))}
      </div>
      {soon && (
        <p role="status" className="text-xs text-center m-0" style={{ color: MUTED }}>
          Buying opens soon.
        </p>
      )}
      {preview && (
        <PreviewSheet p={preview} inUse={inUse(preview)} price={price(preview)} onClose={() => setPreview(null)}>
          {action(preview)}
        </PreviewSheet>
      )}
      {buying && (
        <BuySheet
          pack={buying.id}
          label={buying.label}
          onClose={() => setBuying(null)}
          onDone={(apply) => {
            add(buying.id);
            if (apply) applyPack(account, buying);
            setPreview(null);
            setBuying(null);
          }}
        />
      )}
    </>
  );
}

/** One shop in the mall: banner, logo, name, who runs it, and everything it sells. */
function ShopPage({ shop, onBack }: { shop: Shop; onBack: () => void }) {
  return (
    <>
      <button type="button" onClick={onBack} className={BACK}>
        <ArrowLeft size={14} aria-hidden="true" /> All shops
      </button>
      <div className={`${TILE} overflow-hidden`}>
        <div
          className="h-28 w-full bg-cover bg-center"
          style={{
            background: shop.bannerCss ?? (shop.banner ? `center / cover no-repeat url(${shop.banner})` : shop.colour),
          }}
        />
        <div className="flex items-center gap-3 p-3">
          <img src={shop.logo} alt="" width={48} height={48} className="rounded-xl -mt-8 border-2 border-[#2b2f36]" />
          <div className="min-w-0">
            <b className="block text-base text-white">{shop.name}</b>
            <span className="text-xs" style={{ color: MUTED }}>
              {shop.blurb} · by {shop.owner}
            </span>
          </div>
        </div>
      </div>
      <h2 className="text-sm font-bold text-white m-0">Themes</h2>
      <Editions ids={shop.themes} />
      {!!shop.links?.length && (
        <div className="grid grid-cols-2 gap-1.5">
          {shop.links.map((l) => (
            <button
              key={l.href}
              type="button"
              onClick={() => openExternal(l.href)}
              className="bw-pill bw-pill-gold flex min-h-[40px] items-center justify-center gap-1.5 py-2 text-xs font-bold"
            >
              {l.label} <ExternalLink size={12} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      {!!shop.coming?.length && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {shop.coming.map((c) => (
            <li key={c} className={`${TILE} px-3 py-2 text-xs`} style={{ color: MUTED }}>
              {c}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs m-0" style={{ color: MUTED }}>
        More from {shop.name} soon.
      </p>
    </>
  );
}

/** What a shop owner needs (owner, 17 Oct 2026): a clear list of what to sell and what a good shop has. */
const MANIFEST: readonly (readonly [string, readonly string[]])[] = [
  [
    'What you can sell',
    [
      'Themes: colours and card art for the whole app',
      'Stickers & emoji packs',
      'Art & numbered editions',
      'Music & video: albums, films, fan access',
      'Courses & books',
      'Room memberships and subscriptions (by day, week or month)',
      'Services: design, dev, help',
    ],
  ],
  [
    'What a good shop has',
    [
      'A name and a one-line blurb',
      'A logo, square, 512 × 512',
      'A banner, wide, 1500 × 500',
      'Receipt art: a square picture printed on every receipt you issue (PNG, JPEG or WebP; your logo if none)',
      'At least 3 products, each with a title, one or two lines, a price in $ and a preview picture',
      'For a theme: its colours and card art',
      'Your token and room, if you have one, so buyers can talk to you',
    ],
  ],
  [
    'Rules',
    [
      'Digital goods only',
      'Your own work, or work you have the rights to',
      "No one else's brand or name",
      'b reviews every shop and listing before it goes live',
    ],
  ],
  [
    'Money',
    ["Paid in BSV, straight from the buyer's wallet", 'You get 80%, the Store keeps 20%', 'Paid to your bWalletX'],
  ],
];

function ShopManifest() {
  return (
    <div className={`${TILE} flex flex-col gap-3 p-3`}>
      {MANIFEST.map(([head, items]) => (
        <div key={head}>
          <b className="block text-sm text-white">{head}</b>
          <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
            {items.map((t) => (
              <li key={t} className="flex items-start gap-1.5 text-xs" style={{ color: MUTED }}>
                <Check size={12} className="mt-0.5 shrink-0" aria-hidden="true" /> {t}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p role="status" className="m-0 text-xs font-semibold" style={{ color: 'var(--bw-accent)' }}>
        Shops open soon. Get these ready now.
      </p>
    </div>
  );
}

/** The shops row: a 2-column grid of shop cards (no sideways scrolling), then Open a shop. */
function Shops({ onOpen }: { onOpen: (id: string) => void }) {
  const [soon, setSoon] = useState(false);
  return (
    <>
      <h2 className="text-sm font-bold text-white m-0">Shops</h2>
      <div className="grid grid-cols-2 gap-1.5">
        {SHOPS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onOpen(s.id)}
            className={`${TILE} overflow-hidden flex flex-col text-left cursor-pointer p-0`}
          >
            <span
              className="block h-16 w-full"
              style={{ background: s.bannerCss ?? (s.banner ? `center / cover no-repeat url(${s.banner})` : s.colour) }}
            />
            <span className="flex items-center gap-2 p-2">
              <img src={s.logo} alt="" width={28} height={28} className="rounded-lg" />
              <span className="min-w-0">
                <span className="block text-sm font-bold text-white truncate">{s.name}</span>
                <span className="block text-[11px] truncate" style={{ color: MUTED }}>
                  {s.themes.length} {s.themes.length === 1 ? 'item' : 'items'}
                </span>
              </span>
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setSoon((v) => !v)}
        aria-expanded={soon}
        className={`${BACK} self-stretch justify-center py-2.5`}
      >
        Open your own shop
      </button>
      {soon && <ShopManifest />}
      <h2 className="text-sm font-bold text-white m-0">Departments</h2>
    </>
  );
}

/** One department: its products, or "Be the first to sell here". Buying and selling are not open yet. */
function Department({ d, query, onBack }: { d: Dept; query: string; onBack: () => void }) {
  const [soon, setSoon] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const items = LISTINGS.filter((l) => d.has(l) && matches(l, query));
  return (
    <>
      <button type="button" onClick={onBack} className={BACK}>
        <ArrowLeft size={14} aria-hidden="true" /> All departments
      </button>
      <h2 className="text-base font-bold text-white flex items-center gap-1.5 m-0">
        <d.Icon size={18} style={{ color: 'var(--bw-accent)' }} aria-hidden="true" /> {d.name}
      </h2>
      <p className="text-xs m-0" style={{ color: MUTED }}>
        {d.blurb}
      </p>
      {d.id === 'themes' && (
        <>
          <Editions />
          <h3 className="text-sm font-bold text-white m-0 mt-1">Emoji collection</h3>
          <p className="text-xs m-0 -mt-2" style={{ color: MUTED }}>
            Twelve emoji looks, $1 each. Art: Twemoji, CC-BY 4.0.
          </p>
          <Editions ids={EMOJI_IDS} />
        </>
      )}
      {items.length ? (
        <div className="grid grid-cols-2 gap-1.5">
          {items.map((l) => (
            <div key={l.id} className={`${TILE} p-3 flex flex-col gap-1`}>
              <b className="text-sm text-white">{l.title}</b>
              <span className="text-xs" style={{ color: MUTED }}>
                {l.seller}
              </span>
              <span className="text-xs text-white">{priceLabel(l)}</span>
            </div>
          ))}
        </div>
      ) : d.id === 'themes' ? null : (
        <div className={`${TILE} p-5 flex flex-col items-center gap-2 text-center`}>
          <d.Icon size={28} style={{ color: 'var(--bw-accent)' }} aria-hidden="true" />
          <b className="text-sm text-white">Be the first to sell here</b>
          <span className="text-xs" style={{ color: MUTED }}>
            Nothing is for sale in {d.name} yet.
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={() => setSoon(true)}
        className="bw-pill bw-pill-gold flex min-h-[44px] items-center justify-center gap-2 py-2.5 text-sm font-bold"
      >
        {d.sell}
      </button>
      {soon && (
        <p role="status" className="text-xs text-center m-0" style={{ color: MUTED }}>
          Selling opens soon. b reviews every listing before it goes live.
        </p>
      )}
      {d.id === 'themes' && ThemeOrderSheet && (
        <button
          type="button"
          onClick={() => setOrdering(true)}
          className={`${BACK} self-stretch justify-center py-2.5`}
        >
          Order your own theme edition
        </button>
      )}
      {ordering && ThemeOrderSheet && (
        <Suspense fallback={null}>
          <ThemeOrderSheet onClose={() => setOrdering(false)} />
        </Suspense>
      )}
    </>
  );
}

function Store() {
  const navigate = useNavigate();
  const [dept, setDept] = useState<DeptId | null>(null);
  // /m/store?shop=<id> opens that shop (the home's Store showcase links each item to its shop).
  const [shopId, setShopId] = useState<string | null>(() => {
    try {
      const id = new URLSearchParams(window.location.search).get('shop');
      return id && shopById(id) ? id : null;
    } catch {
      return null;
    }
  });
  const shop = shopId ? shopById(shopId) : undefined;
  const [query, setQuery] = useState('');
  const open = DEPTS.find((d) => d.id === dept);
  const q = query.trim();
  const shown = useMemo(
    () =>
      q
        ? DEPTS.filter(
            (d) =>
              `${d.name} ${d.blurb}`.toLowerCase().includes(q.toLowerCase()) ||
              LISTINGS.some((l) => d.has(l) && matches(l, q)),
          )
        : DEPTS,
    [q],
  );

  return (
    <div
      // Pinned to the screen so it has a height to scroll in (the /m/store route's parent gives none, so a
      // height: 100% box grew with its content and never scrolled; owner, 17 Oct 2026). The dock sits above it.
      // Stops at the dock (like a chat room), so the strip under the dock stays the app's own and the Store's
      // content never shows through beneath it (owner, 17 Oct 2026).
      className="flex w-full flex-col items-center overflow-x-hidden overflow-y-auto pb-6"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 'calc(env(safe-area-inset-bottom) + var(--dock-h, 3.75rem))',
        overscrollBehavior: 'contain',
        background: 'var(--bw-bg)',
      }}
    >
      <TopNav />
      <div className="w-full px-4 pt-16 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-bold text-white flex items-center gap-1.5 m-0">
            <ShoppingBag size={18} style={{ color: 'var(--bw-accent)' }} aria-hidden="true" /> Store
          </h1>
          {/* Back out like every other page: to where you came from, else the Exchange (owner, 17 Oct 2026). */}
          {!open && !shop && (
            <button
              type="button"
              onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/m/exchange'))}
              className={BACK}
            >
              <ArrowLeft size={14} aria-hidden="true" /> Back
            </button>
          )}
        </div>
        <label className="flex items-center gap-2 rounded-xl bg-[var(--bw-surface)] border border-[#2b2f36] px-3 py-2">
          <Search size={16} color={MUTED} aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the Store"
            aria-label="Search the Store"
            className="flex-1 bg-transparent border-0 outline-none text-sm text-white"
          />
        </label>
        {shop ? (
          <ShopPage shop={shop} onBack={() => setShopId(null)} />
        ) : open ? (
          <Department d={open} query={q} onBack={() => setDept(null)} />
        ) : (
          <>
            {!q && <Shops onOpen={setShopId} />}
            {shown.length ? (
              <div className="grid grid-cols-2 gap-1.5">
                {shown.map((d) => {
                  const n = LISTINGS.filter(d.has).length + (d.id === 'themes' ? EDITIONS.length : 0);
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => setDept(d.id)}
                      className={`${TILE} flex min-h-[112px] flex-col items-start gap-1 p-3 text-left cursor-pointer`}
                    >
                      <d.Icon size={22} style={{ color: 'var(--bw-accent)' }} aria-hidden="true" />
                      <span className="text-sm font-bold text-white">{d.name}</span>
                      <span className="text-[11px] leading-tight" style={{ color: MUTED }}>
                        {d.blurb}
                      </span>
                      <span className="mt-auto text-[11px] font-semibold" style={{ color: MUTED }}>
                        {n ? `${n} for sale` : 'Be the first to sell'}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm m-0" style={{ color: MUTED }}>
                Nothing matches &ldquo;{q}&rdquo;.
              </p>
            )}
            <ul className="m-0 p-0 list-none flex flex-col gap-1 text-xs" style={{ color: MUTED }}>
              {(
                [
                  ['Departments and search', true],
                  ['Buying, paid in BSV', false],
                  ['Selling, with every listing reviewed by b', false],
                ] as const
              ).map(([t, done]) => (
                <li key={t} className="flex items-center gap-1.5">
                  {done ? <Check size={12} aria-hidden="true" /> : <Circle size={12} aria-hidden="true" />} {t}
                  {!done && ' (coming)'}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/** Store (/m/store, docs/BSTORE.md): departments, search, each department's products, inside the app shell
 *  (top bar + dock), laid out like the Exchange. bWalletX only: ThemeStorePage loads this chunk behind
 *  THEME_STORE_PAID_ENABLED. */
export default Store;
