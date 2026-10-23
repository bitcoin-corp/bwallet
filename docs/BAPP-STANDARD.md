# The bApp standard

A **bApp** is a web app that lives inside bWalletX: it has its own token, its own room, its own look in the
wallet, and it runs in the wallet with no separate sign-in. The bApps screen lists apps in three tiers:

1. **Featured: b\*X bApps.** Made by The Bitcoin Corporation (bChatX, bSocialX, bMoviesX, bMintX…).
2. **Commercial apps.** Our ventures and clients with tokens (Ninja Punk Girls, VexVoid, Zero Dice; NPGX is
   adults only, see below).
3. **Community bApps.** Apps from other developers, listed **only when they meet all four parts of the standard**.
   Apps that don't yet meet it go in a collapsed "Not yet bApp-ready" section at the bottom.

Each tile shows four badges, one for each part of the standard.

## The four requirements

| Badge     | Requirement                                                                                                                                            | How we check                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Token     | The app has a BSV-21 token (ticker) and it is launched and indexed.                                                                                    | Token id in the wallet's registry                                     |
| Room      | The token has a **bChatX room** (bit-sign room ticker). Holders meet there and a 1¢ ticket gets you in.                                                | `src/mobile/chat/bappRooms.ts`                                        |
| Theme     | The site serves a **wallet theme pack** at `https://<host>/.well-known/bwalletx-theme.json`, so the wallet takes on the app's colours while it's open. | Host listed in `src/mobile/theme/themeSites.ts` (docs/SITE-THEMES.md) |
| In-wallet | The app runs in the **bWalletX bApp format**: see below.                                                                                               | Frame headers, plus a manual BRC-100 check                            |

The data lives on each entry as `standard: { token, room, theme, inWallet }` in `src/mobile/bappStandard.ts`.
`missingStandard()` says what an app still lacks.

## The in-wallet format

A bApp must work in **both** of these places:

- **Phones (iOS/Android):** it opens full screen inside the wallet's webview/frame. Your site must allow framing by
  the wallet: send `Content-Security-Policy: frame-ancestors 'self' capacitor://localhost https://localhost
https://web.bwalletx.com https://desktop.bwalletx.com` and **no** `X-Frame-Options: DENY/SAMEORIGIN`
  (docs/BAPP-FRAME.md).
- **Chrome extension:** the side panel is only the launcher (tiles, badges, search, room previews). Tapping a bApp
  opens it in a **normal browser tab**, or focuses the tab already open on that origin. The extension's injected
  BRC-100 provider connects the page and the site-theme rule applies there. bApps never run in a cramped in-panel
  iframe. So your app must also work as an ordinary full-tab website.
- The web wallet (web.bwalletx.com) keeps its in-page frame for sites that allow it.

In every case the app connects to the wallet over **BRC-100** (`@bsv/sdk` `WalletClient`: auto-detects the extension's
`window.CWI`, or `XDM` when framed). There is no separate login: the wallet's identity key is the account. Don't
target a vendor SDK; any BRC-100 wallet should work, with bWalletX as the main one.

## Getting listed (third-party developers)

1. **Launch a token.** Deploy a BSV-21 token for your app and send us the token id.
2. **Open a room.** Create its bChatX room (bchatx.com, ticker = your token). A 1¢ ticket or holding your token is
   how people join.
3. **Ship a theme pack.** Serve `/.well-known/bwalletx-theme.json` (format in docs/SITE-THEMES.md) and ask for your
   host to be added to the theme-site list.
4. **Run in the wallet.** Allow framing as above, connect with BRC-100 `WalletClient`, drop any separate sign-in,
   and check that it works as a full-tab site with the extension too.
5. **Open a PR** adding your entry (name, url, one-line verb, category, brand colour, logo, standard) or email us.
   We check the four parts and list you under Community bApps.

## Content rules

- **Adult apps** are marked 18+, show a locked tile until the person confirms they are 18 or over, and are **never**
  in the App Store / Play edition (bWallet). They are separate brands: NPGX (adult) is never mixed with Ninja Punk
  Girls (all ages) in one tile, section or artwork.
- Real-money games and bWalletX-only features (`privateOnly`) are left out of store builds (`storeBuild.ts`).
