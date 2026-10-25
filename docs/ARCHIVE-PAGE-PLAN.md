# Your archive: plan

Owner decision, 25 Oct 2026: a "Your archive" page on the wallet's own site, not on bChatX. The user browses
their private (encrypted) records, such as ~19k imported X posts, ticks some and publishes them as "reveal"
posts to bChatX. bChatX only links to the page.

Record format: `PRIVATE-RECORDS.md` v1 (bit-sign PR #442). Protocol `[2, "bmintx archive"]`, counterparty
`self`, one random keyID (kid) per record, records are `OP_FALSE OP_RETURN` B + MAP outputs.

Status: plan only. Nothing here is built yet.

## 1. Where it lives

**Recommendation: a route inside the wallet, `web.bwalletx.com/archive`, not `archive.bwalletx.com`.**

- The web wallet (`pnpm build:web`, `vite.config.web.ts`) is the mobile UI as a static site. Its keys sit in
  that origin's localStorage, encrypted with the user's password (see `docs/WEB-WALLET.md`). Both web hosts
  already serve `index.html` for deep paths (`/lock/subscriptions`, `/bapp/bchatx`), so `/archive` is just
  one more screen in the same bundle.
- Code on that route is the wallet's own code. It calls the wallet as admin, like every other wallet screen,
  so the pin in `src/services/pinnedProtocols.ts` (which only checks outside originators) is never in play
  and no permission sheet is needed to decrypt.
- `archive.bwalletx.com` would be a new origin with no keys. It would be an outside site like any other: it
  would need the popup connect protocol (not built, `WEB-WALLET.md`) and its own entry in the pin list. More
  work, and a second place that can hold the decrypt grant. No gain.
- The same screen ships in the extension and the phone apps (same code), reached from Home › History or
  bMint. On those it runs inside the extension or app, so it works for users whose wallet is not in this
  browser.

**Why this keeps bChatX out.** bChatX (bchatx.com, bit-sign) never runs code on the wallet's origin. It
links to `https://web.bwalletx.com/archive` (or opens the extension/app). Any call bchatx.com makes with
`[2, "bmintx archive"]` is refused before a sheet appears, because that protocol is pinned to bmintx.com.
The decrypt permission therefore only ever exists inside the wallet (admin) and on bmintx.com.

## 2. Finding records

1. **Wallet history first.** `listActions({ labels: ['bmintx archive'], includeOutputs: true,
includeOutputLockingScripts: true, limit, offset })`. Records are vouts 0…n-1 of each batch; skip the seal
   and change outputs; keep only outputs that parse as spec §3. This works on any device that syncs the same
   wallet storage (remote storage, `DEFAULT_STORAGE_REMOTE_URL`).
2. **After a restore from 12 words on a new device.** Labels live in wallet storage, not on chain. If the
   restored wallet has no `bmintx archive` actions:
   - Records carry no address and no AIP, so they cannot be found by address directly.
   - But each batch was funded from the user's own addresses. Ask the indexer (1sat stack / WhatsOnChain) for
     transactions spending from the wallet's addresses, fetch each, and keep the ones with outputs tagged
     `MAP app bmintx type archive`. Decrypt test each one; failure means not ours, skip.
   - Store the found txids back as actions with the `bmintx archive` label, so the next open is fast.
   - Offer a "Scan the chain for my archive" button for this, with a progress bar. It is slow; it runs once.
3. **Optional, the file on this computer.** See §5.

## 3. Paging and caching

- Load one page of batch transactions at a time (10 transactions, so up to 2,500 records), then decrypt
  only what is on screen: 50 records per page of the list, next page decrypted while the user reads.
- Decrypted text is kept in memory only, at most 500 records, oldest dropped first. Closing the tab or
  locking the wallet clears it. Nothing decrypted is written to localStorage, IndexedDB, extension storage
  or the phone's disk.
- The only thing stored is a small index: txid, vout, kid (all already public on chain). About 100 bytes a
  record, ~2 MB for 19k. Optional; it can be rebuilt from §2.
- Search across all records means decrypting all of them. Offer it as an explicit "Search everything"
  action that walks the archive in the background, holds only the matches, and can be cancelled.
- Sort is by `created_at` inside a page. A full date sort needs a full pass, same as search.

## 4. Decrypt flow

For each record output:

1. Parse the 17 pushes (spec §3). Read `kid` and the ciphertext.
2. `decrypt({ ciphertext, protocolID: [2, 'bmintx archive'], keyID: kid, counterparty: 'self' })` as admin.
3. `JSON.parse` the result (padding is trailing spaces). Reject `v != 1`, `source != 'x'`, or non-string
   `text`.
4. Show it like a post: text, date, "reply to" link, media names. Threads (`reply_to`) group together once
   both posts are decrypted.

The wallet must be unlocked. The spec's test vectors become a unit test for the parser and decrypt.

## 5. Optional: read from the file on this computer

The owner has a ~22 GB X archive. Most of that is media; the posts are in `data/tweets.js` and friends.

- Chromium browsers: `showOpenFilePicker` (File System Access API) or a plain `<input type="file">` gives a
  `File` the browser reads in slices. A zip reader that uses the central directory (zip.js) can pull
  `data/tweets.js` out without reading the other 22 GB. An unzipped folder works with `showDirectoryPicker`.
- Safari and Firefox: plain file input works for the zip; folder picking is limited. The phone apps: skip
  this mode at first.
- Nothing leaves the browser and nothing is copied to storage.
- Use: browse the posts at full speed, with media shown from the file, and match them to records. Matching
  needs the record for each `x_id`, which needs a decrypt pass (§3, "Search everything"). Until that pass
  runs, items from the file can be browsed but not revealed.
- This same reader is the natural home for the import itself (§8, option B).

## 6. Reveal flow

1. User ticks items. A bar shows "Reveal 12 posts".
2. **One sheet**, inside the wallet: OG-style card, "Make 12 posts public on bChatX", the fee, and the warning:
   _"This can't be undone. These posts will be public on chain for good. Your private copies stay locked."_
3. The wallet builds one reveal post per transaction (spec §6: feed posts are keyed by txid). `reveal` is the
   record's `txid:vout`; `source`, `source_id`, `source_at`, `source_url` come from the decrypted record.
4. Threads: reveal parents before replies in the same batch. If a parent was revealed, the reply gets
   `context tx`; if `reply_url` is set, `context url`. Never point a reply at a still-hidden parent.
5. Batching: up to 50 posts per go, sent one after another with chained change (`acceptDelayedBroadcast`).
   A failure stops the run and the sheet says which ones went out.
6. Fees: a reveal post is a few hundred bytes, so roughly 30–60 sats each at 100 sat/kB. 50 posts is under
   3,000 sats. No bChatX fee.
7. Already revealed: the page marks a record "Public" when a reveal post exists for it (from the wallet's own
   history, label `bchat reveal`, or from the bChatX feed, §7).
8. B type: the wallet writes `text/markdown UTF-8` and an AIP signature, as bChatX's own builder does, since
   the bChatX indexer requires AIP. Which key signs the AIP is an open question (§9).

## 7. What bChatX needs to do

- A link "Your archive" in Settings › X import (and on the user's profile, owner-only) to
  `https://web.bwalletx.com/archive`, or the extension/app equivalent when bWalletX is connected.
- Read reveal posts like any other post: show "Originally on X, <source_at date>" and link `source_url`.
  Accept either B type. Never show `app bmintx type archive` records in feeds.
- Drop the `/settings/x-import/reveal` decrypt-and-reveal page. It needs the pinned protocol, which
  bchatx.com is refused.
- Optional: an endpoint listing which `reveal` outpoints have reveal posts, so the wallet can mark them Public.

## 8. bChatX X import: hand the items to the wallet

Today bit-sign PR #442 encrypts on bchatx.com with `[2, "bmintx archive"]`. bWalletX refuses that (pinned to
bmintx.com). Two ways to fix it without giving bChatX the protocol:

**Option A, a "mint privately" request (soon).** bChatX parses the archive in the browser, then sends the
items (the spec §2 fields, no keys) to the wallet in one request, e.g. `bwalletx.mintPrivate({ source: 'x',
items })` over the extension/`@bwalletx/connect` transport. The wallet, as admin, pads, encrypts, builds
the 250-record batches and the seal, labels them, and shows **one** sheet: "Lock 19,214 posts to you, ~1.2M
sats, 77 transactions". It returns the txids. bChatX never calls `encrypt`, never sees a kid's key, and
keeps nothing on its server.

**Option B, import inside the wallet (later, preferred).** The archive page itself reads the zip (§5) and
mints. bChatX's import screen becomes a link to it. Then bChatX never even holds the plaintext.

Start with A since the bit-sign parsing code exists; move to B when the file reader lands.

## 9. Open questions for the owner

1. Route OK as `web.bwalletx.com/archive` (plus the same screen in extension and apps)? Or do you still want
   the `archive.bwalletx.com` name, as a redirect to it?
2. AIP on reveal posts: sign with the user's bChatX identity key, or the wallet identity key? The bChatX
   indexer must accept whichever we pick.
3. The chain scan after restore (§2.2) uses an outside indexer and shows it which addresses we are asking
   about. OK, or only offer it when the user asks?
4. File mode on phones: skip at first?
5. Option A for bChatX's import now, B later: agreed? Should bMintX FLICK OFF move to the same request?
6. Reveal batch cap: 50 per go, fine?
7. Should the 22 GB file's media ever be revealed (uploaded) with a post, or text only for now?

## 10. Status

| Item                                          | Status                                   |
| --------------------------------------------- | ---------------------------------------- |
| Record format v1 (spec, test vectors)         | live (bit-sign PR #442)                  |
| `[2, "bmintx archive"]` pinned to bmintx.com  | live (`src/services/pinnedProtocols.ts`) |
| `/archive` route in the wallet                | coming                                   |
| Find records via `listActions` label          | coming                                   |
| Chain scan after restore                      | coming                                   |
| Page-by-page decrypt, memory-only cache       | coming                                   |
| Search everything                             | coming                                   |
| Read from the file on this computer           | coming                                   |
| Reveal with one sheet and one-way warning     | coming                                   |
| bChatX link to the page                       | coming                                   |
| bChatX reads reveal posts ("Originally on X") | coming (check bit-sign)                  |
| Wallet "mint privately" request for bChatX    | coming                                   |
| Import inside the wallet (option B)           | coming                                   |
