import type { Plugin } from 'vite';
import { resolve } from 'path';
import { readFileSync } from 'fs';

/**
 * Build-time brand switch shared by the mobile (vite.config.mobile.ts), web
 * (vite.config.web.ts) and extension (vite.config*.ts) builds. Upstream's files
 * stay unchanged (and mergeable); the brand is applied by these plugins.
 *
 * BRAND=bcorp (default) is "bWallet", the store brand; BRAND=bwallet is the
 * older green bWallet; BRAND=yours keeps upstream's name and logos (internal
 * testing only). MOBILE_BRAND is still read for older scripts.
 */
export type Brand = 'bcorp' | 'yours' | 'bwallet';
export const BRAND: Brand =
  (['yours', 'bwallet'] as const).find((b) => b === (process.env.BRAND ?? process.env.MOBILE_BRAND)) ?? 'bcorp';

/** `__BRAND__` (and the older `__MOBILE_BRAND__`) for src code. */
export const brandDefines = () => ({
  __BRAND__: JSON.stringify(BRAND),
  __MOBILE_BRAND__: JSON.stringify(BRAND),
});

const LOGO_DIR = BRAND === 'bcorp' ? 'src/mobile/brand/bcorp' : 'src/mobile/brand';
// bWalletX = every non-store build (src/mobile/storeBuild.ts): its unlock-screen b wears the x.
const STORE =
  process.env.VITE_STORE_BUILD === '1' || ['ios-store', 'android-play'].includes(process.env.VITE_CHANNEL ?? '');
const WHITE_LOGO_DIR = BRAND === 'bcorp' && !STORE ? 'src/mobile/brand/bcorpx' : LOGO_DIR;
const BWALLET_ASSETS: Record<string, string> = {
  [resolve(__dirname, 'src/utils/constants.ts')]: resolve(__dirname, 'src/mobile/brand/constants.ts'),
  [resolve(__dirname, 'src/assets/logos/icon.png')]: resolve(__dirname, LOGO_DIR, 'icon.png'),
  [resolve(__dirname, 'src/assets/logos/horizontal-logo.png')]: resolve(__dirname, LOGO_DIR, 'horizontal-logo.png'),
  [resolve(__dirname, 'src/assets/logos/white-logo.png')]: resolve(__dirname, WHITE_LOGO_DIR, 'white-logo.png'),
};

/**
 * Swaps upstream modules for brand ones. `extra` swaps (theme, mobile tab bar...)
 * apply to every brand; logos, constants and the default avatar only to bWallet
 * brands. Set `emitAvatar: false` for builds that only bundle scripts.
 */
export const brand = (extra: Record<string, string> = {}, { emitAvatar = true } = {}): Plugin => {
  const SWAPS: Record<string, string> = { ...extra };
  if (BRAND !== 'yours') Object.assign(SWAPS, BWALLET_ASSETS);
  return {
    name: 'bwallet-brand',
    enforce: 'pre',
    // Default account avatar at a stable path (it is stored in account records).
    generateBundle() {
      if (BRAND === 'yours' || !emitAvatar) return;
      this.emitFile({
        type: 'asset',
        fileName: 'bwallet-avatar.png',
        source: readFileSync(resolve(__dirname, LOGO_DIR, 'icon.png')),
      });
    },
    async resolveId(source, importer, options) {
      if (!importer) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const swap = resolved && SWAPS[resolved.id.split('?')[0]];
      // A replacement may import the file it replaces (brand/constants re-exports upstream);
      // every other import from a replacement is still swapped (mobile TopNav's logo).
      if (swap && swap === importer.split('?')[0]) return null;
      return swap ? swap + (resolved!.id.includes('?') ? resolved!.id.slice(resolved!.id.indexOf('?')) : '') : null;
    },
  };
};

type Swaps = Record<string, [string, string][]>;

const applySwaps = (name: string, table: Swaps) =>
  function (this: { error: (m: string) => never }, code: string, id: string) {
    const file = id.split('?')[0].slice(__dirname.length + 1);
    const swaps = table[file];
    if (!swaps) return null;
    for (const [from, to] of swaps) {
      if (!code.includes(from)) this.error(`${name}: "${from}" not found in ${file}`);
      code = code.split(from).join(to);
    }
    return { code, map: null };
  };

// bcorp builds: reword upstream UI strings that name "Yours" as the product, at build
// time. Each entry must still match: the build fails if upstream rewords one, so the
// list can't silently go stale.
const BCORP_TEXT: Swaps = {
  // Accounts created before the rebrand stored upstream's hosted avatar; show ours instead.
  'src/hooks/useIdentity.ts': [
    [
      "if (!uri) return '';",
      "if (!uri) return '';\n  if (uri.includes('i.ibb.co/zGcthBv/yours-org-light.png')) return 'bwallet-avatar.png';",
    ],
  ],
  // Rapid unconfirmed spends (several game Loads or Market buys before a block, token listings with
  // long unconfirmed histories) exceed wallet-toolbox's BEEF recursion limit of 12 ("Maximum BEEF
  // depth exceeded. Limit is 12"). Raise the default at build time in every bundled copy.
  // Market buys made before the Oct 2026 upstream merge stored their token details (customInstructions)
  // encrypted twice, and the permissions manager removes one layer, so balances skipped them. Peel up
  // to three layers when a decrypted value is still base64 ciphertext; anything else is unchanged.
  'node_modules/@bsv/wallet-toolbox-client/out/index.client.mjs': [
    ['this.maxRecursionDepth = 12;', 'this.maxRecursionDepth = 64;'],
    [
      'async maybeDecryptMetadata(ciphertext) {',
      'async maybeDecryptMetadata(ciphertext) {\n' +
        '    let value = await this.maybeDecryptMetadataOnce(ciphertext);\n' +
        '    for (let i = 0; i < 2 && value !== ciphertext && /^[A-Za-z0-9+/]{40,}={0,2}$/.test(value); i++) {\n' +
        '      const next = await this.maybeDecryptMetadataOnce(value);\n' +
        '      if (next === value) break;\n' +
        '      ciphertext = value;\n' +
        '      value = next;\n' +
        '    }\n' +
        '    return value;\n' +
        '  }\n' +
        '  async maybeDecryptMetadataOnce(ciphertext) {',
    ],
  ],
  'node_modules/@1sat/connect/dist/index.js': [
    ['this.maxRecursionDepth = 12;', 'this.maxRecursionDepth = 64;'],
    [
      'async maybeDecryptMetadata(ciphertext) {',
      'async maybeDecryptMetadata(ciphertext) {\n' +
        '    let value = await this.maybeDecryptMetadataOnce(ciphertext);\n' +
        '    for (let i = 0; i < 2 && value !== ciphertext && /^[A-Za-z0-9+/]{40,}={0,2}$/.test(value); i++) {\n' +
        '      const next = await this.maybeDecryptMetadataOnce(value);\n' +
        '      if (next === value) break;\n' +
        '      ciphertext = value;\n' +
        '      value = next;\n' +
        '    }\n' +
        '    return value;\n' +
        '  }\n' +
        '  async maybeDecryptMetadataOnce(ciphertext) {',
    ],
  ],
  'src/components/SyncingBlocks.tsx': [['Yours SPV Wallet will be ready', 'bWallet will be ready']],
  // getVersion() names this wallet, not Yours (wallet-connect spec §3.2). Only the real extension has
  // chrome.sidePanel; the mobile shell's chrome shim doesn't.
  'src/background.ts': [
    // Keep the broadcast reason behind "results require review" (src/brand/walletError.ts).
    [
      "import { RequestParams, ResponseEventDetail, YoursEventName } from './inject';",
      "import { RequestParams, ResponseEventDetail, YoursEventName } from './inject';\nimport { describeWalletError } from './brand/walletError';",
    ],
    ['error: error instanceof Error ? error.message : String(error),', 'error: describeWalletError(error),'],
    [
      'data: { version: `yours-wallet-${chrome.runtime.getManifest().version}`, pinnedProtocols: PINNED_PROTOCOLS_VERSION },',
      "data: { version: `${'sidePanel' in chrome ? 'bwalletx' : 'bwallet-mobile'}-${chrome.runtime.getManifest().version}`, pinnedProtocols: PINNED_PROTOCOLS_VERSION },",
    ],
  ],
  'src/components/UpgradeNotification.tsx': [['Welcome to Yours Wallet 5.0', 'Welcome to bWallet']],
  'src/components/BackupPromo.tsx': [['Yours Wallet now uses', 'bWallet uses']],
  'src/components/ProviderPicker.tsx': [
    // The status check signs with the wallet: when the wallet itself isn't running, say so instead of
    // blaming the provider ("may be temporarily down").
    [
      'Unable to reach this provider. It may be temporarily down.',
      "{result?.status === 'error' && /wallet not (available|initialized)/i.test(result.error ?? '') ? 'Your wallet isn\\'t running: lock and unlock " +
        (STORE ? 'bWallet' : 'bWalletX') +
        ", then try again.' : `Unable to reach this provider (${result?.status === 'error' ? result.error : ''}).`}",
    ],
  ],
  'src/components/storageProviders.ts': [
    ['Official storage partner of Yours Wallet.', 'Default wallet storage provider.'],
  ],
  'src/components/TopNav.tsx': [['alt="Yours Wallet"', 'alt="bWallet"']],
  // Alt text follows the app (it shows in copied text and screen readers): bWalletX, or bWallet in store builds.
  'src/components/YoursIcon.tsx': [
    [
      "import { useState, useRef, useEffect } from 'react';",
      "import { useState, useRef, useEffect } from 'react';\nimport { appNameFor } from '../mobile/storeBuild';",
    ],
    ['alt="Yours Head"', 'alt={appNameFor()}'],
  ],
  'src/pages/requests/UsbCheckRequest.tsx': [['is asking Yours to', 'is asking bWallet to']],
  'src/pages/onboarding/RestoreAccount.tsx': [
    ['alt="Yours"', 'alt="bWallet"'],
    ['Upload Yours JSON', 'Upload wallet backup JSON'],
    // Yours users don't know a Yours seed restores as bWallet: list Yours by name too (same import path), with its green leaf.
    [
      "import masterWallet from '../../assets/master-wallet.svg';",
      "import masterWallet from '../../assets/master-wallet.svg';\nimport yoursOriginalLogo from '../../mobile/brand/restore/yours-leaf.png';",
    ],
    [
      "    {\n      id: 'relayx',",
      "    {\n      id: 'yours',\n      label: 'Yours Wallet',\n      logo: (\n        <div className=\"flex items-center justify-center rounded-lg\" style={{ backgroundColor: '#000', width: '2.25rem', height: '2.25rem', padding: '0.35rem' }}>\n          <img src={yoursOriginalLogo} alt=\"Yours Wallet\" style={{ width: '1.4rem', height: 'auto' }} />\n        </div>\n      ),\n    },\n    {\n      id: 'relayx',",
    ],
    ['key={opt.id}', 'key={opt.label}'],
  ],
};

/**
 * Extension-only bcorp rewording, on top of BCORP_TEXT: pages and logs the mobile
 * app does not show (USB key flows, Settings footer, content/background logs).
 */
export const EXTENSION_TEXT: Swaps = {
  'src/content.ts': [
    ["console.log('🌱 Yours Wallet Loaded');", ''],
    // Only bWalletX's own page event (src/brand/cwi.ts), so a request meant for Yours never reaches us.
    ['self.addEventListener(CustomListenerName.YOURS_REQUEST,', "self.addEventListener('bWalletXRequest',"],
  ],
  'src/background.ts': [
    [
      "console.log('Yours Wallet Background Script Running!');",
      // bWalletX opens in Chrome's side panel when the toolbar icon is clicked (scripts/build.ts manifest).
      "console.log('bWalletX background running');\nchrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});",
    ],
  ],
  'src/pages/Settings.tsx': [
    [
      '        {buildInfo}\n      </div>',
      '        {buildInfo}\n      </div>\n      <div className="text-center text-[10px] pb-4 px-4" style={{ color: \'#667085\' }}>bWalletX (beta) by The Bitcoin Corporation Ltd. Based on the open-source Yours Wallet (MIT licence); not affiliated with or endorsed by its authors.</div>',
    ],
  ],
  'src/pages/usb/RepickFlow.tsx': [['The dialog will name Yours Wallet.', 'The dialog will name bWalletX.']],
  'src/pages/usb/EnrollFlow.tsx': [['already has a Yours key file', 'already has a wallet key file']],
  'src/pages/usb/AddFlow.tsx': [['already has a Yours key file', 'already has a wallet key file']],
  'src/pages/usb/RestoreFlow.tsx': [
    ['No Yours backup found on this drive', 'No wallet backup found on this drive'],
    ['Open the Yours icon;', 'Open the bWalletX icon;'],
  ],
  'src/pages/usb/UsbFlow.tsx': [
    ['Click the Yours icon to open your wallet.', 'Click the bWalletX icon to open your wallet.'],
  ],
  'src/services/usbBackup.ts': [
    ['written by a different version of Yours.', 'written by a different version of the wallet.'],
    ["This drive doesn't hold a Yours USB key", "This drive doesn't hold a wallet USB key"],
  ],
};

export const bcorpText = (extra: Swaps = {}): Plugin => {
  const table: Swaps = { ...BCORP_TEXT };
  for (const [file, swaps] of Object.entries(extra)) table[file] = [...(table[file] ?? []), ...swaps];
  const transform = applySwaps('bcorp-text', table);
  return {
    name: 'bcorp-text',
    enforce: 'pre',
    // order: 'pre' on the hook: in dev, @vitejs/plugin-react reprints sources with Babel first and the
    // exact-text swaps would no longer match (same as mobile-text).
    transform: {
      order: 'pre',
      handler(code, id) {
        if (BRAND !== 'bcorp') return null;
        return transform.call(this, code, id);
      },
    },
    transformIndexHtml: (html) =>
      BRAND === 'bcorp'
        ? html.replace('<title>Yours Wallet</title>', `<title>${STORE ? 'bWallet' : 'bWalletX'}</title>`)
        : html,
  };
};

/**
 * bCorp palette: upstream's greens become BSV gold in the bcorp build only.
 */
const a2 = (hh: string) => +(parseInt(hh, 16) / 255).toFixed(2);
// Theme (owner, 14 Oct 2026): the greens become the app accent as CSS variables (src/accent.css, mobile/theme/accent.ts),
// gold by default, so Settings → Theme → App colours can swap it at runtime. Tailwind arbitrary classes ([#A1FF8B]) stay
// a fixed gold: Tailwind scans the source, not this transform, so a class rewritten here would have no CSS. Tailwind's
// generated selectors escape the hash (.text-\[\#A1FF8B\]), so `\#` is skipped too: rewriting it made `.text-\[\var(…)\]`,
// an invalid selector (esbuild warning) that matched nothing.
const BCORP_COLOURS: [RegExp, string | ((...m: string[]) => string)][] = [
  [
    /(?<![[\\])#(?:A1FF8B|9EFF8A)([0-9a-f]{2})?(?![0-9a-f])/gi,
    (_m, hh) => (hh ? `rgb(var(--bw-accent-hi-rgb)/${a2(hh)})` : 'var(--bw-accent-hi)'),
  ],
  [
    /(?<![[\\])#34D399([0-9a-f]{2})?(?![0-9a-f])/gi,
    (_m, hh) => (hh ? `rgb(var(--bw-accent-lo-rgb)/${a2(hh)})` : 'var(--bw-accent-lo)'),
  ],
  [/#A1FF8B/gi, '#FFD24D'],
  [/#9EFF8A/gi, '#FFD24D'],
  [/#34D399/gi, '#EAB300'],
  [/rgba\(52,\s*211,\s*153,\s*([\d.]+)\)/g, 'rgb(var(--bw-accent-lo-rgb) / $1)'],
  [/rgba\(52,\s*211,\s*153/g, 'rgba(234, 179, 0'],
  [/\btext-green-400\b/g, 'text-yellow-400'],
];
export const bcorpColours = (): Plugin => ({
  name: 'bcorp-colours',
  enforce: 'pre',
  transform(code, id) {
    if (BRAND !== 'bcorp' || !/\/src\/.*\.(tsx?|css)$/.test(id.split('?')[0])) return null;
    let out = code;
    for (const [re, to] of BCORP_COLOURS) out = out.replace(re, to as string);
    return out === code ? null : { code: out, map: null };
  },
});

/** Extension theme: bWallet name and badge, without the mobile-only Browser tab. */
export const EXTENSION_SWAPS: Record<string, string> =
  BRAND === 'yours'
    ? {}
    : {
        [resolve(__dirname, 'src/theme.ts')]: resolve(__dirname, 'src/brand/extensionTheme.ts'),
        // Page-side wallet: own request event, discovery announce, no window.CWI overwrite.
        [resolve(__dirname, 'src/cwi.ts')]: resolve(__dirname, 'src/brand/cwi.ts'),
      };

/** All brand plugins for one extension bundle. */
export const extensionBrandPlugins = ({ emitAvatar = false } = {}): Plugin[] => [
  brand(EXTENSION_SWAPS, { emitAvatar }),
  bcorpText(EXTENSION_TEXT),
  bcorpColours(),
];
