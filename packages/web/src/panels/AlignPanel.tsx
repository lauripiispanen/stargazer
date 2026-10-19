import { useCallback, useMemo, useState } from 'react';
import type { PointingModelParams } from '@stargazer/shared/api.ts';
import { useStore } from '../state/store.ts';
import { useAlignWizard } from '../state/alignWizard.ts';
import { autoSlewBlocked, sunIsUp } from '../lib/safety.ts';
import { compassPoint, fmtDeg, fmtDuration } from '../lib/format.ts';
import { fmtLocation } from '../lib/location.ts';
import { centerOnAltAz } from '../sky/viewControl.ts';
import { Section, Icon, Pill, KV } from './ui.tsx';
import { HomeSummary } from './HomeSummary.tsx';
import { expectedFirstStarErrorDeg } from '@stargazer/shared/sensors.ts';

const QUALITY_TEXT = '1 star: rough (GoTos land within a degree or two) · 2 stars: good (tilt solved) · 3+ stars: best (collimation too, with residuals)';

function Steps({ step, setStep, quality, points }: { step: number; setStep: (n: number) => void; quality: string; points: number }) {
  const labels = ['Location & time', 'Level & north', 'Stars'];
  return (
    <div className="steps">
      {labels.map((l, i) => {
        const done = i === 0 ? step > 0 : i === 1 ? quality !== 'none' : points > 0;
        return (
          <button key={l} className={`step ${step === i ? 'on' : ''} ${done ? 'done' : ''}`} onClick={() => setStep(i)}>
            <span className="step-n">{done ? <Icon name="check" size={12} /> : i + 1}</span>{l}
          </button>
        );
      })}
    </div>
  );
}

function Compass({ az }: { az: number | null }) {
  return (
    <svg className="compass" viewBox="-50 -50 100 100" width="96" height="96" aria-label="Compass hint">
      <circle r="44" fill="none" stroke="currentColor" opacity="0.3" />
      {['N', 'E', 'S', 'W'].map((c, i) => (
        <text key={c} x={Math.sin((i * Math.PI) / 2) * 34} y={-Math.cos((i * Math.PI) / 2) * 34 + 4} textAnchor="middle" fontSize="11" fill={c === 'N' ? 'var(--bad)' : 'currentColor'} fontWeight="700">{c}</text>
      ))}
      <g transform={`rotate(${az ?? 0})`}>
        <path d="M0 -26 L6 4 L0 0 L-6 4 Z" fill="var(--accent)" />
        <path d="M0 26 L5 -2 L-5 -2 Z" fill="currentColor" opacity="0.35" />
      </g>
    </svg>
  );
}

export function AlignPanel() {
  const w = useAlignWizard();
  const { mount, al, quality, step, setStep, connected, locKnown, limits, loc, now, sun, suggestions, capture, chosen, choose, chooseSuggestion,
    chosenAlt, slewBlock, firstStar, gotoRunning, centredBlock, slewed, send } = w;
  const selected = useStore((s) => s.selected);
  const skew = useStore((s) => s.clockSkewMs);
  // stable callback ref: scroll the "Settling…" note into view once, when it appears
  const scrollIntoView = useCallback((el: HTMLElement | null) => el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), []);
  const [homeConfirm, setHomeConfirm] = useState(false);

  const params = al?.params;
  const solved = new Set(al?.solved ?? []);

  return (
    <div className="panel-body">
      <Section title="Alignment" right={<Pill tone={quality === 'aligned' ? 'ok' : quality === 'rough' ? 'warn' : 'bad'}>{quality}{al?.rmsArcmin != null ? ` · ${al.rmsArcmin.toFixed(1)}′` : ''}</Pill>}>
        <Steps step={step} setStep={setStep} quality={quality} points={al?.points.length ?? 0} />
        {!connected && <div className="note warn">Connect to the telescope first (Status tab).</div>}
      </Section>

      {step === 0 && (
        <Section title="Step 1 · Check location and time">
          <KV k="Location" v={fmtLocation(loc)} />
          {!locKnown && <div className="note warn">The server has no location yet. Set it in the <b>Location</b> tab: alignment needs it.</div>}
          <KV k="Laptop time" mono v={new Date(now).toLocaleString()} />
          {skew != null && Math.abs(skew) > 30000 && <div className="note bad">Server clock differs from the browser by {fmtDuration(skew)}. Fix the laptop clock first.</div>}
          <div className="note dim small">The laptop clock is used for all positions (1 s ≈ 15″). Without internet, check it against your phone.</div>
          <div className="row-actions">
            <button className="btn" onClick={() => useStore.getState().setPanel('location')}><Icon name="pin" /> Change location</button>
            <button className="btn primary" onClick={() => setStep(1)} disabled={!locKnown}>Looks right <Icon name="chevronR" /></button>
          </div>
        </Section>
      )}

      {step === 1 && (
        <Section title="Step 2 · Level the tube and point it north">
          <div className="home-hint">
            <Compass az={mount?.encoder ? null : null} />
            <ol className="howto">
              <li>Use the slew pad (or arrow keys) to make the tube <b>level</b>: a phone inclinometer on the tube helps.</li>
              <li>Turn it to point <b>north</b> (Polaris is a good guide at night; a phone compass reads ~1–2° off near metal).</li>
              <li>Make sure the power cable hangs <b>un-wrapped</b>. This position becomes the cable-neutral reference.</li>
              <li>Press <b>Home</b>. GoTos are then rough (a few degrees off) until you add stars.</li>
            </ol>
          </div>
          <div className="note dim small">
            <b>Or let a phone do it:</b> open the phone remote over HTTPS (<span className="mono">npm run start:lan:https</span>, see Status › Phone remote), lay the
            phone on the tube and use <b>Align › Sensors</b>. Its compass and gravity sensor measure where the tube points, so it needn't be level or north.
          </div>
          {quality !== 'none' && <HomeSummary home={al?.home} />}
          {mount?.encoder && <KV k="Encoders now" mono v={`az ${mount.encoder.az.toFixed(2)}°  alt ${mount.encoder.alt.toFixed(2)}°`} />}
          <button className="btn" onClick={() => centerOnAltAz(0, 15, 60)}><Icon name="compass" /> Show north on the map</button>
          {!homeConfirm ? (
            <button className="btn primary wide" disabled={!connected || mount?.slew !== 'idle'} onClick={() => setHomeConfirm(true)} title={mount?.slew !== 'idle' ? 'Wait until the mount is stopped' : ''}>
              <Icon name="compass" /> Home: tube is level and pointing north
            </button>
          ) : (
            <div className="confirm-inline">
              <div>Set the encoders' reference here? Any existing alignment is replaced.</div>
              <div className="row-actions">
                <button className="btn" onClick={() => setHomeConfirm(false)}>Cancel</button>
                <button className="btn primary" disabled={!connected || mount?.slew !== 'idle'} onClick={() => { w.setHome(); setHomeConfirm(false); }}>Yes, set Home</button>
              </div>
            </div>
          )}
        </Section>
      )}

      {step === 2 && (
        <>
          <Section title={`Step 3 · Star ${(al?.points.length ?? 0) + 1}`}>
            {quality === 'none' && (
              <div className="note warn">Do “Home” first: GoTo needs to know where level and north are. <button className="btn small" onClick={() => setStep(1)}>Go to Home</button></div>
            )}
            {quality === 'rough' && <HomeSummary home={al?.home} />}
            <div className="note dim small">Pick a suggested star (highlighted on the map), or click any bright star on the map and choose “Use as alignment star”.</div>
            <ul className="suggest">
              {suggestions.map((s, i) => (
                <li key={s.name + i} className={chosen?.name === s.name ? 'on' : ''} onClick={() => chooseSuggestion(i)}>
                  <span className="sg-n mono">{i + 1}</span>
                  <span className="sg-name">{s.name}</span>
                  <span className="dim mono small">mag {s.mag.toFixed(1)} · {fmtDeg(s.alt, 0)} {compassPoint(s.az)}</span>
                </li>
              ))}
              {suggestions.length === 0 && <li className="dim small">No bright stars between 20° and {Math.min(75, limits.altDeg[1] - 4)}° right now{sunIsUp(sun.alt, limits) ? ' (it is daytime)' : ''}.</li>}
            </ul>
            {selected?.kind === 'star' && selected.key !== chosen?.key && (
              <button className="btn small" onClick={() => choose(selected)}><Icon name="star" /> Use selected: {selected.name}</button>
            )}
          </Section>

          {chosen && (
            <Section title={<>Centre <b>{chosen.name}</b></>} className="align-star">
              <KV k="Position now" mono v={chosenAlt ? `${fmtDeg(chosenAlt.alt)} alt · ${fmtDeg(chosenAlt.az)} ${compassPoint(chosenAlt.az)}` : '—'} />
              <ol className="howto">
                <li>
                  <b>Slew there.</b> {firstStar
                    ? al?.home?.source === 'sensors'
                      ? `This first GoTo is only approximate (Home came from the phone compass): expect the star within ~${expectedFirstStarErrorDeg(al.home) ?? 10}°. Use the finder to find it.`
                      : 'This first GoTo is only approximate (Home is rough): expect it to land a few degrees off. Use the finder to find the star.'
                    : 'With stars already added it should land close.'}
                  <div className="row-actions">
                    <span className="btn-wrap" title={slewBlock ?? ''}>
                      <button className="btn" disabled={!!slewBlock || gotoRunning} onClick={() => w.slewTo()}><Icon name="target" /> Slew there</button>
                    </span>
                    {slewed === chosen.key && gotoRunning && <span className="dim small">slewing…</span>}
                    {slewed === chosen.key && !gotoRunning && mount?.target?.name === chosen.name && <span className="txt-ok small">arrived{mount.tracking ? ' · tracking' : ''}</span>}
                  </div>
                  {slewBlock && <div className="note small">{slewBlock}{autoSlewBlocked(sun.alt, quality, limits) ? ' Find the star manually with the slew pad, then press Centred.' : ''}</div>}
                </li>
                <li><b>Centre it in the eyepiece</b> with the slew pad at a slow rate (3–5), first in the finder, then the eyepiece. <b>Finish with UP and RIGHT</b> presses so gear backlash is always taken up the same way.</li>
                <li><b>Press Centred.</b> The server records the encoders and refits the model.</li>
              </ol>
              <div className="row-actions">
                <button className="btn" disabled={!!capture} onClick={() => useStore.setState({ wizardStar: null })}>Pick another</button>
                <span className="btn-wrap" title={centredBlock ?? 'Record this star at the current position'}>
                  <button className="btn primary" disabled={!!centredBlock} onClick={() => w.centred()}>
                    <Icon name="check" /> Centred
                  </button>
                </span>
              </div>
              {capture && (
                <div className="note settling" role="status" ref={scrollIntoView}>
                  <span className="spinner" aria-hidden />
                  <span><b>Settling…</b> hands off the telescope. {capture.name} is recorded once the mount has been still for {(capture.settleMs / 1000).toFixed(1)} s.</span>
                </div>
              )}
              {!capture && centredBlock && connected && quality !== 'none' && <div className="dim small">{centredBlock}</div>}
            </Section>
          )}

          <Section title="Model" right={al && al.points.length > 0 ? <button className="btn small ghost" onClick={() => send({ type: 'alignClear' })}><Icon name="trash" size={13} /> Clear</button> : undefined}>
            {al && al.points.length > 0 ? (
              <table className="points">
                <thead><tr><th>#</th><th>Star</th><th>Residual</th><th /></tr></thead>
                <tbody>
                  {al.points.map((p, i) => (
                    <tr key={p.id}>
                      <td className="mono">{i + 1}</td>
                      <td>{p.target.name}</td>
                      <td className={`mono ${p.residualArcmin != null && p.residualArcmin > 15 ? 'txt-warn' : ''}`}>{p.residualArcmin != null ? `${p.residualArcmin.toFixed(1)}′` : '—'}</td>
                      <td><button className="icon-btn" title="Remove point and refit" onClick={() => send({ type: 'alignRemovePoint', id: p.id })}><Icon name="x" size={13} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="dim small">No stars yet.</div>}
            {al?.rmsArcmin != null && <KV k="RMS" mono v={`${al.rmsArcmin.toFixed(2)}′`} />}
            {params && <ParamGrid params={params} solved={solved} />}
            <div className="note dim small">{QUALITY_TEXT}</div>
            <div className="row-actions">
              <button className="btn" disabled={!al || al.points.length === 0} onClick={() => useStore.setState({ wizardStar: null })}><Icon name="plus" /> Add another star</button>
              <button className="btn primary" disabled={quality !== 'aligned'} onClick={() => { useStore.getState().setPanel('tonight'); useStore.getState().toast('info', `Alignment done with ${al?.points.length} star(s). Enjoy the sky!`); }}>Finish</button>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

function ParamGrid({ params, solved }: { params: PointingModelParams; solved: Set<string> }) {
  const rows = useMemo(() => Object.entries(params) as [keyof PointingModelParams, number][], [params]);
  const help: Record<string, string> = { IA: 'az zero offset', IE: 'alt zero offset', AN: 'base tilt N–S', AW: 'base tilt E–W', CA: 'collimation', NPAE: 'axis non-perp.' };
  return (
    <div className="params">
      {rows.map(([k, v]) => (
        <div key={k} className={`param ${solved.has(k) ? 'solved' : 'unsolved'}`} title={`${help[k]}${solved.has(k) ? '' : ' (not solved yet)'}`}>
          <span className="pk mono">{k}</span><span className="pv mono">{v >= 0 ? '+' : ''}{Math.abs(v) >= 1 ? v.toFixed(2) + '°' : (v * 60).toFixed(1) + '′'}</span>
        </div>
      ))}
    </div>
  );
}
