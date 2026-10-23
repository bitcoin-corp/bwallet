import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Flame, X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useIdentity } from '../../hooks/useIdentity';
import { cachedExchangeRate } from '../../utils/wallet';
import { ErrorNotice } from '../errors/ErrorActions';
import { notifyAvatarChange, toAvatarUri } from '../names/avatar';
import {
  buildMeltTx,
  checkQuote,
  commitMelt,
  elementLabel,
  elementUrl,
  getQuote,
  MeltNotOpenError,
  MeltRefusedError,
  pollMelt,
  quoteReady,
  recipientPubkey,
  releaseMelt,
  signChallenge,
  splitAvatar,
  type MeltQuote,
  type MeltStatus,
} from '../../sweep/npgMelt';
import type { IdentifiedJig } from '../../sweep/runIdentify';

/**
 * "Melt into element cards" for one identified NPG (owner, 17 Oct 2026). One approval sheet, drawn like a share
 * card: her cut-out, the element cards she becomes, "This NFT will be destroyed", the fees. Allow builds the burn
 * transaction here (sweep/npgMelt.ts), NPG broadcasts it and mints the cards into Collectibles.
 */
type Phase =
  | { k: 'idle' }
  | { k: 'quoting' }
  | { k: 'sheet'; q: MeltQuote }
  | { k: 'working'; q: MeltQuote; step: string }
  | { k: 'done'; q: MeltQuote; s: MeltStatus }
  | { k: 'soon' }
  | { k: 'error'; msg: string; q?: MeltQuote };

const PINK = '#FF2E93';
const usd = (sats: number) => {
  const rate = cachedExchangeRate();
  return rate ? `$${((sats / 1e8) * rate).toFixed(2)}` : '';
};

export function NpgMelt({
  jig,
  wif,
  art,
  size = 'sm',
}: {
  jig: IdentifiedJig;
  wif: string;
  art?: string;
  /** lg: the full-width primary action on the RelayX recovery detail sheet. */
  size?: 'sm' | 'lg';
}) {
  const { apiContext, chromeStorageService } = useServiceContext();
  const identity = useIdentity(apiContext, chromeStorageService);
  const [p, setP] = useState<Phase>({ k: 'idle' });
  const [avatarMsg, setAvatarMsg] = useState('');

  const start = async () => {
    setP({ k: 'quoting' });
    try {
      const q = await getQuote(fetch, {
        jig_location: jig.location,
        jig_origin: jig.origin,
        recipient_pubkey: await recipientPubkey(apiContext),
      });
      const bad = checkQuote(q, jig.location, jig.origin);
      if (bad) throw new Error(bad);
      // Not open for commits yet: say so, build and sign nothing (owner rule: no pretend flows).
      if (!quoteReady(q)) return setP({ k: 'soon' });
      setP({ k: 'sheet', q });
    } catch (e) {
      if (e instanceof MeltNotOpenError) setP({ k: 'soon' });
      else setP({ k: 'error', msg: e instanceof Error ? e.message : String(e) });
    }
  };

  const allow = async (q: MeltQuote) => {
    if (!apiContext.services)
      return setP({ k: 'error', msg: 'Wallet services are not ready yet. Try again in a moment.', q });
    let reference = '';
    try {
      setP({ k: 'working', q, step: 'Signing…' });
      const built = await buildMeltTx(apiContext.wallet, apiContext.services, q, { location: jig.location, wif });
      reference = built.reference;
      setP({ k: 'working', q, step: 'Sending to NPG…' });
      await commitMelt(fetch, { quote_id: q.quote_id, rawtx_ef: built.ef, signature: signChallenge(q.challenge, wif) });
      setP({ k: 'working', q, step: 'Minting your element cards…' });
      const s = await pollMelt(fetch, q.quote_id, (st) =>
        setP({
          k: 'working',
          q,
          step: st.status === 'burned' ? 'Burned. Minting your element cards…' : 'Minting your element cards…',
        }),
      );
      if (s.status === 'failed') throw new Error(s.error || 'NPG could not mint the cards.');
      setP({ k: 'done', q, s });
    } catch (e) {
      // Free the wallet's inputs only when NPG refused cleanly (4xx): it may have broadcast otherwise.
      if (reference && e instanceof MeltRefusedError) await releaseMelt(apiContext.wallet, reference);
      setP({ k: 'error', msg: e instanceof Error ? e.message : String(e), q });
    }
  };

  const setAvatar = async (s: MeltStatus, file: string) => {
    const a = s.elements?.find((e) => e.file === file);
    if (!a) return;
    setAvatarMsg('Setting…');
    const res = await identity.saveProfile({
      name: identity.profile.name,
      image: toAvatarUri(a.outpoint),
      description: identity.profile.description,
    });
    if (res.error) return setAvatarMsg(res.error);
    notifyAvatarChange();
    setAvatarMsg('She is your avatar now.');
  };

  const button = (
    <button
      type="button"
      onClick={() => void start()}
      disabled={p.k === 'quoting'}
      className={
        size === 'lg'
          ? 'w-full h-12 rounded-xl border-0 text-[15px] font-semibold cursor-pointer inline-flex items-center justify-center gap-2 transition-[transform,filter] duration-150 ease-out active:scale-[0.98] hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-60'
          : 'shrink-0 rounded-lg border-0 px-2.5 py-1.5 text-[11px] font-bold cursor-pointer inline-flex items-center gap-1'
      }
      style={{ background: PINK, color: '#000' }}
    >
      <Flame size={size === 'lg' ? 17 : 12} />{' '}
      {p.k === 'quoting' ? 'Checking the price…' : size === 'lg' ? 'Melt into element cards' : 'Melt'}
    </button>
  );

  if (p.k === 'idle' || p.k === 'quoting') return button;
  if (p.k === 'soon')
    return (
      <span
        className={size === 'lg' ? 'block w-full text-center text-sm py-3 rounded-xl' : 'shrink-0 text-[11px]'}
        style={{ color: '#B6C8F5', border: size === 'lg' ? '1px solid rgb(255 255 255 / 0.08)' : undefined }}
      >
        Melting opens soon
      </span>
    );

  const q = 'q' in p ? p.q : undefined;
  const parts = q ? splitAvatar(q) : { cards: [], avatar: undefined };
  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center"
      style={{ background: 'rgb(0 0 0 / 0.7)' }}
    >
      <div
        role="dialog"
        aria-label={`Melt ${jig.title}`}
        className="w-full max-w-[440px] max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl p-5 flex flex-col gap-4"
        style={{ background: '#0B0509', border: `1px solid ${PINK}55` }}
      >
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold tracking-widest" style={{ color: PINK }}>
            MELT INTO ELEMENT CARDS
          </span>
          {p.k !== 'working' && (
            <button
              type="button"
              aria-label="Close"
              onClick={() => setP({ k: 'idle' })}
              className="border-0 bg-transparent cursor-pointer text-white"
            >
              <X size={18} />
            </button>
          )}
        </div>

        {/* The card that sells Allow: her, big, then what she becomes. */}
        <div
          className="rounded-2xl p-4 flex gap-4 items-center"
          style={{ background: `radial-gradient(circle at 30% 20%, ${PINK}33, #12060D)` }}
        >
          {art && <img src={art} alt="" className="h-36 w-auto" style={{ objectFit: 'contain' }} />}
          <div className="flex flex-col gap-1 min-w-0">
            <span className="text-lg font-extrabold text-white">{q?.name ?? jig.title}</span>
            <span className="text-xs" style={{ color: '#F7A8CF' }}>
              {jig.title} · Series {q?.series ?? ''}
            </span>
            <span className="text-xs text-white">
              Becomes {parts.cards.length} element card{parts.cards.length === 1 ? '' : 's'}
              {parts.avatar ? ' + her avatar badge' : ''}
            </span>
          </div>
        </div>

        {!!parts.cards.length && (
          <div className="grid grid-cols-5 gap-1.5">
            {parts.cards.map((e) => (
              <figure key={e.file} className="m-0 flex flex-col gap-1">
                <div className="aspect-[2/3] rounded-lg overflow-hidden" style={{ background: '#1C0A15' }}>
                  {/* Each part is a full 961×1441 layer: contain keeps it whole, as it sits on her card. */}
                  <img
                    src={elementUrl(e.file)}
                    alt={elementLabel(e)}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full"
                    style={{ objectFit: 'contain', filter: e.hue ? `hue-rotate(${e.hue}deg)` : undefined }}
                  />
                </div>
                <figcaption
                  className="overflow-hidden text-ellipsis whitespace-nowrap text-center text-[10px] capitalize"
                  style={{ color: '#C9A3B8' }}
                >
                  {elementLabel(e)}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
        {parts.avatar && (
          <div className="flex items-center gap-2 text-xs text-white">
            <img src={elementUrl(parts.avatar.file)} alt="" className="w-9 h-9 rounded-full" />+ her avatar badge
          </div>
        )}

        {q && (
          <ul className="m-0 p-0 list-none flex flex-col gap-1.5 text-xs text-white">
            <li className="text-[13px] leading-snug">
              <b>What happens:</b> her old RelayX NFT (a Run token) is destroyed, and each of her parts is minted fresh
              as a <b>1Sat Ordinal</b>, the NFT standard bWalletX and today&apos;s BSV wallets use.
            </li>
            <li style={{ color: '#FF8A80' }}>
              <b>The RelayX NFT will be destroyed</b> (burned on chain). It can&apos;t be undone.
            </li>
            {q.note && <li style={{ color: '#F7A8CF' }}>{q.note}</li>}
            {q.fee_sats > 0 ? (
              <li>
                Minting fees: {q.fee_sats.toLocaleString()} sats
                {usd(q.fee_sats) ? ` (${usd(q.fee_sats)})` : ''} to NPG at{' '}
                <span className="font-mono break-all">{q.fee_to}</span>, plus a few sats for the network
              </li>
            ) : (
              <li>No melt or minting fee. You pay only a few sats for the network.</li>
            )}
            <li>The new 1Sat Ordinals arrive in Collectibles.</li>
          </ul>
        )}

        {p.k === 'sheet' && (
          <button
            type="button"
            onClick={() => void allow(p.q)}
            className="w-full rounded-xl border-0 py-3 text-sm font-extrabold cursor-pointer"
            style={{ background: PINK, color: '#000' }}
          >
            Allow: melt {jig.title}
          </button>
        )}
        {p.k === 'working' && <p className="m-0 text-sm text-center text-white">{p.step}</p>}
        {p.k === 'done' && (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-sm font-bold text-white">
              {p.s.status === 'done'
                ? 'Your element cards are in Collectibles.'
                : 'Burned. NPG is still minting: check Collectibles in a few minutes.'}
            </p>
            {!!p.s.elements?.length && (
              <p className="m-0 text-[12px]" style={{ color: '#F7A8CF' }}>
                {/* Labels, not raw file names (owner, 17 Oct 2026). */}
                Minted as 1Sat Ordinals:{' '}
                {p.s.elements
                  .map((e) =>
                    e.outpoint && /\.webp$/.test(e.file) ? 'her avatar badge' : elementLabel({ file: e.file }),
                  )
                  .join(' · ')}
              </p>
            )}
            {p.s.status === 'done' && parts.avatar && (
              <button
                type="button"
                onClick={() => void setAvatar(p.s, parts.avatar!.file)}
                className="rounded-xl border-0 py-2.5 text-sm font-bold cursor-pointer"
                style={{ background: '#fff', color: '#000' }}
              >
                Use her as your avatar?
              </button>
            )}
            {avatarMsg && <p className="m-0 text-xs text-white">{avatarMsg}</p>}
          </div>
        )}
        {p.k === 'error' && <ErrorNotice message={p.msg} />}
      </div>
    </div>,
    document.body,
  );
}
