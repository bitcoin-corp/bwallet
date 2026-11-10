import validate from 'bitcoin-address-validation';
import { bcorpFeeAddress } from '../storeBuild';
import { P2PKH, type CreateActionArgs, type WalletInterface } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import { safety, type SafetyFilter } from '../market/safety';

/**
 * Mint (Wallet tab): pure helpers for the "Mint media" flow in MintButton.tsx.
 *
 * Creation fee: an extra, clearly labelled "bWallet mint fee" output is added
 * ONLY when the app is built with
 *   BWALLET_MINT_FEE_ADDRESS=1YourFeeAddress... pnpm cap:sync
 * (read in vite.config.mobile.ts). The default is EMPTY = no fee. Address only,
 * never a key. Mirrors src/mobile/market/fee.ts.
 */
declare const __MINT_FEE_ADDRESS__: string;

export const MINT_APP = 'bWallet';
export const MAX_MINT_BYTES = 10 * 1024 * 1024;
/** Photos above this are offered a downscale / re-encode. */
export const DOWNSCALE_SUGGEST_BYTES = 1024 * 1024;
export const MINT_FEE_RATE = 0.01;
/** Rough bytes for inputs, change, envelope + MAP + SIGMA around the body. */
/** BRC-217 adds to the inscription output: MAP identity_key pair (80 B) + | AIP address BITCOIN_ECDSA sig -1 (155 B). */
export const BRC217_BYTES = 240;
export const TX_OVERHEAD_BYTES = 900 + BRC217_BYTES; // inputs, change, fee output, issuer statement (~300 B), BRC-217
export const ACCEPT = 'image/*,video/*,audio/*,.glb,.gltf,.usdz';

// Store build: no fee to bCorp (storeBuild.ts).
const configured = bcorpFeeAddress(typeof __MINT_FEE_ADDRESS__ === 'string' ? __MINT_FEE_ADDRESS__.trim() : '');
export const mintFeeAddress = (address = configured): string => (address && validate(address) ? address : '');

// Media plus documents (books, PDFs, text) and single-page websites (owner, 6 Oct 2026: mint more than pictures).
export const isMintableType = (t: string) =>
  /^(image|video|audio)\//i.test(t) ||
  /^(application\/pdf|application\/epub\+zip|text\/plain|text\/markdown|text\/html)$/i.test(t) ||
  /^model\/(gltf-binary|gltf\+json|vnd\.usdz\+zip)$/i.test(t);

export type SizeCheck = { ok: true } | { ok: false; message: string };
export const checkSize = (bytes: number, max = MAX_MINT_BYTES): SizeCheck => {
  if (bytes <= 0) return { ok: false, message: 'That file is empty.' };
  if (bytes > max)
    return {
      ok: false,
      message: `That file is ${formatBytes(bytes)} — the limit is ${formatBytes(max)}. Pick a smaller file, or shrink the photo first.`,
    };
  return { ok: true };
};

export const formatBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

/** The 1% bWallet mint fee on a network fee (min 1 sat); 0 when no fee address is built in. */
export const mintFeeFor = (networkSats: number, feeAddress = configured): number =>
  mintFeeAddress(feeAddress) && networkSats > 0 ? Math.max(1, Math.ceil(networkSats * MINT_FEE_RATE)) : 0;

/** Network fee for one tx of about `bytes` (plus overhead) at `satsPerKb`, plus 1 sat per output. */
export const txFeeSats = (bytes: number, satsPerKb: number) =>
  Math.ceil(((bytes + TX_OVERHEAD_BYTES) * satsPerKb) / 1000) + 1;

export type Cost = { networkSats: number; feeSats: number; totalSats: number; usd: number | null; txCount: number };

/** Network fee ≈ (body + overhead) × sat/kB, plus 1 sat per output; ×2 txs when a new collection is created. */
export function estimateCost(
  bytes: number,
  satsPerKb: number,
  usdPerBsv = 0,
  opts: { newCollection?: boolean; feeAddress?: string } = {},
): Cost {
  const txCount = opts.newCollection ? 2 : 1;
  const networkSats = txFeeSats(bytes, satsPerKb) * txCount;
  const feeSats = mintFeeFor(networkSats, opts.feeAddress);
  const totalSats = networkSats + feeSats;
  return { networkSats, feeSats, totalSats, usd: usdPerBsv > 0 ? (totalSats / 1e8) * usdPerBsv : null, txCount };
}

export type Collection =
  | { kind: 'none' }
  | { kind: 'new'; name: string }
  | { kind: 'existing'; id: string; name: string };
export type MintForm = { title: string; description: string; collection: Collection };

/** MAP for a plain inscription (no collection). */
export function buildMap(f: MintForm): Record<string, string> {
  const map: Record<string, string> = { app: MINT_APP, type: 'ord', name: f.title.trim() };
  const d = f.description.trim();
  if (d) map.description = d;
  return map;
}

export function validateForm(f: MintForm, s: SafetyFilter = safety()): string | null {
  if (!f.title.trim()) return 'Add a title.';
  if (f.title.trim().length > 100) return 'Keep the title under 100 characters.';
  if (f.description.length > 1000) return 'Keep the description under 1000 characters.';
  if (f.collection.kind === 'new' && !f.collection.name.trim()) return 'Name the new collection.';
  if (blockedText(f, s)) return BLOCKED_MESSAGE;
  return null;
}

export const BLOCKED_MESSAGE = "This can't be minted in bWallet.";

/** Market safety keyword check over everything the user typed. */
export function blockedText(f: MintForm, s: SafetyFilter = safety()): boolean {
  const texts = [f.title, f.description];
  if (f.collection.kind !== 'none') texts.push(f.collection.name);
  return s.check({ ids: [], texts }).blocked;
}

/** Collection parent outpoint from mintCollection's "<txid>_0" (or txid). */
export const collectionIdFrom = (txid: string, id?: string) => id || `${txid}_0`;

export const wocTxUrl = (txid: string) => `https://whatsonchain.com/tx/${txid}`;

export const fileToBase64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * A context whose wallet appends one fee output to the NEXT createAction call
 * (the inscription tx; output 0 stays the inscription). Without a fee
 * address it returns the context unchanged.
 */
export function withFeeOutput(ctx: OneSatContext, feeSats: number, address = mintFeeAddress()): OneSatContext {
  if (!address || feeSats <= 0) return ctx;
  let done = false;
  const wallet = new Proxy(ctx.wallet as WalletInterface, {
    get(target, prop, receiver) {
      if (prop === 'createAction' && !done) {
        return (args: CreateActionArgs, originator?: string) => {
          done = true;
          const outputs = [
            ...(args.outputs ?? []),
            {
              lockingScript: new P2PKH().lock(address).toHex(),
              satoshis: feeSats,
              outputDescription: 'bWallet mint fee',
            },
          ];
          return target.createAction({ ...args, outputs }, originator);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ...ctx, wallet } as OneSatContext;
}

/** Wallet › NFTs (media) listens so a new mint shows up without a manual refresh. */
const listeners = new Set<() => void>();
export const onMinted = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const notifyMinted = () => listeners.forEach((fn) => fn());

/** Square-crop and shrink the icon to keep the inscription small. */
export const iconFile = async (file: File, edge = 256): Promise<File> => {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(edge, side);
  canvas
    .getContext('2d')!
    .drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Could not read this image');
  return new File([blob], 'icon.png', { type: 'image/png' });
};

/** Default title suggested from a picked file: its name without the extension, at most 100 characters. */
export const titleFromFileName = (fileName: string): string => fileName.replace(/\.\w+$/, '').slice(0, 100);

/**
 * Select the Title box's text on its first focus so typing replaces the file-name suggestion rather than
 * appending to it ("test-videobWalletX mint test"). Once the user has focused it, leave their caret alone.
 */
export const shouldSelectTitleOnFocus = (touched: boolean, title: string): boolean => !touched && title.length > 0;
