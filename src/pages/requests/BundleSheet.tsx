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
  sheetDecisions,
  type BundleRequest,
} from '../../services/permissionBundle';
import type { MintSheet } from '../../services/pinnedMint';
import { approvalKindForSheet, privateTitleLabel, siteName } from '../../services/approvalKind';
import { ApprovalCard, Check, Chip, Cross, SiteTile } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { CarefulHero, ConnectHero, PayHero, SignInHero } from '../../components/approval/ApprovalHeroes';

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

type Allowance = { usdPerBsv?: number; existingSats?: number; defaultUsd: number };

const fmtUsd = (usd: number) => (usd < 1 ? `${Math.round(usd * 100)}¢` : `$${usd.toFixed(2)}`);
const fmtSats = (sats: number) => (sats >= 1e8 ? `${(sats / 1e8).toFixed(8)} BSV` : `${sats.toLocaleString()} sats`);

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

  // Ticks keyed by requestID so lines that join mid-sheet get their default without resetting the rest.
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const firstCount = useRef(request.items.length);
  const added = Math.max(0, request.items.length - firstCount.current);
  const isChecked = (id: string, dflt: boolean) => checked[id] ?? dflt;

  const [allowance, setAllowance] = useState<Allowance | undefined>();
  const [allowanceUsd, setAllowanceUsd] = useState<number>(DEFAULT_ALLOWANCE_USD);
  const [allowanceOn, setAllowanceOn] = useState(true);
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
  const showAllowance = !mint && !!allowance?.usdPerBsv && allowance.existingSats === undefined;
  const payUsd =
    model.payment && allowance?.usdPerBsv ? (model.payment.satoshis / 1e8) * allowance.usdPerBsv : undefined;

  const send = async (approve: boolean) => {
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
      const decisions = sheetDecisions(model, approve, checked, detailsSeen);
      await sendMessageAsync({
        action: 'BUNDLE_PERMISSION_RESPONSE',
        bundleID: request.bundleID,
        decisions,
        allowanceUsd: approve && showAllowance && allowanceOn ? allowanceUsd : 0,
        remember,
        trustSite: !mint && approve && remember && canTrust && trustSite,
      });
      onResponse();
    } catch (error) {
      addSnackbar(error instanceof Error ? error.message : String(error), 'error');
      setBusy(false);
    }
  };

  const kind = approvalKindForSheet(model, { existingAllowanceSats: allowance?.existingSats });
  const name = siteName(request.originator);
  const many = model.lines.length + (model.payment ? 1 : 0) > 1;
  const payLabel = payUsd !== undefined ? fmtUsd(payUsd) : model.payment ? fmtSats(model.payment.satoshis) : '';
  const allowanceSetsUsd = showAllowance && allowanceOn && allowanceUsd > 0 ? allowanceUsd : 0;
  const existingUsd =
    allowance?.existingSats !== undefined && allowance.usdPerBsv
      ? (allowance.existingSats / 1e8) * allowance.usdPerBsv
      : undefined;
  const primary = mint
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
  const disabled = busy || !armed;
  const careful = kind === 'careful';
  const riskyLines = model.lines.filter((l) => l.risky);

  const toggle = (id: string, dflt: boolean) => setChecked((c) => ({ ...c, [id]: !isChecked(id, dflt) }));
  const lineRow = (l: (typeof model.lines)[number], big = false) => (
    <label
      key={l.requestID}
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
      {added > 0 && (
        <p className="m-0" style={{ fontSize: 12, color: CARD.green }}>
          +{added} more added while this was open
        </p>
      )}
      {model.lines.map((l) => lineRow(l))}
      {model.payment && (
        <p className="m-0" style={{ padding: '6px 0' }}>
          Pay now: <span style={{ color: CARD.gold, fontWeight: 600 }}>{payLabel}</span> to {request.originator}
          {model.payment.description && <> &ldquo;{model.payment.description}&rdquo;</>}
        </p>
      )}
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
            Don&apos;t ask again on {request.originator} for sign-in and signing. Payments stay within the allowance;
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

  const deny = { label: careful ? 'No, block it' : 'Not now', onClick: () => void send(false), disabled };
  const allow = { label: careful ? 'I trust it, allow' : primary, onClick: () => void send(true), disabled, busy };

  let hero: ReactNode;
  let title: ReactNode;
  let body: ReactNode = null;
  let siteSub: string | undefined;
  const gold = (t: string) => <span style={{ color: CARD.gold }}>{t}</span>;

  const satsText = (sats: number) =>
    allowance?.usdPerBsv ? fmtUsd((sats / 1e8) * allowance.usdPerBsv) : fmtSats(sats);
  if (mint && kind !== 'careful') {
    // One button, one approval (owner, 24 Oct 2026): what will happen, then the price, then the button.
    hero = (
      <PayHero amount={payLabel} sub={model.payment ? `${model.payment.satoshis.toLocaleString()} sats` : undefined} />
    );
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
    hero = <CarefulHero />;
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
      <div className="flex flex-col" style={{ gap: 8 }}>
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
    hero = (
      <PayHero
        amount={payLabel}
        sub={payUsd !== undefined && model.payment ? `${model.payment.satoshis.toLocaleString()} sats` : undefined}
      />
    );
    siteSub = model.payment?.description || 'Asks you to pay';
    title = <>Pay {gold(name)}</>;
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
          </div>
        </div>
        <div className="flex items-center gap-2" style={{ fontSize: 14, color: CARD.soft }}>
          <Check size={18} />
          {allowanceSetsUsd > 0
            ? `Then up to ${fmtUsd(allowanceSetsUsd)} a month without asking`
            : 'Every payment asks you first'}
        </div>
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
          {model.payment
            ? `This post costs ${payLabel}${payUsd !== undefined ? ` (${model.payment.satoshis.toLocaleString()} sats)` : ''}`
            : allowanceSetsUsd > 0
              ? `Posts cost a little each, up to ${fmtUsd(allowanceSetsUsd)} a month without asking`
              : 'Each paid post asks you first'}
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
    >
      <ApprovalCard
        tone={careful ? 'red' : 'gold'}
        site={request.originator}
        siteSub={siteSub}
        onClose={() => void send(false)}
        closeLabel="Deny and close"
        closeDisabled={disabled}
        hero={hero}
        title={title}
        primary={careful ? deny : allow}
        secondary={careful ? allow : deny}
        details={details}
        detailsOpen={details_}
        onToggleDetails={() => {
          setDetailsSeen(true);
          setDetails(!details_);
        }}
        error={usbError}
      >
        {body}
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
