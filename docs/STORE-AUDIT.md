# bWallet store audit (App Store and Google Play)

Status: code-level audit of `bwallet` as at 2 Oct 2026 (branch `feat/store-build`), revised the same day after
`5f7954b` brought back token minting, Market trading and indexing in the store build (see section 3). This is not legal advice.
It reviews the code against the Apple App Store Review Guidelines and the Google Play Developer Program
Policies. Where I am confident of a guideline number I cite it. Where I am not, it is marked **(verify)**.
Store policy changes often, so check the current text before you submit.

"Store build" means the build distributed through the App Store or Google Play. It is produced with
`pnpm build:mobile:store` (`VITE_STORE_BUILD=1`, see `src/mobile/storeBuild.ts`). The default build
(`pnpm build:mobile`, direct download and APK) is unchanged.

Risk: **High** means likely rejection or removal. **Med** means likely reviewer questions or a metadata/form fix.
**Low** means hygiene.

---

## 1. Paying bCorp in crypto to unlock features

Apple 3.1.1 says digital features and content unlocked inside the app must use In-App Purchase. Apps
"may not use their own mechanisms to unlock content or functionality, such as license keys, augmented
reality markers, QR codes, cryptocurrencies and cryptocurrency wallets". Apple 3.1.5(iii) allows a wallet
to _transmit_ crypto, but paying the developer for in-app features is still covered by 3.1.1. Google Play's
Payments policy requires Play Billing for in-app digital goods and services. Its exemptions cover payments
for physical goods and some peer-to-peer cases, but not the developer charging for app features. I believe
there is no general crypto exemption for developer-charged features **(verify the current Play text)**.

| #   | Feature                                                                                                                                                       | Files                                                                                                              | Rule                                                                                                                                                        | Risk                           | Fix (store build)                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | b agent "Pay per message": BSV is sent to a bit-sign quote address for each AI answer                                                                         | `src/mobile/agent/paid.ts`, `agent/AgentPage.tsx`, `settings/AgentSettings.tsx`                                    | Apple 3.1.1; Play Payments                                                                                                                                  | **High**                       | **Done.** Own-key mode only. `parseAgentPrefs` forces `own` mode and the paid backend is replaced, so `/api/bitsign/agent/{price,quote,turn}` is not in the store bundle (checked with grep). Settings shows "Use your own AI provider key". |
| 1.2 | bCredits: BSV top-up (≤ £20) to the bCorp treasury, spent only on b replies                                                                                   | `credits/*` (`CreditsRow.tsx` → lazy `CreditsPanel.tsx`, `useAgentCredits.ts`), Wallet "Credits" tab, `/m/credits` | Apple 3.1.1 (prepaid credits for digital services are IAP territory); Play Payments                                                                         | **High**                       | **Done.** `BCREDITS_ENABLED` (literal env check) drops the card, Top up, history and the Ask b bCredits path from the store bundle; the Credits tab is hidden.                                                                               |
| 1.3 | Mint creation fee (1%) to `BWALLET_MINT_FEE_ADDRESS`                                                                                                          | `mint/mint.ts`                                                                                                     | Apple 3.1.1                                                                                                                                                 | **High** if the address is set | **Done.** The fee address is forced to `''` in the store build.                                                                                                                                                                              |
| 1.4 | Market fee (1%) and ticket resale fee to bCorp                                                                                                                | `market/fee.ts`, `sell/sell.ts`                                                                                    | Apple 3.1.1 / 3.1.5(iii)                                                                                                                                    | **High** if set                | **Done.** The address is forced to `''`. Trading stays on with no bCorp fee (section 3).                                                                                                                                                     |
| 1.5 | Token indexing fee (`indexFund.ts`, `WalletIndexing`, `FinishIndexing`, `indexAutoPay`): sats go to the 1Sat overlay fee address, a third party and not bCorp | `tokens/*`                                                                                                         | Probably acceptable (it's a network/service fee to a third party, like miner fees). But it is a cost to make a token "work" in the app **(judgement call)** | Med                            | **On.** Token minting is back in the store build (`5f7954b`), so indexing is on (`indexingEnabled`). The fee goes to the 1Sat overlay, not bCorp; treat it like a miner fee and say so in the review notes.                                  |
| 1.6 | $name/handle: the paymail `name@bwallet.space` is free. The personal $NAME token and room cost a network fee plus indexing                                    | `names/HandleFlow.tsx`, `names/claimPersonal.ts`                                                                   | The free paymail is fine. The personal token is token-gated access (section 2)                                                                              | Med                            | **Done.** The store build offers only the free paymail. The personal token/room option is hidden.                                                                                                                                            |
| 1.7 | Avatar publish: an on-chain inscription plus a network fee only, with nothing paid to bCorp                                                                   | `names/AvatarPicker.tsx`                                                                                           | Not an IAP issue (miner fee only)                                                                                                                           | Low                            | No change.                                                                                                                                                                                                                                   |
| 1.8 | OpNS name: PoW-mined on the phone, network fee only                                                                                                           | `names/GetYourName.tsx`, `names/opns*.ts`                                                                          | Not an IAP issue                                                                                                                                            | Low                            | No change.                                                                                                                                                                                                                                   |
| 1.9 | Paid inbound calls                                                                                                                                            | `calls/*`                                                                                                          | None found. Calls are free (WebRTC via bit-sign signalling)                                                                                                 | n/a                            | n/a                                                                                                                                                                                                                                          |

**Anti-steering.** The store build just hides these features. It does not say "available on
bwallet.space". Apple's link-out rules differ by storefront: the US has allowed external purchase links
since the 2025 Epic injunction, and the EU uses the DMA entitlement and alternative terms. Outside those
storefronts, 3.1.1 and 3.1.3 still bar buttons, links and calls to action that steer to outside purchasing.
Hiding the features is the only option that is safe in every storefront. If you want a link in the US/EU,
make it a per-storefront decision (open decision D5).

## 2. Token-gated chatrooms and tickets

| #   | Feature                                                                                                   | Files                                                                                            | Rule                                                                                                     | Risk     | Fix                                                                                                                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | Chat › Chatrooms: holding ≥ N of a token admits you to its room ("Hold 1 $FILM to join", "Buy in Market") | `tabs/ChatPage.tsx`, `chat/tokenRooms.ts`, `chat/OpenTokenRoomButton.tsx`, `docs/TOKEN-ROOMS.md` | Apple 3.1.1 (crypto/NFT ownership may not unlock app functionality; NFTs can _display_ owned items only) | **High** | **Done.** Rooms are still listed (the user's holdings) but cannot be opened, joined or started. Each row reads "This room is for token holders. Open it in bWalletX or on bchatx.com." There is no "Buy in Market" button, the invite "Join" is hidden, and the "Room" button on token pages is hidden. DMs are unaffected. |
| 2.2 | Tickets: mint room tickets, Wallet › Tickets tab, Market › Tickets, resale                                | `tickets/*`, `wallet/TicketsSection.tsx`, `market/MarketPage.tsx`                                | Apple 3.1.1; Play blockchain content policy **(verify)**                                                 | **High** | **Done.** The Tickets tab, the Market Tickets filter, and the "Mint a chatroom" choice are hidden.                                                                                                                                                                                                                          |

Alternatives considered: (a) hide Chatrooms entirely, which is clean but leaves Chat with only DMs; (b) let
existing members keep chatting, which is still access unlocked by a token. I chose to list the rooms but
make them non-joinable. That is the least-surprise compliant option. Changing it is open decision D2.

## 3. Market / OrdLock trading: is it an exchange?

`market/MarketPage.tsx` lists 1Sat OrdLock listings from the indexer and buys them with `@1sat/actions`
`buyBsv21` / `buyOrdinal`. `sell/*` creates OrdLock listings. Settlement is non-custodial and atomic on
chain, and bCorp optionally takes a 1% fee.

- Apple 3.1.5(iii) says exchange or trading functionality may be offered only on approved exchanges, and only
  by apps from the exchange itself or an entity with appropriate licensing in every region the app is
  offered **(verify the exact wording)**. A peer-to-peer order-book Market for fungible tokens looks enough
  like crypto trading that a reviewer could treat it as an exchange. bCorp holds no exchange licence. **High.**
- Google Play's Cryptocurrency Exchanges and Software Wallets policy (in force since 2025 in many
  jurisdictions) requires registration or licensing for exchange-like functionality in listed countries.
  Purely non-custodial software wallets are generally excluded, but an in-app marketplace with a fee is
  ambiguous. **High (verify country list).**
- Market › bApps (`SharesPanel.tsx`, `kyc/kyc.ts`) showed bCorp/bApp share offers to investors with
  KYC (Veriff via bit-sign). **Removed 18 Oct 2026:** no offers are bundled; members see only their own bCorp tranches from bit-sign `/bshares/me`, everyone else sees "Members only". The store grep also checks `bcorp-ordinary|Register interest|Interest registered|alphabet-share|Share offers are for verified investors|To be confirmed from the Register of Members`. That is a **securities offering inside the app**, regulated in its own right
  (UK FSMA s21 financial promotion, US securities law). Apple 3.1.5 and 5.1.1(ix) (highly regulated fields)
  and Play's Financial Services policy apply. **High.**

**Precedent.** Non-custodial wallets with in-app swaps are on both stores without exchange licences:
Phantom (Solana; routes swaps through on-chain aggregators such as Jupiter and charges a fee of about
0.85%), the Uniswap wallet, MetaMask, Trust Wallet and Coinbase Wallet. Uniswap Labs holds no exchange
licence; the SEC investigated it in 2024 and closed the case in early 2025. Apple's practice has been to read
3.1.5(iii) as covering apps that _are_ exchanges (custody of customer funds, order matching), not wallets that
let users trade on chain from their own keys **(verify current wording and enforcement before submitting)**.

The OrdLock Market is the same kind of thing: the trade is an atomic swap on chain between two users' own
wallets, bCorp never holds the tokens or the money and does not match orders, and in the store build bCorp
takes no fee (less than Phantom takes).

**Decision (revised 2 Oct 2026): trading on.** Buy, sell and list stay on in the store build
(`marketTradingEnabled`, `5f7954b`) with no bCorp fee (`bcorpFeeAddress`). The bApps (share offers) and Tickets
filters stay hidden. What still applies:

- **Country rules, not Apple's.** UK: since October 2023 the FCA financial promotions regime has required
  crypto promotions to show risk warnings and a cooling-off period for first-time buyers. Some wallets restrict
  swaps in some regions for this. Google Play's Cryptocurrency Exchanges and Software Wallets policy asks for
  registration in listed countries **(verify the country list)**. These depend on where the app is listed.
- **No investment framing.** No "earn" or "returns" wording, and no price-up hype in the app or the store listing.
- **Securities stay out.** Market › bApps (share offers with KYC) is a securities offering, not a token swap, and
  stays hidden. Phantom and Uniswap don't do this either.
- **Review notes** should describe the Market as non-custodial on-chain trading between users and cite the
  wallets above as precedent.

## 4. Personal tokens and NFTs

| #   | Item                                                                              | Files                                            | Rule                                                                                                                                                                                          | Risk                                                                                   | Fix                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | Mint a token (BSV-21) and personal $NAME tokens, which can be traded peer to peer | `tokens/TokenMint.tsx`, `names/claimPersonal.ts` | Apple 3.1.5(iv)? ICO/crypto offerings must come from established, licensed institutions **(verify the clause number)**. Play: no promotion of tokens as investments                           | **High** if marketed as an investment. The copy already says "for access, not trading" | **Token minting on** (no bCorp fee, `mintChoicesFor` = token + media). The personal $NAME token and room stay hidden (`paidFeaturesEnabled`). Keep the "for access, not trading" copy and never market tokens as investments. |
| 4.2 | Mint media (NFT)                                                                  | `mint/MintButton.tsx`, `mint/mint.ts`            | Apple 3.1.1 allows apps to sell NFTs _via IAP_ and to let users view their own NFTs; minting your own content with only a network fee is not a sale by the developer                          | Med                                                                                    | Kept, with no bCorp fee. Reviewer notes should explain it.                                                                                                                                                                    |
| 4.3 | NFT viewing (Wallet › NFTs media library)                                         | `media/*`                                        | Apple 3.1.1 allows viewing. Play's blockchain-based content policy allows it, but tokenised assets must not be marketed as earning opportunities and NFT "loot boxes" are banned **(verify)** | Low                                                                                    | Kept.                                                                                                                                                                                                                         |
| 4.4 | Feed "Lock" (lock BSV behind posts, ranked by "Most locked")                      | `feed/locks.ts`, `feed/FeedPage.tsx`             | The user's own funds are time-locked with no payout, so no gambling element                                                                                                                   | Low                                                                                    | Kept. Explain it in review notes.                                                                                                                                                                                             |

## 5. In-app browser and bApps (Apple 4.7)

`mobile/BrowserPage.tsx`, `mobile/dappBrowser.ts`, `mobile/bapps.ts`, `mobile/radarApps.ts`: there is a
curated directory (Apps tab) of about 150 third-party web apps, opened in an in-app WebView that injects the
wallet provider.

- Apple 4.7 allows HTML5 mini apps. Under 4.7 the developer is responsible for that content meeting the
  guidelines, mini apps must not offer digital goods outside IAP, and 4.7.2/4.7.3 limit extending native
  APIs to that code **(verify the sub-clauses)**. The injected wallet lets third-party pages request
  payments for _their_ digital content. That is arguably 3.1.5(iii)-permitted crypto transmission, but a
  reviewer may see it as non-IAP digital purchases inside the app. **Med-High.**
- Fixes: (a) the curated list must exclude gambling and adult apps (already the stated rule,
  `radarApps.ts:134`); review the entries again before each submission. (b) Add a "Report this app" item in
  the browser menu. (c) Consider hiding the open-any-URL bar in the store build if Apple objects
  (**open decision D4**, not done here so the BrowserPage merge with `feat/bapp-frame` stays easy).
  (d) Index the directory in the review notes.
- The "Buy BSV" group (third-party KYC onramps: onramper, cex.io and others) is commented out in
  `radarApps.ts:147-148` and stays hidden. **Keep it hidden.** On Play, linking to onramps is generally fine,
  but on Apple it is outside 3.1.1's reach (physical/financial) only if the onramp is the merchant **(verify)**.

## 6. User-generated content (Apple 1.2; Play UGC policy)

Apple 1.2 requires: a way to filter objectionable material, a mechanism to report offensive content with
timely responses, the ability to block abusive users, published contact information, and (in practice)
EULA/terms acceptance with zero tolerance for objectionable content. Play's UGC policy is similar.

| Surface      | Report                                                                                                                          | Block                        | Mute   | Filter                                   | Files                                          | Risk                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------ | ---------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Feed         | Yes (`reportItem`, but posts only to `BWALLET_MARKET_REPORT_URL`, which is **empty by default**, so reports stay on the device) | Yes (`addBlock`)             | Yes    | Yes (`market/safety.ts` text/blocklist)  | `feed/FeedPage.tsx`, `feed/store.ts`           | **High** until reports reach a moderated server                                            |
| Market NFTs  | Yes (same local-only report)                                                                                                    | n/a                          | n/a    | Yes (blocklist)                          | `market/safety.ts`, `NftCard.tsx`              | Med                                                                                        |
| Chatrooms    | Yes (room and message, `/api/bitsign/report`)                                                                                   | Yes (author)                 | n/a    | Owners/mods delete messages, close rooms | `tabs/ChatPage.tsx`, `chat/OpenRoomSheets.tsx` | Med (open rooms are in every build, `b9f7260`; token rooms stay hidden in the store build) |
| DMs          | **No**                                                                                                                          | **No** (only delete contact) | **No** | **No**                                   | `chat/DmsPage.tsx`, `chat/ContactViews.tsx`    | **High**                                                                                   |
| Calls        | No                                                                                                                              | Yes (`/wallet-calls/blocks`) | n/a    | n/a                                      | `calls/api.ts`, `CallsList.tsx`                | Med                                                                                        |
| EULA / terms | **None in app** (only the Credits terms line)                                                                                   |                              |        |                                          | `tabs/SettingsHub.tsx`                         | **High**                                                                                   |

Fixes: (1) set `BWALLET_MARKET_REPORT_URL` to a bit-sign moderation endpoint and commit to a 24-hour
response; (2) add Report and Block to DMs (bit-sign needs a block list for bChat DMs); (3) add a
terms/EULA acceptance screen on first run with a zero-tolerance clause, plus a link in Settings; (4) publish a
support contact in the app and on the store listing.

## 7. Account deletion (Apple 5.1.1(v); Google Play account deletion)

The wallet itself is local and non-custodial: "Forgot password" wipe (`forgot/wipe.ts`) deletes it from
the device. But the app **creates server-side accounts**: the paymail `name@bwallet.space`
(pay.bwallet.space), the bChat/bit-sign account (signed in with the identity key), call blocks, KYC
records, and feed posts (on chain, so they cannot be deleted).

- Apple 5.1.1(v) says an app that supports account creation must let users initiate deletion in the app.
  **High.**
- Google requires an in-app deletion path **and** a web link to request deletion in the Data safety form.
  **High.**
- Fix: add Settings › Delete account. It should call bit-sign to delete the paymail, the bChat profile,
  rooms membership and call data, then wipe the local wallet. Add a web page (for example
  bwallet.space/delete) and explain that on-chain data can't be erased.

## 8. Third-party AI (Apple 5.1.2(i); Google AI-generated content)

- b agent own-key mode sends the transcript plus a guide prompt directly from the phone to
  `api.anthropic.com`, `api.openai.com` or `openrouter.ai` (`agent/providers.ts`). The paid mode (not
  in the store build) sends it to bit-sign, which forwards it to its model provider.
- Apple 5.1.2(i) (Nov 2025 update) says you must clearly disclose where personal data is shared with
  third parties, **including third-party AI**, and obtain explicit permission first. There is **no consent
  screen today.** **High.**
- Google's AI-Generated Content policy requires in-app reporting/flagging of offensive AI output for
  apps that generate content with AI **(verify scope; it applies to "AI content generators")**. **Med.**
- Fix: show a first-use consent sheet on the b agent ("Messages you send are processed by <provider>
  under their terms. Don't share your recovery phrase.") with Allow/Cancel, stored per provider. Add a
  "Report reply" action on agent messages. `looksLikeSecret` already blocks seed phrases, which is good.

## 9. Privacy labels and Google Data safety: data collected or sent

| Data                                                                             | Sent to                                                                    | Purpose                 | Linked to user          |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------- | ----------------------- |
| Public keys, addresses, txids, UTXO queries                                      | api.1sat.app, ordinals.gorillapool.io, ordfs.network, api.whatsonchain.com | Wallet function         | Yes (pseudonymous)      |
| Identity key signatures, handle, avatar URL, chat messages, DMs, room membership | www.bitcoinchat.online (bit-sign)                                          | bChat, calls signalling | Yes                     |
| Paymail alias and identity pubkey                                                | pay.bwallet.space                                                          | Paymail                 | Yes                     |
| Feed posts, likes, follows, locks (on chain) and reads                           | bmap-api-production.up.railway.app, on chain                               | Social feed             | Yes (public)            |
| Voice audio (peer to peer WebRTC; TURN/STUN servers via bit-sign **(verify)**)   | Other user                                                                 | Calls                   | Yes                     |
| AI chat transcript                                                               | Anthropic / OpenAI / OpenRouter (own key) or bit-sign (paid)               | b agent                 | Yes                     |
| KYC: ID document and selfie                                                      | Veriff via the bit-sign web flow (`kyc/config.ts`)                         | Identity verification   | Yes                     |
| Exchange rate requests                                                           | whatsonchain / price APIs                                                  | Display                 | No                      |
| Third-party bApps                                                                | Whatever each site collects (in-app browser)                               | n/a                     | Disclose as third-party |
| HandCash (upstream integration)                                                  | cloud.handcash.io                                                          | Optional                | Yes                     |

Apple privacy label: Contact Info (none unless KYC), Identifiers (User ID = identity key), User Content
(messages, audio, photos/avatar, posts), Financial Info (wallet addresses/transactions **(verify whether
Apple counts on-chain data)**), Sensitive Info (KYC). No tracking and no ad SDKs were found. The Data safety
form should mark the same data, with encryption in transit = yes (HTTPS) and deletion = yes once section 7
is built.

## 10. Permissions, usage strings and background modes

Files: `ios/App/App/Info.plist` and `android/app/src/main/AndroidManifest.xml`.

| Item                                                          | Finding                                                                                                                                                                                               | Risk                                 | Fix                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- |
| `NSMicrophoneUsageDescription`                                | Present ("voice calls")                                                                                                                                                                               | Low                                  | OK                                                                                  |
| `NSFaceIDUsageDescription`                                    | Present                                                                                                                                                                                               | Low                                  | OK                                                                                  |
| `NSCameraUsageDescription` / `NSPhotoLibraryUsageDescription` | **Missing.** The avatar and Mint pickers use `<input type=file>`, which can offer "Take Photo". WKWebView needs the camera string or the app crashes when the camera is chosen **(verify on device)** | **Med-High** (crash = 2.1 rejection) | Add `NSCameraUsageDescription` (and `NSPhotoLibraryAddUsageDescription` if saving). |
| `UIBackgroundModes = audio`                                   | Used for calls and music playback (MiniPlayer). Apple 2.5.4 allows audio only for audible content. OK for the player, but reviewers test it                                                           | Med                                  | Keep, and state in the review notes that the music player and calls use it.         |
| VoIP / CallKit / PushKit                                      | **Not used.** Incoming calls ring only while the app is open (polling/socket). This is acceptable. Note that if you add PushKit later, Apple requires CallKit reporting for every VoIP push           | Low                                  | Describe calls accurately in metadata ("while the app is open").                    |
| Push                                                          | Only `@capacitor/local-notifications` (no remote push). Android 13+ needs `POST_NOTIFICATIONS` (merged from the plugin manifest; **verify** in the merged manifest)                                   | Low                                  | OK                                                                                  |
| Android `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `INTERNET`   | Appropriate                                                                                                                                                                                           | Low                                  | Fill in Play's permission declaration only if prompted.                             |

## 11. Export compliance

`ITSAppUsesNonExemptEncryption` is **absent** from Info.plist, so App Store Connect asks on every
upload. The app uses standard crypto: HTTPS, plus ECDSA/AES for wallet keys and message encryption
(BRC-2/78). That generally qualifies for the "standard encryption algorithms" exemption under EAR
5D992 / category 5 part 2 note 4 **(verify with counsel; France may need a declaration)**. **Low-Med.**
Fix: add `ITSAppUsesNonExemptEncryption = false` once the exemption is confirmed. Otherwise upload the
self-classification report.

## 12. Wallet published by an organisation (Apple 3.1.5(i))

Apple 3.1.5(i) says wallet apps may only be offered by developers enrolled as an organisation. bCorp has a
D-U-N-S number (The Bitcoin Corporation Ltd). Enrol as an Organization (not Individual) and publish under
that account. Google requires an organisation account for financial-features apps **(verify)**. The
upload-key certificate CN is "Yours Wallet Mobile (unofficial)" (`scripts/android-release.sh`), which is
fine for signing, but the store developer name must be bCorp. **High until enrolment is done.**

Also check Apple 4.1 (copycats) and 5.2 (IP): the fork is of Yours Wallet (MIT), and the store listing must
not suggest it is the official Yours Wallet. **Med.**

## 13. External purchase of BSV

The "Buy BSV" onramp group stays hidden (`radarApps.ts:147`). In the store build there is no in-app link
to buy BSV with fiat. **Keep it that way.** Re-enable it only after open decision D5. Receiving BSV is fine.

## 14. Gambling

There is no gambling in the wallet code. The bApp directory explicitly skips gambling and adult apps
(`radarApps.ts:134`, `:937`). The Feed "Lock" has no chance element. Zero Dice (a bCorp portfolio company)
is **not** in `bapps.ts`; keep it out of the store build. If it is ever listed, Apple 5.3 and Play's Real-Money
Gambling policy (licence, geo-restriction, and on Apple a free app) apply. **Low.**

## 15. Age rating

The app has user-generated content (feed, DMs, calls), an unrestricted in-app web browser, and crypto. Apple's
2025 questionnaire: "Unrestricted web access" plus UGC usually gives **18+** under the new age tiers (it was
17+ under the old ones) **(verify in App Store Connect)**. On Google Play, IARC with "users interact" and
"shares location: no" usually gives Teen or Mature. Crypto/financial apps commonly declare 18+ in the target audience.
**Med.** Fix: answer the questionnaire honestly and set the Play target audience to 18+.

---

## What the store build changes (`VITE_STORE_BUILD=1`)

All gates are in `src/mobile/storeBuild.ts` (tested in `storeBuild.test.ts`):

- **b agent**: own-key mode only. The mode picker and daily limit are hidden and the note reads "Use your own AI
  provider key". The paid endpoints are never called and are not in the bundle.
- **No paying bCorp**: Credits are shelved in every build (2 Oct 2026; tab, row and Settings note gone); the Mint, Market and ticket-resale fee addresses are
  blank; the personal token and room are hidden. Token minting stays (no bCorp fee), with the third-party
  indexing fee. The free paymail is kept. No "available on the web" text is shown (hidden everywhere, see section 1).
- **Token-gated rooms**: Wallet › Tickets is hidden; Chat lists token rooms but they can't be opened,
  joined or bought into; the "Room" buttons are hidden; "Mint a chatroom" is hidden. Open rooms (no token
  needed) work in every build.
- **Market**: buy, sell and list stay on (non-custodial, no bCorp fee, section 3). The Tickets filter is hidden. bApps is now a
  plain token filter in every build (`market/bappTokens.ts`); the share-offer panel and the Shares chip are gone (2 Oct 2026).
- **Unchanged**: peer-to-peer send/receive, paymail, tips and Feed locks, NFT viewing and media minting
  (with no fee), DMs, calls, the Feed, the Apps browser, and settings.
- **Buy BSV**: stays hidden (it was already hidden in both builds).
- **Pots and standing orders** (7 Oct 2026, `src/mobile/pots/`): pots (labelled sub-accounts: fund, name, cap,
  Stop/Resume) and standing orders to a person or paymail stay on (`potsEnabled`, `standingOrdersEnabled`): P2P
  transfers under 3.1.3(e) / 3.1.5, payee shown as entered. Subscriptions to apps and services (the bChat / $b agent
  payees, and later "Subscribe with bWalletX" requests) are gated by the literal-env `SUBSCRIPTIONS_ENABLED`, so the
  payee data is not in the store bundle; the bWalletX billing subscription is gated by `BILLING_ENABLED` (always
  false in a store build) and is OFF everywhere. `storeBuild.test.ts` checks both ways.
- **Back bWalletX** (10 Oct 2026, `src/mobile/pots/fund.ts`): the monthly development-fund pot and its subscription
  are bWalletX only. Every entry point is behind the literal `SUBSCRIPTIONS_ENABLED`, so it is not in the store
  bundle; the release store-bundle grep includes `Back bWalletX|bwalletx-fund`.

- **Passkey seed backup** (19 Oct 2026, prototype, `src/mobile/passkey/`, docs/SEEDLESS-PASSKEY.md): off in every
  build unless `VITE_SEEDLESS=1`, and forced off in a store build (`SEEDLESS_ENABLED` is a literal env check AND
  `!STORE_BUILD`), so "Restore with a passkey", the blob kind and the /passkey-check page are not in the store
  bundle (store grep). It needs no new privacy label while off; if it ever ships in a store build it adds no data
  collection (the blob stays on the device / in a user-saved file) but would need the native passkey plugin.

Build: `pnpm release:ios-store` / `pnpm release:android-play` (store rules) and `pnpm release:ios-private` /
`pnpm release:android-direct` (everything on), via `scripts/channel-build.sh` and `src/mobile/channel.ts`.
The private channels have their own app IDs (`.private`, `.direct`) and are named "bWalletX". The older
`pnpm build:mobile:store` / `cap:sync:store` still work.
`scripts/android-release.sh` now builds the APK from the default build and the AAB (Play) from the store
build, then restores the default build in `android/` and `ios/` (`5734919`).

## Fixed on `feat/store-fixes` (2 Oct 2026)

Server side is bit-sign PR `feat/store-fixes` (migration `migrations/20261002_store_safety.sql`, applied by hand).
Contact everywhere: support@bwalletx.com.

- **Account deletion (section 7).** Settings › Account & safety › Delete account (`src/mobile/account/`). It lists what is
  deleted and what cannot be (on-chain data; KYC, signed agreements and registers kept by law), asks for the $handle or
  DELETE, then: collects and deletes the paymail (signed `delete` op in `site/lib/paymail.js`), deletes the bChat account
  (bit-sign `POST /api/bitsign/account/delete`, identity-key signature, fresh sign-in), clears local data, and removes the
  account from the phone (the existing account-removal steps, or a full wipe when it is the only account). Web page for
  Google: https://www.bitcoinchat.online/delete-account (still served there, never redirected; the app links https://www.bchatx.com/delete-account).
- **UGC (section 6).** Terms with a zero-tolerance clause (bchatx.com/terms#conduct) must be agreed once before
  Feed, Chat/DMs or Calls (`src/mobile/ugc/`), and are linked in Settings. DMs have Report / Block in the conversation
  header; Feed profiles have Report or block. Blocks hide DMs and messages locally and go to bit-sign
  `/api/bitsign/me/blocks`, which refuses 1:1 messages both ways. Feed/Market reports now default to bit-sign
  `POST /api/bitsign/report` (`content_reports`, rate-limited). **Someone must review `content_reports` daily (24 h).**
- **AI consent (section 8).** Before the first b agent message per provider a sheet names the provider (paid mode:
  bit-sign then Anthropic; own key: the chosen provider), says what is sent (message + last 8 turns + fixed instructions)
  and what is not. Stored per provider; Settings › b agent › Revoke. Agent replies have "Report response".

## Prioritised fix list

1. **Org enrolment** (Apple Organization account under The Bitcoin Corporation Ltd; Play organisation account), 3.1.5(i). _Owner._
2. **Ship only the store build** to the stores (done in this branch). Confirm in review notes that there is no in-app purchase of digital features.
3. **Account deletion** in the app plus a web deletion link (paymail, bChat, calls, KYC). Needs bit-sign endpoints. 5.1.1(v) and Play.
4. **UGC safety**: EULA/terms acceptance; Report and Block in DMs; send Feed/Market reports to a monitored server (`BWALLET_MARKET_REPORT_URL`); a support contact. Apple 1.2.
5. **AI consent sheet** before the first b agent message, naming the provider, plus a "Report reply" action. Apple 5.1.2(i), Play AI content.
6. **Remove or disclose securities**: keep the bApps share offers out of the store build (done); get legal review before any in-app share offer.
7. **Add `NSCameraUsageDescription`** (and test the camera path), and **`ITSAppUsesNonExemptEncryption`** after the exemption is confirmed.
8. **Privacy label and Data safety** forms from section 9; update `PRIVACY_POLICY.md` for bit-sign, paymail, AI providers and Veriff.
9. **bApp directory review** before each submission (no gambling, adult or exchange apps); add "Report this app" in the browser.
10. **Age rating** 18+ and accurate call/background-audio descriptions in the review notes.

## Open decisions for the owner

- **D1** Market in the store build: **view-only since 3 Oct 2026.** Build 8 was rejected under 3.1.5(iii); buy / sell / list stay in bWalletX only.
- **D2** Token rooms: listed but non-joinable (chosen), or hidden entirely, or allowed for NFT-only "display" rooms?
- **D3** Media (NFT) minting in the store build: kept with no fee. Keep it?
- **D4** In-app browser in the store build: keep the free URL bar, or allow the curated directory only? (Left alone so `feat/bapp-frame` merges cleanly.)
- **D5** US/EU link-outs to bwallet.space for Credits, paid agent and names, and the Buy BSV onramps: per-storefront, after legal review.
- **D6** The 1Sat indexing fee on store builds: token minting is back, so the fee is on. Treated as a third-party network fee; explain it in the review notes.

## Free Spaces in the store edition (10 Oct 2026)

The owner approved free Spaces in bWallet. `FREE_SPACES_ENABLED` and `roomSpacesAllowed()` in `src/mobile/storeBuild.ts`:

- **Allowed in the store build:** the bWallet Lounge and other open (non-token) rooms show their Space banner. Users can listen, ask to speak, speak and chat. Nothing is bought, sold or unlocked by holding a token.
- **Still bWalletX only (`BSPACES_ENABLED`):** Spaces in token rooms, the Spaces home and its tile, New Space, and paid entry ("Pay at the door", tickets). DoorKeeper and NewSpaceSheet are lazy chunks behind the inlined flag, so the store bundle contains none of their text. The store grep now also checks `Listeners pay|Pay at the door`.
- **Moderation (Apple 1.2 / Play UGC):** in a Space anyone can report or block another person (person menu) or a chat message (flag on each message); blocked people's messages are hidden. Hosts and moderators keep mute, move to audience and remove. A "Community rules" link sits under the Space chat. The Chat tab, where Spaces open, is already behind the terms gate (`TermsGate`).
- **Android background audio:** `SpaceSessionService` (FOREGROUND_SERVICE_MEDIA_PLAYBACK + FOREGROUND_SERVICE_MICROPHONE) starts when a user joins a Space and stops when they leave, with an ongoing notification and a Leave button. This is what the Play foreground-service declaration describes.

**Open question, Google Play (not decided):** Play's policies are looser than Apple 3.1.1 on blockchain tokens, and holding a token you already own to enter a room may be allowed there. Token-gated rooms stay off in the Play build too until someone checks the current Play policy wording (Blockchain-based content / tokenized digital assets) and the owner decides.

- **Paid listening (11 Oct 2026, bWalletX only, `PAID_LISTENING_ENABLED`):** per-minute paid listening in Spaces (BSV or BSV-21, paid to speakers / issuer / burned). `PaidListening.tsx` is a lazy chunk behind the inlined flag, so the store bundle has none of it. The store grep also checks `Paid listening|space-listen`.
- **Pay-per-second streaming (12 Oct 2026, bWalletX only, `PAY_STREAM_ENABLED`):** the bMusic FIRST 12 album on Media (one budget approval, then one payment per second from a session key). `stream/StreamAlbum.tsx` is a lazy chunk behind the inlined flag and the session sweeper is a lazy import behind it in `NotifyEngine.tsx`, so the store bundle has none of it. The store grep should also check `Listening budget|bmusic session|stream/payto`.
- **Exchange (12 Oct 2026, bWalletX only, `MARKET_ENABLED` / `SWAP_ENABLED`):** the Market became the Exchange (`/exchange`, `/exchange/swap`, `/exchange/<token>`, My orders, Collectibles). `exchange/ExchangePage.tsx` is the lazy route chunk behind `MARKET_ENABLED` and the embedded Swap is a lazy chunk behind `SWAP_ENABLED`, so the store bundle has none of it. The store grep also checks `Buy at best price|bwallet.exchange.favs`.
- **Exchange categories (12 Oct 2026):** categories, platforms and tags (`exchange/Categories.tsx`, `exchange/registry/`) are only imported by the Exchange chunk, so the store bundle has none of it. The store grep should also check `bsv-tokens.json|bsv tokens manifest`.
- **Exchange swipe rows (15 Oct 2026):** Chat · Buy · Info on Exchange token rows (`exchange/TokenRowActions.tsx`, `useTokenRowActions.tsx`, `rowActions.ts`) are only imported by the Exchange chunk, so the store bundle has none of it. The store grep also checks `Hold some to enter`.
- **Exchange swipe rows, other lists (15 Oct 2026):** People (Chat · Pay · Profile), OpNS names (Buy · Info), Podcasts (Play · Buy · Info) and Movies (Back · Own a clip · Chat when held) reuse the same SwipeRow actions; all live in Exchange-only files (`PeopleMarket.tsx`, `OpnsMarket.tsx`, `PodcastMarket.tsx`, `MoviesMarket.tsx`), so the store bundle has none of it. The store grep also checks `Swipe a row (or long-press) for Chat, Pay and Profile|Own a clip`.
- **Theme Store (16 Oct 2026, `/m/store`, `THEME_STORE_PAID_ENABLED`):** store builds show Free themes only (owner). Premium (prices, "Coming soon"), Holders (token-gated unlocks) and Editions (the $99 order link) live in `themeStore/PaidTabs.tsx`, a lazy chunk behind the inlined flag, so the store bundle has none of it. The store grep also checks `paid to the creator|Unlocks for|Token themes unlock|Live editions listed here`.
- **bStore (16 Oct 2026, `/m/store`, docs/BSTORE.md):** the Theme Store became bStore. Store builds show free Themes only, with no section tiles. Subscriptions, Credits, Stickers & emoji, Services and Community (third-party listings, Sell something) live in `themeStore/Sections.tsx`, a lazy chunk behind the same inlined `THEME_STORE_PAID_ENABLED`, so the store bundle has none of it. The store grep also checks `Sell something|Selling opens soon|Seller gets|Room membership|Creator fan club`.
- **Business agent account (16 Oct 2026, bWalletX only, `BIZ_AGENT_ACCOUNT_ENABLED`):** a capped account derived from the owner's seed that a room's business agent pays refunds from, with a daily limit, today's spend, a Stop button and an activity list (`agents/business/`). It moves money without a per-payment approval, so `BizAgentAccount.tsx` is a lazy chunk behind the inlined flag and the store bundle has none of it. The store grep also checks `STOP agent spending|Refund from agent account|bwalletx business agent|bwallet.bizAgent`.
- **Onboarding funnel (12 Oct 2026, bWalletX only, `PAY_STREAM_ENABLED`):** `src/mobile/onboarding/funnel/*` (taste free → create wallet → sponsored → add funds → buy) is only imported from the guest bMusic pages and `StreamAlbum`, both lazy chunks behind `PAY_STREAM_ENABLED`, so the store bundle has none of it. The store grep also checks `Takes 20 seconds|bwx.funnel|Hear tracks 2|Add a little BSV`.
- **Artist programme and fee pot (12 Oct 2026, bWalletX only, off by default):** `ARTIST_PROGRAMME_ENABLED` / `FEE_POT_ENABLED` (storeBuild.ts) are literal env checks that are false in every store build, so `media/artists/programme/*`, the Lock screen's `?artist=` backing and `feePot/client.ts` are dropped. The store grep also checks `Join as an artist|Back this artist|sponsored by bWalletX|bmusic artist|bwx-feepot|api/feepot`.
- **bMint Notes (13 Oct 2026, bWalletX only, `BMINT_NOTES_ENABLED`):** the banknote/coin designer at `/bmint/notes` (`src/mobile/bmint/notes/*`, its fonts and the 11 note template images) is a lazy chunk behind the inlined flag, so the store bundle has none of it; a designed banknote, even minted as art, reads as issuing currency (Apple 3.1.5, Play financial services). The `/bmint` shell itself stays and shows the other tools. Notes are owner only (13 Oct 2026): the studio needs an identity on `VITE_BMINT_STUDIO_KEYS` (empty by default) and has no mint button; everyone else sees a showcase (`notes/NotesShowcase.tsx`, also behind the flag). The store grep also checks `bwx-bmint-notes|Banknote designer|bwx-bmint-showcase`.
- **Launch your own coin (14 Oct 2026, bWalletX only, `MARKET_ENABLED`):** the in-app launchpad (`exchange/launch/*`, `/m/exchange/launchpad/new`: name, ticker, 1B supply, icon, one approval sheet, flat launch fee) is only imported by the Exchange chunk, so the store bundle has none of it, and a store build has no fee address anyway. Holders' room at launch, advanced options (decimals, room entry, category, links as an on-chain MAP card, optional indexing fund) and the "Launched in bWalletX" board (local launches + `/api/bitsign/launches`, whose client lives in the Exchange chunk) are in the same chunk. The store grep also checks `Launch your own coin|Launch this coin|Launch fee \(flat\)|launchpad/new|Launched in bWalletX|bwallet.launches|api/bitsign/launches`.
- **bShares, the bCorp share placement (14 Oct 2026, bWalletX only, `PLACEMENT_ENABLED`):** the restricted `/m/bshares` bApp (`placement/BsharesPage.tsx`), the Lock page Vault (`placement/VaultSection.tsx`) and the Exchange "Shares" filter (`placement/SharesMarket.tsx`) are lazy chunks behind the inlined flag, and the bApps shelf entry sits behind a literal env check in `bapps.ts`, so the store bundle has none of it. Securities never ship in a store build (docs/BCORP-PLACEMENT.md). The store grep also checks `bShares|BsharesPage|VaultSection|SharesMarket|Restricted · not offered publicly|Restricted · members only|locked 2-of-2|bshares lock|api/bitsign/bshares|for registered shareholders|Become a registered investor|Couldn.t load your share registers`.
- **bCredits (15 Oct 2026, bWalletX only, `BCREDITS_ENABLED`):** the bCredits card, BSV Top up (one approval, deposit reference in an OP_RETURN), history and Ask b paid from bCredits. `credits/CreditsPanel.tsx` is a lazy chunk behind the inlined flag and Ask b picks `useAgentCredits` by the same flag, so the store bundle has none of it. The store grep also checks `Top-ups pay for b|bwallet.credits.pending|bwx:bcredits|insufficient_credits|Not enough bCredits|bCredits history|Top up bCredits|bCredits — pay for b|Prepaid credits, one line per type`. The card is now titled "Credits" (16 Oct 2026) and lists credit types as lines (`creditLines()` in `credits.ts`); bCredits is the first line. (The bApp icon registry's "bCredits" label in `bappFrame` predates this and is only an icon name.)
- **Emoji themes (18 Oct 2026, bWalletX only, `THEME_STORE_PAID_ENABLED`):** twelve $1 Store themes with Twemoji card art (`theme/emojiThemes.ts`). They are paid editions (`PAID_EDITIONS`), so like VexVoid/NPG/NPGX the packs' colours and card art are bundled but never offered in a store build: the Store page that sells them is the lazy bWalletX-only chunk, the Theme sheet lists editions only behind the flag, and `?theme=` / theme links refuse paid ids. The store grep also checks `Twelve emoji looks`.
- **Partnership shares setup, agreement, admit, pay (18 Oct 2026, bWalletX only, `PLACEMENT_ENABLED`):** `placement/partnership/PartnershipAgreement.tsx` + `partnership.ts` render only inside the lazy Vault chunk (VaultSection → PartnershipShares), so the store bundle has none of it. The store grep also checks `Set up a partnership|Ask b to draft the agreement|Pay the partnership|bwx-partnership|Sign with my wallet`.
- **Balance cards (15 Oct 2026, bWalletX only, `BALANCE_CARDS_ENABLED`):** the swipe carousel of real balances (BSV, bCredits, MNEE, bShares for register members), the All cards browser and their CSS (`wallet/BalanceCarousel.tsx`, `balanceCards.css`) are a lazy chunk behind the inlined flag, so the store bundle has none of it. No mock money: every card opens the real screen for that balance. Token-row swipes (Send / Receive / Chat, Pin / Lock / Archive) are in every build; none of them trades. The store grep also checks `bwCardLayer|bw-bcar-`.
- **bMail › Agreements (was the Bureau; 18 Oct 2026, bWalletX only, `BUREAU_ENABLED`):** agreements over bMail (`/m/bmail/agreements`, `/m/bureau` redirects; `src/mobile/bureau/*`: send a document by bMail, sign with the card signature + identity key, seal a hashes-only receipt on chain, pdf.js preview), the bMail Agreements box (`AgreementsBox.tsx`), and the one-time "Import from bit-sign" view (Settings › Tools, `BitSignImportPage.tsx`). All three are lazy chunks behind the inlined flag (the Settings card and bMail box render `BUREAU_ENABLED && …`), so the store bundle has none of it (bMail itself only carries the opaque `agreement` field). The store grep also checks `Review & sign|bwallet.bureau|Seal on chain|Import from bit-sign|bwallet agreement|Needs my signature`.
- **Pots in PNEEs (18 Oct 2026, bWalletX only, `PNEE_POTS_ENABLED`):** a pot can hold PNEEs and pay standing orders in them (PR 128). The "Pays in" switch, the PNEE balance / top-up copy, the PNEE signing and overlay submit in the pots engine are behind the inlined flag, and a store build treats every pot as a BSV pot, so the store bundle has none of it. The store grep also checks `\$1 is always \$1|Held in PNEEs|PNEEs are dollar tokens|Send PNEEs to this address|from a PNEE pot in PNEEs|This pot pays in PNEEs|PNEE orders need a PNEE pot|PNEEs \(\$\)`.
- **Direct APK updater (15 Oct 2026, Android direct only, `DIRECT_UPDATE_ENABLED`):** Settings › About "Check for updates" / "Update to X.Y.Z" and the once-per-version launch banner (`update/`), which download the APK from bwalletx.com (https only), check its SHA-256 against `/download/latest.json` and hand it to the Android installer. A store app may not install code from outside its store (Apple 2.5.2, Play Device and Network Abuse), so the flag is a literal `VITE_CHANNEL === 'android-direct'` check: the chunk is absent from Play, iOS, dev and extension builds. Natively, `ApkUpdatePlugin.java` and `REQUEST_INSTALL_PACKAGES` live in `android/app/src/direct/` only, so the Play AAB has neither. The store grep also checks `ApkUpdate|bwalletx.com/download/latest.json|Check for updates|Install unknown apps|bwallet.update.bannerSeen`.
- **bCal and All cards swipes (15 Oct 2026, bWalletX only, `BALANCE_CARDS_ENABLED`):** `wallet/BCal.tsx`, `bcalDays.ts` and `bcal.css` (a month of real buys/sells and podcast line-ups) are only imported by the BalanceCarousel lazy chunk, so the store bundle has none of it. The store grep also checks `bw-bcal`.
- **All cards button and browser doors (15 Oct 2026, bWalletX only, `BALANCE_CARDS_ENABLED` / `SWAP_ENABLED`):** the Wallet's icon-only "All cards" button (Layers icon, as wide as the price cell above) sits left of the Swap card, which takes the rest of the row (`wallet/allCardsOpen.ts`); in `BuyBsv.tsx` it is `() => null` in a store build, and the store has no Swap either, so the store Wallet has no row at all (unchanged). The browser's Address book / Calendar buttons (`bw-tm-doors`) live in the BalanceCarousel lazy chunk. The store grep also checks `open-all-cards|bw-tm-doors`.
- **Feed › bMovies (14 Oct 2026, bWalletX only, `BMOVIES_FEED_ENABLED`):** the full-screen bmovies.app clip reel (`src/mobile/feed/bmovies/*`, clips are tokenised pitches with "Tokenise this" offers) is a lazy chunk behind the inlined flag and its Feed picker entry is data behind the same flag, so the store bundle has none of it and the store Feed picker shows Following, For you and bNews only. The store grep also checks `api/feed?cursor|tweet-video|tweet-result|Open bmovies.app|bitsign/bmovies`. The bMusic reel (bmovies.app `?skin=bmusic`) and bNews › Video (`?skin=gmehl`) reuse the same lazy chunks (`feed/bmovies/videoSources.ts`, `NewsVideos.tsx`), so the store bundle also has no `skin=bmusic|skin=gmehl`; store bMusic keeps albums + bChatX posts.
- **Feed › bMovies REGISTER (15 Oct 2026, bWalletX only):** the claim flow (`feed/bmovies/claim.ts`, `RegisterSheet.tsx`: X sign-in proof, BSV-21 deploy from the wallet, bit-sign `/api/bitsign/bmovies/claim(s)`) lives in the same lazy bMovies chunk, so store builds have none of it; the store grep includes `bitsign/bmovies`.
- **Feed › bApps and bExchange reels (15 Oct 2026):** the Feed row is Home, then **bApps** (`feed/reels/BappsReel.tsx`: one full-screen card per bApps store app with a sandboxed, non-interactive live preview on the visible card only, Open in the restricted bApp frame, Comment on bChatX, Tip the builder (P2P, every build), Contribute for open-source apps, Report). bApps is in every build; its **Tokenise** button (builder only, opens the Launchpad prefilled) sits behind `MARKET_ENABLED`, so a store build has no route or button for it. **bExchange** (`feed/reels/BexReel.tsx`: one card per BSV-21 token with price, 24h change, sparkline, BUY / SELL to the token's Exchange page) is bWalletX only (`BEX_REEL_ENABLED`): a lazy chunk behind the inlined flag, with its Feed picker entry as data behind the same flag, so the store bundle has none of it. De minimis rule (owner, 15 Oct 2026): neutral user-chosen sorts only (New, 24h change, 24h volume, holders, A–Z), no Pumping / Hot / Trending labels, no featured or paid placement, no price push notifications, and the risk line on every card. The store grep also checks `Advert made by the creator|Tokens can lose all their value|Every token, one card each`.
- **Launchpad disclaimer (15 Oct 2026, bWalletX only, `MARKET_ENABLED`):** every coin launched in bWalletX carries "No returns, dividends or price rises are promised. There is no promise the money will be spent on the project, that it will succeed, or that it will become a company." in its on-chain MAP card (`disclaimer` field), on the launch form, the approval sheet, the done screen and its Exchange page. All of it is in the Exchange chunk.
- **Creator vesting at launch (18 Oct 2026, bWalletX only, `MARKET_ENABLED`):** the launch form's "Keep for yourself" slider (0–20%, default 10%; 12-month cliff then 24 monthly unlocks, at least 6 months), the vesting transaction (BSV-21 transfers on 1Sat Lock outputs to a seed-derived key, plus a MAP `creator-vesting` receipt), the token page's "Creator vesting" receipt and Claim (`exchange/launch/vesting*.ts`, `VestingSection.tsx`) are only imported by the Exchange chunk, so the store bundle has none of it. The store grep also checks `Keep for yourself|creator-vesting|Creator vesting`.
- **Feed › bApp feeds (14 Oct 2026):** the Feed row scrolls through bApp feeds; every bApp without a custom view shows its bChatX brand account's public posts (`src/mobile/feed/bchatxFeed.ts`, `GET www.bchatx.com/api/feed/author/<slug>`). Adult-leaning brands (`cherryx`, `aigf`) are excluded from the list in every build (never listed, so the strings are not in the bundle; tested in storeBuild.test.ts); bMovies stays bWalletX only.
- **bRadio Spaces, phase 1 (15 Oct 2026):** Exchange › Podcasts (`exchange/PodcastMarket.tsx`, podcast NFT buy with one approval) lives only in the Exchange chunk (`MARKET_ENABLED`), and the Feed › bRadio Buy button is behind the same inlined flag, so a store build cannot buy podcasts. Home's "Live now" Spaces row (`bradio/LiveSpacesBar.tsx`, GET `/api/bitsign/spaces/live`) is a lazy chunk behind `BSPACES_ENABLED`; `space_live` pushes open the Space through the same app-link path, which a store build drops. Paid listening and space-listen stay gated as before. Feed › bRadio podcast previews and playing podcast NFTs you already hold stay on (viewing NFTs). The store grep also checks `Buy this podcast|Exchange · Podcasts|spaces/live`.

- **Exchange › Names categories (15 Oct 2026):** the First names / Cool words / Brands / Short / Tickers chips, tier labels and the buyer-terms line live in `exchange/OpnsMarket.tsx` and `names/market/` (Exchange chunk, `MARKET_ENABLED`), so a store build never sells names. The store grep also checks `Cool words & handles|Names are sold as on-chain text`.
- **Exchange › Movies (15 Oct 2026):** bMovies Originals only (our own productions, no source tweet), each with its movie token (BSV-21, keyed on token ID; buying opens the movie's room) and its clip NFTs (1Sat OrdLock, play in the media player). `exchange/MoviesMarket.tsx` and `exchange/movies.ts` (GET `https://www.bmovies.app/api/originals`) are only imported by the Exchange chunk (`MARKET_ENABLED`), so a store build has none of it. Until bmovies.app ships that endpoint the tab shows an honest empty state. The store grep also checks `api/originals|Back this movie|Own a clip|Exchange · Movies|bMovies Originals`.

- **Room X invites (15 Oct 2026, bWalletX only, `XINVITES_ENABLED`):** a room host's Invites sheet (`chat/XInvitesSheet.tsx`: one transaction sends the gate token plus sats to a fresh one-time key per @handle, links carry the key in the fragment) and the invitee's claim screen (`chat/XInviteClaim.tsx`: verify X, sweep the key) are lazy chunks behind the inlined flag; link routing in `spaces/inviteLinks.ts` and `scan/ScanSheet.tsx` sits behind the same flag. Token transfers that admit someone to a token room (2.1), so never in a store build. The store grep also checks `x-invites|Whoever opens this link|bwx.xinvites`.
- **Sign in with HandCash (15 Oct 2026, bWalletX only, `HANDCASH_SIGNIN_ENABLED`):** "Sign in with HandCash" beside Continue with X / Google (Create Account, Settings › Connect), "Claim name@bwalletx.com · First claim on your HandCash name", and Address book › Import "Bring in my HandCash friends". Same treatment as X (`socialLoginEnabled`): a third-party login for the account with no Sign in with Apple beside it is an Apple 4.8 risk, and HandCash is a competing wallet brand. The flag is a literal env check, so the store bundle has none of it. The store grep also checks `Sign in with HandCash|handcash-friends|auth/native/exchange|Bring in my HandCash|First claim on your HandCash`.
- **Airdrop to holders (16 Oct 2026, bWalletX only, `HOLDER_DROP_ENABLED`):** token page › Issuer tools › "Airdrop to holders" (`holderDrop/HolderDropSheet.tsx`, pure logic in `holderDrop/holderDrop.ts`): snapshot a BSV-21 token's holders (GorillaPool holders API, keyed on token ID), send a fixed or pro-rata amount of the token, another BSV-21 you hold, or BSV (always carrying the bWalletX airdrop marker so it shows in the holders' inbox), one approval sheet for the whole drop then one transaction per batch, resumable with a per-drop ledger of paid addresses so nobody is paid twice, CSV receipt. Rewarding a token's holders is token-gated value (section 2), so the sheet is a lazy chunk behind the inlined flag and the entry row sits behind the same flag. The store grep also checks `Airdrop to holders|bwx.holderdrop`.
- **bPositive (16 Oct 2026, bWalletX only, `BPOSITIVE_ENABLED`):** journeys with three witnesses, daily check-ins and pledges between friends (`bpositive/`, bit-sign `/api/bitsign/bpositive/*`, PR #299). Pledges are signed promises; no money moves. The site page says "Not in the store edition", so the page is a lazy chunk behind the inlined flag and its Apps tile sits behind the same literal env check. 18+ confirmation, Report and Block on every journey you don't own. The store grep also checks `bitsign/bpositive|A promise, no money moves`.
- **Scammers Cartel theme (18 Oct 2026, bWalletX only, `THEME_STORE_PAID_ENABLED`):** a $1 edition for the ScammersCartel community (scammerscartel.com), yellow/orange glow on black with the community's own DJ raccoon art. It is in `PAID_EDITIONS`, so like VexVoid/NPG/NPGX it is bundled but only sold from the lazy bWalletX-only Store chunk; store builds never offer it.
- **Greeting cards and AI pictures (23 Oct 2026, bWalletX only, `GREETING_CARDS_ENABLED`, `SPICY_ENABLED`):** Mint › "Greeting card or AI picture" pays bCorp in BSV (the push server's quote, `/v1/cards/*`) for an AI image, then hands it to the normal Picture mint. Paying bCorp for a digital good is Apple 3.1.1 / Play Payments, so `cards/CardMaker.tsx` and `cards/CardSend.tsx` are lazy chunks behind the inlined flag and the Mint tile is behind it too. The optional Spicy (18+) model option is behind `SPICY_ENABLED` as well (and on web needs the user's "Show 18+ options" switch). The store grep also checks `Greeting card or AI picture|v1/cards/|Cards are coming soon|Spicy (18+)|18 or over|bwx.adult18|bwx.cards.18ok|Show 18+ options`.
- **bAds (23 Oct 2026, bWalletX only, `GREETING_CARDS_ENABLED`):** Mint › "Order a bAd" (`/m/bmint/mint/ad`, linked from bwalletx.com/bads) is the Advert tab of the same `cards/CardMaker.tsx` lazy chunk: business, what to sell, optional audience/style/colours, a format (square / story / banner), the server's price before paying, the same one-sheet BSV payment to bCorp, then Mint it or Download. The Mint tile is data behind the same flag, so the store bundle has none of it. The store grep also checks `Order a bAd|b makes your advert|Adverts are coming soon|Describe your business, b makes the ad`.
- **TokenBlaster shop (25 Oct 2026, bWalletX only, `TOKENBLASTER_ENABLED`):** the TokenBlaster shop in the Store (two $1 theme packs, TokenBlaster and Assault on Terrornode, with Play / Launchpad links to tokenblaster.lol and Merch / Terrornode ammo shown as coming). The packs, shop, links and card art live in `theme/tokenblasterX.ts` (packs) and `theme/tokenblasterShopX.ts` (shop and art), which a store build swaps for the empty `.store.ts` stand-ins (vite.config.mobile.ts), so the store bundle has none of it, art included. The store grep already checks `TokenBlaster`.
- **Get your own theme (16 Oct 2026, bWalletX only, `THEME_ORDERS_ENABLED`):** Settings › Appearance › "Get your own edition" and the link on the Theme page order a custom theme edition ($99 a year, paid in BSV to bCorp through one approval sheet; `themeOrder/*`, server `site/api/theme-orders.js`). Paying bCorp for a digital good is Apple 3.1.1 / Play Payments, so `ThemeOrderSheet.tsx` is a lazy chunk behind the inlined flag and the Settings row and Theme link are behind it too: the store bundle has none of it. The store grep also checks `Get your own edition|api/theme-orders|bwx-theme-order`.
- **Link your accounts (18 Oct 2026, bWalletX only, `LINK_ACCOUNTS_ENABLED`):** the onboarding "Claim your name" › "Link your accounts" step and Settings › Identity › Link your accounts (`social/LinkAccounts.tsx`, `LinkAccountsStep.tsx`, `links.ts`): X / Google / GitHub / LinkedIn rows and the Link HandCash card, each link signed by the wallet's identity key. Same treatment as Continue with X (Apple 4.8 still unsettled), and every use sits behind the inlined flag, so the store bundle has none of it. Create Account no longer shows Continue with X / Google in any build. The store grep also checks `Link your accounts|Link HandCash|api/social/providers`.

- **Space transcription with consent (18 Oct 2026, `TRANSCRIPTION_ENABLED`):** the host's mode switch (New Space + in-Space "Transcription:" picker), the speak-consent tick ("Speak, transcribed" / "Don't transcribe me"), "Stop transcribing me" and the transcript view (`spaces/TranscriptSheet.tsx`, a lazy chunk) are bWalletX only. A store build still shows the "Transcribing" badge, the green-room and in-Space listen notice, and the "(not transcribed)" labels, because they are disclosure. It never offers the tick, so bit-sign never records or transcribes a store user (no speak consent = no track). Opening this to store builds needs the Apple privacy label and Play Data safety form to declare audio collection first. That is an owner decision. The store grep also checks `transcription_set|Stop transcribing me|Delete my line|Transcription: |Speak, transcribed`.

## Release store-bundle grep (all gated strings)

Run right after `pnpm build:mobile:store`; it must print nothing. It collects every "store grep" string above (bShares included); add new ones here too.

```sh
grep -rlE "/api/bitsign/agent/(price|quote|turn)|Subscribe with|TokenBlaster|launch/new|bSpaces|BPOSITIVE|Holders can enter|Back bWalletX|bwalletx-fund|Listeners pay|Pay at the door|Paid listening|space-listen|Back PNEEs|PNEE vault|pnee vault|bwxburn|api/pnee|Lock BSV to back PNEEs|Listening budget|bmusic session|stream/payto|1 sat/sec|Add a release|Buy at best price|bwallet.exchange.favs|Takes 20 seconds|bwx.funnel|Hear tracks 2|Add a little BSV|Join as an artist|Back this artist|sponsored by bWalletX|bmusic artist|bwx-feepot|api/feepot|bsv-tokens.json|bsv tokens manifest|people-tokens|Buy & chat|bwx-bmint-notes|Banknote designer|bwx-bmint-showcase|Launch your own coin|Launch this coin|Launch fee \(flat\)|launchpad/new|Launched in bWalletX|bwallet.launches|api/bitsign/launches|bShares|BsharesPage|VaultSection|SharesMarket|Restricted · not offered publicly|Restricted · members only|locked 2-of-2|bshares lock|api/bitsign/bshares|for registered shareholders|Become a registered investor|Couldn.t load your share registers|Top-ups pay for b|bwallet.credits.pending|bwx:bcredits|insufficient_credits|Not enough bCredits|bCredits history|Top up bCredits|bCredits — pay for b|Prepaid credits, one line per type|api/feed\?cursor|tweet-video|tweet-result|Open bmovies.app|bitsign/bmovies|Advert made by the creator|Tokens can lose all their value|Every token, one card each|Buy this podcast|Exchange · Podcasts|spaces/live|bwCardLayer|bw-bcar-|bw-bc-back|bcredits-contract|BCORP-BCREDITS|credits-sheet|Active on 1sat.market|bex:activity|Cool words & handles|Names are sold as on-chain text|Hold some to enter|ApkUpdate|bwalletx.com/download/latest.json|Check for updates|Install unknown apps|bwallet.update.bannerSeen|x-invites|Whoever opens this link|bwx.xinvites|Sign in with HandCash|handcash-friends|auth/native/exchange|Bring in my HandCash|First claim on your HandCash|Airdrop to holders|bwx.holderdrop|bitsign/bpositive|A promise, no money moves|Get your own edition|api/theme-orders|bwx-theme-order|paid to the creator|Unlocks for|Token themes unlock|Live editions listed here|STOP agent spending|Refund from agent account|bwalletx business agent|bwallet.bizAgent|Set up a partnership|Ask b to draft the agreement|Pay the partnership|bwx-partnership|Sign with my wallet|Keep for yourself|creator-vesting|Creator vesting|transcription_set|Stop transcribing me|Delete my line|Transcription: |Speak, transcribed|Link your accounts|Link HandCash|api/social/providers|Review & sign|bwallet.bureau|Seal on chain|Import from bit-sign|bwallet agreement|Needs my signature|BWX_SUBSCRIBE|bwx-subscribe-v1|bwxSubscribe|\$1 is always \$1|Held in PNEEs|PNEEs are dollar tokens|Send PNEEs to this address|from a PNEE pot in PNEEs|This pot pays in PNEEs|PNEE orders need a PNEE pot|PNEEs \(\$\)|Restore with a passkey|Continue with a passkey|Unlock with passkey|Add a passkey to this wallet|Continue with HandCash|Already saved. You don|Put this wallet on your phone|Your phone has it|bwalletx-restored-v1|Scan to open on computer|bwalletx-open-v1|passkey-backups|bwx:handcash-web|bwalletx-passkey-seed-backup|Passkey PRF check|Greeting card or AI picture|v1/cards/|Cards are coming soon|Spicy \(18\+\)|18 or over|bwx\.adult18|bwx\.cards\.18ok|Show 18\+ options|Order a bAd|b makes your advert|Adverts are coming soon|Describe your business, b makes the ad|No envelopes yet|Could not close the envelope|No envelope|Envelope amount|Envelopes shows what is left|ENVELOPES_LIST|ENVELOPE_COIN_RETURN|bwx-site-room-balance" build-mobile/
```

- **Envelopes and the game room balance card (25 Oct 2026, bWalletX only, `ENVELOPES_ENABLED` / `!STORE_BUILD`):** store builds leave out envelopes (#87) and streaming payments. Settings › Envelopes, the envelope request sheet, the envelope offer on pay sheets, the envelope rows in Permissions and History › Connections, and the background `ENVELOPES_LIST` / `ENVELOPE_COIN_RETURN` handlers are behind the inlined flag, so the store bundle has none of them. A site's `requestSpendingAuthorization` is refused as "Not supported" (never approved) and every payment shows its sheet. The connected game's room balance card (`SiteRoomBalance`, #101) renders only outside a store build, like `SiteRoomChip`. The store grep also checks `No envelopes yet|Could not close the envelope|No envelope|Envelope amount|Envelopes shows what is left|ENVELOPES_LIST|ENVELOPE_COIN_RETURN|bwx-site-room-balance`.

- **Home modules (18 Oct 2026):** the wallet home is a set of modules the user adds, removes and reorders (`src/mobile/home/`). Each module says whether it may show in a store build. The Store showcase (themes, emoji packs, the album, OpNS names, Spaces) is paid content and is a lazy chunk behind the inlined `THEME_STORE_PAID_ENABLED`, so the store bundle has none of it and the module is not offered. Card, Ask b, History, BSV price chart, Pots, Notifications and Music are allowed. The store grep also checks `From the Store|Open Store|tickets at the door`.

- **Names, Rooms and Tickets (24 Oct 2026, `NRT_ENABLED`, off by default and never in a store build):** You (`/m/you`) is in every edition: Names (WalletNames) and rooms with no token (open rooms) sell nothing. Tickets (tokens or 1Sat collections a room accepts at the door, used up on entry) are token-gated access, so `you/TicketsPanel.tsx` is a lazy chunk behind the inlined flag. The store grep also checks `Make a new ticket token|Save tickets|used up on entry`.

- **Company offers, accepted by signing to pay (24 Oct 2026, bWalletX only, `OFFERS_ENABLED`):** bMail › Agreements › Offers (`/m/bmail/offers`, `src/mobile/offer/*`): a director signs a company offer, the company account seals it on chain and sends it by bMail, and the named offeree reads to the end, draws a signature and signs to pay in one approval sheet. It is payment for securities, so it never ships in a store build, not even as code: `OffersPage` and the Agreements header's `OffersLink` are lazy chunks behind the inlined flag (literal env check, plus `VITE_OFFERS=0` to turn it off in bWalletX). Inside bWalletX it shows only to the company's directors, the company account and the named offeree; it is never marketed as buying shares. The store grep also checks `New company offer|Sign as director|Seal & send|Sign & pay|Read to the end to accept|Accept & pay|bcorp-offer|bwx.offer.pending|bwallet.offers.scan|offer-register|offer-receipts|Payments received|Offer payment received`.
