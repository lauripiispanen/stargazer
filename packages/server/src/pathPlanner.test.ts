import { describe, expect, it } from 'vitest';
import { candidatePlans, moveDisplacement, moveDuration, simulate, splitLegs } from './pathPlanner.ts';

const k = { vmax: 3, accel: 3 };

describe('pathPlanner', () => {
  it('trapezoid durations and displacement', () => {
    expect(moveDuration(30, k)).toBeCloseTo(11, 6); // 10 s cruise + 1 s accel/decel overhead
    expect(moveDuration(1, k)).toBeCloseTo(2 / Math.sqrt(3), 6);
    expect(moveDisplacement(-30, k, 100)).toBe(-30);
    expect(moveDisplacement(30, k, 5.5)).toBeCloseTo(15, 6);
  });

  it('splits azimuth travel into legs of at most maxLeg', () => {
    const legs = splitLegs({ az: 0, alt: 0 }, [{ az: 350, alt: 20 }], 170);
    expect(legs).toHaveLength(3);
    expect(legs.map((l) => l.az)).toEqual([350 / 3, 700 / 3, 350]);
    expect(legs[0]!.alt).toBe(20);
    expect(legs[1]!.alt).toBeUndefined();
  });

  it('simulates sequential steps', () => {
    const { poses, legDurations } = simulate({ az: 0, alt: 0 }, [{ alt: 10 }, { az: 20 }], k);
    expect(poses.at(-1)).toEqual({ az: 20, alt: 10 });
    expect(legDurations).toHaveLength(2);
    expect(poses.every((p) => p.alt === 10 || p.az === 0)).toBe(true); // alt finishes before az starts
  });

  it('orders candidates and respects the wrap range', () => {
    const names = candidatePlans({ az: 150, alt: 10 }, { az: 200, alt: 30 }, { azRange: [-200, 200], waypointAlt: 10 }).map((p) => p.name);
    expect(names[0]).toBe('simultaneous');
    expect(names).toContain('alt-first (other way)'); // 150 -> -160 is inside ±200
    const tight = candidatePlans({ az: 150, alt: 10 }, { az: 250, alt: 30 }, { azRange: [-200, 200], waypointAlt: 10 });
    expect(tight.every((p) => p.steps.every((s) => s.az === undefined || s.az === -110))).toBe(true); // +250 exceeds the wrap
  });
});
