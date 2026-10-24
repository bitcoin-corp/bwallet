import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import validate from 'bitcoin-address-validation';
import { sendOrdinals } from '@1sat/actions';
import { readAssetIdTag } from '@1sat/types';
import { Copy, Flame, Send, UserCircle, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { NftHeader, NftHero, PendingCard } from './NftHero';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import type { ChromeStorageObject } from '../../services/types/chromeStorage.types';
import { getTagValue } from '../../utils/format';
import { getErrorMessage } from '../../utils/tools';
import { NameInput } from '../names/NameInput';
import type { WalletInterface } from '@bsv/sdk';
import { sendMail } from '../bmail/client';
import { receiptTags } from '../bmail/ordinalReceipt';
import {
  defaultKeyMode,
  encryptNoteForKey,
  NOTE_MAX,
  noteMap,
  saveSentKeyNote,
  shortKey,
  type KeyMode,
} from '../names/pubkeyRecipient';
import { setLocalAvatar } from '../names/avatar';
import { nftAvatarUri, normalizeOutpoint, ordinalsUrl } from './nftActions';
import type { MediaItem } from './useWalletMedia';
import { TipButton } from '../tip/TipButton';
import { nftCreator } from '../tip/tip';
import { celebrateSend } from '../../components/sent/sent';
import {
  canUseAsAvatar,
  isSelfRecipient,
  nftSendButton,
  PENDING_CARD_TEXT,
  PENDING_SEND_TEXT,
  shortAddr,
} from './nftSend';
import { txidOf, walletTxStates } from './unbroadcast';
import { STORE_BUILD } from '../storeBuild';
import { ReceiptBadge } from '../storeReceipt/ReceiptBadge';
import { isStoreReceipt } from '../storeReceipt/receipt';
import {
  BURN_HOLD_MS,
  BURN_WORD,
  burnAvailability,
  burnConfirmEnabled,
  burnNft,
  copiesOf,
  isListed,
  isLocked,
  shortOutpoint,
  toUnderscore,
} from './nftBurn';

const PENDING_RECHECK_MS = 4000;
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';
const short = (s: string) => (s.length > 22 ? `${s.slice(0, 10)}…${s.slice(-8)}` : s);

/**
 * Wallet › NFTs detail: big viewer, name / collection / origin, and actions:
 * Use as my bAvatar (any image NFT you hold, cards you were sent too: account icon = 1sat://<origin>, as AccountIconField does for a pasted NFT id),
 * Send (sendOrdinals, like upstream's Ordinals manager, to an address / $handle / paymail).
 * Listing an NFT for sale is not offered: OrdLock listing creation is disabled for ordinals
 * (ORDLOCK_LISTING_DISABLED); bWallet's Sell covers BSV-21 only. Portalled like MediaViewer.
 */
export const NftDetail = ({
  item,
  all = [],
  onClose,
  onSent,
  initialTo = '',
  isCard = false,
}: {
  /** A just-made greeting card (CardSend): the pending note says "Your card…". */
  isCard?: boolean;
  item: MediaItem;
  /** Recipient to fill in (Friends › Send NFT): the name box still resolves it and Send to … still confirms. */
  initialTo?: string;
  /** Everything the wallet holds, for the copies / last-copy check before a burn. */
  all?: MediaItem[];
  onClose: () => void;
  onSent: () => void;
}) => {
  useBackClose(true, onClose);
  const { apiContext, chromeStorageService } = useServiceContext();
  const { theme } = useTheme();
  const origin = normalizeOutpoint(item.origin) || normalizeOutpoint(item.output.outpoint);
  const collection = getTagValue(item.output.tags, 'collection') || getTagValue(item.output.tags, 'collectionId');
  const link = ordinalsUrl(origin);
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [to, setTo] = useState('');
  // Set after mount so the name box treats it as typed and resolves it (NameInput's outside-value path).
  useEffect(() => {
    if (initialTo) setTo(initialTo);
  }, [initialTo]);
  const [busy, setBusy] = useState(false);
  // Step 1 (who): what the name box resolved. Step 2: one "Send to <name>" button (nftSend.ts).
  const [status, setStatus] = useState<'empty' | 'typing' | 'loading' | 'error' | 'ready'>('empty');
  const [toName, setToName] = useState<string | undefined>();
  const [toKeys, setToKeys] = useState<{ pubkey?: string; ordAddress?: string }>({});
  // Send to a public key (24 Oct 2026): the key as typed, how to deliver, and an optional encrypted note.
  const [toKey, setToKey] = useState<{ raw: string; pubkey: string; address: string } | null>(null);
  const [keyMode, setKeyMode] = useState<KeyMode>('plain');
  const [note, setNote] = useState('');
  const [sent, setSent] = useState<{ txid: string; name: string } | null>(null);
  const [failed, setFailed] = useState('');
  // An NFT from a mint the network never saw can't be sent (vexvoid, 11 Oct 2026: every try failed and hid it).
  const [onChain, setOnChain] = useState<boolean | null>(item.pending ? false : null);
  // Queued but not on chain yet ('sending'): pending, not owned; can't be sent or burned until it lands.
  const [pending, setPending] = useState(!!item.pending);
  // While it is still going out, look again every few seconds: Send unlocks by itself once it lands.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const txid = txidOf(item.output.outpoint);
    const check = () =>
      void walletTxStates(apiContext.wallet)
        .then((st) => {
          if (!live) return;
          const still = st.pending.has(txid);
          setPending(still);
          setOnChain(!st.offChain.has(txid) && !still);
          if (still) timer = setTimeout(check, PENDING_RECHECK_MS);
        })
        .catch(() => live && setOnChain(null));
    check();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [apiContext.wallet, item.output.outpoint]);

  // Burn (nftBurn.ts): offered only for on-chain, unlisted, unlocked items; confirm by typing BURN or a 2 s hold.
  const [burning, setBurning] = useState(false);
  const [typed, setTyped] = useState('');
  const [held, setHeld] = useState(false);
  const [burnBusy, setBurnBusy] = useState(false);
  const [burnErr, setBurnErr] = useState('');
  const [burned, setBurned] = useState('');
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outpoint = toUnderscore(item.output.outpoint);
  const copies = copiesOf(item, all);
  const burnable = burnAvailability({ onChain, listed: isListed(item.output), locked: isLocked(item.output) });
  const startHold = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = setTimeout(() => setHeld(true), BURN_HOLD_MS);
  };
  const endHold = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  };
  useEffect(() => endHold, []);
  const canBurn = burnConfirmEnabled({ typed, held, busy: burnBusy, done: !!burned });
  const burn = async () => {
    if (!canBurn) return;
    setBurnBusy(true);
    setBurnErr('');
    try {
      const r = await burnNft(apiContext, item.output);
      if ('error' in r) return setBurnErr(r.error);
      setBurned(r.txid);
      setBurning(false);
      onSent();
    } catch (e) {
      setBurnErr(`Not confirmed: ${e instanceof Error ? e.message : String(e)}. Check History before burning again.`);
    } finally {
      setBurnBusy(false);
      setHeld(false);
    }
  };
  const copyOutpoint = async () => {
    try {
      await navigator.clipboard.writeText(outpoint);
      setMsg('Outpoint copied');
    } catch {
      setMsg(outpoint);
    }
  };

  const setAvatar = async () => {
    const uri = nftAvatarUri(origin);
    const account = chromeStorageService.getCurrentAccountObject().account;
    const id = account?.addresses?.identityAddress;
    if (!uri || !account || !id) return setMsg("Couldn't set the avatar.");
    try {
      const key: keyof ChromeStorageObject = 'accounts';
      await chromeStorageService.updateNested(key, { [id]: { ...account, icon: uri } } as Partial<
        ChromeStorageObject['accounts']
      >);
      // A photo picked on this phone wins over the account icon: clear it (this also fires notifyAvatarChange).
      setLocalAvatar(id, '');
      setMsg('This NFT is now your bAvatar.');
    } catch {
      setMsg("Couldn't set the avatar.");
    }
  };

  const send = async () => {
    const assetId = readAssetIdTag(item.output.tags);
    if (!assetId) return setFailed('This NFT is missing a tracking id and cannot be sent yet. Try Refresh.');
    setBusy(true);
    setFailed('');
    try {
      const viaWallet = !!toKey && keyMode === 'wallet';
      const memo = note.trim().slice(0, NOTE_MAX);
      const transfer = !toKey
        ? { id: assetId, address: to }
        : viaWallet
          ? { id: assetId, counterparty: toKey.pubkey }
          : {
              id: assetId,
              address: toKey.address,
              ...(memo ? { map: noteMap(encryptNoteForKey(memo, toKey.raw)) } : {}),
            };
      const res = await sendOrdinals.execute(apiContext, { transfers: [transfer] });
      if (!res.txid || res.error) {
        // Known codes keep their wording; anything else shows the real message, never a bare "unknown error, try
        // again" (vexvoid, 12 Oct 2026: that hid why sends failed and invited repeats).
        const known = getErrorMessage(res.error);
        throw new Error(
          known.startsWith('An unknown error')
            ? `Not sent: ${String(res.error || 'the wallet returned no transaction')}. Check History before sending again.`
            : known,
        );
      }
      if (toKey) {
        if (viaWallet) {
          // The derivation details (and note, BRC-2 to the identity key) go as a bMail so their wallet can read it.
          try {
            await sendMail(apiContext.wallet as unknown as WalletInterface, {
              to: toKey.pubkey,
              toLabel: toName ?? shortKey(toKey.raw),
              sealed: {
                subject: `An NFT for you: ${item.name}`.slice(0, 120),
                body: memo || `${item.name} is on its way to your wallet.`,
                ordinal: {
                  txid: res.txid,
                  deliveries: res.deliveries ?? [],
                  name: item.name,
                  tags: receiptTags(item.output.tags),
                },
              },
              sats: 0,
              replyPaidSats: 0,
            });
          } catch (e) {
            console.warn('[send to key] NFT sent; the delivery letter did not go', e);
          }
        }
        if (memo)
          saveSentKeyNote({
            at: Date.now(),
            key: toKey.raw,
            address: toKey.address,
            mode: keyMode,
            txid: res.txid,
            note: memo,
          });
      }
      const name = toName && toName !== to ? toName : shortAddr(to);
      setSent({ txid: res.txid, name });
      celebrateSend(res, { amount: { kind: 'nft', count: 1, name: item.name }, recipients: [to] });
      setSending(false);
      onSent();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'Not sent. Check History before sending again.');
    } finally {
      setBusy(false);
    }
  };

  const validTo = !!to && validate(to);
  const account = chromeStorageService.getCurrentAccountObject().account;
  const isSelf =
    status === 'ready' &&
    isSelfRecipient(
      { to, ...toKeys },
      {
        identityPubKey: account?.pubKeys?.identityPubKey,
        addresses: [
          account?.addresses?.bsvAddress,
          account?.addresses?.ordAddress,
          account?.addresses?.identityAddress,
        ].filter((a): a is string => !!a),
      },
    );
  const button = nftSendButton({ to: validTo ? to : '', name: toName, status, busy, onChain, isSelf, pending });
  const btn = 'flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold';

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-black overflow-y-auto"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="relative">
        <NftHero m={item} pending={pending} />
        <button
          aria-label="Close"
          onClick={onClose}
          className="absolute top-3 right-3 z-10 h-9 w-9 flex items-center justify-center rounded-full bg-black/60 backdrop-blur"
        >
          <X size={18} color="#fff" />
        </button>
      </div>

      <div className="px-4 py-4 flex flex-col gap-3">
        <NftHeader
          name={item.name}
          collection={collection ? `Collection ${short(collection)}` : undefined}
          contentType={item.type}
          status={pending ? 'pending' : isListed(item.output) ? 'listed' : onChain ? 'onchain' : 'checking'}
          origin={origin}
          chainLink={link || undefined}
        />
        {/* Theme-store receipts: not in the App Store / Play edition (store audit, docs/STORE-AUDIT.md). */}
        {!STORE_BUILD && isStoreReceipt(item.output.tags) && <ReceiptBadge txid={txidOf(item.output.outpoint)} />}
        {nftCreator(item.output.tags) && (
          <TipButton
            to={nftCreator(item.output.tags)!}
            context={{ kind: 'nft', outpoint: origin }}
            className="self-start"
          />
        )}
        {/* Only while it is still ours: not after a send or burn, nor while the mint is still going out. */}
        {canUseAsAvatar(item.kind, { sent: !!sent, burned: !!burned, pending }) && (
          <button onClick={() => void setAvatar()} className={`${btn} bg-[#A1FF8B] text-[#010101]`}>
            <UserCircle size={16} /> Use as my bAvatar
          </button>
        )}
        {burned || burning ? null : sent ? (
          <div className="flex flex-col gap-1 rounded-xl bg-[var(--bw-surface)] p-3">
            <span className="text-sm font-semibold text-[#A1FF8B]">Sent to {sent.name}</span>
            <a
              href={`https://whatsonchain.com/tx/${sent.txid}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-[#98A2B3] underline break-all"
            >
              {short(sent.txid)}
            </a>
          </div>
        ) : pending ? (
          <>
            <PendingCard />
            <p className="text-xs text-[#e6d08a] m-0">{isCard ? PENDING_CARD_TEXT : PENDING_SEND_TEXT}</p>
          </>
        ) : onChain === false ? (
          <div className="rounded-xl bg-[var(--bw-surface)] p-3 text-xs text-[color:var(--bw-accent)]">
            Not on the blockchain yet. This NFT&apos;s mint never reached the network, so it can&apos;t be sent or
            burned. Nothing on chain needs burning.
          </div>
        ) : !sending ? (
          <button
            onClick={() => setSending(true)}
            className={`${btn} text-[#010101]`}
            style={{ background: 'var(--bw-accent)' }}
          >
            <Send size={16} /> Send
          </button>
        ) : (
          <div className="flex flex-col gap-2 rounded-xl bg-[var(--bw-surface)] p-3">
            <div className="text-xs font-semibold text-[#98A2B3]">
              Who gets it? A $name, paymail, address or any public key
            </div>
            <NameInput
              theme={theme}
              value={to}
              asset="token"
              autoConfirm
              onStatus={(st, r) => {
                setStatus(st);
                setToName(r ? (r.displayName ?? r.input) : undefined);
                setToKeys(r ? { pubkey: r.pubkey, ordAddress: r.ordAddress } : {});
                const k = r?.via === 'pubkey' && r.rawKey && r.pubkey ? r : null;
                setToKey((prev) =>
                  k && prev?.raw === k.rawKey
                    ? prev
                    : k
                      ? { raw: k.rawKey!, pubkey: k.pubkey!, address: k.target }
                      : null,
                );
                if (k && k.rawKey !== toKey?.raw)
                  setKeyMode(defaultKeyMode({ hex: k.rawKey!, compressed: k.rawKey!.length === 66 }));
              }}
              onChange={(v) => {
                setTo(v);
                setFailed('');
              }}
              style={{ width: '100%', margin: 0 }}
            />
            {to && !validTo && status === 'ready' && <p className="text-xs text-[#F97066]">Not a valid address.</p>}
            {toKey && status === 'ready' && (
              <KeySendPanel k={toKey} mode={keyMode} setMode={setKeyMode} note={note} setNote={setNote} />
            )}
            <button
              disabled={!button.enabled}
              onClick={() => void send()}
              className={`${btn} w-full text-[#010101] disabled:opacity-40`}
              style={{ background: 'var(--bw-accent-hi)' }}
            >
              <Send size={16} /> {button.label}
            </button>
            {button.enabled && <div className="text-center text-[11px] text-[#667085]">to {shortAddr(to)}</div>}
            {failed && <p className="text-xs text-[#F97066] break-words">{failed}</p>}
            <button
              onClick={() => {
                setSending(false);
                setTo('');
                setFailed('');
              }}
              className="text-xs text-[#98A2B3] py-1"
            >
              Cancel
            </button>
          </div>
        )}
        {burned ? (
          <div className="flex flex-col gap-1 rounded-xl bg-[var(--bw-surface)] p-3">
            <span className="text-sm font-semibold text-[#F97066]">Burned</span>
            <a
              href={`https://whatsonchain.com/tx/${burned}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-[#98A2B3] underline break-all"
            >
              View on WhatsOnChain · {short(burned)}
            </a>
          </div>
        ) : sent || sending ? null : !burnable.show ? (
          burnable.reason && onChain !== false && <p className="text-[11px] text-[#667085]">{burnable.reason}</p>
        ) : !burning ? (
          <button
            onClick={() => setBurning(true)}
            className={`${btn} border border-[#F97066]/40 bg-transparent text-[#F97066]`}
          >
            <Flame size={16} /> Burn
          </button>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-[#F97066]/40 bg-[var(--bw-surface)] p-3">
            <div className="flex items-center gap-3">
              {item.kind === 'images' ? (
                <img src={item.url} alt="" className="h-12 w-12 rounded-lg object-cover" />
              ) : item.kind === 'video' ? (
                <video src={item.url} muted playsInline className="h-12 w-12 rounded-lg object-cover" />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[#0b0c0f]">
                  <Flame size={18} color="#F97066" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className={`text-sm font-semibold text-white ${ELLIPSIS}`}>{item.name}</div>
                <div className="flex items-center gap-1">
                  <span className="text-[11px] text-[#98A2B3]">{shortOutpoint(outpoint)}</span>
                  <button aria-label="Copy outpoint" onClick={() => void copyOutpoint()} className="p-1">
                    <Copy size={12} color="#98A2B3" />
                  </button>
                </div>
              </div>
            </div>
            <p className="text-xs text-white">
              Burning is permanent. This NFT will be destroyed and can&apos;t be recovered.
            </p>
            {copies.length === 0 ? (
              <p className="rounded-lg bg-[#F97066]/15 p-2 text-xs font-semibold text-[#F97066]">
                This is your only copy.
              </p>
            ) : (
              <p className="text-xs text-[#98A2B3]">
                You hold {copies.length} other {copies.length === 1 ? 'copy' : 'copies'} of this file.
              </p>
            )}
            <label className="text-[11px] text-[#98A2B3]">
              Type {BURN_WORD} to confirm
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoCapitalize="characters"
                autoComplete="off"
                aria-label={`Type ${BURN_WORD} to confirm`}
                className="mt-1 w-full rounded-lg bg-[#0b0c0f] px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-[#F97066]"
              />
            </label>
            <button
              disabled={burnBusy || !!burned}
              onClick={() => void burn()}
              onPointerDown={() => !canBurn && startHold()}
              onPointerUp={endHold}
              onPointerLeave={endHold}
              onPointerCancel={endHold}
              className={`${btn} w-full text-white disabled:opacity-40`}
              style={{ background: canBurn ? '#D92D20' : '#5c1a14' }}
            >
              <Flame size={16} />{' '}
              {burnBusy ? 'Burning…' : canBurn ? 'Burn forever' : 'Type BURN, or hold for 2 seconds'}
            </button>
            {burnErr && <p className="text-xs text-[#F97066] break-words">{burnErr}</p>}
            <button
              disabled={burnBusy}
              onClick={() => {
                setBurning(false);
                setTyped('');
                setHeld(false);
                setBurnErr('');
              }}
              className="text-xs text-[#98A2B3] py-1"
            >
              Cancel
            </button>
          </div>
        )}
        {msg && <p className="text-xs text-[#98A2B3] break-all">{msg}</p>}
      </div>
    </div>,
    document.body,
  );
};

/** Send to a public key: how to deliver it, the encrypted note, and what the confirmation will do. */
const KeySendPanel = ({
  k,
  mode,
  setMode,
  note,
  setNote,
}: {
  k: { raw: string; pubkey: string; address: string };
  mode: KeyMode;
  setMode: (m: KeyMode) => void;
  note: string;
  setNote: (n: string) => void;
}) => {
  const opt = (m: KeyMode, title: string, sub: string) => (
    <label className="flex items-start gap-2 text-xs cursor-pointer">
      <input type="radio" name="bw-key-mode" checked={mode === m} onChange={() => setMode(m)} className="mt-0.5" />
      <span>
        <span className="font-semibold text-[color:var(--bw-fg,#fff)]">{title}</span>
        <span className="block text-[#98A2B3]">{sub}</span>
      </span>
    </label>
  );
  return (
    <div data-testid="key-send-panel" className="flex flex-col gap-2 rounded-lg border border-white/10 p-2">
      <div className="text-[11px] text-[#98A2B3] break-all">
        Key {shortKey(k.raw)} · address {k.address}
      </div>
      {opt(
        'wallet',
        'This key belongs to a wallet (recommended)',
        'Sent so their wallet finds it, with a bMail it can read.',
      )}
      {opt('plain', "Send to the key's plain address", `Goes to ${k.address}. Only that key can spend it.`)}
      <textarea
        aria-label="Note, encrypted to this key"
        maxLength={NOTE_MAX}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Add a note (optional). Only the key's holder can read it."
        rows={3}
        className="w-full rounded-lg bg-black/40 text-sm text-white p-2 border border-white/10"
      />
      {note.trim() && (
        <div className="text-[11px] text-[#A1FF8B]">
          Note encrypted to this key{' '}
          {mode === 'plain' ? '(Electrum ECIES, in the same transaction)' : '(BRC-2, delivered by bMail)'}. You keep a
          copy on this device.
        </div>
      )}
    </div>
  );
};
