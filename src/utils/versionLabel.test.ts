import { describe, expect, test } from 'bun:test';
import { cleanCommit, settingsBuildInfo, versionLabel } from './versionLabel';

describe('versionLabel', () => {
  test('release build shows the plain version', () => {
    expect(versionLabel('5.2.40', '')).toBe('5.2.40');
  });
  test('hotfix build shows the short commit', () => {
    expect(versionLabel('5.2.40', '131a723')).toBe('5.2.40 · hotfix 131a723');
  });
  test('never shows -dirty', () => {
    expect(versionLabel('5.2.40', '131a723-dirty')).toBe('5.2.40 · hotfix 131a723');
    expect(settingsBuildInfo('5.2.40', '131a723-dirty')).toBe('v5.2.40 · 131a723');
    expect(cleanCommit('abc1234')).toBe('abc1234');
  });
  test('settings line keeps the commit', () => {
    expect(settingsBuildInfo('5.2.40', '131a723')).toBe('v5.2.40 · 131a723');
  });
});
