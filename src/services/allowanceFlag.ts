/**
 * Envelopes replace allowances (owner, 24 Oct 2026: "replace allowances with envelopes for now").
 *
 * Standing allowances, caps and grants were the biggest source of payment-safety holes. With this flag off (the
 * default) no stored spending grant, monthly allowance or streaming grant ever approves a payment without a sheet;
 * the only silent spends are from a site's envelope (services/envelopes.ts), and only up to its balance.
 *
 * The old allowance code is kept behind this flag for ideas that may want it later. Turning it on brings back the
 * monthly allowance line on sheets, the stored spending grants and the streaming grants exactly as they were.
 */
export const ALLOWANCES_ENABLED = false as boolean;
