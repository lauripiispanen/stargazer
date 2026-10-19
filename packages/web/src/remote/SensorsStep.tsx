// Phone remote "Sensors" step: the phone lies on the tube and its gravity sensor + compass measure where the
// tube points, replacing "level the tube, point it north, press Home". Stars then refine the model.
import { useEffect, useState } from 'react';
import { baseTilt, expectedFirstStarErrorDeg, GOOD_HEADING_ALT_DEG, MAX_SENSOR_ALT_DEG, sensorHome, type SensorCapture, type SensorHome } from '@stargazer/shared/sensors.ts';
import type { useAlignWizard } from '../state/alignWizard.ts';
import { useTubeSensors } from '../state/useTubeSensors.ts';
import { compassPoint } from '../lib/format.ts';
import { Icon, KV, Section } from '../panels/ui.tsx';
import { HomeSummary } from '../panels/HomeSummary.tsx';
import { RemotePad } from './RemotePad.tsx';

type Wizard = ReturnType<typeof useAlignWizard>;
type Stage = 'intro' | 'live' | 'capturing' | 'review' | 'sent';

const CAPTURE_MS = 3000;
const signed = (d: number, digits = 1) => `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(digits)}°`;

/** Side view: tube on the mount, phone flat on top, its top edge toward the open (sky) end. */
function PlacementDiagram() {
  return (
    <svg className="sensor-diagram" viewBox="0 0 320 150" role="img" aria-label="Phone flat on top of the tube, top edge toward the sky end">
      <g transform="rotate(-18 160 95)">
        <rect x="40" y="80" width="230" height="36" rx="6" fill="none" stroke="currentColor" strokeWidth="2" />
        <rect x="262" y="76" width="14" height="44" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
        <text x="290" y="102" fontSize="11" fill="currentColor">sky</text>
        <rect x="26" y="88" width="14" height="20" rx="2" fill="none" stroke="currentColor" opacity="0.6" />
        {/* phone */}
        <rect x="120" y="68" width="90" height="12" rx="3" fill="var(--accent)" opacity="0.85" />
        <rect x="200" y="70" width="6" height="8" rx="1.5" fill="currentColor" opacity="0.5" />
        <path d="M150 58 L215 58" stroke="var(--accent)" strokeWidth="2" markerEnd="url(#sg-arrow)" />
        <text x="118" y="52" fontSize="11" fill="currentColor">top edge →</text>
      </g>
      <path d="M150 128 L150 146 M120 146 L180 146" stroke="currentColor" strokeWidth="2" opacity="0.6" />
      <text x="2" y="112" fontSize="11" fill="currentColor" opacity="0.7">eyepiece end</text>
      <defs>
        <marker id="sg-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--accent)" />
        </marker>
      </defs>
    </svg>
  );
}

function StabilityMeter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone = value > 0.8 ? 'ok' : value > 0.4 ? 'warn' : 'bad';
  return (
    <div className="stability" aria-label={`Stability ${pct}%`}>
      <div className="stability-bar"><div className={`stability-fill ${tone}`} style={{ width: `${pct}%` }} /></div>
      <span className="small dim">{value > 0.8 ? 'steady' : value > 0.4 ? 'settling…' : 'moving'}</span>
    </div>
  );
}

export function SensorsStep({ w, goTo }: { w: Wizard; next: () => void; goTo: (id: string) => void }) {
  const s = useTubeSensors(w.loc);
  const [stage, setStage] = useState<Stage>('intro');
  const [cap, setCap] = useState<SensorCapture | null>(null);
  const [home, setHome] = useState<SensorHome | null>(null);
  const [showPad, setShowPad] = useState(false);
  const [levelCheck, setLevelCheck] = useState(false);
  const [progress, setProgress] = useState(0);
  const fakeBlocked = !!s.fake && w.mount != null && !w.mount.simulator;
  const r = s.live.reading;
  const trueAz = r?.magHeadingDeg != null ? (((r.magHeadingDeg + s.declinationDeg) % 360) + 360) % 360 : null;
  const tooSteep = r != null && Math.abs(r.altDeg) > MAX_SENSOR_ALT_DEG;
  const homeIsSensors = w.al?.home?.source === 'sensors';

  useEffect(() => {
    if (stage === 'sent' && w.quality !== 'none' && homeIsSensors) s.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, w.quality, homeIsSensors]);

  const startSensors = async () => {
    await s.start();
    setStage('live');
  };

  const doCapture = async () => {
    setStage('capturing');
    setProgress(0);
    const t0 = Date.now();
    const timer = setInterval(() => setProgress(Math.min(1, (Date.now() - t0) / CAPTURE_MS)), 100);
    const c = await s.capture(CAPTURE_MS);
    clearInterval(timer);
    setCap(c);
    if (c.ok) {
      setHome(sensorHome(c, s.declinationDeg));
      setStage('review');
    } else setStage('live');
  };

  const send = () => {
    if (!home) return;
    w.setHomeFromSensors(home);
    setStage('sent');
  };

  const locNote = w.loc.label?.startsWith('Default') || !w.locKnown
    ? <div className="note warn small">Set your location first (Settings): the compass correction (declination) depends on it.</div> : null;

  // ---- after Home: remove the phone, continue with stars
  if (stage === 'sent' && homeIsSensors && w.quality !== 'none') {
    return (
      <Section title="Home set from the phone" className="r-card sensors-step">
        <HomeSummary home={w.al?.home} />
        <ol className="howto small">
          <li>Take the phone off the tube (or leave it taped on: it does no harm).</li>
          <li>Continue with the stars: GoTo the first one, find it in the finder, centre it and press <b>Centred</b>.</li>
        </ol>
        <button className="btn primary r-btn wide" onClick={() => w.setStep(2)}>Continue with stars <Icon name="chevronR" /></button>
      </Section>
    );
  }

  return (
    <>
      <Section title="Auto-align with phone sensors" className="r-card sensors-step">
        {s.fake && <div className="note warn small"><b>FAKE SENSORS</b> (dev): reading the simulator's true pointing with {s.fake.headingErrDeg}° compass and {s.fake.altErrDeg}° altitude error.</div>}
        {fakeBlocked && <div className="note bad small">Fake sensors only work with the simulator. Remove <span className="mono">?fakeSensors</span> from the address.</div>}
        {stage === 'intro' && (
          <>
            <PlacementDiagram />
            <ol className="howto small">
              <li>Lay this phone <b>flat on top of the tube</b>, screen up, with its <b>top edge toward the open (sky) end</b>. Tape it or hold it so it can't slide.</li>
              <li>Keep the tube <b>below ~{GOOD_HEADING_ALT_DEG}°</b> (near level is best for the compass) and the cable unwrapped.</li>
              <li>Tap <b>Start sensors</b>{s.fake ? '' : ' and allow motion & orientation access'}.</li>
            </ol>
            {locNote}
            <button className="btn primary r-btn wide" disabled={fakeBlocked} onClick={() => void startSensors()}><Icon name="compass" /> Start sensors</button>
            <button className="btn ghost r-btn wide" onClick={() => goTo('home')}>Level &amp; north by hand instead</button>
          </>
        )}
        {stage !== 'intro' && (
          <>
            {s.status === 'denied' && <div className="note bad small">Motion &amp; orientation access was denied. On iPhone: Settings › Safari › Motion &amp; Orientation Access, then reload. Or level &amp; north by hand.</div>}
            {s.status === 'unsupported' && <div className="note bad small">This browser has no orientation sensors here (it needs HTTPS: <span className="mono">npm run start:lan:https</span>).</div>}
            {s.status === 'no-data' && <div className="note warn small">No sensor readings yet. Is this a phone? Desktop browsers have no orientation sensors.</div>}
            {s.error && <div className="note bad small">{s.error}</div>}
            <div className="sensor-readout">
              <div className="sr-big">
                <span className="sr-label small dim">Tube altitude</span>
                <span className={`sr-val mono ${tooSteep ? 'txt-bad' : ''}`}>{r ? `${r.altDeg.toFixed(1)}°` : '—'}</span>
              </div>
              <div className="sr-big">
                <span className="sr-label small dim">Heading (true)</span>
                <span className="sr-val mono">{trueAz != null ? `${trueAz.toFixed(1)}° ${compassPoint(trueAz)}` : r ? 'no compass' : '—'}</span>
              </div>
            </div>
            <KV k="Magnetic heading" mono v={r?.magHeadingDeg != null ? `${r.magHeadingDeg.toFixed(1)}°` : '—'} />
            <KV k="Declination" mono v={`${signed(s.declinationDeg)} ${s.declinationDeg >= 0 ? 'E' : 'W'} (WMM2025${s.inValidity ? '' : ', outside 2025–2030'})`} />
            <KV k="Phone roll on tube" mono v={r ? `${r.rollDeg.toFixed(0)}°` : '—'} />
            {r?.accuracyDeg != null && <KV k="Compass accuracy" mono v={r.accuracyDeg < 0 ? 'needs calibration' : `±${r.accuracyDeg.toFixed(0)}°`} />}
            <StabilityMeter value={s.live.stability} />
            {tooSteep && <div className="note bad small">The tube is too steep ({r!.altDeg.toFixed(0)}°): lower it below {MAX_SENSOR_ALT_DEG}° (the compass can't tell the direction near the zenith).</div>}
            {r && !tooSteep && Math.abs(r.altDeg) > GOOD_HEADING_ALT_DEG && <div className="note warn small">Lower the tube toward level for a better compass reading.</div>}
            {r && Math.abs(r.rollDeg) > 45 && <div className="note warn small">The phone is tipped {r.rollDeg.toFixed(0)}° sideways: lay it flat on top of the tube.</div>}
            {s.live.jumpDeg > 3 && <div className="note warn small">The heading jumps ({s.live.jumpDeg.toFixed(0)}°) while the tube is still: magnetic interference. Keep the motors still and the phone away from steel; try a spot further along the tube.</div>}
            {s.live.fieldWarning && <div className="note warn small">{s.live.fieldWarning}.</div>}
            {r && r.headingSource == null && <div className="note warn small">This browser gives no compass heading: only the altitude is measured. Point the tube <b>north</b> by eye first; Home then assumes north (±10°).</div>}
            {r && ((r.accuracyDeg != null && (r.accuracyDeg < 0 || r.accuracyDeg > 15)) || (cap?.problems.some((p) => /compass/.test(p)))) && (
              <div className="note warn small">Compass accuracy is poor: take the phone off, wave it slowly in a <b>figure-8</b> a few times, then put it back.</div>
            )}
            {locNote}
            {cap && !cap.ok && stage === 'live' && <div className="note bad small">Capture rejected: {cap.problems.join('; ')}. Hands off and try again.</div>}

            {stage === 'review' && home && cap ? (
              <div className="confirm-inline sensor-review">
                <div>
                  The tube points <b>{Math.abs(home.altDeg).toFixed(1)}° {home.altDeg >= 0 ? 'up' : 'DOWN'}</b> (±{home.altSigmaDeg.toFixed(1)}°)
                  {cap.magHeadingDeg != null ? <>, toward <b>{home.azDeg.toFixed(0)}° {compassPoint(home.azDeg)}</b> (±{home.azSigmaDeg.toFixed(0)}°)</> : <>, assumed <b>north</b> (±{home.azSigmaDeg.toFixed(0)}°)</>}.
                  Does that look right?
                </div>
                {home.altDeg < -3 && <div className="note warn small">Below level? If the tube actually points <b>up</b>, the phone is the wrong way round: its top edge must face the sky end.</div>}
                {cap.warnings.length > 0 && <div className="dim small">{cap.warnings.join('; ')}.</div>}
                <div className="dim small">{cap.n} readings over {CAPTURE_MS / 1000} s; spread alt {cap.altStdDeg.toFixed(2)}°{cap.headingStdDeg != null ? `, heading ${cap.headingStdDeg.toFixed(1)}°` : ''}. Expect the first star within ~{expectedFirstStarErrorDeg(home) ?? 10}°.</div>
                <div className="row-actions">
                  <button className="btn r-btn" onClick={() => { setCap(null); setStage('live'); }}>Retake</button>
                  <span className="btn-wrap" title={w.homeBlock ?? ''}>
                    <button className="btn primary r-btn" disabled={!!w.homeBlock} onClick={send}><Icon name="check" /> Set Home from sensors</button>
                  </span>
                </div>
                <div className="dim small">Any existing alignment is replaced.</div>
              </div>
            ) : stage === 'capturing' ? (
              <div className="note settling" role="status">
                <span className="spinner" aria-hidden />
                <span><b>Capturing…</b> hands off the telescope ({Math.round(progress * CAPTURE_MS / 1000 * 10) / 10} / {CAPTURE_MS / 1000} s)</span>
              </div>
            ) : (
              <>
                <span className="btn-wrap r-full" title={w.homeBlock ?? (tooSteep ? 'Lower the tube' : '')}>
                  <button className="btn primary r-btn wide" disabled={!r || tooSteep || !!w.homeBlock || fakeBlocked} onClick={() => void doCapture()}>
                    <Icon name="target" /> Capture ({CAPTURE_MS / 1000} s, hold still)
                  </button>
                </span>
                {w.homeBlock && <div className="dim small block-reason">{w.homeBlock}</div>}
              </>
            )}
            {stage === 'sent' && !homeIsSensors && <div className="note small">Sending…</div>}
          </>
        )}
      </Section>

      {stage !== 'intro' && (
        <Section title="Optional" className="r-card">
          <div className="dim small">Point the tube roughly north and near level with the pad first: the compass works best there, and the first GoTos are shorter.</div>
          <div className="row-actions">
            <button className="btn r-btn" onClick={() => setShowPad(!showPad)}><Icon name="gamepad" /> {showPad ? 'Hide' : 'Show'} slew pad</button>
            <button className="btn r-btn" onClick={() => setLevelCheck(!levelCheck)}><Icon name="gauge" /> Tripod level check</button>
          </div>
          {levelCheck && <LevelCheck raw={s.live.raw} />}
        </Section>
      )}
      {showPad && stage !== 'intro' && <RemotePad compact />}
    </>
  );
}

/** Bonus: phone flat on the mount base (not the tube) shows how far the base is from level. */
function LevelCheck({ raw }: { raw: { beta: number | null; gamma: number | null } | null }) {
  if (!raw || raw.beta == null || raw.gamma == null) return <div className="dim small">Waiting for sensor readings…</div>;
  const t = baseTilt(raw.beta, raw.gamma);
  const sides = ['top edge', 'right edge', 'bottom edge', 'left edge'];
  const side = sides[Math.round(t.downhillDeg / 90) % 4];
  return (
    <div className="level-check">
      <div className="dim small">Lay the phone flat on the mount base (the part that turns in azimuth), not on the tube.</div>
      <KV k="Base tilt" mono v={<span className={t.tiltDeg < 0.5 ? 'txt-ok' : t.tiltDeg < 1.5 ? 'txt-warn' : 'txt-bad'}>{t.tiltDeg.toFixed(1)}°</span>} />
      {t.tiltDeg >= 0.3 && <div className="small">Low side: toward the phone's <b>{side}</b>. Lengthen that leg (or shorten the opposite one).</div>}
      {t.tiltDeg < 0.3 && <div className="small txt-ok">Level.</div>}
    </div>
  );
}
