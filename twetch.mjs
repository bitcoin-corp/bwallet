// Twetch posting for the official bWalletX account (twetch.com user 220501, "bWalletX").
// Builds posts exactly as Twetch does (decoded from tx 0d52a065…c717, 11 Oct 2026):
//   B <text> text/markdown UTF-8 | MAP SET app twetch type post ts <ms> | AIP BITCOIN_ECDSA <address> <sig>
// The AIP signature is made with the account's Twetch key, so Twetch shows the post as @bWalletX.
// The fee is paid from the bChat poster key (bchat.mjs send/ledger); the Twetch key holds no coins.
// Key comes from the environment only (TWETCH_SIGN_WIF), never from code.
import { PrivateKey } from '@bsv/sdk';
import { aipSign, B_PREFIX, MAP_PREFIX, opReturn, PIPE, publishScripts, push } from './bchat.mjs';

/** The bWalletX Twetch account's public key (api.twetch.com/v1/users/220501). Any other key is refused. */
export const TWETCH_PUBKEY = '02767300227bce93c441f9b2e88f5077c0052a3eaace8d96e466cff69966116e9f';
export const TWETCH_ADDRESS = '1HQTpVArDyFac7hnoMBFjDPxCqQt3boHRp';

/** The Twetch signing key from env, or null. Throws if it isn't the bWalletX account's key. */
export function twetchKey(env) {
  if (!env.TWETCH_SIGN_WIF) return null;
  const key = PrivateKey.fromWif(env.TWETCH_SIGN_WIF.trim());
  if (key.toPublicKey().toString() !== TWETCH_PUBKEY) {
    throw new Error(`TWETCH_SIGN_WIF is not the bWalletX Twetch key (expected address ${TWETCH_ADDRESS})`);
  }
  return key;
}

export function twetchPostScript(text, key, ts = Date.now()) {
  const s = opReturn();
  push(s, B_PREFIX); push(s, text.trim()); push(s, 'text/markdown'); push(s, 'UTF-8');
  s.writeBin([PIPE]); push(s, MAP_PREFIX); push(s, 'SET');
  for (const v of ['app', 'twetch', 'type', 'post', 'ts', String(ts)]) push(s, v);
  return aipSign(s, key);
}

/** Post `text` to Twetch as @bWalletX. `k` = bChat poster keys (pays the fee). Not sent to the bChat feed indexers. */
export const publishTwetch = (k, key, text, o = {}) => publishScripts(k, [twetchPostScript(text, key)], { ...o, ingest: false });
