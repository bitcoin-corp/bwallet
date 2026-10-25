import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AGENT_HANDOFF_EVENT, takeAgentDraft, takeAgentNote, takeAgentSend } from './handoff';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Flag, Loader2, X } from 'lucide-react';
import { sendBsv } from '../../utils/guardedSendBsv';
import { useBackClose } from '../backStack';
import { useFloatingBarReserve } from '../ui/floatingBars';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getErrorMessage } from '../../utils/tools';
import { fetchExchangeRate } from '../../utils/wallet';
import { ChatApiError, saveSession, type BchatClient } from '../chat/api';
import { kycClient, signedInClient } from '../kyc/kycWallet';
import { oneClick } from '../settings/oneClick';
import {
  ASK_B_FREE,
  ASK_B_FREE_TEXT,
  MAX_INPUT,
  SECRET_WARNING,
  looksLikeSecret,
  transcript,
  type AgentMessage,
} from './agent';
import { BWALLET_GUIDE } from './guide';
import { PROVIDERS, callProvider } from './providers';
import { loadKey } from './keyStore';
import { KeyScreen } from '../settings/AgentSettings';
import { limitSats, loadSpend, recordSpend, spentToday, useAgentPrefs } from './agentPrefs';
import {
  FREE_CAP_CODE,
  FREE_REST_TEXT,
  NOT_YET_RETRY_MS,
  bitsignPaidBackend,
  freeFallbackReply,
  formatPrice,
  payDecision,
  refuseText,
  type PaidBackend,
  type PriceInfo,
  noKeyReply,
  paymentFailedText,
  reportToB,
  type ReportResult,
} from './paid';
import { enqueueReport, failureReason, logQueued, outboxText } from './reportOutbox';
import { BCREDITS_ENABLED, MARKET_ENABLED, STORE_BUILD } from '../storeBuild';
import { useAgentCredits, type AgentCredits } from '../credits/useAgentCredits';

/** Store build: never routes b to bCredits (the literal flag drops useAgentCredits from the bundle). */
const useNoAgentCredits = (_withClient: unknown, _ready: boolean): AgentCredits => ({
  route: async () => 'other',
  run: () => Promise.reject(new Error('Not available')),
  lowText: () => null,
  low: false,
  setLow: () => {},
});
const useCreditsForB = BCREDITS_ENABLED ? useAgentCredits : useNoAgentCredits;
import { agentAccountPrompt, parseActions, runAgentAction } from '../agents/agentTrade';
import { consentTarget, grantConsent, hasConsent } from './consent';
import { ConsentSheet } from './ConsentSheet';
import { ObsidianHero } from './ObsidianHero';
import { AskBar } from './AskBar';
import { loadThread, saveThread, screenContext } from './thread';
import { useBWeb } from '../bweb/useBWeb';
import { bwebContext } from '../bweb/bweb';
import { FINAL_CODES, clearPending, errorCode, finalText, loadPending, savePending, type PendingPaid } from './pending';
import { ReportSheet } from '../ugc/UgcSheets';

/** Store build: no paid endpoints are ever called (own key only, storeBuild.ts). */
const storeNoPaid: PaidBackend = {
  price: () => Promise.reject(new Error('Use your own AI provider key')),
  quote: () => Promise.reject(new Error('Use your own AI provider key')),
  turn: () => Promise.reject(new Error('Use your own AI provider key')),
  free: () => Promise.reject(new Error('Use your own AI provider key')),
};
import { money } from '../money/money';

/**
 * The b agent conversation (status, messages, composer). Shown on the full page (/m/ask-b, AgentPage.tsx).
 * Helps people use bWallet (guide.ts).
 * Either the user's own provider key (direct from the device) or bCorp's service: free for now
 * (ASK_B_FREE, bit-sign /agent/free with a daily cap), else pay per message in BSV (paid.ts). See agent.ts.
 */
const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

/**
 * A paid message whose payment went out but whose answer did not come back: retried, never re-paid.
 * Also saved on the device (pending.ts) so a reload or app restart resumes it (owner, 6 Oct 2026).
 */
const MUTED_X = '#98A2B3';
const NUDGE_KEY = 'bwallet.agent.keyNudgeDismissed';
/** The own-key nudge, once dismissed, stays hidden for that account on this device. */
const keyNudgeDismissed = (account: string | null | undefined) => {
  try {
    return !!account && !!JSON.parse(localStorage.getItem(NUDGE_KEY) || '{}')[account];
  } catch {
    return false;
  }
};
const dismissKeyNudge = (account: string | null | undefined) => {
  if (!account) return;
  try {
    const v = JSON.parse(localStorage.getItem(NUDGE_KEY) || '{}');
    localStorage.setItem(NUDGE_KEY, JSON.stringify({ ...(v && typeof v === 'object' ? v : {}), [account]: true }));
  } catch {
    /* storage unavailable: it shows again next time */
  }
};

/** `beef`: the signed payment, kept in memory only (not persisted) and sent with the turn. */
type Unanswered = PendingPaid & { txid: string; beef?: string };

const ConfirmSheet = ({
  sats,
  bsvUsd,
  usd,
  onPay,
  onCancel,
}: {
  sats: number;
  bsvUsd: number;
  usd: number | null;
  onPay: () => void;
  onCancel: () => void;
}) => {
  useBackClose(true, onCancel);
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-full rounded-t-3xl p-5"
        style={{
          background: PANEL,
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'max(env(safe-area-inset-bottom), 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-base font-bold text-white">Pay for this message?</p>
        <p className="mt-1 text-sm" style={{ color: MUTED }}>
          {formatPrice(sats, bsvUsd, usd)} from this wallet, plus a small network fee.
        </p>
        {(usd !== null || bsvUsd > 0) && (
          <p className="mt-0.5 text-[11px]" style={{ color: MUTED, opacity: 0.7 }}>
            Paid as {sats.toLocaleString('en-US')} sats
          </p>
        )}
        <button
          onClick={onPay}
          className="mt-4 w-full rounded-2xl py-3 text-sm font-bold"
          style={{ background: GOLD, color: '#1a1300' }}
        >
          Pay and send
        </button>
        <button onClick={onCancel} className="mt-2 w-full py-2 text-sm" style={{ color: MUTED }}>
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
};

/**
 * Quick starts above the composer (bWalletX only, owner 5 Oct 2026): each fills in a prompt the user can edit
 * before sending, so nothing is paid for until they tap Send. Only things b's guide covers (guide.ts MAKING_THINGS);
 * sentence case, no near-duplicates (owner, 14 Oct 2026).
 */
const QUICK_STARTS: { label: string; prompt: string }[] = [
  {
    label: 'Launch a coin',
    prompt: 'Help me launch my own coin. Ask me for its name, ticker, supply and what it is for.',
  },
  {
    label: 'List my app as a bApp',
    prompt:
      'Help me list my app as a bApp with its own token. Ask me for the app name, its website and what the token should do.',
  },
  {
    label: 'Create a strategy',
    prompt: 'Help me create a strategy. Ask me what I want it to do, which tokens, my budget and when it should stop.',
  },
  {
    label: 'Buy or sell a strategy',
    prompt:
      'Help me buy or sell a strategy on Exchange › Contracts › Strategies: compare listings, or fill in the listing spec for mine and suggest a price.',
  },
];

export const AgentConversation = ({
  compact = false,
  autoFocus = false,
  variant = 'page',
  screen,
}: {
  compact?: boolean;
  autoFocus?: boolean;
  /** 'page' = /m/ask-b; 'float' = the bar + dismissable bubbles over every Desktop page (owner, 12 Oct 2026). */
  variant?: 'page' | 'float';
  /** The route the user is on, told to b so answers fit the screen. */
  screen?: string;
}) => {
  const float = variant === 'float';
  const navigate = useNavigate();
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const accountId = account?.addresses.identityAddress;
  // bWalletX only: in an agent account b may act, within the account's limits and loaded strategy (agents/agentTrade.ts).
  const baseSystem = MARKET_ENABLED
    ? BWALLET_GUIDE + agentAccountPrompt(accountId, account?.name || 'Agent account')
    : BWALLET_GUIDE;
  // bWeb (Settings › bWeb): the screen line only if allowed, plus the Ask b add-ons you switched on.
  const [bweb] = useBWeb();
  const system = baseSystem + (bweb.privacy.shareScreen ? screenContext(screen) : '') + bwebContext(bweb);
  const [prefs, setPrefs] = useAgentPrefs();
  const [keyScreen, setKeyScreen] = useState(false);
  // Shared with the floating bar / full page (thread.ts), so "Open full chat" carries the conversation over.
  const [messages, setMessages] = useState<AgentMessage[]>(() => loadThread(accountId));
  useEffect(() => saveThread(accountId, messages), [accountId, messages]);
  // A request handed over from elsewhere (e.g. Mint › Contracts) arrives typed in, ready to send (page only).
  const [input, setInput] = useState(() => (float ? '' : takeAgentDraft()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [price, setPrice] = useState<PriceInfo | null>(null);
  const [rate, setRate] = useState(0);
  const [keyReady, setKeyReady] = useState<boolean | null>(null);
  const [confirm, setConfirm] = useState<{ sats: number; resolve: (ok: boolean) => void } | null>(null);
  const [unanswered, setUnanswered] = useState<Unanswered | null>(null);
  /** Shown while a saved paid answer is fetched after a reload, then "ready". */
  // Hold the b to talk (phone/Dock.tsx): a short note when voice didn't work.
  const [notice, setNotice] = useState<string | null>(() => (float ? null : takeAgentNote() || null));
  // …or the spoken request, to send once the price / key status is known. Same send() as typing.
  const [autoSend, setAutoSend] = useState(() => !float && takeAgentSend());
  // Already open when the b was held: take the handoff now (a fresh mount took it above).
  useEffect(() => {
    if (float) return;
    const onHandoff = () => {
      const draft = takeAgentDraft();
      const note = takeAgentNote();
      if (draft) setInput(draft);
      if (note) setNotice(note);
      if (takeAgentSend()) setAutoSend(true);
    };
    window.addEventListener(AGENT_HANDOFF_EVENT, onHandoff);
    return () => window.removeEventListener(AGENT_HANDOFF_EVENT, onHandoff);
  }, [float]);
  // Third-party AI consent (agent/consent.ts): asked before the first message to each provider.
  const [consentAsk, setConsentAsk] = useState<((ok: boolean) => void) | null>(null);
  const [reportingReply, setReportingReply] = useState<{ text: string; index: number } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const provider = PROVIDERS[prefs.provider];

  // Braces matter: newer WebViews return a Promise from scrollIntoView, which React would call as the cleanup.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  /** The signed-in bit-sign client, re-signing once with the wallet's key on a stale session. */
  const withClient = useCallback(
    async <T,>(fn: (c: BchatClient) => Promise<T>): Promise<T> => {
      if (!apiContext) throw new Error('Wallet is locked.');
      try {
        return await fn(await signedInClient(apiContext));
      } catch (e) {
        if (!(e instanceof ChatApiError) || e.status !== 401) throw e;
        saveSession(null);
        return fn(await signedInClient(apiContext, kycClient()));
      }
    },
    [apiContext],
  );
  const creditsForB = useCreditsForB(withClient, !!apiContext && !STORE_BUILD);
  const backend = useMemo(
    () =>
      STORE_BUILD
        ? storeNoPaid
        : bitsignPaidBackend((method, path, body) => withClient((c) => c.agentCall(method, path, body))),
    [withClient],
  );
  /** Free Ask b (agent.ts ASK_B_FREE): bCorp's mode sends no payment, no confirm, no bCredits. */
  const freeNow = ASK_B_FREE && prefs.mode !== 'own' && !STORE_BUILD;

  useEffect(() => {
    let live = true;
    setError(null);
    if (prefs.mode === 'own') {
      setKeyReady(null);
      void loadKey(prefs.provider).then((k) => live && setKeyReady(!!k));
    } else if (!freeNow) {
      setPrice(null);
      backend
        .price()
        .then((p) => live && setPrice(p))
        .catch(
          () =>
            live &&
            setPrice({
              enabled: false,
              usd: null,
              sats: 0,
              bsvUsd: 0,
              model: '',
              reason: 'Paid messages are not available right now.',
            }),
        );
    }
    // Both modes: paid prices show in dollars, and agent-account actions are sized in dollars.
    fetchExchangeRate('main')
      .then((r) => live && setRate(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [prefs.mode, prefs.provider, backend, freeNow]);

  const bsvUsd = price?.bsvUsd || rate;
  const askConfirm = (sats: number) => new Promise<boolean>((resolve) => setConfirm({ sats, resolve }));

  /** Ask for the answer with the quote + txid already paid. A failure that can never succeed clears the slot. */
  const answerPaid = async (u: Unanswered) => {
    setUnanswered(u);
    const { beef: _beef, ...persisted } = u;
    savePending(persisted);
    try {
      // A fresh payment can race the network: re-ask (same quote + txid, never a new payment) a couple of times first.
      let text = '';
      for (let i = 0; ; i++) {
        try {
          text = await backend.turn(u.quote, u.txid, u.messages, system, u.beef);
          break;
        } catch (e) {
          if (errorCode(e) !== 'tx_not_found' || i >= NOT_YET_RETRY_MS.length) throw e;
          await new Promise((r) => setTimeout(r, NOT_YET_RETRY_MS[i]));
        }
      }
      clearPending();
      setUnanswered(null);
      return text;
    } catch (e) {
      const code = errorCode(e);
      if (code && FINAL_CODES.has(code)) {
        clearPending();
        setUnanswered(null);
        throw new Error(finalText(code));
      }
      throw e;
    }
  };

  const runPaid = async (sent: AgentMessage[], shown: AgentMessage[]): Promise<string | null> => {
    if (!apiContext) throw new Error('Wallet is locked.');
    const quote = await backend.quote(sent);
    const decision = payDecision(
      quote.sats,
      limitSats(prefs.dailyLimitCents, bsvUsd),
      spentToday(loadSpend(), Date.now()),
      () => oneClick.take(quote.sats).ok,
    );
    if (decision.kind === 'refuse')
      throw new Error(refuseText(decision.reason, limitSats(prefs.dailyLimitCents, bsvUsd), bsvUsd));
    if (decision.kind === 'confirm' && !(await askConfirm(quote.sats))) return null;
    if (!accountId) throw new Error('Wallet is locked.');
    // Saved BEFORE paying, so a reload mid-payment is never silent (pending.ts).
    const pending: PendingPaid = { account: accountId, quote, txid: null, messages: sent, shown, at: Date.now() };
    savePending(pending);
    let res: Awaited<ReturnType<typeof sendBsv.execute>>;
    try {
      res = await sendBsv.execute(apiContext, { requests: [{ address: quote.payTo, satoshis: quote.sats }] });
    } catch (e) {
      clearPending();
      throw new Error(paymentFailedText(e));
    }
    if (!res.txid || res.error) {
      clearPending();
      const friendly = getErrorMessage(res.error);
      throw new Error(paymentFailedText(/unknown error/i.test(friendly) ? res.error : friendly));
    }
    recordSpend(quote.sats);
    const beef = res.tx?.length ? res.tx.map((b) => b.toString(16).padStart(2, '0')).join('') : undefined;
    return answerPaid({ ...pending, txid: res.txid, beef });
  };

  // On open: resume a paid message whose answer had not arrived (reload / app restart). Same quote + txid: never re-paid.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || !accountId || !apiContext || STORE_BUILD) return;
    resumed.current = true;
    const p = loadPending(accountId);
    if (!p) return;
    setMessages(p.shown);
    if (!p.txid) {
      clearPending();
      setError(
        'The app closed while paying for your last message. If a payment shows in Activity and no answer came, contact bCorp support for a refund.',
      );
      return;
    }
    const u: Unanswered = { ...p, txid: p.txid };
    setUnanswered(u);
    setBusy(true);
    setNotice('Getting your paid answer…');
    answerPaid(u)
      .then(async (reply) => {
        await answer(p.shown, reply);
        setNotice('Your paid answer is ready.');
      })
      .catch((e) => {
        setNotice(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, apiContext]);

  /** Pass a message to the team (bit-sign /agent/feedback). Offline or signed out: it waits in the outbox. */
  const tellTeam = async (text: string): Promise<ReportResult | { queued: string }> => {
    try {
      return await reportToB((m, p, b) => withClient((c) => c.agentCall(m, p, b)), text);
    } catch (e) {
      const reason = failureReason(e);
      logQueued(reason, e);
      enqueueReport(accountId, text, reason);
      return { queued: `${outboxText(reason)} You'll see it in Your reports as Waiting to send.` };
    }
  };

  /**
   * Free answer. When b's free allowance is used up (429 free_cap), or the server has no free path yet (404) or has
   * it switched off (503), the message still reaches the team as a report: never a payment prompt.
   */
  const runFree = async (sent: AgentMessage[], text: string): Promise<string> => {
    try {
      return await backend.free(sent, system);
    } catch (e) {
      const status = e instanceof ChatApiError ? e.status : 0;
      const capped = errorCode(e) === FREE_CAP_CODE;
      if (!capped && status !== 404 && status !== 503) throw e;
      const r = await tellTeam(text);
      return freeFallbackReply(
        capped ? (e instanceof Error && e.message) || FREE_REST_TEXT : null,
        'ack' in r ? r.ack : r.queued,
      );
    }
  };

  const runOwn = async (sent: AgentMessage[]) => {
    const key = await loadKey(prefs.provider);
    if (!key) throw new Error(`Add your ${provider.label} API key in Settings › b agent.`);
    return callProvider(prefs.provider, key, prefs.models[prefs.provider], system, sent);
  };

  /** Show a reply; in an agent account, run any actions it asked for and show each result. */
  const answer = async (before: AgentMessage[], reply: string) => {
    const { text, actions, bad } =
      !MARKET_ENABLED || baseSystem === BWALLET_GUIDE ? { text: reply, actions: [], bad: 0 } : parseActions(reply);
    let shown: AgentMessage[] = [...before, { role: 'assistant', text: text || 'Working on it.' }];
    setMessages(shown);
    if (bad)
      shown = [
        ...shown,
        { role: 'assistant', text: `⚙ Wallet: ignored ${bad} action${bad === 1 ? '' : 's'} it couldn't read.` },
      ];
    for (const a of actions) {
      let r: { ok: boolean; text: string; txid?: string };
      try {
        r =
          apiContext && accountId
            ? await runAgentAction(apiContext, accountId, a, bsvUsd)
            : { ok: false, text: 'Wallet is locked.' };
      } catch (e) {
        r = { ok: false, text: e instanceof Error ? e.message : String(e) };
      }
      shown = [
        ...shown,
        { role: 'assistant', text: `⚙ Wallet: ${r.text}${r.txid ? ` (tx ${r.txid.slice(0, 10)}…)` : ''}` },
      ];
      setMessages(shown);
    }
    setMessages(shown);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (looksLikeSecret(text)) {
      setInput('');
      setError(SECRET_WARNING);
      return;
    }
    // ⚠ Nothing leaves the phone for an AI provider the user has not allowed (Apple 5.1.2(i)).
    const target = prefs.mode === 'own' && keyReady === false ? 'paid' : consentTarget(prefs.mode, prefs.provider);
    if (!hasConsent(target)) {
      const ok = await new Promise<boolean>((resolve) => setConsentAsk(() => resolve));
      setConsentAsk(null);
      if (!ok) return;
      grantConsent(target);
    }
    const next: AgentMessage[] = [...messages, { role: 'user', text }];
    setMessages(next);
    setInput('');
    setError(null);
    setNotice(null);
    creditsForB.setLow(false);
    setBusy(true);
    try {
      // No key in own-key mode: b can't answer, but it still takes the message for the team (paid.ts reportToB).
      if (prefs.mode === 'own' && keyReady === false) {
        // Can't reach bit-sign (offline, signed out): the message waits in the outbox, never dropped.
        const r = await tellTeam(text);
        const reply = 'queued' in r ? r.queued : noKeyReply(r, provider.label);
        setMessages([...next, { role: 'assistant', text: reply }]);
        return;
      }
      const sent = transcript(next);
      if (freeNow) {
        await answer(next, await runFree(sent, text));
        return;
      }
      // bCredits first when there is a balance; once used, an empty balance asks for a top-up (never debt).
      const way = await creditsForB.route(prefs.mode !== 'own');
      if (way === 'low') {
        setMessages([...next, { role: 'assistant', text: creditsForB.lowText() ?? '' }]);
        creditsForB.setLow(true);
        return;
      }
      const reply =
        prefs.mode === 'own'
          ? await runOwn(sent)
          : way === 'credits'
            ? await creditsForB.run(sent, system)
            : await runPaid(sent, next);
      if (reply === null) {
        // Cancelled at the confirm step: nothing paid, put the text back.
        setMessages(messages);
        setInput(text);
      } else await answer(next, reply);
    } catch (e) {
      const low = creditsForB.lowText(e);
      if (low) {
        setMessages([...next, { role: 'assistant', text: low }]);
        creditsForB.setLow(true);
      } else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!unanswered || busy) return;
    setBusy(true);
    setError(null);
    try {
      const reply = await answerPaid(unanswered);
      await answer(unanswered.shown, reply);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const [nudgeHidden, setNudgeHidden] = useState(() => keyNudgeDismissed(accountId));
  useEffect(() => setNudgeHidden(keyNudgeDismissed(accountId)), [accountId]);
  const today = spentToday(loadSpend(), Date.now());
  const status = freeNow
    ? ASK_B_FREE_TEXT
    : prefs.mode === 'own'
      ? keyReady === false
        ? 'No AI key yet: what you type here goes to the team as feedback. Add a key in Settings › b agent for answers.'
        : `Your ${provider.label} key · ${prefs.models[prefs.provider]}`
      : price === null
        ? 'Checking the price…'
        : price.enabled
          ? `${formatPrice(price.sats, bsvUsd, price.usd)} per message · today ${money(today, bsvUsd)} / $${(prefs.dailyLimitCents / 100).toFixed(2)}`
          : (price.reason ?? 'Paid messages are not available yet.');
  // Own-key mode sends even without a key: the message goes to the team as feedback (reportToB).
  const canSend = freeNow || (prefs.mode === 'own' ? keyReady !== null : !!price?.enabled);
  const statusKnown = freeNow || (prefs.mode === 'own' ? keyReady !== null : price !== null);
  // Spoken request: sent through send() like a typed one, so consent, the price and the confirm step all apply.
  // If b can't take it (no key, paid off) it stays typed in the composer.
  useEffect(() => {
    if (!autoSend || busy || !statusKnown) return;
    setAutoSend(false);
    if (canSend && input.trim()) void send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSend, busy, statusKnown]);

  const onTranscript = (t: string) => {
    setNotice(null);
    setInput((prev) => (prev.trim() ? `${prev.trimEnd()} ${t}` : t).slice(0, MAX_INPUT));
  };
  const bar = (placement: 'float' | 'page') => (
    <AskBar
      value={input}
      onChange={setInput}
      onSend={() => void send()}
      canSend={!busy && canSend && !unanswered}
      onTranscript={onTranscript}
      onNote={setNotice}
      placement={placement}
      autoFocus={autoFocus}
      status={status}
      onFocus={() => setFloatHidden(false)}
    />
  );

  // Floating: dismissed bubbles hide here only; the thread (and /m/ask-b) keeps them.
  const [dismissed, setDismissed] = useState<Set<number>>(() => new Set(messages.map((_, i) => i)));
  const [floatHidden, setFloatHidden] = useState(false);
  const [notesHidden, setNotesHidden] = useState(false);
  useEffect(() => setNotesHidden(false), [error, notice]);
  useEffect(() => {
    if (!float) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFloatHidden(true);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [float]);
  useEffect(() => {
    if (float && busy) setFloatHidden(false);
  }, [float, busy]);
  const floatList = useRef<HTMLDivElement>(null);
  // The bar itself (not the dismissable reply bubbles above it) keeps the page's content clear of it.
  const floatBar = useRef<HTMLDivElement>(null);
  useFloatingBarReserve(floatBar);
  useEffect(() => {
    const el = floatList.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const sheets = (
    <>
      {consentAsk && (
        <ConsentSheet
          target={consentTarget(prefs.mode, prefs.provider)}
          onAllow={() => consentAsk(true)}
          onCancel={() => consentAsk(false)}
        />
      )}
      {confirm && (
        <ConfirmSheet
          sats={confirm.sats}
          bsvUsd={bsvUsd}
          usd={price?.usd && confirm.sats === price.sats ? price.usd : null}
          onPay={() => {
            confirm.resolve(true);
            setConfirm(null);
          }}
          onCancel={() => {
            confirm.resolve(false);
            setConfirm(null);
          }}
        />
      )}
    </>
  );

  if (float) {
    const visible = floatHidden ? [] : messages.map((m, i) => ({ m, i })).filter(({ i }) => !dismissed.has(i));
    const notes = !floatHidden && !notesHidden && (error || (notice && !busy));
    const any = visible.length > 0 || busy || !!notes || (!!unanswered && !busy);
    return (
      <div className={`askb-float${any || input ? '' : ' is-collapsed'}`}>
        {any && (
          <>
            <div className="askb-tools">
              <button type="button" onClick={() => navigate('/m/ask-b')}>
                Open full chat
              </button>
              <button
                type="button"
                onClick={() => {
                  setDismissed(new Set(messages.map((_, i) => i)));
                  setNotesHidden(true);
                }}
              >
                Clear all
              </button>
            </div>
            <div ref={floatList} className="askb-bubbles" aria-live="polite" aria-label="Replies from b">
              {visible.map(({ m, i }) => (
                <div key={i} className={`askb-bubble ${m.role === 'user' ? 'user' : 'b'}`}>
                  {m.text}
                  <button
                    type="button"
                    className="askb-x"
                    aria-label="Dismiss"
                    onClick={() => setDismissed((d) => new Set(d).add(i))}
                  >
                    ×
                  </button>
                </div>
              ))}
              {busy && (
                <div className="askb-bubble note">
                  <Loader2 size={12} className="animate-spin inline mr-1" /> {notice ?? 'b is thinking…'}
                </div>
              )}
              {notes && (
                <div className={`askb-bubble note${error ? ' err' : ''}`}>
                  {error ?? notice}
                  <button type="button" className="askb-x" aria-label="Dismiss" onClick={() => setNotesHidden(true)}>
                    ×
                  </button>
                </div>
              )}
              {unanswered && !busy && (
                <button type="button" className="askb-bubble note" onClick={() => void retry()}>
                  Paid — get the answer (no new payment)
                </button>
              )}
            </div>
          </>
        )}
        <div ref={floatBar}>{bar('float')}</div>
        {sheets}
      </div>
    );
  }

  const empty = messages.length === 0 && !busy;
  return (
    <div className="relative w-full flex-1 min-h-0 flex flex-col">
      {/* Empty chat: the pool fills the whole section, edge to edge, and the composer floats over it (owner, 12 Oct 2026). */}
      {empty && (
        <div className="absolute inset-0 z-0">
          <ObsidianHero
            compact={compact}
            extra={MARKET_ENABLED ? QUICK_STARTS : []}
            onPick={(prompt) => {
              setInput(prompt);
              document.querySelector<HTMLTextAreaElement>('[data-agent-input]')?.focus();
            }}
          />
        </div>
      )}
      {/* Own-key nudge (owner, 5 Oct 2026): most people never find Settings › b agent. With their own key, messages
          go from this device straight to their AI provider instead of through bCorp's paid service. */}
      {/* Shown until dismissed (✕), remembered per account on this device (owner, 8 Oct 2026: "a lot of text"). */}
      {(prefs.mode !== 'own' || keyReady === false) && !nudgeHidden && (
        <div
          className="relative z-10 shrink-0 w-full flex items-center"
          style={{ background: PANEL, borderBottom: `1px solid ${LINE}` }}
        >
          <button
            type="button"
            onClick={() => setKeyScreen(true)}
            className="flex-1 min-w-0 pl-4 py-1.5 text-[11px] font-semibold text-left border-0 bg-transparent"
            style={{ color: GOLD }}
          >
            More private: use your own AI key (Claude, OpenAI or OpenRouter). Messages go straight to them, not through
            us. Add it here ›
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setNudgeHidden(true);
              dismissKeyNudge(accountId);
            }}
            className="shrink-0 px-3 py-1.5 border-0 bg-transparent"
            style={{ color: MUTED_X }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {keyScreen && (
        <KeyScreen
          onBack={() => {
            setKeyScreen(false);
            void loadKey(prefs.provider).then((k) => {
              if (k) {
                setPrefs({ mode: 'own' });
                setKeyReady(true);
              }
            });
          }}
        />
      )}

      <div className="askb-pagepad relative z-10 flex-1 overflow-y-auto px-4 py-4">
        <div className="askb-thread mx-auto w-full flex flex-col gap-4">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className="max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap break-words"
                style={
                  m.role === 'user'
                    ? { background: GOLD, color: '#1a1300' }
                    : { background: PANEL, color: '#F2F2F0', border: `1px solid ${LINE}` }
                }
              >
                {m.text}
                {m.role === 'assistant' && (
                  <button
                    onClick={() => setReportingReply({ text: m.text, index: i })}
                    className="mt-1.5 flex items-center gap-1 text-[11px]"
                    style={{ color: MUTED }}
                    aria-label="Report response"
                  >
                    <Flag size={11} /> Report response
                  </button>
                )}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
              <Loader2 size={14} className="animate-spin" /> {notice ?? 'b is thinking…'}
            </div>
          )}
          {notice && !busy && (
            <p className="text-xs" style={{ color: GOLD }}>
              {notice}
            </p>
          )}
          {error && (
            <p className="text-xs" style={{ color: '#ff6b6b' }}>
              {error}
            </p>
          )}
          {BCREDITS_ENABLED && creditsForB.low && !busy && (
            <button
              onClick={() => {
                creditsForB.setLow(false);
                navigate('/m/credits');
              }}
              className="self-start rounded-full px-3 py-1 text-xs font-bold"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              Top up bCredits
            </button>
          )}
          {unanswered && !busy && (
            <button
              onClick={() => void retry()}
              className="self-start rounded-full px-3 py-1 text-xs font-bold"
              style={{ border: `1px solid ${GOLD}`, color: GOLD }}
            >
              Paid — get the answer (no new payment)
            </button>
          )}
          <div ref={endRef} />
        </div>
      </div>

      {MARKET_ENABLED && !input && !busy && messages.length > 0 && (
        <div className="askb-chips relative z-10 shrink-0 flex flex-wrap gap-1.5 px-3 pb-2">
          {QUICK_STARTS.map((q) => (
            <button
              key={q.label}
              type="button"
              onClick={() => setInput(q.prompt)}
              className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold"
              style={{
                border: `1px solid color-mix(in srgb, ${GOLD} 40%, transparent)`,
                color: GOLD,
                background: 'rgba(0,0,0,0.35)',
              }}
            >
              {q.label}
            </button>
          ))}
        </div>
      )}
      <div className="relative z-10 shrink-0">{bar('page')}</div>
      {/* Price / key status: a small, quiet line under the composer (owner, 14 Oct 2026: the full-width yellow banner
          was too loud). Tap for Settings. */}
      <button
        type="button"
        onClick={() => navigate('/m/settings')}
        className="askb-meta relative z-10 shrink-0 self-center max-w-full px-4 pb-2 text-[11px] leading-tight text-center border-0 bg-transparent overflow-hidden text-ellipsis whitespace-nowrap"
        style={{ color: MUTED }}
      >
        {status}
      </button>
      {reportingReply && (
        <ReportSheet
          title="Report this response"
          report={{
            kind: 'ai_response',
            target: `b-agent:${prefs.mode === 'paid' ? 'paid' : `${prefs.provider}/${prefs.models[prefs.provider]}`}`,
            content: reportingReply.text,
            details: `the user's message: ${messages[reportingReply.index - 1]?.text.slice(0, 1000) ?? ''}`,
          }}
          onClose={() => setReportingReply(null)}
        />
      )}
      {sheets}
    </div>
  );
};
