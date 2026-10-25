import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { markSiteConnected } from '../../mobile/theme/connectSiteTheme';
import { motion } from 'framer-motion';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useAccountNames } from '../../mobile/names/accountNames';
import { identityRowText } from '../../mobile/names/identityText';
import { keyFingerprint } from '../../mobile/wallet/identityLine';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useServiceContext } from '../../hooks/useServiceContext';
import { sendMessageAsync } from '../../utils/chromeHelpers';
import { confirmUsbForApproval } from '../../services/usbPresence';
import {
  ALLOWANCE_CHOICES_USD,
  buildSheetModel,
  DEFAULT_ALLOWANCE_USD,
  sheetCanTrust,
  sheetAnswer,
  sheetHash,
  sheetView,
  shownItems,
  type SheetChoice,
  type BundleRequest,
} from '../../services/permissionBundle';
import type { MintSheet } from '../../services/pinnedMint';
import { approvalKindForSheet, privateTitleLabel, siteName } from '../../services/approvalKind';
import { ApprovalCard, Check, Chip, Cross, SiteTile } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { CarefulHero, ConnectHero, PayHero, SignInHero } from '../../components/approval/ApprovalHeroes';
import { useSheetPrice } from '../../components/DollarAmount';
import { EnvelopePresets } from '../../components/approval/EnvelopePresets';
import { envelopeUsdText } from '../../services/envelopes';
import { ENVELOPES_ENABLED } from '../../mobile/storeBuild';
import { dollarsFirst, dollarsInline } from '../../utils/dollarsFirst';

/**
 * One sheet per action (docs/ONE-SHEET-PERMISSIONS.md §3c): everything a site asks for in one action,
 * in plain words, ticked by default (risky lines never are), with one button. Used in the side panel,
 * the prompt window, the in-page sheet and the phone overlay alike: all of them load prompt.html.
 */
export type BundlePayload = {
  bundleID: string;
  originator: string;
  items: BundleRequest[];
  /** A pinned site's paid action (services/pinnedMint.ts): one sheet with these words, no allowance, no trust. */
  mint?: MintSheet;
};

type Allowance = {
  usdPerBsv?: number;
  existingSats?: number;
  defaultUsd: number;
  /** Monthly allowances are on (services/allowanceFlag.ts); off by default, envelopes instead. */
  allowances?: boolean;
  /** The site's envelope (services/envelopes.ts): offered on its pay sheet, with what it holds now. */
  envelope?: { offer: boolean; balanceSats?: number; presetsUsd: readonly number[] };
};

const fmtUsd = (usd: number) => (usd < 1 ? `${Math.round(usd * 100)}¢` : `$${usd.toFixed(2)}`);

/** How long a refused answer's message stays up before the sheet moves on (the background leaves the window open). */
export const ANSWER_ERROR_HOLD_MS = 3000;

export const BundleSheet = (props: {
  request: BundlePayload;
  onResponse: () => void;
  /** In-page sheet: buttons stay off until the sheet is confirmed visible (clickjacking guard). */
  armed?: boolean;
}) => {
  const { request, onResponse, armed = true } = props;
  const { handleSelect, hideMenu } = useBottomMenu();
  const { addSnackbar } = useSnackbar();
  const { chromeStorageService } = useServiceContext();
  // Which account is signing (owner, 11 Oct 2026): "$handle · 033622…3ed4", the same fingerprint the card shows,
  // so a user can match it with what the site displays.
  const signer = chromeStorageService.getCurrentAccountObject().account;
  const signerNames = useAccountNames(
    signer?.addresses?.identityAddress,
    signer?.name ?? '',
    signer?.settings?.socialProfile?.displayName ?? '',
    false,
  );
  const signerTag = identityRowText(signerNames.displayName, signerNames.paymail, signerNames.handle).tag;
  const signerFingerprint = keyFingerprint(signer?.pubKeys?.identityPubKey);
  const model = useMemo(() => buildSheetModel(request), [request]);

  // Ticks keyed by requestID, so a line that joins live gets its own (unticked) tick without resetting the rest.
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  // A line joined: hold the buttons for a moment so a tap already on its way cannot land on the new set.
  const [hold, setHold] = useState(false);
  const shownCount = useRef(request.items.length);
  useEffect(() => {
    if (request.items.length === shownCount.current) return;
    shownCount.current = request.items.length;
    setHold(true);
    const t = setTimeout(() => setHold(false), 1000);
    return () => clearTimeout(t);
  }, [request.items.length]);
  // First touch freezes the sheet: anything arriving after it gets its own sheet.
  const frozen = useRef(false);
  const freeze = () => {
    if (frozen.current) return;
    frozen.current = true;
    sendMessageAsync({ action: 'BUNDLE_SHEET_FREEZE', bundleID: request.bundleID }).catch(() => undefined);
  };
  const isChecked = (id: string, dflt: boolean) => checked[id] ?? dflt;

  const [allowance, setAllowance] = useState<Allowance | undefined>();
  const [allowanceUsd, setAllowanceUsd] = useState<number>(DEFAULT_ALLOWANCE_USD);
  const [allowanceOn, setAllowanceOn] = useState(true);
  // Opt-in: a pay sheet pays this payment; putting money in the envelope is the user's own choice.
  const [envelopeUsd, setEnvelopeUsd] = useState(0);
  const [remember, setRemember] = useState(true);
  // "Don't ask again": later sign-in, signing and basket requests from this site need no sheet.
  const canTrust = useMemo(() => sheetCanTrust(request), [request]);
  const [trustSite, setTrustSite] = useState(true);
  const [details_, setDetails] = useState(false);
  // Once the ticks have been on screen they decide; until then Allow covers the routine lines (sheetDecisions).
  const [detailsSeen, setDetailsSeen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [usbError, setUsbError] = useState('');

  useEffect(() => {
    handleSelect('bsv');
    hideMenu();
  }, [handleSelect, hideMenu]);

  useEffect(() => {
    sendMessageAsync<{ success: boolean; data?: Allowance }>({
      action: 'GET_BUNDLE_ALLOWANCE',
      originator: request.originator,
    })
      .then((res) => {
        if (!res?.success || !res.data) return;
        setAllowance(res.data);
        setAllowanceUsd(res.data.defaultUsd);
      })
      .catch(() => undefined);
  }, [request.originator]);

  // The allowance line shows when the price is known and the site has none yet.
  // A mint sheet is for this one mint: never an allowance or "don't ask again" (the background enforces it too).
  const mint = request.mint && model.payment && model.lines.every((l) => !l.risky) ? request.mint : undefined;
  // Pay in the moment (owner, 24 Oct 2026): these sheets never offer a monthly allowance.
  const showAllowance = false as boolean;
  // "Put $X in <site>'s envelope" / "Top up the envelope": a payment from a micropayments site, or one with an envelope.
  // Store builds never offer an envelope (storeBuild.ts ENVELOPES_ENABLED).
  const envelope = ENVELOPES_ENABLED && !mint && model.payment && allowance?.usdPerBsv ? allowance.envelope : undefined;
  const showEnvelope = !!envelope?.offer;
  // Dollars first (owner, 24 Oct 2026): the site's allowance rate when the background sent one, else the live price.
  const price = useSheetPrice(allowance?.usdPerBsv);
  const payAmount = model.payment ? dollarsFirst(model.payment.satoshis, price) : undefined;

  const send = async (choice: SheetChoice) => {
    const approve = choice === 'allow';
    setBusy(true);
    setUsbError('');
    try {
      if (approve) {
        const usb = await confirmUsbForApproval(chromeStorageService);
        if (!usb.ok) {
          setUsbError(usb.message);
          setBusy(false);
          return;
        }
      }
      if (approve) markSiteConnected(request.originator); // its sheets may now wear its theme (docs/SITE-THEME.md)
      const answer = sheetAnswer(model, choice, checked, detailsSeen, view);
      const res = await sendMessageAsync<{ success?: boolean; error?: string }>({
        action: 'BUNDLE_PERMISSION_RESPONSE',
        seenHash: seenHash(choice),
        bundleID: request.bundleID,
        decisions: answer.decisions,
        allowanceUsd: answer.mayStore && showAllowance && allowanceOn ? allowanceUsd : 0,
        envelopeUsd: answer.mayStore && showEnvelope ? envelopeUsd : 0,
        remember: answer.mayStore && remember,
        trustSite: !mint && answer.mayStore && remember && canTrust && trustSite,
        block: answer.block,
      });
      if (res && res.success === false && res.error) {
        // e.g. "This request changed while you were answering…": leave it on screen long enough to read.
        addSnackbar(res.error, 'error');
        await new Promise((r) => setTimeout(r, ANSWER_ERROR_HOLD_MS));
      }
      onResponse();
    } catch (error) {
      addSnackbar(error instanceof Error ? error.message : String(error), 'error');
      setBusy(false);
    }
  };

  const kind = approvalKindForSheet(model, { existingAllowanceSats: allowance?.existingSats });
  const name = siteName(request.originator);
  const many = model.lines.length + (model.payment ? 1 : 0) > 1;
  const payLabel = model.payment ? dollarsInline(model.payment.satoshis, price) : '';
  const allowanceSetsUsd = showAllowance && allowanceOn && allowanceUsd > 0 ? allowanceUsd : 0;
  const existingUsd =
    allowance?.existingSats !== undefined && allowance.usdPerBsv
      ? (allowance.existingSats / 1e8) * allowance.usdPerBsv
      : undefined;
  const reconnect = request.items.some((r) => r.reconnect);
  const primary = reconnect
    ? 'Reconnect'
    : mint
      ? `${mint.title.split(' ')[0]} · ${payLabel}`
      : kind === 'post'
        ? model.payment
          ? `Allow & pay ${payLabel}`
          : 'Allow posting'
        : kind === 'private'
          ? 'Allow'
          : kind === 'signin'
            ? 'Sign in'
            : kind === 'pay'
              ? model.mode === 'connectAndPay'
                ? `Connect & pay ${payLabel}`
                : `Pay ${payLabel}`
              : many
                ? 'Allow all'
                : 'Connect';
  const nextAllowance = () => {
    const i = ALLOWANCE_CHOICES_USD.indexOf(allowanceUsd as (typeof ALLOWANCE_CHOICES_USD)[number]);
    const next = ALLOWANCE_CHOICES_USD[(i + 1) % ALLOWANCE_CHOICES_USD.length];
    setAllowanceUsd(next);
    setAllowanceOn(next > 0);
  };
  const disabled = busy || !armed || hold;
  const careful = kind === 'careful';
  const riskyLines = model.lines.filter((l) => l.risky);
  // Lines that joined while the sheet was open: shown up front with their own tick ("New: …").
  const newLines = model.lines.filter((l) => l.isNew && !(careful && l.risky));
  // Every line a tap can grant is on the face (owner: never approve something the user can't read).
  // Lines whose row has been fully on screen (above the choices). On the careful card Allow waits until every line
  // was read; a line never on screen is never granted (sheetView.hidden).
  const [seenLines, setSeenLines] = useState<ReadonlySet<string>>(() => new Set());
  const faceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const face = faceRef.current;
    const scroller = face?.closest<HTMLElement>('[data-approval-scroll]');
    if (!careful || !face || !scroller) return;
    const check = () => {
      const choices = scroller.querySelector('[data-testid="approval-choices"]');
      const top = Math.max(scroller.getBoundingClientRect().top, 0);
      const bottom = Math.min(choices ? choices.getBoundingClientRect().top : window.innerHeight, window.innerHeight);
      const seen: string[] = [];
      scroller.querySelectorAll<HTMLElement>('[data-line-id]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.top >= top - 1 && r.bottom <= bottom + 1) seen.push(el.dataset.lineId ?? '');
      });
      setSeenLines((prev) => (seen.every((id) => prev.has(id)) ? prev : new Set([...prev, ...seen])));
    };
    check();
    const t = setTimeout(check, 700); // after the entry animation
    scroller.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    return () => {
      clearTimeout(t);
      scroller.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
  }, [careful, model]);
  const view = sheetView(model, careful, careful && !detailsSeen ? seenLines : undefined);
  // Careful card: "I trust it, allow" waits until every line has been on screen (or Details was opened).
  const mustRead = careful && view.hidden.size > 0;
  const ordinaryLines = careful ? model.lines.filter((l) => !l.risky && !l.isNew) : [];
  // Live sheet: an Allow is bound to exactly the lines on screen (background checks the hash). A line not on
  // screen is never in it, so it can never be granted. Not now and Block decline everything, so they cover all.
  const seenHash = (choice: SheetChoice) =>
    sheetHash(choice === 'allow' ? shownItems(request.items, view) : request.items);

  const toggle = (id: string, dflt: boolean) => setChecked((c) => ({ ...c, [id]: !isChecked(id, dflt) }));
  const lineRow = (l: (typeof model.lines)[number], big = false) => (
    <label
      key={l.requestID}
      data-line-id={l.requestID}
      className="flex items-center gap-3 cursor-pointer"
      style={{
        minHeight: 44,
        padding: big ? '10px 14px' : '6px 0',
        borderRadius: big ? 14 : 0,
        background: big ? CARD.redChip : undefined,
        fontSize: big ? 14 : 13,
      }}
    >
      <input
        type="checkbox"
        checked={isChecked(l.requestID, l.checked)}
        onChange={() => toggle(l.requestID, l.checked)}
        style={{ width: 18, height: 18, accentColor: l.risky ? CARD.red : CARD.gold, flexShrink: 0 }}
      />
      <span style={{ color: l.risky ? '#FF6B6B' : undefined }}>{l.text}</span>
    </label>
  );

  const signingAs = (signerTag || signerFingerprint) && (
    <span>
      <span style={{ color: CARD.gold }}>{signerTag || 'this account'}</span>
      {signerFingerprint && (
        <span className="font-mono" style={{ userSelect: 'none', fontSize: 12, color: CARD.muted }}>
          {' '}
          · {signerFingerprint}
        </span>
      )}
    </span>
  );

  // Everything the old sheet showed, behind "Details": per-line ticks, allowance, remember, trust, raw detail.
  const details = (
    <div className="flex flex-col" style={{ gap: 4 }}>
      {(signerTag || signerFingerprint) && (
        <p className="m-0" data-testid="signing-as" style={{ fontSize: 12 }}>
          Signing in as {signingAs}
        </p>
      )}
      {model.lines.length > 0 && (
        <p className="m-0" style={{ fontSize: 12, fontWeight: 700, color: CARD.muted }}>
          Allow this app
        </p>
      )}
      {model.lines.map((l) => lineRow(l))}
      {model.payment && (
        <p className="m-0" style={{ padding: '6px 0' }}>
          Pay <span style={{ color: CARD.gold, fontWeight: 600 }}>{payLabel}</span> now to {request.originator}
          {model.payment.description && <> &ldquo;{model.payment.description}&rdquo;</>}
        </p>
      )}
      {model.payment?.labels?.length ? (
        <p className="m-0" style={{ fontSize: 13, color: CARD.muted }} data-testid="payment-labels">
          Labels: {model.payment.labels.join(', ')}
        </p>
      ) : null}
      {showAllowance && (
        <div className="flex items-center gap-3" style={{ minHeight: 44 }}>
          <input
            type="checkbox"
            checked={allowanceOn && allowanceUsd > 0}
            onChange={() => {
              if (allowanceUsd === 0) setAllowanceUsd(DEFAULT_ALLOWANCE_USD);
              setAllowanceOn(!(allowanceOn && allowanceUsd > 0));
            }}
            style={{ width: 18, height: 18, accentColor: CARD.gold, flexShrink: 0 }}
            aria-label="Monthly allowance"
          />
          <span className="flex-1">
            {allowanceUsd > 0
              ? `Spend up to ${fmtUsd(allowanceUsd)} a month without asking`
              : 'Ask me before every payment'}
          </span>
          <button
            type="button"
            className="border-0 bg-transparent underline"
            style={{ color: CARD.gold, minHeight: 44, padding: '0 4px', fontSize: 13 }}
            onClick={nextAllowance}
          >
            change
          </button>
        </div>
      )}
      <label className="flex items-center gap-3 cursor-pointer" style={{ minHeight: 44 }}>
        <input
          type="checkbox"
          checked={remember}
          onChange={() => setRemember(!remember)}
          style={{ width: 18, height: 18, accentColor: CARD.gold, flexShrink: 0 }}
        />
        <span>Remember this site</span>
      </label>
      {!mint && canTrust && remember && (
        <label className="flex items-start gap-3 cursor-pointer" style={{ padding: '6px 0' }}>
          <input
            type="checkbox"
            checked={trustSite}
            onChange={() => setTrustSite(!trustSite)}
            style={{ width: 18, height: 18, accentColor: CARD.gold, flexShrink: 0, marginTop: 1 }}
          />
          <span>
            Don&apos;t ask again on {request.originator} for sign-in and signing.{' '}
            {allowance?.allowances
              ? 'Payments stay within the allowance;'
              : ENVELOPES_ENABLED
                ? 'Payments still ask, or use its envelope;'
                : 'Payments still ask;'}{' '}
            your personal details always ask.
          </span>
        </label>
      )}
      <ul className="m-0 mt-1 pl-4 break-all" style={{ fontSize: 11, color: CARD.muted }}>
        {model.payment && <li>pay: {model.payment.detail}</li>}
        {model.lines.map((l) => (
          <li key={l.requestID}>{l.detail}</li>
        ))}
        {allowanceSetsUsd > 0 && <li>allowance: monthly spending cap for {request.originator}</li>}
      </ul>
    </div>
  );

  // Careful card: three choices (owner, 24 Oct 2026). The large, safe default is Not now (this request only);
  // Block this site really blocks (background stores a block record and revokes its grants).
  const deny = { label: 'Not now', onClick: () => void send('notNow'), disabled };
  const block = { label: 'Block this site', onClick: () => void send('block'), disabled };
  const allow = {
    label: careful ? 'I trust it, allow' : primary,
    onClick: () => void send('allow'),
    disabled: disabled || mustRead,
    busy,
  };

  let hero: ReactNode;
  let title: ReactNode;
  let body: ReactNode = null;
  let siteSub: string | undefined;
  const gold = (t: string) => <span style={{ color: CARD.gold }}>{t}</span>;

  const satsText = (sats: number) => dollarsInline(sats, price);
  if (mint && kind !== 'careful') {
    // One button, one approval (owner, 24 Oct 2026): what will happen, then the price, then the button.
    hero = <PayHero amount={payAmount?.main ?? ''} sub={payAmount?.sub} />;
    siteSub = 'One approval for all of it';
    title = <>{gold(mint.title)}</>;
    body = (
      <div className="flex flex-col" style={{ gap: 8 }} data-testid="mint-sheet">
        <div className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 600 }} data-testid="mint-cost">
          <Check size={18} />
          Costs {satsText(mint.premiumSats)} + {satsText(mint.feeSats)} network fee
        </div>
        <div className="flex flex-wrap" style={{ gap: 8 }}>
          <Chip>
            <Check />
            Locked with your keys
          </Chip>
          <Chip>
            <Check />
            Only on {mint.site}
          </Chip>
          <Chip>
            <Check />
            Next payment asks again
          </Chip>
        </div>
      </div>
    );
  } else if (kind === 'careful') {
    // With lines to read, the words come first: the red card and "Check this carefully" carry the warning, and
    // the lines and the choices fit a 392×540 window without the big hero.
    hero = model.lines.length > 0 ? null : <CarefulHero />;
    siteSub = 'Check this carefully';
    const privileged = request.items.some((r) => r.privileged);
    const privateCert = riskyLines.some(
      (l) => request.items.find((r) => r.requestID === l.requestID)?.type === 'certificate',
    );
    const red = (t: string) => <span style={{ color: '#FF6B6B' }}>{t}</span>;
    title = privileged ? (
      <>Wants {red('full control')} of your keys</>
    ) : privateCert ? (
      <>Wants your {red('private details')}</>
    ) : model.payment && riskyLines.length === 0 ? (
      <>{red(payLabel)} is over your allowance</>
    ) : (
      <>Wants {red('more than usual')}</>
    );
    body = (
      <div ref={faceRef} className="flex flex-col" style={{ gap: 8 }}>
        {privileged && (
          <div
            className="flex items-center gap-2.5"
            style={{ padding: '12px 14px', borderRadius: 14, background: CARD.redChip, fontSize: 14 }}
          >
            <Cross />
            Could move your money
          </div>
        )}
        {riskyLines.length === 0 && model.payment && (
          <div
            className="flex items-center gap-2.5"
            style={{ padding: '12px 14px', borderRadius: 14, background: CARD.redChip, fontSize: 14 }}
          >
            <Cross />
            {existingUsd !== undefined
              ? `Your allowance here is ${fmtUsd(existingUsd)} a month`
              : 'More than this site may spend'}
          </div>
        )}
        {riskyLines.map((l) => lineRow(l, true))}
        {ordinaryLines.length > 0 && (
          <div className="flex flex-col" data-testid="careful-ordinary-lines" style={{ padding: '0 4px' }}>
            <p className="m-0" style={{ fontSize: 12, fontWeight: 700, color: CARD.muted }}>
              Also asks to
            </p>
            {ordinaryLines.map((l) => lineRow(l))}
          </div>
        )}
        <div
          className="flex items-center gap-2.5"
          style={{ padding: '12px 14px', borderRadius: 14, background: CARD.redChip, fontSize: 14 }}
        >
          <Cross />
          Only allow apps you trust
        </div>
      </div>
    );
  } else if (kind === 'pay') {
    hero = <PayHero amount={payAmount?.main ?? ''} sub={payAmount?.sub} />;
    siteSub = model.payment?.description || 'Asks you to pay';
    title = (
      <>
        Pay {gold(payLabel)} now to {gold(name)}
      </>
    );
    body = (
      <>
        <div className="flex items-center gap-3" style={{ padding: 14, borderRadius: 16, background: CARD.chip }}>
          <SiteTile site={request.originator} size={44} />
          <div className="flex flex-col min-w-0" style={{ gap: 2, lineHeight: 1.25 }}>
            <span className="truncate" style={{ fontSize: 15, fontWeight: 600 }}>
              To {request.originator}
            </span>
            <span className="truncate" style={{ fontSize: 13, color: CARD.muted }}>
              {model.payment?.description ? `“${model.payment.description}”` : 'Straight from your wallet'}
            </span>
            {model.payment?.labels?.length ? (
              <span className="truncate" style={{ fontSize: 12, color: CARD.muted }} data-testid="payment-labels">
                Labels: {model.payment.labels.join(', ')}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2" style={{ fontSize: 14, color: CARD.soft }}>
          <Check size={18} />
          {allowanceSetsUsd > 0
            ? `Then up to ${fmtUsd(allowanceSetsUsd)} a month without asking`
            : ENVELOPES_ENABLED && envelopeUsd > 0
              ? `Then small payments come out of the envelope`
              : 'Every payment asks you first'}
        </div>
        {ENVELOPES_ENABLED && showEnvelope && envelope && (
          <div className="flex flex-col" style={{ gap: 8 }} data-testid="envelope-offer">
            <span style={{ fontSize: 15, fontWeight: 600 }}>
              {envelope.balanceSats !== undefined ? (
                <>
                  Top up the envelope
                  <span style={{ fontSize: 13, fontWeight: 400, color: CARD.muted }}>
                    {' '}
                    · {dollarsInline(envelope.balanceSats, price)} left, not enough for this
                  </span>
                </>
              ) : (
                <>
                  {envelopeUsd > 0 ? `Also put ${envelopeUsdText(envelopeUsd)}` : 'Also put money'} in {gold(name)}
                  &apos;s envelope?
                </>
              )}
            </span>
            <EnvelopePresets
              presetsUsd={envelope.presetsUsd}
              value={envelopeUsd}
              onChange={setEnvelopeUsd}
              allowNone
              disabled={disabled}
            />
            <span style={{ fontSize: 12, color: CARD.muted }}>
              Stays in your wallet. Small payments from {name} come out of it without asking; Coin return any time.
            </span>
          </div>
        )}
      </>
    );
  } else if (kind === 'post') {
    // One sheet for a site's first post (identity basket, post signature, the post's cost). The amount is plain
    // text, never themed or hidden (one-sheet rule).
    hero = <ConnectHero site={request.originator} />;
    siteSub = 'Wants to post for you';
    title = <>Allow {gold(name)} to post for you</>;
    body = (
      <>
        <div className="flex flex-wrap" style={{ gap: 8 }}>
          <Chip>
            <Check />
            Post and like as you
          </Chip>
          <Chip>
            <Check />
            Nothing else moves
          </Chip>
        </div>
        <div className="flex items-center gap-2" style={{ fontSize: 14 }} data-testid="post-cost">
          <Check size={18} />
          {payAmount ? (
            <span className="flex flex-col">
              <span>
                This post costs{' '}
                <span style={{ fontSize: 20, fontWeight: 800, color: CARD.gold }}>{payAmount.main}</span>
              </span>
              <span style={{ fontSize: 12, color: CARD.muted }}>{payAmount.sub}</span>
            </span>
          ) : allowanceSetsUsd > 0 ? (
            `Posts cost a little each, up to ${fmtUsd(allowanceSetsUsd)} a month without asking`
          ) : (
            'Each paid post asks you first'
          )}
        </div>
      </>
    );
  } else if (kind === 'private') {
    hero = <SignInHero />;
    siteSub = 'Private data';
    title = <>Keep your {gold(privateTitleLabel(model))} private</>;
    body = (
      <div className="flex flex-wrap" style={{ gap: 8, marginTop: 4 }}>
        <Chip>
          <Check />
          Only you can read them
        </Chip>
        <Chip>
          <Check />
          No money moves
        </Chip>
      </div>
    );
  } else if (reconnect && kind === 'signin') {
    hero = <ConnectHero site={request.originator} />;
    siteSub = 'You disconnected this site';
    title = <>Reconnect to {gold(name)}?</>;
    body = (
      <div className="flex flex-wrap" style={{ gap: 8, marginTop: 4 }}>
        <Chip>
          <Check />
          Shares your public key
        </Chip>
        <Chip>
          <Check />
          No money moves
        </Chip>
      </div>
    );
  } else if (kind === 'signin') {
    hero = <SignInHero />;
    siteSub = 'Sign-in request';
    title = <>Sign in to {gold(name)}</>;
    body = (
      <>
        {signingAs && (
          <div className="flex items-center gap-2.5">
            <div
              aria-hidden="true"
              style={{
                width: 30,
                height: 30,
                borderRadius: 15,
                background: 'conic-gradient(#F5C542, #B8860B, #FFE08A, #F5C542)',
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 18, fontWeight: 600 }}>as {signingAs}</span>
          </div>
        )}
        <div className="flex flex-wrap" style={{ gap: 8, marginTop: 4 }}>
          <Chip>
            <Check />
            No password
          </Chip>
          <Chip>
            <Check />
            No money moves
          </Chip>
        </div>
      </>
    );
  } else {
    hero = <ConnectHero site={request.originator} />;
    siteSub = 'Wants to connect';
    title = (
      <>
        Use {gold('bWalletX')} on {name}
      </>
    );
    const types = new Set(request.items.map((r) => r.type));
    const tiles: { label: string; icon: ReactNode }[] = [
      { label: types.has('certificate') ? 'Your details' : 'Your name', icon: <PersonIcon /> },
    ];
    if (types.has('protocol')) tiles.push({ label: 'Sign posts', icon: <PenIcon /> });
    if (types.has('basket')) tiles.push({ label: 'Keep items', icon: <BagIcon /> });
    body = (
      <>
        <div className="grid" style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))`, gap: 8 }}>
          {tiles.map((t) => (
            <div
              key={t.label}
              className="flex flex-col items-center"
              style={{ gap: 8, padding: '14px 6px', borderRadius: 16, background: CARD.chip }}
            >
              {t.icon}
              <span style={{ fontSize: 13, fontWeight: 600, textAlign: 'center' }}>{t.label}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2" style={{ fontSize: 14, color: CARD.soft }}>
          <Check size={18} />
          {allowanceSetsUsd > 0
            ? `Payments over ${fmtUsd(allowanceSetsUsd)} a month ask you first`
            : 'Payments still ask you first'}
        </div>
      </>
    );
  }

  return (
    <motion.div
      className="flex flex-col w-full h-full"
      style={{ maxHeight: '100vh' }}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', damping: 24, stiffness: 260 }}
      data-approval-kind={kind}
      onPointerDownCapture={freeze}
    >
      <ApprovalCard
        tone={careful ? 'red' : 'gold'}
        site={request.originator}
        siteSub={siteSub}
        onClose={() => void send('notNow')}
        closeLabel="Deny and close"
        closeDisabled={disabled}
        hero={hero}
        title={title}
        primary={careful ? deny : allow}
        secondary={careful ? allow : deny}
        tertiary={careful ? block : undefined}
        details={details}
        detailsOpen={details_}
        onToggleDetails={() => {
          setDetailsSeen(true);
          setDetails(!details_);
        }}
        error={usbError || (mustRead ? 'Scroll to read every line before allowing' : '')}
      >
        {body}
        {newLines.length > 0 && (
          <div className="flex flex-col" data-testid="new-lines" style={{ gap: 4, marginTop: 8 }}>
            {newLines.map((l) => lineRow(l, true))}
          </div>
        )}
      </ApprovalCard>
    </motion.div>
  );
};

const iconProps = {
  'aria-hidden': true,
  width: 28,
  height: 28,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: CARD.gold,
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;
const PersonIcon = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
  </svg>
);
const PenIcon = () => (
  <svg {...iconProps}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
const BagIcon = () => (
  <svg {...iconProps}>
    <rect x="3" y="7" width="18" height="13" rx="2" />
    <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);
