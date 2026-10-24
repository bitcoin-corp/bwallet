import { describe, expect, test } from 'bun:test';
import { forwardCwiCall, RELOAD_PAGE_ERROR, type ForwardRuntime } from './cwiForward';

const collect = () => {
  const got: unknown[] = [];
  return { got, answer: (d: unknown) => got.push(d) };
};

describe('forwardCwiCall', () => {
  test('passes the background answer through', () => {
    const { got, answer } = collect();
    const rt: ForwardRuntime = { id: 'x', sendMessage: (_m, cb) => cb({ success: true, data: 1 }) };
    forwardCwiCall(rt, { action: 'getPublicKey' }, answer);
    expect(got).toEqual([{ success: true, data: 1 }]);
  });

  test('a closed channel (worker restarted mid-call) answers with an error', () => {
    const { got, answer } = collect();
    const rt: ForwardRuntime = {
      id: 'x',
      lastError: null,
      sendMessage: (_m, cb) => {
        rt.lastError = { message: 'The message port closed before a response was received.' };
        cb(undefined);
      },
    };
    forwardCwiCall(rt, {}, answer);
    expect(got).toEqual([{ success: false, error: 'The message port closed before a response was received.' }]);
  });

  test('extension reloaded: sendMessage throws, the page still gets an answer', () => {
    const { got, answer } = collect();
    const rt: ForwardRuntime = {
      id: 'x',
      sendMessage: () => {
        throw new Error('Extension context invalidated.');
      },
    };
    expect(() => forwardCwiCall(rt, {}, answer)).not.toThrow();
    expect(got).toEqual([{ success: false, error: RELOAD_PAGE_ERROR }]);
  });

  test('runtime gone (id undefined) answers without calling sendMessage', () => {
    const { got, answer } = collect();
    let called = false;
    forwardCwiCall({ sendMessage: () => (called = true) }, {}, answer);
    forwardCwiCall(undefined, {}, answer);
    expect(called).toBe(false);
    expect(got).toEqual([
      { success: false, error: RELOAD_PAGE_ERROR },
      { success: false, error: RELOAD_PAGE_ERROR },
    ]);
  });

  test('answers once even if the callback fires after a throw', () => {
    const { got, answer } = collect();
    const rt: ForwardRuntime = {
      id: 'x',
      sendMessage: (_m, cb) => {
        cb({ success: true });
        throw new Error('late');
      },
    };
    forwardCwiCall(rt, {}, answer);
    expect(got).toEqual([{ success: true }]);
  });
});
