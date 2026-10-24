import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { resolve } from 'path';
import { execSync } from 'child_process';

const gitCommit = (() => {
  try {
    const hash = execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    // -uno: only tracked-file changes count as dirty, matching `git describe --dirty`
    const dirty = execSync('git status --porcelain -uno', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return dirty ? `${hash}-dirty` : hash;
  } catch {
    return 'unknown';
  }
})();

// The release commit is the last one that changed package.json's "version" line. Any other HEAD (a web
// deploy between releases) is a hotfix build, labelled with its short commit; '' when HEAD is the release
// or git is missing.
const buildHotfix = (() => {
  try {
    const run = (cmd: string) =>
      execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    const head = run('git rev-parse --short=7 HEAD');
    const release = run(`git log -1 -G'"version"' --format=%h --abbrev=7 -- package.json`);
    if (!head || !release) return '';
    return head.startsWith(release) || release.startsWith(head) ? '' : head;
  } catch {
    return '';
  }
})();

// three's DRACOLoader (Market › 3D viewer, src/mobile/three3d/gltfLoader.ts) brings its decoder files in with
// new URL(..., import.meta.url), and Vite emits them as soon as the module is transformed, even when the lazy
// 3D chunk is dropped. A store build has no 3D viewer: drop the orphaned decoder files (about 1.3 MB) too.
const STORE_BUILD =
  process.env.VITE_STORE_BUILD === '1' || ['ios-store', 'android-play'].includes(process.env.VITE_CHANNEL ?? '');
export const dropDracoInStore = (): Plugin => ({
  name: 'bwallet-drop-draco-in-store',
  apply: 'build',
  generateBundle(_, bundle) {
    if (!STORE_BUILD) return;
    for (const k of Object.keys(bundle)) if (/(^|\/)draco_(decoder|wasm_wrapper)[-.]/.test(k)) delete bundle[k];
  },
});

// bMint Notes (src/mobile/bmint) is not in a store build (BMINT_NOTES_ENABLED drops its lazy chunks), but Vite
// still emits the assets those chunks imported: the 11 note images and the designer's fonts. Drop them too,
// unless some chunk that stayed still references the file.
const BMINT_NOTE_ASSET =
  /(^|\/)(note-\d+(-thumb)?|bangers-400|bebas-neue-400|ibm-plex-mono-(400|600)|oswald|permanent-marker-400|space-grotesk)-[\w-]{8}\.(webp|woff2)$/;
export const dropBmintNotesInStore = (): Plugin => ({
  name: 'bwallet-drop-bmint-notes-in-store',
  apply: 'build',
  generateBundle(_, bundle) {
    if (!STORE_BUILD) return;
    const code = Object.values(bundle)
      .map((o) => (o.type === 'chunk' ? o.code : typeof o.source === 'string' ? o.source : ''))
      .join('\n');
    for (const k of Object.keys(bundle)) {
      if (BMINT_NOTE_ASSET.test(k) && !code.includes(k.split('/').pop()!)) delete bundle[k];
    }
  },
});

// Main config for popup/extension pages
export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    dropDracoInStore(),
    dropBmintNotesInStore(),
    nodePolyfills({
      include: ['buffer', 'process', 'util', 'stream', 'crypto', 'assert', 'url', 'path'],
      globals: {
        Buffer: true,
        process: true,
      },
    }),
  ],
  resolve: {
    alias: {
      path: 'path-browserify',
      'xdelta3-wasm': resolve(__dirname, 'src/stubs/empty.ts'),
    },
    preserveSymlinks: true,
  },
  publicDir: 'public',
  build: {
    outDir: 'build',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'sweep-tab': resolve(__dirname, 'sweep-tab.html'),
        'prompt-tab': resolve(__dirname, 'prompt.html'),
        'usb-tab': resolve(__dirname, 'usb.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
      onwarn(warning, warn) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
        if (warning.message?.includes('externalized for browser')) return;
        if (warning.code === 'CIRCULAR_DEPENDENCY') return;
        if (warning.message?.includes('while both modules are dependencies of each other')) return;
        warn(warning);
      },
    },
    sourcemap: true,
  },
  define: {
    'process.env': {},
    __BUILD_COMMIT__: JSON.stringify(gitCommit),
    __BUILD_HOTFIX__: JSON.stringify(buildHotfix),
  },
});
