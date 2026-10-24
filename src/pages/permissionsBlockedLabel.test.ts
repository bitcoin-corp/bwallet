import { describe, expect, it } from 'bun:test';
import { formatPermissionDetail, permissionBadge } from './PermissionsManager';
import { BLOCK_SITE_BASKET } from '../services/reservedBaskets';

// Found clicking through the sheets in a real Chrome (24 Oct 2026): a blocked site was listed as
// "Data Access · Can access: bwalletx.block-site", which reads like a grant.
describe('Settings › Permissions shows a blocked site as blocked', () => {
  const blocked = { type: 'basket', basketName: BLOCK_SITE_BASKET } as Parameters<typeof formatPermissionDetail>[0];
  it('badge says Blocked, not Data Access', () => {
    expect(permissionBadge(blocked).label).toBe('Blocked');
    expect(permissionBadge({ type: 'basket', basketName: 'ordinals' }).label).toBe('Data Access');
  });
  it('the line explains how to unblock rather than "Can access: bwalletx.block-site"', () => {
    const line = formatPermissionDetail(blocked);
    expect(line).not.toContain('Can access');
    expect(line).toContain('Revoke All Access');
  });
});
