import { beforeEach, describe, expect, test } from 'bun:test';
import { stubGlobals } from '../../testing/stubGlobals';

const mem = new Map<string, string>();
stubGlobals({
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  },
  window: new EventTarget(),
});

const {
  SIG_MAX_BYTES,
  canonicalSvg,
  getSignature,
  isValidSignature,
  signatureSha256,
  normalisePoints,
  polygonToPath,
  setSignature,
  signatureFromStrokes,
  simplifyPoints,
  strokesToPath,
  padSize,
  padToScreen,
  screenToPad,
} = await import('./signature');
type SigPoint = [number, number, number];

const scribble = (n: number, w: number, h: number): SigPoint[] =>
  Array.from({ length: n }, (_, i) => [
    (i / n) * w,
    h / 2 + Math.sin(i * 1.7) * h * 0.4 + Math.cos(i * 0.31) * h * 0.05,
    0.5,
  ]);

describe('card signature path', () => {
  test('normalises pad pixels to the 1000 × 250 box and clamps', () => {
    expect(
      normalisePoints(
        [
          [200, 50, 0.5],
          [400, 100, 0.5],
          [-5, 120, 1],
        ],
        400,
        100,
      ),
    ).toEqual([
      [500, 125, 0.5],
      [1000, 250, 0.5],
      [0, 250, 1],
    ]);
    expect(normalisePoints([[1, 1, 1]], 0, 100)).toEqual([]);
  });

  test('rounds to integers and clamps outlines', () => {
    expect(
      polygonToPath([
        [1.4, 2.6],
        [10.5, -3],
        [1200, 300.2],
      ]),
    ).toBe('M1 3L11 0L1000 250Z');
    expect(polygonToPath([[1, 1]])).toBe('');
  });

  test('a drawn stroke becomes a valid compact path', () => {
    const path = signatureFromStrokes([{ pen: false, points: scribble(60, 360, 90) }], 360, 90);
    expect(isValidSignature(path)).toBe(true);
    expect(path).not.toMatch(/\./);
    expect(signatureFromStrokes([], 360, 90)).toBe('');
  });

  test('simplify drops collinear points, keeps ends', () => {
    const line: SigPoint[] = Array.from({ length: 50 }, (_, i) => [i, i * 2, 0.5]);
    expect(simplifyPoints(line, 0.5)).toEqual([line[0], line[49]]);
    const v: SigPoint[] = [
      [0, 0, 0.5],
      [5, 10, 0.5],
      [10, 0, 0.5],
    ];
    expect(simplifyPoints(v, 1)).toEqual(v);
  });

  test('a huge drawing is simplified under the 8KB cap', () => {
    const strokes = Array.from({ length: 10 }, () => ({ pen: true, points: scribble(400, 800, 200) }));
    expect(
      strokesToPath(strokes.map((s) => ({ ...s, points: normalisePoints(s.points, 800, 200) }))).length,
    ).toBeGreaterThan(SIG_MAX_BYTES);
    const path = signatureFromStrokes(strokes, 800, 200);
    expect(path.length).toBeGreaterThan(0);
    expect(path.length).toBeLessThanOrEqual(SIG_MAX_BYTES);
    expect(isValidSignature(path)).toBe(true);
  });
});

describe('card signature storage', () => {
  beforeEach(() => mem.clear());

  test('round trip per account', () => {
    const a = signatureFromStrokes([{ pen: false, points: scribble(40, 400, 100) }], 400, 100);
    const b = signatureFromStrokes([{ pen: false, points: scribble(20, 400, 100) }], 400, 100);
    setSignature('1AAA', a, 1000);
    setSignature('1BBB', b, 2000);
    expect(getSignature('1AAA')).toEqual({
      svgPath: a,
      viewBox: '0 0 1000 250',
      createdAt: 1000,
      sha256: signatureSha256(a),
    });
    expect(getSignature('1BBB')?.svgPath).toBe(b);
    expect(getSignature('1CCC')).toBeNull();
    expect(getSignature(undefined)).toBeNull();
    setSignature('1AAA', '');
    expect(getSignature('1AAA')).toBeNull();
    expect(getSignature('1BBB')?.svgPath).toBe(b);
  });

  test('canonical SVG and hash are deterministic', () => {
    const strokes = [{ pen: false, points: scribble(40, 400, 100) }];
    const a = signatureFromStrokes(strokes, 400, 100);
    expect(signatureFromStrokes(strokes, 400, 100)).toBe(a);
    expect(canonicalSvg('M1 2L3 4Z')).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 250"><path d="M1 2L3 4Z"/></svg>',
    );
    expect(signatureSha256('M1 2L3 4Z')).toMatch(/^[0-9a-f]{64}$/);
    expect(signatureSha256('M1 2L3 4Z')).toBe(signatureSha256('M1 2L3 4Z'));
    expect(signatureSha256('M1 2L3 5Z')).not.toBe(signatureSha256('M1 2L3 4Z'));
  });

  test('corrupt or oversized data is ignored', () => {
    for (const bad of [
      '<script>alert(1)</script>',
      'M1 1L2 2',
      'M1.5 1L2 2Z',
      'M1 1L2 2Z" onload="x',
      'M1 1C2 2 3 3 4 4Z',
      'M1 1' + 'L2 2'.repeat(3000) + 'Z',
      '',
    ]) {
      mem.set('bwallet.signature.1AAA', JSON.stringify({ v: 1, svgPath: bad, createdAt: 1 }));
      expect(getSignature('1AAA')).toBeNull();
    }
    for (const raw of [
      'not json',
      '{}',
      'null',
      JSON.stringify({ v: 2, svgPath: 'M1 1L2 2Z', createdAt: 1 }),
      JSON.stringify({ v: 1, svgPath: 'M1 1L2 2Z', createdAt: 'x' }),
    ]) {
      mem.set('bwallet.signature.1AAA', raw);
      expect(getSignature('1AAA')).toBeNull();
    }
    setSignature('1AAA', 'garbage');
    expect(mem.has('bwallet.signature.1AAA')).toBe(false);
  });
});

describe('rotated signature pad (portrait)', () => {
  // Portrait phone: the 4:1 pad is drawn rotated, 160 px wide on screen and 640 px tall.
  const rotRect = { left: 100, top: 50, width: 160, height: 640 };
  const flatRect = { left: 10, top: 20, width: 640, height: 160 };

  test('rotated pad is 640 × 160 in its own space', () => {
    expect(padSize(rotRect, true)).toEqual({ w: 640, h: 160 });
    expect(padSize(flatRect, false)).toEqual({ w: 640, h: 160 });
  });

  test('corners: pad top-left is the screen top-right; pad x runs down the screen', () => {
    expect(screenToPad(260, 50, rotRect, true)).toEqual([0, 0]);
    expect(screenToPad(260, 690, rotRect, true)).toEqual([640, 0]);
    expect(screenToPad(100, 50, rotRect, true)).toEqual([0, 160]);
    expect(screenToPad(100, 690, rotRect, true)).toEqual([640, 160]);
  });

  test('rotate and back is the identity, both ways', () => {
    for (const rotated of [true, false]) {
      const r = rotated ? rotRect : flatRect;
      for (const [x, y] of [
        [0, 0],
        [123.5, 77],
        [640, 160],
        [320, 1],
      ] as const) {
        const [cx, cy] = padToScreen(x, y, r, rotated);
        const [bx, by] = screenToPad(cx, cy, r, rotated);
        expect(bx).toBeCloseTo(x, 9);
        expect(by).toBeCloseTo(y, 9);
      }
    }
  });

  test('the same stroke drawn rotated or flat saves the identical signature', () => {
    const local = scribble(60, 640, 160);
    const viaRot = local.map(([x, y, p]) => {
      const [cx, cy] = padToScreen(x, y, rotRect, true);
      const [px, py] = screenToPad(cx, cy, rotRect, true);
      return [px, py, p] as SigPoint;
    });
    const a = signatureFromStrokes([{ pen: false, points: local }], 640, 160);
    const s = padSize(rotRect, true);
    const b = signatureFromStrokes([{ pen: false, points: viaRot }], s.w, s.h);
    expect(a).not.toBe('');
    expect(b).toBe(a);
  });
});
