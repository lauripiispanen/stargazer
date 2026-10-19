import { describe, expect, it } from 'vitest';
import { declutterLabels, dsoLabelMagLimit, starMagLimit } from './declutter.ts';

describe('declutterLabels', () => {
  it('places higher priority first and drops overlapping lower ones', () => {
    const placed = declutterLabels([
      { id: 'low', x: 100, y: 100, w: 40, h: 12, priority: 1, offsets: [[0, 0]] },
      { id: 'high', x: 105, y: 102, w: 40, h: 12, priority: 10, offsets: [[0, 0]] },
      { id: 'far', x: 300, y: 300, w: 40, h: 12, priority: 0, offsets: [[0, 0]] },
    ], 800, 600);
    expect(placed.map((p) => p.id).sort()).toEqual(['far', 'high']);
  });
  it('tries alternative offsets before giving up', () => {
    const placed = declutterLabels([
      { id: 'a', x: 100, y: 100, w: 40, h: 12, priority: 2 },
      { id: 'b', x: 100, y: 100, w: 40, h: 12, priority: 1 },
    ], 800, 600);
    expect(placed).toHaveLength(2);
  });
  it('respects obstacles and the viewport', () => {
    const placed = declutterLabels([
      { id: 'a', x: 10, y: 10, w: 40, h: 12, priority: 1, offsets: [[0, 0]] },
      { id: 'edge', x: 790, y: 10, w: 40, h: 12, priority: 1, offsets: [[0, 0]] },
    ], 800, 600, { obstacles: [{ id: 'o', x: 0, y: 0, w: 60, h: 30 }] });
    expect(placed).toHaveLength(0);
  });
  it('handles many labels quickly', () => {
    const c = Array.from({ length: 3000 }, (_, i) => ({ id: String(i), x: (i * 37) % 1280, y: (i * 53) % 800, w: 50, h: 12, priority: i % 7 }));
    const t = performance.now();
    const placed = declutterLabels(c, 1280, 800);
    expect(performance.now() - t).toBeLessThan(100);
    expect(placed.length).toBeGreaterThan(50);
  });
});

describe('zoom-dependent limits', () => {
  it('show fainter things when zoomed in', () => {
    expect(dsoLabelMagLimit(5)).toBeGreaterThan(dsoLabelMagLimit(60));
    expect(starMagLimit(2)).toBeGreaterThan(starMagLimit(100));
    expect(starMagLimit(0.5)).toBeLessThanOrEqual(8.5);
  });
});
