import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findNodeModulesLoops, loopedSources } from '../scripts/lib/nodeModulesLoop';

describe('node_modules symlink loop guard', () => {
  test('finds node_modules/node_modules pointing back at node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'nmloop-'));
    mkdirSync(join(root, 'node_modules/real-pkg'), { recursive: true });
    mkdirSync(join(root, 'node_modules/@scope'), { recursive: true });
    symlinkSync(join(root, 'node_modules/real-pkg'), join(root, 'node_modules/alias'));
    expect(findNodeModulesLoops(root)).toEqual([]);
    symlinkSync(join(root, 'node_modules'), join(root, 'node_modules/node_modules'));
    symlinkSync(root, join(root, 'node_modules/@scope/up'));
    expect(findNodeModulesLoops(root).sort()).toEqual(['node_modules/@scope/up', 'node_modules/node_modules']);
  });

  test('flags looped source-map paths only', () => {
    expect(
      loopedSources([
        '../../node_modules/@bsv/sdk/dist/esm/src/primitives/Hash.js',
        '../../node_modules/.pnpm/a@1/node_modules/b/index.js',
        '../../node_modules/node_modules/node_modules/@bsv/sdk/dist/esm/src/primitives/Hash.js',
      ]),
    ).toEqual(['../../node_modules/node_modules/node_modules/@bsv/sdk/dist/esm/src/primitives/Hash.js']);
  });
});
