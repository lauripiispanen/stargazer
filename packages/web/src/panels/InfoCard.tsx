import { useStore, useLocation } from '../state/store.ts';
import { useDisplayTime, useGotoBlock, useSun } from '../state/hooks.ts';
import { bodyRaDec, doubleStarNote, objectToTarget, raDecToAltAz, riseTransitSet, separation } from '../lib/astroAdapter.ts';
import { objectTitle } from '../lib/catalog.ts';
import { compassPoint, fmtDeg, fmtDms, fmtMag, fmtRa, fmtSize, fmtTime } from '../lib/format.ts';
import { sunIsUp } from '../lib/safety.ts';
import { centerOn } from '../sky/viewControl.ts';
import { KV, Icon } from './ui.tsx';
import { AddToListButton } from './ListPanel.tsx';

export function InfoCard() {
  const o = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const requestGoto = useStore((s) => s.requestGoto);
  const loc = useLocation();
  const t = useDisplayTime(2000);
  const block = useGotoBlock(o);
  const sun = useSun();
  if (!o) return null;
  let ra = o.ra, dec = o.dec, mag = o.mag, dist: number | undefined;
  if (o.body) { const p = bodyRaDec(o.body, loc, t); ra = p.ra; dec = p.dec; mag = p.mag; dist = p.distanceAu; }
  const aa = raDecToAltAz({ ra, dec }, loc, t);
  const rts = riseTransitSet({ ra, dec, body: o.body }, loc, t);
  const sunSep = separation({ ra, dec }, sun);
  const bright = o.body === 'Moon' || o.body === 'Venus';
  const useForAlign = () => {
    useStore.setState({ wizardStar: o, panel: 'align' });
  };
  const goto = () => requestGoto(objectToTarget({ ...o, ra, dec }), { daytime: sunIsUp(sun.alt) });
  return (
    <div className="infocard glass">
      <div className="info-h">
        <div>
          <div className="info-type">{o.typeLabel}{o.con ? ` · ${o.con}` : ''}</div>
          <h2>{objectTitle(o)}</h2>
          {o.aliases.length > 0 && <div className="dim small">{o.aliases.filter((a) => a !== o.name && a !== o.id).slice(0, 4).join(' · ')}</div>}
        </div>
        <button className="icon-btn" onClick={() => select(null)} aria-label="Close"><Icon name="x" /></button>
      </div>
      <div className="info-grid">
        <KV k="Magnitude" mono v={fmtMag(mag)} />
        {o.sizeArcmin && <KV k="Size" mono v={fmtSize(o.sizeArcmin)} />}
        {dist != null && <KV k="Distance" mono v={o.body === 'Moon' ? `${Math.round(dist * 149597870.7).toLocaleString()} km` : `${dist.toFixed(2)} AU`} />}
        <KV k="RA / Dec" mono v={`${fmtRa(ra)}  ${fmtDms(dec)}`} />
        <KV k="Alt / Az" mono v={<span className={aa.alt < 0 ? 'txt-bad' : ''}>{fmtDeg(aa.alt)} / {fmtDeg(aa.az)} {compassPoint(aa.az)}</span>} />
        <KV k="Rise · Transit · Set" mono v={
          rts.circumpolar ? <>circumpolar · {fmtTime(rts.transit)} ({fmtDeg(rts.transitAlt, 0)})</> :
          rts.neverRises ? 'never rises here' :
          <>{fmtTime(rts.rise)} · {fmtTime(rts.transit)} ({fmtDeg(rts.transitAlt, 0)}) · {fmtTime(rts.set)}</>} />
        {sunSep < 30 && o.body !== 'Sun' && <KV k="From the Sun" mono v={<span className="txt-bad">{sunSep.toFixed(0)}°</span>} />}
      </div>
      {o.type === 'double-star' && o.id && doubleStarNote(o.id) && <div className="note small">{doubleStarNote(o.id)}</div>}
      {o.body === 'Sun' && <div className="note bad">Never point the telescope at the Sun without a certified full-aperture solar filter, and cap the finder.</div>}
      {bright && <div className="note small">Bright: expect dazzle. Consider a Moon filter.</div>}
      <div className="info-actions">
        <span title={block ?? 'Slew the telescope here'} className="btn-wrap">
          <button className="btn primary" disabled={!!block} onClick={goto}><Icon name="target" /> GoTo</button>
        </span>
        <button className="btn" onClick={() => centerOn(o, { select: false })}><Icon name="crosshair" /> Centre</button>
        {o.kind !== 'constellation' && <AddToListButton target={objectToTarget({ ...o, ra, dec })} />}
        {o.kind === 'star' && <button className="btn" onClick={useForAlign} title="Use this star in the alignment wizard"><Icon name="star" /> Use as alignment star</button>}
      </div>
      {block && <div className="dim small block-reason">{block}</div>}
    </div>
  );
}
