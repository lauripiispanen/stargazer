// Desktop status pane: how to open the phone remote (LAN URL + QR code), or how to restart the server so a
// phone can reach it. The QR encoder (qrcode, bundled locally) is loaded on demand.
import { useEffect, useState } from 'react';
import { useStore } from '../state/store.ts';
import { Icon, Section } from './ui.tsx';

function QrCode({ text, night }: { text: string; night: boolean }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    import('qrcode')
      .then((q) => q.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: night ? '#b3261a' : '#ffffff' } }))
      .then((s) => { if (live) { setSvg(s); setErr(null); } })
      .catch((e) => { if (live) setErr(String(e)); });
    return () => { live = false; };
  }, [text, night]);
  if (err) return <div className="note bad small">QR code failed: {err}</div>;
  return <div className="qr" role="img" aria-label={`QR code for ${text}`} dangerouslySetInnerHTML={svg ? { __html: svg } : undefined} />;
}

/** HTTPS mode: what the one-time certificate warning looks like and how to get past it (or avoid it). */
function HttpsHelp({ fingerprint, caUrl }: { fingerprint?: string; caUrl: string | null }) {
  return (
    <div className="note small https-help">
      <div><b>HTTPS is on</b> (sensor auto-align works). The certificate is made by this laptop, so the first visit shows a warning:</div>
      <ul className="howto">
        <li><b>iPhone (Safari):</b> “This Connection Is Not Private” › <b>Show Details</b> › <b>visit this website</b> › Visit Website.</li>
        <li><b>Android (Chrome):</b> “Your connection is not private” › <b>Advanced</b> › <b>Proceed to …</b>.</li>
      </ul>
      {fingerprint && <div className="dim">To be sure it is this laptop, the certificate's SHA-256 fingerprint starts with <span className="mono">{fingerprint.slice(0, 23)}</span>.</div>}
      {caUrl && <div className="dim">If the live view doesn't connect after accepting (some iOS versions), install the laptop's certificate once: open <span className="mono">{caUrl}</span> on the phone, install the profile (Settings › Profile Downloaded), then enable it under Settings › General › About › Certificate Trust Settings.</div>}
    </div>
  );
}

export function PhoneRemoteCard() {
  const mount = useStore((s) => s.mount);
  const link = useStore((s) => s.link);
  const mock = useStore((s) => s.mock);
  const night = useStore((s) => s.night);
  const [pick, setPick] = useState(0);
  const [copied, setCopied] = useState(false);
  const net = mount?.network;
  const clients = mount?.clients;
  const devices = clients != null && link === 'open' ? <span className="dim small">{clients} device{clients === 1 ? '' : 's'} connected</span> : undefined;

  let body: React.ReactNode;
  if (mock) {
    body = <div className="note dim small">Mock mode runs entirely in this browser. Start the real server (<span className="mono">npm start</span>) to use a phone as a remote.</div>;
  } else if (!net) {
    body = <div className="note dim small">The server doesn't report its network address (it may be an older version).</div>;
  } else if (net.bind !== '0.0.0.0' && net.lanUrls.length === 0) {
    body = (
      <>
        <div className="note small">
          The server only accepts connections from this computer (<span className="mono">{net.bind}</span>). To control the telescope from your phone, stop
          it (Ctrl+C) and restart it with:
        </div>
        <pre className="cmd mono">npm run start:lan</pre>
        <div className="dim small">or <span className="mono">HOST=0.0.0.0 npm start</span>. Then join the phone to the telescope WiFi and scan the QR code shown here.</div>
        <div className="note dim small">To auto-align with the phone's compass and gravity sensors, use <span className="mono">npm run start:lan:https</span> instead (phones only allow sensors over HTTPS).</div>
        <div className="note warn small">Anyone on the same WiFi can then move the telescope.</div>
      </>
    );
  } else if (net.lanUrls.length === 0) {
    body = <div className="note warn small">Listening on all interfaces, but this computer has no network address yet. Join the telescope's WiFi; the address appears here.</div>;
  } else {
    const url = net.lanUrls[Math.min(pick, net.lanUrls.length - 1)]!;
    const devServer = typeof window !== 'undefined' && window.location.port !== String(net.port);
    body = (
      <>
        <div className="phone-remote">
          <QrCode text={url} night={night} />
          <div className="pr-text">
            <div className="small">Join your phone to the same WiFi (the telescope's network), then scan the code or open:</div>
            <div className="pr-url mono">{url}</div>
            <button className="btn small" onClick={() => {
              navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
            }}>{copied ? <><Icon name="check" size={13} /> Copied</> : 'Copy link'}</button>
          </div>
        </div>
        {net.lanUrls.length > 1 && (
          <div className="presets">
            {net.lanUrls.map((u, i) => <button key={u} className={`chip mono ${u === url ? 'on' : ''}`} onClick={() => setPick(i)}>{u.replace(/^https?:\/\/|\/$/g, '')}</button>)}
          </div>
        )}
        {devServer && <div className="note dim small">These addresses serve the built UI (run <span className="mono">npm run build</span> after changes).</div>}
        <div className="note dim small">The phone joins this session: same telescope, alignment and observing list. STOP works from every device.</div>
        {net.https ? <HttpsHelp fingerprint={net.certFingerprint} caUrl={net.caCertPath ? url.replace(/\/$/, '') + net.caCertPath : null} /> : (
          <div className="note dim small">
            <b>Sensor auto-align</b> (the phone on the tube sets level &amp; north) needs HTTPS: phones only give web pages their compass and motion
            sensors over a secure connection. Restart with <span className="mono">npm run start:lan:https</span>.
          </div>
        )}
      </>
    );
  }
  return <Section title={<><Icon name="phone" /> Phone remote</>} right={devices}>{body}</Section>;
}
