import { describe, expect, it } from 'bun:test';
import { DRAWER_NAME_CHIPS, drawerNames } from './drawerNames';

describe('drawerNames', () => {
  it('keeps the drawer short for an account with hundreds of names', () => {
    const names = Array.from({ length: 800 }, (_, i) => `name${i}`);
    const r = drawerNames(names, 'name500');
    expect(r.chips.length).toBe(DRAWER_NAME_CHIPS);
    expect(r.chips[0]).toBe('name500');
    expect(r.total).toBe(800);
    expect(r.more).toBe(true);
  });
  it('shows no picker for one name', () => {
    expect(drawerNames(['solo'], 'solo')).toEqual({ chips: [], total: 1, more: false });
  });
  it('shows all names when few', () => {
    expect(drawerNames(['a', 'b'], 'b')).toEqual({ chips: ['b', 'a'], total: 2, more: false });
  });
});
