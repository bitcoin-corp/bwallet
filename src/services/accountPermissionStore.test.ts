/**
 * App grants are per account (b-Aware report, 23-24 Oct 2026): an allowance or site approval made on one account
 * must not be shown, honoured or spent on another. Local only: fake-indexeddb, a stub wallet.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { LocalWalletPermissionsManager, normalizeOriginator } from '@1sat/wallet';
import { IndexedDbPermissionStore } from '@1sat/wallet-browser';
import {
  LEGACY_PERMISSION_SCOPE,
  migrateLegacyGrants,
  openAccountPermissionStore,
  permissionScopeFor,
  revokeOriginatorInAccounts,
} from './accountPermissionStore';

const SITE = 'acctgrants.example';
const signIn = { data: [1], protocolID: [2, 'bwallet sign in'], keyID: 'n', counterparty: 'anyone' };
let n = 0;
const ids = () => {
  n++;
  return { A: `1AccountA${n}`, B: `1AccountB${n}` };
};

const protocolGrant = (originator = SITE) =>
  ({
    key: {
      type: 'protocol',
      originator: normalizeOriginator(originator),
      privileged: false,
      protocolLevel: 2,
      protocolName: 'bwallet sign in',
      counterparty: 'anyone',
    },
    expiry: 0,
    grantedAt: Date.now(),
    reason: 'Sign in',
  }) as never;
const allowance = () =>
  ({
    key: { type: 'spending', originator: normalizeOriginator(SITE) },
    expiry: 0,
    grantedAt: Date.now(),
    authorizedAmount: 5_000_000,
    reason: 'Up to $5 a month without asking',
  }) as never;

const manager = (s: IndexedDbPermissionStore) => {
  let prompts = 0;
  const w = {
    createSignature: async () => ({ signature: [1] }),
    getPublicKey: async () => ({ publicKey: '02' + '11'.repeat(32) }),
    listOutputs: async () => ({ outputs: [], totalOutputs: 0 }),
    listActions: async () => ({ actions: [], totalActions: 0 }),
  };
  const mgr = new LocalWalletPermissionsManager(w as never, 'wallet-admin-id', {}, { store: s } as never);
  mgr.bindCallback('onProtocolPermissionRequested', (async () => {
    prompts++;
  }) as never);
  return { mgr, prompts: () => prompts };
};
const signOutcome = async (s: IndexedDbPermissionStore) => {
  const m = manager(s);
  const p = m.mgr.createSignature(signIn as never, SITE);
  p.catch(() => undefined);
  const outcome = await Promise.race([
    p.then(() => 'allowed'),
    new Promise((r) => setTimeout(() => r('pending'), 300)),
  ]);
  return { outcome, prompts: m.prompts() };
};

const legacy = () => new IndexedDbPermissionStore({ scope: LEGACY_PERMISSION_SCOPE });

describe('per-account permission store', () => {
  test('scope names the account', () => {
    expect(permissionScopeFor('1Abc')).toBe('yours-wallet:1Abc');
    expect(() => permissionScopeFor('')).toThrow();
  });

  test('an allowance set on A is not visible on B', async () => {
    const { A, B } = ids();
    const a = await openAccountPermissionStore(A, 2);
    const b = await openAccountPermissionStore(B, 2);
    await a.putGrant(allowance());
    expect((await a.listGrants({ originator: normalizeOriginator(SITE), type: 'spending' })).length).toBe(1);
    expect((await b.listGrants({ originator: normalizeOriginator(SITE), type: 'spending' })).length).toBe(0);
    expect(await b.findGrant({ type: 'spending', originator: normalizeOriginator(SITE) } as never)).toBeNull();
  });

  test('a site approved on A is asked again on B; A keeps its approval after switching back', async () => {
    const { A, B } = ids();
    const a = await openAccountPermissionStore(A, 2);
    await a.putGrant(protocolGrant());
    expect((await signOutcome(a)).outcome).toBe('allowed');

    const b = await openAccountPermissionStore(B, 2);
    const onB = await signOutcome(b);
    expect(onB.outcome).toBe('pending');
    expect(onB.prompts).toBe(1);

    const backToA = await openAccountPermissionStore(A, 2);
    expect((await signOutcome(backToA)).outcome).toBe('allowed');
  });

  test('legacy shared grants move to the only account, then the legacy store is gone', async () => {
    const { A } = ids();
    const old = legacy();
    await old.putGrant(protocolGrant());
    await old.putGrant(allowance());
    await old.close();
    const a = await openAccountPermissionStore(A, 1);
    expect((await a.listGrants()).length).toBe(2);
    const again = await migrateLegacyGrants(a, 1);
    expect(again.count).toBe(0);
  });

  test('legacy shared grants are dropped when the device has several accounts', async () => {
    const { A, B } = ids();
    const old = legacy();
    await old.putGrant(protocolGrant());
    await old.close();
    const a = await openAccountPermissionStore(A, 2);
    expect((await a.listGrants()).length).toBe(0);
    const b = await openAccountPermissionStore(B, 2);
    expect((await b.listGrants()).length).toBe(0);
    const check = legacy();
    expect((await check.listGrants()).length).toBe(0);
    await check.close();
  });

  test('a paired-site revoke reaches every account', async () => {
    const { A, B } = ids();
    const a = await openAccountPermissionStore(A, 2);
    const b = await openAccountPermissionStore(B, 2);
    await a.putGrant(protocolGrant());
    await b.putGrant(allowance());
    expect(await revokeOriginatorInAccounts([A, B], normalizeOriginator(SITE))).toBe(2);
    expect((await a.listGrants()).length).toBe(0);
    expect((await b.listGrants()).length).toBe(0);
  });
});
