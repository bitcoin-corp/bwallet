import type { SheetModel } from './permissionBundle';

/**
 * Which approval card a request gets (owner-approved designs, 11 Oct 2026). Users don't read, so each
 * kind looks different: SIGN IN (gold key), CONNECT (wallet ↔ site), PAY (the dollar amount), MINT
 * (the bAvatar), CAREFUL (red, the safe answer is the big button).
 */
export type ApprovalKind = 'signin' | 'connect' | 'pay' | 'mint' | 'careful' | 'post' | 'private';

export interface ApprovalContext {
  /**
   * The site's current monthly allowance in sats, if it has one. A payment that still reaches a sheet
   * while an allowance exists did not fit inside it.
   */
  existingAllowanceSats?: number;
}

/** True when this sheet's payment goes past the site's monthly allowance. */
export const isOverAllowance = (model: Pick<SheetModel, 'payment'>, ctx: ApprovalContext = {}): boolean =>
  !!model.payment && ctx.existingAllowanceSats !== undefined;

/**
 * The card for a one-sheet bundle. Risk wins over everything; then a first post (POST, its cost shown); then
 * payment; then sign-in, private data, or connect.
 */
export const approvalKindForSheet = (
  model: Pick<SheetModel, 'lines' | 'payment' | 'mode'> & Partial<Pick<SheetModel, 'purpose'>>,
  ctx: ApprovalContext = {},
): ApprovalKind => {
  if (model.lines.some((l) => l.risky)) return 'careful';
  if (isOverAllowance(model, ctx)) return 'careful';
  if (model.purpose === 'post') return 'post';
  if (model.payment) return 'pay';
  if (model.lines.length > 0 && model.lines.every(isSignInLine)) return 'signin';
  if (model.lines.length > 0 && model.lines.every((l) => l.signIn || l.privateLabel)) return 'private';
  return 'connect';
};

/**
 * Sign-in style: a real sign-in (a signature anyone can check, the public identity key, or a sign-in protocol).
 * A key for the site with counterparty self is NOT a sign-in ("bchatx agent history" encrypts your Ask b chats).
 */
const isSignInLine = (l: SheetModel['lines'][number]): boolean => l.signIn === true;

/** "Keep your Ask b chats private": the label for a PRIVATE card (first private line's label). */
export const privateTitleLabel = (model: Pick<SheetModel, 'lines'>): string =>
  model.lines.find((l) => l.privateLabel)?.privateLabel ?? 'data';

/** "bchatx.com" → "bchatx"; "www.app.example.co.uk" → "app.example". Display only. */
export const siteName = (originator: string): string => {
  const host = originator
    .replace(/^[a-z]+:\/\//i, '')
    .split(/[/:?#]/)[0]
    .replace(/^www\./i, '');
  const parts = host.split('.');
  if (parts.length <= 1) return host;
  const drop = parts.length > 2 && parts[parts.length - 2].length <= 3 ? 2 : 1;
  return parts.slice(0, parts.length - drop).join('.') || host;
};
