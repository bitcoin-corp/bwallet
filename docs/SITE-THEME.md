# Site theme JSON: the wallet wears a connected site's look

Owner, 23 Oct 2026: "every site that connects to bWallet needs a theme JSON that tells the wallet what it should look
like when connected." Part of the Theme edition (bwalletx.com/themes/custom). Code:
`src/mobile/theme/connectSiteTheme.ts` (validate, fetch, cache, switches) and `src/mobile/theme/SiteThemeFrame.tsx`
(the frame every approval sheet sits in, `src/prompt-tab.tsx`). Schema: `bwalletx-connect/schema/bwallet-theme.schema.json`.

This is separate from the family-site offer in `docs/SITE-THEMES.md` (v1 file, "Wear DNS DEX colours?", saves a
pack to your account). A v2 theme is never saved to the account: it dresses that site's sheets only.

## Where the site puts it

Either file, served over https from the site's own origin, `Access-Control-Allow-Origin: *`:

1. `/.well-known/bwalletx-theme.json` (checked first; a family v1 file there also works, colours only), or
2. a `theme` object in `/.well-known/bapp.json` (the bApp manifest; `name` is taken from the manifest).

```json
{
  "v": 2,
  "name": "Ember & Bean",
  "mode": "dark",
  "accent": "#E8B04A",
  "accentHi": "#F6D08A",
  "bg": "#0F2A1F",
  "surface": "#173A2C",
  "text": "#F5EBDD",
  "logo": "/brand/logo.png",
  "cardArt": "/brand/card.jpg"
}
```

| Key                               | Rule                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `v`                               | `2` (optional in bapp.json)                                                                |
| `name`                            | 1-32 characters of plain words; no links, markup or addresses                              |
| `mode`                            | `dark` or `light`                                                                          |
| `accent`, `bg`, `surface`, `text` | `#RRGGBB` only. `accentHi` optional, `#RRGGBB`                                             |
| `logo`                            | optional; a path or https URL on the **same origin**; png, jpeg, webp, gif or svg; ≤ 64 KB |
| `cardArt`                         | optional; same rules, ≤ 256 KB; drawn behind the banner                                    |

| `paths` | optional, root file only; see "Path sub-themes" below |
| `room` | optional; the site's chat room ticker (`ASSAULT` or `$ASSAULT`, 1-20 letters/digits); see "The game's room" |

No other keys. No CSS, fonts, scripts, gradients or arbitrary values. File ≤ 8 KB.

### Path sub-themes

A site with several games or sections can give each its own look (agreed with TokenBlaster, b0ase/tokenblaster.lol
#38). The root file carries a `paths` map from a page-path prefix to another theme file:

```json
{ "v": 2, "name": "TokenBlaster", "…": "…", "paths": { "/arcade/assault": "/.well-known/bwalletx-theme.assault.json" } }
```

- At most 8 entries. Keys are `/` or `/segment[/segment…]` (letters, digits, `. _ ~ -`), no trailing slash.
- Targets are **same-origin** `/.well-known/<name>.json` only (no query, no fragment, not the root file itself).
- The page's path comes from Chrome (`sender.url` of the page's own messages), never from the page's message. The
  **longest** prefix wins, and it matches only on a `/` boundary (`/arcade/assault` covers `/arcade/assault` and
  `/arcade/assault/…`, not `/arcade/assaulted`).
- A sub-theme file passes exactly the same v2 checks and caps. It may not have its own `paths`.
- If anything fails (bad map, missing file, bad file, failed contrast), the wallet falls back to the root theme. A
  malformed `paths` map is dropped and the root theme still applies.
- Cached like the root file. The whole view follows the active tab's path, including in-app route changes (checked
  once a second while connected). Sheets use the last path the panel saw for that site, otherwise the root theme.

Contrast: `text` must reach 4.5:1 on both `bg` and `surface`; if it doesn't, the wallet swaps it for black or white,
and refuses the theme if neither works. `accent` must reach 3:1 on `bg` or the theme is refused. Text on the accent
is picked by the wallet.

## When it kicks in

- Approval sheets: whenever that origin has a request on screen, including its **first connect sheet** (24 Oct
  2026). The origin is the request's originator as checked by the background, so a site can only ever dress its
  own sheets. Approving marks the site connected.
- The whole view (extension, 24 Oct 2026): while the active tab is a site the user has connected, and that page
  has talked to the wallet, the side panel / popup wears the site's look: page, cards, bars, text and buttons in its
  colours (`src/mobile/theme/siteLook.ts`, built only from the validated colours above; derived shades are
  contrast-checked again). It is never saved. It reverts when the tab changes to another site, reloads, closes,
  the site disconnects (`bwallet:disconnect`, see `src/services/reconnectGate.ts`), the user revokes it, or a
  switch below is turned off. A bundled pack the page names (`<meta name="bwalletx-theme">`) wins over the file.
- A site that never made a request is never fetched.
- Fetch: no cookies, no referrer, 4 s timeout, size caps, no redirect to another origin. Images are fetched by the
  wallet and kept as `data:` URLs. Cached a day (a site with no theme: an hour). Per device (localStorage).
- Extension: every approval (side panel, popup window, in-page sheet) is `prompt.html`, so all three wear it.
- Phone app: sites in the in-app browser (`dappBrowser.ts`) approve through the same `prompt.html` overlay.
- Web wallet: same overlay. **Paired sessions** (`<host>.paired.invalid`, phone/web pairing) are never themed: the
  origin there is a relay hint, not proof (`originKey.ts`, audit H1), and a theme must not lend an unproven
  origin a real site's look.

## What a theme can never touch

- The wallet's strip at the top of every sheet: fixed bWalletX colours, a lock, "request from **host**", where the
  host is the request's originator as checked by the background (never from the theme).
- The sheet itself: amounts, recipients, warnings, allowance, Approve / Deny keep the wallet's styling. A theme
  dresses only the banner (logo, name, colours) and a thin accent edge around the sheet.
- The whole-view look is colours only: no logo, art, fonts, CSS or patterns from the site reach the wallet's own
  screens.

## The game's room (extension)

Owner, 24 Oct 2026: when a site or game is connected, the extension opens straight to its chat room, in its look.

- The room is the `room` of the theme in force for the active tab: the root file, or the path sub-theme for that
  page (so `/arcade/assault` opens the Assault room). Switching to another connected game follows it; nothing
  connected, the user's own home screen comes back.
- Only a room the wallet already lists (`/api/bitsign/rooms`) is opened, through the Chat tab's own ticker hand-off.
  Unknown room, no chat sign-in, or a bad `room` value: the normal home screen, nothing else changes.
- Above the room, a short balance card: the balance in dollars large, BSV small, in the site's colours. It shows the
  last balance the wallet card read.
- Store builds never do this: rooms there can take a penny ticket, and the store edition sells no paid content.

## Switches

- Settings › Theme › Connected sites: one switch for all sites (default on).
- History › Connections: "Use this site's theme" per site (default on). Revoke access forgets the site and its theme.

## Store edition

Cosmetic only, nothing to buy in the wallet, no links: on in store builds (`storeBuild.ts` needs no change).

## Demo

`bwalletx-site`: `/.well-known/bwalletx-theme.json` (bwalletx.com's own: gold on black, `/icon-192.png`) and
`connect-demo/` (fictional "Ember & Bean" coffee shop, deep green and cream). A theme belongs to an origin, so the
demo needs its own origin to show its own theme: serve `connect-demo/` as a site root (it carries its own
`.well-known/bwalletx-theme.json` and `brand/logo.svg`), e.g. on a subdomain. Served at bwalletx.com/connect-demo it
wears bwalletx.com's theme instead.

Note: BRC-100 originators carry no port, so a local test server must listen on the default port (80) for the
wallet to find its theme file.
