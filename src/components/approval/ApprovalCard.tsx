import type { CSSProperties, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { CARD, CARD_FONT } from './cardTheme';

/**
 * The approval card shell (owner-approved designs, 11 Oct 2026): site row, a hero art panel that looks
 * different per kind, a short headline, one big button, small "Not now" and "Details". Shared by the
 * one-sheet permission prompt and the bAvatar mint sheet. Heroes live next to it in ApprovalHeroes.tsx.
 */

export type CardTone = 'gold' | 'red';

export const Check = ({ color = CARD.green, size = 16 }: { color?: string; size?: number }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2.4"
    strokeLinecap="round"
  >
    <path d="m5 12 5 5 9-10" />
  </svg>
);

export const Cross = ({ size = 20 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="#FF6B6B"
    strokeWidth="2.2"
    strokeLinecap="round"
  >
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

/** Rounded pill, e.g. "No password", "FREE". */
export const Chip = (props: { children: ReactNode; solid?: boolean; tone?: CardTone }) => (
  <span
    className="flex items-center gap-1.5"
    style={{
      padding: '8px 12px',
      borderRadius: 999,
      fontSize: 13,
      fontWeight: props.solid ? 800 : 400,
      background: props.solid ? CARD.gold : props.tone === 'red' ? CARD.redChip : CARD.chip,
      color: props.solid ? CARD.bg : undefined,
    }}
  >
    {props.children}
  </span>
);

/** First letters of the site for its tile ("twetch.com" → "Tw"). */
const siteInitials = (site: string) => {
  const s = site.replace(/^www\./i, '').replace(/[^a-z0-9]/gi, '');
  return s ? s[0].toUpperCase() + (s[1] ?? '').toLowerCase() : '?';
};

export const SiteTile = (props: { site: string; size?: number; tone?: CardTone; ours?: boolean }) => {
  const size = props.size ?? 32;
  const red = props.tone === 'red';
  return (
    <div
      aria-hidden="true"
      className="flex items-center justify-center flex-shrink-0"
      style={{
        width: size,
        height: size,
        borderRadius: size >= 64 ? size / 2 : 10,
        background: red ? '#3A1414' : props.ours ? CARD.gold : '#E8E2D2',
        color: red ? CARD.redSoft : CARD.bg,
        fontWeight: 800,
        fontSize: Math.round(size * (props.ours ? 0.56 : 0.42)),
      }}
    >
      {red ? '?' : props.ours ? 'b' : siteInitials(props.site)}
    </div>
  );
};

export interface CardButton {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  ariaLabel?: string;
}

export interface ApprovalCardProps {
  tone?: CardTone;
  /** Domain shown top-left (or "bWalletX" for the wallet's own sheets). */
  site: string;
  siteSub?: string;
  /** The site tile shows the gold b (the wallet's own sheets). */
  ours?: boolean;
  onClose?: () => void;
  closeLabel?: string;
  closeDisabled?: boolean;
  hero: ReactNode;
  title: ReactNode;
  /** Short, visual body: chips, tiles, a recipient row. */
  children?: ReactNode;
  primary?: CardButton;
  /** "Not now" (gold tone) or "I trust it, allow" (red tone). */
  secondary?: CardButton;
  /** A third, small choice next to secondary (the careful card's "Block this site"). */
  tertiary?: CardButton;
  /** Expanded under "Details": the per-permission lines, options and technical detail. */
  details?: ReactNode;
  detailsOpen?: boolean;
  onToggleDetails?: () => void;
  /** Error text above the buttons (USB check, mint failure). */
  error?: string;
  testId?: string;
}

const btnBase: CSSProperties = { fontFamily: CARD_FONT, border: 0, cursor: 'pointer' };

export const ApprovalCard = (p: ApprovalCardProps) => {
  const red = p.tone === 'red';
  const ink = red ? CARD.redInk : CARD.ink;
  return (
    <div
      data-testid={p.testId}
      data-approval-scroll
      className="flex flex-col w-full h-full overflow-y-auto"
      style={{
        background: red ? CARD.redBg : CARD.bg,
        color: ink,
        fontFamily: CARD_FONT,
        boxShadow: red ? `inset 0 0 0 2px ${CARD.redLine}` : undefined,
        minHeight: '100%',
      }}
    >
      <div className="flex items-center" style={{ gap: 10, padding: '14px 16px 10px 20px' }}>
        <SiteTile site={p.site} tone={p.tone} ours={p.ours} />
        <div className="flex flex-col min-w-0" style={{ lineHeight: 1.2 }}>
          <span className="truncate" style={{ fontSize: 15, fontWeight: 600 }}>
            {p.site}
          </span>
          {p.siteSub && (
            <span className="truncate" style={{ fontSize: 12, color: red ? CARD.redSoft : CARD.muted }}>
              {p.siteSub}
            </span>
          )}
        </div>
        {p.onClose && (
          <button
            type="button"
            aria-label={p.closeLabel ?? 'Close'}
            disabled={p.closeDisabled}
            onClick={p.onClose}
            className="flex items-center justify-center flex-shrink-0"
            style={{
              ...btnBase,
              marginLeft: 'auto',
              width: 44,
              height: 44,
              borderRadius: 22,
              background: red ? CARD.redChip : CARD.chip,
              color: red ? '#D9A5A5' : CARD.muted,
              fontSize: 20,
            }}
          >
            ×
          </button>
        )}
      </div>

      {p.hero}

      <div className="flex flex-col" style={{ padding: '20px 22px 0', gap: 12 }}>
        <h1 className="m-0" style={{ fontSize: red ? 34 : 36, lineHeight: 1.05, fontWeight: 800, letterSpacing: -1 }}>
          {p.title}
        </h1>
        {p.children}
      </div>

      {/* The choices stick to the bottom: on a short window (392×540) the user sees them without scrolling. */}
      <div
        className="flex flex-col"
        data-testid="approval-choices"
        style={{
          position: 'sticky',
          bottom: 0,
          zIndex: 1,
          margin: red ? 'auto 2px 0' : 'auto 0 0',
          padding: '14px 20px 16px',
          gap: 10,
          background: red ? CARD.redBg : CARD.bg,
          boxShadow: `0 -12px 24px ${red ? CARD.redBg : CARD.bg}`,
        }}
      >
        {p.error && (
          <p className="m-0 text-center" role="alert" style={{ fontSize: 13, color: CARD.redSoft }}>
            {p.error}
          </p>
        )}
        {p.primary && (
          <button
            type="button"
            aria-label={p.primary.ariaLabel}
            disabled={p.primary.disabled}
            onClick={p.primary.onClick}
            className="flex items-center justify-center gap-2 w-full"
            style={{
              ...btnBase,
              height: 64,
              borderRadius: 20,
              fontSize: 22,
              fontWeight: 800,
              background: red ? CARD.redInk : 'linear-gradient(180deg, var(--bw-accent-hi), var(--bw-accent))',
              color: red ? CARD.redBg : CARD.bg,
              boxShadow: red ? undefined : '0 12px 40px rgb(var(--bw-accent-rgb) / 0.35)',
              opacity: p.primary.disabled ? 0.6 : 1,
            }}
          >
            {p.primary.busy && <Loader2 size={20} className="animate-spin" />}
            {p.primary.label}
          </button>
        )}
        <div className="flex justify-between items-center">
          {p.secondary ? (
            <button
              type="button"
              aria-label={p.secondary.ariaLabel}
              disabled={p.secondary.disabled}
              onClick={p.secondary.onClick}
              className="flex items-center gap-2"
              style={{
                ...btnBase,
                height: 44,
                padding: red ? '0 12px' : '0 8px',
                borderRadius: 12,
                background: 'transparent',
                border: red ? `1px solid ${CARD.redLine}` : 0,
                color: red ? CARD.redSoft : CARD.muted,
                fontSize: red ? 14 : 15,
                opacity: p.secondary.disabled ? 0.6 : 1,
              }}
            >
              {p.secondary.busy && <Loader2 size={14} className="animate-spin" />}
              {p.secondary.label}
            </button>
          ) : (
            <span />
          )}
          {p.tertiary && (
            <button
              type="button"
              aria-label={p.tertiary.ariaLabel}
              disabled={p.tertiary.disabled}
              onClick={p.tertiary.onClick}
              className="flex items-center gap-2"
              style={{
                ...btnBase,
                height: 44,
                padding: '0 12px',
                borderRadius: 12,
                background: 'transparent',
                border: `1px solid ${red ? CARD.redLine : CARD.muted}`,
                color: red ? CARD.redSoft : CARD.muted,
                fontSize: 14,
                opacity: p.tertiary.disabled ? 0.6 : 1,
              }}
            >
              {p.tertiary.busy && <Loader2 size={14} className="animate-spin" />}
              {p.tertiary.label}
            </button>
          )}
          {p.details && (
            <button
              type="button"
              aria-expanded={!!p.detailsOpen}
              onClick={p.onToggleDetails}
              style={{
                ...btnBase,
                minHeight: 44,
                padding: '0 8px',
                background: 'transparent',
                color: CARD.gold,
                fontSize: 14,
                textDecoration: 'underline',
              }}
            >
              {p.detailsOpen ? 'Hide details' : 'Details'}
            </button>
          )}
        </div>
      </div>
      {p.detailsOpen && p.details && (
        <div style={{ padding: '0 20px 20px' }}>
          <div
            className="w-full"
            style={{
              borderRadius: 16,
              padding: '10px 14px',
              background: red ? CARD.redChip : CARD.chip,
              fontSize: 13,
              color: red ? CARD.redInk : CARD.soft,
            }}
          >
            {p.details}
          </div>
        </div>
      )}
    </div>
  );
};
