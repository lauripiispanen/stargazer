import { describe, expect, it } from 'vitest';
import { backoffMs } from './transport.ts';

describe('reconnect backoff', () => {
  it('grows and caps at 5 s', () => {
    expect(backoffMs(0)).toBe(400);
    expect(backoffMs(1)).toBeGreaterThan(backoffMs(0));
    expect(backoffMs(50)).toBe(5000);
  });
});
