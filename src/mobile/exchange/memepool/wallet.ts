/**
 * The in-app BRC-100 wallet, as the Memepool flow needs it (trade.ts TradeWallet). THIS FILE MOVES MONEY.
 *
 * Keys: every trade gets fresh keys of this wallet, never an address Memepool picks.
 *  - ord (tokens): ONESAT protocol, keyID `<tokenId>-<time>` (the 1Sat wallets' own pattern, as launchpad/client.ts),
 *    so bought or left-over tokens are filed into the bsv21 basket with the note the wallet counts them by.
 *  - pay (BSV): a BRC-29 payment key to ourselves (random derivation prefix/suffix), so change and sell proceeds are
 *    taken in as an ordinary wallet payment and show in the balance.
 * Signing goes through createSignature (sign.ts); nothing here sees a private key.
 */
import { P2PKH, PublicKey, Random, Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk';
import { noteFor, tokenCoins, tokenOutputTags } from '../../market/launchpad/tokens';
import { signOurInputs } from './sign';
import { bsv21TransferScript, addressPkh, parseBsv21Transfer, parseP2pkh } from './script';
import type { Funding, OfferedCoin, OrdKey, PayKey, TradeWallet } from './trade';
import type { Template } from './validate';

const ONESAT: WalletProtocol = [0, 'onesat'];
const BRC29: WalletProtocol = [2, '3241645161d8'];

type BeefSource = { getBeefForTxid(txid: string): Promise<{ toBinaryAtomic(txid: string): number[] }> };

export function memepoolWallet(
  wallet: WalletInterface,
  services: BeefSource | undefined,
  icon?: string | null,
): TradeWallet {
  const identity = async () => (await wallet.getPublicKey({ identityKey: true })).publicKey;
  const addressOf = async (protocolID: WalletProtocol, keyID: string) =>
    PublicKey.fromString(
      (await wallet.getPublicKey({ protocolID, keyID, counterparty: 'self', forSelf: true })).publicKey,
    ).toAddress();
  const payment = async (pay: PayKey, outputIndex: number) => ({
    outputIndex,
    protocol: 'wallet payment' as const,
    paymentRemittance: {
      derivationPrefix: pay.derivationPrefix,
      derivationSuffix: pay.derivationSuffix,
      senderIdentityKey: await identity(),
    },
  });

  return {
    async newOrdKey(tokenId) {
      const keyID = `${tokenId}-${Date.now()}`;
      return { address: await addressOf(ONESAT, keyID), key: { protocolID: ONESAT, keyID } };
    },
    async newPayKey() {
      const derivationPrefix = Utils.toBase64(Random(10));
      const derivationSuffix = Utils.toBase64(Random(10));
      const keyID = `${derivationPrefix} ${derivationSuffix}`;
      return {
        address: await addressOf(BRC29, keyID),
        key: { protocolID: BRC29, keyID },
        derivationPrefix,
        derivationSuffix,
      };
    },
    async fund(pay, sats) {
      const script = new P2PKH().lock(pay.address).toHex();
      const r = await wallet.createAction({
        description: 'Set aside BSV for a Memepool buy',
        outputs: [
          { lockingScript: script, satoshis: sats, outputDescription: 'BSV for your Memepool buy (still yours)' },
        ],
        labels: ['memepool'],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
      });
      if (!r.txid || !r.tx) throw new Error('The wallet could not set the BSV aside.');
      const coin: OfferedCoin = { txid: r.txid, vout: 0, satoshis: sats, script, key: pay.key };
      return { coin, beef: Array.from(r.tx), pay };
    },
    async returnFunding(f: Funding) {
      await wallet.internalizeAction({
        tx: f.beef,
        outputs: [await payment(f.pay, f.coin.vout)],
        description: 'Memepool buy not made: BSV back in your wallet',
        labels: ['memepool'],
      });
    },
    async tokenCoins(tokenId) {
      const { coins } = await tokenCoins(wallet, false);
      const out: OfferedCoin[] = [];
      for (const c of coins) {
        if (c.id !== tokenId || !c.keyID || !c.noted || !c.lockingScript) continue;
        const tok = parseBsv21Transfer(c.lockingScript);
        if (!tok || tok.id !== tokenId || tok.amt !== c.amt) continue; // only canonical coins we can account for
        const [txid, vout] = c.outpoint.split(/[._]/);
        out.push({
          txid,
          vout: Number(vout),
          satoshis: 1,
          script: c.lockingScript,
          amt: c.amt,
          key: { protocolID: (c.protocolID ?? ONESAT) as WalletProtocol, keyID: c.keyID },
        });
      }
      return out.sort((a, b) => ((b.amt ?? BigInt(0)) > (a.amt ?? BigInt(0)) ? 1 : -1));
    },
    sign: (t, indexes, keyFor) => signOurInputs(wallet, t, indexes, keyFor),
    async receive(txid: string, t: Template, p: { ord: OrdKey; pay: PayKey; sym: string; tokenId: string }) {
      if (!services) return; // the wallet's own address sync picks it up later
      const beef = (await services.getBeefForTxid(txid)).toBinaryAtomic(txid);
      const ordPkh = addressPkh(p.ord.address);
      const payPkh = addressPkh(p.pay.address);
      const outputs: Parameters<WalletInterface['internalizeAction']>[0]['outputs'] = [];
      for (const [i, o] of t.outputs.entries()) {
        const tok = parseBsv21Transfer(o.script);
        if (tok && tok.pkh === ordPkh && o.script === bsv21TransferScript(tok.pkh, p.tokenId, tok.amt))
          outputs.push({
            outputIndex: i,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket: 'bsv21',
              customInstructions: noteFor(p.tokenId, tok.amt, p.sym, 0, p.ord.key.keyID, icon),
              tags: tokenOutputTags(p.tokenId),
            },
          });
        else if (!tok && parseP2pkh(o.script) === payPkh) outputs.push(await payment(p.pay, i));
      }
      if (outputs.length)
        await wallet.internalizeAction({
          tx: beef,
          outputs,
          description: `Memepool trade $${p.sym}`,
          labels: ['memepool'],
        });
    },
  };
}
