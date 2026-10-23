import { describe, expect, test } from 'bun:test';
import {
  USER_DENIED_CODE,
  USER_DENIED_MESSAGE,
  isUserDenied,
  replyError,
  userDeniedError,
  withDenialCode,
} from './userDenied';
import { toXdmResponse } from '../mobile/bappFrame/frameBridge';

describe('user declined: one standard error', () => {
  test('the error keeps the toolbox message and carries the code', () => {
    const e = userDeniedError();
    expect(e.message).toBe('Permission denied.');
    expect(e.code).toBe('ERR_PERMISSION_DENIED');
    expect(e.status).toBe(403);
    expect(e.isError).toBe(true);
  });

  test('every refusal text the toolbox and the wallet use is a denial', () => {
    for (const m of [
      'Permission denied.',
      'Permission denied by user',
      'Grouped permission denied by user',
      'Counterparty permission denied by user',
      'The user has denied the request for permission.',
    ])
      expect(isUserDenied(m)).toBe(true);
    expect(isUserDenied({ code: USER_DENIED_CODE, message: 'whatever' })).toBe(true);
  });

  test('failures are not denials', () => {
    for (const m of ['Insufficient funds', 'Wallet is locked', 'Request expired', 'Origin mismatch', ''])
      expect(isUserDenied(m)).toBe(false);
    expect(isUserDenied(undefined)).toBe(false);
    expect(isUserDenied(new Error('Permission denied for basket "x" (reserved)'))).toBe(false);
  });

  test('a denied reply gets code and status; others pass through untouched', () => {
    expect(withDenialCode({ type: 'createAction', success: false, error: 'Permission denied.' })).toEqual({
      type: 'createAction',
      success: false,
      error: USER_DENIED_MESSAGE,
      code: USER_DENIED_CODE,
      status: 403,
    });
    const fail = { type: 'createAction', success: false, error: 'Insufficient funds' };
    expect(withDenialCode(fail)).toBe(fail);
    const ok = { type: 'createAction', success: true, data: 1 };
    expect(withDenialCode(ok)).toBe(ok);
  });

  test('the page-side transport rejects with the coded error', () => {
    const e = replyError({ error: 'Permission denied.', code: USER_DENIED_CODE }) as Error & { code?: string };
    expect(e.code).toBe(USER_DENIED_CODE);
    expect(e.message).toBe(USER_DENIED_MESSAGE);
    const f = replyError({ error: 'Insufficient funds' }) as Error & { code?: string };
    expect(f.message).toBe('Insufficient funds');
    expect(f.code).toBeUndefined();
  });

  test('bApp frames (XDM) answer a denial with the code, not the generic 1', () => {
    expect(toXdmResponse('1', { success: false, error: 'Permission denied.', code: USER_DENIED_CODE })).toMatchObject({
      status: 'error',
      description: USER_DENIED_MESSAGE,
      code: USER_DENIED_CODE,
    });
    expect(toXdmResponse('2', { success: false, error: 'Insufficient funds' })).toMatchObject({ code: 1 });
  });
});
