import { appVersionLabel } from '../utils/versionLabel';

/** Small muted release number under the b (owner, 24 Oct 2026): "5.2.40", or "5.2.40 · hotfix 131a723". */
export const VersionLabel = ({ color, className = '' }: { color?: string; className?: string }) => (
  <p
    data-testid="version-label"
    className={`text-[0.65rem] tracking-wide select-none tabular-nums ${className}`}
    style={{ color, opacity: 0.55 }}
  >
    {appVersionLabel()}
  </p>
);
