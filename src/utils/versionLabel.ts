/**
 * User-facing version strings. The build stamps `__BUILD_COMMIT__` (with "-dirty" when built from a tree
 * with uncommitted changes) and `__BUILD_HOTFIX__` (the short commit when the build is not the release
 * commit, '' otherwise). Users never see "-dirty"; error reports and scripts/verify-build.ts keep it.
 */

/** The commit without the internal "-dirty" marker. */
export const cleanCommit = (commit: string): string => commit.replace(/-dirty$/, '');

/** "5.2.40", or "5.2.40 · hotfix 131a723" for a build between releases. */
export const versionLabel = (version: string, hotfix: string): string => {
  const h = cleanCommit(hotfix.trim());
  return h ? `${version} · hotfix ${h}` : version;
};

/** Settings footer: "v5.2.40 · 131a723". */
export const settingsBuildInfo = (version: string, commit: string): string => `v${version} · ${cleanCommit(commit)}`;

/** The running app's version: the extension manifest, or the mobile shim's manifest; 'dev' when neither exists. */
export const manifestVersion = (): string =>
  typeof chrome !== 'undefined' && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : 'dev';

/** The label shown under the b on the unlock and start screens. */
export const appVersionLabel = (): string =>
  versionLabel(manifestVersion(), typeof __BUILD_HOTFIX__ === 'string' ? __BUILD_HOTFIX__ : '');
