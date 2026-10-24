/**
 * One spend at a time per device, across every path that checks an account's daily cap (checkAgentSpend):
 * paired-CLI/agent actions (pair/agentPairing.ts) and pot standing orders (pots/payDue.ts). The cap check reads
 * the activity log, and the log entry lands only after signing and broadcast, so two spends running side by side
 * could each pass the cap while together going over it (b-Aware reports 18 Oct 2026 and 24 Oct 2026).
 * Run the check, the sign and the log append inside `serialSpend`.
 */
let queue: Promise<unknown> = Promise.resolve();

export const serialSpend = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
};
