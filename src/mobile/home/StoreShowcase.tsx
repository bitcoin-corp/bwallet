import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ShoppingBag } from 'lucide-react';
import { SHOPS } from '../themeStore/shops';
import { HEADLINE_ALBUM } from '../media/featured/featured';
import { BSPACES_ENABLED } from '../storeBuild';
import scammersCard from '../wallet/editionArt/scammerscartel-dj-card.webp';
import npgBanner from '../wallet/art/npg/npg-1.webp';
import vexArt from '../media/featured/vexvoid-cover.jpg';
import namesArt from './art/store-names.webp';
import spacesArt from './art/store-spaces.webp';
import { bavatarSvg } from '../bavatar/bavatar';
import { useCollapsed } from './collapse';
import { CollapseToggle } from './CollapseToggle';
import { AD_PAGE_URL, adSlideText } from './adSlot';
import { openExternal } from '../exchange/useTokenRowActions';
import { TOKENBLASTER_SHOP_ART } from '../theme/tokenblasterShopX';

/**
 * Store showcase (home module, bWalletX only: loaded behind THEME_STORE_PAID_ENABLED like the Store itself).
 * A calm, slowly turning shelf of real things in the Store: the edition themes (Scammers Cartel first), the emoji
 * packs, the VexVoid album, OpNS names and Spaces. Every slide opens its own page.
 */
type Item = {
  key: string;
  kind: string;
  title: string;
  blurb: string;
  to: string;
  /** Background behind the picture (or the whole art when there is no picture). */
  art: string;
  /** The item's picture, shown sharp with object-fit: cover; `pos` keeps its focal point in view. */
  img?: string;
  pos?: string;
  logo?: string;
  /** An outside page (opened in the browser) instead of an in-app route. */
  href?: string;
};

/** Sharp art per shop (the shops' own banner CSS uses a soft, blurred backdrop for Scammers Cartel). */
const SHOP_ART: Record<string, { img: string; pos: string } | undefined> = {
  scammerscartel: { img: scammersCard, pos: '50% 35%' },
  npg: { img: npgBanner, pos: '50% 30%' },
  vexvoid: { img: vexArt, pos: '50% 40%' },
  ...TOKENBLASTER_SHOP_ART,
};

const ROTATE_MS = 5200;

/** Gold bAvatar art for a slide (seeded by its key), used when it has no picture or its picture fails to load. */
const goldArt = (seed: string) =>
  'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(bavatarSvg(seed, { size: 512 }));

const reduced = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

const showcaseItems = (spaces = BSPACES_ENABLED): Item[] => {
  const order = ['emoji', 'npg', 'tokenblaster', 'vexvoid', 'npgx']; // Scammers Cartel hidden until ready (19 Oct)
  const shops = [...SHOPS].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const items: Item[] = shops.map((s) => ({
    ...SHOP_ART[s.id],
    key: `shop:${s.id}`,
    kind: s.id === 'emoji' ? 'Emoji packs' : 'Theme',
    title: s.name,
    blurb: s.blurb,
    to: `/m/store?shop=${encodeURIComponent(s.id)}`,
    art: s.bannerCss ?? (s.banner ? `center / cover no-repeat url(${s.banner}), ${s.colour}` : s.colour),
    logo: s.logo,
  }));
  // The album sits after NPG and TokenBlaster (TokenBlaster right after NPG, owner 25 Oct 2026).
  items.splice(items.findIndex((i) => i.key === 'shop:tokenblaster') + 1 || 2, 0, {
    key: 'album',
    kind: 'Album',
    title: HEADLINE_ALBUM.title,
    blurb: `${HEADLINE_ALBUM.artist} · first track free`,
    to: '/m/media',
    art: '#000',
    img: HEADLINE_ALBUM.cover,
    pos: '50% 40%',
  });
  items.splice(4, 0, {
    key: 'names',
    kind: 'Names',
    title: 'Your name on chain',
    blurb: 'OpNS names: short, yours, payable',
    to: '/m/names',
    art: '#000',
    img: namesArt,
    pos: '70% 50%',
  });
  if (spaces)
    items.push({
      key: 'spaces',
      kind: 'Spaces',
      title: 'Live Spaces',
      blurb: 'Talks and shows in your rooms, tickets at the door',
      to: '/m/spaces',
      art: '#000',
      img: spacesArt,
      pos: '70% 50%',
    });
  // Far right: the advert slot (owner, 20 Oct 2026). Gold bAvatar art like any slide without a picture of its own.
  items.push({ key: 'advertise', ...adSlideText(), to: '/m/store', href: AD_PAGE_URL, art: '#000' });
  // Gold by default: a slide with no picture of its own gets gold bAvatar art, never a blank banner.
  return items.map((it) => (it.img || /url\(/.test(it.art) ? it : { ...it, img: goldArt(it.key) }));
};

const StoreShowcase = () => {
  const navigate = useNavigate();
  const items = useMemo(() => showcaseItems(), []);
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [collapsed, toggleCollapsed] = useCollapsed('showcase');
  useEffect(() => {
    if (collapsed || paused || reduced() || items.length < 2) return;
    const t = setInterval(() => setI((n) => (n + 1) % items.length), ROTATE_MS);
    return () => clearInterval(t);
  }, [collapsed, paused, items.length]);
  const go = (d: number) => setI((n) => (n + d + items.length) % items.length);
  return (
    <section
      className="bw-home-panel bw-home-show"
      aria-roledescription="carousel"
      aria-label="From the Store"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <header className="bw-home-head">
        <ShoppingBag size={16} className="bw-home-ico" aria-hidden="true" />
        <span className="bw-home-title">From the Store</span>
        <button type="button" className="bw-home-link" onClick={() => navigate('/m/store')}>
          Open Store
        </button>
        <CollapseToggle collapsed={collapsed} onToggle={toggleCollapsed} label="the Store showcase" />
      </header>
      {!collapsed && (
        <div className="bw-home-stage">
          {items.map((it, n) => (
            <button
              key={it.key}
              type="button"
              className={`bw-home-slide${n === i ? ' on' : ''}`}
              aria-hidden={n !== i}
              tabIndex={n === i ? 0 : -1}
              onClick={() => (it.href ? openExternal(it.href) : navigate(it.to))}
            >
              <span className="bw-home-art" style={{ background: it.art }} />
              {it.img && (
                <img
                  className="bw-home-artimg"
                  src={it.img}
                  alt=""
                  style={{ objectPosition: it.pos ?? 'center' }}
                  onError={(e) => {
                    const fallback = goldArt(it.key);
                    if (e.currentTarget.src !== fallback) e.currentTarget.src = fallback;
                  }}
                />
              )}
              <span className="bw-home-cap">
                {it.logo && it.logo !== it.img && <img src={it.logo} alt="" width={34} height={34} />}
                <span className="bw-home-tiletext">
                  <span className="bw-home-kind">{it.kind}</span>
                  <span className="bw-home-captitle">{it.title}</span>
                  <span className="bw-home-capsub">{it.blurb}</span>
                </span>
              </span>
            </button>
          ))}
          <button type="button" className="bw-home-nav l" aria-label="Previous" onClick={() => go(-1)}>
            <ChevronLeft size={16} />
          </button>
          <button type="button" className="bw-home-nav r" aria-label="Next" onClick={() => go(1)}>
            <ChevronRight size={16} />
          </button>
        </div>
      )}
      {!collapsed && (
        <div className="bw-home-dots" aria-hidden="true">
          {items.map((it, n) => (
            <span key={it.key} className={n === i ? 'on' : ''} />
          ))}
        </div>
      )}
    </section>
  );
};

export default StoreShowcase;
