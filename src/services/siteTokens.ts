/**
 * Site tokens: how an outside site delivers BSV-21 tokens a user buys into the wallet's own token view, and lets the
 * user sell them, without ever deriving or signing with the wallet's token keys (TokenBlaster BlastPad, 25 Oct 2026:
 * 'This protocol is reserved for bWalletX itself: "onesat"'). Site developers: docs/SITE-TOKENS.md.
 *
 * The holes the reservations close stay closed (reservedProtocols.ts, reservedBaskets.ts, b-Aware reports):
 *  - [0,'onesat'] stays reserved on every method. A site never learns a token key it did not ask the wallet for,
 *    and never gets a signature with one.
 *  - 'bsv21' stays reserved for listOutputs and relinquishOutput, and no basket grant for it is ever stored.
 *
 * What this adds, for outside originators only:
 *  1. Receive key. getPublicKey({ protocolID: SITE_TOKEN_RECEIVE, keyID: <tokenId>, counterparty: 'self' }) answers
 *     a FRESH token key the wallet picks itself: [0,'onesat'] with keyID `${tokenId}-${ms}`, exactly the key the
 *     wallet's own trades use (launchpad/client.ts freshTokenKey), so the coin is a normal wallet coin (token view,
 *     Send, seed recovery scan). The answer carries { publicKey, keyID }. The site cannot choose the keyID, so it
 *     cannot derive any key the wallet already uses, and two sites never get the same key. No sheet: a public key
 *     the wallet minted for this request reveals nothing else.
 *  2. Delivery. A createAction / internalizeAction output into basket 'bsv21' is accepted only when it is exactly a
 *     BSV-21 transfer of 1 sat to the P2PKH address of a key from (1) (or a keyID of that same shape that derives the
 *     address). The wallet writes the record itself (customInstructions, tags): whatever the site sent there is
 *     thrown away, so a site cannot relabel a coin (fake symbol/icon/amount) or point its record at another key.
 *  3. Selling. A site's createAction may spend the wallet's own token coins by outpoint. The wallet shows one sheet
 *     listing the tokens that leave and where every output goes; on Allow it signs those inputs itself at
 *     signAction (spends for them from the site are refused). The site never gets a token signature.
 *  4. The receive protocol is for getPublicKey only: createSignature, encrypt, HMAC, linkage with it are refused.
 */
import { PublicKey, Transaction, Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk';
import type { PromptRequest } from '@1sat/permission-module';
import { ONESAT, bsv21, tokenOutputTags, tokenSpends } from '../mobile/market/launchpad/tokens';

/** The receive-key request protocol (a name only: the key answered is a wallet token key, see above). */
export const SITE_TOKEN_RECEIVE: WalletProtocol = [1, 'bwalletx token receive'];
export const TOKEN_BASKET = 'bsv21';
const TOKEN_BASKETS = new Set(['bsv21', 'p 1sat bsv21']);

export const RECEIVE_ONLY_REFUSAL = 'bwalletx token receive is for getPublicKey only';
export const BAD_DELIVERY_REFUSAL = 'bWalletX takes a token into your wallet only to a receive key it gave this site';
export const SITE_SPENDS_REFUSAL = 'bWalletX signs its own token inputs; a site may not supply them';
export const SELL_REJECTED = 'You said no: nothing was signed';

const TOKEN_ID = /^[0-9a-f]{64}_\d{1,6}$/;
const MAX_ISSUED_PER_SITE = 500;
const ISSUED_TTL_MS = 24 * 60 * 60 * 1000;

const PROTOCOL_METHODS = [
  'createSignature',
  'verifySignature',
  'encrypt',
  'decrypt',
  'createHmac',
  'verifyHmac',
  'revealSpecificKeyLinkage',
] as const;

type Protocolish = { protocolID?: unknown };
const isReceiveProtocol = (p: unknown) =>
  Array.isArray(p) &&
  p.length === 2 &&
  p[0] === SITE_TOKEN_RECEIVE[0] &&
  typeof p[1] === 'string' &&
  p[1].trim().toLowerCase() === SITE_TOKEN_RECEIVE[1];

const normOutpoint = (op: string) => (op.length > 64 && op[64] === '_' ? `${op.slice(0, 64)}.${op.slice(65)}` : op);

/** The keyID the wallet mints for a receive key: the 1Sat wallets' own `${tokenId}-${ms}` (seed recovery scans it). */
export const receiveKeyID = (tokenId: string, ms: number) => `${tokenId}-${ms}`;

/** Parse a wallet receive keyID; null unless it is exactly `${tokenId}-${13-digit ms}`. */
export const parseReceiveKeyID = (keyID: unknown): { tokenId: string; ms: number } | null => {
  if (typeof keyID !== 'string') return null;
  const m = /^([0-9a-f]{64}_\d{1,6})-(\d{13})$/.exec(keyID);
  return m ? { tokenId: m[1], ms: Number(m[2]) } : null;
};

/**
 * Read a BSV-21 transfer output exactly as bWalletX writes one (launchpad/tokens.ts bsv21): the script must rebuild
 * byte for byte from its own id, amount and address, so nothing else rides along. Null when it is anything else.
 */
export const readTokenTransfer = (scriptHex: string): { id: string; amt: bigint; address: string } | null => {
  try {
    const m = /76a914([0-9a-f]{40})88ac$/i.exec(scriptHex);
    if (!m) return null;
    const ascii = Utils.toUTF8(Utils.toArray(scriptHex.slice(0, scriptHex.length - 50), 'hex'));
    const start = ascii.indexOf('{"p":"bsv-20"');
    const end = ascii.lastIndexOf('}');
    if (start < 0 || end < start) return null;
    const data = JSON.parse(ascii.slice(start, end + 1)) as { p?: string; op?: string; id?: string; amt?: string };
    if (data.p !== 'bsv-20' || data.op !== 'transfer' || typeof data.id !== 'string' || !TOKEN_ID.test(data.id))
      return null;
    if (typeof data.amt !== 'string' || !/^[1-9]\d{0,30}$/.test(data.amt)) return null;
    const address = Utils.toBase58Check(Utils.toArray(m[1], 'hex'), [0]);
    const amt = BigInt(data.amt);
    if (bsv21(data.id, amt, address).toHex() !== scriptHex.toLowerCase()) return null;
    return { id: data.id, amt, address };
  } catch {
    return null;
  }
};

/** The record the wallet writes on a delivered coin: the same note its own trades write, minus site claims. */
export const deliveredNote = (id: string, amt: bigint, keyID: string) =>
  JSON.stringify({ id, amt: amt.toString(), op: 'transfer', protocolID: ONESAT, keyID, counterparty: 'self' });

type Issued = { keyID: string; at: number };

export type SiteTokenDeps = {
  adminOriginator: string;
  normalize: (o: string) => string;
  /** The approval sheet (oneSatPrompt.showOneSatPrompt). */
  prompt: (req: PromptRequest) => Promise<boolean>;
  /** Time source (tests). */
  now?: () => number;
};

type AnyFn = (args: never, originator?: string) => Promise<unknown>;
type Out = {
  lockingScript?: string;
  satoshis?: number;
  basket?: string;
  customInstructions?: string;
  tags?: string[];
  outputDescription?: string;
};
type CreateArgs = {
  description?: string;
  inputs?: { outpoint?: string; unlockingScriptLength?: number; inputDescription?: string }[];
  outputs?: Out[];
  options?: { signAndProcess?: boolean } & Record<string, unknown>;
} & Record<string, unknown>;
type InternalizeArgs = {
  tx?: number[] | Uint8Array;
  outputs?: {
    outputIndex: number;
    protocol?: string;
    insertionRemittance?: { basket?: string; customInstructions?: string; tags?: string[] };
  }[];
} & Record<string, unknown>;
type SignArgs = { reference?: string; spends?: Record<number, unknown> } & Record<string, unknown>;

type TokenCoinRec = {
  outpoint: string;
  id: string;
  amt: bigint;
  sym?: string;
  protocolID: WalletProtocol;
  keyID: string;
};
type PendingSell = {
  originator: string;
  tx: number[];
  uses: { index: number; protocolID: WalletProtocol; keyID: string }[];
};

/**
 * Insertion tickets: guardReservedBaskets lets an outside 'bsv21' insertion through only against one of these. Each
 * guarded call holds its own ticket (one per output it validated) and drops whatever is left when it returns.
 */
type Ticket = { left: number };
const tickets = new Map<string, Ticket[]>();

/** Called by reservedBaskets.ensureBasketAccess: consume one validated-delivery ticket for this originator. */
export const takeTokenInsertionTicket = (originator: unknown, basket: unknown, usage: unknown): boolean => {
  if (typeof originator !== 'string' || typeof basket !== 'string') return false;
  if (basket.trim().toLowerCase() !== TOKEN_BASKET || (usage !== undefined && usage !== 'insertion')) return false;
  const t = tickets.get(originator)?.find((x) => x.left > 0);
  if (!t) return false;
  t.left--;
  return true;
};

const addTickets = (originator: string, n: number) => {
  if (n <= 0) return () => undefined;
  const t: Ticket = { left: n };
  tickets.set(originator, [...(tickets.get(originator) ?? []), t]);
  return () => {
    const rest = (tickets.get(originator) ?? []).filter((x) => x !== t);
    if (rest.length) tickets.set(originator, rest);
    else tickets.delete(originator);
  };
};

/** Test hook. */
export const _ticketsFor = (originator: string) => (tickets.get(originator) ?? []).reduce((n, t) => n + t.left, 0);

/**
 * Wrap the outermost wallet (the one background.ts hands every site): receive keys, validated deliveries and
 * wallet-signed sells for outside originators. Calls from the wallet itself pass straight through.
 */
export function guardSiteTokens<T extends object>(wallet: T, deps: SiteTokenDeps): T {
  const w = wallet as Record<string, unknown>;
  const now = deps.now ?? Date.now;
  const outside = (o?: string) => !!o && o !== deps.adminOriginator;
  const admin = deps.adminOriginator;
  const call = <R>(name: string, args: unknown, originator?: string): Promise<R> =>
    (w[`__site_${name}`] as AnyFn).call(wallet, args as never, originator) as Promise<R>;
  for (const name of ['getPublicKey', 'createAction', 'signAction', 'abortAction', 'internalizeAction', 'listOutputs'])
    if (typeof w[name] === 'function') w[`__site_${name}`] = w[name];
  for (const name of PROTOCOL_METHODS) if (typeof w[name] === 'function') w[`__site_${name}`] = w[name];

  const issued = new Map<string, Map<string, Issued>>(); // site -> address -> key
  let lastMs = 0;

  const deriveAddress = async (keyID: string) => {
    const { publicKey } = await call<{ publicKey: string }>(
      'getPublicKey',
      { protocolID: ONESAT, keyID, counterparty: 'self' },
      admin,
    );
    return { publicKey, address: PublicKey.fromString(publicKey).toAddress() };
  };

  /** The keyID that locks `address` for this site, or null: an issued key, or a receive-shaped keyID that derives it. */
  const keyFor = async (site: string, tokenId: string, address: string, claimed?: unknown): Promise<string | null> => {
    const hit = issued.get(site)?.get(address);
    if (hit && parseReceiveKeyID(hit.keyID)?.tokenId === tokenId) return hit.keyID;
    const parsed = parseReceiveKeyID(claimed);
    if (!parsed || parsed.tokenId !== tokenId || parsed.ms > now() + ISSUED_TTL_MS) return null;
    const d = await deriveAddress(claimed as string);
    return d.address === address ? (claimed as string) : null;
  };

  const claimedKeyID = (ci: unknown) => {
    if (typeof ci !== 'string') return undefined;
    try {
      return (JSON.parse(ci) as { keyID?: unknown }).keyID;
    } catch {
      return undefined;
    }
  };

  /** Validate and rewrite one delivered output in place; throws BAD_DELIVERY_REFUSAL otherwise. */
  const checkDelivery = async (site: string, scriptHex: string, sats: number, ci: unknown) => {
    const t = readTokenTransfer(scriptHex);
    if (!t || sats !== 1) throw new Error(`${BAD_DELIVERY_REFUSAL} (not a 1-sat BSV-21 transfer)`);
    const keyID = await keyFor(site, t.id, t.address, claimedKeyID(ci));
    if (!keyID) throw new Error(`${BAD_DELIVERY_REFUSAL} (unknown receive key; ask getPublicKey again)`);
    return { customInstructions: deliveredNote(t.id, t.amt, keyID), tags: tokenOutputTags(t.id) };
  };

  // 1. Receive keys.
  const getPublicKey = w.getPublicKey as AnyFn | undefined;
  if (typeof getPublicKey === 'function')
    w.getPublicKey = async (args: Protocolish & { keyID?: unknown; counterparty?: unknown }, originator?: string) => {
      if (!outside(originator) || !isReceiveProtocol(args?.protocolID)) return call('getPublicKey', args, originator);
      const tokenId = typeof args.keyID === 'string' ? args.keyID.trim().replace('.', '_') : '';
      if (!TOKEN_ID.test(tokenId)) throw new Error('keyID must be the BSV-21 token id (txid_vout)');
      if (args.counterparty !== undefined && args.counterparty !== 'self')
        throw new Error("counterparty must be 'self' for a token receive key");
      const site = deps.normalize(originator!);
      const ms = (lastMs = Math.max(now(), lastMs + 1));
      const keyID = receiveKeyID(tokenId, ms);
      const { publicKey, address } = await deriveAddress(keyID);
      let mine = issued.get(site);
      if (!mine) issued.set(site, (mine = new Map()));
      for (const [a, k] of mine) if (now() - k.at > ISSUED_TTL_MS || mine.size >= MAX_ISSUED_PER_SITE) mine.delete(a);
      mine.set(address, { keyID, at: now() });
      return { publicKey, keyID };
    };

  // 4. The receive protocol signs nothing for a site.
  for (const name of PROTOCOL_METHODS) {
    if (typeof w[name] !== 'function') continue;
    w[name] = async (args: Protocolish, originator?: string) => {
      if (outside(originator) && isReceiveProtocol(args?.protocolID)) throw new Error(RECEIVE_ONLY_REFUSAL);
      return call(name, args, originator);
    };
  }

  // 3. Selling: the wallet's own token coins named as inputs.
  const pending = new Map<string, PendingSell>();
  const walletTokenCoins = async (): Promise<Map<string, TokenCoinRec>> => {
    const out = new Map<string, TokenCoinRec>();
    for (const basket of TOKEN_BASKETS) {
      const r = await call<{
        outputs: { outpoint: string; spendable?: boolean; customInstructions?: string; tags?: string[] }[];
      }>('listOutputs', { basket, includeCustomInstructions: true, includeTags: true, limit: 10000 }, admin).catch(
        () => null,
      );
      for (const o of r?.outputs ?? []) {
        if (o.spendable === false) continue;
        let ci: Record<string, unknown> = {};
        try {
          ci = o.customInstructions ? JSON.parse(o.customInstructions) : {};
        } catch {
          continue;
        }
        if (!Array.isArray(ci.protocolID) || typeof ci.keyID !== 'string' || typeof ci.id !== 'string') continue;
        out.set(normOutpoint(o.outpoint), {
          outpoint: normOutpoint(o.outpoint),
          id: ci.id,
          amt: BigInt(typeof ci.amt === 'string' && /^\d+$/.test(ci.amt) ? ci.amt : '0'),
          sym: typeof ci.sym === 'string' ? ci.sym : undefined,
          protocolID: ci.protocolID as WalletProtocol,
          keyID: ci.keyID,
        });
      }
    }
    return out;
  };

  const sellSheet = (originator: string, args: CreateArgs, sold: TokenCoinRec[]): PromptRequest => {
    const short = (s: string) => (s.length > 20 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);
    const panels: Record<string, unknown>[] = sold.map((c) => ({
      title: `${c.amt.toLocaleString()} ${c.sym ? `$${c.sym}` : short(c.id)}`,
      subtitle: 'Leaves your wallet',
      subtitleCopy: c.id,
      variant: 'token',
      tone: 'danger',
    }));
    for (const o of args.outputs ?? []) {
      const hex = o.lockingScript ?? '';
      const t = readTokenTransfer(hex);
      if (t && o.basket === TOKEN_BASKET)
        panels.push({
          title: `${t.amt.toLocaleString()} ${short(t.id)}`,
          subtitle: 'Comes to your wallet',
          variant: 'token',
        });
      else {
        const p2pkh = /^76a914([0-9a-f]{40})88ac$/i.exec(hex);
        const to = p2pkh
          ? Utils.toBase58Check(Utils.toArray(p2pkh[1], 'hex'), [0])
          : t
            ? `tokens to ${t.address}`
            : 'a script';
        panels.push({
          title: o.outputDescription?.slice(0, 80) || 'Output',
          subtitle: `To ${short(to)}`,
          subtitleCopy: to,
          variant: 'value',
          amountSats: o.satoshis ?? 0,
          valueIcon: 'pay',
        });
      }
    }
    return {
      kind: 'transaction',
      originator,
      summary: `${originator} wants to spend ${sold.length} token coin${sold.length === 1 ? '' : 's'} from your wallet`,
      payload: {
        title: 'Transaction Request',
        subtitle: originator,
        panels,
        rows: [{ key: 'What the site says', value: String(args.description ?? '').slice(0, 200) }],
      },
    };
  };

  const createAction = w.createAction as AnyFn | undefined;
  if (typeof createAction === 'function')
    w.createAction = async (args: CreateArgs, originator?: string) => {
      if (!outside(originator)) return call('createAction', args, originator);
      const site = deps.normalize(originator!);
      // 2. Deliveries into the token basket: rewrite the record, or refuse.
      let deliveries = 0;
      let next: CreateArgs = args;
      if (
        args?.outputs?.some((o) => typeof o?.basket === 'string' && TOKEN_BASKETS.has(o.basket.trim().toLowerCase()))
      ) {
        const outputs: Out[] = [];
        for (const o of args.outputs) {
          if (typeof o?.basket !== 'string' || !TOKEN_BASKETS.has(o.basket.trim().toLowerCase())) {
            outputs.push(o);
            continue;
          }
          const rec = await checkDelivery(
            site,
            String(o.lockingScript ?? ''),
            Number(o.satoshis),
            o.customInstructions,
          );
          outputs.push({ ...o, basket: TOKEN_BASKET, ...rec });
          deliveries++;
        }
        next = { ...args, outputs };
      }
      // 3. Wallet token coins named as inputs.
      const named = (args?.inputs ?? []).map((i) => (typeof i?.outpoint === 'string' ? normOutpoint(i.outpoint) : ''));
      const coins = named.some(Boolean) ? await walletTokenCoins() : new Map<string, TokenCoinRec>();
      const sold = named.map((op) => coins.get(op)).filter((c): c is TokenCoinRec => !!c);
      const wantsAuto = sold.length > 0 && next.options?.signAndProcess !== false;
      if (sold.length > 0) {
        if (!(await deps.prompt(sellSheet(originator!, next, sold)))) throw new Error(SELL_REJECTED);
        next = { ...next, options: { ...(next.options ?? {}), signAndProcess: false } };
      }
      const release = addTickets(originator!, deliveries);
      let res: { signableTransaction?: { tx: number[]; reference: string } } & Record<string, unknown>;
      try {
        res = (await call('createAction', next, originator)) as typeof res;
      } finally {
        release();
      }
      if (sold.length === 0) return res;
      const signable = res.signableTransaction;
      if (!signable) throw new Error('The wallet did not return a transaction to sign');
      const tx = Transaction.fromAtomicBEEF(signable.tx);
      const uses: PendingSell['uses'] = [];
      tx.inputs.forEach((inp, index) => {
        const op = `${inp.sourceTXID ?? inp.sourceTransaction?.id('hex')}.${inp.sourceOutputIndex}`;
        const c = coins.get(op);
        if (c && sold.includes(c)) uses.push({ index, protocolID: c.protocolID, keyID: c.keyID });
      });
      if (uses.length !== sold.length) {
        await call('abortAction', { reference: signable.reference }, originator).catch(() => undefined);
        throw new Error('The transaction to sign does not spend the coins you approved');
      }
      pending.set(signable.reference, { originator: originator!, tx: Array.from(signable.tx), uses });
      if (!wantsAuto) return res;
      return (w.signAction as AnyFn).call(wallet, { reference: signable.reference, spends: {} } as never, originator);
    };

  const signAction = w.signAction as AnyFn | undefined;
  if (typeof signAction === 'function')
    w.signAction = async (args: SignArgs, originator?: string) => {
      const p = args?.reference ? pending.get(args.reference) : undefined;
      if (!p) return call('signAction', args, originator);
      if (p.originator !== originator) throw new Error('This transaction belongs to another site');
      const spends = { ...(args.spends ?? {}) } as Record<number, unknown>;
      for (const u of p.uses) if (spends[u.index] !== undefined) throw new Error(SITE_SPENDS_REFUSAL);
      const tx = Transaction.fromAtomicBEEF(p.tx);
      const adminWallet = {
        createSignature: (a: unknown) => call('createSignature', a, admin),
        getPublicKey: (a: unknown) => call('getPublicKey', a, admin),
      } as unknown as WalletInterface;
      Object.assign(spends, await tokenSpends(adminWallet, tx, p.uses));
      const done = await call('signAction', { ...args, spends }, originator);
      pending.delete(args.reference!);
      return done;
    };

  const abortAction = w.abortAction as AnyFn | undefined;
  if (typeof abortAction === 'function')
    w.abortAction = async (args: { reference?: string }, originator?: string) => {
      const p = args?.reference ? pending.get(args.reference) : undefined;
      if (p && p.originator === originator) pending.delete(args.reference!);
      return call('abortAction', args, originator);
    };

  // 2b. internalizeAction into the token basket (a site sending tokens later).
  const internalize = w.internalizeAction as AnyFn | undefined;
  if (typeof internalize === 'function')
    w.internalizeAction = async (args: InternalizeArgs, originator?: string) => {
      const hits = (args?.outputs ?? []).filter(
        (o) =>
          o?.protocol === 'basket insertion' &&
          typeof o.insertionRemittance?.basket === 'string' &&
          TOKEN_BASKETS.has(o.insertionRemittance.basket.trim().toLowerCase()),
      );
      if (!outside(originator) || hits.length === 0) return call('internalizeAction', args, originator);
      const site = deps.normalize(originator!);
      const tx = Transaction.fromAtomicBEEF(Array.from(args.tx ?? []));
      const outputs = [];
      for (const o of args.outputs ?? []) {
        if (!hits.includes(o)) {
          outputs.push(o);
          continue;
        }
        const out = tx.outputs[o.outputIndex];
        if (!out) throw new Error(`${BAD_DELIVERY_REFUSAL} (no output ${o.outputIndex})`);
        const rec = await checkDelivery(
          site,
          out.lockingScript.toHex(),
          Number(out.satoshis),
          o.insertionRemittance?.customInstructions,
        );
        outputs.push({ ...o, insertionRemittance: { basket: TOKEN_BASKET, ...rec } });
      }
      const release = addTickets(originator!, hits.length);
      try {
        return await call('internalizeAction', { ...args, outputs }, originator);
      } finally {
        release();
      }
    };

  return wallet;
}
