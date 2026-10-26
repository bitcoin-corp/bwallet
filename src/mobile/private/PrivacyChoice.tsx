import { Globe, Lock } from 'lucide-react';

const GOLD = 'var(--bw-accent-hi)';
const BORDER = '#3a2f0c';

/**
 * Private / public switch for a mint sheet (owner, 25 Oct 2026). Private is the default: the item is encrypted with
 * the wallet's own keys before it goes on chain. "Make public now" is a per-mint choice.
 */
export const PrivacyChoice = ({
  isPublic,
  onChange,
  available = true,
}: {
  isPublic: boolean;
  onChange: (makePublic: boolean) => void;
  /** False when this file type can only be minted publicly. */
  available?: boolean;
}) => {
  if (!available)
    return (
      <p className="text-xs m-0" style={{ color: '#FFB020' }}>
        This type of file can only be minted publicly for now. Anyone will be able to see it.
      </p>
    );
  const opt = (pub: boolean, Icon: typeof Lock, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={isPublic === pub}
      onClick={() => onChange(pub)}
      className="flex flex-1 items-center justify-center gap-1 rounded-lg py-2 text-xs font-bold border-0 cursor-pointer"
      style={isPublic === pub ? { background: GOLD, color: '#1a1400' } : { background: 'transparent', color: '#ccc' }}
    >
      <Icon size={14} aria-hidden="true" />
      {label}
    </button>
  );
  return (
    <div className="flex flex-col gap-1">
      <div
        className="flex gap-1 rounded-xl p-1 border"
        style={{ borderColor: BORDER }}
        role="radiogroup"
        aria-label="Who can see it"
      >
        {opt(false, Lock, 'Private (only you can see it)')}
        {opt(true, Globe, 'Make public now')}
      </div>
    </div>
  );
};
