// Remote "Align" tab: the alignment wizard for a phone. Same logic as the desktop AlignPanel (useAlignWizard);
// suggested stars become a list with GoTo / Centred, and the slew pad is inline where it's needed.
//
// Steps are a registry so new ones slot in without touching the rest. "Sensors" (SensorsStep.tsx: the phone on
// the tube measures altitude with gravity and heading with the compass) shares wizard phase 1 with the manual
// "Level & north" Home step; it is listed only where the page can read the sensors (secure context +
// DeviceOrientationEvent, or ?fakeSensors in development).
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../state/store.ts';
import { useAlignWizard, suggestionToObject } from '../state/alignWizard.ts';
import { autoSlewBlocked, sunIsUp } from '../lib/safety.ts';
import { compassPoint, fmtDeg, fmtDuration } from '../lib/format.ts';
import { fmtLocation } from '../lib/location.ts';
import { Icon, KV, Pill, Section } from '../panels/ui.tsx';
import { RemotePad } from './RemotePad.tsx';
import { SensorsStep } from './SensorsStep.tsx';
import { sensorsAvailable } from '../state/useTubeSensors.ts';
import { HomeSummary } from '../panels/HomeSummary.tsx';
import { expectedFirstStarErrorDeg } from '@stargazer/shared/sensors.ts';

type Wizard = ReturnType<typeof useAlignWizard>;

export interface AlignStep {
  id: string;
  label: string;
  /** Which shared wizard phase it belongs to (0 location, 1 level & north, 2 stars). */
  wizardStep: 0 | 1 | 2;
  /** Hide the step when the device can't do it (e.g. sensors without HTTPS). */
  available?: () => boolean;
  done: (w: Wizard) => boolean;
  Body: (props: StepProps) => React.ReactNode;
}

export interface StepProps {
  w: Wizard;
  next: () => void;
  /** Jump to another step by id (e.g. Sensors <-> manual Home). */
  goTo: (id: string) => void;
}

function LocationStep({ w, next }: StepProps) {
  const skew = useStore((s) => s.clockSkewMs);
  return (
    <Section title="Check location and time" className="r-card">
      <KV k="Location" v={fmtLocation(w.loc)} />
      {!w.locKnown && <div className="note warn small">The server has no location yet: set it in <b>Settings</b>. Alignment needs it.</div>}
      <KV k="Time" mono v={new Date(w.now).toLocaleTimeString()} />
      {skew != null && Math.abs(skew) > 30000 && <div className="note bad small">The laptop clock differs from this phone by {fmtDuration(skew)}. Fix the laptop clock first.</div>}
      <div className="row-actions">
        <button className="btn r-btn" onClick={() => useStore.getState().setRemoteTab('settings')}><Icon name="pin" /> Change</button>
        <button className="btn primary r-btn" disabled={!w.locKnown} onClick={next}>Looks right <Icon name="chevronR" /></button>
      </div>
    </Section>
  );
}

function HomeStep({ w, goTo }: StepProps) {
  const [confirm, setConfirm] = useState(false);
  const canSensors = sensorsAvailable();
  return (
    <>
      <Section title="Level the tube, point it north" className="r-card">
        {canSensors ? (
          <button className="btn r-btn wide" onClick={() => goTo('sensors')}><Icon name="phone" /> Use this phone's sensors instead</button>
        ) : (
          <div className="note dim small">Tip: a phone on the tube can do this step automatically (compass + gravity), but its sensors need HTTPS: restart the laptop server with <span className="mono">npm run start:lan:https</span>.</div>
        )}
        <ol className="howto small">
          <li>Slew until the tube is <b>level</b> (a phone inclinometer app on the tube helps).</li>
          <li>Turn it to point <b>north</b> (Polaris at night; a phone compass is ~1–2° off near metal).</li>
          <li>Check the power cable hangs <b>unwrapped</b>.</li>
          <li>Press <b>Home</b>. GoTos are rough until you add stars.</li>
        </ol>
        {w.mount?.encoder && <KV k="Encoders" mono v={`az ${w.mount.encoder.az.toFixed(2)}°  alt ${w.mount.encoder.alt.toFixed(2)}°`} />}
      </Section>
      <RemotePad compact />
      <div className="r-card">
        {!confirm ? (
          <span className="btn-wrap r-full" title={w.homeBlock ?? ''}>
            <button className="btn primary r-btn wide" disabled={!!w.homeBlock} onClick={() => setConfirm(true)}><Icon name="compass" /> Home: level &amp; pointing north</button>
          </span>
        ) : (
          <div className="confirm-inline">
            <div>Set the encoders' reference here? Any existing alignment is replaced.</div>
            <div className="row-actions">
              <button className="btn r-btn" onClick={() => setConfirm(false)}>Cancel</button>
              <button className="btn primary r-btn" disabled={!!w.homeBlock} onClick={() => { w.setHome(); setConfirm(false); }}>Yes, set Home</button>
            </div>
          </div>
        )}
        {w.homeBlock && <div className="dim small block-reason">{w.homeBlock}</div>}
      </div>
    </>
  );
}

function StarsStep({ w }: StepProps) {
  const catalog = useStore((s) => s.catalog);
  const scrollIntoView = useCallback((el: HTMLElement | null) => el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), []);
  const { al, quality, suggestions, chosen, capture, centredBlock, gotoRunning, mount } = w;
  return (
    <>
      <Section title={`Star ${(al?.points.length ?? 0) + 1}`} className="r-card">
        {quality === 'none' && <div className="note warn small">Do “Home” first: GoTo needs to know where level and north are.</div>}
        {quality === 'rough' && al?.home?.source === 'sensors' && (al.points.length ?? 0) === 0 && (
          <div className="note small">Home came from the phone compass: expect the first star within ~{expectedFirstStarErrorDeg(al.home) ?? 10}°. Find it in the finder, then centre it.</div>
        )}
        <div className="dim small">GoTo a suggested star, centre it in the eyepiece with the pad below (finish with UP and RIGHT), then press <b>Centred</b>.</div>
        <ul className="r-suggest">
          {suggestions.map((s, i) => {
            const o = suggestionToObject(s, catalog?.namedStars);
            const on = chosen?.name === s.name;
            const block = w.blocker({ kind: 'radec', ra: s.ra, dec: s.dec, name: s.name });
            return (
              <li key={s.name + i} className={on ? 'on' : ''}>
                <div className="r-sg-row">
                  <span className="sg-n mono">{i + 1}</span>
                  <div className="r-sg-main">
                    <b>{s.name}</b>
                    <span className="dim small mono">mag {s.mag.toFixed(1)} · {fmtDeg(s.alt, 0)} {compassPoint(s.az)}</span>
                  </div>
                  <span className="btn-wrap" title={block ?? `GoTo ${s.name}`}>
                    <button className="btn r-btn" disabled={!!block || gotoRunning} onClick={() => { w.choose(o); w.slewTo(o); }}><Icon name="target" /> GoTo</button>
                  </span>
                  <span className="btn-wrap" title={centredBlock ?? `Record ${s.name} at the current position`}>
                    <button className="btn primary r-btn" disabled={!!centredBlock} onClick={() => { w.choose(o); w.centred(o); }}><Icon name="check" /> Centred</button>
                  </span>
                </div>
                {on && w.slewed === o.key && gotoRunning && <div className="dim small">slewing…</div>}
                {on && !gotoRunning && mount?.target?.name === o.name && <div className="txt-ok small">arrived{mount.tracking ? ' · tracking' : ''}: centre it, then press Centred</div>}
              </li>
            );
          })}
          {suggestions.length === 0 && <li className="dim small">No bright stars between 20° and {w.maxAlt}° right now{sunIsUp(w.sun.alt, w.limits) ? ' (it is daytime)' : ''}.</li>}
        </ul>
        {w.slewBlock && autoSlewBlocked(w.sun.alt, quality, w.limits) && <div className="note small">{w.slewBlock} Find the star manually with the pad, then press Centred.</div>}
        {capture && (
          <div className="note settling" role="status" ref={scrollIntoView}>
            <span className="spinner" aria-hidden />
            <span><b>Settling…</b> hands off. {capture.name} is recorded once the mount has been still for {(capture.settleMs / 1000).toFixed(1)} s.</span>
          </div>
        )}
        {!capture && centredBlock && w.connected && quality !== 'none' && <div className="dim small">{centredBlock}</div>}
      </Section>
      <RemotePad compact />
      <Section title="Model" className="r-card" right={al && al.points.length > 0 ? <button className="btn small ghost" onClick={() => w.send({ type: 'alignClear' })}><Icon name="trash" size={13} /> Clear</button> : undefined}>
        {al && al.points.length > 0 ? (
          <ul className="r-points">
            {al.points.map((p, i) => (
              <li key={p.id}>
                <span className="mono dim">{i + 1}</span>
                <span className="r-pt-name">{p.target.name}</span>
                <span className={`mono ${p.residualArcmin != null && p.residualArcmin > 15 ? 'txt-warn' : ''}`}>{p.residualArcmin != null ? `${p.residualArcmin.toFixed(1)}′` : '—'}</span>
                <button className="icon-btn" aria-label={`Remove ${p.target.name}`} onClick={() => w.send({ type: 'alignRemovePoint', id: p.id })}><Icon name="x" size={14} /></button>
              </li>
            ))}
          </ul>
        ) : <div className="dim small">No stars yet.</div>}
        {al?.rmsArcmin != null && <KV k="RMS" mono v={`${al.rmsArcmin.toFixed(2)}′`} />}
        <div className="note dim small">1 star: rough · 2 stars: good · 3+: best.</div>
        <HomeSummary home={al?.home} compact />
      </Section>
    </>
  );
}

export const ALIGN_STEPS: AlignStep[] = [
  { id: 'location', label: 'Location', wizardStep: 0, done: (w) => w.step > 0 && w.locKnown, Body: LocationStep },
  { id: 'sensors', label: 'Sensors', wizardStep: 1, available: sensorsAvailable, done: (w) => w.quality !== 'none' && w.al?.home?.source === 'sensors', Body: SensorsStep },
  { id: 'home', label: 'Level & north', wizardStep: 1, done: (w) => w.quality !== 'none' && w.al?.home?.source !== 'sensors', Body: HomeStep },
  { id: 'stars', label: 'Stars', wizardStep: 2, done: (w) => (w.al?.points.length ?? 0) > 0, Body: StarsStep },
];

export function AlignTab() {
  const w = useAlignWizard();
  const steps = ALIGN_STEPS.filter((s) => !s.available || s.available());
  const [stepId, setStepId] = useState<string>(() => steps.find((s) => s.wizardStep === w.step)?.id ?? steps[0]!.id);
  const cur = steps.find((s) => s.id === stepId) ?? steps[0]!;
  const go = (s: AlignStep) => { setStepId(s.id); w.setStep(s.wizardStep); };
  const next = () => { const i = steps.indexOf(cur); if (i < steps.length - 1) go(steps[i + 1]!); };
  const goTo = (id: string) => { const s = steps.find((x) => x.id === id); if (s) go(s); };
  // the wizard can move on by itself (Home sets step 2; "Use as alignment star" jumps to stars)
  useEffect(() => {
    const auto = steps.find((s) => s.wizardStep === w.step);
    if (auto && auto.wizardStep !== cur.wizardStep) setStepId(auto.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.step]);
  return (
    <div className="r-tab-body">
      <div className="r-card r-align-head">
        <div className="r-align-title">
          <b>Alignment</b>
          <Pill tone={w.quality === 'aligned' ? 'ok' : w.quality === 'rough' ? 'warn' : 'bad'}>{w.quality}{w.al?.rmsArcmin != null ? ` · ${w.al.rmsArcmin.toFixed(1)}′` : ''}</Pill>
        </div>
        <div className="steps r-steps">
          {steps.map((s, i) => (
            <button key={s.id} className={`step ${s.id === cur.id ? 'on' : ''} ${s.done(w) ? 'done' : ''}`} onClick={() => go(s)}>
              <span className="step-n">{s.done(w) ? <Icon name="check" size={12} /> : i + 1}</span>{s.id === 'home' && steps.some((x) => x.id === 'sensors') ? 'By hand' : s.label}
            </button>
          ))}
        </div>
        {!w.connected && <div className="note warn small">Connect to the telescope first (Control tab).</div>}
      </div>
      <cur.Body w={w} next={next} goTo={goTo} />
    </div>
  );
}
