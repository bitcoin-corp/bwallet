/**
 * Memepool (TX Blaster, txblaster.xyz/memepool) trading: the numbers this wallet pins in code. THIS FOLDER MOVES
 * MONEY (it is on .github/money-paths.txt): change only with the owner's money-ok review.
 *
 * Owner, 25 Oct 2026 ("yes to all three", docs/MEMEPOOL-TRADING-DESIGN.md): native buy/sell with a 1 BSV cap per
 * trade and 3% default slippage; refuse coins whose proof of reserves row isn't healthy.
 *
 * Read from https://txblaster.xyz/memepool/api/config on 25 Oct 2026. If their /config ever says something else,
 * trading refuses until we update these deliberately: a server can't move the fee or the fee address on its own.
 */
export const MEMEPOOL_API = 'https://txblaster.xyz/memepool/api';
export const MEMEPOOL_PROOF_URL = 'https://txblaster.xyz/memepool/proof.html';

/** Where Memepool's share of the fee goes (their /config `platformAddress`). */
export const PLATFORM_ADDRESS = '1JhfTxnm8YeYHPdXHFYZFaw2aSQrRtB6aa';
/** Total trade fee, in basis points of the BSV side: 1.25%. */
export const FEE_BPS = BigInt(125);
/** The creator's part of that fee: 0.30%. Memepool keeps the other 0.95%. */
export const CREATOR_BPS = BigInt(30);

/** The most one trade may move: 1 BSV (owner, 25 Oct 2026; the design proposed 20). */
export const CAP_SATS = BigInt(100_000_000);
/** Memepool's own smallest buy (their /config `minBuySats`). */
export const MIN_BUY_SATS = BigInt(10_000);
/** Default "price can move by": 3%. */
export const DEFAULT_SLIPPAGE_BPS = 300;
export const SLIPPAGE_CHOICES = [100, 300, 500, 1000] as const;
/** The slippage a user may pick, at most. Anything above is clamped. */
export const MAX_SLIPPAGE_BPS = 1000;

/** Indexer fee: 1,000 sats per token output (their `indexFeePerOutput`), and never more than this per trade. */
export const INDEX_FEE_PER_OUTPUT = 1_000;
export const MAX_INDEX_FEE = 5_000;
/** The most network (miner) fee a trade may cost the user. Their template pays 0.5 sat/byte: ~150 to ~1,500 sats. */
export const NETWORK_ALLOWANCE = 4_000;
/** What a sell's own network fee may take from the payout before slippage (their trade.js uses the same). */
export const SELL_NETWORK_RESERVE = 1_500;
/** Rebate slack per creator fee-share output on a sell: the shares give back what their own bytes cost. */
export const SHARE_REBATE_SLACK = 150;

/** A quote's life in this wallet when Memepool doesn't say (their templates go stale within seconds anyway). */
export const QUOTE_TTL_MS = 60_000;

/** Their template format version this verifier understands. */
export const TEMPLATE_VERSION = 1;
/** SIGHASH_ALL | SIGHASH_FORKID: the only signature type this wallet ever makes for a Memepool trade. */
export const SIGHASH_ALL_FORKID = 0x41;

/** Most inputs/outputs a sane trade template has (their sells use up to 8 user + 40 pool coins). */
export const MAX_TEMPLATE_INPUTS = 64;
export const MAX_TEMPLATE_OUTPUTS = 32;
