# Phone pairing: proving a site's origin

## Return to the site (v2), quick reference

Add these four optional fields to the pairing link, next to the fields you already send. Keep `v=1` and keep `s`:
older wallets ignore the new fields and still see your v1 proof.

| Field | Value                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ret` | The https URL to send the user back to after Allow. Same host as `o`, or a subdomain of it. At most 512 bytes. No userinfo, no port. |
| `rid` | A one-time request id: 16 random bytes, base64url (22 chars; 16–64 `[A-Za-z0-9_-]` accepted). New for every link.                    |
| `b`   | Browser hint: `safari`, `chrome`, `firefox`, `samsung`, `edge`, `brave` or `other`. Optional.                                        |
| `s2`  | The v2 proof: DER signature (hex), by a key in your `/.well-known/bwalletx-pair.json`, over the UTF-8 string below.                  |

```
bwallet-pair-v2|proof|<c>|<k lowercase>|<o>|<e>|<ret>|<rid>|<b, or empty>
```

`signPairProofV2` in `src/pair/protocol.ts` builds it. Example link (line breaks added):

```
https://www.bwallet.space/pair?v=1&r=relay.bwallet.space&c=Q2hhbm5lbElkMTIzNDU2Nw
  &k=02a1…&o=https%3A%2F%2Fwww.tokenblaster.lol&e=1793000000
  &s=3044…                       (v1 proof, unchanged)
  &ret=https%3A%2F%2Fwww.tokenblaster.lol%2Fterrornode
  &rid=Zm9vYmFyYmF6cXV4MTIzNA
  &b=chrome
  &s2=3045…                      (v2 proof over the string above)
```

After the user taps Connect, the wallet opens `ret` with the result in the fragment, so it never reaches your server:

```
https://www.tokenblaster.lol/terrornode#bwx=ok&rid=Zm9vYmFyYmF6cXV4MTIzNA
```

On that page: check `rid` is the one you issued (then forget it), restore the pairing you saved before navigating
(`restorePairing`) and carry on. Save the pairing state in **localStorage keyed by `rid`**, not only sessionStorage: the
web wallet returns in a new tab (below). The fragment carries no secret; sign the user in with your own
challenge/verify over the relay as today.

**When the wallet returns.** Only when all of these hold; otherwise it shows the usual "switch back to your browser"
screen and nothing else changes:

- `s2` verifies against a key at `https://<o>/.well-known/bwalletx-pair.json` (it binds `c`, `k`, `o`, `e`, `ret`,
  `rid` and `b`, so none of them can be swapped);
- `ret` is https, on the host of `o` or a subdomain of it (never a parent domain or a look-alike), no userinfo, no
  port, at most 512 bytes; and the relay's origin equals `o`;
- `rid` has not been used on that device in the last 24 hours.

A link with only `s` (v1) still pairs and shows the host plainly, just without a return. A link with only `s2` also
counts as proven.

**Which browser.** Send `b` for the browser that opened the link (the wallet can't tell from the app):

| Where the wallet runs | `b`                                             | Opens                                                                                                                                        |
| --------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS app               | `safari`, `other`, none                         | the https URL (the default browser)                                                                                                          |
| iOS app               | `chrome`                                        | `googlechromes://<host><path>…`                                                                                                              |
| iOS app               | `firefox`                                       | `firefox://open-url?url=<https URL>`                                                                                                         |
| Android app           | `chrome`, `samsung`, `firefox`, `edge`, `brave` | `intent://<host><path>…#Intent;scheme=https;package=<browser>;S.browser_fallback_url=<https URL>;end`                                        |
| Android app           | `other`, none                                   | the https URL (the default browser)                                                                                                          |
| Web wallet            | any                                             | the https URL in a new tab, after the user taps **Return** (browsers block untapped popups); the wallet tab must stay open for your requests |

Android packages: chrome `com.android.chrome`, samsung `com.sec.android.app.sbrowser`, firefox `org.mozilla.firefox`,
edge `com.microsoft.emmx`, brave `com.brave.browser`.

**No app installed.** `www.bwallet.space/pair` (site/pair.html) on a phone offers **Open in the bWallet app**
(`bwalletx://pair?<same params>`), **Use the web wallet**
(`https://web.bwalletx.com/m/settings?bwxpair=1&<same params>`, same request and same return) and **Get bWallet**
(`/get`). It never shows a QR or mentions a computer on a phone.

Security audit 19 Oct 2026, finding H1 (and C2/M4 on the seedless branches).

## The problem

A paired site talks to the phone through relay.bwallet.space. The relay tells the phone which origin opened the
channel, but it reads that from the WebSocket `Origin` header. Browsers set that header honestly; any other client
(Node, curl, a script) can set it to anything. The 4-digit code doesn't help: it comes from the attacker's own key,
so the attacker's screen shows the same code.

## What ships now

1. **Pinned relay.** Pairing links must name `relay.bwallet.space` (loopback only in dev builds). Links naming any
   other relay are refused, and stored pairings that point elsewhere are dropped on load and never reconnected.
2. **No inherited trust.** A paired session runs under its own permission key, `<host>.paired.invalid`
   (`.invalid` never resolves, so no real site can hold it). It does not get the site's saved grants, its monthly
   allowance or its "Don't ask again". Everything the paired page asks for gets a fresh approval sheet, and anything
   the user grants there belongs to the paired key only.
3. The relay's origin is still checked against the QR, but only to catch honest mistakes. It is a hint, not proof.

Side effect: level-2 keys (protocol keys bound to the originator) differ between the in-app browser and a paired
session for the same site. That is deliberate.

## Origin proof (shipped 25 Oct 2026, display only)

A site may prove its origin so the phone shows its host plainly. Without a proof the phone says
**"a site that claims to be <host>"** in amber (pair screen, done screen, Paired websites).

1. Publish `https://<origin>/.well-known/bwalletx-pair.json` = `{"keys":["02…"]}` (up to 8 compressed secp256k1
   public keys; served directly, no redirect, ≤ 8 KB).
2. Add `s=<DER signature hex>` to the pairing QR: the signature by one of those keys over the UTF-8 string
   `bwallet-pair-v1|proof|<channel>|<k lowercase>|<origin>|<expiry>` (`signPairProof` in `src/pair/protocol.ts`).
   It binds the channel and the site's ephemeral key, so it can't be replayed.

A proven pairing still runs under its own `.paired.invalid` key: the proof changes what is shown, not grants.

## Sharing the site's grants (not built yet)

Let a site prove it controls its origin before a paired session can share that origin's grants:

- **Well-known key.** The site publishes a pairing public key at `https://<origin>/.well-known/bwallet-pair.json`
  (fetched by the phone over TLS, so only the real origin can publish it). The site signs
  `bwallet-pair-v1|<channel>|<site ephemeral key k>|<expiry>` with that key and sends the signature in its first
  sealed frame. The phone fetches the key itself, verifies the signature, and only then maps the session to the
  real originator. A forger can't sign without the origin's key.
- **Or a server attestation.** bwalletx.com (or the relay operator) issues a short-lived signed statement binding
  `k` to an origin, issued only after an https callback to that origin; the phone checks the signature against a
  key pinned in the app.

Either way the binding covers the channel and the ephemeral key, so a proof can't be replayed onto another channel.
Until then, paired sessions stay on their own key.

## CLI pairing

`https://cli.bwalletx.com` has no web origin to prove. A CLI session is bound to an agent account with scopes the
user picks on the phone, and the pinned relay closes the attacker-relay case. Spoofing the CLI origin on the real
relay is still possible, so the CLI confirm screen must keep treating the request as untrusted (user picks scopes,
caps and expiry).
