// DM the owner as $bwalletx through bit-sign (POST /api/bitsign/bwalletx/dm, x-b-signature HMAC).
import { bSign } from './lib.mjs';

export async function sendDm(env, text, ref) {
  const base = env.BITSIGN_URL || 'https://www.bitcoinchat.online';
  const secret = env.BWALLETX_AGENT_SECRET;
  if (!secret) throw new Error('BWALLETX_AGENT_SECRET missing from the blog env file');
  const body = JSON.stringify({ to: 'boase', text, ref });
  const r = await fetch(`${base}/api/bitsign/bwalletx/dm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-b-signature': bSign(body, secret) },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`bit-sign DM refused: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
