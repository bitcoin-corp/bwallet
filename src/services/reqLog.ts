/**
 * `[bwx-req]` trace lines in the service worker (TokenBlaster, 25 Oct 2026: a site waited on "open the extension to
 * approve" and neither console said anything). One short line per step: request received, locked/unlocked, prompt
 * queued, open attempted (surface), opened/failed (error), answered/timed out.
 *
 * Non-secret by construction: only the fields below are ever printed. Never keys, amounts, params or payloads; the
 * origin is cut to its host and the error to its first 120 characters.
 */
export type ReqLogFields = {
  method?: string;
  origin?: string;
  surface?: 'popup' | 'window' | 'side panel' | 'in-page sheet' | 'panel overlay' | 'existing window';
  kind?: string;
  locked?: boolean;
  step?: string;
  error?: unknown;
};

const hostOf = (origin: string): string => {
  try {
    return new URL(origin.includes('://') ? origin : `https://${origin}`).host || origin.slice(0, 80);
  } catch {
    return origin.slice(0, 80);
  }
};

export function reqLogLine(event: string, f: ReqLogFields = {}): string {
  const parts = [`[bwx-req] ${event}`];
  if (f.method) parts.push(`method=${String(f.method).slice(0, 48)}`);
  if (f.origin) parts.push(`origin=${hostOf(String(f.origin))}`);
  if (f.kind) parts.push(`kind=${String(f.kind).slice(0, 32)}`);
  if (f.locked !== undefined) parts.push(f.locked ? 'locked' : 'unlocked');
  if (f.surface) parts.push(`surface=${f.surface}`);
  if (f.step) parts.push(`(${String(f.step).slice(0, 80)})`);
  if (f.error !== undefined) {
    const m = f.error instanceof Error ? f.error.message : String(f.error);
    parts.push(`error=${m.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  return parts.join(' ');
}

export function bwxReq(event: string, f?: ReqLogFields): void {
  try {
    console.log(reqLogLine(event, f));
  } catch {
    /* never let a log line break a request */
  }
}
