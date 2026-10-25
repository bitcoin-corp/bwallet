/** Most "Show as" chips the account drawer shows; the rest live in Your names (/m/you), never in the menu. */
export const DRAWER_NAME_CHIPS = 3;

/**
 * The account drawer must stay short so Sign out is always visible, even for an account holding thousands of OpNS
 * names (owner, 25 Oct 2026). Returns the few names shown as chips (the current one first) and the total for the
 * "Your names (N)" link.
 */
export const drawerNames = (
  names: readonly string[],
  shown: string,
  max = DRAWER_NAME_CHIPS,
): { chips: string[]; total: number; more: boolean } => {
  const total = names.length;
  if (total < 2) return { chips: [], total, more: false };
  const current = names.find((n) => n === shown);
  const chips = (current ? [current, ...names.filter((n) => n !== current)] : [...names]).slice(0, max);
  return { chips, total, more: total > chips.length };
};
