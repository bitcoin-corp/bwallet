# Subscribe with bWalletX (API for apps)

An app opened inside bWalletX can ask the user for a monthly subscription. The user sees **one** approval sheet, picks
the pot that pays, and taps Subscribe. After that the wallet charges once a month by itself. The app never gets a key,
a balance or a pot.

- **Priced in dollars.** Each month the wallet pays `usdPerMonth` in BSV at that day's rate (the wallet's price feed).
- **Nothing locked or paid ahead.** The first month is paid right after approval. Later months are paid when they fall
  due, while the wallet is open.
- **Missed months never stack.** If the wallet wasn't opened on the due date, it pays **one** month the next time it
  opens and skips the older ones. It never charges two or more months at once.
- **Pot only.** Payments come only from the chosen pot, never the main balance; there is no fallback. With no pot, the
  sheet offers to make one (the request answers `Declined`; ask again once the user has a pot). Every payment goes
  through the pot's Stop switch, the global Stop all and its daily cap. If the pot is empty or the cap is hit, the
  charge fails and the status shows `lastError`.
- **Signed by the merchant.** Every `subscribe` request carries the merchant's signature (see Signing). Unsigned,
  altered, expired or replayed requests are refused before the sheet opens. The sheet names the site by its real
  origin and shows your merchant name as named by that site. The key is remembered per origin when the user approves:
  later requests show "Same merchant key as before", and a different key from the same origin gets a warning.
- **Limits.** One request per site may wait for the user at a time, and a site may ask a few times a minute. A
  request's nonce is used up only when the user approves it.
- **The user is in charge.** Every subscription is listed in Pots & Locks › Subscriptions with Pause and Cancel.

Available in bWalletX (web, extension, direct APK). The App Store / Play edition (bWallet) doesn't answer these calls.

## Where it works

The page posts the same message to `window.parent` in all three places (at the top level `window.parent` is the page
itself), and listens for the reply on `window`. The origin always comes from the browser, never from the page:

| Where                         | How the message reaches the wallet                       | Origin taken from                    |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------ |
| bApp frame (bApps list only)  | `postMessage` to the parent wallet page                  | the `MessageEvent` origin            |
| In-app browser (iOS, Android) | the injected provider forwards it over the native bridge | the native WebView's frame origin    |
| Chrome extension              | the content script forwards it to the open wallet page   | Chrome's `sender` (origin / tab URL) |

Only the page's own window is heard (a child frame posting to its parent is ignored). Pages must be https (http only
on localhost). In the extension the wallet must be open (side panel or popup); otherwise the reply is an error asking
the user to open bWalletX.

## Messages

Request (page → wallet):

```json
{ "type": "BWX_SUBSCRIBE", "isInvocation": true, "id": "req-1", "call": "subscribe", "args": { ... } }
```

Reply (wallet → page):

```json
{ "type": "BWX_SUBSCRIBE", "isInvocation": false, "id": "req-1", "status": "success", "result": { ... } }
{ "type": "BWX_SUBSCRIBE", "isInvocation": false, "id": "req-1", "status": "error", "description": "Declined" }
```

`id` is any string (up to 128 chars) or number; the reply carries the same one.

### `subscribe`

| arg            | type   | rule                                                               |
| -------------- | ------ | ------------------------------------------------------------------ |
| `merchantName` | string | shown on the sheet, up to 40 chars                                 |
| `payTo`        | string | a paymail (`pay@example.com`) or a BSV address                     |
| `usdPerMonth`  | number | dollars a month, $0.01 to $100, rounded to cents                   |
| `description`  | string | optional, up to 140 chars, shown under Details                     |
| `appOrigin`    | string | must equal the origin of the page sending the message, or it fails |
| `merchantKey`  | string | the merchant's identity public key, compressed hex (66 chars)      |
| `nonce`        | string | 16-64 chars of `A-Z a-z 0-9 _ -`, unique per request               |
| `expiresAt`    | number | ms since 1970; in the future and at most 15 minutes ahead          |
| `signature`    | string | BSM signature (base64, compact) by `merchantKey`, see Signing      |

The paymail must resolve to an address (P2P-only paymails are not supported yet). The result is a **status**
(below). Errors: `Declined` (the user said Not now, or made a pot first), `Unsigned request…`,
`The merchant signature doesn’t match this request`, `This request has expired`, `This request was already used`,
`Only a pot can pay`, `Unlock bWalletX, then try again`, or a message naming the bad argument.

### Signing

Sign on your **server** with a key you keep for this (your merchant identity key); never put it in the page. The
signed message is this exact JSON array, as UTF-8, signed as a Bitcoin Signed Message (BSM, `@bsv/sdk` `BSM.sign`
with mode `base64`):

```js
JSON.stringify([
  'bwx-subscribe-v1',
  origin, // your page's origin, e.g. "https://app.example.com" (the wallet uses the origin the browser reports)
  payTo, // as sent
  usdPerMonth.toFixed(2), // e.g. "5.00"
  'month',
  merchantName, // as sent (no control characters, trimmed)
  description, // as sent, "" if none
  nonce,
  expiresAt, // a number, not a string
]);
```

The wallet rebuilds the array from what it shows on the sheet and the **real** sender origin, so a signature made for
one site fails on another, and changing any field breaks it. Each `merchantKey` + `nonce` is accepted once per origin
(until it expires), counted when the user approves. Keep `merchantKey` stable: the wallet pins it to your origin, and
a changed key is shown to users as a warning.

```js
// Node, on your server
import { BSM, PrivateKey, Utils } from '@bsv/sdk';
const key = PrivateKey.fromWif(process.env.MERCHANT_WIF);
const nonce = crypto.randomUUID().replaceAll('-', '');
const expiresAt = Date.now() + 5 * 60_000;
const msg = JSON.stringify([
  'bwx-subscribe-v1',
  origin,
  payTo,
  usdPerMonth.toFixed(2),
  'month',
  merchantName,
  description,
  nonce,
  expiresAt,
]);
const signature = BSM.sign(Utils.toArray(msg, 'utf8'), key, 'base64');
return { merchantKey: key.toPublicKey().toString(), nonce, expiresAt, signature };
```

The wallet's own copy of this recipe is `signSubscribeRequest` in `src/mobile/pots/merchantSig.ts`.

### `status` · `cancel`

`args: { "id": "<subscription id>" }`. An app can only see or cancel subscriptions it created. Any other id answers
`Unknown subscription`. `cancel` returns the status afterwards (`cancelled`).

### `list`

`args: {}`. Every subscription this origin created, as statuses.

### Status

```json
{
  "id": "3f0c…",
  "status": "active",
  "merchantName": "Example Pro",
  "usdPerMonth": 5,
  "nextCharge": "2026-11-16T12:00:00.000Z",
  "lastPayment": { "at": "2026-10-16T12:00:04.000Z", "txid": "ab12…", "usd": 5, "sats": 10000000 },
  "lastError": null
}
```

`status` is one of `active`, `lowFunds`, `paused`, `cancelled`, `ended`. `nextCharge` is `null` once it can't charge
again. Check a payment yourself from `lastPayment.txid` and your `payTo` address.

## Example

```js
const ask = (call, args) =>
  new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const on = (e) => {
      const d = e.data;
      if (e.source !== window.parent || d?.type !== 'BWX_SUBSCRIBE' || d.isInvocation || d.id !== id) return;
      window.removeEventListener('message', on);
      d.status === 'success' ? resolve(d.result) : reject(new Error(d.description));
    };
    window.addEventListener('message', on);
    window.parent.postMessage({ type: 'BWX_SUBSCRIBE', isInvocation: true, id, call, args }, '*');
  });

const plan = {
  merchantName: 'Example Pro',
  payTo: 'pay@example.com',
  usdPerMonth: 5,
  description: 'Pro plan: no ads, HD',
};
// Your server signs it (see Signing) and returns { merchantKey, nonce, expiresAt, signature }.
const proof = await fetch('/api/sign-subscription', { method: 'POST', body: JSON.stringify(plan) }).then((r) =>
  r.json(),
);
const sub = await ask('subscribe', { ...plan, appOrigin: location.origin, ...proof });
localStorage.setItem('bwxSub', sub.id);

// Later
const s = await ask('status', { id: localStorage.getItem('bwxSub') });
if (s.status !== 'active') showUpgrade();

// Let the user stop it from your app too
await ask('cancel', { id: s.id });
```

## Not covered yet

- Other wallets, and the web wallet's own tabs outside the bApp frame.
- Presigned payments (`docs/POTS-SUBSCRIPTIONS-PLAN.md` §4). This API pays on open only.
- `@bwalletx/connect` (separate repo, bitcoin-corp/bwalletx-connect) has no `subscribe` helper yet; apps use the
  message above.
