/**
 * The readable registry behind services/reservedProtocols.ts (security audit 19 Oct 2026, C1). Only tests import
 * this file: the runtime checks hashes, so store builds never carry the names of store-hidden features
 * (release-bwallet STORE-AUDIT). reservedProtocols.test.ts checks the hashes match this list and scans src so a
 * new internal protocol fails the tests until it is classified here.
 */

type Protocol = readonly [number, string];

/** Protocols only the wallet itself may use. Default for anything the wallet derives keys under. */
export const RESERVED_PROTOCOLS: readonly Protocol[] = [
  // Funds, ordinals, Locks, vesting, NFT ownership, deposit keys (@1sat ONESAT_PROTOCOL / P1SAT_PROTOCOL).
  [0, 'onesat'],
  // xInvites vault keys (src/mobile/chat/xInvites.ts).
  [0, 'bwx xinvites'],
  // bTrust owner / heir keys (src/mobile/btrust/inheritance.ts).
  [1, 'btrust'],
  // Token registry manifest signer (src/mobile/exchange/registry/manifest.ts).
  [1, 'bsv tokens manifest'],
  // The wallet's identity signatures (chat signer, name proofs, identity map).
  [1, 'message signing'],
  // Pre-signed payments / pots / subscriptions (src/mobile/presign/keys.ts).
  [2, 'bwalletx presign'],
  // bChatX / bit-sign sign-in for the wallet itself (src/mobile/auth/authApi.ts).
  [2, 'bwalletx auth'],
  [2, 'bwalletx business agent'],
  [2, 'bwallet calls'],
  // dns-dex.com domain token requests (src/mobile/domains/dnsdex.ts): an app must not sign these as the user.
  [2, 'dnsdex domain'],
  // bDNSx domain link record (src/mobile/domains/bdnsx.ts): the signature in _bdnsx.<domain> that links it to the user.
  [2, 'bdnsx link'],
  [2, 'bwallet issuer'],
  [2, 'bwallet paymail'],
  [2, 'bwallet agreement'],
  [2, 'bwx partnership'],
  [2, 'bwx escrow'],
  [2, 'bwx commission terms'],
  [2, 'bshares director'],
  [2, 'bshares treasury'],
  [2, 'bshares partner'],
  [2, 'bshares lock'],
  [2, 'bitsign kyc certificate'],
  [2, 'bitsign investor self cert'],
  [2, 'bitsign share offer event'],
  [2, 'bitsign account delete'],
  [2, 'bitsign handle claim'],
  [2, 'bmail'],
  [2, 'bmusic session'],
  [2, 'bmusic artist'],
  [2, 'bmusic listen claim'],
  [2, 'bpositive'],
];

/**
 * Protocols the wallet uses that outside apps legitimately need too. Still prompted (never auto-granted),
 * and hashToDirectlySign is refused for the ones in NO_RAW_HASH.
 */
export const EXTERNAL_OK: readonly (readonly [number, string, string])[] = [
  [2, 'bwallet sign in', 'Sign in with bWalletX (bwalletx-connect, bit-sign, bChatX)'],
  [0, 'fwetch identity', 'bit-sign fwetch feed signatures'],
  [2, '3241645161d8', 'BRC-29 payments: every BRC-100 payer derives these keys'],
];
