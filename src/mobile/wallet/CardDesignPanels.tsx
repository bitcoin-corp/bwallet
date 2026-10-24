import { useWithoutHidden } from '../albums/useAlbums';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Check, Lock } from 'lucide-react';
import { ACCENTS, accentById, type AccentId } from '../theme/accents';
import { PATTERNS, patternUri } from './cardPatterns';
import type { CardDesign, SubFeed } from './cardDesign';
import { loadCardArt, type CardArtModule } from './cardArtLoader';
import { ownsPack } from './cardPacks';
import { heldTokenSymbols } from '../wide/walletFeed';
import { useWalletMedia } from '../media/useWalletMedia';

/** Design your card › Patterns: drawn in code, following the theme colour by default. */
export function PatternsPanel({
  design,
  accentId,
  onDesign,
}: {
  design: CardDesign | null;
  accentId: AccentId;
  onDesign: (d: CardDesign) => void;
}) {
  const cur = design?.kind === 'pattern' ? design : null;
  const [follow, setFollow] = useState(cur ? cur.follow : true);
  const [colour, setColour] = useState<AccentId>(cur?.colour ?? accentId);
  const shown = follow ? accentById(accentId).accent : accentById(colour).accent;
  const themePattern = accentById(accentId).pattern;
  const ordered = [...PATTERNS].sort((a, b) => (a.id === themePattern ? -1 : b.id === themePattern ? 1 : 0));
  const pick = (id: (typeof PATTERNS)[number]['id'], f = follow, c = colour) =>
    onDesign({ kind: 'pattern', id, follow: f, ...(f ? {} : { colour: c }) });
  return (
    <div className="bw-cdes-panel">
      <label className="bw-cdes-toggle">
        <input
          type="checkbox"
          checked={follow}
          onChange={(e) => {
            setFollow(e.target.checked);
            if (cur) pick(cur.id, e.target.checked);
          }}
        />
        Follow theme colour
      </label>
      {!follow && (
        <div className="bw-cdes-colours" role="radiogroup" aria-label="Pattern colour">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={colour === a.id}
              aria-label={a.label}
              className={colour === a.id ? 'is-on' : ''}
              style={{ background: a.accent }}
              onClick={() => {
                setColour(a.id);
                if (cur) pick(cur.id, false, a.id);
              }}
            />
          ))}
        </div>
      )}
      <div className="bw-cdes-grid">
        {ordered.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`bw-cdes-tile${cur?.id === p.id ? ' is-on' : ''}`}
            aria-pressed={cur?.id === p.id}
            onClick={() => pick(p.id)}
          >
            <img src={patternUri(p.id, shown)} alt="" draggable={false} />
            <span>
              {p.label}
              {p.id === themePattern ? ' · theme' : ''}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

const useArt = () => {
  const [mod, setMod] = useState<CardArtModule | null>(null);
  useEffect(() => {
    void loadCardArt().then(setMod);
  }, []);
  return mod;
};

/** Design your card › Art: public-domain works (The Met, CC0), credited. Never recoloured by the theme. */
export function ArtPanel({ design, onDesign }: { design: CardDesign | null; onDesign: (d: CardDesign) => void }) {
  const mod = useArt();
  if (!mod) return <p className="bw-cdes-empty">Loading art…</p>;
  const sel = design?.kind === 'art' ? design.id : null;
  const cur = mod.PD_ART.find((a) => a.id === sel);
  return (
    <div className="bw-cdes-panel">
      <div className="bw-cdes-grid">
        {mod.PD_ART.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`bw-cdes-tile${sel === a.id ? ' is-on' : ''}`}
            aria-pressed={sel === a.id}
            onClick={() => onDesign({ kind: 'art', id: a.id })}
          >
            <img src={a.src} alt="" loading="lazy" draggable={false} />
            <span>
              {a.artist.split(' ').slice(-1)[0]} · {a.title}
            </span>
          </button>
        ))}
      </div>
      <p className="bw-cdes-note">
        {cur ? mod.artCreditLine(cur) : 'Public-domain works from The Met’s Open Access collection (CC0).'}
      </p>
    </div>
  );
}

/** Design your card › Collections: our own art packs, unlocked by what this wallet holds. */
export function CollectionsPanel({
  design,
  onDesign,
}: {
  design: CardDesign | null;
  onDesign: (d: CardDesign) => void;
}) {
  const mod = useArt();
  // The wallet's own NFT list (same source as My NFTs): names unlock packs, no extra lookups.
  const { items: shownRaw } = useWalletMedia();
  const nfts = useWithoutHidden(shownRaw);
  const navigate = useNavigate();
  const holdings = useMemo(() => ({ tokens: heldTokenSymbols(), nftNames: nfts.map((n) => n.name) }), [nfts]);
  if (!mod) return <p className="bw-cdes-empty">Loading collections…</p>;
  return (
    <div className="bw-cdes-panel">
      {mod.PACKS.map((p) => {
        const owned = ownsPack(p.id, holdings);
        return (
          <section key={p.id} className="bw-cdes-pack">
            <h4>
              {p.name}
              {!owned && (
                <button type="button" className="bw-cdes-unlock" onClick={() => navigate(p.getAt)}>
                  <Lock size={12} aria-hidden="true" /> {p.unlock}
                </button>
              )}
            </h4>
            <div className="bw-cdes-grid">
              {p.items.map((it) => {
                const on = design?.kind === 'pack' && design.pack === p.id && design.id === it.id;
                return (
                  <button
                    key={it.id}
                    type="button"
                    className={`bw-cdes-tile${on ? ' is-on' : ''}${owned ? '' : ' is-locked'}`}
                    aria-pressed={on}
                    aria-label={owned ? it.title : `${it.title}. ${p.unlock}`}
                    onClick={() => (owned ? onDesign({ kind: 'pack', pack: p.id, id: it.id }) : navigate(p.getAt))}
                  >
                    <img src={it.src} alt="" loading="lazy" draggable={false} />
                    <span>{it.title}</span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** MOCK (owner, 14 Oct 2026): card-art subscriptions. Nothing is paid; marked as a demo throughout. */
export function SubscribePanel({ design, onDesign }: { design: CardDesign | null; onDesign: (d: CardDesign) => void }) {
  const mod = useArt();
  const [confirm, setConfirm] = useState<SubFeed | null>(null);
  if (!mod) return <p className="bw-cdes-empty">Loading…</p>;
  const sub = design?.kind === 'sub' ? design : null;
  return (
    <div className="bw-cdes-panel">
      <p className="bw-cdes-mock">Demo · no money moves</p>
      {mod.SUB_FEEDS.map((f) => {
        const active = sub?.active && sub.feed === f.id;
        return (
          <section key={f.id} className="bw-cdes-pack">
            <h4>
              {f.name}
              <small>1p a week · goes to the featured artists</small>
            </h4>
            <div className="bw-cdes-strip" aria-label={`${f.name} example weekly picks`}>
              {f.picks.map((p, i) => (
                <figure key={i}>
                  <img src={p.src} alt="" loading="lazy" draggable={false} />
                  <figcaption>Example</figcaption>
                </figure>
              ))}
            </div>
            {active && sub ? (
              <div className="bw-cdes-subrow">
                <span>
                  <Check size={14} aria-hidden="true" /> Subscribed · paid so far {sub.paid}p
                </span>
                <button type="button" onClick={() => onDesign({ ...sub, week: sub.week + 1, paid: sub.paid + 1 })}>
                  Next week (demo)
                </button>
                <button type="button" onClick={() => onDesign({ ...sub, active: false })}>
                  Stop
                </button>
              </div>
            ) : (
              <button type="button" className="bw-cdes-pick" onClick={() => setConfirm(f.id)}>
                Subscribe · 1p/week
              </button>
            )}
          </section>
        );
      })}
      {confirm &&
        createPortal(
          <div className="bw-cdes-confirm" role="dialog" aria-modal="true" aria-label="Confirm subscription">
            <div>
              <p className="bw-cdes-mock">Demo</p>
              <p>Pay 1p a week from your Subscriptions pot to the featured artists. Stop any time.</p>
              <div className="bw-cdes-actions">
                <button type="button" className="bw-cdes-reset" onClick={() => setConfirm(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="bw-cdes-done"
                  onClick={() => {
                    onDesign({ kind: 'sub', feed: confirm, week: 0, paid: 1, active: true });
                    setConfirm(null);
                  }}
                >
                  Confirm
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
