// Alignment wizard state and actions, shared by the desktop AlignPanel and the phone remote's Align tab.
// Steps: 0 location & time, 1 level & north (Home), 2 stars. The remote adds its own step ids on top (see
// remote/AlignTab.tsx), e.g. the phone "Sensors" step (compass + gravity measure where the tube points).
import { useEffect, useState } from 'react';
import type { Target } from '@stargazer/shared/api.ts';
import type { SensorHome } from '@stargazer/shared/sensors.ts';
import { useStore, useLocation } from './store.ts';
import { useGotoBlocker, useNow, useSun } from './hooks.ts';
import { suggestAlignmentStars, raDecToAltAz, type AlignStarSuggestion } from '../lib/astroAdapter.ts';
import { mountLimits, sunIsUp } from '../lib/safety.ts';
import type { SkyObject } from '../lib/catalog.ts';
import { centerOn } from '../sky/viewControl.ts';

/** A suggestion as a selectable sky object (the catalog's named star when there is one). */
export function suggestionToObject(s: AlignStarSuggestion, namedStars: SkyObject[] | undefined): SkyObject {
  const named = namedStars?.find((n) => n.hip && n.hip === s.hip);
  return named ?? { key: `star:${s.hip ?? s.name}`, kind: 'star', name: s.name, id: s.hip ? `HIP ${s.hip}` : undefined, aliases: [], ra: s.ra, dec: s.dec, mag: s.mag, typeLabel: 'Star', hip: s.hip };
}

export function starTarget(o: SkyObject): Target {
  return { kind: 'radec', ra: o.ra, dec: o.dec, name: o.name, id: o.id };
}

export function useAlignWizard() {
  const mount = useStore((s) => s.mount);
  const link = useStore((s) => s.link);
  const send = useStore((s) => s.send);
  const catalog = useStore((s) => s.catalog);
  const wizardStar = useStore((s) => s.wizardStar);
  const suggestions = useStore((s) => s.alignSuggestions);
  const requestGoto = useStore((s) => s.requestGoto);
  const capture = useStore((s) => s.pendingCapture);
  const alignCentred = useStore((s) => s.alignCentred);
  const blocker = useGotoBlocker();
  const limits = mountLimits(mount);
  const loc = useLocation();
  const now = useNow(30000);
  const sun = useSun();
  const al = mount?.alignment;
  const quality = al?.quality ?? 'none';
  const [step, setStep] = useState(() => (quality === 'none' ? 0 : 2));
  const [slewed, setSlewed] = useState<string | null>(null);
  const connected = link === 'open' && mount?.connection === 'connected';
  const locKnown = !!mount?.location;

  useEffect(() => { if (wizardStar) setStep(2); }, [wizardStar]);

  // suggestions (also highlighted on the sky map while the wizard is open)
  const maxAlt = Math.min(75, limits.altDeg[1] - 4); // a few degrees under the upper limit so GoTo + tracking are allowed
  const pointsKey = al?.points.map((p) => p.id).join(',') ?? '';
  useEffect(() => {
    if (!catalog || step !== 2) { useStore.setState({ alignSuggestions: [] }); return; }
    try {
      const s = suggestAlignmentStars(loc, Date.now(), al?.points ?? [], { dsos: catalog.dsoRecords, stars: catalog.stars, starNames: catalog.starNames }, { maxAlt });
      useStore.setState({ alignSuggestions: s });
    } catch (e) { console.warn('suggestAlignmentStars failed', e); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, step, pointsKey, loc.lat, loc.lon, maxAlt, Math.floor(now / 60000)]);
  useEffect(() => () => useStore.setState({ alignSuggestions: [] }), []);

  const chosen: SkyObject | null = wizardStar;
  const choose = (o: SkyObject) => { useStore.setState({ wizardStar: o }); setSlewed(null); centerOn(o, { select: true, fov: 40 }); };
  const chooseSuggestion = (i: number) => { const s = suggestions[i]; if (s) choose(suggestionToObject(s, catalog?.namedStars)); };
  const target: Target | null = chosen ? starTarget(chosen) : null;
  const chosenAlt = chosen ? raDecToAltAz(chosen, loc, now) : null;
  const slewBlock = target ? blocker(target) : null;
  const firstStar = (al?.points.length ?? 0) === 0;
  const gotoRunning = !!mount?.slew.startsWith('goto');
  const centredBlock = !connected ? 'Telescope not connected' : quality === 'none' ? 'Do “Home” first (step 2)' : !locKnown ? 'Set your location first'
    : gotoRunning ? 'Wait for the GoTo to finish' : mount?.slew === 'manual' ? 'Release the slew pad first' : capture ? 'Recording…' : null;
  const homeBlock = !connected ? 'Telescope not connected' : mount?.slew !== 'idle' ? 'Wait until the mount is stopped' : null;

  /** GoTo the chosen star (or `o`), with the keep-clear notice. */
  const slewTo = (o: SkyObject | null = chosen) => {
    if (!o) return;
    requestGoto(starTarget(o), { daytime: sunIsUp(sun.alt, limits) });
    setSlewed(o.key);
  };
  /** Record the current position for the chosen star (or `o`). */
  const centred = (o: SkyObject | null = chosen) => {
    if (!o) return;
    alignCentred(starTarget(o));
    setSlewed(null);
  };
  const setHome = () => { send({ type: 'alignHome' }); setStep(2); };
  /** Home measured by the phone on the tube. Stays on the current step (the UI asks to remove the phone first). */
  const setHomeFromSensors = (h: SensorHome) => send({
    type: 'alignHome', source: 'sensors', azDeg: h.azDeg, altDeg: h.altDeg,
    uncertainty: { azSigmaDeg: h.azSigmaDeg, altSigmaDeg: h.altSigmaDeg },
    ...(h.magHeadingDeg != null ? { magHeadingDeg: h.magHeadingDeg } : {}), declinationDeg: h.declinationDeg,
  });

  return {
    mount, al, quality, step, setStep, connected, locKnown, limits, loc, now, sun, suggestions, maxAlt, capture,
    chosen, choose, chooseSuggestion, target, chosenAlt, slewBlock, firstStar, gotoRunning, centredBlock, homeBlock,
    slewed, setSlewed, slewTo, centred, setHome, setHomeFromSensors, blocker, send,
  };
}
