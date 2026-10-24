/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WOC_API_KEY: string;
  /** '1' = App Store / Google Play build (src/mobile/storeBuild.ts). */
  readonly VITE_STORE_BUILD?: string;
  readonly VITE_CHANNEL?: string;
  readonly VITE_NRT?: string;
  /** bMint note studio allow-list: identity pubkeys or identity addresses, comma-separated (bmint/lib/studioAccess.ts). */
  readonly VITE_BMINT_STUDIO_KEYS?: string;
  readonly VITE_OFFERS?: string;
  readonly VITE_OPNS_FEE_ADDRESS?: string;
  /** Live chat relay base URL (src/mobile/chat/live.ts); default https://rt.b0ase.com. */
  readonly VITE_RT_URL?: string;
  /** '0' = build without the live chat stream. */
  readonly VITE_LIVE_CHAT?: string;
  /** bMusic server base URL (src/mobile/media/stream/api.ts). */
  readonly VITE_BMUSIC_URL?: string;
  /** '1' = show the bMusic artist programme (off by default; needs the server). */
  readonly VITE_ARTIST_PROGRAMME?: string;
  /** '1' = ask the fee pot to pay network fees (off by default; needs the server). */
  readonly VITE_FEE_POT?: string;
  /** '1' = show "Find people you follow on X" (off by default; needs bit-sign #295 turned on). */
  readonly VITE_X_FOLLOWS_IMPORT?: string;
  /** '1' = passkey seed backup prototype + /passkey-check (off by default; never in store builds). */
  readonly VITE_SEEDLESS?: string;
  /** Test builds only: shows the on-screen restore trace. */
  readonly VITE_SEEDLESS_TRACE?: string;
  /** Passkey seed backup store (default bit-sign /api/bitsign/passkey-backups on www.bchatx.com). */
  readonly VITE_PASSKEY_BACKUP_URL?: string;
  /** Pairing relay host for "open on computer" (default relay.bwallet.space). */
  readonly VITE_PAIR_RELAY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
