import { useSyncExternalStore } from 'react';
import { Globe, Terminal } from 'lucide-react';
import { forget, pairedSites, subscribePairs, type StoredSession } from './sessions';
import { usd2 } from './mintScope';

const MUTED = '#98A2B3';

let cache: StoredSession[] = [];
let cacheKey = '';
const snapshot = () => {
  const next = pairedSites();
  const k = JSON.stringify(next.map((s) => [s.c, s.lastUsed, s.agent?.mint?.items, s.agent?.mint?.spentUsd]));
  if (k !== cacheKey) {
    cacheKey = k;
    cache = next;
  }
  return cache;
};

/** Settings › Paired websites: every site connected by QR, with Disconnect. */
export function PairedSitesList({ onScan }: { onScan: () => void }) {
  const sites = useSyncExternalStore(subscribePairs, snapshot);
  return (
    <div>
      {sites.length === 0 && (
        <p className="text-sm" style={{ color: MUTED }}>
          Nothing paired. Use Scan to connect on a site that shows a bWallet QR code, or to pair the bWalletX CLI
          (bwalletx login).
        </p>
      )}
      {sites.map((s) => (
        <div key={s.c} className="mb-2 rounded-xl p-3" style={{ background: 'var(--bw-surface)' }}>
          <div className="flex items-center gap-3">
            {s.agent ? <Terminal size={18} color="#BDB4FE" /> : <Globe size={18} color={MUTED} />}
            <div className="min-w-0 flex-1">
              <div className="overflow-hidden text-ellipsis whitespace-nowrap font-semibold text-white">
                {s.agent
                  ? `bWalletX CLI · ${s.agent.name}`
                  : s.proven
                    ? new URL(s.origin).host
                    : `claims to be ${new URL(s.origin).host}`}
              </div>
              <div className="text-xs" style={{ color: MUTED }}>
                {s.agent
                  ? `${s.agent.scopes.join(', ')} · until ${new Date(s.agent.expiresAt).toLocaleDateString()}`
                  : `Last used ${new Date(s.lastUsed).toLocaleString()}`}
              </div>
            </div>
            <button
              onClick={() => forget(s.c)}
              className="rounded-lg px-3 py-1.5 text-sm font-semibold"
              style={{ background: 'rgba(240,68,56,0.12)', color: '#FDA29B' }}
            >
              Disconnect
            </button>
          </div>
          {s.agent?.mint && (
            <div className="mt-2 text-xs" style={{ color: MUTED }}>
              <div>
                Minted {s.agent.mint.items} of {s.agent.mint.maxItems} · spent {usd2(s.agent.mint.spentUsd)} of{' '}
                {usd2(s.agent.mint.maxUsd)}
              </div>
              {s.agent.mint.recent.slice(0, 10).map((m) => (
                <a
                  key={m.txid}
                  href={`https://whatsonchain.com/tx/${m.txid}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 flex justify-between gap-2 no-underline"
                  style={{ color: MUTED }}
                >
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-white">{m.name}</span>
                  <span>{usd2(m.usd)}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
      <button
        onClick={onScan}
        className="mt-4 w-full rounded-xl py-3 font-bold"
        style={{ background: 'var(--bw-accent)', color: '#000' }}
      >
        Scan to connect
      </button>
    </div>
  );
}
