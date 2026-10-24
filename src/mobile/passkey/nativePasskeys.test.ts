import { describe, expect, test } from 'bun:test';
import { NATIVE_RP_ID, nativeCreateWithPrf, nativeGetPrf, type PasskeysPlugin } from './nativePasskeys';
import { rpIdFor } from './prf';
import { b64url, fromB64url, prfSalt } from './seedBackup';

/** A fake authenticator: PRF = salt XOR a per-credential byte, so the same passkey + salt always gives the same key. */
const mockPlugin = (opts: { prfAtCreate?: boolean; prfEnabled?: boolean; noPrf?: boolean; reject?: unknown } = {}) => {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const prfFor = (cred: string, salt: string) => b64url(fromB64url(salt).map((x) => x ^ fromB64url(cred)[0]!));
  const plugin: PasskeysPlugin = {
    isAvailable: async () => ({ available: true, prf: true }),
    create: async (a) => {
      calls.push({ method: 'create', args: a });
      if (opts.reject) throw opts.reject;
      const credentialId = b64url(new Uint8Array([7, 1, 2]));
      return opts.prfAtCreate
        ? { credentialId, prf: prfFor(credentialId, a.prfSalt), prfEnabled: true }
        : { credentialId, prfEnabled: opts.prfEnabled };
    },
    get: async (a) => {
      calls.push({ method: 'get', args: a });
      if (opts.reject) throw opts.reject;
      const credentialId = a.allowCredentials[0] ?? b64url(new Uint8Array([5]));
      return opts.noPrf ? { credentialId } : { credentialId, prf: prfFor(credentialId, a.prfSalt) };
    },
  };
  return { plugin, calls };
};

describe('native passkey bridge', () => {
  test('apps always claim the web.bwalletx.com rpId, web keeps its host rule', () => {
    expect(NATIVE_RP_ID).toBe('web.bwalletx.com');
    expect(rpIdFor('localhost', true)).toBe('web.bwalletx.com');
    expect(rpIdFor('localhost', false)).toBe('localhost');
    expect(rpIdFor('web.bwalletx.com', false)).toBe('web.bwalletx.com');
  });

  test('create returning PRF uses it directly with the shared web salt', async () => {
    const salt = await prfSalt();
    const { plugin, calls } = mockPlugin({ prfAtCreate: true });
    const r = await nativeCreateWithPrf(plugin, salt, NATIVE_RP_ID, 'bWalletX · test');
    expect(calls.map((c) => c.method)).toEqual(['create']);
    expect(calls[0]!.args.rpId).toBe('web.bwalletx.com');
    expect(calls[0]!.args.prfSalt).toBe(b64url(salt));
    expect(fromB64url(calls[0]!.args.userId as string).length).toBe(16);
    expect(r.prf.length).toBe(32);
  });

  test('create without PRF output follows with one get for that credential (same key as a later get)', async () => {
    const salt = await prfSalt();
    const { plugin, calls } = mockPlugin({ prfEnabled: true });
    const made = await nativeCreateWithPrf(plugin, salt, NATIVE_RP_ID, 'x');
    expect(calls.map((c) => c.method)).toEqual(['create', 'get']);
    expect(calls[1]!.args.allowCredentials).toEqual([made.credentialId]);
    const again = await nativeGetPrf(plugin, salt, NATIVE_RP_ID, made.credentialId);
    expect(b64url(again.prf)).toBe(b64url(made.prf));
  });

  test('prfEnabled false = clear no-PRF message, no second prompt', async () => {
    const { plugin, calls } = mockPlugin({ prfEnabled: false });
    await expect(nativeCreateWithPrf(plugin, await prfSalt(), NATIVE_RP_ID, 'x')).rejects.toThrow(/no PRF/);
    expect(calls.length).toBe(1);
  });

  test('get without credential id offers any passkey; missing PRF is reported', async () => {
    const { plugin, calls } = mockPlugin({ noPrf: true });
    await expect(nativeGetPrf(plugin, await prfSalt(), NATIVE_RP_ID)).rejects.toThrow(/no PRF/);
    expect(calls[0]!.args.allowCredentials).toEqual([]);
  });

  test('plugin error codes map to the web wording', async () => {
    const salt = await prfSalt();
    await expect(
      nativeGetPrf(mockPlugin({ reject: { code: 'CANCELLED', message: 'x' } }).plugin, salt, NATIVE_RP_ID),
    ).rejects.toThrow('No passkey was chosen.');
    await expect(
      nativeCreateWithPrf(mockPlugin({ reject: { code: 'NO_PRF', message: 'x' } }).plugin, salt, NATIVE_RP_ID, 'x'),
    ).rejects.toThrow(/Keep your 12 words/);
    await expect(
      nativeGetPrf(
        mockPlugin({ reject: { code: 'UNSUPPORTED', message: 'iOS 18 needed' } }).plugin,
        salt,
        NATIVE_RP_ID,
      ),
    ).rejects.toThrow(/iOS 18 needed/);
  });
});
