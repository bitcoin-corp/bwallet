// Twetch posting for the official bWalletX account (twetch.com user 220501, "bWalletX").
// Builds posts exactly as Twetch does (decoded from tx 0d52a065…c717, 11 Oct 2026):
//   B <text> text/markdown UTF-8 | MAP SET app twetch type post | AIP BITCOIN_ECDSA <address> <base64 sig>
// then registered with Twetch via POST api.twetch.com/v1/posts (Twetch does not index broadcast-only posts).
// The AIP signature is made with the account's Twetch key, so Twetch shows the post as @bWalletX.
// The fee is paid by the Twetch key itself, from 1HQTpV… (Twetch only shows posts paid by the account).
// Key comes from the environment only (TWETCH_SIGN_WIF), never from code.
import { BigNumber, BSM, PrivateKey, Utils } from '@bsv/sdk';
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

// Matches what Twetch indexes (12 Oct 2026): no ts field, base64 AIP signature.
export function twetchPostScript(text, key) {
  const s = opReturn();
  push(s, B_PREFIX); push(s, text.trim()); push(s, 'text/markdown'); push(s, 'UTF-8');
  s.writeBin([PIPE]); push(s, MAP_PREFIX); push(s, 'SET');
  for (const v of ['app', 'twetch', 'type', 'post']) push(s, v);
  return aipSign(s, key, true);
}

export const TWETCH_USER_ID = 220501;
const TWETCH_API = 'https://api.twetch.com';

/** Twetch's request signature: BSM base64 over "METHOD\npath\nuserId\nts\nbody" (as twetch.com's app does). */
function apiSign(key, msg) {
  const m = Utils.toArray(msg, 'utf8');
  const sig = BSM.sign(m, key, 'raw');
  return sig.toCompact(sig.CalculateRecoveryFactor(key.toPublicKey(), new BigNumber(BSM.magicHash(m))), true, 'base64');
}

/**
 * Register a signed post tx with Twetch (POST /v1/posts, the call twetch.com makes). Twetch no longer indexes
 * posts it only sees on chain: b14f47 (/ask-b, made in Twetch's app) was indexed through this call; every
 * cron post was byte-identical in shape but only broadcast, so none appeared. Safe to call for a tx that is
 * already broadcast or mined. Returns Twetch's reply ({ id, ... }).
 */
export async function registerTwetch(key, text, rawTx, paidSats) {
  const path = '/v1/posts';
  const body = JSON.stringify({ userId: TWETCH_USER_ID, content: text.trim(), txHex: rawTx, paidSats });
  for (let attempt = 0; ; attempt++) {
  const ts = Date.now();
  const r = await fetch(TWETCH_API + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json', origin: 'https://twetch.com',
      'x-twetch-user': String(TWETCH_USER_ID), 'x-twetch-ts': String(ts),
      'x-twetch-sig': apiSign(key, `POST\n${path}\n${TWETCH_USER_ID}\n${ts}\n${body}`),
    },
    body, signal: AbortSignal.timeout(30_000),
  });
  const out = await r.text();
  if (r.status >= 500 && attempt < 2) { await new Promise((ok) => setTimeout(ok, 5000 * (attempt + 1))); continue; } // Cloudflare 502s now and then
  if (!r.ok) throw new Error(`Twetch POST /v1/posts -> ${r.status} ${out.slice(0, 300)}`);
  try { return JSON.parse(out); } catch { return { raw: out }; }
  }
}

/** Post `text` to Twetch as @bWalletX: build + broadcast from the account's own address, then register with Twetch. */
// Twetch only shows posts paid from the account's own address, and only once they're submitted to its API.
export async function publishTwetch(_k, key, text, o = {}) {
  const r = await publishScripts({ sign: key, address: key.toAddress(), ledger: key.toAddress() }, [twetchPostScript(text, key)], { ...o, ingest: false });
  if (r.dry) return r;
  try { r.twetch = await registerTwetch(key, text, r.rawTx, r.fee); }
  catch (e) { r.twetchError = e.message; } // on chain already: report, don't retry (a retry would double-post)
  return r;
}
