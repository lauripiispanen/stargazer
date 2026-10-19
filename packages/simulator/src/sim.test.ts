import { describe, expect, it } from 'vitest';
import { AuxCmd, AuxDevice, encodeGuideRate, encodePosition } from '@stargazer/shared/aux.ts';
import { Simulator } from './sim.ts';

const req = (dst: number, cmd: number, data: number[] = []) => ({ src: AuxDevice.APP, dst, cmd, data: Uint8Array.from(data) });

/** Step a simulator with a virtual clock. */
function virtual(sim: Simulator) {
  let t = 1e9;
  sim.clock = () => t;
  sim.advance();
  return (seconds: number) => {
    for (let i = 0; i < Math.round(seconds * 20); i++) {
      t += 50;
      sim.advance();
    }
  };
}

describe('Simulator physics', () => {
  it('GOTO_FAST follows a trapezoid capped at max rate, and reports SLEW_DONE', () => {
    const sim = new Simulator({ maxRateDeg: 3, accelDeg: 4 });
    const run = virtual(sim);
    sim.az.goto(30, true);
    let peak = 0;
    for (let i = 0; i < 20 * 15; i++) {
      run(0.05);
      peak = Math.max(peak, Math.abs(sim.az.velocity));
    }
    expect(peak).toBeCloseTo(3, 5);
    expect(sim.az.encoder).toBeCloseTo(30, 4);
    expect(sim.az.slewing).toBe(false);
  });

  it('MOVE rate 0 aborts a goto; guide rate superposes', () => {
    const sim = new Simulator();
    const run = virtual(sim);
    sim.alt.goto(40, true);
    run(2);
    sim.alt.move(1, 0);
    run(2);
    expect(sim.alt.slewing).toBe(false);
    const stopped = sim.alt.encoder;
    expect(stopped).toBeLessThan(10);
    const { cmd, data } = encodeGuideRate(-36); // 0.01°/s down
    sim.handle(req(AuxDevice.ALT, cmd, data));
    run(10);
    expect(sim.alt.encoder).toBeCloseTo(stopped - 0.1, 2);
  });

  it('cordwrap makes AZM take the long way round', () => {
    const sim = new Simulator();
    const run = virtual(sim);
    sim.handle(req(AuxDevice.AZM, AuxCmd.SET_CORDWRAP_POS, encodePosition(5)));
    sim.handle(req(AuxDevice.AZM, AuxCmd.ENABLE_CORDWRAP));
    sim.handle(req(AuxDevice.AZM, AuxCmd.GOTO_FAST, encodePosition(10)));
    run(1);
    expect(sim.az.velocity).toBeLessThan(0); // heading 0 -> 359 -> ... -> 10
  });

  it('power cycle zeroes encoders but keeps the physical orientation', () => {
    const sim = new Simulator();
    const run = virtual(sim);
    sim.az.goto(20, true);
    run(15);
    sim.powerCycle();
    expect(sim.az.encoder).toBeCloseTo(0, 6);
    expect(sim.az.pos).toBeCloseTo(20, 4);
    expect(sim.truth().encoder.az).toBeCloseTo(0, 6);
  });

  it('answers only known devices/commands', () => {
    const sim = new Simulator();
    expect(sim.handle(req(AuxDevice.GPS, AuxCmd.GET_VER))).toBeNull();
    expect(sim.handle(req(AuxDevice.ALT, AuxCmd.ENABLE_CORDWRAP))).toBeNull();
    expect(sim.handle(req(AuxDevice.AZM, 0x81))).toBeNull();
    expect(Array.from(sim.handle(req(AuxDevice.AZM, AuxCmd.GET_POS_BACKLASH))!.data)).toEqual([0]);
  });
});
