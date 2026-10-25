/**
 * The extension configs build with `resolve.preserveSymlinks: true`. A symlink inside
 * node_modules that points back at node_modules (or the repo) makes every package
 * reachable under endless paths (node_modules/node_modules/node_modules/...). Vite then
 * bundles each path as a separate module: the popup grows by megabytes and the service
 * worker build runs out of memory. A stray `ln -s <repo>/node_modules node_modules` run
 * while sitting in node_modules is enough to cause it.
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from 'fs';
import { join, relative, sep } from 'path';

/** Symlinks in node_modules (top level and @scope/*) that resolve to node_modules itself or one of its ancestors. */
export function findNodeModulesLoops(root: string): string[] {
  const nm = join(root, 'node_modules');
  if (!existsSync(nm)) return [];
  const nmReal = realpathSync(nm);
  const loops: string[] = [];
  const check = (path: string) => {
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return;
    }
    if (!st.isSymbolicLink()) return;
    let target: string;
    try {
      target = realpathSync(path);
    } catch {
      return; // dangling link: not a loop
    }
    if (target === nmReal || nmReal.startsWith(target + sep)) loops.push(relative(root, path));
  };
  for (const name of readdirSync(nm)) {
    const p = join(nm, name);
    check(p);
    if (name.startsWith('@')) {
      try {
        for (const sub of readdirSync(p)) check(join(p, sub));
      } catch {
        /* not a directory */
      }
    }
  }
  return loops;
}

/** Source-map entries that went through a node_modules loop. */
export function loopedSources(sources: string[]): string[] {
  return sources.filter((s) => /node_modules[\\/]+node_modules[\\/]/.test(s) && !/\.pnpm[\\/]/.test(s));
}
