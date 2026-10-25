# Native trading of launchpad tokens (Memepool and TokenBlaster): design

Status: **approved by the owner 25 Oct 2026 ("yes to all three") and built** in `src/mobile/exchange/memepool/`:
1 BSV cap per trade (not 20), 3% default slippage, refuse coins whose `/api/proof` row isn't healthy, and the trade
files are on `.github/money-paths.txt`. Differences from the plan below, found while building:

- **Buys set their BSV aside first.** Memepool spends named coins and the in-app wallet can't sign its own coins one
  by one, so a buy first pays the amount to a fresh BRC-29 key of the same wallet (a payment to itself), offers that
  coin, and takes it back into the balance if the trade isn't made. Sells offer the token coins directly.
- **Curve:** stage 1 is constant product on virtual reserves, the tail (after graduation) on the real reserves. A
  trade that would cross between them is refused (finish it on Memepool). Checked against their live `/quote`.
- **409 after signing:** re-prepared once, then always a fresh sheet (never signed again without the user).
- **Sells** offer only token coins (no fee coin): the payout pays the network fee, as their own page does.

## 1. Memepool (TX Blaster, txblaster.xyz/memepool)

API: `https://txblaster.xyz/memepool/api` (OpenAPI at `/openapi.json`, CORS open, no key; we send
`X-Memepool-Client: bWalletX`). Read 25 Oct 2026 from `/config`: `feeBps 125` (1.25% total, of which
`creatorBps 30`), `platformAddress 1JhfTxnm8YeYHPdXHFYZFaw2aSQrRtB6aa`, `minBuySats 10000`, `maxBuySats 2000000000`,
`satPerKb 500`, `indexFeePerOutput 1000`, curve `vSats0 5e8`, `vTokens0 1.073e9`, `curveSupply 7.931e8`, decimals 0.

### Flow

1. `GET /quote?id=&side=buy&sats=` (or `side=sell&tokens=`) for the number on the screen.
2. `POST /trade/prepare` body `{ tokenId, side, sats | tokens, minTokens | minSats, trader: { ord, pay }, coins: [{txid, vout}] }`
   → `{ quoteId, template, expiresAt }`. `coins` are the UTXOs we offer (pay coins for a buy; token outputs plus a
   fee coin for a sell), chosen by us via the wallet's own `listOutputs`.
3. **Verify the template locally (section below). If any check fails, nothing is signed.**
4. Show the one approval sheet. On Allow, sign only our input indexes.
5. `POST /trade/submit` `{ quoteId, unlocks: { "<index>": "<unlocking script hex>" } }` → 202 = sent; MEMEPOOL signs
   the pool's input last and broadcasts. We then watch the txid (WhatsOnChain / ARC status) and mark our spent coins.

### Template checks before signing (all required, in `memepool/validate.ts`)

- **Our inputs only.** Every input we are asked to sign is one of the `coins` we offered (outpoint match) and is
  ours (`listOutputs`, right basket). Inputs we did not offer are left unsigned; any input we don't recognise that
  is _not_ the pool's published pool UTXO for this token refuses the trade.
- **SIGHASH_ALL | FORKID only** (0x41). Never ANYONECANPAY or NONE/SINGLE, so the server can't add or reroute outputs
  after we sign.
- **Spend cap.** Sum of our inputs minus everything paid back to our own addresses ≤ the amount on the sheet + the
  quoted network fee + a hard ceiling (e.g. 2,000 sats). Buy: never above `maxBuySats` or the user's typed amount.
- **Minimum back.** Buy: a BSV-21 transfer output to our **ord** address for the token id with amount ≥ `minTokens`.
  Sell: a P2PKH output to our **pay** address ≥ `minSats`. `minTokens`/`minSats` come from our own curve maths with
  the slippage the user chose (default 3%), not from the server.
- **Exact fee outputs.** Platform fee output to `platformAddress` = exactly 1.25% minus the creator share as the
  config describes (round per their curve code), creator/route output = exactly 0.30%, index fee outputs at
  `indexFeePerOutput` × token outputs, capped. Any extra output not to us, the pool, or these addresses → refuse.
  The platform address is pinned in our code; a changed `/config` address refuses until we update deliberately.
- **Token conservation.** Token amounts in = token amounts out for this token id; no other token id touched.
- **Pool output.** The new pool output keeps the token id and carries the pool's change; its amounts match the curve
  step within 1 token / 1 sat.
- **Expiry.** `expiresAt` not passed; re-prepare otherwise.

### Addresses

- **ord**: the account's ordinals (token) address. Bought tokens land here. Sold tokens are spent from here.
- **pay**: the account's BSV address. Buy coins come from here; sell proceeds and change go back here.
- Never a fresh unknown address supplied by the server.

### The approval sheet (one sheet, owner rule)

One card, nothing to untick: "Buy $FROG on Memepool", **You pay** 0.01 BSV ($x), **You get at least** 1,234,567 $FROG,
**Fees** 1.25% (Memepool 0.95% + creator 0.30%) + network ~1 sat, **Price can move** up to 3% (change on the trade
screen), **Pool held by** Memepool (custodial, proof of reserves link). Allow / Cancel.

### Failures

- **409 on prepare or submit** ("another trade landed first"): discard the quote, re-prepare once automatically with
  the same limits; if the new quote breaks the user's minimum, stop and show the new numbers on a fresh sheet (never
  sign silently a second time).
- **400**: show their error code in plain English via `ErrorActions` ("Report to b").
- **429**: back off, "Memepool is busy, try again in a minute".
- **Timeout after submit**: do not retry submit with new signatures; poll the txid; only mark coins spent when seen.
- Nothing is signed after `expiresAt`.

### Risks

- **Custodial pool**: each coin's pool is held by MEMEPOOL's keys. If they disappear, the pool BSV is gone. We show
  that on the sheet and link `/api/proof`; optionally refuse trading a coin whose proof row is not "ok".
- Template-substitution attacks are what the checks above exist for; SIGHASH_ALL is the backstop.
- Memecoins can go to zero; no investment wording.

## 2. TokenBlaster (tokenblaster.lol BlastPad)

Already built in the wallet: `src/mobile/market/launchpad/client.ts` calls `/api/launch/trade` (prepare), wraps the
plan in the wallet's `createAction`, the server signs the pool inputs, then commit. `validate.ts` checks every row
(house fee 0.70% to the pinned `HOUSE_ADDRESS`, route 0.30%, index fee caps, min buy/max buy, slippage). Pools are
custodial (server keys), same risk as Memepool. TokenBlaster is adding `price_sats`, `theme`, `room`, `merch_url`
to `/api/launch/coins`; the Exchange already reads them when present (this PR). No change to trading proposed.

## 3. Files a Memepool build would add or touch

New: `src/mobile/exchange/memepool/trade.ts` (prepare/submit), `memepool/validate.ts` (+ tests), a trade sheet in
`MemepoolMarket.tsx`. Touched: `src/mobile/exchange/memepool.ts` (quote). Signing goes through the existing wallet
signer, not new key code.

`.github/money-paths.txt` today guards keys/backup/restore only; none of these files match. **Recommendation:** add
`^src/mobile/exchange/memepool/` and `^src/mobile/market/launchpad/(client|validate|curve)\.ts$` so trade code needs
the owner's `money-ok` label (editing money-paths.txt itself is guarded too).

## Decisions for the owner

1. Approve native Memepool trading with the checks above (default slippage 3%, cap 20 BSV per trade)?
2. Refuse trading coins whose `/api/proof` row is not healthy?
3. Add the launchpad trade files to money-paths.txt?
