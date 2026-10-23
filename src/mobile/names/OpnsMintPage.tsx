import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { listOpns } from '@1sat/actions';
import { sendBsv } from '../../utils/guardedSendBsv';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { TopNav } from '../../components/TopNav';
import { useServiceContext } from '../../hooks/useServiceContext';
import { fetchExchangeRate, getWalletBalance } from '../../utils/wallet';
import { loadLastBalance } from '../wallet/balanceLoad';
import { fmtSats, fmtUsd, satsToUsd, useBsvUsd, usdToSats } from '../money/money';
import { ownedFromOutputs } from './accountName';
import { NODE_SCRIPT_ESTIMATE, PHONE_HASHRATE } from './GetYourName';
import { estimateMintFee } from './opnsMint';
import {
  ALLOWANCE_USED_UP,
  applySweep,
  checkNames,
  invalidReason,
  loadBatch,
  mintParam,
  newBatch,
  OPNS_FEE_ADDRESS,
  OPNS_FEE_USD_PER_NAME,
  orderForMinting,
  parseNameList,
  planBatch,
  remaining,
  runBatch,
  saveBatch,
  summarise,
  type BatchState,
  type NameCheck,
} from './opnsBatch';
import { formatEta, mineName } from './opnsRegister';
import { opnsTreeFor } from './opnsTree';
import { sweepDeadMints } from './opnsTxStatus';
import { walletTxStates } from '../media/unbroadcast';
import { MARKET_ENABLED } from '../storeBuild';
import { checkOpnsAvailability } from './names';
import { buyOpnsListing, listOpnsName } from './opnsBuy';
import {
  loadAutoList,
  OPNS_LIST_FEE_ESTIMATE,
  ownedForSale,
  saveAutoList,
  searchLabel,
  usdOrSats,
  type OwnedForSale,
} from './opnsSell';
import { OpnsSellSection } from './OpnsSellSection';
import { OpnsGiftSection } from './OpnsGiftSection';
import { OpnsBuySheet } from './OpnsSheets';
import { useOpnsVault } from './useOpnsVault';
import { OpnsVaultCounts, OpnsVaultSection } from './OpnsVaultSection';
import { isProtected, vaultCounts, vaultedInBatch } from './opnsVault';
import { nameTierUsd } from './store/tiers';

/**
 * bMint › OpNS names (Desktop / web: desktop.bwalletx.com/bmint/opns; old /opns-mint links redirect here).
 * Three steps: add names (drop a .txt, choose a file, or paste; ?mint=a,b,c pre-fills) → live check →
 * an itemised invoice with ONE gold button that opens the single approval sheet. Then the names are mined
 * one after another with the normal mint path; the queue is saved, so a closed window offers Resume.
 * See opnsBatch.ts. Selling (bWalletX only, not the store edition): Owned names lists the wallet's names for
 * $1 each (OpnsSellSection, opnsSell.ts), and a searched name that is taken but listed offers "Buy for $X".
 */
const f = (u: string, i?: RequestInit) => fetch(u, i);

const GOLD = 'var(--bw-accent-hi)';
const GOLD_DIM = 'rgb(var(--bw-accent-hi-rgb) / 0.14)';
const TEXT = '#f4f1e8';
const MUTED = 'rgba(244,241,232,0.58)';
const HAIR = 'rgba(255,255,255,0.08)';
const GREEN = '#3ddc84';
const RED = '#ff5a5a';
const CARD_BG = 'rgba(12,12,14,0.92)';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting',
  mining: 'Mining…',
  done: 'Minted',
  skipped: 'Skipped',
  mine: 'Already yours',
  error: 'Error',
};

/** Is a taken name listed for sale? (the latest location is an unspent OrdLock; names.ts) */
const listingOf = MARKET_ENABLED
  ? async (name: string) => {
      const a = await checkOpnsAvailability(f, name);
      return a.status === 'taken' && a.listing ? { outpoint: a.listing.outpoint, priceSats: a.listing.price } : null;
    }
  : undefined;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Gold mark for the empty state and the finished view: a name tag on a block (no grey placeholders). */
const GoldArt = ({ size = 96 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 96 96" aria-hidden="true" className="shrink-0">
    <defs>
      <linearGradient id="opns-g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="var(--bw-accent-hi)" />
        <stop offset="0.55" stopColor="var(--bw-accent-hi)" />
        <stop offset="1" stopColor="#B8860B" />
      </linearGradient>
    </defs>
    <rect x="8" y="8" width="80" height="80" rx="22" fill="#0b0b0d" stroke="url(#opns-g)" strokeWidth="2" />
    <path d="M26 58 48 36h18v18L44 76z" fill="none" stroke="url(#opns-g)" strokeWidth="3.5" strokeLinejoin="round" />
    <circle cx="59" cy="43" r="3.5" fill="url(#opns-g)" />
    <path d="M22 30h22M22 22h34" stroke="url(#opns-g)" strokeWidth="3" strokeLinecap="round" opacity="0.6" />
  </svg>
);

const Step = (p: { n: number; title: string; sub?: string; on: boolean; children: ReactNode }) => (
  <section
    className="rounded-2xl p-4 sm:p-5 flex flex-col gap-3"
    style={{ background: CARD_BG, border: `1px solid ${p.on ? 'rgb(var(--bw-accent-hi-rgb) / 0.28)' : HAIR}` }}
  >
    <header className="flex items-center gap-3">
      <span
        className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
        style={{ background: p.on ? GOLD : GOLD_DIM, color: p.on ? '#000' : GOLD }}
      >
        {p.n}
      </span>
      <div className="flex flex-col">
        <h2 className="m-0 text-[15px] font-semibold tracking-tight" style={{ color: TEXT }}>
          {p.title}
        </h2>
        {p.sub && (
          <span className="text-xs" style={{ color: MUTED }}>
            {p.sub}
          </span>
        )}
      </div>
    </header>
    {p.children}
  </section>
);

const goldBtn =
  'rounded-xl font-semibold border-0 cursor-pointer transition-[filter,transform] duration-150 ease-out hover:brightness-110 active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
const ghostBtn =
  'rounded-lg px-3 py-1.5 text-xs font-semibold cursor-pointer bg-transparent border-0 transition-colors duration-150 hover:bg-white/5 focus-visible:outline focus-visible:outline-2';

export const OpnsMintPage = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const identityAddress = account?.addresses?.identityAddress ?? '';
  const vault = useOpnsVault(identityAddress, account?.pubKeys?.identityPubKey);
  const rate = useBsvUsd();
  const [text, setText] = useState(() => mintParam(window.location.search));
  const [checks, setChecks] = useState<Record<string, NameCheck>>({});
  const [checking, setChecking] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [batch, setBatch] = useState<BatchState | null>(() => loadBatch(identityAddress));
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState('');
  const [drag, setDrag] = useState(false);
  const [paste, setPaste] = useState('');
  const [balance, setBalance] = useState<number | null>(() => loadLastBalance(identityAddress));
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const ownedRef = useRef<Set<string>>(new Set());
  const [owned, setOwned] = useState<OwnedForSale[]>([]);
  const [buy, setBuy] = useState<{ name: string; outpoint: string; priceSats: number } | null>(null);
  const [buying, setBuying] = useState('');
  // Auto-list each minted name for $1 (bWalletX only; remembered, on by default).
  const [autoList, setAutoListState] = useState(() => MARKET_ENABLED && loadAutoList());
  const setAutoList = (v: boolean) => {
    setAutoListState(v);
    saveAutoList(v);
  };
  const [retrying, setRetrying] = useState('');

  const parsed = useMemo(() => parseNameList(text), [text]);
  const ordered = useMemo(() => orderForMinting(parsed.names), [parsed.names]);
  const allChecked = ordered.length > 0 && ordered.every((n) => checks[n]);
  const plan = useMemo(
    () => (allChecked ? planBatch(ordered.map((n) => checks[n])) : null),
    [allChecked, ordered, checks],
  );
  const summary = plan ? summarise(plan, NODE_SCRIPT_ESTIMATE, PHONE_HASHRATE) : null;
  const perChar = estimateMintFee(NODE_SCRIPT_ESTIMATE);
  const feePerNameSats = OPNS_FEE_ADDRESS ? (usdToSats(OPNS_FEE_USD_PER_NAME, rate) ?? 0) : 0;
  const serviceSats = summary ? summary.toMint * feePerNameSats : 0;
  const toVault = plan
    ? vaultedInBatch(
        vault.state,
        plan.filter((p) => p.chars > 0).map((p) => p.name),
      )
    : [];
  const listFeeSats = summary && autoList ? (summary.toMint - toVault.length) * OPNS_LIST_FEE_ESTIMATE : 0;
  const totalSats = summary ? summary.feeSats + serviceSats + listFeeSats : 0;
  const usd = (sats: number) => {
    const v = satsToUsd(sats, rate);
    return v == null ? '' : `≈ ${fmtUsd(v)}`;
  };
  const shortfall = balance != null && summary ? Math.max(0, totalSats - balance) : 0;

  const refreshOwned = async () => {
    if (!apiContext) return ownedRef.current;
    try {
      const r = await listOpns.execute(apiContext, { includeTags: true, limit: 1000 });
      ownedRef.current = new Set(ownedFromOutputs(r.outputs).map((o) => o.name));
      setOwned(ownedForSale(r.outputs));
    } catch {
      /* keep the last known set */
    }
    return ownedRef.current;
  };
  const refreshBalance = () =>
    getWalletBalance()
      .then((s) => {
        if (Number.isFinite(s)) setBalance(s);
      })
      .catch(() => {});

  /**
   * Mints the network never received (13 Oct 2026, opnsTxStatus.ts): checked against WhatsOnChain on page load, on
   * Resume and before every name in a run; dead ones are evicted from the tree cache and their names go back to
   * pending. `withWallet` also asks the wallet which of its own actions failed (dead at once, no grace period).
   */
  const sweep = async (withWallet: boolean) => {
    let offChain: Set<string> | undefined;
    if (withWallet && apiContext)
      offChain = await walletTxStates(apiContext.wallet).then(
        (s) => s.offChain,
        () => undefined,
      );
    return sweepDeadMints(opnsTreeFor(identityAddress), f, { offChain });
  };
  /** Every address of every account in this wallet (agent accounts included): a name they own is ours, not "taken". */
  const myAddresses = () => {
    const out = new Set<string>();
    for (const a of chromeStorageService.getAllAccounts())
      for (const v of Object.values(a.addresses ?? {})) if (typeof v === 'string' && v) out.add(v);
    return out;
  };
  const takenBy = async (name: string) => {
    const a = await checkOpnsAvailability(f, name);
    return a.status === 'taken' && a.owner && myAddresses().has(a.owner)
      ? ('another-account' as const)
      : ('other' as const);
  };

  useEffect(() => {
    void refreshOwned();
    void refreshBalance();
    setBatch(loadBatch(identityAddress));
    let live = true;
    void sweep(true)
      .then((sw) => {
        if (!live || !sw.dead.length) return;
        setBatch((b) => {
          const next = b ? applySweep(b, sw, perChar) : b;
          if (next && next !== b) saveBatch(identityAddress, next);
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiContext, identityAddress]);
  useEffect(() => () => abort.current?.abort(), []);

  // Live check: new names are looked up shortly after they are added (so the ?mint= prefill checks at once).
  const key = ordered.join(',');
  useEffect(() => {
    const todo = ordered.filter((n) => !checks[n]);
    if (!todo.length || running) return;
    let live = true;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setChecking(true);
      setMsg('');
      try {
        const mine = await refreshOwned();
        // 8 lookups at a time; each result shows as it lands (batched into one render per frame).
        let pending: Record<string, NameCheck> = {};
        let raf = 0;
        const flush = () => {
          raf = 0;
          const add = pending;
          pending = {};
          if (live) setChecks((prev) => ({ ...prev, ...add }));
        };
        await checkNames(f, todo, (x) => mine.has(x), opnsTreeFor(identityAddress), {
          signal: ctl.signal,
          listingOf,
          onResult: (c) => {
            pending[c.name] = c;
            if (!raf) raf = requestAnimationFrame(flush);
          },
        });
        if (raf) cancelAnimationFrame(raf);
        flush();
      } catch {
        if (live) setMsg('Lookup failed. Check your connection; it tries again when the list changes.');
      } finally {
        if (live) setChecking(false);
      }
    }, 400);
    return () => {
      live = false;
      ctl.abort();
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, running]);

  const buyNow = async (b: { name: string; outpoint: string }) => {
    setBuy(null);
    setBuying(b.name);
    setMsg('');
    try {
      await buyOpnsListing(apiContext, b.outpoint, b.name);
      setMsg(`You bought ${b.name}. It shows under Owned names once indexed.`);
      setChecks((prev) => ({ ...prev, [b.name]: { name: b.name, state: 'mine' } }));
      void refreshOwned();
      void refreshBalance();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Purchase failed');
    } finally {
      setBuying('');
    }
  };

  const addText = (body: string) => setText((t) => (t.trim() ? `${t.trim()}\n${body}` : body));
  const addFiles = async (files: FileList | null | undefined) => {
    for (const file of Array.from(files ?? [])) addText(await file.text());
  };
  const removeName = (name: string) =>
    setText([...parsed.names, ...parsed.invalid].filter((n) => n !== name).join('\n'));
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
    else {
      const t = e.dataTransfer.getData('text/plain');
      if (t) addText(t);
    }
  };

  const payFee = OPNS_FEE_ADDRESS
    ? async () => {
        const sats = usdToSats(OPNS_FEE_USD_PER_NAME, await fetchExchangeRate('main'));
        if (!sats) throw new Error("Couldn't get the BSV price for the service fee. Resume in a minute.");
        const res = await sendBsv.execute(apiContext, { requests: [{ address: OPNS_FEE_ADDRESS, satoshis: sats }] });
        if (res.error || !res.txid) throw new Error(String(res.error ?? 'Service fee payment failed'));
        return res.txid;
      }
    : undefined;

  /** List a name we just minted: found in the wallet's own OPNS basket (its BEEF, no indexer), tier price at today's rate. */
  const listAfterMint = async (name: string) => {
    const r = await listOpns.execute(apiContext, { includeTags: true, limit: 1000 });
    const o = ownedForSale(r.outputs).find((x) => x.name === name);
    if (!o) throw new Error('not in the wallet yet');
    if (o.listedSats !== null) return '';
    // Tier price by length (store/tiers.ts); premium names are never auto-listed.
    const usd = nameTierUsd(name);
    if (usd === null) return '';
    const sats = usdToSats(usd, await fetchExchangeRate('main'));
    if (!sats) throw new Error("couldn't get the BSV price");
    return listOpnsName(apiContext, o.id, sats);
  };
  const retryList = async (name: string) => {
    if (!batch) return;
    setRetrying(name);
    const patch = (p: Partial<BatchState['items'][number]>) =>
      setBatch((b) => {
        if (!b) return b;
        const next = { ...b, items: b.items.map((i) => (i.name === name ? { ...i, ...p } : i)) };
        saveBatch(identityAddress, next);
        return next;
      });
    try {
      const txid = await listAfterMint(name);
      const it = batch.items.find((i) => i.name === name);
      patch({ listed: true, note: undefined, txids: txid && it ? [...it.txids, txid] : (it?.txids ?? []) });
      void refreshOwned();
    } catch (e) {
      patch({ listed: false, note: `Not listed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setRetrying('');
    }
  };

  const run = async (start: BatchState) => {
    const ctl = new AbortController();
    abort.current = ctl;
    setRunning(true);
    setMsg('');
    try {
      // Resume: first drop the mints the network never received, so their names are mined again, not waited on.
      const begin = applySweep(start, await sweep(true).catch(() => ({ dead: [], seen: [], unknown: [] })), perChar);
      if (begin !== start) {
        saveBatch(identityAddress, begin);
        setBatch(begin);
      }
      const r = await runBatch(
        {
          fetch: f,
          mine: (name, signal) =>
            mineName({ ctx: apiContext, fetch: f, tree: opnsTreeFor(identityAddress) }, name, signal, () => undefined),
          sweep: () => sweep(false),
          takenBy,
          payFee,
          afterMint: autoList ? listAfterMint : undefined,
          // Read at listing time (and from storage), so names vaulted after approval are skipped too.
          keep: (n) => isProtected(vault.current(), n),
          isMine: (n) => ownedRef.current.has(n),
          tree: opnsTreeFor(identityAddress),
          save: (s) => saveBatch(identityAddress, s),
          onUpdate: setBatch,
          perCharSats: perChar,
          perNameSats: feePerNameSats,
        },
        begin,
        ctl.signal,
      );
      if (r.stopped === 'error' && r.error === ALLOWANCE_USED_UP) setMsg(`${ALLOWANCE_USED_UP}.`);
      else if (r.stopped === 'error' && r.namesServer) setMsg(r.error ?? '');
      else if (r.stopped === 'error') setMsg(`Stopped: ${r.error}. Fix it, then Resume.`);
      else if (r.stopped === 'cancelled') setMsg('Paused. Characters already mined stay yours; Resume any time.');
      else if (r.stopped === 'finished' && remaining(r.state) > 0)
        setMsg('Some names are waiting for a mint to be indexed. Resume in about 10 minutes.');
      void refreshOwned();
      void refreshBalance();
    } finally {
      abort.current = null;
      setRunning(false);
    }
  };

  const approve = () => {
    if (!plan || !summary) return;
    setSheet(false);
    // The one approval is this batch's allowance: the invoice total (+10%), spent without further prompts.
    const b = newBatch(plan, totalSats);
    saveBatch(identityAddress, b);
    setBatch(b);
    void run(b);
  };

  const startOver = () => {
    saveBatch(identityAddress, null);
    setBatch(null);
    setText('');
    setChecks({});
    setMsg('');
  };

  const left = remaining(batch);
  const showProgress = !!batch && batch.items.length > 0;
  const finished = showProgress && !running && left === 0;
  const minted = batch?.items.filter((i) => i.status === 'done').map((i) => i.name) ?? [];
  const empty = !parsed.names.length && !parsed.invalid.length;
  const toMint = plan?.filter((p) => p.chars > 0) ?? [];
  const checkedCount = ordered.filter((n) => checks[n]).length;

  return (
    <div
      className="relative w-full h-full overflow-y-auto overscroll-contain"
      style={{ background: '#050506', paddingTop: '3.5rem', paddingBottom: 'calc(var(--dock-h, 3.75rem) + 96px)' }}
    >
      <TopNav />
      <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 pt-5 flex flex-col gap-4">
        <div className="flex items-start gap-4">
          <GoldArt size={56} />
          <div className="flex flex-col gap-1 min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: GOLD }}>
              bMint
            </span>
            <h1 className="m-0 text-2xl font-bold tracking-tight" style={{ color: TEXT }}>
              OpNS names
            </h1>
            <p className="m-0 text-[13px] leading-relaxed" style={{ color: MUTED }}>
              On-chain 1Sat names you own. Anyone can claim a name first, and network fees aren't refundable.
            </p>
          </div>
        </div>

        <OpnsVaultCounts counts={vaultCounts(vault.state, owned)} />

        {showProgress && (
          <section
            className="rounded-2xl p-4 sm:p-5 flex flex-col gap-3"
            style={{ background: CARD_BG, border: '1px solid rgb(var(--bw-accent-hi-rgb) / 0.28)' }}
          >
            {finished ? (
              <div className="flex flex-col items-center text-center gap-2 py-2">
                <GoldArt size={72} />
                <h2 className="m-0 text-lg font-semibold tracking-tight" style={{ color: TEXT }}>
                  {minted.length ? 'You now own' : 'Nothing new was minted'}
                </h2>
                {minted.length > 0 && (
                  <div className="flex flex-wrap justify-center gap-2">
                    {minted.map((n) => (
                      <span
                        key={n}
                        className="px-2.5 py-1 rounded-full text-xs font-semibold"
                        style={{ background: GOLD_DIM, color: GOLD }}
                      >
                        {n}
                      </span>
                    ))}
                  </div>
                )}
                <p className="m-0 text-xs" style={{ color: MUTED }}>
                  New names appear in your names list once indexed, usually within a few minutes.
                </p>
                <div className="flex gap-2 mt-1">
                  <Link
                    to="/settings"
                    className={`${goldBtn} px-4 py-2 text-sm no-underline`}
                    style={{ background: GOLD, color: '#000' }}
                  >
                    See your names
                  </Link>
                  <button
                    type="button"
                    className={ghostBtn}
                    style={{ color: GOLD, border: `1px solid ${HAIR}` }}
                    onClick={startOver}
                  >
                    Mint more
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-col">
                    <h2 className="m-0 text-[15px] font-semibold" style={{ color: TEXT }}>
                      {running ? 'Minting' : 'Paused'} · {batch.items.length - left} of {batch.items.length} done
                    </h2>
                    <span className="text-xs" style={{ color: MUTED }}>
                      Keep this window open. If it closes, come back here and Resume.
                    </span>
                  </div>
                  {running ? (
                    <button
                      type="button"
                      className={ghostBtn}
                      style={{ color: TEXT, border: `1px solid ${HAIR}` }}
                      onClick={() => abort.current?.abort()}
                    >
                      Pause
                    </button>
                  ) : (
                    <span className="flex gap-2">
                      <button type="button" className={ghostBtn} style={{ color: MUTED }} onClick={startOver}>
                        Clear
                      </button>
                      <button
                        type="button"
                        className={`${goldBtn} px-4 py-1.5 text-xs`}
                        style={{ background: GOLD, color: '#000' }}
                        onClick={() => void run(batch)}
                      >
                        Resume
                      </button>
                    </span>
                  )}
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: GOLD_DIM }}>
                  <div
                    className="h-full rounded-full transition-[width] duration-300 ease-out"
                    style={{ background: GOLD, width: `${((batch.items.length - left) / batch.items.length) * 100}%` }}
                  />
                </div>
              </>
            )}
            <ul className="m-0 p-0 list-none flex flex-col">
              {batch.items.map((it) => (
                <li
                  key={it.name}
                  className="flex items-start justify-between gap-3 py-2 text-[13px]"
                  style={{ borderTop: `1px solid ${HAIR}` }}
                >
                  <span className="font-medium break-all" style={{ color: TEXT }}>
                    {it.name}
                  </span>
                  <span className="flex flex-col items-end text-right shrink-0">
                    <span
                      style={{
                        color: it.status === 'done' ? GREEN : it.status === 'mining' ? GOLD : it.note ? RED : MUTED,
                      }}
                    >
                      {it.status === 'done' && it.listed === true
                        ? 'Minted · listed for $1'
                        : it.status === 'done' && it.listed === false
                          ? 'Minted · not listed'
                          : STATUS_LABEL[it.status]}
                      {it.note ? ` · ${it.note}` : ''}
                    </span>
                    {it.status === 'done' && it.listed === false && !running && (
                      <button
                        type="button"
                        className={ghostBtn}
                        style={{ color: GOLD, border: `1px solid ${HAIR}` }}
                        disabled={!!retrying}
                        onClick={() => void retryList(it.name)}
                      >
                        {retrying === it.name ? 'Listing…' : 'Retry listing'}
                      </button>
                    )}
                    {it.txids.map((t) => (
                      <a
                        key={t}
                        href={`https://whatsonchain.com/tx/${t}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] font-mono"
                        style={{ color: GOLD }}
                      >
                        {t.slice(0, 8)}…{t.slice(-6)}
                      </a>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!showProgress && (
          <>
            <Step n={1} title="Add names" sub="Drop a .txt list, choose a file, or paste names." on={empty}>
              <div
                role="button"
                tabIndex={0}
                aria-label="Drop a .txt list of names, or press to choose a file"
                onClick={() => fileInput.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click();
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={onDrop}
                className="rounded-2xl flex flex-col items-center justify-center gap-2 text-center cursor-pointer transition-colors duration-150 focus-visible:outline focus-visible:outline-2"
                style={{
                  minHeight: empty ? 200 : 112,
                  padding: 20,
                  border: `1.5px dashed ${drag ? GOLD : 'rgb(var(--bw-accent-hi-rgb) / 0.35)'}`,
                  background: drag ? 'rgb(var(--bw-accent-hi-rgb) / 0.08)' : 'rgb(var(--bw-accent-hi-rgb) / 0.03)',
                }}
              >
                {empty && <GoldArt size={64} />}
                <span className="text-sm font-semibold" style={{ color: TEXT }}>
                  {drag ? 'Drop to add' : 'Drop your .txt list here'}
                </span>
                <span className="text-xs" style={{ color: MUTED }}>
                  or <span style={{ color: GOLD }}>choose a file</span> · one name per line, or comma separated
                </span>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".txt,text/plain"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    void addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </div>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (paste.trim()) addText(paste);
                  setPaste('');
                }}
              >
                <input
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  onPaste={(e) => {
                    const t = e.clipboardData.getData('text');
                    if (/[\n,]/.test(t)) {
                      e.preventDefault();
                      addText(t);
                    }
                  }}
                  placeholder="Paste or type names, then Add"
                  aria-label="Paste or type names"
                  className="flex-1 min-w-0 rounded-xl px-3 py-2.5 text-sm outline-none focus-visible:ring-2"
                  style={{ background: '#0b0b0d', color: TEXT, border: `1px solid ${HAIR}` }}
                />
                <button
                  type="submit"
                  className={`${goldBtn} px-4 text-sm`}
                  style={{ background: GOLD_DIM, color: GOLD }}
                  disabled={!paste.trim()}
                >
                  Add
                </button>
              </form>
              {!empty && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: MUTED }}>
                      {plural(parsed.names.length, 'name')}
                      {parsed.invalid.length ? ` · ${parsed.invalid.length} can't be used` : ''}
                    </span>
                    <button type="button" className={ghostBtn} style={{ color: MUTED }} onClick={() => setText('')}>
                      Clear all
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {parsed.names.map((n) => (
                      <span
                        key={n}
                        className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full text-xs font-medium"
                        style={{ background: GOLD_DIM, color: GOLD }}
                      >
                        {n}
                        <button
                          type="button"
                          aria-label={`Remove ${n}`}
                          className="w-4 h-4 rounded-full border-0 bg-transparent cursor-pointer leading-none p-0 hover:bg-white/10"
                          style={{ color: GOLD }}
                          onClick={() => removeName(n)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    {parsed.invalid.map((n) => (
                      <span
                        key={`x-${n}`}
                        className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full text-xs font-medium"
                        style={{ background: 'rgba(255,90,90,0.12)', color: RED }}
                      >
                        {n} <span style={{ opacity: 0.75 }}>· {invalidReason(n)}</span>
                        <button
                          type="button"
                          aria-label={`Remove ${n}`}
                          className="w-4 h-4 rounded-full border-0 bg-transparent cursor-pointer leading-none p-0 hover:bg-white/10"
                          style={{ color: RED }}
                          onClick={() => removeName(n)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </Step>

            {ordered.length > 0 && (
              <Step
                n={2}
                title="Check"
                sub={
                  checking || !allChecked
                    ? `Looking up ${checkedCount} of ${ordered.length}…`
                    : 'Live on-chain status. Names that start the same reuse each other’s characters.'
                }
                on={!allChecked}
              >
                <ul className="m-0 p-0 list-none flex flex-col">
                  {ordered.map((n) => {
                    const p = plan?.find((x) => x.name === n);
                    const c = checks[n];
                    const st = c ? searchLabel(c, (sats) => usdOrSats(sats, rate), MARKET_ENABLED) : null;
                    const label = !c
                      ? 'Checking…'
                      : c.state === 'free' && c.domain === null
                        ? 'Free · try again later'
                        : (st?.label ?? '');
                    const color = !st
                      ? MUTED
                      : st.kind === 'taken'
                        ? RED
                        : st.kind === 'mine' || st.kind === 'buy'
                          ? GOLD
                          : c?.state === 'free' && c.domain === null
                            ? MUTED
                            : GREEN;
                    return (
                      <li
                        key={n}
                        className="flex items-center justify-between gap-3 py-2 text-[13px]"
                        style={{ borderTop: `1px solid ${HAIR}` }}
                      >
                        <span className="font-medium break-all" style={{ color: TEXT }}>
                          {n}
                        </span>
                        <span className="flex items-center gap-3 shrink-0">
                          {p && p.chars > 0 && (
                            <span className="text-xs tabular-nums" style={{ color: MUTED }}>
                              {plural(p.chars, 'char')} to mine
                            </span>
                          )}
                          {st?.kind === 'buy' && c?.state === 'taken' && c.listing ? (
                            <button
                              type="button"
                              className={`${goldBtn} px-3 py-1.5 text-xs`}
                              style={{ background: GOLD, color: '#000' }}
                              disabled={!apiContext || !!buying}
                              onClick={() =>
                                c.listing &&
                                setBuy({ name: n, outpoint: c.listing.outpoint, priceSats: c.listing.priceSats })
                              }
                            >
                              {buying === n ? 'Buying…' : label}
                            </button>
                          ) : (
                            <span className="font-semibold text-xs" style={{ color }}>
                              {label}
                            </span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Step>
            )}

            {plan && summary && (
              <Step n={3} title="Invoice" sub="What you pay, before anything is signed." on={summary.toMint > 0}>
                {summary.toMint === 0 ? (
                  <p className="m-0 text-[13px]" style={{ color: MUTED }}>
                    Nothing to mint: every name is taken or already yours. Add more names above.
                  </p>
                ) : (
                  <>
                    <table className="w-full text-[13px] border-collapse">
                      <thead>
                        <tr style={{ color: MUTED }}>
                          <th className="text-left font-medium pb-2 text-xs">Name</th>
                          <th className="text-right font-medium pb-2 text-xs">Txs</th>
                          <th className="text-right font-medium pb-2 text-xs">Network fee</th>
                        </tr>
                      </thead>
                      <tbody>
                        {toMint.map((p) => (
                          <tr key={p.name} style={{ borderTop: `1px solid ${HAIR}` }}>
                            <td className="py-2 break-all" style={{ color: TEXT }}>
                              {p.name}
                            </td>
                            <td className="py-2 text-right tabular-nums" style={{ color: MUTED }}>
                              {p.chars}
                            </td>
                            <td className="py-2 text-right tabular-nums" style={{ color: TEXT }}>
                              {fmtSats(p.chars * perChar)}
                              <span className="block text-[11px]" style={{ color: MUTED }}>
                                {usd(p.chars * perChar)}
                              </span>
                            </td>
                          </tr>
                        ))}
                        {listFeeSats > 0 && (
                          <tr style={{ borderTop: `1px solid ${HAIR}` }}>
                            <td className="py-2" style={{ color: TEXT }} colSpan={2}>
                              Listing fee (est.) · {summary.toMint - toVault.length} × {fmtSats(OPNS_LIST_FEE_ESTIMATE)}
                            </td>
                            <td className="py-2 text-right tabular-nums" style={{ color: TEXT }}>
                              {fmtSats(listFeeSats)}
                              <span className="block text-[11px]" style={{ color: MUTED }}>
                                {usd(listFeeSats)}
                              </span>
                            </td>
                          </tr>
                        )}
                        {OPNS_FEE_ADDRESS && (
                          <tr style={{ borderTop: `1px solid ${HAIR}` }}>
                            <td className="py-2" style={{ color: TEXT }} colSpan={2}>
                              Service fee · ${OPNS_FEE_USD_PER_NAME} × {summary.toMint}
                            </td>
                            <td className="py-2 text-right tabular-nums" style={{ color: TEXT }}>
                              {feePerNameSats ? fmtSats(serviceSats) : '—'}
                              <span className="block text-[11px]" style={{ color: MUTED }}>
                                {fmtUsd(summary.toMint * OPNS_FEE_USD_PER_NAME)}
                              </span>
                            </td>
                          </tr>
                        )}
                      </tbody>
                      <tfoot>
                        <tr style={{ borderTop: '1px solid rgb(var(--bw-accent-hi-rgb) / 0.35)' }}>
                          <td className="pt-3 font-semibold" style={{ color: TEXT }}>
                            Total · {plural(summary.toMint, 'name')}
                          </td>
                          <td className="pt-3 text-right tabular-nums" style={{ color: MUTED }}>
                            {summary.chars}
                          </td>
                          <td className="pt-3 text-right tabular-nums font-bold" style={{ color: GOLD }}>
                            {fmtSats(totalSats)}
                            <span className="block text-xs font-medium" style={{ color: TEXT }}>
                              {usd(totalSats)}
                            </span>
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-xl p-3" style={{ background: '#0b0b0d', border: `1px solid ${HAIR}` }}>
                        <span style={{ color: MUTED }}>Mining time</span>
                        <div className="text-sm font-semibold mt-0.5" style={{ color: TEXT }}>
                          {formatEta(summary.seconds)}
                        </div>
                      </div>
                      <div className="rounded-xl p-3" style={{ background: '#0b0b0d', border: `1px solid ${HAIR}` }}>
                        <span style={{ color: MUTED }}>Wallet balance</span>
                        <div className="text-sm font-semibold mt-0.5 tabular-nums" style={{ color: TEXT }}>
                          {balance == null ? '—' : fmtSats(balance)}
                          <span className="text-[11px] font-normal ml-1" style={{ color: MUTED }}>
                            {balance == null ? '' : usd(balance)}
                          </span>
                        </div>
                      </div>
                    </div>
                    {shortfall > 0 && (
                      <div
                        role="alert"
                        className="rounded-xl px-3 py-2.5 text-xs"
                        style={{
                          background: 'rgba(255,90,90,0.1)',
                          color: RED,
                          border: '1px solid rgba(255,90,90,0.25)',
                        }}
                      >
                        You need {fmtSats(shortfall)} more{usd(shortfall) ? ` (${usd(shortfall)})` : ''}. Add BSV to
                        this wallet, or remove some names.
                      </div>
                    )}
                    {toVault.length > 0 && (
                      <p className="m-0 text-[13px] font-semibold" style={{ color: GOLD }}>
                        {plural(toVault.length, 'name')} {toVault.length === 1 ? 'goes' : 'go'} straight to your Vault
                        (not listed)
                      </p>
                    )}
                    {MARKET_ENABLED && (
                      <label className="flex items-center gap-2.5 text-[13px] cursor-pointer" style={{ color: TEXT }}>
                        <input
                          type="checkbox"
                          checked={autoList}
                          onChange={(e) => setAutoList(e.target.checked)}
                          className="w-4 h-4 accent-[color:var(--bw-accent-hi)] cursor-pointer"
                        />
                        Auto-list each name at its tier price after it&apos;s minted ($1 · $5 · $15 by length; special
                        names never)
                      </label>
                    )}
                    <button
                      type="button"
                      className={`${goldBtn} w-full py-3.5 text-[15px]`}
                      style={{
                        background: GOLD,
                        color: '#000',
                        boxShadow: '0 8px 28px rgb(var(--bw-accent-hi-rgb) / 0.18)',
                      }}
                      disabled={!apiContext || shortfall > 0}
                      onClick={() => setSheet(true)}
                    >
                      Mint {plural(summary.toMint, 'name')}
                      {autoList ? ' + list at tier prices' : ''} · pay {fmtSats(totalSats)}
                      {usd(totalSats) ? ` ${usd(totalSats)}` : ''}
                    </button>
                  </>
                )}
              </Step>
            )}
          </>
        )}

        {msg && (
          <p className="m-0 text-xs" style={{ color: MUTED }}>
            {msg}
          </p>
        )}

        <OpnsVaultSection vault={vault.state} owned={new Set(owned.map((o) => o.name))} onChange={vault.set} />

        {MARKET_ENABLED ? (
          <OpnsSellSection
            vault={vault.state}
            onVault={vault.set}
            ctx={apiContext}
            identityAddress={identityAddress}
            rate={rate}
            owned={owned}
            onChanged={() => void refreshOwned()}
          />
        ) : (
          <OpnsGiftSection ctx={apiContext} owned={owned} onChanged={() => void refreshOwned()} />
        )}
      </div>

      {buy && (
        <OpnsBuySheet
          name={buy.name}
          priceSats={buy.priceSats}
          rate={rate}
          site="bMint · OpNS names"
          onAllow={() => void buyNow(buy)}
          onClose={() => setBuy(null)}
        />
      )}

      {sheet &&
        summary &&
        plan &&
        createPortal(
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
              siteSub="bMint · OpNS names"
              onClose={() => setSheet(false)}
              hero={
                <PayHero amount={usd(totalSats).replace('≈ ', '~') || fmtSats(totalSats)} sub={fmtSats(totalSats)} />
              }
              title={
                <>
                  {autoList ? 'Mint' : 'Own'} <span style={{ color: CARD.gold }}>{summary.toMint}</span>{' '}
                  {autoList ? 'names + list at tier prices' : 'names on-chain'}
                </>
              }
              primary={{ label: 'Allow', onClick: approve }}
              secondary={{ label: 'Not now', onClick: () => setSheet(false) }}
            >
              <div className="flex flex-wrap gap-2">
                {toMint.map((p) => (
                  <Chip key={p.name}>{p.name}</Chip>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Chip>{plural(summary.chars, 'transaction')}</Chip>
                <Chip>{formatEta(summary.seconds)}</Chip>
                <Chip>{autoList ? 'Listed as each one mints' : 'Locked to your wallet'}</Chip>
                {autoList && <Chip>Fees {fmtSats(totalSats)} incl. listing</Chip>}
              </div>
            </ApprovalCard>
          </div>,
          document.body,
        )}
    </div>
  );
};

export default OpnsMintPage;
