import { lazy, Suspense, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Bot, Check, ChevronRight, Copy, Plus, Server } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useNavigate } from 'react-router-dom';
import { useBackClose } from '../backStack';
import { routeFor } from '../tabs/tabs';
import { requestPayAfterSwitch } from '../wallet/payNav';
import {
  allAgentsStopped,
  getAgentAccount,
  getAgentLog,
  listAgentsOnly,
  onAgentsChange,
  setAgentDailyCap,
  setAgentLabels,
  setAgentStopped,
  setAllAgentsStopped,
  spentToday,
  unmarkAgentAccount,
} from './agentAccounts';
import { sweepBack } from './sweepBack';
import { StrategySection } from './StrategySection';
import { ExportForCli } from './ExportForCli';
import { IS_EXTENSION } from '../extension';
import { MARKET_ENABLED, STORE_BUILD } from '../storeBuild';
import { REMOTE_AGENTS, isRemoteAgentReady, remoteAgentBalanceSats, type RemoteAgent } from './remoteAgents';

const PairSheet = lazy(() => import('../pair/PairSheet'));

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
const LINE = '#2b2f36';
const CARD = '#17191E';
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** Ask Settings to open Create account with "Agent account" already on (CreateAccount reads it). */
export const AGENT_CREATE_FLAG = 'bwallet.createAgent';

const useAgentsTick = () => {
  const [, set] = useState(0);
  useEffect(() => onAgentsChange(() => set((n) => n + 1)), []);
};

const Header = ({ title, onBack }: { title: string; onBack: () => void }) => (
  <div className="flex items-center gap-2 px-2 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
    <button type="button" onClick={onBack} aria-label="Back" className="p-2 bg-transparent border-0">
      <ArrowLeft size={20} color="white" />
    </button>
    <span className="text-[16px] font-bold text-white">{title}</span>
  </div>
);

const Switch = ({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    onClick={() => onChange(!on)}
    className="relative h-6 w-11 rounded-full shrink-0 border-0"
    style={{ background: on ? '#F04438' : LINE }}
  >
    <span className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" style={{ left: on ? 22 : 2 }} />
  </button>
);

export const AgentBadge = ({ stopped = false, label = 'AGENT' }: { stopped?: boolean; label?: string }) => (
  <span
    className="text-[9px] font-bold rounded px-1.5 py-0.5"
    style={{
      background: stopped ? '#F0443822' : '#7A5AF822',
      color: stopped ? '#FDA29B' : '#BDB4FE',
      letterSpacing: '0.05em',
    }}
  >
    {stopped ? `${label} · STOPPED` : label}
  </span>
);

/**
 * Settings › Agents (docs/SMART-WALLET-SPEC.md §1): every agent account, Stop all agents, and a new
 * agent account. Each opens its own screen: labels, Stop, daily cap, Fund, Sweep back, activity log.
 */
export const AgentsScreen = ({ onClose }: { onClose: () => void }) => {
  useBackClose(true, onClose);
  useAgentsTick();
  const { chromeStorageService } = useServiceContext();
  const { handleSelect } = useBottomMenu();
  const navigate = useNavigate();
  const [open, setOpen] = useState<string | null>(null);
  const accounts = chromeStorageService.getAllAccounts?.() ?? [];
  const agents = listAgentsOnly();
  const stopAll = allAgentsStopped();

  const newAgent = () => {
    try {
      localStorage.setItem(AGENT_CREATE_FLAG, '1');
    } catch {
      /* storage unavailable */
    }
    onClose();
    handleSelect('settings', 'create-account');
    const route = routeFor('settings');
    if (route) navigate(route);
  };

  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col" style={{ background: 'var(--bw-bg)' }}>
      <Header title="Agents" onBack={onClose} />
      <div className="flex flex-col gap-3 px-4 pb-10 overflow-y-auto">
        <p className="text-sm m-0" style={{ color: MUTED }}>
          An agent account is a separate account, with its own keys, that your agents may use without asking you each
          time. Whatever you put in it is the agent's whole budget. Your other accounts are never touched.
        </p>
        <div className="flex items-center gap-3 rounded-2xl p-3" style={{ background: CARD }}>
          <div className="flex-1">
            <div className="text-sm font-bold text-white">Stop all agents</div>
            <div className="text-xs" style={{ color: MUTED }}>
              {stopAll ? 'Every agent account refuses agent actions.' : 'Freezes every agent account at once.'}
            </div>
          </div>
          <Switch on={stopAll} onChange={setAllAgentsStopped} label="Stop all agents" />
        </div>
        {agents.length === 0 && (
          <p className="text-sm text-center py-6 m-0" style={{ color: MUTED }}>
            No agent accounts yet.
          </p>
        )}
        {agents.map((a) => {
          const acct = accounts.find((x) => x.addresses.identityAddress === a.identityAddress);
          return (
            <button
              key={a.identityAddress}
              type="button"
              onClick={() => setOpen(a.identityAddress)}
              className="flex items-center gap-3 rounded-2xl p-3 border-0 text-left cursor-pointer"
              style={{ background: CARD }}
            >
              <Bot size={20} color="#BDB4FE" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-white">{acct?.name || 'Agent account'}</span>
                  <AgentBadge stopped={a.stopped || stopAll} />
                </div>
                <div className="text-[11px]" style={{ color: MUTED }}>
                  {a.labels.length ? a.labels.join(' · ') : short(acct?.addresses.bsvAddress ?? a.identityAddress)}
                  {a.dailyCapUsd !== null ? ` · cap $${a.dailyCapUsd}/day` : ''}
                </div>
              </div>
              <ChevronRight size={16} color={MUTED} />
            </button>
          );
        })}
        {!STORE_BUILD && REMOTE_AGENTS.map((r) => <RemoteAgentCard key={r.name} agent={r} />)}
        <button
          type="button"
          onClick={newAgent}
          className="flex items-center justify-center gap-2 rounded-2xl py-3 font-bold border-0"
          style={{ background: GOLD, color: '#000' }}
        >
          <Plus size={16} /> New agent account
        </button>
      </div>
      {open && <AgentAccountScreen id={open} onClose={() => setOpen(null)} />}
    </div>,
    document.body,
  );
};

/** Read-only card for an agent that runs on a server (its keys live there, never in this phone). */
const RemoteAgentCard = ({ agent }: { agent: RemoteAgent }) => {
  const ready = isRemoteAgentReady(agent);
  const [sats, setSats] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    remoteAgentBalanceSats(agent.receiveAddress)
      .then((s) => live && setSats(s))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [ready, agent.receiveAddress]);
  const balance = !ready
    ? 'Waiting for setup'
    : failed
      ? 'Balance unavailable'
      : sats === null
        ? 'Reading balance…'
        : `${(sats / 1e8).toFixed(8)} BSV`;
  return (
    <div className="flex items-start gap-3 rounded-2xl p-3" style={{ background: CARD }}>
      <Server size={20} color="#BDB4FE" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold text-white">{agent.name}</span>
          <AgentBadge label="RUNS ON A SERVER" />
        </div>
        <div className="text-[11px]" style={{ color: MUTED }}>
          Owner {agent.owner} · cap ${agent.dailyCapUsd.toFixed(2)}/day · approval above $
          {agent.approvalAboveUsd.toFixed(2)}
        </div>
        <div className="text-[11px]" style={{ color: ready ? 'white' : MUTED }}>
          {balance}
        </div>
      </div>
    </div>
  );
};

const AgentAccountScreen = ({ id, onClose }: { id: string; onClose: () => void }) => {
  useBackClose(true, onClose);
  useAgentsTick();
  const { chromeStorageService, apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const agent = getAgentAccount(id);
  const accounts = chromeStorageService.getAllAccounts?.() ?? [];
  const acct = accounts.find((x) => x.addresses.identityAddress === id);
  const others = accounts.filter((x) => x.addresses.identityAddress !== id);
  const current = chromeStorageService.getCurrentAccountObject().account?.addresses.identityAddress;
  const isCurrent = current === id;
  const [scanning, setScanning] = useState(false);
  const log = getAgentLog(id);
  const [labels, setLabels] = useState(agent?.labels.join(', ') ?? '');
  const [cap, setCap] = useState(agent?.dailyCapUsd?.toString() ?? '');
  const [copied, setCopied] = useState(false);
  const [sweepTo, setSweepTo] = useState(others[0]?.addresses.identityAddress ?? '');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState('');
  // Never a blank screen (owner, 6 Oct 2026: new agent account went blank on the web): if the account
  // or its agent record isn't loaded yet, say so and offer a reload.
  if (!agent || !acct)
    return createPortal(
      <div className="fixed inset-0 z-[410] flex flex-col" style={{ background: 'var(--bw-bg)' }}>
        <Header title="Agent account" onBack={onClose} />
        <div className="flex flex-col items-center gap-3 px-4 pt-10 text-center">
          <p className="text-sm m-0" style={{ color: MUTED }}>
            {agent ? 'This account isn’t loaded on this device yet.' : 'This is no longer an agent account.'}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-2xl px-5 py-2 font-bold border-0"
            style={{ background: GOLD, color: '#000' }}
          >
            Reload
          </button>
        </div>
      </div>,
      document.body,
    );
  const address = acct.addresses.bsvAddress;

  const switchTo = async (to: string) => {
    setBusy('Switching…');
    await chromeStorageService.switchAccount(to);
    window.location.reload();
  };

  const sweep = async () => {
    const dest = accounts.find((x) => x.addresses.identityAddress === sweepTo);
    if (!dest) return;
    setAsking(false);
    setBusy('Sweeping back…');
    try {
      const r = await sweepBack(apiContext, id, {
        bsvAddress: dest.addresses.bsvAddress,
        ordAddress: dest.addresses.ordAddress,
        label: dest.name || 'your account',
      });
      const moved = [
        r.tokens && `${r.tokens} token${r.tokens === 1 ? '' : 's'}`,
        r.nfts && `${r.nfts} NFTs`,
        r.bsvTxid && 'all BSV',
      ]
        .filter(Boolean)
        .join(', ');
      addSnackbar(
        r.errors.length
          ? `Moved ${moved || 'nothing'}. Problems: ${r.errors.join('; ')}`
          : `Moved ${moved || 'nothing (empty)'}.`,
        r.errors.length ? 'error' : 'success',
      );
    } finally {
      setBusy('');
    }
  };

  const section = 'rounded-2xl p-3 flex flex-col gap-2';
  const input = 'rounded-lg px-3 py-2 text-sm text-white outline-none border';
  return createPortal(
    <div className="fixed inset-0 z-[410] flex flex-col" style={{ background: 'var(--bw-bg)' }}>
      <Header title={acct.name || 'Agent account'} onBack={onClose} />
      <div className="flex flex-col gap-3 px-4 pb-10 overflow-y-auto">
        <div className="flex items-center gap-2">
          <AgentBadge stopped={agent.stopped} />
          <span className="text-xs" style={{ color: MUTED }}>
            Spent today: ${spentToday(log).toFixed(2)}
            {agent.dailyCapUsd !== null ? ` of $${agent.dailyCapUsd}` : ''}
          </span>
        </div>

        <div className={section} style={{ background: CARD }}>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="text-sm font-bold text-white">Stop this agent</div>
              <div className="text-xs" style={{ color: MUTED }}>
                Agents can't act on this account while it's stopped.
              </div>
            </div>
            <Switch on={agent.stopped} onChange={(v) => setAgentStopped(id, v)} label="Stop this agent" />
          </div>
        </div>

        {/* Trading strategies (buy/sell rules) are bWalletX only (MARKET_ENABLED, App Review 3.1.5(iii)). */}
        {MARKET_ENABLED && <StrategySection id={id} />}

        <div className={section} style={{ background: CARD }}>
          <div className="text-sm font-bold text-white">Fund</div>
          <div className="text-xs" style={{ color: MUTED }}>
            Send BSV or tokens to this account. Its balance is all the agent can spend.
          </div>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(address);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-mono border-0 text-left"
            style={{ background: 'var(--bw-bg)', color: '#D0D5DD' }}
          >
            {copied ? <Check size={13} color="#2ecc71" /> : <Copy size={13} color={MUTED} />} {address}
          </button>
          {others.map((o) => (
            <button
              key={o.addresses.identityAddress}
              type="button"
              disabled={!!busy}
              onClick={() => {
                requestPayAfterSwitch(address);
                void switchTo(o.addresses.identityAddress);
              }}
              className="rounded-lg px-3 py-2 text-xs font-bold border-0 text-left"
              style={{ background: 'rgb(var(--bw-accent-rgb)/0.13)', color: GOLD }}
            >
              Pay from {o.name || short(o.addresses.bsvAddress)} →
            </button>
          ))}
        </div>

        <div className={section} style={{ background: CARD }}>
          <div className="text-sm font-bold text-white">Sweep back</div>
          <div className="text-xs" style={{ color: MUTED }}>
            Move every token, NFT and all the BSV from this account to another one.
          </div>
          {isCurrent ? (
            <>
              <select
                value={sweepTo}
                onChange={(e) => setSweepTo(e.target.value)}
                className={input}
                style={{ background: 'var(--bw-bg)', borderColor: LINE }}
              >
                {others.map((o) => (
                  <option key={o.addresses.identityAddress} value={o.addresses.identityAddress}>
                    {o.name || short(o.addresses.bsvAddress)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!sweepTo || !!busy}
                onClick={() => (asking ? void sweep() : setAsking(true))}
                className="rounded-lg px-3 py-2 text-sm font-bold border-0"
                style={{ background: asking ? '#F04438' : GOLD, color: asking ? '#fff' : '#000' }}
              >
                {busy || (asking ? 'Tap again to sweep everything back' : 'Sweep back')}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void switchTo(id)}
              className="rounded-lg px-3 py-2 text-sm font-bold border-0"
              style={{ background: 'rgb(var(--bw-accent-rgb)/0.13)', color: GOLD }}
            >
              {busy || 'Switch to this account to sweep back'}
            </button>
          )}
        </div>

        {/* Pair the CLI or an AI assistant with THIS agent account (owner, 6 Oct 2026: no scan button here). */}
        {
          <div className={section} style={{ background: CARD }}>
            <div className="text-sm font-bold text-white">Connect the CLI or an AI assistant</div>
            <div className="text-xs" style={{ color: '#98A2B3' }}>
              {IS_EXTENSION ? (
                <>
                  Run <span className="font-mono text-white">bwalletx login</span>, then paste the link it prints (or
                  open it in Chrome). Keys stay in this extension; you choose what the CLI may do.
                </>
              ) : (
                <>
                  On your computer run <span className="font-mono text-white">bwalletx login</span>, then scan the QR
                  code it shows. Keys stay on this phone; you choose what the computer may do.
                </>
              )}
            </div>
            {isCurrent ? (
              <button
                type="button"
                onClick={() => setScanning(true)}
                className="rounded-lg px-3 py-2 text-sm font-bold border-0"
                style={{ background: GOLD, color: '#010101' }}
              >
                {IS_EXTENSION ? 'Paste pairing link' : 'Scan to connect'}
              </button>
            ) : (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void switchTo(id)}
                className="rounded-lg px-3 py-2 text-sm font-bold border-0"
                style={{ background: 'rgb(var(--bw-accent-rgb)/0.13)', color: GOLD }}
              >
                {busy || 'Switch to this account to connect'}
              </button>
            )}
          </div>
        }
        {scanning && (
          <Suspense fallback={null}>
            <PairSheet allowCli onClose={() => setScanning(false)} />
          </Suspense>
        )}

        {isCurrent && <ExportForCli id={id} name={acct.name || 'agent'} />}

        <div className={section} style={{ background: CARD }}>
          <div className="text-sm font-bold text-white">Labels</div>
          <input
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
            onBlur={() => setAgentLabels(id, labels.split(','))}
            placeholder="e.g. long-term, $B0ASEX fund"
            className={input}
            style={{ background: 'var(--bw-bg)', borderColor: LINE }}
          />
          <div className="text-sm font-bold text-white mt-1">Daily spending cap</div>
          <div className="flex items-center gap-2">
            <span className="text-sm" style={{ color: MUTED }}>
              $
            </span>
            <input
              value={cap}
              inputMode="decimal"
              onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ''))}
              onBlur={() => setAgentDailyCap(id, cap ? Number(cap) : null)}
              placeholder="no cap"
              className={`${input} w-28`}
              style={{ background: 'var(--bw-bg)', borderColor: LINE }}
            />
            <span className="text-xs" style={{ color: MUTED }}>
              per day (optional; the balance is already the limit)
            </span>
          </div>
        </div>

        <div className={section} style={{ background: CARD }}>
          <div className="text-sm font-bold text-white">Activity</div>
          {log.length === 0 && (
            <div className="text-xs" style={{ color: MUTED }}>
              Nothing yet.
            </div>
          )}
          {log.slice(0, 100).map((e, i) => (
            <div key={`${e.at}-${i}`} className="flex gap-2 text-xs">
              <span className="shrink-0 font-mono" style={{ color: '#667085' }}>
                {new Date(e.at).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <span className="flex-1" style={{ color: '#D0D5DD' }}>
                {e.detail}
                {e.usd > 0 ? ` · $${e.usd.toFixed(2)}` : ''}
                {e.rule ? ` · rule: ${e.rule}` : ''}
              </span>
              {e.txid && (
                <a
                  href={`https://whatsonchain.com/tx/${e.txid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0"
                  style={{ color: GOLD }}
                >
                  tx
                </a>
              )}
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => {
            unmarkAgentAccount(id);
            onClose();
          }}
          className="text-xs bg-transparent border-0 p-2"
          style={{ color: MUTED }}
        >
          Make this a normal account (agents lose access)
        </button>
      </div>
    </div>,
    document.body,
  );
};
