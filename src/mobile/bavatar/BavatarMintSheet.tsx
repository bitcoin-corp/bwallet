import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink } from 'lucide-react';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { MintHero } from '../../components/approval/ApprovalHeroes';
import { useBackClose } from '../backStack';
import { useServiceContext } from '../../hooks/useServiceContext';
import type { BavatarMine } from '../chat/api';
import { svgDataUri } from '../wallet/cardBackQr';
import { PrivacyChoice } from '../private/PrivacyChoice';
import {
  bavatarClient,
  bavatarLabel,
  bavatarNumber,
  bavatarMintSvg,
  FOUNDING,
  mintBavatar,
  mintOffer,
} from './mintBavatar';

type State =
  | { k: 'loading' }
  | { k: 'error'; msg: string }
  | { k: 'ready'; mine: BavatarMine }
  | { k: 'minting'; mine: BavatarMine }
  | { k: 'done'; mine: BavatarMine; txid: string };

/**
 * "Mint my bAvatar" (owner, 11 Oct 2026). One sheet: the preview, what it is, what it costs, one Mint
 * button. This sheet is the confirmation (one-sheet rule): pressing Mint inscribes, nothing else pops up.
 * Founding 1,000 (#1–#1,000): bWalletX pays the network fee. After that: the user pays it, ~4,000 sats.
 */
export default function BavatarMintSheet({ onClose }: { onClose: () => void }) {
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const identityKey = account?.pubKeys?.identityPubKey ?? '';
  const payAddress = account?.addresses?.bsvAddress ?? '';
  const [state, setState] = useState<State>({ k: 'loading' });
  const [details, setDetails] = useState(false);

  useBackClose(true, onClose);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const mine = await (await bavatarClient(apiContext)).bavatarMine();
        if (!live) return;
        setState(mine.minted ? { k: 'done', mine, txid: mine.minted.txid } : { k: 'ready', mine });
      } catch (e) {
        if (live) setState({ k: 'error', msg: e instanceof Error ? e.message : 'Could not load your number' });
      }
    })();
    return () => {
      live = false;
    };
  }, [apiContext]);

  const mine = state.k === 'ready' || state.k === 'minting' || state.k === 'done' ? state.mine : null;
  const preview = useMemo(
    () => (mine ? svgDataUri(bavatarMintSvg(identityKey, mine.handle, mine.number)) : ''),
    [mine, identityKey],
  );
  const offer = mine ? mintOffer(mine) : null;

  const [makePublic, setMakePublic] = useState(false);
  const mint = async () => {
    if (state.k !== 'ready') return;
    const m = state.mine;
    setState({ k: 'minting', mine: m });
    try {
      const txid = await mintBavatar(apiContext, { identityKey, payAddress, mine: m, private: !makePublic });
      setState({ k: 'done', mine: m, txid });
    } catch (e) {
      setState({ k: 'error', msg: e instanceof Error ? e.message : 'Mint failed' });
    }
  };

  const num = mine ? bavatarNumber(mine.number) : undefined;
  const founding = !!mine?.founding && !!mine && mine.number <= FOUNDING;
  const busy = state.k === 'minting';

  return createPortal(
    <div
      className="fixed inset-0 z-[420] flex flex-col"
      style={{
        background: CARD.bg,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <ApprovalCard
        ours
        site="bWalletX"
        siteSub={founding ? 'Founding 1,000' : 'Your bAvatar'}
        onClose={onClose}
        closeLabel="Close"
        hero={
          <MintHero
            image={preview || undefined}
            alt={mine ? bavatarLabel(mine.handle, mine.number) : 'Your bAvatar'}
            number={num}
          />
        }
        title={
          <>
            {state.k === 'done' ? 'Minted your ' : 'Mint your '}
            <span style={{ color: CARD.gold }}>bAvatar</span>
          </>
        }
        primary={
          state.k === 'ready' || state.k === 'minting'
            ? {
                label: busy ? 'Minting…' : `Mint ${num ?? ''}`.trim(),
                onClick: () => void mint(),
                disabled: busy || !preview,
                busy,
              }
            : undefined
        }
        secondary={state.k === 'done' ? undefined : { label: 'Not now', onClick: onClose, disabled: busy }}
        details={
          mine ? (
            <span>
              {makePublic
                ? 'Public: your bAvatar art, your name and your number, inscribed as a 1-sat ordinal anyone can see. The QR opens your paymail. Send it on and the art and number go with it; your account stays yours.'
                : 'Private: your bAvatar is encrypted with your own keys before it goes on chain, so only you can see it. You can reveal it later from bMint › Your vault.'}
            </span>
          ) : undefined
        }
        detailsOpen={details}
        onToggleDetails={() => setDetails(!details)}
        error={state.k === 'error' ? state.msg : undefined}
      >
        {state.k === 'loading' && (
          <p className="m-0" style={{ color: CARD.muted }}>
            Looking up your number…
          </p>
        )}
        {mine && (
          <>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{bavatarLabel(mine.handle, mine.number)}</div>
            {!preview && (
              <p className="m-0" style={{ fontSize: 14, color: CARD.muted }}>
                Claim a $name first: your bAvatar carries it.
              </p>
            )}
            {state.k !== 'done' && <PrivacyChoice isPublic={makePublic} onChange={setMakePublic} />}
            <div className="flex flex-wrap" style={{ gap: 8 }}>
              {offer?.kind === 'free' && <Chip solid>FREE</Chip>}
              {offer?.kind === 'paid' && <Chip>Network fee ~4,000 sats</Chip>}
              <Chip>
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={CARD.gold}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <path d="M9 9h2v2H9zM13 13h2v2h-2z" />
                </svg>
                Scans to your paymail
              </Chip>
              <Chip>{makePublic ? 'Public' : 'Private: only you'}</Chip>
              <Chip>Yours forever</Chip>
            </div>
            {state.k === 'done' && (
              <a
                href={`https://whatsonchain.com/tx/${state.txid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 font-bold"
                style={{ color: CARD.gold, minHeight: 44 }}
              >
                Minted: view on chain <ExternalLink size={14} />
              </a>
            )}
          </>
        )}
      </ApprovalCard>
    </div>,
    document.body,
  );
}
