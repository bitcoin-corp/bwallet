import validate from 'bitcoin-address-validation';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useServiceContext } from '../hooks/useServiceContext';
import { useSnackbar } from '../hooks/useSnackbar';
import { useTheme } from '../hooks/useTheme';
import { ONE_SAT_MARKET_URL } from '../utils/constants';
import { showAmount, normalize, truncate } from '../utils/format';
import { sleep } from '../utils/sleep';
import { getErrorMessage } from '../utils/tools';
import { Input } from './Input';
import { SendConfirmation, type SendLineItem } from './SendConfirmation';
import { Bsv21OverlayPrompt, type Bsv21OverlayIssue } from './Bsv21OverlayPrompt';
import { Show } from './Show';
import { SpeedBump } from './SpeedBump';
import { CoinHistory } from './CoinHistory';
import {
  BSV21_BASKET,
  bsv21FieldsFromOutput,
  fundBsv21Overlay,
  sendBsv21,
  type Bsv21Balance,
} from '@1sat/actions';
import { classifyBsv21Shortfall } from '../utils/bsv21OverlayShortfall';
import { EMPTY_UNLOCK_MESSAGE, OVERLAY_ISSUES, bsv21ErrorMessage, isEmptyUnlockError } from '../utils/bsv21SendErrors';
import { fundOverlayExact, fundingTotal, formatBsvAmount, transfersCovered } from '../services/bsv21FundGuard';
import {
  chromeJournalStore,
  describeStaleFix,
  describeUnseenHeal,
  isUnseenState,
  type UnseenHealReport,
  journalSendEnd,
  journalSendStart,
  type StaleFixResult,
} from '../services/tokenSendHeal';
import { sendMessageAsync } from '../utils/chromeHelpers';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, ArrowLeft, ShoppingCart, Send, Copy, Check, Plus, Trash2, Tag } from 'lucide-react';
import { SellSheet } from '../mobile/sell/SellSheet';
import { SELL_ENABLED } from '../mobile/sell/sell';
import { IssuerBadge } from '../mobile/issuer/IssuerBadge';
import { PriceChart } from '../mobile/wallet/PriceChart';
import { TokenIconHeader } from '../mobile/tokens/TokenIconHeader';
import { TokenIndexButton } from '../mobile/tokens/TokenIndexButton';
import { GroupSendBar } from '../mobile/send/GroupSend';
import { NoteField } from '../mobile/airdrops/NoteField';
import { activeQuarantine } from '../mobile/airdrops/inbox';
import { normId } from '../mobile/airdrops/quarantine';
import { cleanNote, noteOutput, withExtraOutput } from '../mobile/airdrops/note';
import { celebrateSend } from './sent/sent';
import { P2PKH } from '@bsv/sdk';
import { maxOverlayFee, withTokenSendGuard, type OverlayFee } from '../mobile/wallet/send/tokenFee';
import { HOLDER_DROP_ENABLED } from '../mobile/storeBuild';
import { tokenIconUrl } from '../mobile/tokens/officialTokens';

// Issuer tools › Airdrop to holders: bWalletX only, a lazy chunk the store build drops (storeBuild.ts).
const HolderDropSheet = HOLDER_DROP_ENABLED ? lazy(() => import('../mobile/holderDrop/HolderDropSheet')) : null;

export interface Token {
  isConfirmed: boolean;
  info: Bsv21Balance;
}

export type SendBsv21ViewProps = {
  token: Token;
  /**
   * Called when the user exits the view. If the exit was triggered by a
   * successful send, `sentAtomic` is the total atomic token amount sent so
   * the parent can optimistically adjust its cached balance. Omitted on a
   * manual back press.
   */
  onBack: (sentAtomic?: bigint) => void | Promise<void>;
  /**
   * Opens the send form already filled (the token room invite sheet: recipient checked by the same
   * NameInput, amount = the room's entry). The user still reviews and confirms here as usual.
   */
  prefill?: { address: string; amountInput: string };
};

type Bsv21Recipient = {
  id: string;
  address: string;
  amountInput: string;
};

const WARN = '#F79009';

/** Overlay status of the token, for the pill beside the token ID. */
type OverlayStatus = 'active' | 'inactive' | 'unknown';
const OK = '#12B76A';

const newRecipient = (): Bsv21Recipient => ({
  id: crypto.randomUUID(),
  address: '',
  amountInput: '',
});

export const SendBsv21View = ({ token, onBack, prefill }: SendBsv21ViewProps) => {
  const { apiContext } = useServiceContext();
  const { theme } = useTheme();
  const { addSnackbar } = useSnackbar();
  const getTokenName = (b: { sym?: string }): string => b.sym || 'Null';
  const [recipients, setRecipients] = useState<Bsv21Recipient[]>(() => [
    prefill ? { ...newRecipient(), address: prefill.address, amountInput: prefill.amountInput } : newRecipient(),
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [sendConfirmation, setSendConfirmation] = useState<{
    icon?: string;
    lineItems: SendLineItem[];
    total: string;
    onConfirm: () => void;
  } | null>(null);
  const [successTxId, setSuccessTxId] = useState('');
  const [overlayStatus, setOverlayStatus] = useState<OverlayStatus | null>(null);
  /** Indexing balance and fee from the token details (status.balance / fee_per_output, sats). */
  const [overlayFunds, setOverlayFunds] = useState<{ balance: number; feePerOutput: number } | null>(null);
  const [overlayPrompt, setOverlayPrompt] = useState<{
    issue: Bsv21OverlayIssue;
    recipients: { address: string; amount: bigint }[];
    total: bigint;
    fundingSats?: number;
    fundingCovers?: number;
    fundingError?: string;
  } | null>(null);
  const [overlayProcessing, setOverlayProcessing] = useState<string | undefined>();
  /** Outpoints (txid.vout) the overlay reported 'unknown' on the last re-check, shown in the unseen prompt. */
  const [unseenOutpoints, setUnseenOutpoints] = useState<string[]>([]);
  const [confirmUnverified, setConfirmUnverified] = useState(false);
  const sentAtomicRef = useRef<bigint>(0n);
  const [copied, setCopied] = useState(false);
  const [selling, setSelling] = useState(false);
  const [dropping, setDropping] = useState(false);
  // Recipient fields stay hidden until the owner taps Send (owner, 5 Oct 2026).
  const [composing, setComposing] = useState(!!prefill);
  // Airdrop note (src/mobile/airdrops/note.ts): optional, written on chain in the same tx.
  const [note, setNote] = useState('');

  const maxAmount = token.isConfirmed ? token.info.all.confirmed : token.info.all.pending;
  const maxDisplay = showAmount(maxAmount, token.info.dec);

  useEffect(() => {
    if (!successTxId) return;
    // Reset local form state first, then exit. Parent does an optimistic balance
    // update based on `sentAtomicRef.current` so the transition is instant.
    resetSendState();
    void onBack(sentAtomicRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [successTxId]);

  const refreshOverlayStatus = async () => {
    const bsv21 = apiContext.services?.bsv21;
    if (!bsv21 || !token.info.id) return;
    try {
      const details = await bsv21.getTokenDetails(token.info.id, { fresh: true });
      setOverlayStatus(details.status?.is_active ? 'active' : 'inactive');
      setOverlayFunds({ balance: details.status?.balance ?? 0, feePerOutput: details.status?.fee_per_output ?? 0 });
      return details;
    } catch (error) {
      console.error('[SendBsv21View] overlay status lookup failed:', error);
      setOverlayStatus('unknown');
    }
    return undefined;
  };

  useEffect(() => {
    void refreshOverlayStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token.info.id]);

  const toAtomic = (input: string): bigint | null => {
    if (!input || input === '.' || input === '0.') return null;
    try {
      return BigInt(normalize(input, token.info.dec));
    } catch {
      return null;
    }
  };

  const addRecipient = () => setRecipients((prev) => [...prev, newRecipient()]);
  const removeRecipient = (id: string) =>
    setRecipients((prev) => (prev.length > 1 ? prev.filter((r) => r.id !== id) : prev));

  const updateRecipient = (id: string, field: 'address' | 'amountInput', value: string) => {
    if (field === 'amountInput') {
      if (value !== '' && !/^\d*\.?\d*$/.test(value)) return;
      const dec = token.info.dec;
      const parts = value.split('.');
      if (parts.length === 2 && dec > 0 && parts[1].length > dec) return;
      if (parts.length === 2 && dec === 0) return;
    }
    setRecipients((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  };

  /** Fill the given recipient with (max available - amounts already assigned to others). */
  const handleSetMax = (id: string) => {
    const assignedElsewhere = recipients.reduce(
      (acc, r) => (r.id === id ? acc : acc + (toAtomic(r.amountInput) ?? 0n)),
      0n,
    );
    const available = maxAmount > assignedElsewhere ? maxAmount - assignedElsewhere : 0n;
    updateRecipient(id, 'amountInput', showAmount(available, token.info.dec));
  };

  const handleCopyId = () => {
    if (!token.info.id) return;
    navigator.clipboard.writeText(token.info.id);
    setCopied(true);
    addSnackbar('Token ID copied', 'success');
    setTimeout(() => setCopied(false), 2000);
  };

  const resetSendState = () => {
    setRecipients([newRecipient()]);
    setSuccessTxId('');
    setIsProcessing(false);
  };

  /** The indexer fee the user saw on the confirm sheet: the send may pay no more, and no one else (tokenFee.ts). */
  const confirmedFeeRef = useRef<OverlayFee | null>(null);

  const handleSendBSV21 = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    await sleep(25);

    // Validate each recipient and build the action input
    const sendRecipients: { address: string; amount: bigint }[] = [];
    let total = 0n;

    for (const r of recipients) {
      if (!validate(r.address)) {
        addSnackbar('All recipients must have a valid 1Sat Ordinal address.', 'info');
        return;
      }
      const atomic = toAtomic(r.amountInput);
      if (atomic === null || atomic <= 0n) {
        addSnackbar('All recipients must have a valid amount.', 'info');
        return;
      }
      sendRecipients.push({ address: r.address, amount: atomic });
      total += atomic;
    }

    if (total > maxAmount) {
      addSnackbar('Total amount exceeds available balance.', 'error');
      return;
    }

    if (!token.info.id) {
      addSnackbar('Missing token ID!', 'error');
      return;
    }

    const tokenName = getTokenName(token.info);

    const shownIcon = tokenIconUrl(token.info.id, tokenName, token.info.icon);
    // Consolidate duplicate addresses by summing amounts
    const tokenConsolidated = new Map<string, bigint>();
    const tokenOrder: string[] = [];
    for (const r of sendRecipients) {
      tokenConsolidated.set(r.address, (tokenConsolidated.get(r.address) ?? 0n) + r.amount);
      if (!tokenOrder.includes(r.address)) tokenOrder.push(r.address);
    }
    const lineItems: SendLineItem[] = tokenOrder.map((addr) => ({
      address: addr,
      amount: `${showAmount(tokenConsolidated.get(addr)!, token.info.dec)} ${tokenName}`,
    }));
    // sendBsv21 also pays the token's indexer per token output (fee_address, fee_per_output): show it to confirm.
    const details = await refreshOverlayStatus();
    const fee = maxOverlayFee(details?.status?.fee_address, details?.status?.fee_per_output, sendRecipients.length);
    confirmedFeeRef.current = fee;
    if (fee) lineItems.push({ address: fee.address, amount: `up to ${fee.sats} sats (indexer fee)` });

    const tokenIcon = shownIcon;
    setSendConfirmation({
      icon: tokenIcon,
      lineItems,
      total: `${showAmount(total, token.info.dec)} ${tokenName}`,
      onConfirm: async () => {
        setSendConfirmation(null);
        setIsProcessing(true);
        await runSend(sendRecipients, total, true);
      },
    });
  };

  /**
   * Send through sendBsv21. With validateOverlay, an overlay error opens the
   * overlay prompt so the user can fund the overlay or send unverified.
   */
  const runSend = async (
    sendRecipients: { address: string; amount: bigint }[],
    total: bigint,
    validateOverlay: boolean,
    healedKeys = false,
  ): Promise<void> => {
    let sendRes: Awaited<ReturnType<typeof sendBsv21.execute>>;
    let journalId: string | undefined;
    // Quarantine: never spend a token from a sender you have not accepted together with your own coins.
    if (activeQuarantine().has(normId(token.info.id ?? ''))) {
      addSnackbar('This token is in Quarantine. Keep it in bMail › Quarantine first.', 'error');
      setIsProcessing(false);
      return;
    }
    try {
      const text = cleanNote(note);
      if (note.trim() && !text) {
        setIsProcessing(false);
        addSnackbar('The note must be 1–280 characters of plain text.', 'error');
        return;
      }
      const fee = confirmedFeeRef.current;
      const guarded = withTokenSendGuard(
        apiContext.wallet,
        fee ? { feeScript: new P2PKH().lock(fee.address).toHex(), maxSats: fee.sats } : null,
      );
      const ctx = {
        ...apiContext,
        wallet: text ? withExtraOutput(guarded, noteOutput(text, token.info.id!)) : guarded,
      };
      // Journal: open before the send, closed as soon as a txid (or a clean refusal) comes back. A page suspended
      // in between leaves it open, and the next start heals this token (tokenSendHeal.ts).
      journalId = await journalSendStart(chromeJournalStore, token.info.id!).catch(() => undefined);
      sendRes = await sendBsv21.execute(ctx, {
        tokenId: token.info.id!,
        recipients: sendRecipients.map((r) => ({
          amount: r.amount,
          destination: { address: r.address },
        })),
        validateOverlay,
      });
    } catch (error) {
      if (isEmptyUnlockError(error)) {
        // Rejected by the wallet's own verifier before any broadcast, so the journal can close.
        if (journalId) void journalSendEnd(chromeJournalStore, journalId, undefined).catch(() => undefined);
        await retryAfterKeyCheck(sendRecipients, total, validateOverlay, healedKeys);
        return;
      }
      // Left open on purpose: a throw can come after the broadcast.
      console.error('[SendBsv21View] sendBsv21.execute threw:', error);
      setIsProcessing(false);
      addSnackbar(getErrorMessage(error), 'error');
      return;
    }
    if (journalId) void journalSendEnd(chromeJournalStore, journalId, sendRes.txid).catch(() => undefined);

    if (!sendRes.txid && isEmptyUnlockError(sendRes.error)) {
      await retryAfterKeyCheck(sendRecipients, total, validateOverlay, healedKeys);
      return;
    }
    if (!sendRes.txid || sendRes.error) {
      console.error('[SendBsv21View] sendBsv21 error:', sendRes.error);
      setIsProcessing(false);
      let issue = validateOverlay && sendRes.error ? OVERLAY_ISSUES[sendRes.error] : undefined;
      if (issue === 'not-valid') issue = await refineNotValid(total);
      if (issue) {
        await openOverlayPrompt(issue, sendRecipients, total);
        return;
      }
      addSnackbar(bsv21ErrorMessage(sendRes.error, getTokenName(token.info)) ?? getErrorMessage(sendRes.error), 'error');
      return;
    }

    setOverlayPrompt(null);
    setNote('');
    sentAtomicRef.current = total;
    setSuccessTxId(sendRes.txid);
    const shown = celebrateSend(sendRes, {
      amount: { kind: 'token', display: showAmount(total, token.info.dec), ticker: getTokenName(token.info) },
      recipients: sendRecipients.map((r) => r.address),
    });
    if (!shown) addSnackbar('Tokens Sent!', 'success');
  };

  /**
   * F-3: the signer left a token input's unlock empty (its record names a key that doesn't derive its address).
   * Run the keys-only check for this token (refile with the key that signs, or set the output aside), then try the
   * send once more. Runs on every send path, not only "Send unverified".
   */
  const retryAfterKeyCheck = async (
    sendRecipients: { address: string; amount: bigint }[],
    total: bigint,
    validateOverlay: boolean,
    healedKeys: boolean,
  ) => {
    console.error('[SendBsv21View] empty unlock on a token input (F-3); healedKeys =', healedKeys);
    if (healedKeys) {
      setIsProcessing(false);
      addSnackbar(EMPTY_UNLOCK_MESSAGE, 'error');
      return;
    }
    setIsProcessing(true);
    const keys = await sendMessageAsync<{ success: boolean; data?: UnseenHealReport }>({
      action: 'BSV21_FIX_UNSEEN',
      tokenId: token.info.id,
      keysOnly: true,
    }).catch(() => undefined);
    if (keys?.data && (keys.data.keysRepaired || keys.data.keysDropped)) addSnackbar(describeUnseenHeal(keys.data), 'info');
    await runSend(sendRecipients, total, validateOverlay, true);
  };

  /**
   * sendBsv21 reports outputs the overlay hasn't seen yet ('unknown') as not
   * valid, and skips outputs it reports spent. Re-check so a just-arrived
   * transfer reads as "not validated yet" and a stale local list as "repair sync".
   */
  const refineNotValid = async (total: bigint): Promise<Bsv21OverlayIssue> => {
    try {
      const tokenId = token.info.id!;
      const norm = (id: string) => id.replace('.', '_');
      const list = await apiContext.wallet.listOutputs({
        basket: BSV21_BASKET,
        includeTags: true,
        includeCustomInstructions: true,
        limit: 10000,
      });
      const owned = list.outputs.flatMap((o) => {
        const f = bsv21FieldsFromOutput({ tags: o.tags, customInstructions: o.customInstructions, outpoint: o.outpoint });
        if (!f.tokenId || !f.amt || norm(f.tokenId) !== norm(tokenId)) return [];
        return [{ outpoint: o.outpoint, amount: BigInt(f.amt) }];
      });
      const statuses = await apiContext.services!.bsv21.getOutputStatus(
        tokenId,
        owned.map((o) => o.outpoint),
      );
      const states = new Map(statuses.map((s) => [s.outpoint, s.state as string]));
      setUnseenOutpoints(owned.filter((o) => isUnseenState(states.get(o.outpoint))).map((o) => o.outpoint));
      const shortfall = classifyBsv21Shortfall(
        owned.map((o) => ({ amount: o.amount, state: states.get(o.outpoint) })),
        total,
      );
      return shortfall;
    } catch (error) {
      console.error('[SendBsv21View] overlay shortfall re-check failed:', error);
      return 'not-valid';
    }
  };

  /** The indexer's exact price, or why there is none (then nothing can be paid). */
  const loadFunding = async (): Promise<{ fundingSats?: number; fundingCovers?: number; fundingError?: string }> => {
    try {
      const [template, details] = await Promise.all([
        apiContext.services!.bsv21.getFundingTemplate(token.info.id!),
        refreshOverlayStatus(),
      ]);
      const sats = fundingTotal(template);
      if (sats <= 0) return { fundingError: 'The indexer is not asking for funding right now. Try sending again.' };
      return {
        fundingSats: sats,
        fundingCovers: transfersCovered(sats, details?.status?.fee_per_output, details?.status?.balance),
      };
    } catch (error) {
      console.error('[SendBsv21View] funding template lookup failed:', error);
      return { fundingError: "Couldn't get the indexer's price, so nothing can be paid." };
    }
  };

  const openOverlayPrompt = async (
    issue: Bsv21OverlayIssue,
    sendRecipients: { address: string; amount: bigint }[],
    total: bigint,
  ) => {
    const funding = issue === 'not-active' ? await loadFunding() : {};
    setOverlayPrompt({ issue, recipients: sendRecipients, total, ...funding });
  };

  const handleRetryFunding = async () => {
    if (!overlayPrompt) return;
    setOverlayProcessing('Getting the price...');
    try {
      const funding = await loadFunding();
      setOverlayPrompt((p) => (p ? { ...p, fundingSats: undefined, fundingCovers: undefined, fundingError: undefined, ...funding } : p));
    } finally {
      setOverlayProcessing(undefined);
    }
  };

  /** Pays exactly the confirmed sats; a changed price is refused and shown for a new confirm. */
  const handleFundOverlay = async (confirmedSats: number) => {
    setOverlayProcessing('Funding indexer...');
    try {
      const res = await fundOverlayExact(apiContext, token.info.id!, confirmedSats, fundBsv21Overlay);
      if (res.error === 'funding-amount-changed') {
        addSnackbar(bsv21ErrorMessage(res.error, tokenName)!, 'error');
        const funding = await loadFunding();
        setOverlayPrompt((p) => (p ? { ...p, fundingSats: undefined, fundingError: undefined, ...funding } : p));
        return;
      }
      if (res.error === 'funding-not-needed') {
        addSnackbar(`The ${tokenName} indexer is already funded. Nothing was paid. Try sending again.`, 'info');
      } else if (res.error === 'funding-submit-failed') {
        addSnackbar(`Paid ${formatBsvAmount(confirmedSats)}. The indexer will pick it up within about 20 minutes.`, 'info');
      } else if (res.error) {
        addSnackbar(bsv21ErrorMessage(res.error, tokenName) ?? getErrorMessage(res.error), 'error');
        return;
      } else {
        addSnackbar(`Paid ${formatBsvAmount(confirmedSats)} to the ${tokenName} indexer. Your tokens will be checked shortly.`, 'success');
      }
      setOverlayPrompt(null);
      await refreshOverlayStatus();
    } catch (error) {
      console.error('[SendBsv21View] fundBsv21Overlay threw:', error);
      addSnackbar(getErrorMessage(error), 'error');
    } finally {
      setOverlayProcessing(undefined);
    }
  };

  /** Stale prompt: make this wallet match the indexer for this token, say what changed, send again. */
  const handleFixAndSend = async () => {
    if (!overlayPrompt) return;
    const { recipients: rs, total } = overlayPrompt;
    setOverlayProcessing('Updating this wallet from the indexer...');
    try {
      const res = await sendMessageAsync<{ success: boolean; error?: string; data?: StaleFixResult }>({
        action: 'BSV21_FIX_STALE',
        tokenId: token.info.id,
      });
      if (!res?.success || !res.data) {
        addSnackbar(res?.error ?? "Couldn't update this wallet. Try Settings › Troubleshooting › Repair Sync.", 'error');
        return;
      }
      const summary = describeStaleFix(res.data, (a) => showAmount(a, token.info.dec), tokenName);
      addSnackbar(summary, res.data.dropped.length || res.data.imported.length ? 'success' : 'info');
      setOverlayProcessing('Sending...');
      await runSend(rs, total, true);
    } catch (error) {
      addSnackbar(getErrorMessage(error), 'error');
    } finally {
      setOverlayProcessing(undefined);
    }
  };

  /** Unseen prompt: submit mined transfers to the overlay, rebroadcast unfinished ones, drop dead ones, send again. */
  const handleFixUnseenAndSend = async () => {
    if (!overlayPrompt) return;
    const { recipients: rs, total } = overlayPrompt;
    setOverlayProcessing('Sending your tokens to the indexer...');
    try {
      const res = await sendMessageAsync<{ success: boolean; error?: string; data?: UnseenHealReport }>({
        action: 'BSV21_FIX_UNSEEN',
        tokenId: token.info.id,
      });
      if (!res?.success || !res.data) {
        addSnackbar(res?.error ?? "Couldn't fix this. Try Settings › Troubleshooting › Repair Sync.", 'error');
        return;
      }
      const d = res.data;
      const changed = d.submitted.length + d.rebroadcast.length + d.dropped.length > 0;
      addSnackbar(describeUnseenHeal(d), changed ? 'success' : 'info');
      if (d.submitted.length || d.rebroadcast.length) {
        // The overlay validates a submitted transfer in a moment.
        setOverlayProcessing('Waiting for the indexer...');
        await new Promise((r) => setTimeout(r, 4000));
      }
      setOverlayProcessing('Sending...');
      await runSend(rs, total, true);
    } catch (error) {
      addSnackbar(getErrorMessage(error), 'error');
    } finally {
      setOverlayProcessing(undefined);
    }
  };

  const handleRetrySend = async () => {
    if (!overlayPrompt) return;
    const { recipients: rs, total } = overlayPrompt;
    setOverlayProcessing('Sending...');
    try {
      await runSend(rs, total, true);
    } finally {
      setOverlayProcessing(undefined);
    }
  };

  const handleSendUnverified = async () => {
    if (!overlayPrompt) return;
    setOverlayProcessing('Checking your token keys...');
    try {
      // Never sign with a record whose key doesn't match its output: the unlock would be empty (5.2.25, SCAM).
      const keys = await sendMessageAsync<{ success: boolean; data?: UnseenHealReport }>({
        action: 'BSV21_FIX_UNSEEN',
        tokenId: token.info.id,
        keysOnly: true,
      }).catch(() => undefined);
      if (keys?.data && (keys.data.keysRepaired || keys.data.keysDropped)) addSnackbar(describeUnseenHeal(keys.data), 'info');
      setOverlayProcessing('Sending...');
      await runSend(overlayPrompt.recipients, overlayPrompt.total, false);
    } finally {
      setOverlayProcessing(undefined);
    }
  };

  const gray = theme.color.global.gray;
  const contrast = theme.color.global.contrast;
  const row = theme.color.global.row;
  const accent = theme.color.component.primaryButtonLeftGradient;
  const tokenName = getTokenName(token.info);
  const shownIcon = tokenIconUrl(token.info.id, tokenName, token.info.icon);

  const anyRecipientEmpty = recipients.some((r) => !r.address || !r.amountInput);
  // Group send: the running total across every recipient; Send stays off while it exceeds the balance.
  const groupTotal = recipients.reduce<bigint | null>((acc, r) => {
    if (acc === null || !r.amountInput) return acc;
    const a = toAtomic(r.amountInput);
    return a === null ? null : acc + a;
  }, 0n);
  const overBalance = groupTotal !== null && groupTotal > maxAmount;
  const submitDisabled = isProcessing || anyRecipientEmpty || overBalance;

  return (
    <Show when={token !== null}>
      {token ? (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ type: 'spring', stiffness: 320, damping: 35 }}
          className="flex flex-col w-full pt-14 overflow-y-auto bw-dock-pad overflow-x-hidden self-start"
          style={{ height: '100%', backgroundColor: theme.color.global.walletBackground }}
        >
          {/* Header */}
          <div className="flex items-center gap-3 px-4 mb-5">
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => {
                resetSendState();
                onBack();
              }}
              className="flex h-8 w-8 items-center justify-center rounded-lg flex-shrink-0 outline-none border-none cursor-pointer"
              style={{ backgroundColor: 'var(--bw-surface)' }}
            >
              <ArrowLeft size={16} style={{ color: '#FFFFFF' }} />
            </motion.button>
            <span className="text-base font-bold" style={{ color: contrast }}>
              Send {tokenName}
            </span>
          </div>

          <TokenIconHeader
            tokenId={token.info.id}
            ticker={tokenName}
            onchain={shownIcon}
          />
          {/* Balance chip — matches the BSV / MNEE send views */}
          <div className="flex flex-col items-center w-full mb-5 gap-1.5">
            <div className="flex items-center gap-2 px-4 py-2 rounded-full" style={{ background: row }}>
              <img src={shownIcon} alt={tokenName} className="w-4 h-4 rounded-full object-cover flex-shrink-0" />
              <span className="text-xs" style={{ color: gray }}>
                Balance
              </span>
              <span className="text-sm font-semibold font-mono" style={{ color: contrast }}>
                {maxDisplay}
              </span>
              <span className="text-xs font-semibold" style={{ color: accent }}>
                {tokenName}
              </span>
            </div>

            {/* Token ID copy chip, with the overlay status when it needs attention */}
            <div className="flex items-center gap-1.5">
              <Show when={!!token.info.id}>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={handleCopyId}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-full border-0 outline-none cursor-pointer"
                  style={{ background: `${gray}12` }}
                  title="Copy token ID"
                >
                  {copied ? <Check size={10} style={{ color: accent }} /> : <Copy size={10} style={{ color: gray }} />}
                  <span className="text-[10px] font-mono" style={{ color: gray }}>
                    {truncate(token.info.id, 8, 6)}
                  </span>
                </motion.button>
              </Show>

              <Show when={overlayStatus !== null}>
                {(() => {
                  const color = overlayStatus === 'active' ? OK : overlayStatus === 'inactive' ? WARN : gray;
                  const label =
                    overlayStatus === 'active'
                      ? `Indexed${overlayFunds ? ` · ${formatBsvAmount(overlayFunds.balance)}` : ''}`
                      : overlayStatus === 'inactive'
                        ? 'Indexer not funded'
                        : 'Indexer offline';
                  const title =
                    overlayStatus === 'active'
                      ? `The ${tokenName} indexer is funded and active. Its balance pays for checking future transfers.`
                      : overlayStatus === 'inactive'
                        ? `The ${tokenName} indexer is not funded, so it cannot check your tokens before you send them`
                        : "Couldn't reach the token indexer";
                  return (
                    <div
                      className="flex items-center gap-1 px-2.5 py-1 rounded-full"
                      style={{ background: `${color}1A` }}
                      title={title}
                    >
                      {overlayStatus === 'active' ? (
                        <Check size={10} style={{ color }} />
                      ) : (
                        <AlertTriangle size={10} style={{ color }} />
                      )}
                      <span className="text-[10px] font-semibold" style={{ color }}>
                        {label}
                      </span>
                    </div>
                  );
                })()}
              </Show>
            </div>
            <Show when={!!token.info.id}>
              <IssuerBadge tokenId={token.info.id} />
            </Show>
          </div>

          {/* Market chart */}
          <Show when={!!token.info.id}>
            <div className="mx-4 mb-5 rounded-2xl p-4" style={{ background: row }}>
              <PriceChart tokenId={token.info.id} />
            </div>
          </Show>

          {/* Pay to index (any holder), only when the 1Sat overlay says it's needed */}
          <Show when={!!token.info.id}>
            <TokenIndexButton tokenId={token.info.id!} ticker={tokenName} />
          </Show>

          {HOLDER_DROP_ENABLED && HolderDropSheet && !!token.info.id && (
            <div className="mx-4 mb-4 flex items-center justify-between gap-2 rounded-2xl px-4 py-3" style={{ background: row }}>
              <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: '#98A2B3' }}>
                Issuer tools
              </span>
              <button
                type="button"
                onClick={() => setDropping(true)}
                className="rounded-lg px-3 py-1.5 text-xs font-bold border-0 cursor-pointer"
                style={{ background: 'rgb(var(--bw-accent-rgb)/0.13)', color: 'var(--bw-accent)' }}
              >
                Airdrop to holders
              </button>
            </div>
          )}

          {/* Send form */}
          <form noValidate onSubmit={(e) => handleSendBSV21(e)} className="flex flex-col w-full px-4 gap-3">
            {composing && (<>
            {/* Recipient cards */}
            <AnimatePresence>
              {recipients.map((recipient, idx) => (
                <motion.div
                  key={recipient.id}
                  initial={{ opacity: 0, y: 12, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.96 }}
                  transition={{ duration: 0.22, ease: 'easeOut' }}
                  className="w-full rounded-2xl p-4 flex flex-col gap-3"
                  style={{ background: row }}
                >
                  {/* Card header */}
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: gray }}>
                      {recipients.length > 1 ? `Recipient ${idx + 1}` : 'Recipient'}
                    </span>
                    {recipients.length > 1 && (
                      <motion.button
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        type="button"
                        onClick={() => removeRecipient(recipient.id)}
                        className="flex items-center justify-center w-6 h-6 rounded-full border-0 outline-none cursor-pointer"
                        style={{ background: '#ff444415', color: '#ff4444' }}
                      >
                        <Trash2 size={12} />
                      </motion.button>
                    )}
                  </div>

                  {/* Address input */}
                  <Input
                    theme={theme}
                    placeholder="Enter address..."
                    type="text"
                    onChange={(e) => updateRecipient(recipient.id, 'address', e.target.value)}
                    value={recipient.address}
                    style={{ width: '100%', margin: 0 }}
                  />

                  {/* Amount + MAX */}
                  <div
                    className="flex items-center w-full rounded-xl border"
                    style={{ backgroundColor: row, borderColor: gray + '40' }}
                  >
                    <input
                      placeholder="0"
                      type="text"
                      inputMode="decimal"
                      className="flex-1 bg-transparent h-9 px-4 text-sm outline-none border-none"
                      style={{
                        color: contrast,
                        fontFamily: "'Inter', Arial, Helvetica, sans-serif",
                      }}
                      value={recipient.amountInput}
                      onChange={(e) => updateRecipient(recipient.id, 'amountInput', e.target.value)}
                    />
                    {recipients.length === 1 && (
                      <motion.button
                        type="button"
                        whileTap={{ scale: 0.93 }}
                        onClick={() => handleSetMax(recipient.id)}
                        className="flex items-center gap-1 px-2.5 py-1.5 mr-1.5 rounded-lg border-0 outline-none cursor-pointer shrink-0"
                        style={{ background: `color-mix(in srgb, ${accent} 9%, transparent)` }}
                        title="Fill with remaining available amount"
                      >
                        <span className="text-[11px] font-bold" style={{ color: accent }}>
                          MAX
                        </span>
                      </motion.button>
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>

            <GroupSendBar
              recipients={recipients}
              setRecipients={setRecipients}
              total={groupTotal}
              max={maxAmount}
              fmt={(a) => showAmount(a, token.info.dec)}
              ticker={tokenName}
              newRecipient={newRecipient}
            />
            {/* Add recipient */}
            <motion.button
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.98 }}
              type="button"
              onClick={addRecipient}
              className="flex items-center justify-center gap-2 w-full py-3 rounded-2xl border-0 outline-none cursor-pointer"
              style={{
                background: `color-mix(in srgb, ${accent} 6%, transparent)`,
                border: `1px dashed color-mix(in srgb, ${accent} 25%, transparent)`,
              }}
            >
              <Plus size={14} style={{ color: accent }} />
              <span className="text-sm font-semibold" style={{ color: accent }}>
                Add Recipient
              </span>
            </motion.button>
            <NoteField value={note} onChange={setNote} />

            </>)}

            {/* Action buttons */}
            <div className="flex gap-2 mt-1">
              {SELL_ENABLED && maxAmount > 0n && (
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  type="button"
                  onClick={() => setSelling(true)}
                  className="flex items-center justify-center gap-2 flex-1 h-11 rounded-xl text-sm font-bold outline-none border cursor-pointer"
                  style={{ backgroundColor: 'var(--bw-surface)', borderColor: '#3a2f0c', color: 'var(--bw-accent-hi)' }}
                >
                  <Tag size={14} />
                  Sell
                </motion.button>
              )}
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                type="button"
                onClick={() => window.open(`${ONE_SAT_MARKET_URL}/bsv21/${token.info.id}`, '_blank')}
                className="flex items-center justify-center gap-2 flex-1 h-11 rounded-xl text-sm font-bold outline-none border cursor-pointer"
                style={{
                  backgroundColor: theme.color.global.walletBackground,
                  borderColor: gray + '40',
                  color: contrast,
                }}
              >
                <ShoppingCart size={14} />
                Trade
              </motion.button>
              <motion.button
                whileHover={!(composing && submitDisabled) ? { scale: 1.02 } : undefined}
                whileTap={!(composing && submitDisabled) ? { scale: 0.98 } : undefined}
                type={composing ? 'submit' : 'button'}
                onClick={composing ? undefined : () => setComposing(true)}
                disabled={composing && submitDisabled}
                className="flex items-center justify-center gap-2 flex-1 h-11 rounded-xl text-sm font-bold outline-none border cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                // Same look as Buy · Sell · Chat (owner, 4 Oct 2026).
                style={{ backgroundColor: 'var(--bw-surface)', borderColor: '#3a2f0c', color: 'var(--bw-accent-hi)' }}
              >
                <Send size={14} />
                {isProcessing ? 'Sending...' : 'Send'}
              </motion.button>
            </div>
          </form>

          <Show when={!!token.info.id}>
            <div className="w-full px-4">
              <CoinHistory
                filter={{
                  type: 'bsv21',
                  tokenId: token.info.id!,
                  decimals: token.info.dec,
                  symbol: token.info.sym,
                }}
                refreshKey={successTxId}
              />
            </div>
          </Show>
        </motion.div>
      ) : (
        <></>
      )}
      <SendConfirmation
        show={!!sendConfirmation}
        theme={theme}
        icon={sendConfirmation?.icon}
        lineItems={sendConfirmation?.lineItems ?? []}
        total={sendConfirmation?.total}
        isProcessing={isProcessing}
        onConfirm={() => sendConfirmation?.onConfirm()}
        onCancel={() => setSendConfirmation(null)}
      />
      {HOLDER_DROP_ENABLED && HolderDropSheet && dropping && token.info.id && (
        <Suspense fallback={null}>
          <HolderDropSheet
            token={{ id: token.info.id, dec: token.info.dec, symbol: tokenName }}
            heldRaw={maxAmount}
            onClose={() => setDropping(false)}
          />
        </Suspense>
      )}
      {SELL_ENABLED && selling && token && (
        <SellSheet
          target={{ tokenId: token.info.id, symbol: getTokenName(token.info), dec: token.info.dec, heldRaw: maxAmount }}
          onClose={() => setSelling(false)}
          onListed={(amt) => void onBack(amt)}
        />
      )}
      <Bsv21OverlayPrompt
        show={!!overlayPrompt}
        theme={theme}
        issue={overlayPrompt?.issue ?? 'not-active'}
        tokenName={tokenName}
        fundingSats={overlayPrompt?.fundingSats}
        fundingCovers={overlayPrompt?.fundingCovers}
        fundingError={overlayPrompt?.fundingError}
        processingMessage={overlayProcessing}
        onFund={(sats) => void handleFundOverlay(sats)}
        onRetryFunding={() => void handleRetryFunding()}
        onFixAndSend={() => void (overlayPrompt?.issue === 'unseen' ? handleFixUnseenAndSend() : handleFixAndSend())}
        unseenOutpoints={overlayPrompt?.issue === 'unseen' ? unseenOutpoints : undefined}
        onRetry={() => void handleRetrySend()}
        onSendUnverified={() => setConfirmUnverified(true)}
        onCancel={() => setOverlayPrompt(null)}
      />
      <SpeedBump
        theme={theme}
        showSpeedBump={confirmUnverified}
        message={`Sending unverified skips the check that your ${tokenName} are valid. If any token this transfer spends is invalid, the whole transfer is invalid and every token in it is permanently lost, including the valid ones. Only continue if you trust where these tokens came from.`}
        onCancel={() => setConfirmUnverified(false)}
        onConfirm={() => {
          setConfirmUnverified(false);
          void handleSendUnverified();
        }}
      />
    </Show>
  );
};
