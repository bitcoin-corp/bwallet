/**
 * Memepool buy/sell flow (docs/MEMEPOOL-TRADING-DESIGN.md). THIS FILE MOVES MONEY (money-paths.txt).
 *
 *   quote → prepare (trader {ord, pay}, our coins) → verify the template here → ONE approval sheet (the caller)
 *   → sign only our inputs (SIGHASH_ALL|FORKID) → submit → watch the transaction.
 *
 * A buy first sets the BSV for the trade aside on a fresh key of this wallet (a payment to itself), because Memepool
 * spends named coins and the wallet's own coins can't be signed one by one. If the trade doesn't happen, that coin
 * is taken back into the wallet's balance (cancel). Rules the owner set: one sheet; 409 = re-prepare once, and after
 * a signature never sign again silently (a fresh sheet instead); after submit, never re-sign, only watch.
 */
import {
  CAP_SATS,
  DEFAULT_SLIPPAGE_BPS,
  MAX_INDEX_FEE,
  MAX_SLIPPAGE_BPS,
  MIN_BUY_SATS,
  NETWORK_ALLOWANCE,
  QUOTE_TTL_MS,
  SELL_NETWORK_RESERVE,
} from './constants';
import {
  MemepoolHttpError,
  configProblem,
  getCoin,
  getConfig,
  getProof,
  getQuote,
  plainError,
  prepareTrade,
  submitTrade,
  type Fetcher,
} from './api';
import { CurveError, buyTokens, minTokensFor, parseCurve, sellSats, type CurveParams, type CurveState } from './curve';
import { proofVerdict, type ProofVerdict } from './proof';
import { isAddress } from './script';
import type { CoinKey } from './sign';
import {
  TradeRefused,
  verifyTemplate,
  type CheckedTrade,
  type OurCoin,
  type Template,
  type VerifyContext,
} from './validate';

export { TradeRefused };

const ZERO = BigInt(0);

/** A coin of ours offered to a trade, with the key that signs it. */
export type OfferedCoin = { txid: string; vout: number; satoshis: number; script: string; amt?: bigint; key: CoinKey };
export type PayKey = { address: string; key: CoinKey; derivationPrefix: string; derivationSuffix: string };
export type OrdKey = { address: string; key: CoinKey };
export type Funding = { coin: OfferedCoin; beef: number[]; pay: PayKey };

/** What the flow needs from the wallet (memepool/wallet.ts builds it from the in-app BRC-100 wallet). */
export type TradeWallet = {
  newOrdKey(tokenId: string): Promise<OrdKey>;
  newPayKey(): Promise<PayKey>;
  /** Pay `sats` to our own `pay` key; resolves once the wallet has sent it. */
  fund(pay: PayKey, sats: number): Promise<Funding>;
  /** Take a funding coin that wasn't spent back into the wallet's balance. */
  returnFunding(f: Funding): Promise<void>;
  /** Our token coins of `tokenId` that this wallet can sign, largest first. */
  tokenCoins(tokenId: string): Promise<OfferedCoin[]>;
  /** Unlocking scripts for exactly these input indexes. */
  sign(t: Template, indexes: number[], keyFor: (i: number) => CoinKey | undefined): Promise<Record<string, string>>;
  /** Record what the trade paid us (tokens, change, payout) once the network has it. */
  receive(txid: string, t: Template, p: { ord: OrdKey; pay: PayKey; sym: string; tokenId: string }): Promise<void>;
};

export type Deps = { fetch: Fetcher; wallet: TradeWallet; now?: () => number; sleep?: (ms: number) => Promise<void> };
const nowOf = (d: Deps) => (d.now ?? Date.now)();
const sleepOf = (d: Deps) => d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

export type Market = {
  tokenId: string;
  sym: string;
  params: CurveParams;
  state: CurveState;
  proof: ProofVerdict;
  indexAddress: string | null;
};

const plain = (why: string): never => {
  throw new TradeRefused(why);
};

/** Everything a trade needs to know about one coin, or a plain-English refusal. */
export async function loadMarket(d: Deps, tokenId: string): Promise<Market> {
  const [cfg, coin, proofBody] = await Promise.all([
    getConfig(d.fetch),
    getCoin(d.fetch, tokenId),
    getProof(d.fetch),
  ]).catch((e) => plain(plainError(e)));
  const why = configProblem(cfg);
  if (why) plain(why);
  const proof = proofVerdict(proofBody, tokenId);
  if (!proof.healthy) plain(proof.why);
  if (coin.status !== 'live' || coin.haltReason || coin.pause) plain('Memepool has paused trading this coin for now.');
  if (proof.healthy && (coin.poolPay !== proof.row.poolPay || coin.poolOrd !== proof.row.poolOrd))
    plain("This coin's pool doesn't match Memepool's proof of reserves, so we won't trade it.");
  const curve = parseCurve(coin);
  if (!curve) plain("Memepool's numbers for this coin don't add up, so we won't trade it.");
  const ix = (coin.indexer as { fundAddress?: unknown } | undefined)?.fundAddress;
  return {
    tokenId,
    sym: typeof coin.sym === 'string' ? coin.sym.slice(0, 20) : tokenId.slice(0, 6),
    params: curve!.params,
    state: curve!.state,
    proof,
    indexAddress: isAddress(ix) ? ix : null,
  };
}

const clampSlip = (bps: number) => Math.max(10, Math.min(MAX_SLIPPAGE_BPS, Math.floor(bps || DEFAULT_SLIPPAGE_BPS)));
const num = (v: unknown): bigint | null =>
  typeof v === 'string' && /^\d{1,20}$/.test(v)
    ? BigInt(v)
    : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
      ? BigInt(v)
      : null;

/** A checked trade waiting for the user's Allow. */
export type Prepared = {
  side: 'buy' | 'sell';
  market: Market;
  /** Buy: sats budget. Sell: tokens. */
  amount: bigint;
  slippageBps: number;
  quoteId: string;
  template: Template;
  expiresAt: number;
  checked: CheckedTrade;
  limits: VerifyContext['limits'];
  /** Buy: the most that can leave the wallet (what the sheet shows). */
  maxSpend: bigint;
  ord: OrdKey;
  pay: PayKey;
  coins: OfferedCoin[];
  funding: Funding | null;
};

type Limits = { limits: VerifyContext['limits']; maxSpend: bigint; indexFee: number };

/** Limits from OUR curve maths at the user's slippage, cross-checked with Memepool's quote. */
async function limitsFor(d: Deps, m: Market, side: 'buy' | 'sell', amount: bigint, slip: number): Promise<Limits> {
  const q = await getQuote(d.fetch, m.tokenId, side, amount).catch((e) => plain(plainError(e)));
  const qTokens = num(q.tokens);
  const qGross = num(q.grossSats);
  const indexFee = Number(num(q.indexFeeSats) ?? -1);
  if (qTokens === null || qGross === null || !(indexFee >= 0)) plain("Memepool's quote doesn't add up.");
  if (indexFee > MAX_INDEX_FEE) plain('Memepool asks for an unusually high indexer fee.');
  try {
    if (side === 'buy') {
      if (amount < MIN_BUY_SATS) plain('The smallest buy on Memepool is 0.0001 BSV.');
      if (amount > CAP_SATS) plain('The most you can buy in one go is 1 BSV.');
      const ours = buyTokens(m.params, m.state, amount);
      const minTokens = minTokensFor(ours, slip);
      if (minTokens <= ZERO) plain('That buy is too small to get any tokens.');
      if (qTokens! < minTokens) plain('The price moved more than you allowed. Try again.');
      const charged = qGross! < amount ? qGross! : amount;
      const maxSpend = charged + BigInt(indexFee + NETWORK_ALLOWANCE);
      return { limits: { maxSpendSats: maxSpend, minTokens }, maxSpend, indexFee };
    }
    const ours = sellSats(m.params, m.state, amount);
    if (ours.gross > CAP_SATS) plain('The most you can sell in one go is 1 BSV worth. Sell fewer tokens.');
    const expected = ours.net - BigInt(indexFee + SELL_NETWORK_RESERVE);
    const minSats = (expected * BigInt(10_000 - slip)) / BigInt(10_000);
    if (minSats < BigInt(1)) plain('That sell is too small to cover its fees.');
    return { limits: { tokens: amount, minSats }, maxSpend: ZERO, indexFee };
  } catch (e) {
    if (e instanceof CurveError) plain(e.message);
    throw e;
  }
}

/** POST /trade/prepare and verify. 409 = once more; a coin the network hasn't shown yet is waited for. */
async function prepareAndVerify(
  d: Deps,
  m: Market,
  side: 'buy' | 'sell',
  amount: bigint,
  l: Limits,
  ord: OrdKey,
  pay: PayKey,
  coins: OfferedCoin[],
): Promise<{ template: Template; quoteId: string; expiresAt: number; checked: CheckedTrade }> {
  const body = {
    tokenId: m.tokenId,
    side,
    ...(side === 'buy'
      ? { sats: Number(amount), minTokens: (l.limits as { minTokens: bigint }).minTokens.toString() }
      : { tokens: amount.toString(), minSats: Number((l.limits as { minSats: bigint }).minSats) }),
    trader: { ord: ord.address, pay: pay.address },
    coins: coins.map((c) => ({ txid: c.txid, vout: c.vout })),
  };
  let prep: Record<string, unknown> | null = null;
  let stale = 0;
  for (let wait = 0; !prep; ) {
    try {
      prep = await prepareTrade(d.fetch, body);
    } catch (e) {
      if (e instanceof MemepoolHttpError && e.status === 409 && stale++ < 1) continue; // re-prepare once
      if (e instanceof MemepoolHttpError && e.code === 'unknown_coin' && wait++ < 10) {
        await sleepOf(d)(1500); // our just-sent coin hasn't reached Memepool's indexer yet
        continue;
      }
      plain(plainError(e));
    }
  }
  const template = prep!.template as Template;
  const quoteId = prep!.quoteId;
  if (typeof quoteId !== 'string' || !quoteId || !template) plain("Memepool sent an answer this wallet can't read.");
  const exp = Number(prep!.expiresAt);
  const now = nowOf(d);
  // Memepool may send seconds or ms; never trust more than our own TTL.
  const expiresAt = Math.min(
    Number.isFinite(exp) && exp > 0 ? (exp < 1e12 ? exp * 1000 : exp) : Infinity,
    now + QUOTE_TTL_MS,
  );
  const ctx: VerifyContext = {
    side,
    tokenId: m.tokenId,
    me: {
      ord: ord.address,
      pay: pay.address,
      coins: new Map<string, OurCoin>(
        coins.map((c) => [`${c.txid}_${c.vout}`, { satoshis: c.satoshis, script: c.script, amt: c.amt }]),
      ),
    },
    proof: m.proof,
    indexAddress: m.indexAddress,
    limits: l.limits,
    expiresAt,
    now,
  };
  return { template, quoteId: quoteId as string, expiresAt, checked: verifyTemplate(template, ctx) };
}

/** Quote, prepare and check a buy of `budget` sats. Sets the BSV aside first (see the header). */
export async function prepareBuy(d: Deps, m: Market, budget: bigint, slippageBps: number): Promise<Prepared> {
  const slip = clampSlip(slippageBps);
  const l = await limitsFor(d, m, 'buy', budget, slip);
  const ord = await d.wallet.newOrdKey(m.tokenId);
  const pay = await d.wallet.newPayKey();
  const funding = await d.wallet.fund(pay, Number(l.maxSpend));
  try {
    const r = await prepareAndVerify(d, m, 'buy', budget, l, ord, pay, [funding.coin]);
    return {
      side: 'buy',
      market: m,
      amount: budget,
      slippageBps: slip,
      ...r,
      ...l,
      ord,
      pay,
      coins: [funding.coin],
      funding,
    };
  } catch (e) {
    await d.wallet.returnFunding(funding).catch(() => undefined);
    throw e;
  }
}

/** Quote, prepare and check a sell of `tokens`. */
export async function prepareSell(d: Deps, m: Market, tokens: bigint, slippageBps: number): Promise<Prepared> {
  const slip = clampSlip(slippageBps);
  if (tokens <= ZERO) plain('Enter how many tokens to sell.');
  const l = await limitsFor(d, m, 'sell', tokens, slip);
  const all = await d.wallet.tokenCoins(m.tokenId);
  const coins: OfferedCoin[] = [];
  let held = ZERO;
  for (const c of all) {
    if (held >= tokens || coins.length >= 8) break;
    coins.push(c);
    held += c.amt ?? ZERO;
  }
  if (held < tokens) plain(`You can sell ${held.toLocaleString('en-US')} right now (new coins can take a minute).`);
  const ord = await d.wallet.newOrdKey(m.tokenId); // where any tokens left over come back
  const pay = await d.wallet.newPayKey(); // where the BSV comes back
  const r = await prepareAndVerify(d, m, 'sell', tokens, l, ord, pay, coins);
  return { side: 'sell', market: m, amount: tokens, slippageBps: slip, ...r, ...l, ord, pay, coins, funding: null };
}

export type ExecuteResult =
  /** Memepool took it and is broadcasting. Watch `txid`; never sign again. */
  | { kind: 'sent'; txid: string }
  /** Someone traded first. Here's a fresh, checked trade: show it on a NEW sheet, never sign it silently. */
  | { kind: 'new-sheet'; prepared: Prepared; brokeMinimum: boolean }
  /** We don't know whether Memepool broadcast it. Watch our coin; never sign again. */
  | { kind: 'unsure'; message: string };

/** The user said Allow: check again, sign only our inputs, submit. */
export async function executeTrade(d: Deps, p: Prepared): Promise<ExecuteResult> {
  const keys = new Map(p.coins.map((c) => [`${c.txid}_${c.vout}`, c.key]));
  // The same checks again, right before signing (the quote may have expired while the sheet was open).
  const checked = verifyTemplate(p.template, {
    side: p.side,
    tokenId: p.market.tokenId,
    me: {
      ord: p.ord.address,
      pay: p.pay.address,
      coins: new Map(
        p.coins.map((c) => [`${c.txid}_${c.vout}`, { satoshis: c.satoshis, script: c.script, amt: c.amt }]),
      ),
    },
    proof: p.market.proof,
    indexAddress: p.market.indexAddress,
    limits: p.limits,
    expiresAt: p.expiresAt,
    now: nowOf(d),
  });
  const unlocks = await d.wallet.sign(p.template, checked.ourInputs, (i) => {
    const inp = p.template.inputs[i];
    return keys.get(`${inp.txid}_${inp.vout}`);
  });
  let out: Record<string, unknown>;
  try {
    out = await submitTrade(d.fetch, { quoteId: p.quoteId, unlocks });
  } catch (e) {
    if (e instanceof MemepoolHttpError && e.status === 409) {
      // Stale. Our coins weren't spent. Re-prepare once from a fresh look at the coin; the user decides again.
      const m = await loadMarket(d, p.market.tokenId);
      const l = await limitsFor(d, m, p.side, p.amount, p.slippageBps);
      const r = await prepareAndVerify(d, m, p.side, p.amount, l, p.ord, p.pay, p.coins);
      const brokeMinimum =
        p.side === 'buy'
          ? r.checked.tokens < (p.limits as { minTokens: bigint }).minTokens
          : r.checked.sats < (p.limits as { minSats: bigint }).minSats;
      return { kind: 'new-sheet', brokeMinimum, prepared: { ...p, market: m, ...r, ...l } };
    }
    if (e instanceof MemepoolHttpError && e.status >= 400 && e.status < 500) {
      // A definite refusal: nothing was broadcast. Put a buy's BSV back.
      if (p.funding) await d.wallet.returnFunding(p.funding).catch(() => undefined);
      plain(plainError(e));
    }
    return {
      kind: 'unsure',
      message: "We sent the trade but Memepool didn't confirm it. We're watching the network for it.",
    };
  }
  const txid = typeof out.txid === 'string' && /^[0-9a-f]{64}$/.test(out.txid) ? out.txid : null;
  if (!txid)
    return { kind: 'unsure', message: "Memepool took the trade but didn't say its id. We're watching for it." };
  return { kind: 'sent', txid };
}

/** The user said Cancel (or the sheet closed): a buy's set-aside BSV goes back into the wallet. */
export async function cancelPrepared(d: Deps, p: Prepared): Promise<void> {
  if (p.funding) await d.wallet.returnFunding(p.funding);
}

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

/** Wait until the network knows `txid` (up to ~2 minutes). Never signs anything. */
export async function watchTx(d: Deps, txid: string, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const r = await d.fetch(`${WOC}/tx/hash/${txid}`, { credentials: 'omit' }).catch(() => null);
    if (r?.ok) return true;
    await sleepOf(d)(3000);
  }
  return false;
}

/** After an unsure submit: which transaction (if any) spent our first coin. Never signs anything. */
export async function watchSpend(d: Deps, coin: { txid: string; vout: number }, tries = 40): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    const r = await d.fetch(`${WOC}/tx/${coin.txid}/${coin.vout}/spent`, { credentials: 'omit' }).catch(() => null);
    if (r?.ok) {
      const j = (await r.json().catch(() => null)) as { txid?: unknown } | null;
      if (typeof j?.txid === 'string' && /^[0-9a-f]{64}$/.test(j.txid)) return j.txid;
    }
    await sleepOf(d)(3000);
  }
  return null;
}

export { DEFAULT_SLIPPAGE_BPS };
