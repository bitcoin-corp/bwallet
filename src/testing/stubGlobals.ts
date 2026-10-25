import { afterAll } from 'bun:test';

/**
 * Install browser-ish globals (window, document, localStorage, WebSocket…) for ONE test file and put the previous
 * values back when that file finishes. `bun test` runs every file in one process, so a stub left on globalThis
 * leaks into whichever file runs next. A leaked plain-object `window` made `fake-indexeddb/auto` install
 * indexedDB on that stub instead of globalThis ("indexedDB is not defined"), and a leaked `document` broke the
 * theme tests. Call it at module level (before importing code that reads the globals at load time).
 */
export function stubGlobals(values: Record<string, unknown>): void {
  const g = globalThis as Record<string, unknown>;
  const saved = Object.keys(values).map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  for (const [k, v] of Object.entries(values)) {
    Object.defineProperty(g, k, { value: v, writable: true, configurable: true, enumerable: true });
  }
  afterAll(() => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  });
}

/**
 * For files that swap globals inside their own tests or hooks: remember the named globals as they are when the file
 * loads and put them back when the file finishes.
 */
export function keepGlobals(...names: string[]): void {
  const g = globalThis as Record<string, unknown>;
  const saved = names.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  afterAll(() => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  });
}
