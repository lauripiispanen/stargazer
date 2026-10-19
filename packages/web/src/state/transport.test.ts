import { describe, expect, it } from 'vitest';
import { backoffMs, wsUrl } from './transport.ts';

describe('reconnect backoff', () => {
  it('grows and caps at 5 s', () => {
    expect(backoffMs(0)).toBe(400);
    expect(backoffMs(1)).toBeGreaterThan(backoffMs(0));
    expect(backoffMs(50)).toBe(5000);
  });
});

describe('WebSocket URL', () => {
  it('uses wss: on an https page and ws: on http', () => {
    expect(wsUrl({ protocol: 'https:', host: '192.168.1.5:8080' } as Location)).toBe('wss://192.168.1.5:8080/ws');
    expect(wsUrl({ protocol: 'http:', host: 'localhost:8080' } as Location)).toBe('ws://localhost:8080/ws');
  });
});
