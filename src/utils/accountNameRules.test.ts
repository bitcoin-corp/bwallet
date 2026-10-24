import { describe, expect, it, test } from 'bun:test';
import {
  accountNameError,
  cleanAccountName,
  needsAccountName,
  RESTORE_NAME_HINT,
  RESTORE_NAME_LABEL,
  suggestAccountName,
} from './accountNameRules';

describe('account name is required', () => {
  it('suggests the next free Account N', () => {
    expect(suggestAccountName([])).toBe('Account 1');
    expect(suggestAccountName(['Account 1'])).toBe('Account 2');
    expect(suggestAccountName(['Savings', 'account 3'])).toBe('Account 4');
  });
  it('blocks an empty name', () => {
    expect(accountNameError('', [])).toBe('Give this account a name.');
    expect(accountNameError('   ', ['x'])).toBe('Give this account a name.');
  });
  it('blocks a duplicate in the same wallet, ignoring case and spacing', () => {
    expect(accountNameError('savings', ['Savings'])).toContain('already have an account called');
    expect(accountNameError('  My   Wallet ', ['my wallet'])).toContain('already have');
  });
  it('blocks an over-long name', () => {
    expect(accountNameError('x'.repeat(41), [])).toContain('40 characters');
  });
  it('accepts a fresh name', () => {
    expect(accountNameError('Spending', ['Savings'])).toBe('');
    expect(cleanAccountName('  a   b ')).toBe('a b');
  });
  it('flags old unnamed accounts for a gentle prompt only', () => {
    expect(needsAccountName('')).toBe(true);
    expect(needsAccountName(undefined)).toBe(true);
    expect(needsAccountName('Account 3')).toBe(true);
    expect(needsAccountName('Savings')).toBe(false);
  });
});

describe('restore name label', () => {
  test('says the name is local to this device', () => {
    expect(RESTORE_NAME_LABEL).toBe('Name on this device only');
    expect(RESTORE_NAME_HINT).toMatch(/comes back by itself/);
  });
});
