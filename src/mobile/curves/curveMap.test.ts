import { expect, test } from 'bun:test';
import { curveMapFields, curveMapScript } from './curveMap';
import { preset, verifyCurve } from '../../lib/curves';

test('curve MAP fields verify', () => {
  const f = curveMapFields(preset('standard'));
  const rec: Record<string, string> = {};
  for (let i = 0; i < f.length; i += 2) rec[f[i]] = f[i + 1];
  expect(rec.type).toBe('curve');
  expect(verifyCurve(rec).ok).toBe(true);
  expect(curveMapScript(preset('standard')).toHex().startsWith('006a')).toBe(true);
});
