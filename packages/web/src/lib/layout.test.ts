import { describe, expect, it } from 'vitest';
import { chooseLayout, type LayoutEnv, stripLayoutParams } from './layout.ts';

const laptop: LayoutEnv = { search: '', stored: null, width: 1440, height: 900, coarse: false, hover: true };
const phone: LayoutEnv = { search: '', stored: null, width: 390, height: 844, coarse: true, hover: false };

describe('chooseLayout', () => {
  it('picks by device', () => {
    expect(chooseLayout(laptop)).toBe('desktop');
    expect(chooseLayout(phone)).toBe('remote');
    expect(chooseLayout({ ...phone, width: 844, height: 390 })).toBe('remote'); // phone in landscape
    expect(chooseLayout({ ...laptop, width: 650 })).toBe('remote'); // narrow desktop window
    expect(chooseLayout({ ...phone, width: 1024, height: 768 })).toBe('desktop'); // tablet keeps the sky map
    expect(chooseLayout({ ...laptop, coarse: true, hover: true })).toBe('desktop'); // touch laptop with a mouse
  });

  it('honours the saved toggle, and URL params above all', () => {
    expect(chooseLayout({ ...phone, stored: 'desktop' })).toBe('desktop');
    expect(chooseLayout({ ...laptop, stored: 'remote' })).toBe('remote');
    expect(chooseLayout({ ...laptop, stored: 'desktop', search: '?remote' })).toBe('remote');
    expect(chooseLayout({ ...phone, stored: 'remote', search: '?mock&desktop' })).toBe('desktop');
    expect(chooseLayout({ ...laptop, search: '?remote=1' })).toBe('remote');
  });
});

describe('stripLayoutParams', () => {
  it('removes only the layout params', () => {
    expect(stripLayoutParams('http://x:8080/?remote')).toBe('/');
    expect(stripLayoutParams('http://x:8080/?mock&desktop&night#a')).toBe('/?mock&night#a');
    expect(stripLayoutParams('http://x:8080/?select=M31&remote=1')).toBe('/?select=M31');
  });
});
