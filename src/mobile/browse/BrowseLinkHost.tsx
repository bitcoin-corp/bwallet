import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Globe } from 'lucide-react';
import { openDappBrowser } from '../dappBrowser';
import { onBrowseLink, takeBrowseLink } from './browseLink';

/**
 * A www.bwallet.space/browse?url=… link opened the app: show the page's host, and open it in bWallet's browser only
 * when the user taps Open. Opening grants nothing; the page asks to connect like any other.
 */
export function BrowseLinkHost() {
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    const show = () => {
      const t = takeBrowseLink();
      if (t) setTarget(t);
    };
    show();
    return onBrowseLink(show);
  }, []);
  if (!target) return null;
  const host = new URL(target).host;
  return createPortal(
    <div className="fixed inset-0 z-[420] flex items-end justify-center bg-black/60" onClick={() => setTarget(null)}>
      <div
        className="w-full max-w-md rounded-t-3xl p-6 text-center"
        style={{ background: 'var(--bw-bg)', paddingBottom: 'max(env(safe-area-inset-bottom), 24px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <span
          className="mx-auto grid h-12 w-12 place-items-center rounded-2xl"
          style={{ background: 'rgb(var(--bw-accent-rgb) / 0.12)' }}
        >
          <Globe size={24} color="var(--bw-accent)" />
        </span>
        <p className="mt-4 text-sm" style={{ color: 'var(--bw-text-muted, #98A2B3)' }}>
          Open in bWallet&apos;s browser
        </p>
        <p className="mt-1 break-all text-xl font-bold" style={{ color: 'var(--bw-text)' }} data-testid="browse-host">
          {host}
        </p>
        <p className="mt-3 text-xs" style={{ color: 'var(--bw-text-muted, #98A2B3)' }}>
          The site isn&apos;t connected. It will ask you first if it wants to use your wallet.
        </p>
        <div className="mt-6 flex gap-3">
          <button
            onClick={() => setTarget(null)}
            className="flex-1 rounded-xl py-3 font-semibold"
            style={{ background: 'var(--bw-card)', color: 'var(--bw-text)' }}
          >
            Cancel
          </button>
          <button
            onClick={() => {
              const t = target;
              setTarget(null);
              openDappBrowser(t).catch((e) => console.error('[browse link]', e));
            }}
            className="flex-1 rounded-xl py-3 font-bold"
            style={{ background: 'var(--bw-accent)', color: 'var(--bw-on-accent, #000)' }}
          >
            Open
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
