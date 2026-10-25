# Security policy: b-Aware

bWallet and bWalletX are non-custodial BSV wallets published by The Bitcoin Corporation Ltd. If you find a way to
take or spend someone's money, read their keys, or make the wallet sign something its owner did not approve, we want
to hear from you first, and we pay for it.

The full policy, the reward table and our responses to advisories live at **https://bwalletx.com/b-Aware**
(machine-readable: `/.well-known/security.txt`). This file is the short form of policy version 3 (25 October 2026).

## Report a vulnerability

- Check **https://bwalletx.com/bugs** first. Known and already-fixed issues are listed there and earn credit, not
  money. Still-unfixed security issues are not listed, for safety; if yours looks serious and is not there, report it
  privately as below.
- Email **support@bwalletx.com** with the subject line `b-Aware`. Put the full report in the mail; we do not need a
  video, we need steps we can run.
- If the finding would let an attacker move funds or read keys, say so in the subject so it is read first.
- Do not open a public GitHub issue for a security finding. Ordinary bugs go to
  https://github.com/bitcoin-corp/bwallet/issues.

We acknowledge within 2 working days, give you a severity and a fix plan within 7 days, and tell you when the fix ships.
With your permission we credit you on the b-Aware page.

## Rewards (paid in BSV)

| Severity | What it looks like in bWallet                                                                | Reward  |
| -------- | -------------------------------------------------------------------------------------------- | ------- |
| Critical | Steal or spend funds, extract keys or the recovery phrase, sign without the owner's approval | 10 BSV  |
| High     | Bypass an approval or permission, forge a pairing or connection, drain via a dApp endpoint   | 3 BSV   |
| Medium   | Leak private data, defeat the safety filter, deny a user their own wallet                    | 0.5 BSV |
| Low      | Real but contained                                                                           | Credit  |

The reward pool is **20 BSV per calendar quarter**. First valid report of an issue wins; duplicates, issues we already
know about and issues listed under "Known and accepted" on the b-Aware page earn credit, not money. When the quarter's
pool is spent, valid reports still get credit and are paid from the next quarter's pool, in order. Severity is ours to
set, by impact on users' money and keys; we explain the reasoning in writing.

Rewards are paid in BSV to an address you give us, within 30 days of the fix being live on every channel (including
the App Store and Chrome Web Store) or 60 days after we confirm your report, whichever is first. We pay in one batch
each month. Reports received before 25 October 2026 keep the earlier terms: 14 days from the fix shipping or 30 days
from triage.

We pay people we can name, and we record every payout: who, which address, how much, and the transaction. Under
1 BSV, a stable handle and a paymail or address is enough. For 1 BSV or more (every High and Critical), we need your
real name and country before we pay; the reward is held for you until you send them. Your name stays private unless
you ask to be credited by it. Anonymous reporters still get credit, but not payments of 1 BSV or more.

## Scope

In scope: key handling, signing and approvals (`src/background.ts`, `src/services/`, `src/security/`), storage and
backup, the BRC-100 dApp bridge (`src/inject.ts`, `src/content.ts`, `src/mobile/dappBrowser.ts`, the hub), paymail,
OpNS names, the mobile apps, the extension and the web wallet.

Out of scope: the marketing sites, rate limiting, self-XSS, findings that need a rooted or jailbroken device or
physical access, social engineering of our staff or users, automated scanner output without a working reproduction,
and third-party services we do not run (indexers, exchanges, the Yours Wallet upstream).

## Safe harbour

Research done in good faith under this policy is authorised. We will not pursue or support legal action against you
for it, and if a third party does, we will say so publicly. Good faith means: test against your own wallets and funds,
do not access, modify or destroy anyone else's data or money, do not degrade the service for others, and give us a
reasonable time to fix before you publish. We will not ask you to sign anything to get paid.

## Advisories

Our responses to published advisories that touch BRC-100 wallets, the BSV TypeScript stack or our dependencies are
listed, dated, on https://bwalletx.com/b-Aware#advisories.
