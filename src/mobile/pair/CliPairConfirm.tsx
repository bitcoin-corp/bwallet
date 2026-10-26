import { formatPairCode } from '../../pair/protocol';
import { APP_NAME, MARKET_ENABLED } from '../storeBuild';
import { useState } from 'react';
import { Terminal } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { isPairableAgent } from '../agents/agentAccounts';
import { makeGrant, type AgentGrant, type AgentScope } from './agentPairing';
import { describeMintLimits, makeMintLimits, MAX_MINT_ITEMS, MAX_MINT_USD } from './mintScope';

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
const PANEL = '#17191E';

const originHost = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * Confirm a bWalletX CLI / MCP pairing: it's bound to the agent account open right now, with the scopes
 * and lifetime chosen here. Keys stay on the phone; the computer sends requests, the phone checks and signs.
 */
export const CliPairConfirm = ({
  code,
  origin,
  onCancel,
  onConnect,
}: {
  code: string;
  /** The origin that asked to pair; shown so a website can't pass itself off as the CLI. */
  origin: string;
  onCancel: () => void;
  onConnect: (g: AgentGrant) => void;
}) => {
  const { chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const id = account?.addresses.identityAddress;
  const agent = isPairableAgent(id); // never a pot: pots keep no daily cap
  const [trade, setTrade] = useState(MARKET_ENABLED);
  const [send, setSend] = useState(false);
  const [days, setDays] = useState(7);
  // Minting works on any account (e.g. the owner's main one), within the limits set here.
  const [mint, setMint] = useState(!agent);
  const [maxItems, setMaxItems] = useState(50);
  const [maxUsd, setMaxUsd] = useState(3);
  const limits = makeMintLimits(maxItems, maxUsd);
  const scopes: AgentScope[] = [
    ...(agent && trade ? ['trade' as AgentScope] : []),
    ...(agent && send ? ['send' as AgentScope] : []),
    ...(mint ? ['mint' as AgentScope] : []),
  ];
  const canPair = agent || mint;
  const numberField = (
    label: string,
    value: number,
    set: (n: number) => void,
    max: number,
    step: number,
    prefix = '',
  ) => (
    <label className="flex flex-1 flex-col text-left text-xs" style={{ color: MUTED }}>
      {label}
      <span className="mt-1 flex items-center rounded-lg px-2" style={{ background: '#0f1115' }}>
        {prefix && <span className="text-sm text-white">{prefix}</span>}
        <input
          type="number"
          inputMode="decimal"
          min={step}
          max={max}
          step={step}
          value={value}
          onChange={(e) => set(Number(e.target.value))}
          className="w-full bg-transparent py-2 text-sm text-white outline-none border-0"
        />
      </span>
    </label>
  );

  const toggle = (on: boolean, set: (v: boolean) => void, label: string, hint: string) => (
    <button
      type="button"
      onClick={() => set(!on)}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left border-0"
      style={{ background: PANEL }}
    >
      <span
        className="grid h-5 w-5 place-items-center rounded text-xs font-bold"
        style={{ background: on ? GOLD : '#2b2f36', color: '#000' }}
      >
        {on ? '✓' : ''}
      </span>
      <span className="flex-1">
        <span className="block text-sm font-semibold text-white">{label}</span>
        <span className="block text-xs" style={{ color: MUTED }}>
          {hint}
        </span>
      </span>
    </button>
  );

  return (
    <div className="mt-6 flex flex-col items-center text-center">
      <span
        className="grid h-14 w-14 place-items-center rounded-2xl"
        style={{ background: 'rgb(var(--bw-accent-rgb) / 0.12)' }}
      >
        <Terminal size={28} color={GOLD} />
      </span>
      <p className="mt-4 text-xl font-bold text-white">Pair the bWalletX CLI</p>
      <p className="mt-1 break-all font-mono text-sm text-white">{originHost(origin)}</p>
      <p className="mt-1 text-sm" style={{ color: MUTED }}>
        A program on a computer (CLI or an AI agent through MCP)
      </p>
      <p className="mt-3 text-sm font-semibold" style={{ color: '#FDA29B' }}>
        Only pair if you just ran <span className="font-mono">bwalletx login</span> on your own computer. Any program
        can call itself the CLI; a website or a stranger asking you to scan this is a scam.
      </p>
      <p className="mt-5 text-sm" style={{ color: MUTED }}>
        Check the terminal shows the same code:
      </p>
      <p
        className={`mt-2 whitespace-nowrap font-mono font-bold ${code.length > 4 ? 'text-3xl tracking-[0.15em]' : 'text-4xl tracking-[0.3em]'}`}
        style={{ color: GOLD }}
        data-testid="pair-code"
      >
        {formatPairCode(code)}
      </p>
      <p className="mt-6 text-sm text-white">
        For <b>{account?.name || 'this account'}</b> only.{' '}
        {agent
          ? 'Its balance is the budget; your other accounts are never touched.'
          : 'This is not an agent account, so the CLI may only mint, within the budget below.'}
      </p>
      <div className="mt-4 flex w-full flex-col gap-2">
        {toggle(true, () => {}, 'See balances, prices and activity', 'Always on')}
        {agent &&
          MARKET_ENABLED &&
          toggle(
            trade,
            setTrade,
            'Buy tokens and load strategies',
            'Within the account’s limits and its strategy’s rules',
          )}
        {agent && toggle(send, setSend, 'Send BSV', "To anyone, up to the account's daily cap")}
        {toggle(mint, setMint, 'Mint NFTs', 'Photos, music, video, PDFs: signed here, within the limits below')}
        {mint && (
          <div className="rounded-xl px-3 py-3" style={{ background: PANEL }}>
            <div className="flex gap-2">
              {numberField('Most items', maxItems, setMaxItems, MAX_MINT_ITEMS, 1)}
              {numberField('Most to spend (USD)', maxUsd, setMaxUsd, MAX_MINT_USD, 0.5, '$')}
            </div>
            <p className="mt-3 mb-0 text-sm font-semibold" style={{ color: GOLD }}>
              {describeMintLimits(limits)}
            </p>
            <p className="mt-1 mb-0 text-xs" style={{ color: MUTED }}>
              Network fees plus the 1% {APP_NAME} mint fee count toward it. Each mint is checked against what’s left
              before it is signed.
            </p>
          </div>
        )}
      </div>
      {!canPair && (
        <p className="mt-4 text-sm" style={{ color: '#FDA29B' }}>
          Trading and sending need an agent account (Settings › Agents). Turn on Mint NFTs to pair this account for
          minting only.
        </p>
      )}
      <div className="mt-4 flex w-full items-center gap-2 text-sm" style={{ color: MUTED }}>
        Lasts
        {[1, 7, 30].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDays(d)}
            className="rounded-full px-3 py-1 text-sm font-semibold border-0"
            style={{ background: days === d ? GOLD : PANEL, color: days === d ? '#000' : MUTED }}
          >
            {d === 1 ? '1 day' : `${d} days`}
          </button>
        ))}
      </div>
      <p className="mt-4 text-xs" style={{ color: MUTED }}>
        Your keys stay on this phone: the computer asks, {APP_NAME} checks and signs. Keep {APP_NAME} open on this
        account while it works. Disconnect any time in Settings › Paired websites.
      </p>
      <div className="mt-6 flex w-full gap-3">
        <button
          onClick={onCancel}
          className="flex-1 rounded-xl py-3 font-semibold text-white"
          style={{ background: PANEL }}
        >
          Cancel
        </button>
        <button
          disabled={!canPair || !id}
          onClick={() =>
            onConnect(
              makeGrant(id!, account?.name || 'Agent account', scopes, days, Date.now(), mint ? limits : undefined),
            )
          }
          className="flex-1 rounded-xl py-3 font-bold"
          style={{ background: GOLD, color: '#000', opacity: canPair ? 1 : 0.4 }}
        >
          Pair
        </button>
      </div>
    </div>
  );
};
