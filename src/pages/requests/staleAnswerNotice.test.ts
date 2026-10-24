import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Found clicking through the sheets in a real Chrome (24 Oct 2026): when a line joined while the user's tap was
// in flight, the background refused the answer but the popup closed ~10 ms later (the denied requests settling
// ran closeDappPopupIfIdle), so "This request changed while you were answering…" was never seen.
const root = join(import.meta.dir, '..', '..');
const background = readFileSync(join(root, 'background.ts'), 'utf8');
const sheet = readFileSync(join(root, 'pages', 'requests', 'BundleSheet.tsx'), 'utf8');

describe('a stale answer is explained, not closed away', () => {
  it('the background does not close the window itself after a stale answer', () => {
    const tail = background.slice(background.indexOf("error: 'This request changed while you were answering"));
    const close = tail.slice(0, tail.indexOf('closeDappPopupIfNoUi();'));
    expect(close.endsWith('if (!result.stale) ')).toBe(true);
  });
  it('the hold starts as soon as the answer is found stale, before any denied request settles', () => {
    const fn = background.slice(background.indexOf('const processBundlePermissionResponse'));
    const hold = fn.indexOf('if (result.stale) holdPopupOpenUntil = Date.now() + STALE_NOTICE_MS;');
    expect(hold).toBeGreaterThan(0);
    expect(hold).toBeLessThan(fn.indexOf('const work = '));
  });
  it('nothing auto-closes the popup while the notice is up', () => {
    for (const fn of ['const closeDappPopupIfNoUi = ', 'const closeDappPopupIfIdle = ']) {
      const at = background.indexOf(fn);
      expect(background.slice(at, background.indexOf('};', at))).toContain(
        'if (Date.now() < holdPopupOpenUntil) return;',
      );
    }
  });
  it('the sheet holds its error on screen before moving on', () => {
    const at = sheet.indexOf('addSnackbar(res.error');
    expect(at).toBeGreaterThan(0);
    expect(sheet.slice(at, sheet.indexOf('onResponse();', at))).toContain('ANSWER_ERROR_HOLD_MS');
  });
});
