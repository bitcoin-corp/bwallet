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

/**
 * Image output, as Twetch's own app attaches a photo (decoded from tx 64225c39…77bc, 13 Oct 2026):
 *   output 0 = the signed text post above, output 1 = OP_FALSE OP_RETURN B <bytes> <mime> (no encoding, no name).
 * Twetch lists it as files ["b://<txid>@1"] and shows it under the text. The AIP signature covers output 0 only.
 */
export function twetchImageScript(bytes, mime) {
  const s = opReturn();
  push(s, B_PREFIX); s.writeBin(Array.from(bytes)); push(s, mime);
  return s;
}

const MAX_IMAGE = 120_000; // bytes on chain; at 100 sat/kB about 12k sats

/**
 * The page's og:image as bytes ready to attach, or null. Re-encoded to a 1200px JPEG with ffmpeg when it is
 * larger than MAX_IMAGE or not jpeg/png/webp/gif. Never throws: a post without an image is better than no post.
 */
export async function ogImage(url) {
  try {
    const html = await (await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'follow' })).text();
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (!m) return null;
    const imgUrl = new URL(m[1].replace(/&amp;/g, '&'), url).href;
    const r = await fetch(imgUrl, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return null;
    let bytes = Buffer.from(await r.arrayBuffer());
    let mime = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (bytes.length > MAX_IMAGE || !/^image\/(jpeg|png|webp|gif)$/.test(mime)) {
      const { execFileSync } = await import('node:child_process');
      for (const q of [4, 7, 11, 16]) {
        const out = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-vf', 'scale=min(1200\\,iw):-2', '-frames:v', '1', '-q:v', String(q), '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { input: bytes, maxBuffer: 20e6 });
        if (out.length <= MAX_IMAGE) { bytes = out; mime = 'image/jpeg'; break; }
      }
      if (bytes.length > MAX_IMAGE) return null;
    }
    return { bytes, mime, src: imgUrl };
  } catch { return null; }
}

export const TWETCH_USER_ID = 220501;
const TWETCH_API = 'https://api.twetch.com';

/** Signed call to Twetch's API as @bWalletX (same headers as registerTwetch). */
export async function twetchApi(key, method, path, bodyObj) {
  const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const ts = Date.now();
  const r = await fetch(TWETCH_API + path, {
    method,
    headers: {
      ...(body && { 'content-type': 'application/json' }), accept: 'application/json', origin: 'https://twetch.com',
      'x-twetch-user': String(TWETCH_USER_ID), 'x-twetch-ts': String(ts),
      'x-twetch-sig': apiSign(key, `${method}\n${path}\n${TWETCH_USER_ID}\n${ts}\n${body}`),
    },
    ...(body && { body }), signal: AbortSignal.timeout(30_000),
  });
  const out = await r.text();
  if (!r.ok) throw new Error(`Twetch ${method} ${path} -> ${r.status} ${out.slice(0, 300)}`);
  try { return JSON.parse(out); } catch { return { raw: out }; }
}

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
// o.image = { bytes, mime } (from ogImage) attaches it as output 1, as Twetch's app does.
export async function publishTwetch(_k, key, text, o = {}) {
  const scripts = [twetchPostScript(text, key)];
  if (o.image) scripts.push(twetchImageScript(o.image.bytes, o.image.mime));
  const r = await publishScripts({ sign: key, address: key.toAddress(), ledger: key.toAddress() }, scripts, { ...o, ingest: false });
  if (r.dry) return r;
  try { r.twetch = await registerTwetch(key, text, r.rawTx, r.fee); }
  catch (e) { r.twetchError = e.message; } // on chain already: report, don't retry (a retry would double-post)
  return r;
}
