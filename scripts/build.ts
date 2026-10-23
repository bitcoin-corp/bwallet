import { build } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import chalk from 'chalk';

// ─── Paths ───────────────────────────────────────────────────
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(__dirname, '..');
const dist = resolve(root, 'build');
const META = resolve(__dirname, '.build-meta.json');

// Same rule as vite.brand.ts: BRAND=bcorp (default) is bWallet; yours keeps upstream's manifest.
const BRAND = ['yours', 'bwallet'].find((b) => b === (process.env.BRAND ?? process.env.MOBILE_BRAND)) ?? 'bcorp';
// The extension is a full-feature build, so it ships as bWalletX with the b+x icons (scripts/gen-bwalletx-mark.sh).
const BRAND_ICONS = resolve(root, 'assets/bwalletx-ext');
const NAME = 'bWalletX';

/**
 * bWallet builds: rewrite build/manifest.json and the PWA manifest, and replace the
 * Yours sprout icons with the bWallet mark. The name differs from Yours Wallet and no
 * `key` is set, so Chrome gives it its own extension ID and it installs alongside
 * Yours Wallet (the Web Store assigns the published ID).
 */
function brandManifest() {
  if (BRAND === 'yours') return;
  const icons = resolve(dist, 'icons');
  rmSync(icons, { recursive: true, force: true });
  mkdirSync(icons);
  for (const s of [16, 32, 48, 128, 192, 512])
    copyFileSync(resolve(BRAND_ICONS, `icon${s}.png`), resolve(icons, `icon${s}.png`));
  copyFileSync(resolve(BRAND_ICONS, 'icon192.png'), resolve(dist, 'logo192.png'));
  copyFileSync(resolve(BRAND_ICONS, 'icon512.png'), resolve(dist, 'logo512.png'));
  copyFileSync(resolve(BRAND_ICONS, 'favicon.ico'), resolve(dist, 'favicon.ico'));
  rmSync(resolve(dist, 'banner.png'), { force: true }); // Yours artwork, unreferenced

  const manifestPath = resolve(dist, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const iconSet = {
    '16': 'icons/icon16.png',
    '32': 'icons/icon32.png',
    '48': 'icons/icon48.png',
    '128': 'icons/icon128.png',
  };
  manifest.name = NAME;
  manifest.short_name = NAME;
  manifest.description = 'The BSV wallet for tokens, media and apps.';
  // Side panel instead of the 360x600 popup: the mobile UI is phone-shaped (vite.config.ts).
  const { default_popup: _popup, ...action } = manifest.action;
  manifest.action = { ...action, default_title: NAME, default_icon: iconSet };
  manifest.side_panel = { default_path: 'index.html' };
  manifest.permissions = [...new Set([...manifest.permissions, 'sidePanel'])];
  // In-page wallet sheet (docs/ONE-SHEET-PERMISSIONS.md §3d): when the side panel can't open, the content
  // script shows prompt.html in an iframe over the site. The page refuses to act without a one-time token
  // from the background and keeps its buttons off until it is fully visible, so a site framing it gains nothing.
  manifest.web_accessible_resources = [
    ...(manifest.web_accessible_resources ?? []),
    { resources: ['prompt.html'], matches: ['<all_urls>'] },
  ];
  // 1Sat overlay submit sends an x-topics header api.1sat.app's CORS rejects; host access skips CORS.
  manifest.host_permissions = [
    ...new Set([
      ...(manifest.host_permissions ?? []),
      'https://api.1sat.app/*',
      ...BAPP_HOSTS,
      'https://chat.bwalletx.com/*',
    ]),
  ];
  manifest.icons = iconSet;
  // Fixed extension ID (owner, 4 Oct 2026): each build is loaded from its own versioned folder
  // (dist/bwalletx-extension-<version>); without a key Chrome derives the ID from the folder path,
  // so every new folder was a new extension with an empty wallet. This is a PUBLIC key only.
  manifest.key = readFileSync(resolve(__dirname, 'extension-key.pub.txt'), 'utf-8').trim();
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const pwaPath = resolve(dist, 'pwa-manifest.json');
  if (existsSync(pwaPath)) {
    const pwa = JSON.parse(readFileSync(pwaPath, 'utf-8'));
    pwa.short_name = NAME;
    pwa.name = NAME;
    pwa.description = manifest.description;
    pwa.icons = [16, 48, 128, 192, 512].map((s) => ({
      src: `icons/icon${s}.png`,
      sizes: `${s}x${s}`,
      type: 'image/png',
    }));
    writeFileSync(pwaPath, JSON.stringify(pwa, null, 2) + '\n');
  }
}

// bApp sites (src/mobile/bapps.ts): host permission lets the extension read their framing headers, so
// it can open them inside the wallet (src/mobile/bappFrame). Read from source: bapps.ts imports images.
const BAPP_HOSTS = [
  ...new Set(
    [...readFileSync(resolve(__dirname, '../src/mobile/bapps.ts'), 'utf-8').matchAll(/url: '(https:\/\/[^/']+)/g)].map(
      (m) => `${m[1]}/*`,
    ),
  ),
];

// ─── Build pipeline ──────────────────────────────────────────
const STEPS = [
  { name: 'Popup UI', tag: 'Popup UI', cfg: 'vite.config.ts', out: ['assets'] },
  { name: 'Service Worker', tag: 'Worker', cfg: 'vite.config.background.ts', out: ['background.js'] },
  { name: 'Content Script', tag: 'Content', cfg: 'vite.config.content.ts', out: ['content.js'] },
  { name: 'Inject Script', tag: 'Inject', cfg: 'vite.config.inject.ts', out: ['inject.js'] },
] as const;

// ─── Theme ───────────────────────────────────────────────────
const accent = chalk.hex('#A1FF8B');
const ok = chalk.green;
const fail = chalk.red;
const dim = chalk.dim;
const bold = chalk.bold;

// ─── Terminal helpers ────────────────────────────────────────
const rawWrite = process.stdout.write.bind(process.stdout);
const isTTY = Boolean(process.stdout.isTTY);
const hideCursor = () => {
  if (isTTY) rawWrite('\x1b[?25l');
};
const showCursor = () => {
  if (isTTY) rawWrite('\x1b[?25h');
};

function mute() {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  return () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  };
}

// ─── Spinner ─────────────────────────────────────────────────
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function spinner(text: string) {
  // Not a terminal (CI logs): one line when a step starts, one when it finishes.
  if (!isTTY) {
    rawWrite(`  · ${text}\n`);
    return (line: string) => rawWrite(`  ${line}\n`);
  }
  let i = 0;
  hideCursor();
  const id = setInterval(() => {
    rawWrite(`\r  ${accent(SPIN[i++ % SPIN.length])} ${text}  `);
  }, 80);
  return (line: string) => {
    clearInterval(id);
    rawWrite(`\x1b[2K\r  ${line}\n`);
    showCursor();
  };
}

// ─── Size helpers ────────────────────────────────────────────
function measureDir(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) total += measureDir(full);
    else if (!entry.name.endsWith('.map')) total += statSync(full).size;
  }
  return total;
}

function measureOutputs(paths: readonly string[]): number {
  return paths.reduce((sum, p) => {
    const full = resolve(dist, p);
    if (!existsSync(full)) return sum;
    const stat = statSync(full);
    return sum + (stat.isDirectory() ? measureDir(full) : stat.size);
  }, 0);
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const k = n / 1024;
  return k < 1024 ? `${Math.round(k)} kB` : `${(k / 1024).toFixed(1)} MB`;
}

function fmtDelta(now: number, prev?: number): string {
  if (prev == null) return dim('new');
  const diff = now - prev;
  if (Math.abs(diff) < 512) return dim('±0');
  return diff > 0 ? fail(`+${fmtBytes(diff)}`) : ok(`-${fmtBytes(Math.abs(diff))}`);
}

// ─── Build metadata (persists across builds) ─────────────────
type Meta = { sizes: Record<string, number>; total: number; streak: number };

function loadMeta(): Meta {
  try {
    return JSON.parse(readFileSync(META, 'utf-8'));
  } catch {
    return { sizes: {}, total: 0, streak: 0 };
  }
}

function saveMeta(meta: Meta) {
  writeFileSync(META, JSON.stringify(meta, null, 2) + '\n');
}

// ─── Blockchain visualization ────────────────────────────────
function center(text: string, width: number): string {
  const pad = width - text.length;
  if (pad <= 0) return text.slice(0, width);
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + text + ' '.repeat(pad - left);
}

function printChain(blocks: { tag: string; bytes: number }[]) {
  const W = 12;
  const link = accent('━━━');
  const gap = '   ';
  const rows = ['', '', '', ''];

  for (let i = 0; i < blocks.length; i++) {
    const { tag, bytes } = blocks[i];
    const last = i === blocks.length - 1;

    rows[0] += dim(`╔${'═'.repeat(W)}╗`) + (last ? '' : gap);
    rows[1] += dim('║') + bold(center(tag, W)) + dim('║') + (last ? '' : link);
    rows[2] += dim('║') + dim(center(fmtBytes(bytes), W)) + dim('║') + (last ? '' : gap);
    rows[3] += dim(`╚${'═'.repeat(W)}╝`) + (last ? '' : gap);
  }

  console.log();
  for (const row of rows) console.log('  ' + row);
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
  const meta = loadMeta();

  // Header
  console.log();
  console.log(accent.bold(BRAND === 'yours' ? '  🌱 YOURS WALLET' : '  bWALLET'));
  console.log(dim(`  v${version}  ·  Chrome Extension  ·  ${new Date().toLocaleTimeString()}`));
  console.log(dim('  ' + '━'.repeat(40)));
  console.log();

  const results: { tag: string; bytes: number; ms: number }[] = [];
  const t0 = Date.now();

  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    const idx = dim(`[${i + 1}/${STEPS.length}]`);
    const done = spinner(`${idx} Building ${step.name}...`);
    const t = Date.now();

    const unmute = mute();
    try {
      await build({ configFile: resolve(root, step.cfg), logLevel: 'silent' });
      unmute();
    } catch (err) {
      // Unmute first, or the error printed below is swallowed and the build fails silently.
      unmute();
      done(`${fail('✗')} ${idx} ${step.name}  ${fail('FAILED')}`);
      throw err;
    }

    const ms = Date.now() - t;
    const bytes = measureOutputs(step.out);
    const time = dim(`${(ms / 1000).toFixed(1)}s`);
    const size = bold(fmtBytes(bytes));
    const diff = fmtDelta(bytes, meta.sizes[step.tag]);

    done(`${ok('✓')} ${idx} ${step.name}  ${time}  ${size}  ${diff}`);
    results.push({ tag: step.tag, bytes, ms });
  }

  brandManifest();

  const elapsed = Date.now() - t0;
  const totalBytes = results.reduce((sum, r) => sum + r.bytes, 0);
  const streak = meta.streak + 1;

  // Blockchain
  printChain(results);

  // Summary
  console.log();
  console.log(dim('  ' + '━'.repeat(40)));

  const totalDelta = meta.total ? fmtDelta(totalBytes, meta.total) : '';
  const timing = `${bold(`${(elapsed / 1000).toFixed(1)}s`)}`;
  const total = bold(fmtBytes(totalBytes));

  console.log([ok.bold('  ✓ Confirmed'), dim('in'), timing, dim('·'), total, totalDelta].filter(Boolean).join(' '));

  if (streak >= 10) {
    console.log(accent(`  🌳 Build streak: ${streak}`));
  } else if (streak >= 5) {
    console.log(accent(`  🌿 Build streak: ${streak}`));
  } else {
    console.log(dim(`  Build #${streak}`));
  }

  console.log();

  saveMeta({
    sizes: Object.fromEntries(results.map((r) => [r.tag, r.bytes])),
    total: totalBytes,
    streak,
  });
}

main().catch((err) => {
  showCursor();
  console.error(fail('\n  ✗ Build failed\n'));
  console.error(err);
  try {
    const meta = loadMeta();
    saveMeta({ ...meta, streak: 0 });
  } catch {
    // the build-streak file is optional; the build already failed
  }
  process.exit(1);
});
