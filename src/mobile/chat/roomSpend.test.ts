import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk';
import {
  commitmentFor,
  commitmentScript,
  costLine,
  mustPay,
  needsConfirm,
  parseSpendCharge,
  paymentOutputs,
  payForMessage,
  releasePayment,
  sha256Hex,
  spendFloorError,
  type MessageCharge,
  type SpendCharge,
} from './roomSpend';
import { parseLookup, parseSpend, spendEnforced, spendLabel } from './tokenRooms';

const TOKEN = `${'ab'.repeat(32)}_0`;
const ISSUER = PrivateKey.fromRandom().toAddress();
const burn: MessageCharge = { unit: 'token', tokenId: TOKEN, amount: '5', to: 'burn' };
const toIssuer: MessageCharge = { unit: 'token', tokenId: TOKEN, amount: '5', to: ISSUER };
const sats: MessageCharge = { unit: 'sats', amount: '100', to: ISSUER };
const charge = (charges: MessageCharge[], exempt = false): SpendCharge => ({
  rule: 'R1',
  charges,
  unenforced: null,
  exempt,
});

/** Decode a BSV-21 inscription JSON from an output script, if any. */
const bsv21Of = (hex: string): { op?: string; id?: string; amt?: string } | null => {
  const c = Script.fromHex(hex).chunks;
  for (let i = 0; i + 2 < c.length; i++) {
    if (c[i + 2].data && Utils.toUTF8(c[i + 2].data!) === 'ord') {
      for (let j = i + 3; j + 1 < c.length; j += 2) {
        if (c[j].op === 0 && c[j + 1].data) return JSON.parse(Utils.toUTF8(c[j + 1].data!));
      }
    }
  }
  return null;
};

describe('room spend: commitment', () => {
  test('bytes match bit-sign (room-spend.ts commitmentScript)', () => {
    // Reference produced by bit-sign's commitmentScript for the same input (8 Oct 2026).
    expect(sha256Hex('gm')).toBe('a474219e5e9503c84d59500bb1bda3d9ade81e52d9fa1c234278770892a6dd74');
    expect(
      commitmentScript({
        room: 'CHAT',
        author: 'alice',
        body: sha256Hex('gm'),
        rule: '2026-10-08T10:00:00.000Z',
      }).toHex(),
    ).toBe(
      '006a223150755161374b36324d694b43747373534c4b79316b683536575755374d745552350353455403617070056243686174047479706508726f6f6d5f70617904726f6f6d044348415406617574686f7205616c69636504626f647940613437343231396535653935303363383464353935303062623162646133643961646538316535326439666131633233343237383737303839326136646437340472756c6518323032362d31302d30385431303a30303a30302e3030305a',
    );
  });
  test('commitmentFor normalises ticker, handle and trims the text', () => {
    expect(commitmentFor('$CHAT', '$Alice', '  gm  ', 'R1')).toEqual({
      room: 'CHAT',
      author: 'alice',
      body: sha256Hex('gm'),
      rule: 'R1',
    });
  });
});

describe('room spend: the tx builder includes the payment', () => {
  const c = commitmentFor('CHAT', 'alice', 'gm', 'R1');
  test('burn: a BSV-21 burn output for the amount, then the commitment', () => {
    const outs = paymentOutputs([burn], c);
    expect(outs.length).toBe(2);
    expect(bsv21Of(outs[0].lockingScript)).toEqual({ p: 'bsv-20', op: 'burn', id: TOKEN, amt: '5' } as never);
    expect(outs[1].lockingScript).toBe(commitmentScript(c).toHex());
    expect(outs[1].satoshis).toBe(0);
  });
  test('to issuer: a BSV-21 transfer locked to the issuer address', () => {
    const outs = paymentOutputs([toIssuer], c);
    expect(bsv21Of(outs[0].lockingScript)?.op).toBe('transfer');
    expect(outs[0].lockingScript.endsWith(new P2PKH().lock(ISSUER).toHex())).toBe(true);
  });
  test('sats: a P2PKH output to the issuer for the price', () => {
    const outs = paymentOutputs([sats], c);
    expect(outs[0]).toMatchObject({ lockingScript: new P2PKH().lock(ISSUER).toHex(), satoshis: 100 });
  });
  test('message and payment end up in one transaction', () => {
    const tx = new Transaction();
    for (const o of paymentOutputs([burn, sats], c))
      tx.addOutput({ lockingScript: Script.fromHex(o.lockingScript), satoshis: o.satoshis });
    const parsed = Transaction.fromHex(tx.toHex());
    expect(parsed.outputs.length).toBe(3);
    expect(parsed.outputs.some((o) => bsv21Of(o.lockingScript.toHex())?.op === 'burn')).toBe(true);
    expect(
      parsed.outputs.some((o) => o.lockingScript.toHex() === new P2PKH().lock(ISSUER).toHex() && o.satoshis === 100),
    ).toBe(true);
  });
});

describe('room spend: confirm and caps', () => {
  test('always asks by default', () =>
    expect(needsConfirm(charge([burn]), { autoUnderRaw: '', sessionCapRaw: '' }, BigInt(0))).toBe(true));
  test("don't ask under N", () =>
    expect(needsConfirm(charge([burn]), { autoUnderRaw: '5', sessionCapRaw: '' }, BigInt(0))).toBe(false));
  test('above N asks', () =>
    expect(needsConfirm(charge([burn]), { autoUnderRaw: '4', sessionCapRaw: '' }, BigInt(0))).toBe(true));
  test('session cap reached asks', () =>
    expect(needsConfirm(charge([burn]), { autoUnderRaw: '5', sessionCapRaw: '12' }, BigInt(10))).toBe(true));
  test('mixed units always ask', () =>
    expect(needsConfirm(charge([burn, sats]), { autoUnderRaw: '1000', sessionCapRaw: '' }, BigInt(0))).toBe(true));
  test('issuer is exempt', () => expect(mustPay(charge([burn], true))).toBe(false));
  test('cost line', () => expect(costLine(charge([burn]), 'X', 0)).toBe('This message costs 5 $X, burned'));
});

describe('room spend: parsing the server', () => {
  test('spend_charge parsed; malformed refused', () => {
    expect(
      parseSpendCharge({ rule: 'R1', charges: [burn, sats], unenforced: null, exempt: false })?.charges.length,
    ).toBe(2);
    expect(
      parseSpendCharge({ rule: 'R1', charges: [{ unit: 'token', amount: '0', to: 'burn', tokenId: TOKEN }] }),
    ).toBeNull();
  });
  test('lookup carries spendCharge; older server → null', () => {
    expect(
      parseLookup({ key: `bsv21:${TOKEN}`, spend_charge: { rule: '', charges: [burn] } })?.spendCharge?.charges[0],
    ).toEqual(burn);
    expect(parseLookup({ key: `bsv21:${TOKEN}` })?.spendCharge).toBeNull();
  });
  test('sats rule and version kept; enforcement only per message', () => {
    const s = parseSpend({ amountRaw: '100', per: 'message', to: 'issuer', unit: 'sats', since: 'R1' });
    expect(s).toEqual({ amountRaw: '100', per: 'message', to: 'issuer', unit: 'sats', since: 'R1' });
    expect(spendLabel(s, 'X', 0)).toBe('Spend 100 sats per message, to the issuer');
    expect(spendEnforced(s)).toBe(true);
    expect(spendEnforced({ amountRaw: '1', per: 'hour', to: 'burn' })).toBe(false);
  });
});

describe('room spend: the wallet never broadcasts', () => {
  test('sats payment is signed with noSend and returned for bit-sign to broadcast', async () => {
    const calls: Array<{ options?: { noSend?: boolean } }> = [];
    const ctx = {
      wallet: {
        createAction: async (a: { options?: { noSend?: boolean } }) => {
          calls.push(a);
          return { txid: 'ab'.repeat(32), tx: [1, 2, 3] };
        },
      },
    } as never;
    const r = await payForMessage(ctx, {
      ticker: 'CHAT',
      handle: 'alice',
      text: 'gm',
      charge: charge([sats]),
      issuerAddress: ISSUER,
    });
    expect(calls.length).toBe(1);
    expect(calls[0].options?.noSend).toBe(true);
    expect(r).toEqual({ beef: '010203', txid: 'ab'.repeat(32) });
  });
  test('a server refusal (4xx) the chain confirms releases the signed tx (abortAction)', async () => {
    const aborted: string[] = [];
    const ctx = {
      wallet: { abortAction: async (a: { reference: string }) => void aborted.push(a.reference) },
    } as never;
    const fast = { lookups: [async () => 'missing' as const], delaysMs: [0, 1], sleep: async () => {}, log: () => {} };
    await releasePayment(ctx, 'cd'.repeat(32), { status: 402 }, fast);
    expect(aborted).toEqual(['cd'.repeat(32)]);
  });
  test('a 5xx / network error never aborts: the server may have broadcast', async () => {
    const aborted: string[] = [];
    const ctx = {
      wallet: { abortAction: async (a: { reference: string }) => void aborted.push(a.reference) },
    } as never;
    const fast = {
      lookups: [async () => 'missing' as const],
      sleep: async () => {},
      log: () => {},
      background: false,
      settleDelaysMs: [],
    };
    await releasePayment(ctx, 'cd'.repeat(32), { status: 502 }, fast);
    await releasePayment(ctx, 'cd'.repeat(32), new TypeError('Failed to fetch'), fast);
    expect(aborted).toEqual([]);
  });
  test('floors: 50 sats minimum, token rules any positive unit', () => {
    expect(spendFloorError('sats', '49')).not.toBeNull();
    expect(spendFloorError('sats', '50')).toBeNull();
    expect(spendFloorError('token', '1')).toBeNull();
  });
});
