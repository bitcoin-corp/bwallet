/**
 * b agent wallet tools in agent accounts (SMART-WALLET-SPEC.md §4). The chat models are text-only, so the
 * agent asks for an action with a fenced block in its reply:
 *
 *   ```bwalletx
 *   {"kind":"buy","token":"<BSV-21 id>","usd":2}
 *   ```
 *
 * The app reads the block, and every request goes through checkAgentAction (account Stop / daily cap +
 * the loaded strategy's rules) before anything is signed. Only the current account, and only when it is
 * an agent account, can be acted on: its keys are the only ones unlocked. Paper mode fills on the paper
 * book; live mode buys the cheapest listing or sends BSV.
 */
import { MARKET_ENABLED } from '../storeBuild';
import { buyBsv21, type OneSatContext } from '@1sat/actions';
import { sendBsv } from '../../utils/guardedSendBsv';
import { assertOrdLockV2 } from '../market/ordlockVersion';
import { appendAgentLog, getAgentAccount } from './agentAccounts';
import { checkAgentAction, getLoadedStrategy, getPaperBook, type ActionRequest, type StrategyAction } from './strategy';
import { describeRules } from './describeRules';
import { parseRoom, roomMarket, roomMeta, type Listing } from '../market/indexer';
import { MODULE_FINISHES, purchaseContext, walletOutpoint } from '../market/walletOutpoint';
import { marketFeeOptions } from '../market/fee';

export type AgentActionBlock = { kind: StrategyAction; token: string; usd: number; to?: string; amount?: number };

const FENCE = /```bwalletx\s*\n([\s\S]*?)```/g;

/** Pull action blocks out of a reply; returns the reply text without them plus the parsed requests. */
export const parseActions = (reply: string): { text: string; actions: AgentActionBlock[]; bad: number } => {
  const actions: AgentActionBlock[] = [];
  let bad = 0;
  const text = reply
    .replace(FENCE, (_, body: string) => {
      try {
        const o = JSON.parse(body.trim()) as Record<string, unknown>;
        const kind = o.kind as StrategyAction;
        const usd = Number(o.usd ?? 0);
        if (
          !['buy', 'sell', 'send', 'list'].includes(kind) ||
          typeof o.token !== 'string' ||
          !o.token.trim() ||
          !(usd >= 0)
        )
          throw 0;
        actions.push({
          kind,
          token: o.token.trim(),
          usd,
          ...(typeof o.to === 'string' && { to: o.to.trim() }),
          ...(Number(o.amount) > 0 && { amount: Number(o.amount) }),
        });
      } catch {
        bad++;
      }
      return '';
    })
    .trim();
  return { text, actions: actions.slice(0, 3), bad };
};

/** The cheapest buyable listing of a token whose whole price fits the budget. Pure over its inputs. */
export const pickListing = (listings: Listing[], maxUsd: number, bsvUsd: number): Listing | null =>
  listings
    .filter((l) => l.buyable && (l.priceSats / 1e8) * bsvUsd <= maxUsd + 1e-9)
    .sort((a, b) => a.priceSats - b.priceSats)[0] ?? null;

/** Extra system-prompt text for an agent account: its strategy and how to ask for actions. Empty otherwise. */
export const agentAccountPrompt = (id: string | undefined, name: string) => {
  if (!id || !getAgentAccount(id)) return '';
  const l = getLoadedStrategy(id);
  const strategy = l
    ? `Loaded strategy: "${l.strategy.name}" v${l.strategy.version}, ${l.mode === 'paper' ? 'PAPER mode (pretend money, nothing is signed)' : 'LIVE (real money)'}.
Goals: ${l.strategy.goals}
Rules the wallet enforces (you cannot change them): ${describeRules(l.strategy.rules).join('; ')}.${
        l.mode === 'paper' ? ` Paper cash: $${getPaperBook(id).cashUsd.toFixed(2)}.` : ''
      }`
    : 'No strategy is loaded, so the user is driving: only act when they ask you to in this chat.';
  return `

AGENT ACCOUNT MODE (this overrides "you cannot do anything" above)
The current account "${name}" is an agent account: its balance is a budget the user gave you. ${strategy}
To act, put one fenced block per action at the end of your reply, exactly:
\`\`\`bwalletx
{"kind":"buy","token":"<BSV-21 token id, txid_vout>","usd":<most dollars to spend>}
\`\`\`
Kinds: "buy" (cheapest listing within usd), "send" (BSV worth usd to "to": an address or paymail). Selling and listing from chat are not available yet.
The wallet checks every action before signing and may refuse it; the result is shown to the user and logged. Never claim an action happened: say what you asked for. At most 3 actions per reply.`;
};

export type ActionResult = { ok: boolean; text: string; txid?: string };

/** Quote, gate and run one action on the current (agent) account. */
export const runAgentAction = async (
  ctx: OneSatContext,
  id: string,
  a: AgentActionBlock,
  bsvUsd: number,
): Promise<ActionResult> => {
  if (!getAgentAccount(id)) return { ok: false, text: 'This isn’t an agent account, so b can’t act on it.' };
  if (!(bsvUsd > 0)) return { ok: false, text: 'No BSV price right now; try again shortly.' };
  if (a.kind === 'sell' || a.kind === 'list') return { ok: false, text: 'Selling from chat isn’t available yet.' };
  // Buying tokens is exchange functionality: bWalletX only (MARKET_ENABLED, App Review 3.1.5(iii)).
  if (!MARKET_ENABLED && a.kind !== 'send') return { ok: false, text: 'This edition can only send BSV.' };

  if (a.kind === 'send') {
    if (!a.to) return { ok: false, text: 'Send needs a recipient.' };
    const req: ActionRequest = { kind: 'send', token: a.token, usd: a.usd, to: a.to };
    const g = checkAgentAction(id, req);
    if (!g.ok) return { ok: false, text: `Refused: ${g.reason}` };
    if (g.paper) return { ok: true, text: `Paper send of $${a.usd.toFixed(2)} to ${a.to}` };
    const sats = Math.round((a.usd / bsvUsd) * 1e8);
    const to = a.to.includes('@') ? { paymail: a.to } : { address: a.to };
    const res = await sendBsv.execute(ctx, { requests: [{ ...to, satoshis: sats }] });
    if (!res.txid || res.error) return { ok: false, text: `Send failed: ${String(res.error ?? 'unknown error')}` };
    appendAgentLog(id, {
      at: Date.now(),
      action: 'send',
      detail: `Sent $${a.usd.toFixed(2)} to ${a.to}`,
      usd: a.usd,
      txid: res.txid,
      rule: getLoadedStrategy(id)?.strategy.name,
    });
    return { ok: true, text: `Sent $${a.usd.toFixed(2)} to ${a.to}`, txid: res.txid };
  }

  // buy
  const ref = parseRoom('bsv21', a.token);
  if (!ref) return { ok: false, text: `${a.token} isn’t a BSV-21 token id.` };
  const [market, meta] = await Promise.all([roomMarket(ref, 40), roomMeta('bsv21', a.token).catch(() => null)]);
  const ticker = meta?.title?.replace(/^\$/, '');
  const pick = pickListing(market.listings, a.usd, bsvUsd);
  if (!pick) return { ok: false, text: `No listing of that token fits $${a.usd.toFixed(2)}.` };
  const usd = (pick.priceSats / 1e8) * bsvUsd;
  const priceUsd = market.floorSats !== null ? (market.floorSats / 1e8) * bsvUsd : undefined;
  const amount = priceUsd ? usd / priceUsd : undefined;
  const g = checkAgentAction(id, { kind: 'buy', token: a.token, ticker, usd, priceUsd, amount });
  if (!g.ok) return { ok: false, text: `Refused: ${g.reason}` };
  if (g.paper) return { ok: true, text: `Paper buy: ${pick.label} for $${usd.toFixed(2)}` };
  const outpoint = walletOutpoint(pick.outpoint);
  try {
    await assertOrdLockV2(outpoint);
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : 'Listing check failed' };
  }
  const res = await buyBsv21.execute(purchaseContext(ctx, outpoint), {
    tokenId: a.token,
    outpoint,
    amount: pick.amount ?? '0',
    ...marketFeeOptions(),
    ...MODULE_FINISHES,
  });
  if (!res.txid || res.error) return { ok: false, text: `Buy failed: ${String(res.error ?? 'unknown error')}` };
  appendAgentLog(id, {
    at: Date.now(),
    action: 'buy',
    detail: `Bought ${pick.label}`,
    usd,
    txid: res.txid,
    rule: getLoadedStrategy(id)?.strategy.name,
  });
  return { ok: true, text: `Bought ${pick.label} for $${usd.toFixed(2)}`, txid: res.txid };
};
