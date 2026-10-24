# Passkey seed backup ("seedless sign-up"), prototype

Status: prototype on `feat/seedless-passkey`, 19 Oct 2026. **Off everywhere** unless built with `VITE_SEEDLESS=1`,
and forced off in store builds. Code: `src/mobile/passkey/`. Tests: `src/mobile/passkey/seedBackup.test.ts`.

## What it is (and is not)

- The wallet still makes the normal BIP39 12 words, exactly as today (`keysService.generateSeedAndStoreEncrypted`).
  Key derivation, the password keystore, lock/unlock and Face ID unlock (`biometricUnlock.ts`) are untouched.
- New: the user can **seal the 12 words with a passkey** (Face ID / fingerprint / device PIN, synced by iCloud
  Keychain or Google Password Manager) and get them back on a new device with the same passkey.
- So it is "seedless" in the user's experience (no paper needed), not in the key model. The 12 words still work
  and Settings › Backup › "Show recovery phrase" stays.

### Why the password stays in v1

The password encrypts the keystore that every unlock path reads (password unlock, biometric re-seal, account
switching, USB backup, the extension). Letting a passkey replace it means a second keystore wrapping, changes to
`UnlockWallet`, `ChangePassword`, `biometricUnlock`, forgot-password, and the extension, where the passkey can't
work (see rpId below). That is too much KEY code for a prototype. v1 adds the passkey **backup** alongside the
password. v2 option: on web only, derive the keystore password from the same PRF output (a second HKDF `info`
label, e.g. `bwalletx keystore v1`) so "Continue with a passkey" needs no password at all; the password form then
becomes "Set a password too (for the extension)".

## Welcome screen and identity (owner, 19 Oct 2026)

Flag-on welcome (`src/mobile/passkey/SeedlessWelcome.tsx`, replaces Create / Restore on `Start.tsx`), in this order:

1. **Continue with X**, 2. **Continue with Google**: the existing wallet sign-in (`social/SocialSignIn.tsx`,
   `social/socialLogin.ts` → paymail server `/api/social/start` + `/preview`, web returns to the same tab). This is
   **who you are**: the verified profile waits as `NEW_ACCOUNT`, the new account picks it up (`bindSocial`, mobile
   patch on CreateAccount) and "Claim your name" links the $name and badge as today. It never touches keys.
   (Reverses the 18 Oct removal of these buttons from Create, but only in VITE_SEEDLESS builds.)
2. **Continue with a passkey**: **what protects the keys** (`/create-wallet?via=passkey`, `PasskeyCreate.tsx`).
3. "Use a password instead" (the current flow) · "Restore a wallet".

### Passkey instead of a password (v1.5, built)

With `?via=passkey` the user never invents a password:

- One passkey sheet makes the passkey and returns its PRF output.
- The wallet password is derived from it: `"pk1." + b64url(HKDF-SHA256(prf, salt=0^32, info="bwalletx keystore password v1"))`.
  The normal create path runs with that password (same keystore format, nothing else changed). The derived
  password is not offered to the browser's password manager (patch in `vite.config.mobile.ts`).
- The 12 words are still generated and shown; the same PRF output (kept in memory only, `session.ts`) seals them
  straight away, so the recovery file downloads with no second prompt.
- Unlock screen shows **"Unlock with passkey"** when `bwx:passkey-unlock` (credential id + rpId, not secret) is
  set; it derives the same password and runs the normal unlock. Typing the password is still possible in theory
  but the user doesn't know it; "Forgot password? Restore with recovery phrase" and Restore with a passkey are the
  ways back.
- Not covered yet: adding a second account (asks for the
  master password: needs the same "Use passkey" button there), the extension and native apps (no passkey).

Verified 19 Oct in headless Chrome + virtual PRF authenticator: welcome shows the five options in order; Continue
with a passkey → Create my passkey → wallet created, words shown, "Saved with your passkey", file downloaded →
session cleared + reload → "Welcome back" with **Unlock with passkey** → unlocked to the Wallet tab. X / Google were
not exercised (real OAuth); they are the unchanged existing flow.

### Welcome layout v2 + HandCash (owner, 19 Oct 2026)

Order: Continue with X, Google, **HandCash**, then Continue with a passkey, then two full-size secondary buttons
**Create with password and 12 words** and **Restore with 12 words or a backup file** (today's flows, unchanged). On
narrow screens (< 640px) X / Google / HandCash are one row of three icon buttons after "Continue with"; wider
screens get full buttons. Screenshots: 1440 and 390 wide (scratchpad, see PR report).

**Continue with HandCash = identity only** (`passkey/handcashWeb.ts`). Same PKCE contract as the phone app's "Sign
in with HandCash" (`social/handcashLogin.ts`: bit-sign `/api/auth/handcash?mode=native` + `/api/auth/native/exchange`
on www.bchatx.com, HandCash app id/secret server-side only). The web version returns to
`https://<web origin>/auth/handcash`, keeps only the verified `$handle` (shown with a badge) and drops HandCash's
auth_token at once. Keys still come from the passkey or password. **Missing server side** (not in this repo):

1. bit-sign must allow `https://web.bwalletx.com/auth/handcash` and `https://desktop.bwalletx.com/auth/handcash`
   (and beta.) as `redirect` for `mode=native` (today only `bwalletx://auth/handcash`, bit-sign #283);
2. CORS on `/api/auth/native/exchange` for those origins;
3. Vercel: `/auth/handcash` must serve index.html (SPA fallback; check the web project's rewrites);
4. linking the handle to the new account's badge on web: the phone links it via the stored token; on web the
   handle is only shown for now. Needs a bit-sign "attach verified handle to identity key" call, or the user links
   HandCash later in the app.
   Until 1-2 exist the button comes back with an error and the other options still work.

### Existing password wallets: Settings › Passkey (built)

Settings › Security › **Passkey** (`PasskeySettings.tsx`, flag only):

- **Add a passkey to this wallet**: type the current password → one passkey prompt → the typed password is sealed
  with a PRF-derived key (`sealPassword`, HKDF label `bwalletx unlock password v1`, AAD = rpId + credential id) and
  stored as `bwx:passkey-unlock.sealed`; the open account's 12 words are sealed in the usual blob (now with
  `account`). The keystore is not touched; the typed password keeps working.
- Wallet already has a passkey: the button backs up the open account too (reuses the same passkey, one prompt).
- Lists every account with "Passkey backup" / "None". **Remove passkey** forgets the unlock record and that
  passkey's local backups (the passkey itself stays in iCloud / Google until the user deletes it).
- **Change password** re-seals the new password with one passkey prompt ("Unlock with passkey still works."). If
  the prompt is cancelled, passkey unlock is turned off and the screen says to add it again. A wallet made with
  "Continue with a passkey" becomes a sealed-password wallet after a change.

Verified 19 Oct, headless Chrome + virtual PRF authenticator: password wallet → Settings › Passkey → add →
account shows "Passkey backup" → lock → Unlock with passkey ✓ → typed old password still unlocks ✓ → Change
password → "Unlock with passkey still works." → lock → Unlock with passkey ✓ → Remove passkey → lock → no passkey
button ✓.

### Finding the backup by X / Google on a new device (design, not built)

Goal: new phone → Continue with X → passkey sheet → wallet back, no file. The server keeps ciphertext only.

- Store: the paymail sign-in service already proves an X / Google account with a one-time `ticket` + `secret`
  (`/api/social/preview`). Add `POST /api/social/backup/put { ticket, secret, blob }` (store the blob under the
  verified `provider:subject`, at most 5 per subject) and `POST /api/social/backup/get { ticket, secret }` (return
  that subject's blobs). Both take a fresh sign-in proof, so only the X / Google account holder can fetch.
- Why server + X/Google together can't decrypt: the blob is AES-GCM under a key from the passkey's PRF output,
  which only the user's authenticator can compute after Face ID / fingerprint. The server never sees PRF output,
  the phrase or a key; X/Google never see the blob. A server breach plus an X takeover yields ciphertext only.
- Client: after the social return on Restore, call `backup/get`, list the blobs (label, date), then `getPrf(rpId,
credentialId)` → `openSeed` → normal restore (the code path in `PasskeyRestoreRow.openWith`).
- Missing today: the two endpoints and a table on the paymail server (`social_backups(subject text, credential_id
text, blob jsonb, created_at)`, RLS on) and a migration on Hetzner, not run. Alternatively key it by identity key
  on the bit-sign API (below); the X / Google lookup is what makes "no file" work on a new device.

## Round 4 (owner, 19 Oct 2026): saved banner, server store, phone pairing, open on computer

### 12-words step in the passkey flow

Big green check: **"Already saved. You don't need to write these down."** + "Your wallet is locked with your passkey
(Face ID / Touch ID) and an encrypted backup was saved to this device. These 12 words are only for people who want a
paper copy." The words sit behind **"Show my 12 words (optional)"**; the button is a big **Continue**. While the seal
runs it says "Saving…"; if sealing fails it turns red ("Write these 12 words down on paper before you continue")
and shows the words. "Passphrase" never appears in this flow.

### Server store (bit-sign PR, table NOT created)

`PUT /api/bitsign/passkey-backups` `{ blob, identity_key, ts, signature }`: BSM signature by the wallet identity key
over `bwalletx passkey backup v1|<credentialId>|sha256(blob json)|<ts>` (5-minute window). The first PUT claims the
credential id for that key; later PUTs need the same key (no overwrite by others). `GET
/api/bitsign/passkey-backups/<credentialId>` → `{ blob }`, public by random id, ciphertext only, rate-limited (30 /
10 min / IP), one 404 for missing and deleted. Migration `migrations/20261220_passkey_seed_backups.sql` (RLS on,
service role only) **must be approved and run by the owner**; until then the routes answer 503 and the wallet keeps
the local copy + recovery file (it says "Online copy not available right now").
Why identity-key signature and not a WebAuthn assertion: verifying an assertion needs the passkey's public key on
the server (a registration ceremony we don't have); the identity key is already the wallet's public identity and
the wallet can sign with it at the moment it seals.

Client (`passkeyServer.ts`): uploads after every seal (sign-up, Settings › Passkey), three tries; restore does a
**discoverable** passkey sign-in (no allowCredentials) → credential id → local copy, else server → decrypt →
normal restore, and the restored wallet unlocks with the same passkey (no password).

### Pair your phone at sign-up

After a passkey sign-up on a computer: **"Put this wallet on your phone"** with a QR to
`https://web.bwalletx.com/restore?passkey=1` (no secrets: the synced passkey + server copy do the work) and "Same
Apple or Google account → your passkey is already on your phone." **Later** skips. On a phone the same step reads
**"Add on your computer"** with the address. Settings › Passkey › **Pair a device** shows it again. (Success on the
other device is not reported back yet: optional, would need a "restored" ping to the store.)

### Open on computer (WhatsApp-Web style) — threat model

For wallets that live in the phone app (no passkey yet). Web welcome at desktop widths: "Already have bWalletX on
your phone? Scan to open it here" + QR. Phone: Scan (top bar) or Settings › Passkey › **Scan to open on computer** →
"Open your wallet on web.bwalletx.com? Check the code: 4-7-2-9" → wallet password (app lock) → the open account's
12 words are sealed to the computer and sent → the computer restores and asks for a passkey ("Create my passkey"),
so it is a passkey wallet from then on. Code: `passkey/openHere.ts`, `OpenOnComputer.tsx`, `OpenHereSheet.tsx`.

- **QR**: `https://www.bwallet.space/open?v=1&r=<relay>&c=<channel>&k=<ephemeral pubkey>&o=<origin>&e=<expiry>`.
  Public data only; a fresh key pair per QR, private key in page memory only.
- **Transport**: the existing phone-pairing relay (`relay/relay.mjs`, relay.bwallet.space). It forwards frames
  verbatim and never sees plaintext. It reports the computer socket's Origin to the phone; the phone refuses unless
  it equals the QR's `o` and is a `https://*.bwalletx.com` host. That stops a QR shown on a phishing page in a real
  browser, but it is a **hint, not proof**: any non-browser client can send any Origin header (audit C2, 19 Oct). The
  phone UI never calls it "verified" and does not show it.
- **Crypto (v2)**: ECDH secp256k1 (phone ephemeral × computer ephemeral) → HKDF-SHA256(salt = channel, info =
  `bwalletx-open-v2`) → AES-256-GCM key + HMAC-SHA256 key; AAD binds the channel; the payload carries the QR expiry.
- **The code goes phone → computer (audit C2 fix)**: the phone makes 6 random digits and shows them only on its
  screen. The user types them on the computer, which sends `HMAC(macKey, "bwalletx-open-proof|<channel>|<code>")`.
  The phone checks it once: a wrong proof ends the session. Only after a good proof and Face ID / the wallet
  password does it seal the words. Whoever made the QR knows its key (v1's 4-digit code came from that key, so an
  attacker with a forged Origin could display it); only someone looking at the phone knows v2's code. A remote
  attacker gets one guess per scan: 1 in 1,000,000. A key-swapping MITM can't produce a valid proof either.
- **Expiry and single use**: QR and relay channel live 2 minutes (the relay enforces the expiry when the phone
  joins; the phone checks it again before sending); the computer accepts exactly one wallet frame, then closes and
  forgets the key. A new QR appears on expiry.
- **Consent**: the phone sends nothing until the computer has proved the code and the user has confirmed with Face
  ID / the wallet password; the sheet says "It gets full control of this wallet."
- **What it does NOT protect against**: malware on the computer or a malicious browser extension on
  web.bwalletx.com (it would see the words after decryption, as with typing the 12 words), a compromised
  web.bwalletx.com deployment, or a user who reads the code out to someone else (the sheet says never to). The relay operator can deny
  service but not read or change the wallet.
- Tests (`openHere.test.ts`): QR has no secrets and round-trips; lookalike / http / foreign origins refused; 2-minute
  expiry and over-long expiry refused; both sides derive the same code and key; a MITM key gives a different code
  and can't decrypt; channel binding; expired payload refused.
- Verified 19 Oct: headless Chrome (computer, 1440) + a simulated phone running the same `beginOpenHere` code
  against a local relay: codes matched (2-1-2-9 on both), words arrived, Restore → Create my passkey → wallet
  restored → lock → Unlock with passkey. The phone UI sheet itself was not driven (needs the app + camera).

## Round 5 (owner, 19 Oct 2026)

Server table `public.passkey_seed_backups` now exists (migration run by the coordinator after owner approval).

### Scan to open on computer: confirm with Face ID / Touch ID

The phone sheet's main button is **"Codes match: confirm with Face ID"** (or Touch ID / fingerprint).
`confirmWithBiometrics()` in `biometricUnlock.ts` reuses the existing biometric unlock: it reads the account's
sealed unlock key from the Keychain / Keystore (`YoursNative.biometricGet`, which shows the system biometric prompt)
and checks it still decrypts this account's keys. That proves the owner is present on an enrolled device. The
password itself is never needed here: the wallet is already unlocked, so its keys are readable
(`keysService.retrieveKeys()` without a password uses the session key, as the rest of the app does). If biometric
unlock isn't set up for this account (or on the web), the sheet falls back to the wallet password; "Use my password
instead" is always there.

### "✓ Your phone has it"

The computer's "Put this wallet on your phone" QR now also carries a one-time relay channel and ephemeral public key
(`/restore?passkey=1&r=…&c=…&k=…&e=…`). The phone joins that channel as soon as the page opens (the relay keeps a
joined channel open) and, once its passkey has opened the backup, sends one sealed ping `{ t:'restored', fp }` where
`fp = SHA-256("bwalletx-restored|" + words)`. The computer shows **✓ Your phone has it** only if `fp` matches its own
new wallet, and the button becomes Continue. No server, no PII, the relay sees ciphertext only, and the HKDF label
differs from "open on computer". Best effort: if the phone opens the page after the QR lapsed (≈4½ min; the computer
renews it) or restores some other way, nothing is shown and nothing breaks.
(Scan-to-open is the other direction, phone to computer, so its success is already visible on the computer.)

### Add account with a passkey

On a passkey wallet, Add account (both "New account" and restoring another wallet into it) shows **Use passkey**:
one passkey prompt unseals or derives the master password (`unlockPasswordFromPrf`) and the normal add-account path
runs. Typing the master password still works.

Verified 19 Oct (headless Chrome + virtual PRF authenticator, local relay; phone simulated with the same
`armRestorePing` / `sendRestoredPing` code): see the PR report. The biometric confirm needs a real device;
unit-tested only for its fallback.

## Crypto

```
prfInput  = SHA-256("bwalletx seed backup v1")          fixed, same for every wallet
prfOut    = WebAuthn PRF(passkey, prfInput).first        32 bytes, never leaves the device
key       = HKDF-SHA256(ikm = prfOut, salt = random16, info = "bwalletx seed backup v1 aes-256-gcm")
blob.ct   = AES-256-GCM(key, iv = random12, aad = [kind, v, rpId, credentialId, salt], plaintext = the phrase)
```

The plaintext is the normalised mnemonic text rather than BIP39 entropy, so Twetch/RelayX/24-word or
non-English phrases restore exactly. It is the same secret either way.

Blob v1 (JSON, also the recovery file):

```json
{
  "kind": "bwalletx-passkey-seed-backup",
  "v": 1,
  "rpId": "bwalletx.com",
  "credentialId": "<b64url>",
  "salt": "<b64url>",
  "iv": "<b64url>",
  "ct": "<b64url>",
  "createdAt": "2026-10-19T…",
  "label": "Account 1"
}
```

A newer `v` is rejected with "needs a newer bWalletX". Changing the header breaks the GCM tag.

## What the user sees

Sign-up (Create Account):

1. Account name + password, "Generate Seed" (as today).
2. "Your recovery phrase" shows the 12 words with Copy and Download encrypted backup (as today), plus a new
   link **"Save with a passkey (Face ID / fingerprint)"**, shown only when the browser looks PRF-capable.
3. Tap: the OS passkey sheet ("Create a passkey for bwalletx.com"). Face ID / fingerprint. On Chrome a second
   prompt follows (Chrome gives PRF output only on sign-in, not on create).
4. "Saved with your passkey"; a recovery file `bwalletx-passkey-backup-<date>-<id>.json` downloads, and a copy
   is kept in this browser. Text: keep the file somewhere safe; only your passkey opens it; your 12 words still work.
5. Next / Wallet Ready (as today).

Restore (Restore a Wallet):

1. New top row **"Restore with a passkey"** (Face ID, fingerprint or your device PIN), plus "Use a passkey
   recovery file".
2. Same browser: tap, pick the bWalletX passkey, the matching local backup opens.
   New device: tap "Use a passkey recovery file", choose the file, then the passkey sheet for that passkey.
3. The 12 words are put in the normal restore form ("Restore bWalletX wallet") and the user sets name and
   password; from here it is the normal restore path (`RestoreAccount` → `generateKeysFromTag...` etc.).

Errors are plain: "This passkey doesn't open this backup.", "This device's passkeys can't make a backup key (no
PRF). Keep your 12 words safe instead.", "This backup was made on <rpId>. Open bWalletX there to restore it."

### Settings nudge (spec only, not built)

Where: Settings › Backup row, and the Wallet tab's backup card (`BackupPromo.tsx`), when the account's balance is
over about $100 and it has a passkey backup but the 12 words were never shown/confirmed.

Copy: **"Your wallet is worth more now. Write down your 12 words too."** Sub: "Your passkey backup is handy,
but paper never needs a phone or an account. Takes 2 minutes." Button: "Show my 12 words". Dismiss: "Later"
(snooze 30 days; reappears when the balance doubles).

## rpId decision

**rpId = `web.bwalletx.com`** for `web.bwalletx.com`, `desktop.bwalletx.com` (an explicit list, `WALLET_RP_HOSTS`
in `prf.ts`) and the native apps. Every other host, including `bwalletx.com` and other subdomains, uses its own
hostname.

- Changed 24 Oct 2026 (b-Aware row 57). The first design used the registrable domain `bwalletx.com`. WebAuthn lets
  any `*.bwalletx.com` page request an rpId of `bwalletx.com`, and the PRF input is a public constant, so any
  subdomain (chat., auth., a forgotten deploy) could get the same PRF output and open the seed backup with one
  Face ID tap. Mixing the origin into the PRF input does not help: the caller chooses that input. Only the rpId
  scopes who can ask. No backups existed when this changed (passkey_seed_backups had 0 rows), so nothing moved.
- `desktop.bwalletx.com` uses the same passkeys through Related Origin Requests:
  `https://web.bwalletx.com/.well-known/webauthn` lists it (Chrome 128+, Safari 18+).
- The apps claim `webcredentials:web.bwalletx.com` (iOS) and the `assetlinks.json` on `web.bwalletx.com`
  (Android); both files are served from the wallet's `public/.well-known/`.
- What breaks across origins: a passkey made on localhost/preview only works there (the blob records its rpId
  and the restore screen says where to go).
- The browser blocks `rp.id = bwalletx.com` from any page that is not on bwalletx.com, so a phishing site can't
  ask for our PRF output.

## Support matrix

| Environment                                                                      | WebAuthn           | PRF                                                                 | Status                              | Notes                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headless Chrome 154 (macOS), CDP virtual authenticator (ctap2, internal, PRF on) | yes                | yes                                                                 | **Verified** 19 Oct                 | `/passkey-check` PASS; full UI run: create wallet → Save with a passkey → wipe wallet storage → Restore with a passkey (local copy) and, separately, via the recovery file → same identity address. With PRF off the "no PRF" message shows.                                                                         |
| Desktop Chrome, real iCloud Keychain / Google Password Manager passkey           | yes                | yes (Chrome 116+ with GPM; iCloud Keychain via Chrome on macOS 15+) | Researched                          | PRF results come at get(), not create(); we do the second prompt                                                                                                                                                                                                                                                     |
| Safari macOS 18+                                                                 | yes                | yes (iCloud Keychain passkeys)                                      | Researched                          | Safari returns PRF at create() too                                                                                                                                                                                                                                                                                   |
| iOS Safari 18+                                                                   | yes                | yes (iCloud Keychain)                                               | Researched                          | iOS 17 and older: no PRF, option hidden                                                                                                                                                                                                                                                                              |
| Android Chrome (GPM passkeys)                                                    | yes                | yes                                                                 | Researched                          | Needs current Play services; third-party providers vary                                                                                                                                                                                                                                                              |
| Firefox 135+                                                                     | yes                | yes for security keys, platform varies                              | Researched                          | `getClientCapabilities` missing → we can't know until we try                                                                                                                                                                                                                                                         |
| Capacitor iOS (WKWebView, `capacitor://localhost`)                               | no usable          | no                                                                  | Researched: **does not work**       | WKWebView only allows WebAuthn for the app's associated domains, and the page origin is `capacitor://localhost`, never bwalletx.com. Needs a native plugin using `ASAuthorizationPlatformPublicKeyCredentialProvider` (iOS 18 adds `prf` to ASAuthorization) + `webcredentials:bwalletx.com` entitlement + AASA file |
| Capacitor Android (WebView, `https://localhost`)                                 | opt-in only        | no                                                                  | Researched: **does not work as-is** | Android WebView WebAuthn needs `WebSettingsCompat.setWebAuthenticationSupport` and still checks the origin against the rpId via Digital Asset Links. Real path: native Credential Manager plugin (`androidx.credentials`, PRF passed in the JSON request) + `assetlinks.json` on bwalletx.com                        |
| Chrome extension (`chrome-extension://<id>`)                                     | yes for its own id | rpId would be the extension id                                      | Researched: **not offered**         | An extension page cannot claim `bwalletx.com` as rpId, so its passkeys wouldn't open web backups. The flag check plus `detectPrfSupport()` hide it there                                                                                                                                                             |
| Tauri Desktop (WKWebView on macOS)                                               | no usable          | no                                                                  | Researched                          | Same as Capacitor iOS; use the web edition                                                                                                                                                                                                                                                                           |

Test page: build with `VITE_SEEDLESS=1` and open `/passkey-check`. It reports origin, rpId, secure context,
platform authenticator, `getClientCapabilities()['extension:prf']`, and "Run full test" makes a throwaway
passkey ("bWalletX PRF test"), seals a dummy phrase and reopens it with a second get().

## Server blob store (design only, nothing deployed, no migration run)

Goal: restore on a new phone with just the passkey (no file). The server stores ciphertext it cannot open.

Natural home: the existing bit-sign API that bWalletX already calls with wallet-signed auth
(`/api/bitsign/auth/wallet/challenge` + `/verify`, then `/api/bitsign/me/*`), served for bWalletX (brand
consolidation keeps the server, only the name goes).

```
PUT  /api/bitsign/me/passkey-backups            (wallet-authenticated; body = blob v1)
     -> stores { identity_key, credential_id, blob, created_at }; max 5 per identity key
GET  /api/bitsign/passkey-backups/:credentialId  (no auth: returns the blob for that credential id)
DELETE /api/bitsign/me/passkey-backups/:credentialId
```

- Lookup by credential id, because on a new device we don't know the identity key yet: the passkey sheet gives
  us `rawId` first, then we fetch the blob for it. Credential ids are random 16+ bytes and the blob is useless
  without the passkey's PRF, so an unauthenticated GET is acceptable; rate-limit it and return the same 404 for
  "never existed" and "deleted".
- Writes need the wallet signature, so nobody can overwrite another user's backup.
- Table sketch (not run): `passkey_backups(credential_id text primary key, identity_key text not null,
blob jsonb not null, created_at timestamptz default now())`, RLS on, service-role only.
- Server never sees the PRF output, the phrase or the AES key. A database leak gives attackers blobs they can
  only open with the user's passkey, which needs the user's device and biometrics.

## Risks / honest caveats

- A passkey is only as safe as the account syncing it (Apple ID / Google account). Someone who takes over that
  account and has the recovery file (or, with a server store, just the account) can restore the wallet. That is
  why the nudge pushes paper for larger balances.
- Deleting the passkey in iCloud/Google makes the backup unopenable. The 12 words are the fallback.
- PRF support is new; the option hides itself where the browser says no, but some browsers can't say until a
  passkey is made (then the user sees the "no PRF" message and keeps the 12 words).

## Open decisions for the owner

1. Ship v1 (backup alongside password) to web.bwalletx.com behind the flag, or wait for v2 (passkey instead of
   password on web)?
2. Server blob store: build the bit-sign endpoint (needs a migration on Hetzner) or keep file + local only?
3. Native apps: worth a Capacitor passkey plugin (ASAuthorization / Credential Manager) + AASA/assetlinks for
   `bwalletx.com`? That is what makes it work in the store apps, where most users arrive.
4. Balance threshold and wording for the "write your 12 words too" nudge.

## Native apps (feat/seedless-native)

The Capacitor shells can't use `navigator.credentials` for `bwalletx.com` (origin is `capacitor://localhost` /
`https://localhost`), so `prf.ts` sends passkey calls to a local plugin when `Capacitor.isNativePlatform()`:

- JS bridge: `src/mobile/passkey/nativePasskeys.ts` (`Passkeys` plugin: `isAvailable`, `create`, `get`; base64url
  over the bridge), tests in `nativePasskeys.test.ts` with a mock plugin. Same rpId (`bwalletx.com`), same PRF input
  (`prfSalt()`), same blob format and server store, so one synced passkey gives the same key on web and in the app.
- iOS: `ios/App/App/PasskeysPlugin.swift`, `ASAuthorizationPlatformPublicKeyCredentialProvider` + `prf`
  (iOS 18+; older iOS reports unavailable and the passkey options stay hidden). Entitlement
  `webcredentials:bwalletx.com`; AASA on `https://bwalletx.com/.well-known/apple-app-site-association` lists
  `ZQ4NX9NJ89.com.bitcoincorp.bwallet` and `ZQ4NX9NJ89.com.bitcoincorp.bwallet.private`.
- Android: `PasskeysPlugin.java`, Credential Manager (`androidx.credentials` 1.5.0 + play-services-auth) with
  `extensions.prf` in the WebAuthn JSON (Android 9+). PRF output depends on the provider: Google Password Manager
  returns it; a third-party provider may not, which shows the "no PRF" message. `assetlinks.json` on bwalletx.com
  lists `com.bitcoincorp.bwallet` and `com.bitcoincorp.bwallet.direct` with the upload-key and Play app-signing
  SHA-256 fingerprints (`get_login_creds`).
- Flag: unchanged. `SEEDLESS_ENABLED` needs `VITE_SEEDLESS=1` and is always off in store builds, so only
  `VITE_SEEDLESS=1 bash scripts/channel-build.sh ios-private` / `android-direct` turn it on.
- To verify on device: make a passkey on web.bwalletx.com, then Restore with a passkey in the app (and the reverse);
  both must open the same backup. That proves the OS PRF APIs apply the same WebAuthn salt hashing as the browser.
