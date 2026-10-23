import { useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, Check, Gift, Search } from 'lucide-react';
import { listOpns } from '@1sat/actions';
import { sendBsv } from '../../../utils/guardedSendBsv';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { ApprovalCard, Chip } from '../../../components/approval/ApprovalCard';
import { CARD } from '../../../components/approval/cardTheme';
import { PayHero } from '../../../components/approval/ApprovalHeroes';
import { bavatarSvg } from '../../bavatar/bavatar';
import { ObsidianBackdrop } from '../../ui/ObsidianBackdrop';
import { fmtSats, fmtUsd, usdToSats, useBsvUsd } from '../../money/money';
import { fetchExchangeRate } from '../../../utils/wallet';
import { AccountList, AccountRow } from '../../account/AccountSwitcher';
import { useAccountSwitch } from '../../account/accountSwitch';
import { MARKET_ENABLED } from '../../storeBuild';
import { GuestCtx } from '../../media/artists/guestCtx';
import { resumeAt } from '../../url/resume';
import { checkOpnsAvailability, parseRecipient, resolveRecipient } from '../names';
import { OPNS_PROFILE_DOMAIN } from '../config';
import { NamesServerError } from '../opnsMint';
import { EXPECTED_HASHES } from '../opnsPow';
import { formatEta, mineName, MiningCancelled, NameTakenError, type Progress } from '../opnsRegister';
import { opnsTreeFor } from '../opnsTree';
import { sweepDeadMints } from '../opnsTxStatus';
import { buyOpnsListing, giftOpnsName, listOpnsName, opnsIdFor, unlistOpnsName } from '../opnsBuy';
import { giftDestination, giftRecipientLabel } from '../opnsGift';
import { fetchOpnsListings, ownedForSale, type OpnsListing } from '../opnsSell';
import {
  buyThenGive,
  displayUsd,
  normaliseQuery,
  RAILS,
  railNames,
  resultFor,
  STORE_PAY_ADDRESS,
  type StoreResult,
} from './inventory';
import { NAME_TIERS, nameTierUsd, offerHref } from './tiers';

/**
 * The Name Store (/names, owner-approved 13 Oct 2026): "Get your name on Bitcoin. Yours forever."
 * Search → one result card (buy from us, get a free name, buy from someone else, or taken + suggestions),
 * a live preview of what the name becomes, browse rails from our listed inventory, and "Give a name".
 * A free name is got right here (owner, 14 Oct 2026, after landing in the bulk bMint tool for "kooky"): one
 * sheet, then it is mined on this device and the tier price is paid to the storefront, with the account that
 * pays shown above the result so the wrong one (an agent account with 0 sats) is never a surprise.
 * Works signed out (GuestNames.tsx): anything that needs the wallet asks to sign in first.
 * Plumbing words (OpNS, mining, ordinals) stay in "What is this?" only. Selling/buying needs MARKET_ENABLED;
 * a store build keeps search and claim only.
 */

const BG = '#07080a';
const GOLD = 'var(--bw-accent)';
const TEXT = '#f4f1e8';
const MUTED = 'rgba(244,241,232,0.82)';
const FAINT = 'rgba(244,241,232,0.64)';
const HAIR = 'rgba(244,241,232,0.14)';
// Cards sit on the gold pool: a near-solid dark surface so their text reads (owner, 13 Oct 2026).
const SURFACE = 'rgba(7,8,10,0.72)';
const LISTINGS_URL = 'https://api.1sat.app/1sat/market/listings?status=active&type=application/op-ns&limit=1000';
const f = (u: string, i?: RequestInit) => fetch(u, i);

const usdLabel = (l: OpnsListing, rate: number) => {
  const u = displayUsd(l, rate);
  return u === null ? fmtSats(l.priceSats) : fmtUsd(u);
};

const Avatar = ({ name, size }: { name: string; size: number }) => {
  const src = useMemo(
    () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(bavatarSvg(name || 'b', { size: 128 }))}`,
    [name],
  );
  return <img src={src} alt="" width={size} height={size} className="rounded-full block shrink-0" />;
};

const btn =
  'max-w-full inline-flex items-center justify-center gap-2 rounded-xl px-5 h-11 text-sm font-semibold border-0 cursor-pointer transition-[filter,transform] duration-150 ease-out hover:brightness-110 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 no-underline';
const goldBtn = { background: GOLD, color: '#0a0a0a', outlineColor: GOLD };
const ghostBtn = { background: 'transparent', color: TEXT, boxShadow: `inset 0 0 0 1px ${HAIR}`, outlineColor: GOLD };

type GiftTo = { label: string; address: string };
type Pending = { listing: OpnsListing; giftTo?: GiftTo };
type PendingGet = { name: string; sats: number; giftTo?: GiftTo };
type Getting = { name: string; progress: Progress | null; stage: 'mining' | 'paying' | 'sending' };
/** A name this wallet holds: its ordinal id and, when on sale, the asking price. */
type Owned = { id: string; listedSats: number | null };
type PendingSell = { name: string; id: string; usd: number; sats: number };

export const NameStorePage = () => {
  const { apiContext, isLocked, chromeStorageService } = useServiceContext();
  const onWallet = useContext(GuestCtx);
  const guest = !!onWallet || isLocked;
  const account = guest ? undefined : chromeStorageService.getCurrentAccountObject().account;
  const identityAddress = account?.addresses?.identityAddress ?? '';
  const { search } = useLocation();
  const rate = useBsvUsd();
  const initial = new URLSearchParams(search).get('q') ?? '';
  const [q, setQ] = useState(initial);
  const [result, setResult] = useState<StoreResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [listings, setListings] = useState<OpnsListing[] | null>(null);
  const [mine, setMine] = useState<Set<string>>(new Set());
  const [owned, setOwned] = useState<Map<string, Owned>>(new Map());
  const [sellUsd, setSellUsd] = useState('');
  const [pendingSell, setPendingSell] = useState<PendingSell | null>(null);
  const [giving, setGiving] = useState(false);
  const [giftTo, setGiftTo] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [pendingGet, setPendingGet] = useState<PendingGet | null>(null);
  const [getting, setGetting] = useState<Getting | null>(null);
  const [switcher, setSwitcher] = useState(false);
  const { switchingTo, switchAccount } = useAccountSwitch(() => setSwitcher(false));
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const seq = useRef(0);
  const name = normaliseQuery(q);
  const previewName = result && result.kind !== 'invalid' ? result.name : name || 'yourname';

  useEffect(() => {
    let live = true;
    fetchOpnsListings(f, LISTINGS_URL)
      .then((l) => live && setListings(l))
      .catch(() => live && setListings([]));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (guest || !apiContext) return;
    listOpns
      .execute(apiContext, { includeTags: true, limit: 1000 })
      .then((r) => {
        const o = ownedForSale(r.outputs);
        setMine(new Set(o.map((x) => x.name)));
        setOwned(new Map(o.map((x) => [x.name, { id: x.id, listedSats: x.listedSats }])));
      })
      .catch(() => undefined);
  }, [apiContext, guest]);

  const lookup = async (raw: string) => {
    const n = normaliseQuery(raw);
    const id = ++seq.current;
    if (!n) {
      setResult(null);
      return;
    }
    setChecking(true);
    setMsg('');
    try {
      const a = await checkOpnsAvailability(f, n);
      if (id === seq.current) setResult(resultFor(a, listings ?? [], mine));
    } catch {
      if (id === seq.current) setMsg("Couldn't check that name just now. Try again in a moment.");
    } finally {
      if (id === seq.current) setChecking(false);
    }
  };

  // Instant result while typing (debounced), and again once the listings arrive.
  useEffect(() => {
    const t = setTimeout(() => void lookup(q), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, listings, mine]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void lookup(q);
  };
  const pick = (n: string) => {
    setQ(n);
    setGiving(false);
    window.scrollTo?.({ top: 0, behavior: 'smooth' });
    document.getElementById('name-store-top')?.scrollIntoView?.({ behavior: 'smooth' });
  };

  /** Anything that needs the wallet: signed out → sign in / create, then come back to this name. */
  const needWallet = (n: string) => {
    if (!guest) return false;
    resumeAt(`/m/names?q=${encodeURIComponent(n)}`);
    onWallet?.();
    return true;
  };

  /** Who gets it when "Give it to someone" is ticked (undefined = keep it). Throws with the words to show. */
  const giftRecipient = async (): Promise<GiftTo | undefined> => {
    if (!giving) return undefined;
    const r = await resolveRecipient(f, parseRecipient(giftTo));
    const d = giftDestination(r);
    if (!d.ok) throw new Error(d.error);
    return { label: giftRecipientLabel(r, d.to), address: d.to };
  };

  const startBuy = async (listing: OpnsListing) => {
    if (needWallet(listing.name)) return;
    setMsg('');
    try {
      setPending({ listing, giftTo: await giftRecipient() });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Enter their $handle or paymail');
    }
  };

  /** A free name: one sheet with the tier price, then it is got right here (never the bulk bMint tool). */
  const startGet = async (n: string) => {
    if (needWallet(n)) return;
    setMsg('');
    try {
      const to = await giftRecipient();
      let sats = 0;
      if (MARKET_ENABLED) {
        sats = usdToSats(nameTierUsd(n) ?? 0, rate || (await fetchExchangeRate('main'))) ?? 0;
        if (!sats) throw new Error("Couldn't get the BSV price. Try again in a minute.");
      }
      setPendingGet({ name: n, sats, giftTo: to });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Enter their $handle or paymail');
    }
  };

  const approveGet = async () => {
    if (!pendingGet || !apiContext) return;
    const { name: n, sats, giftTo: to } = pendingGet;
    setPendingGet(null);
    setBusy(n);
    setGetting({ name: n, progress: null, stage: 'mining' });
    const ctl = new AbortController();
    const tree = opnsTreeFor(identityAddress);
    // Mine it (one transaction per new character), then pay the tier price to the storefront. Returns a txid
    // for buyThenGive, which treats it like a purchase and sends the name on when it is a gift.
    const get = async (): Promise<string> => {
      await sweepDeadMints(tree, f).catch(() => undefined);
      const steps = await mineName({ ctx: apiContext, fetch: f, tree }, n, ctl.signal, (progress) =>
        setGetting((g) => (g ? { ...g, progress } : g)),
      );
      let txid = steps[steps.length - 1]?.txid ?? '';
      if (sats > 0) {
        setGetting((g) => (g ? { ...g, stage: 'paying' } : g));
        const r = await sendBsv.execute(apiContext, { requests: [{ address: STORE_PAY_ADDRESS, satoshis: sats }] });
        if (r.error || !r.txid)
          throw new Error(`${n} is yours, but the payment didn't go through (${String(r.error ?? 'payment failed')}).`);
        txid = r.txid;
      }
      return txid;
    };
    try {
      if (!to) {
        await get();
        setMsg(`${n} is yours. It shows in your names within a minute.`);
      } else {
        const r = await buyThenGive(
          {
            buy: get,
            idOf: (x) => opnsIdFor(apiContext, x),
            send: (id, address) => giftOpnsName(apiContext, id, address),
            onStep: (s) => s !== 'buying' && setGetting((g) => (g ? { ...g, stage: 'sending' } : g)),
          },
          n,
          to.address,
        );
        if (r.ok) setMsg(`Sent. ${n} now belongs to ${to.label}.`);
        else if (r.stage === 'buy') throw new Error(r.error);
        else setMsg(`You got ${n}, but the gift didn't go through (${r.error}). It's safe in your wallet.`);
      }
      setMine((m) => new Set(m).add(n));
      setResult(null);
    } catch (e) {
      if (e instanceof MiningCancelled) setMsg('Cancelled.');
      else if (e instanceof NameTakenError) {
        setMsg(`Someone got ${n} a moment ago. Try another name.`);
        setResult(null);
      } else if (e instanceof NamesServerError) setMsg('The names service is busy. Try again in a minute.');
      else setMsg(e instanceof Error ? e.message : `Couldn't get ${n}`);
    } finally {
      setGetting(null);
      setBusy('');
    }
  };

  const approve = async () => {
    if (!pending || !apiContext) return;
    const { listing, giftTo: to } = pending;
    setPending(null);
    setBusy(listing.name);
    try {
      if (!to) {
        await buyOpnsListing(apiContext, listing.outpoint, listing.name);
        setMsg(`${listing.name} is yours. It shows in your names within a minute.`);
        setMine((m) => new Set(m).add(listing.name));
      } else {
        const r = await buyThenGive(
          {
            buy: () => buyOpnsListing(apiContext, listing.outpoint, listing.name),
            idOf: (n) => opnsIdFor(apiContext, n),
            send: (id, address) => giftOpnsName(apiContext, id, address),
            onStep: (s) => setMsg(s === 'buying' ? 'Buying…' : s === 'finding' ? 'Wrapping it up…' : 'Sending…'),
          },
          listing.name,
          to.address,
        );
        if (r.ok) setMsg(`Sent. ${listing.name} now belongs to ${to.label}.`);
        else if (r.stage === 'buy') setMsg(r.error);
        else
          setMsg(`You bought ${listing.name}, but the gift didn't go through (${r.error}). It's safe in your wallet.`);
      }
      setListings((l) => (l ?? []).filter((x) => x.outpoint !== listing.outpoint));
      setResult(null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Purchase failed');
    } finally {
      setBusy('');
    }
  };

  /** Selling a name you hold (owner, 14 Oct 2026: users must be able to buy AND sell names; the bulk tool is hidden). */
  const startSell = async (n: string) => {
    if (needWallet(n)) return;
    const o = owned.get(n);
    if (!o) return;
    setMsg('');
    const usd = Number(sellUsd || nameTierUsd(n) || 15);
    if (!(usd >= 0.01 && usd <= 100_000)) return setMsg('Choose a price between $0.01 and $100,000.');
    const sats = usdToSats(usd, rate || (await fetchExchangeRate('main').catch(() => 0))) ?? 0;
    if (!sats) return setMsg("Couldn't get the BSV price. Try again in a minute.");
    setPendingSell({ name: n, id: o.id, usd, sats });
  };
  const approveSell = async () => {
    if (!pendingSell || !apiContext) return;
    const { name: n, id, usd, sats } = pendingSell;
    setPendingSell(null);
    setBusy(n);
    try {
      await listOpnsName(apiContext, id, sats);
      setOwned((m) => new Map(m).set(n, { id, listedSats: sats }));
      setMsg(`${n} is on sale for ${fmtUsd(usd)}. Buyers pay you directly; take it off sale any time.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : `Couldn't list ${n}`);
    } finally {
      setBusy('');
    }
  };
  const unlist = async (n: string) => {
    const o = owned.get(n);
    if (!o || !apiContext) return;
    setBusy(n);
    setMsg('');
    try {
      await unlistOpnsName(apiContext, o.id);
      setOwned((m) => new Map(m).set(n, { id: o.id, listedSats: null }));
      setMsg(`${n} is off sale and back in your wallet.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : `Couldn't take ${n} off sale`);
    } finally {
      setBusy('');
    }
  };
  const giveOwned = async (n: string) => {
    const o = owned.get(n);
    if (!o || !apiContext) return;
    setMsg('');
    try {
      const to = await giftRecipient();
      if (!to) return setMsg('Enter their $handle or paymail');
      setBusy(n);
      await giftOpnsName(apiContext, o.id, to.address);
      setOwned((m) => {
        const next = new Map(m);
        next.delete(n);
        return next;
      });
      setMine((m) => {
        const next = new Set(m);
        next.delete(n);
        return next;
      });
      setMsg(`Sent. ${n} now belongs to ${to.label}.`);
      setResult(null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Enter their $handle or paymail');
    } finally {
      setBusy('');
    }
  };
  const yourNames = useMemo(() => [...owned.keys()].sort((a, b) => a.localeCompare(b)), [owned]);

  return (
    <div
      className="relative w-full h-full overflow-y-auto"
      style={{ background: BG, color: TEXT, isolation: 'isolate' }}
    >
      {/* The gold pool (owner, 13 Oct 2026): the obsidian pool's shader in molten gold, dimmed so the text reads. */}
      <ObsidianBackdrop variant="gold" dim={0.58} />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px]"
        style={{ background: 'radial-gradient(60% 60% at 50% 0%, rgb(var(--bw-accent-rgb) / 0.10), transparent 70%)' }}
      />
      <div id="name-store-top" className="relative w-full max-w-5xl mx-auto px-4 sm:px-8 pt-12 sm:pt-20 pb-40">
        {/* Hero */}
        <header className="flex flex-col items-center text-center gap-4">
          <span className="text-[11px] font-semibold tracking-[0.18em] uppercase" style={{ color: GOLD }}>
            Names
          </span>
          <h1 className="m-0 text-[34px] leading-[1.05] sm:text-[56px] font-bold tracking-[-0.035em] max-w-[16ch]">
            Get your name on Bitcoin.
          </h1>
          <p className="m-0 text-base sm:text-lg max-w-[46ch]" style={{ color: MUTED }}>
            Yours forever. One payment, no renewals.
          </p>
        </header>

        <form onSubmit={submit} className="mt-8 sm:mt-10 mx-auto max-w-2xl" role="search">
          <label
            className="flex items-center gap-3 rounded-2xl px-4 sm:px-5 h-16 transition-shadow duration-200 focus-within:shadow-[0_0_0_1px_var(--bw-accent),0_12px_40px_rgb(var(--bw-accent-rgb) / 0.12)]"
            style={{ background: '#0f1013', boxShadow: `0 0 0 1px ${HAIR}, 0 12px 40px rgba(0,0,0,0.4)` }}
          >
            <Search size={20} color={FAINT} aria-hidden="true" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find your name"
              aria-label="Find your name"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 min-w-0 bg-transparent border-0 outline-none text-lg sm:text-xl"
              style={{ color: TEXT }}
            />
            <button type="submit" className={`${btn} h-10 px-4 shrink-0`} style={goldBtn}>
              <span className="hidden sm:inline">Search</span>
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </label>
          {MARKET_ENABLED && (
            <ul
              className="list-none p-0 m-0 mt-3 flex flex-wrap justify-center gap-x-5 gap-y-1 text-xs"
              style={{ color: FAINT }}
            >
              {NAME_TIERS.map((t) => (
                <li key={t.label}>
                  {t.label} <span style={{ color: MUTED }}>{fmtUsd(t.usd)}</span>
                </li>
              ))}
              <li>Special names: make an offer</li>
            </ul>
          )}
        </form>

        {/* Who pays (owner, 14 Oct 2026: Desktop opened in an agent account with 0 sats and nothing said so). */}
        {!guest && account && (
          <div
            className="mt-4 mx-auto max-w-2xl rounded-2xl pl-3 pr-2 py-1 flex items-center gap-1"
            style={{ background: SURFACE, boxShadow: `inset 0 0 0 1px ${HAIR}` }}
          >
            <span className="text-xs shrink-0" style={{ color: FAINT }}>
              Paying from
            </span>
            <AccountRow
              account={account}
              switchingTo={null}
              compact
              onSwitch={() => setSwitcher(true)}
              trailing={
                <button
                  type="button"
                  onClick={() => setSwitcher(true)}
                  className="shrink-0 h-8 px-3 rounded-lg text-xs font-semibold cursor-pointer"
                  style={ghostBtn}
                >
                  Switch
                </button>
              }
            />
          </div>
        )}

        {/* Result + preview */}
        <section aria-live="polite" className="mt-10 grid gap-4 lg:grid-cols-[1.15fr_1fr] [&>*]:min-w-0">
          <ResultCard
            result={result}
            checking={checking && !!name}
            rate={rate}
            busy={busy}
            giving={giving}
            setGiving={setGiving}
            giftTo={giftTo}
            setGiftTo={setGiftTo}
            onBuy={(l) => void startBuy(l)}
            onGet={(n) => void startGet(n)}
            getting={getting}
            owned={owned}
            sellUsd={sellUsd}
            setSellUsd={setSellUsd}
            onSell={(n) => void startSell(n)}
            onUnlist={(n) => void unlist(n)}
            onGive={(n) => void giveOwned(n)}
            onPick={pick}
          />
          <Preview name={previewName} />
        </section>
        {msg && (
          <p role="status" className="mt-4 text-sm text-center m-0" style={{ color: MUTED }}>
            {msg}
          </p>
        )}

        {/* Your names: tap one to sell it, take it off sale or give it (owner, 14 Oct 2026). */}
        {yourNames.length > 0 && (
          <div className="mt-12">
            <Rail title="Your names" sub="tap to sell or give" loading={false}>
              {yourNames.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => pick(n)}
                  className="group w-[150px] text-left rounded-2xl p-4 border-0 cursor-pointer transition-[background,transform] duration-150 ease-out hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2"
                  style={{ background: SURFACE, boxShadow: `inset 0 0 0 1px ${HAIR}`, color: TEXT, outlineColor: GOLD }}
                >
                  <span className="block text-base font-semibold break-all">{n}</span>
                  <span className="block mt-1 text-xs tabular-nums" style={{ color: MUTED }}>
                    {owned.get(n)?.listedSats
                      ? `On sale · ${rate ? fmtUsd(((owned.get(n)?.listedSats ?? 0) / 1e8) * rate) : fmtSats(owned.get(n)?.listedSats ?? 0)}`
                      : 'Yours'}
                  </span>
                </button>
              ))}
            </Rail>
          </div>
        )}

        {/* Browse */}
        {MARKET_ENABLED && (
          <div className="mt-16 flex flex-col gap-10">
            {RAILS.map((r) => (
              <Rail key={r.id} title={r.title} sub={r.sub} loading={listings === null}>
                {(listings ? railNames(r.id, listings) : []).map((l) => (
                  <button
                    key={l.outpoint}
                    type="button"
                    onClick={() => pick(l.name)}
                    className="group w-[150px] text-left rounded-2xl p-4 border-0 cursor-pointer transition-[background,transform] duration-150 ease-out hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2"
                    style={{
                      background: SURFACE,
                      boxShadow: `inset 0 0 0 1px ${HAIR}`,
                      color: TEXT,
                      outlineColor: GOLD,
                    }}
                  >
                    <span className="block text-base font-semibold truncate">{l.name}</span>
                    <span className="block mt-1 text-xs tabular-nums" style={{ color: MUTED }}>
                      {usdLabel(l, rate)}
                    </span>
                    <span
                      className="block mt-3 text-xs font-semibold opacity-60 group-hover:opacity-100 transition-opacity"
                      style={{ color: GOLD }}
                    >
                      View →
                    </span>
                  </button>
                ))}
              </Rail>
            ))}
          </div>
        )}

        <WhatIsThis />
      </div>

      {MARKET_ENABLED && pending && (
        <BuySheet
          name={pending.listing.name}
          amount={usdLabel(pending.listing, rate)}
          sats={pending.listing.priceSats}
          giftTo={pending.giftTo?.label}
          onAllow={() => void approve()}
          onClose={() => setPending(null)}
        />
      )}
      {pendingSell && (
        <BuySheet
          verb="Sell"
          name={pendingSell.name}
          amount={fmtUsd(pendingSell.usd)}
          sats={pendingSell.sats}
          onAllow={() => void approveSell()}
          onClose={() => setPendingSell(null)}
        />
      )}
      {pendingGet && (
        <BuySheet
          verb="Get"
          name={pendingGet.name}
          amount={pendingGet.sats ? fmtUsd(nameTierUsd(pendingGet.name) ?? 0) : 'Network fee only'}
          sats={pendingGet.sats}
          giftTo={pendingGet.giftTo?.label}
          onAllow={() => void approveGet()}
          onClose={() => setPendingGet(null)}
        />
      )}
      {switcher &&
        createPortal(
          <div
            className="fixed inset-0 z-[420] flex items-end sm:items-center justify-center"
            style={{ background: 'rgba(0,0,0,0.6)' }}
            onClick={() => setSwitcher(false)}
          >
            <div
              role="listbox"
              aria-label="Pay from which account?"
              className="w-full max-w-md rounded-t-3xl sm:rounded-3xl p-3 flex flex-col gap-1"
              style={{ background: '#0f1013', color: TEXT, boxShadow: `inset 0 0 0 1px ${HAIR}` }}
              onClick={(e) => e.stopPropagation()}
            >
              <p className="m-0 px-3 pt-2 pb-1 text-sm font-semibold">Pay from which account?</p>
              <AccountList
                current={identityAddress}
                switchingTo={switchingTo}
                onSwitch={(id) => void switchAccount(id)}
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
};

const ResultCard = (p: {
  result: StoreResult | null;
  checking: boolean;
  rate: number;
  busy: string;
  giving: boolean;
  setGiving: (v: boolean) => void;
  giftTo: string;
  setGiftTo: (v: string) => void;
  onBuy: (l: OpnsListing) => void;
  onGet: (n: string) => void;
  getting: Getting | null;
  owned: Map<string, Owned>;
  sellUsd: string;
  setSellUsd: (v: string) => void;
  onSell: (n: string) => void;
  onUnlist: (n: string) => void;
  onGive: (n: string) => void;
  onPick: (n: string) => void;
}) => {
  const r = p.result;
  const shell = (children: ReactNode) => (
    <div
      className="rounded-3xl p-6 sm:p-8 flex flex-col gap-5 min-h-[260px]"
      style={{ background: SURFACE, boxShadow: `inset 0 0 0 1px ${HAIR}` }}
    >
      {children}
    </div>
  );
  if (!r)
    return shell(
      <div className="flex flex-col gap-2 my-auto">
        <p className="m-0 text-2xl font-semibold tracking-tight">
          {p.checking ? 'Checking…' : 'Type a name to start.'}
        </p>
        <p className="m-0 text-sm" style={{ color: MUTED }}>
          Letters, numbers and dashes. First come, first served.
        </p>
      </div>,
    );

  const title = (
    <p className="m-0 text-[32px] sm:text-[40px] font-bold tracking-[-0.03em] leading-none break-all">{r.name}</p>
  );
  const busy = p.busy === r.name;
  const buyable = MARKET_ENABLED && (r.kind === 'house' || r.kind === 'listed');
  const giftBox = (
    <div className="flex flex-col gap-2">
      <label className="inline-flex items-center gap-2 text-sm cursor-pointer select-none" style={{ color: MUTED }}>
        <input
          type="checkbox"
          checked={p.giving}
          onChange={(e) => p.setGiving(e.target.checked)}
          className="accent-[color:var(--bw-accent)] w-4 h-4"
        />
        <Gift size={14} aria-hidden="true" /> Give it to someone
      </label>
      {p.giving && (
        <input
          value={p.giftTo}
          onChange={(e) => p.setGiftTo(e.target.value)}
          placeholder="Their $handle or paymail"
          aria-label="Who is it for? Their $handle or paymail"
          autoCapitalize="none"
          className="h-11 rounded-xl px-4 text-sm outline-none focus-visible:shadow-[0_0_0_1px_var(--bw-accent)]"
          style={{ background: '#0b0c0f', color: TEXT, boxShadow: `inset 0 0 0 1px ${HAIR}` }}
        />
      )}
    </div>
  );

  switch (r.kind) {
    case 'invalid':
      return shell(
        <>
          {title}
          <p className="m-0 text-sm" style={{ color: MUTED }}>
            {r.reason}. Try lower-case letters, numbers or a dash.
          </p>
        </>,
      );
    case 'mine': {
      const o = p.owned.get(r.name);
      const listedUsd = o?.listedSats && p.rate ? (o.listedSats / 1e8) * p.rate : null;
      const tier = nameTierUsd(r.name);
      return shell(
        <>
          {title}
          <p className="m-0 text-base inline-flex items-center gap-2" style={{ color: GOLD }}>
            <Check size={18} aria-hidden="true" /> Already yours.
          </p>
          {!o ? (
            <Link to="/m/settings" className={btn} style={{ ...ghostBtn, alignSelf: 'flex-start' }}>
              Your names are in Settings
            </Link>
          ) : MARKET_ENABLED && o.listedSats ? (
            <>
              <p className="m-0 text-sm" style={{ color: MUTED }}>
                On sale for {listedUsd !== null ? fmtUsd(listedUsd) : fmtSats(o.listedSats)}. Buyers pay you directly.
              </p>
              <button
                type="button"
                disabled={!!p.busy}
                onClick={() => p.onUnlist(r.name)}
                className={btn}
                style={{ ...ghostBtn, alignSelf: 'flex-start' }}
              >
                {busy ? 'Working…' : 'Take it off sale'}
              </button>
            </>
          ) : (
            <>
              {/* Selling names is exchange functionality: bWalletX only (MARKET_ENABLED, App Review 3.1.5(iii)). */}
              {MARKET_ENABLED && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex items-center gap-2 text-sm" style={{ color: MUTED }}>
                      Sell for $
                      <input
                        value={p.sellUsd}
                        onChange={(e) => p.setSellUsd(e.target.value.replace(/[^\d.]/g, ''))}
                        placeholder={String(tier ?? 15)}
                        inputMode="decimal"
                        aria-label="Asking price in US dollars"
                        className="h-11 w-24 rounded-xl px-3 text-sm outline-none focus-visible:shadow-[0_0_0_1px_var(--bw-accent)]"
                        style={{ background: '#0b0c0f', color: TEXT, boxShadow: `inset 0 0 0 1px ${HAIR}` }}
                      />
                    </label>
                    <button
                      type="button"
                      disabled={!!p.busy}
                      onClick={() => p.onSell(r.name)}
                      className={btn}
                      style={goldBtn}
                    >
                      {busy ? 'Working…' : 'Put it on sale'}
                    </button>
                  </div>
                  <p className="m-0 text-xs" style={{ color: FAINT }}>
                    Listed on the Exchange until it sells or you take it off. The buyer pays you directly; the network
                    fee is a fraction of a cent.
                  </p>
                </>
              )}
              {giftBox}
              {p.giving && (
                <button
                  type="button"
                  disabled={!!p.busy}
                  onClick={() => p.onGive(r.name)}
                  className={btn}
                  style={{ ...ghostBtn, alignSelf: 'flex-start' }}
                >
                  {busy ? 'Sending…' : `Give ${r.name}`}
                </button>
              )}
            </>
          )}
        </>,
      );
    }
    case 'premium':
      // A store build has no selling or buying (MARKET_ENABLED): premium and listed names just read "Taken".
      if (!MARKET_ENABLED)
        return shell(
          <>
            {title}
            <p className="m-0 text-lg" style={{ color: MUTED }}>
              Taken.
            </p>
          </>,
        );
      return shell(
        <>
          {title}
          <p className="m-0 text-base" style={{ color: MUTED }}>
            A special name. It isn&apos;t sold at a set price, but we&apos;re happy to hear an offer.
          </p>
          <a href={offerHref(r.name)} className={btn} style={{ ...goldBtn, alignSelf: 'flex-start' }}>
            Make an offer
          </a>
        </>,
      );
    case 'house':
    case 'listed': {
      if (!MARKET_ENABLED)
        return shell(
          <>
            {title}
            <p className="m-0 text-lg" style={{ color: MUTED }}>
              Taken.
            </p>
          </>,
        );
      const price = usdLabel(r.listing, p.rate);
      return shell(
        <>
          {title}
          <p className="m-0 text-lg">
            {r.kind === 'house' ? (
              <>
                <span style={{ color: GOLD }}>{r.name}</span> is yours for {price}.
              </>
            ) : (
              <>Its owner is selling it for {price}.</>
            )}
          </p>
          <>
            {buyable && giftBox}
            <button
              type="button"
              disabled={!!p.busy}
              onClick={() => p.onBuy(r.listing)}
              className={btn}
              style={{ ...goldBtn, alignSelf: 'flex-start' }}
            >
              {busy ? 'Buying…' : p.giving ? `Buy and give · ${price}` : `Buy · ${price}`}
            </button>
            <p className="m-0 text-xs" style={{ color: FAINT }}>
              One payment, plus a tiny network fee. No renewals.
            </p>
          </>
        </>,
      );
    }
    case 'free': {
      const g = p.getting?.name === r.name ? p.getting : null;
      const pr = g?.progress;
      const frac =
        pr && pr.phase === 'mining'
          ? (pr.charIndex + Math.min(0.95, pr.tried / EXPECTED_HASHES)) / Math.max(1, pr.charsTotal)
          : pr
            ? 1
            : 0;
      const words =
        g?.stage === 'paying'
          ? 'Paying…'
          : g?.stage === 'sending'
            ? 'Sending it on…'
            : pr?.phase === 'broadcasting'
              ? 'Nearly there…'
              : pr && pr.rate > 0 && Number.isFinite(pr.etaSeconds)
                ? `Making ${r.name} yours · about ${formatEta(pr.etaSeconds)} left`
                : `Making ${r.name} yours…`;
      const price = MARKET_ENABLED ? fmtUsd(nameTierUsd(r.name) ?? 0) : '';
      return shell(
        <>
          {title}
          <p className="m-0 text-lg">
            <span style={{ color: GOLD }}>{r.name}</span> is available{price ? `: ${price}` : ''}.
          </p>
          {g ? (
            <div className="flex flex-col gap-2" role="status">
              <p className="m-0 text-sm" style={{ color: MUTED }}>
                {words}
              </p>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: HAIR }}>
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{ width: `${Math.round(frac * 100)}%`, background: GOLD }}
                />
              </div>
              <p className="m-0 text-xs" style={{ color: FAINT }}>
                Keep this page open until it&apos;s done.
              </p>
            </div>
          ) : (
            <>
              <p className="m-0 text-sm" style={{ color: MUTED }}>
                {price ? 'Paid in BSV at today’s price. ' : ''}Yours forever, or give it to someone.
              </p>
              {giftBox}
              <button
                type="button"
                disabled={!!p.busy}
                onClick={() => p.onGet(r.name)}
                className={btn}
                style={{ ...goldBtn, alignSelf: 'flex-start' }}
              >
                <span className="truncate">
                  {p.giving ? `Get and give${price ? ` · ${price}` : ''}` : `Get ${r.name}`}
                </span>
              </button>
              <p className="m-0 text-xs" style={{ color: FAINT }}>
                Usually under a minute. One payment, plus a tiny network fee. No renewals.
              </p>
            </>
          )}
        </>,
      );
    }
    case 'taken':
      return shell(
        <>
          {title}
          <p className="m-0 text-lg" style={{ color: MUTED }}>
            Taken.
          </p>
          {r.suggestions.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: FAINT }}>
                Try instead
              </p>
              <div className="flex flex-wrap gap-2">
                {r.suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => p.onPick(s)}
                    className="h-9 px-3.5 rounded-full text-sm border-0 cursor-pointer transition-colors duration-150 hover:bg-[rgb(var(--bw-accent-rgb) / 0.12)] focus-visible:outline focus-visible:outline-2"
                    style={{
                      background: 'transparent',
                      color: TEXT,
                      boxShadow: `inset 0 0 0 1px ${HAIR}`,
                      outlineColor: GOLD,
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>,
      );
  }
};

/** What the name becomes: identity address, a payable name in bWalletX, and the profile card. */
const Preview = ({ name }: { name: string }) => (
  <div
    className="rounded-3xl p-6 sm:p-8 flex flex-col gap-5"
    style={{
      background:
        'linear-gradient(160deg, rgb(var(--bw-accent-rgb) / 0.10), rgb(var(--bw-accent-rgb) / 0.02) 55%), rgba(7,8,10,0.74)',
      boxShadow: `inset 0 0 0 1px ${HAIR}`,
    }}
  >
    <p className="m-0 text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: FAINT }}>
      What it becomes
    </p>
    <div className="flex items-center gap-4">
      <Avatar name={name} size={64} />
      <div className="min-w-0">
        <p className="m-0 text-xl font-semibold truncate">{name}</p>
        <p className="m-0 text-sm truncate" style={{ color: MUTED }}>
          {name}@{OPNS_PROFILE_DOMAIN}
        </p>
      </div>
    </div>
    <dl className="m-0 grid gap-3 text-sm">
      {[
        ['Pay me', `Anyone with bWalletX pays you by typing ${name}.`],
        ['Profile', `${name}@${OPNS_PROFILE_DOMAIN} shows your name and picture.`],
        ['Yours', 'One payment. No renewals, no expiry.'],
      ].map(([k, v]) => (
        <div key={k} className="flex gap-3 items-baseline">
          <dt className="w-16 shrink-0 text-xs font-semibold" style={{ color: GOLD }}>
            {k}
          </dt>
          <dd className="m-0 min-w-0 break-words" style={{ color: MUTED }}>
            {v}
          </dd>
        </div>
      ))}
    </dl>
  </div>
);

const Rail = (p: { title: string; sub: string; loading: boolean; children: ReactNode[] }) => {
  if (!p.loading && p.children.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 className="m-0 text-lg font-semibold tracking-tight">{p.title}</h2>
        <span className="text-sm" style={{ color: FAINT }}>
          {p.sub}
        </span>
      </div>
      <div className="flex flex-wrap gap-3 pb-2">
        {p.loading
          ? Array.from({ length: 6 }, (_, i) => (
              <div
                key={i}
                className="shrink-0 w-[150px] h-[104px] rounded-2xl animate-pulse"
                style={{ background: SURFACE }}
              />
            ))
          : p.children}
      </div>
    </section>
  );
};

const WhatIsThis = () => (
  <details className="mt-16 mx-auto max-w-2xl rounded-2xl px-5 py-4" style={{ boxShadow: `inset 0 0 0 1px ${HAIR}` }}>
    <summary className="cursor-pointer text-sm font-semibold" style={{ color: MUTED }}>
      What is this?
    </summary>
    <div className="mt-3 flex flex-col gap-2 text-[13px] leading-relaxed" style={{ color: FAINT }}>
      <p className="m-0">
        These are on-chain names (OpNS) on Bitcoin SV. Each name is a 1-sat ordinal inscription held by your wallet, not
        an account we can take back. Once it&apos;s yours it stays yours: no renewals and no expiry.
      </p>
      <p className="m-0">
        New names are first come, first served. Names already claimed can only be bought if their owner lists them.
      </p>
      {MARKET_ENABLED && (
        <p className="m-0">
          Prices are set in US dollars and paid in BSV at the live rate when you buy, plus a small network fee.
          Purchases are final; there are no refunds.
        </p>
      )}
      <p className="m-0">Your name takes payments in bWalletX once you set it as your name in Settings › Identity.</p>
    </div>
  </details>
);

const BuySheet = (p: {
  /** "Buy" a listed name, or "Get" a free one (mined here, tier price to the storefront). */
  verb?: 'Buy' | 'Get' | 'Sell';
  name: string;
  amount: string;
  sats: number;
  giftTo?: string;
  onAllow: () => void;
  onClose: () => void;
}) =>
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
        siteSub="Names"
        onClose={p.onClose}
        hero={
          <PayHero
            amount={p.amount}
            sub={fmtSats(p.sats)}
            badge={p.giftTo ? 'GIFT' : p.verb === 'Sell' ? 'SELL' : 'PAY'}
          />
        }
        title={
          p.giftTo ? (
            <>
              {p.verb ?? 'Buy'} <span style={{ color: CARD.gold }}>{p.name}</span> for {p.giftTo}
            </>
          ) : (
            <>
              {p.verb ?? 'Buy'} <span style={{ color: CARD.gold }}>{p.name}</span>
            </>
          )
        }
        primary={{ label: 'Allow', onClick: p.onAllow }}
        secondary={{ label: 'Not now', onClick: p.onClose }}
      >
        <div className="flex flex-wrap gap-2">
          {p.verb === 'Sell' ? (
            <>
              <Chip>Asking price, paid to you</Chip>
              <Chip>On the Exchange until it sells</Chip>
              <Chip>Take it off sale any time</Chip>
              <Chip>Plus a small network fee</Chip>
            </>
          ) : (
            <>
              <Chip>Yours forever</Chip>
              {p.verb === 'Get' && <Chip>Takes about a minute</Chip>}
              <Chip>Plus a small network fee</Chip>
              {p.giftTo ? <Chip>Sent to {p.giftTo} straight after</Chip> : <Chip>Kept in your wallet</Chip>}
              <Chip>No refunds</Chip>
            </>
          )}
        </div>
      </ApprovalCard>
    </div>,
    document.body,
  );

export default NameStorePage;
