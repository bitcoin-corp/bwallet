import { beforeEach, describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import {
  REPORT_URL,
  SUPPORT_EMAIL,
  acceptTerms,
  blockLocal,
  blockedHandles,
  isBlocked,
  mergeBlocks,
  reportBody,
  sendReport,
  termsAccepted,
  unblockLocal,
} from './ugc';
import {
  NOT_SENT_TEXT,
  SENT_TEXT,
  consentInfo,
  consentTarget,
  consents,
  grantConsent,
  hasConsent,
  revokeConsent,
} from '../agent/consent';
import { MAX_TURNS } from '../agent/agent';
import {
  ACCOUNT_DELETE_KEY_ID,
  ACCOUNT_DELETE_PROTOCOL,
  accountDeleteMessage,
  confirmMatches,
} from '../account/deleteAccount';
import { deletePaymail, signRequest } from '../names/paymail';
import type { Http } from '../chat/api';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');
const server = require('../../../site/lib/paymail.js');

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}
const g = globalThis as unknown as { localStorage: MemStorage };
beforeEach(() => {
  g.localStorage = new MemStorage();
});

describe('terms (Apple 1.2)', () => {
  test('not agreed until Agree, then remembered on this device', () => {
    expect(termsAccepted()).toBe(false);
    acceptTerms();
    expect(termsAccepted()).toBe(true);
  });
  test('the support contact is the owner’s address', () => {
    expect(SUPPORT_EMAIL).toBe('support@bwalletx.com');
  });
});

describe('blocks', () => {
  test('block / unblock by handle, normalised; server list merges in', () => {
    blockLocal('$Eve');
    expect(isBlocked('eve')).toBe(true);
    expect(isBlocked('$EVE')).toBe(true);
    mergeBlocks(['mallory', 'eve']);
    expect(blockedHandles().sort()).toEqual(['eve', 'mallory']);
    unblockLocal('eve');
    expect(isBlocked('eve')).toBe(false);
    expect(isBlocked(null)).toBe(false);
  });
});

describe('reports reach the server', () => {
  test('POSTs the bit-sign shape to /api/bitsign/report', async () => {
    const seen: Parameters<Http>[0][] = [];
    const http: Http = async (req) => (seen.push(req), { status: 200, data: { id: 'x' } });
    await sendReport(http, { kind: 'ai_response', target: 'b-agent:paid', reason: 'hate', content: 'reply' });
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe(REPORT_URL);
    expect(REPORT_URL).toBe('https://www.bchatx.com/api/bitsign/report');
    expect(seen[0].body).toMatchObject({ kind: 'ai_response', reason: 'hate', content: 'reply', source: 'bwallet' });
  });
  test('a refused report is an error the user sees, not silence', async () => {
    const http: Http = async () => ({ status: 429, data: { error: 'Too many reports.' } });
    await expect(sendReport(http, { kind: 'user', target: '$x', reason: 'spam' })).rejects.toThrow('Too many reports.');
  });
  test('long fields are capped to what the server accepts', () => {
    const b = reportBody({ kind: 'user', target: 'x'.repeat(900), reason: 'spam', content: 'y'.repeat(9000) });
    expect(b.target.length).toBe(512);
    expect(b.content?.length).toBe(8000);
  });
});

describe('AI consent (Apple 5.1.2(i))', () => {
  test('per provider, revocable', () => {
    expect(hasConsent('openai')).toBe(false);
    grantConsent('openai');
    expect(hasConsent('openai')).toBe(true);
    expect(hasConsent('anthropic')).toBe(false);
    expect(consents().map((c) => c.target)).toEqual(['openai']);
    revokeConsent('openai');
    expect(hasConsent('openai')).toBe(false);
  });
  test('paid mode is its own target and names Anthropic via bit-sign', () => {
    expect(consentTarget('paid', 'openai')).toBe('paid');
    expect(consentTarget('own', 'openrouter')).toBe('openrouter');
    expect(consentInfo('paid').provider).toBe('Anthropic');
    expect(consentInfo('paid').route).toContain('bchatx.com');
    expect(consentInfo('openai').provider).toBe('OpenAI');
  });
  test('the sheet states the real turn limit and what is not sent', () => {
    expect(SENT_TEXT).toContain(`last ${MAX_TURNS} messages`);
    expect(NOT_SENT_TEXT).toContain('recovery phrase');
  });
});

describe('account deletion', () => {
  test('the signed message matches bit-sign (src/lib/store-safety.ts)', () => {
    expect(accountDeleteMessage('alice', '02ab', '2026-10-02T00:00:00Z')).toBe(
      'bit-sign delete account\nhandle:alice\nidentity_key:02ab\ntimestamp:2026-10-02T00:00:00Z',
    );
    expect(ACCOUNT_DELETE_PROTOCOL).toEqual([2, 'bitsign account delete']);
    expect(ACCOUNT_DELETE_KEY_ID).toBe('1');
  });
  test('confirm by typing the $handle or DELETE', () => {
    expect(confirmMatches('DELETE', null)).toBe(true);
    expect(confirmMatches('delete', null)).toBe(false);
    expect(confirmMatches('$Alice', 'alice')).toBe(true);
    expect(confirmMatches('alice', 'alice')).toBe(true);
    expect(confirmMatches('bob', 'alice')).toBe(false);
    expect(confirmMatches('', 'alice')).toBe(false);
    expect(confirmMatches('$', null)).toBe(false);
  });
  test('the paymail delete request is signed so the paymail server accepts it', async () => {
    // deletePaymail = POST api('delete') with this body (paymail is off in tests: no build-time domain).
    const wallet = new ProtoWallet(PrivateKey.fromRandom());
    const body = await signRequest(wallet, 'delete', { confirm: 'DELETE' });
    expect(await server.verifySigned(body, 'delete')).toBeNull();
    expect(await server.verifySigned({ ...body, fields: { confirm: 'DELETE', x: '1' } }, 'delete')).toBe(
      'Bad signature',
    );
    expect(typeof deletePaymail).toBe('function');
  });
  test('a bit-sign deletion signature verifies against the identity key', async () => {
    const wallet = new ProtoWallet(PrivateKey.fromRandom());
    const { publicKey } = await wallet.getPublicKey({ identityKey: true });
    const msg = accountDeleteMessage('alice', publicKey, '2026-10-02T00:00:00Z');
    const { signature } = await wallet.createSignature({
      data: Utils.toArray(msg, 'utf8'),
      protocolID: ACCOUNT_DELETE_PROTOCOL,
      keyID: ACCOUNT_DELETE_KEY_ID,
      counterparty: 'anyone',
    });
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(msg, 'utf8'),
      signature,
      protocolID: ACCOUNT_DELETE_PROTOCOL,
      keyID: ACCOUNT_DELETE_KEY_ID,
      counterparty: publicKey,
    });
    expect(valid).toBe(true);
  });
});
