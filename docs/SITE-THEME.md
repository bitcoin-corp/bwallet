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

No other keys. No CSS, fonts, scripts, gradients or arbitrary values. File ≤ 8 KB.

Contrast: `text` must reach 4.5:1 on both `bg` and `surface`; if it doesn't, the wallet swaps it for black or white,
and refuses the theme if neither works. `accent` must reach 3:1 on `bg` or the theme is refused. Text on the accent
is picked by the wallet.

## When it kicks in

- Only after the user approves a request from that origin (Allow on a connect, sign or pay sheet). The approval
  marks the site connected and starts the fetch, so the next sheet is already dressed. A site the user never
  approved is never fetched.
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
