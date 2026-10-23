import { deployBsv21Mint, inscribe, type OneSatContext } from '@1sat/actions';
import { rememberDeployOutput } from '../chat/holdings';
import type { CreateActionArgs, LockingScript, WalletInterface } from '@bsv/sdk';
import { isNative } from '../native';
import { BchatClient, defaultHttp, loadSession, saveSession } from '../chat/api';
import { walletSigner } from '../chat/signer';
import { proveHoldings } from '../chat/holdings';
import { MINT_APP, fileToBase64, withFeeOutput } from '../mint/mint';
import { withIssuerSignature } from '../issuer/issuerSign';
import { registerIssuer } from '../issuer/issuerVerify';
import { rememberOwnToken } from '../tokens/indexFund';
import { CURVE_MAP_DESCRIPTION, curveMapScript } from '../curves/curveMap';
import type { Curve } from '../../lib/curves';
import {
  TICKET_DECIMALS,
  TICKET_MIN,
  TICKET_PURPOSE,
  cleanTicket,
  foundingMessage,
  localTickets,
  parseTicketList,
  saveLocalTicket,
  ticketMapScript,
  ticketRegistration,
  type Ticket,
  type TicketForm,
} from './tickets';

/**
 * Ticket network steps, run only after the user confirms SendConfirmation:
 *   1. (optional) inscribe the icon image → its outpoint is the token's icon;
 *   2. deploy the BSV-21 ticket (fixed supply to self) with the MAP `type=ticket` marker and the
 *      1% bWallet mint fee output on the same tx;
 *   3. open the holders' room in bit-sign (signatures only), post the founding note, and register
 *      the ticket so the Market's Tickets filter lists it.
 * Steps 3 can fail while the new token is not yet indexed; the ticket is kept locally with
 * `roomTicker: null` and `finishTicketRooms` retries from the Market.
 */

/** A context whose wallet appends a 0-sat output (a MAP tag) to the NEXT createAction (the deploy). */
export function withMapOutput(ctx: OneSatContext, script: LockingScript, description: string): OneSatContext {
  let done = false;
  const wallet = new Proxy(ctx.wallet as WalletInterface, {
    get(target, prop, receiver) {
      if (prop === 'createAction' && !done) {
        return (args: CreateActionArgs, originator?: string) => {
          done = true;
          const outputs = [
            ...(args.outputs ?? []),
            { lockingScript: script.toHex(), satoshis: 0, outputDescription: description },
          ];
          return target.createAction({ ...args, outputs }, originator);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ...ctx, wallet } as OneSatContext;
}

export async function inscribeIcon(ctx: OneSatContext, file: File, ticker: string, what = 'ticket'): Promise<string> {
  const res = await inscribe.execute(ctx, {
    base64Content: fileToBase64(await file.arrayBuffer()),
    contentType: file.type,
    map: { app: MINT_APP, type: 'ord', name: `$${ticker} ${what} icon` },
  });
  if (!res.txid || res.error) throw new Error(res.error || 'Icon inscription failed');
  return `${res.txid}_0`;
}

/**
 * Shared BSV-21 deploy (tickets and plain tokens): fixed supply to self, the 1% mint fee output,
 * and an optional MAP tag output on the same tx. Indexing is not paid here: the creator sets up the
 * token's room / listing later (tokens/roomSetup.ts). `amount` is in raw units. Returns the token id
 * as `txid_vout`.
 */
export async function deployBsv21(
  ctx: OneSatContext,
  opts: {
    symbol: string;
    amount: string;
    decimals: number;
    icon: string | null;
    feeSats: number;
    map?: { script: LockingScript; description: string };
    /** The launch curve, committed on the deploy tx as its own MAP output (fixed from then on). */
    curve?: Curve | null;
  },
): Promise<string> {
  const withFee = withIssuerSignature(withFeeOutput(ctx, opts.feeSats), 'bsv21');
  const withCurve = opts.curve ? withMapOutput(withFee, curveMapScript(opts.curve), CURVE_MAP_DESCRIPTION) : withFee;
  const res = await deployBsv21Mint.execute(
    opts.map ? withMapOutput(withCurve, opts.map.script, opts.map.description) : withCurve,
    {
      symbol: opts.symbol,
      amount: opts.amount,
      decimals: opts.decimals,
      ...(opts.icon ? { icon: opts.icon } : {}),
    },
  );
  if (res.error || !res.tokenId) throw new Error(res.error || 'Mint failed');
  const tokenId = res.tokenId.replace('.', '_');
  void registerIssuer(tokenId);
  // The deploy output's key is the issuer key a token room's admin claim must sign with.
  void rememberDeployOutput(ctx, tokenId).catch(() => undefined);
  // Minting no longer pays indexing; remembered as own so "Set up $X's room" can offer it later.
  rememberOwnToken({ tokenId, ticker: opts.symbol });
  return tokenId;
}

export async function deployTicket(
  ctx: OneSatContext,
  form: TicketForm,
  opts: { icon: string | null; feeSats: number },
): Promise<Ticket> {
  const c = cleanTicket(form);
  const tokenId = await deployBsv21(ctx, {
    symbol: c.ticker,
    amount: c.supply,
    decimals: TICKET_DECIMALS,
    icon: opts.icon,
    feeSats: opts.feeSats,
    map: { script: ticketMapScript(form), description: 'bWallet ticket (MAP)' },
  });
  const ticket: Ticket = {
    tokenId,
    ticker: c.ticker,
    name: c.name,
    description: c.description || null,
    icon: opts.icon,
    eventDate: c.eventDate,
    priceSats: c.priceSats,
    supply: c.supply,
    min: c.min,
    roomTicker: null,
    createdAt: Date.now(),
  };
  saveLocalTicket(ticket);
  return ticket;
}

export async function chatClient(ctx: OneSatContext): Promise<BchatClient> {
  const client = new BchatClient(defaultHttp(isNative), loadSession());
  if (!client.handle) saveSession(await client.signIn(walletSigner(ctx)));
  return client;
}

/**
 * Shared room open (tickets and plain tokens): prove holdings, open the token-gated room for
 * `bsv21:<id>`, post the founding note. Returns the room ticker.
 */
export async function openRoom(
  ctx: OneSatContext,
  tokenId: string,
  opts: { name: string; min?: string; purpose?: string; founding: string },
  client?: BchatClient,
): Promise<string> {
  const c = client ?? (await chatClient(ctx));
  const key = `bsv21:${tokenId}`;
  await proveHoldings(ctx, c, key).catch(() => 0);
  const roomTicker = await c.startTokenRoom(key, {
    name: opts.name,
    ...(opts.min ? { min: opts.min } : {}),
    ...(opts.purpose ? { purpose: opts.purpose } : {}),
  });
  await c.send(roomTicker, opts.founding).catch(() => null);
  return roomTicker;
}

/** Open the ticket's holders' room, post the founding note, register it. Returns the room ticker. */
export async function openTicketRoom(ctx: OneSatContext, ticket: Ticket, client?: BchatClient): Promise<string> {
  const c = client ?? (await chatClient(ctx));
  const roomTicker = await openRoom(
    ctx,
    ticket.tokenId,
    { name: ticket.name, min: ticket.min ?? TICKET_MIN, purpose: TICKET_PURPOSE, founding: foundingMessage(ticket) },
    c,
  );
  const done = { ...ticket, roomTicker };
  saveLocalTicket(done);
  await registerTicket(done, c);
  return roomTicker;
}

/** Registry POST; a missing endpoint (not deployed yet) is not an error for the wallet. */
export async function registerTicket(ticket: Ticket, client: BchatClient): Promise<boolean> {
  return client
    .registerTicket(ticketRegistration(ticket))
    .then(() => true)
    .catch(() => false);
}

/** Market: retry rooms for this device's tickets whose room could not be opened at mint. */
export async function finishTicketRooms(ctx: OneSatContext): Promise<number> {
  const todo = localTickets().filter((t) => !t.roomTicker);
  if (!todo.length) return 0;
  const client = await chatClient(ctx).catch(() => null);
  if (!client) return 0;
  let n = 0;
  for (const t of todo) if (await openTicketRoom(ctx, t, client).catch(() => null)) n++;
  return n;
}

/** The public registry list (empty when the endpoint is not deployed or unreachable). */
export async function registryTickets(): Promise<Ticket[]> {
  const client = new BchatClient(defaultHttp(isNative), loadSession());
  return client
    .tickets()
    .then(parseTicketList)
    .catch(() => []);
}
