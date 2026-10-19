// How Home was set (manual level & north, or measured by the phone's sensors), shared by the desktop wizard and
// the phone remote.
import type { AlignmentHome } from '@stargazer/shared/api.ts';
import { expectedFirstStarErrorDeg } from '@stargazer/shared/sensors.ts';
import { compassPoint } from '../lib/format.ts';

const signed = (d: number, digits = 1) => `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(digits)}°`;

export function HomeSummary({ home, compact = false }: { home: AlignmentHome | null | undefined; compact?: boolean }) {
  if (!home) return null;
  if (home.source !== 'sensors') {
    return <div className="home-summary dim small">Home: tube levelled and pointed north by hand{home.azDeg || home.altDeg ? ` (az ${home.azDeg.toFixed(1)}°, alt ${home.altDeg.toFixed(1)}°)` : ''}.</div>;
  }
  const exp = expectedFirstStarErrorDeg(home);
  return (
    <div className="home-summary note small" data-source="sensors">
      <div><b>Home from the phone sensors</b>{home.time ? <span className="dim"> · {new Date(home.time).toLocaleTimeString()}</span> : null}</div>
      <div className="mono">
        az {home.azDeg.toFixed(1)}° {compassPoint(home.azDeg)}{home.azSigmaDeg != null ? ` ±${home.azSigmaDeg.toFixed(1)}°` : ''} · alt {home.altDeg.toFixed(1)}°{home.altSigmaDeg != null ? ` ±${home.altSigmaDeg.toFixed(1)}°` : ''}
      </div>
      {!compact && home.declinationDeg != null && (
        <div className="mono dim">
          {home.magHeadingDeg != null ? `magnetic ${home.magHeadingDeg.toFixed(1)}° ` : ''}declination {signed(home.declinationDeg)} (WMM2025)
        </div>
      )}
      <div className="dim">The compass is only good to a few degrees: expect the first star within ~{exp ?? 10}°, use the finder. Stars refine it.</div>
    </div>
  );
}
