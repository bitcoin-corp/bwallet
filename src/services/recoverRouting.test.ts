/**
 * Regression (owner, 15 Oct 2026, web build): STORAGE_RECOVER_TXID was handled only in the internal switch but missing
 * from the internal-actions list, so the router sent it down the dApp path, whose switch has no case for it: no
 * response ever, and Settings sat on "Starting… (87 s)". Every storage action Settings sends must be in that list.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';

test('every STORAGE_* action Settings sends is routed as internal by the background', () => {
  const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
  // The recovery handlers moved to useRecoveryTools (shared with the home DON'T PANIC button, 25 Oct 2026).
  const settings = ['../pages/Settings.tsx', '../hooks/useRecoveryTools.ts', '../components/HomeShortcuts.tsx']
    .map((p) => readFileSync(new URL(p, import.meta.url), 'utf8'))
    .join('\n');
  const sent = [...new Set([...settings.matchAll(/action: '(STORAGE_[A-Z_]+)'/g)].map((m) => m[1]))];
  expect(sent).toContain('STORAGE_RECOVER_TXID');
  for (const a of sent) {
    expect(bg.includes(`      '${a}',`), `${a} missing from the internal-actions list`).toBe(true);
    expect(bg.includes(`case '${a}':`), `${a} has no handler`).toBe(true);
  }
});
