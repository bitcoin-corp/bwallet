import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useBackClose } from '../backStack';
import { useServiceContext } from '../../hooks/useServiceContext';
import { scanAddress } from '../../sweep/scanner';
import { relayxXpub } from '../../sweep/relayxRecover';
import { moneyNow } from '../money/money';
import { mix, pickReadable } from '../theme/colour';
import { HdSweepScreen } from '../sweep/HdSweepScreen';
import { RelayxRecoverScreen } from '../sweep/RelayxRecoverScreen';
import {
  canRecheck,
  holdingsLine,
  loadOrigins,
  inferOrigin,
  loadAccountOrigin,
  ORIGIN_NAMES,
  saveAccountOrigin,
  originTheme,
  saveOrigins,
  scanOrigins,
  shouldAutoScan,
  type OriginResult,
  type OriginScan,
} from './origins';

const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

const ago = (at: number) => {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

const Shell = ({ onBack, children }: { onBack: () => void; children: ReactNode }) => {
  useBackClose(true, onBack);
  return createPortal(
    <div className="fixed inset-0 z-[80] flex flex-col" style={{ background: 'var(--bw-bg)' }}>
      <div
        className="flex items-center gap-2 px-2 pb-2"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)', borderBottom: `1px solid ${LINE}` }}
      >
        <button onClick={onBack} aria-label="Back" className="p-2">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">Where this account came from</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 bw-dock-pad">{children}</div>
    </div>,
    document.body,
  );
};

const Card = ({ r, onBring }: { r: OriginResult; onBring: () => void }) => {
  const line = holdingsLine(r.holdings);
  const accent = originTheme(r.id)?.accent;
  const bg = accent ? mix(PANEL, accent, 0.14) : PANEL;
  const border = accent ? mix(LINE, accent, 0.5) : LINE;
  const btnText = accent ? pickReadable(['#000000', '#FFFFFF'], [accent]) : '#000';
  return (
    <div className="mb-3 rounded-2xl p-4" style={{ background: bg, border: `1px solid ${border}` }}>
      <p className="text-xs" style={{ color: MUTED }}>
        This account came from
      </p>
      <p className="text-lg font-bold text-white">{r.name}</p>
      {r.holdings.sats > 0 && <p className="mt-2 text-2xl font-bold text-white">{moneyNow(r.holdings.sats)}</p>}
      {line && (
        <p className="mt-1 text-sm" style={{ color: MUTED }}>
          {line}
        </p>
      )}
      <p className="mt-1 text-xs" style={{ color: MUTED }}>
        Still at {r.name}’s old addresses. Nothing moves until you say so.
      </p>
      <button
        onClick={onBring}
        className="mt-3 flex w-full items-center justify-center gap-1 rounded-full py-2 text-sm font-bold"
        style={{ background: accent ?? GOLD, color: btnText }}
      >
        Bring it over <ChevronRight size={16} />
      </button>
    </div>
  );
};

/**
 * Settings › This account › Where this account came from. Read-only check of older wallets' addresses for this
 * account's recovery phrase; "Bring it over" opens the existing sweep screens, which ask before moving anything.
 */
export const OriginsScreen = ({ onBack }: { onBack: () => void }) => {
  const { apiContext, chromeStorageService, keysService } = useServiceContext();
  const id = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const [scan, setScan] = useState<OriginScan | null>(() => (id ? loadOrigins(id) : null));
  const [busy, setBusy] = useState(false);
  const [noPhrase, setNoPhrase] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<{ kind: 'sweep' | 'relayx'; words: string } | null>(null);
  const [showEmpty, setShowEmpty] = useState(false);
  const started = useRef(false);
  const [mine, setMine] = useState<string | undefined>(() => (id ? loadAccountOrigin(id) : undefined));

  const words = async (): Promise<string | null> => {
    try {
      const k = await keysService.retrieveKeys();
      return k.mnemonic || null;
    } catch {
      return null;
    }
  };

  const run = async (force: boolean) => {
    if (busy || !id) return;
    if (!force && !shouldAutoScan(scan)) return;
    if (force && !canRecheck(scan)) return;
    const services = apiContext.services;
    if (!services) return setError('Wallet services are not ready yet. Try again in a moment.');
    const phrase = await words();
    if (!phrase) return setNoPhrase(true);
    setBusy(true);
    setError('');
    try {
      const r = await scanOrigins(phrase, (address) => scanAddress(services, address));
      saveOrigins(id, r);
      const guess = inferOrigin(r);
      if (guess && !loadAccountOrigin(id)) {
        saveAccountOrigin(id, guess);
        setMine(guess);
      }
      setScan(r);
    } catch {
      setError('The check failed. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on open
  }, []);

  const bring = async (r: OriginResult) => {
    const phrase = await words();
    if (!phrase) return setNoPhrase(true);
    setOpen({ kind: r.bring, words: phrase });
  };

  if (open?.kind === 'sweep') return <HdSweepScreen initialPhrase={open.words} onBack={() => setOpen(null)} />;
  if (open?.kind === 'relayx')
    return <RelayxRecoverScreen xpub={relayxXpub(open.words)} onBack={() => setOpen(null)} />;

  const found = scan?.results.filter((r) => r.status === 'found') ?? [];
  const rest = scan?.results.filter((r) => r.status !== 'found') ?? [];

  return (
    <Shell onBack={onBack}>
      {noPhrase ? (
        <p className="text-sm" style={{ color: MUTED }}>
          Can’t check: no recovery phrase on this device for this account.
        </p>
      ) : (
        <>
          <p className="mb-3 text-sm" style={{ color: MUTED }}>
            Your recovery phrase may also have been used in older wallets. Here is what is still at their addresses.
          </p>
          {found.map((r) => (
            <Card key={r.id} r={r} onBring={() => void bring(r)} />
          ))}
          {scan && !found.length && !busy && <p className="mb-3 text-sm text-white">Nothing left in older wallets.</p>}
          {rest.length > 0 && (
            <button
              onClick={() => setShowEmpty((v) => !v)}
              className="mb-2 w-full text-left text-xs"
              style={{ color: MUTED }}
            >
              Checked: {rest.map((r) => r.name).join(', ')}: nothing there {showEmpty ? '▴' : '▾'}
            </button>
          )}
          {showEmpty &&
            rest.map((r) => (
              <p key={r.id} className="mb-1 text-xs" style={{ color: MUTED }}>
                {r.name}: {r.status === 'error' ? 'couldn’t check, try again' : `nothing at ${r.addresses} addresses`}
              </p>
            ))}
          {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs" style={{ color: MUTED }}>
              {busy ? 'Checking…' : scan ? `Last checked ${ago(scan.at)}` : ''}
            </span>
            <button
              onClick={() => void run(true)}
              disabled={busy || !canRecheck(scan)}
              className="flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold disabled:opacity-40"
              style={{ border: `1px solid ${GOLD}`, color: GOLD }}
            >
              {busy && <Loader2 size={12} className="animate-spin" />} Check again
            </button>
          </div>
          <p className="mt-5 mb-2 text-xs font-semibold uppercase tracking-widest" style={{ color: MUTED }}>
            Show this account as
          </p>
          <div className="flex flex-wrap gap-2">
            {[undefined, ...Object.keys(ORIGIN_NAMES)].map((o) => (
              <button
                key={o ?? 'bwalletx'}
                onClick={() => {
                  saveAccountOrigin(id, o ?? null);
                  setMine(o);
                }}
                className="rounded-full px-3 py-1 text-xs font-semibold"
                style={{
                  border: `1px solid ${mine === o ? GOLD : LINE}`,
                  color: mine === o ? GOLD : 'white',
                }}
              >
                {o ? ORIGIN_NAMES[o] : 'bWalletX (new)'}
              </button>
            ))}
          </div>
          <p className="mt-4 text-xs" style={{ color: MUTED }}>
            Electrum uses its own kind of seed, so it isn’t checked here.
          </p>
        </>
      )}
    </Shell>
  );
};
