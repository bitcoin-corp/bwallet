/** A name NFT drawn as a name card (opnsName.ts): a gold "Name" badge and the full name as React text in large type. */
import { useEffect, useState } from 'react';
import { OPNS_FETCH_MAX, opnsNameFrom } from './opnsName';
import { nameBavatarUri, shortFrom } from './nameCard';

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
  // Gold bAvatar art drawn from the name behind it (gold by default, never a grey placeholder).
  const art = name && !compact ? nameBavatarUri(name) : '';
  return (
    <div
      className="relative flex h-full w-full flex-col items-center justify-center gap-2 overflow-hidden text-center"
      style={{
        padding: compact ? 6 : 24,
        containerType: compact ? 'inline-size' : undefined,
        background: 'radial-gradient(circle at 30% 20%, #3a2c05 0%, #17191E 70%)',
      }}
    >
      {art && (
        <img
          src={art}
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-35"
        />
      )}
      <span
        className="relative rounded-full font-bold uppercase tracking-widest"
        style={{
          background: GOLD,
          color: '#010101',
          fontSize: compact ? 9 : 12,
          padding: compact ? '1px 8px' : '3px 12px',
        }}
      >
        Name
      </span>
      <span
        className="relative max-w-full break-all font-extrabold leading-tight"
        style={{
          color: name ? GOLD : '#98A2B3',
          fontSize: compact ? nameSize(name) : 48,
          textShadow: '0 2px 12px rgba(0,0,0,0.8)',
        }}
      >
        {name ?? (loading ? '…' : 'Not a valid name')}
      </span>
      {from && !compact && (
        <span className="relative text-sm font-semibold text-white">A gift from {shortFrom(from)}</span>
      )}
    </div>
  );
};

/** Grid tiles: the name as large as the tile allows (container width), a long one still shown in full. */
const nameSize = (name: string | null) => `max(9px, min(34px, calc(150cqw / ${Math.max(name?.length ?? 1, 3)})))`;
