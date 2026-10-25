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
| `cardArt`                         | optional; same rules, ≤ 256 KB; drawn behind the banner (and the room header, see below)   |
| `roomArt`                         | optional; same rules, ≤ 256 KB; a wide picture for the chat room's header (else `cardArt`) |

| `paths` | optional, root file only; see "Path sub-themes" below |
| `room` | optional; the site's chat room ticker (`ASSAULT` or `$ASSAULT`, 1-20 letters/digits); see "The game's room" |

Unknown keys are ignored (never read), so a field added later never breaks a newer wallet; known keys are checked
strictly. **Wallets 5.2.41 and earlier refuse the whole theme if it has any key they don't know** (e.g. `roomArt`):
add new keys only once the users you care about have updated. No CSS, fonts, scripts, gradients or arbitrary values. File ≤ 8 KB.

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
- "Connected" means the user approved a sheet from that site in this build, **or** the site already holds wallet
  permissions (History › Connections lists it). The second case covers sites approved before site themes shipped
  (25 Oct 2026): the panel asks the background's permission list once and remembers the answer. `www.` and the apex
  are different origins: each needs its own connection and serves its own file.
- A site that never made a request is never fetched.
- Approving a site again forgets a cached "no theme" answer, so a site that just added its file shows at once.
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

Owner, 25 Oct 2026 (replaces 24 Oct): connecting a site or game never switches the wallet to its chat room. The
site's theme still applies. While that site is the active tab, a small "Open <site> room" chip opens the room on a tap.

- The room is the `room` of the theme in force for the active tab: the root file, or the path sub-theme for that
  page (so `/arcade/assault` offers the Assault room). Switching to another connected game follows it; nothing
  connected, no chip.
- The chip shows only for a room the wallet already lists (`/api/bitsign/rooms`) and opens it through the Chat tab's
  own ticker hand-off. Unknown room, no chat sign-in, or a bad `room` value: no chip, nothing else changes.
- Above the room, a short balance card: the balance in dollars large, BSV small, in the site's colours. It shows the
  last balance the wallet card read.
- Store builds never do this: rooms there can take a penny ticket, and the store edition sells no paid content.

## The room dresses itself (game makers: what to put in the file)

Owner, 25 Oct 2026: a game's room, its token picture and its agent take the game's look automatically, and change
as the game maker updates the theme file. Code: `src/mobile/chat/roomLook.ts`.

| Field               | Drives in the room                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `room`              | which room is dressed (only that room; a sub-theme dresses its own room, e.g. `ASSAULT`)    |
| `roomArt`           | header background picture (wide, about 3:1, ≤ 256 KB). Optional: falls back to `cardArt`    |
| `cardArt`           | header background when there is no `roomArt`                                                |
| `bg`, `surface`     | header overlay and gradient; a `dark` theme also colours the room behind the messages       |
| `text`              | room name and details in the header                                                         |
| `accent`/`accentHi` | header edge and buttons; the room agent's label                                             |
| `logo`              | the room's picture (room list and header) and the room agent's picture, when they have none |
| `name`              | "<name> look · from <host>" under the room name, and the agent's label ("<NAME> · AI")      |

- **The site must name the room (25 Oct 2026).** A room's `metadata.look` on bChatX is used only when the site's own
  theme file (root or a `paths` sub-theme) has `room` set to that ticker. Without that, the room is plain: anyone can
  set `metadata.site`, so the site's own file is the proof that the site agrees.
- **Ownership: a site only dresses a room it owns.** The room must name the site as its own in its bChatX room
  metadata, `site: "https://www.tokenblaster.lol"` (set by the room's owner), and the theme file must come from
  exactly that origin (`www.` and the bare domain differ). A room with no `site`, or another site's, is never dressed,
  so no site can dress another's token room by putting its ticker in `room`. (The wallet's own room-to-site memory
  can't prove ownership, because it is learned from the theme itself.)
- The art always sits under an overlay in the theme's `bg` so text stays readable. Messages, amounts and payment
  buttons keep the wallet's own styling.
- A room's own picture (`metadata.icon`) or its token's icon wins over the theme logo.
- The wallet learns which site dresses a room when the extension sees that site (connected, theme on) name it; the
  room stays dressed while the site stays connected and its theme switched on. Never the Help Desk, official rooms,
  or store builds. The header always names the true host the look came from.
- Sub-themes match the page's real path (after redirects), longest prefix first, so moving a game from
  `/arcade/assault` to `/arcade/terrornode` only needs the `paths` key changed.

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
