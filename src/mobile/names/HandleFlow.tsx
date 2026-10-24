import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { payNameFee } from './nameFee';
import { askNotifyPermissionOnce } from '../notify/engine';
import { X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useLegacyKeys } from './useLegacyKeys';
import { getPaymail, setPaymail } from './accountName';
import { syncBchatHandle } from './bchatHandle';
import {
  claimPaymail,
  isGmailName,
  lookupPaymail,
  type NameFee,
  paymailConfig,
  nameChangeBlocked,
  paymailAvailable,
  paymailEnabled,
  PAYMAIL_ALIAS_RE,
  SOCIAL_ALIAS_RE,
  toAlias,
  DISPLAY_NAME_MAX,
  cleanDisplayName,
  defaultDisplayName,
} from './paymail';
import { clearSocial, socialProof } from '../social/socialLogin';
import { BWALLET_PAYMAIL_API, BWALLET_PAYMAIL_DOMAIN, SIBLING_PAYMAIL_DOMAINS } from './config';
import {
  PERSONAL_FEE_ESTIMATE_SATS,
  PERSONAL_NETWORK_FEE_SATS,
  deployPersonalToken,
  existingChoice,
  importExistingToken,
  openPersonalRoom,
  recoverPersonalLink,
} from './claimPersonal';
import { getFundRecord, showOnWallet } from '../tokens/indexFund';
import { FinishIndexing } from '../tokens/FinishIndexing';
import { AvatarPicker } from './AvatarPicker';
import { NRT_ENABLED, PAID_FEATURES_ENABLED } from '../storeBuild';
import { paymailAvatar } from './avatar';
import { adoptSocialAvatar } from './socialAvatar';
import { DEFAULT_SUPPLY, getPersonalLink, onPersonalChange, personalTicker, validateSupply } from './personalToken';
import { getMyName } from './myName';
import { SendConfirmation } from '../../components/SendConfirmation';
import { CurvePicker } from '../curves/CurvePicker';
import { STANDARD_SUPPLY, curveProblem } from '../curves/curveChoice';
import { maxPrice, standardCurve, usd, type Curve } from '../../lib/curves';
import { useTheme } from '../../hooks/useTheme';
import { handleTitle, suggestHandle } from './handlePrompt';
import { useBackClose } from '../backStack';
import { moneyNow } from '../money/money';
import {
  bsv20TakenError,
  duplicateNote,
  heldTokenNote,
  personalTokenLabel,
  type ExistingChoice,
} from './existingToken';

/**
 * "Choose your handle": a full-screen sheet shown after create / restore (HandleOnboarding) and
 * from the Wallet "Get your $name" card. Step 1 claims the free paymail name@bwallet.space (signed by
 * the identity key, no transaction). Step 2, on by default: the personal $NAME token + its
 * holder-only room (claimPersonal), after the standard confirmation sheet shows the fee (network
 * + creator-paid indexing). Optional: a photo (local; publishing it is a separate confirmed step).
 * The on-chain OpNS name is NOT offered here: it stays a quiet optional link in Settings → Identity.
 * Nothing is broadcast without a confirmation; the user can skip.
 */
const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#17191E';
const BORDER = '#2b2f36';
const GRAY = '#98A2B3';

const f = (u: string, i?: RequestInit) => fetch(u, i);
type AliasState = 'idle' | 'checking' | 'free' | 'mine' | 'taken' | 'invalid' | 'error';

export const HandleFlow = ({
  onClose,
  title = 'Choose your handle',
  onClaimed,
  suggest,
}: {
  onClose: () => void;
  title?: string;
  /** A verified name to prefill (Sign in with HandCash: first claim on the HandCash handle). */
  suggest?: string;
  /** bChat sign-in waiting on a handle (needs_handle): the caller finishes the sign-in with this name. */
  onClaimed?: (paymail: string) => Promise<void> | void;
}) => {
  useBackClose(true, onClose);
  const { apiContext, chromeStorageService } = useServiceContext();
  const legacy = useLegacyKeys();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const identityAddress = account?.addresses?.identityAddress ?? '';
  const ordAddress = account?.addresses?.ordAddress ?? '';
  const profileName = account?.settings?.socialProfile?.displayName ?? '';
  const [paymail, setPm] = useState(getPaymail(identityAddress));
  const [alias, setAlias] = useState(() => suggest || suggestHandle(profileName, account?.name ?? ''));
  // Optional "Your name" (owner, 15 Oct 2026): shown to people who pay the paymail. Blank → the server uses the handle.
  const [yourName, setYourName] = useState(() => cleanDisplayName(profileName));
  const [state, setState] = useState<AliasState>('idle');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const enabled = paymailEnabled();
  const { theme } = useTheme();
  const [link, setLink] = useState(() => getPersonalLink(identityAddress));
  // Store build: free paymail only, no personal token + holder room (storeBuild.ts).
  const withToken = PAID_FEATURES_ENABLED;
  const [supply, setSupply] = useState(DEFAULT_SUPPLY);
  const supplyNum = Number(String(supply).replace(/[,_\s]/g, '')) || 0;
  const [curve, setCurve] = useState<Curve>(() => standardCurve());
  const [curveOk, setCurveOk] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [tokenMsg, setTokenMsg] = useState('');
  // 1¢ to claim a new name (anti-squatting, owner 10 Oct 2026); null = free (server fee off).
  const [nameFee, setNameFee] = useState<NameFee | null>(null);
  const [feeConfirm, setFeeConfirm] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void paymailConfig(f).then((c) => live && setNameFee(c.nameFee));
    return () => {
      live = false;
    };
  }, [enabled]);
  useEffect(() => onPersonalChange(() => setLink(getPersonalLink(identityAddress))), [identityAddress]);
  // A restored wallet already owns its name: show it instead of suggesting a new one. (The background
  // name sync may not have finished when this opens.) The server answers with the wallet's identity,
  // the handle it chose first, so a stale name stored here is replaced.
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    apiContext.wallet
      .getPublicKey({ identityKey: true })
      .then(({ publicKey }) => lookupPaymail(f, publicKey))
      .then((p) => {
        if (!live || !p || p === paymail) return;
        setPaymail(identityAddress, p);
        setPm(p);
        if (!socialProof(identityAddress)) setAlias(p.split('@')[0]);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Continue with X / Google: nothing is registered for the user (owner, 9 Oct 2026: users choose their
  // handle). X prefills its @name as a suggestion they can change; Google suggests nothing (an email-derived
  // name published the address). Old servers send only `alias` (b0asex.x): its X part is the suggestion.
  const [_suggested] = useState<string | null>(() => {
    const p = socialProof(identityAddress)?.profile;
    if (suggest || !p || p.provider !== 'x') return null;
    const a = toAlias(p.suggested_handle || p.name || '');
    if (a) setTimeout(() => setAlias(a), 0);
    return a || null;
  });
  // The token is named after the claimed handle (paymail alias, else OpNS name), else what's typed.
  const claimed = (paymail ? paymail.split('@')[0] : '') || getMyName(identityAddress);
  const tokenName = claimed || alias;
  const ticker = personalTicker(tokenName);
  const supplyError = validateSupply(supply);
  // A token minted earlier whose local link was lost: find this wallet's own deploy (read-only).
  useEffect(() => {
    if (link || !claimed || !apiContext) return;
    recoverPersonalLink(apiContext, identityAddress, claimed)
      .then((l) => l && setLink(l))
      .catch(() => undefined);
  }, [apiContext, identityAddress, claimed, link]);

  // Tokens that already use this ticker: import ours, refuse a taken BSV-20 tick, note someone else's.
  const [choice, setChoice] = useState<ExistingChoice | null>(null);
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    if (link || !claimed || !apiContext || !withToken) return;
    let live = true;
    existingChoice(apiContext, claimed, undefined, legacy)
      .then((c) => live && setChoice(c))
      .catch(() => live && setChoice({ kind: 'mint' }));
    return () => {
      live = false;
    };
  }, [apiContext, claimed, link, withToken, legacy]);

  const importToken = async () => {
    if (choice?.kind !== 'import') return;
    setImporting(false);
    setBusy(true);
    setTokenMsg('');
    try {
      const { link: l, roomTicker } = await importExistingToken(
        apiContext,
        identityAddress,
        claimed,
        choice.token,
        legacy,
      );
      void showOnWallet(chromeStorageService, l.tokenId);
      setTokenMsg(
        roomTicker
          ? `$${l.ticker} is now your token and its room is open.`
          : `$${l.ticker} is now your token. Set up its room from Chat when you're ready.`,
      );
    } catch (e) {
      setTokenMsg(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  const mintToken = async (name = tokenName) => {
    setConfirming(false);
    setBusy(true);
    setTokenMsg('');
    try {
      const l = await deployPersonalToken(apiContext, {
        identityAddress,
        name,
        supply,
        payAddress: account?.addresses?.bsvAddress,
        curve,
        avatar: account?.settings?.socialProfile?.avatar ?? account?.icon,
        ...(choice ? { choice, acceptDuplicate: choice.kind === 'mint-labelled' } : {}),
      });
      if (choice?.kind === 'mint-labelled') setTokenMsg(personalTokenLabel(name));
      // Its balance is local: show it on the Wallet tab now, not when an indexer catches up.
      void showOnWallet(chromeStorageService, l.tokenId);
      void askNotifyPermissionOnce();
      // Names, Rooms and Tickets: a token opens no room by itself; attach it to a room in You › Rooms.
      if (NRT_ENABLED) {
        setTokenMsg(`$${l.ticker} minted. Add it as a ticket to any room from You › Rooms.`);
        return;
      }
      setTokenMsg(`$${l.ticker} minted. Opening your room…`);
      // Signatures only; a fresh token may not be indexed yet. Chat retries until it is.
      openPersonalRoom(apiContext, identityAddress, l)
        .then(() => setTokenMsg(`$${l.ticker} minted and your room is open. Invite = send 1 $${l.ticker}.`))
        .catch(() =>
          setTokenMsg(`$${l.ticker} minted. Set up your room from Chat or Settings › My tokens when you're ready.`),
        );
    } catch (e) {
      setTokenMsg(e instanceof Error ? e.message : 'Token mint failed');
    } finally {
      setBusy(false);
    }
  };

  // Live availability, debounced.
  useEffect(() => {
    if (!enabled) return;
    if (!alias) return setState('idle');
    // An existing .x / .gmail name of this wallet's stays valid (it keeps receiving); new ones are plain.
    const current = paymail ? paymail.split('@')[0] : '';
    if (!PAYMAIL_ALIAS_RE.test(alias) && !(SOCIAL_ALIAS_RE.test(alias) && alias === current))
      return setState('invalid');
    if (paymail && paymail.split('@')[0] === alias) return setState('free');
    setState('checking');
    let live = true;
    const t = setTimeout(() => {
      paymailAvailable(f, alias)
        .then(async (free) => {
          if (free) return live && setState('free');
          // Taken — by this wallet? Then it's ours (e.g. claimed a moment ago, or a restored wallet).
          const { publicKey } = await apiContext.wallet.getPublicKey({ identityKey: true });
          const mine =
            (await lookupPaymail(f, publicKey).catch(() => undefined))?.split('@')[0] === alias ||
            (await fetch(`${BWALLET_PAYMAIL_API}/api/paymail/id/${alias}@${BWALLET_PAYMAIL_DOMAIN}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((j: { pubkey?: string } | null) => j?.pubkey === publicKey)
              .catch(() => false));
          if (live) setState(mine ? 'mine' : 'taken');
        })
        .catch(() => live && setState('error'));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [alias, enabled, paymail, apiContext.wallet]);

  /** Pay the 1¢ name fee with the normal wallet send, then claim with its txid. */
  const payAndClaim = async () => {
    setFeeConfirm(false);
    if (!nameFee) return claim();
    setBusy(true);
    setMsg('');
    try {
      await claim(await payNameFee(apiContext, nameFee));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Claim failed');
      setBusy(false);
    }
  };

  const claim = async (fee: { feeTxid?: string; feeTx?: string } = {}) => {
    setBusy(true);
    setMsg('');
    try {
      // The sign-in only lends its photo and display name; the handle is the one typed here.
      const proof = socialProof(identityAddress);
      const pm = await claimPaymail(f, apiContext.wallet, alias, {
        ordAddress,
        name:
          cleanDisplayName(yourName) ||
          cleanDisplayName(proof?.profile.display) ||
          cleanDisplayName(profileName) ||
          undefined,
        avatar: paymailAvatar(proof?.profile.avatar || account?.settings?.socialProfile?.avatar),
        ...fee,
      });
      if (proof) {
        await adoptSocialAvatar(chromeStorageService, proof.profile.avatar);
        clearSocial();
      }
      setPaymail(identityAddress, pm);
      setPm(pm);
      // bChat handle = paymail name, before any token room is opened under it. A sign-in that was
      // waiting on a handle finishes with its own claim token instead (onClaimed).
      if (onClaimed) await onClaimed(pm);
      else await syncBchatHandle(apiContext, pm, { signIn: true });
      // The token + room is an explicit choice (its own button below), never started automatically.
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Claim failed');
    } finally {
      setBusy(false);
    }
  };

  const owned = (!!paymail && paymail.split('@')[0] === alias) || state === 'mine';
  const blocked = nameChangeBlocked(paymail, alias);
  const stateText: Record<AliasState, string> = {
    idle: '',
    checking: 'Checking…',
    free: owned ? 'Yours ✓' : 'Available',
    mine: 'Yours ✓',
    taken: 'Taken. Try another.',
    invalid: 'Use a-z, 0-9, - or _',
    error: "Couldn't check. Check your connection.",
  };

  // Portalled to <body>: opened from inside the wallet page (WalletCard, TopNav), a transformed ancestor such as
  // the pull-to-refresh container became the containing block of this fixed sheet, so it drew inside the page
  // between the card and the token list and its Close/Done were hard or impossible to reach (owner, 11 Oct 2026).
  return createPortal(
    <div
      className="fixed inset-0 z-[400] flex flex-col overflow-y-auto"
      style={{
        background: '#0b0c0f',
        paddingTop: 'calc(env(safe-area-inset-top) + 12px)',
        paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)',
      }}
      role="dialog"
      aria-label={title}
    >
      <div className="flex items-center justify-between px-4 h-12">
        <span className="text-base font-bold text-white">{title}</span>
        <button type="button" aria-label="Close" onClick={onClose} className="p-2 bg-transparent border-0">
          <X size={18} color={GRAY} />
        </button>
      </div>

      <div className="flex flex-col gap-4 px-4 pt-2">
        <div className="flex flex-col items-center gap-2 pt-2 pb-1 text-center">
          <AvatarPicker displayName={profileName || claimed || alias} />
          <span className="text-2xl font-bold" style={{ color: GOLD }}>
            {handleTitle(paymail ? paymail.split('@')[0] : alias)}
          </span>
          <p className="text-xs max-w-[300px]" style={{ color: GRAY }}>
            A name people can pay instead of a long address. You choose it; change it any time in Settings → Identity,
            and your old name keeps receiving.
          </p>
        </div>

        {enabled ? (
          <div
            className="flex flex-col gap-2 rounded-2xl p-4"
            style={{ background: PANEL, border: `1px solid ${BORDER}` }}
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-widest" style={{ color: GRAY }}>
                Your paymail
              </span>
              <span className="text-[10px] font-semibold" style={{ color: nameFee ? GOLD : '#2ecc71' }}>
                {nameFee ? '1¢ · instant' : 'Free · instant'}
              </span>
            </div>
            <div
              className="flex items-center gap-1 rounded-xl px-3 h-11"
              style={{ background: '#0b0c0f', border: `1px solid ${BORDER}` }}
            >
              <input
                value={alias}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="yourname"
                aria-label="Handle"
                onChange={(e) => setAlias(toAlias(e.target.value))}
                className="flex-1 min-w-0 bg-transparent outline-none border-0 text-sm text-white"
              />
              <span className="text-sm whitespace-nowrap" style={{ color: GRAY }}>
                @{BWALLET_PAYMAIL_DOMAIN}
              </span>
            </div>
            <span
              className="text-[11px] min-h-[16px]"
              style={{
                color:
                  state === 'free' || state === 'mine'
                    ? '#2ecc71'
                    : state === 'checking' || state === 'idle'
                      ? GRAY
                      : '#ff4444',
              }}
            >
              {stateText[state]}
            </span>
            {!!alias && SIBLING_PAYMAIL_DOMAINS.length > 0 && (
              <span className="text-[11px]" style={{ color: GRAY }}>
                Also yours, same key: {SIBLING_PAYMAIL_DOMAINS.map((d) => `${alias}@${d}`).join(', ')}
              </span>
            )}
            {isGmailName(paymail) && (
              <p className="text-xs" style={{ color: GOLD }}>
                Choose a name — your current address shows your Gmail. Your old address keeps receiving for 90 days.
              </p>
            )}
            {paymail && (
              <p className="text-xs text-white">
                <b style={{ color: GOLD }}>{paymail} ✓</b> receives BSV and tokens from any paymail wallet.
              </p>
            )}
            {!owned && blocked && (
              <p className="text-xs" style={{ color: GRAY }}>
                {blocked}
              </p>
            )}
            {!paymail && (
              <input
                value={yourName}
                maxLength={DISPLAY_NAME_MAX}
                placeholder={`Your name (optional), e.g. ${defaultDisplayName(alias) || 'Mike Smith'}`}
                aria-label="Your name"
                onChange={(e) => setYourName(e.target.value)}
                className="rounded-xl px-3 h-11 outline-none text-sm text-white"
                style={{ background: '#0b0c0f', border: `1px solid ${BORDER}` }}
              />
            )}
            {/* With a paymail already, offer "Change to" only once a different name is typed (owner, 11 Oct 2026). */}
            {!owned && !blocked && (!paymail || (!!alias && `${alias}@${BWALLET_PAYMAIL_DOMAIN}` !== paymail)) && (
              <button
                type="button"
                disabled={busy || state !== 'free'}
                onClick={() => (nameFee ? setFeeConfirm(true) : void claim())}
                className="h-11 rounded-xl text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
                style={{ background: GOLD, color: '#000' }}
              >
                {busy
                  ? 'Claiming…'
                  : `${paymail ? 'Change to' : 'Claim'} ${alias || 'name'}@${BWALLET_PAYMAIL_DOMAIN}${nameFee ? ' · 1¢' : ''}`}
              </button>
            )}
            {msg && (
              <p className="text-xs" style={{ color: '#ff4444' }}>
                {msg}
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs" style={{ color: GRAY }}>
            Paymail isn't available in this build. You can still register an on-chain name below.
          </p>
        )}

        {/* Personal token + room is bWalletX-only: the store build has no panel (or price), and none of its text. */}
        {PAID_FEATURES_ENABLED ? (
          <div
            className="flex flex-col gap-2 rounded-2xl p-4"
            style={{ background: PANEL, border: `1px solid ${BORDER}` }}
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-widest" style={{ color: GRAY }}>
                Your token + room
              </span>
              <span className="text-[10px] font-semibold" style={{ color: GOLD }}>
                ~{moneyNow(PERSONAL_FEE_ESTIMATE_SATS)}
              </span>
            </div>
            {link ? (
              <p className="text-xs text-white">
                <b style={{ color: GOLD }}>${link.ticker} ✓</b> · {Number(link.supply).toLocaleString()} minted ·{' '}
                {link.roomTicker
                  ? 'room open'
                  : getFundRecord(link.tokenId)
                    ? 'room paid for, waiting for confirmation (usually 10–20 min)'
                    : 'room not set up yet'}
                .
              </p>
            ) : null}
            {link && !busy && !getFundRecord(link.tokenId) ? (
              <FinishIndexing tokenId={link.tokenId} ticker={link.ticker} compact />
            ) : null}
            {link || !PAID_FEATURES_ENABLED ? null : (
              <>
                <p className="text-[11px]" style={{ color: GRAY }}>
                  A personal token, <b className="text-white">${ticker ?? 'NAME'}</b>, all to your wallet, and a chat
                  room only holders can enter. Invite someone by sending 1 ${ticker ?? 'NAME'}. Your room's token:
                  holders get in; it trades on your curve. About {moneyNow(PERSONAL_NETWORK_FEE_SATS)} network fee. You
                  confirm it before anything is sent.
                </p>
                {withToken && (
                  <label className="text-[11px] flex items-center gap-2" style={{ color: GRAY }}>
                    Supply
                    <input
                      value={supply}
                      inputMode="numeric"
                      onChange={(e) => setSupply(e.target.value)}
                      className="flex-1 rounded-lg px-2 py-1 text-xs bg-transparent outline-none text-white"
                      style={{ border: `1px solid ${supplyError ? '#ff4444' : BORDER}` }}
                    />
                  </label>
                )}
                {withToken && claimed && (choice?.kind === 'mint' || choice?.kind === 'mint-labelled') && (
                  <CurvePicker
                    curve={curve}
                    onChange={setCurve}
                    accepted={curveOk}
                    onAccept={setCurveOk}
                    tokenSupply={supplyNum}
                    onUseStandardSupply={() => setSupply(STANDARD_SUPPLY)}
                  />
                )}
                {withToken && supplyError && (
                  <span className="text-[11px]" style={{ color: '#ff4444' }}>
                    {supplyError}
                  </span>
                )}
                {withToken && claimed && choice?.kind === 'import' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setImporting(true)}
                    className="h-11 rounded-xl text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
                    style={{ background: GOLD, color: '#000' }}
                  >
                    We found the ${choice.token.sym.replace(/^\$/, '').toUpperCase()} token — sign to import it
                  </button>
                )}
                {withToken && claimed && choice?.kind === 'bsv20-taken' && (
                  <p className="text-[11px]" style={{ color: '#ff4444' }}>
                    {bsv20TakenError(choice.tick)}
                  </p>
                )}
                {withToken && claimed && choice?.kind === 'held' && (
                  <p className="text-[11px]" style={{ color: GOLD }}>
                    {heldTokenNote(choice.token.sym)}
                  </p>
                )}
                {withToken && claimed && choice?.kind === 'mint-labelled' && (
                  <p className="text-[11px]" style={{ color: GOLD }}>
                    {duplicateNote(claimed)}
                  </p>
                )}
                {withToken && claimed && (choice?.kind === 'mint' || choice?.kind === 'mint-labelled') && (
                  <button
                    type="button"
                    disabled={busy || !ticker || !!supplyError || !!curveProblem(curve, curveOk, supplyNum)}
                    onClick={() => setConfirming(true)}
                    className="h-11 rounded-xl text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
                    style={{ background: GOLD, color: '#000' }}
                  >
                    Create ${ticker ?? 'NAME'} token + room
                  </button>
                )}
              </>
            )}
            {tokenMsg && (
              <p className="text-xs" style={{ color: GRAY }}>
                {tokenMsg}
              </p>
            )}
          </div>
        ) : null}

        <button
          type="button"
          onClick={onClose}
          className="h-11 rounded-xl text-sm font-semibold cursor-pointer"
          style={
            claimed
              ? { background: GOLD, color: '#000', border: 0 }
              : { background: 'transparent', color: GRAY, border: `1px solid ${BORDER}` }
          }
        >
          {claimed ? 'Done' : 'Skip for now'}
        </button>
        <SendConfirmation
          show={feeConfirm}
          theme={theme}
          lineItems={[{ address: `Claim $${alias}`.slice(0, 16), amount: '1¢' }]}
          total="1¢"
          isProcessing={busy}
          onConfirm={() => void payAndClaim()}
          onCancel={() => setFeeConfirm(false)}
        />
        <SendConfirmation
          show={confirming}
          theme={theme}
          lineItems={[
            // SendConfirmation truncates labels over 16 characters: keep them short.
            {
              address: `$${ticker ?? 'NAME'} + room`.slice(0, 16),
              amount: `${Number(supply || 0).toLocaleString()} tokens`,
            },
            { address: 'Curve (fixed)', amount: `${usd(curve.floorUsd)} → ${usd(maxPrice(curve))}` },
            { address: 'Network fee', amount: `~${moneyNow(PERSONAL_NETWORK_FEE_SATS)}` },
          ]}
          total={`~${moneyNow(PERSONAL_FEE_ESTIMATE_SATS)}`}
          isProcessing={busy}
          onConfirm={() => void mintToken()}
          onCancel={() => setConfirming(false)}
        />
        <SendConfirmation
          show={importing}
          theme={theme}
          lineItems={[
            {
              address: `Import $${choice?.kind === 'import' ? choice.token.sym.replace(/^\$/, '') : ''}`.slice(0, 16),
              amount: 'Signature',
            },
          ]}
          total="Free"
          isProcessing={busy}
          onConfirm={() => void importToken()}
          onCancel={() => setImporting(false)}
        />
      </div>
    </div>,
    document.body,
  );
};
