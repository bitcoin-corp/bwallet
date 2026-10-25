import { useIssuer } from './useIssuer';
import { BadgeCheck, ShieldQuestion, TriangleAlert } from 'lucide-react';
import { issuerLabel } from './issuerVerify';

const GOLD = '#d4af37';
const GREY = '#8a8a8a';

/** "Issued by $handle ✓" (gold) or "Unverified issuer" (grey). `compact` for list rows. */
export function IssuerBadge({ tokenId, compact = false }: { tokenId: string | null | undefined; compact?: boolean }) {
  const info = useIssuer(tokenId);
  if (!tokenId) return null;
  const { text, verified } = issuerLabel(info);
  const Icon = verified ? BadgeCheck : ShieldQuestion;
  return (
    <span
      data-testid="issuer-badge"
      title={
        info?.official
          ? 'First-party token: this exact token id is built into bWalletX'
          : verified && info?.identityKey
            ? `Signed in the mint tx by identity key ${info.identityKey}`
            : (info?.reason ?? text)
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: compact ? 11 : 12,
        color: verified ? GOLD : GREY,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: '100%',
      }}
    >
      <Icon size={compact ? 11 : 13} aria-hidden />
      {text}
    </span>
  );
}

/** Amber note when a ticker is shared by several token ids. */
export function SharedTickerNote({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div
      role="note"
      style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#e0a030', margin: '6px 0' }}
    >
      <TriangleAlert size={13} aria-hidden />
      {text}
    </div>
  );
}
