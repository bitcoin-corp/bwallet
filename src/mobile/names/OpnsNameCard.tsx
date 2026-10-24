/** A name NFT drawn as a name card (opnsName.ts): the name as React text in large type, a small "name" label. */
import { useEffect, useState } from 'react';
import { OPNS_FETCH_MAX, opnsNameFrom } from './opnsName';

const GOLD = 'var(--bw-accent)';

/** The name from the content URL (read as text, size-capped), else the fallback if that is a valid name. */
// eslint-disable-next-line react-refresh/only-export-components
export const useOpnsName = (url: string | null | undefined, fallback?: string) => {
  const fb = opnsNameFrom(fallback);
  const [name, setName] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!url) {
      setName(null);
      return;
    }
    const ac = new AbortController();
    fetch(url, { signal: ac.signal })
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => !ac.signal.aborted && setName(t.length > OPNS_FETCH_MAX ? null : opnsNameFrom(t)))
      .catch(() => !ac.signal.aborted && setName(null));
    return () => ac.abort();
  }, [url]);
  return { name: name ?? fb, loading: name === undefined && !fb };
};

export const OpnsNameCard = ({
  url,
  fallback,
  from,
  compact = false,
}: {
  url: string | null | undefined;
  fallback?: string;
  /** "from $alice" under the name, when known. */
  from?: string;
  compact?: boolean;
}) => {
  const { name, loading } = useOpnsName(url, fallback);
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-1 overflow-hidden text-center"
      style={{ padding: compact ? 4 : 24 }}
    >
      <span className="uppercase tracking-widest" style={{ color: '#98A2B3', fontSize: compact ? 8 : 11 }}>
        name
      </span>
      <span
        className="max-w-full break-all font-bold leading-tight"
        style={{ color: name ? GOLD : '#98A2B3', fontSize: compact ? 13 : 40 }}
      >
        {name ?? (loading ? '…' : 'Not a valid name')}
      </span>
      {from && !compact && (
        <span className="text-xs" style={{ color: '#98A2B3' }}>
          from {from}
        </span>
      )}
    </div>
  );
};
