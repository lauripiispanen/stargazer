// Local HTTPS for the phone remote (sensor APIs need a secure context). Generates, once, a small local CA and a
// server certificate signed by it, with the laptop's LAN IPs and hostname in subjectAltName, using the `openssl`
// CLI. Files live in <state dir>/tls (~/.stargazer/tls, or .dev/tls in dev):
//   ca.key / ca.crt   local CA (10 years). The key never leaves this directory (mode 600).
//   key.pem / cert.pem server certificate (825 days, the iOS maximum), re-issued when the LAN IPs change.
// Phones see a one-time "not private" warning, or can install ca.crt (served at /stargazer-ca.crt) to trust it.
// Bring your own: STARGAZER_TLS_CERT / STARGAZER_TLS_KEY (PEM paths) skip generation.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TlsMaterial {
  key: Buffer;
  cert: Buffer;
  /** CA certificate (PEM) phones may install; null with a user-provided certificate. */
  ca: Buffer | null;
  /** SHA-256 fingerprint of the server certificate (AA:BB:...). */
  fingerprint256: string;
  /** subjectAltName entries of the server certificate, e.g. ['DNS:localhost', 'IP:192.168.1.5']. */
  sans: string[];
  dir: string;
  /** True when this call created or re-issued the server certificate. */
  issued: boolean;
}

export interface TlsHosts {
  ips: string[];
  dns: string[];
}

const LEAF_DAYS = 825; // iOS refuses TLS server certificates valid for longer
const CA_DAYS = 3650;

/** Where certificates are kept: STARGAZER_TLS_DIR, else next to the state file, else ~/.stargazer/tls. */
export function tlsDir(stateFile: string | null, env: Record<string, string | undefined> = process.env): string {
  if (env.STARGAZER_TLS_DIR) return path.resolve(env.STARGAZER_TLS_DIR);
  return stateFile ? path.join(path.dirname(stateFile), 'tls') : path.join(os.homedir(), '.stargazer', 'tls');
}

/** Names and addresses the certificate must cover: loopback, hostname(.local) and every LAN IPv4. */
export function tlsHosts(lanIps: string[], hostname = os.hostname()): TlsHosts {
  const short = hostname.replace(/\.local$/i, '');
  const dns = [...new Set(['localhost', short, `${short}.local`].filter((h) => /^[A-Za-z0-9.-]+$/.test(h)))];
  return { ips: [...new Set(['127.0.0.1', ...lanIps])], dns };
}

export function sanList(h: TlsHosts): string[] {
  return [...h.dns.map((d) => `DNS:${d}`), ...h.ips.map((ip) => `IP:${ip}`)];
}

/** subjectAltName entries of a PEM certificate, normalised to 'DNS:x' / 'IP:x'. */
export function certSans(pem: Buffer | string): string[] {
  const c = new crypto.X509Certificate(pem);
  return (c.subjectAltName ?? '').split(/,\s*/).filter(Boolean).map((s) => s.replace(/^IP Address:/, 'IP:'));
}

function opensslAvailable(bin: string): boolean {
  try {
    execFileSync(bin, ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function run(bin: string, args: string[]): void {
  try {
    execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    const err = e as { stderr?: Buffer; message: string };
    throw new Error(`openssl ${args[0]} failed: ${err.stderr?.toString().trim() || err.message}`);
  }
}

function writeConf(file: string, body: string): void {
  fs.writeFileSync(file, body.trim() + '\n');
}

/** Create the local CA if missing (or expiring). */
function ensureCa(dir: string, bin: string, now: number): void {
  const caKey = path.join(dir, 'ca.key');
  const caCrt = path.join(dir, 'ca.crt');
  if (fs.existsSync(caKey) && fs.existsSync(caCrt)) {
    try {
      const c = new crypto.X509Certificate(fs.readFileSync(caCrt));
      if (new Date(c.validTo).getTime() > now + 30 * 86400e3) return;
    } catch {
      /* unreadable: recreate */
    }
  }
  const conf = path.join(dir, 'ca.cnf');
  const host = os.hostname().replace(/[^A-Za-z0-9.-]/g, '').slice(0, 40) || 'laptop';
  writeConf(conf, `
[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no
[dn]
CN = Stargazer local CA (${host})
O = Stargazer
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
`);
  run(bin, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', String(CA_DAYS), '-keyout', caKey, '-out', caCrt, '-config', conf]);
  fs.chmodSync(caKey, 0o600);
  fs.rmSync(conf, { force: true });
}

/** Issue the server certificate for `sans`, signed by the local CA. */
function issueLeaf(dir: string, bin: string, sans: string[]): void {
  const key = path.join(dir, 'key.pem');
  const csr = path.join(dir, 'server.csr');
  const crt = path.join(dir, 'cert.pem');
  const conf = path.join(dir, 'server.cnf');
  writeConf(conf, `
[req]
distinguished_name = dn
prompt = no
[dn]
CN = Stargazer
O = Stargazer
[v3]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${sans.join(', ')}
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
`);
  run(bin, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-config', conf]);
  const serial = '0x' + crypto.randomBytes(12).toString('hex');
  run(bin, ['x509', '-req', '-in', csr, '-CA', path.join(dir, 'ca.crt'), '-CAkey', path.join(dir, 'ca.key'), '-set_serial', serial,
    '-days', String(LEAF_DAYS), '-sha256', '-extfile', conf, '-extensions', 'v3', '-out', crt]);
  fs.chmodSync(key, 0o600);
  fs.rmSync(csr, { force: true });
  fs.rmSync(conf, { force: true });
}

function material(dir: string, keyFile: string, certFile: string, caFile: string | null, issued: boolean): TlsMaterial {
  const cert = fs.readFileSync(certFile);
  const x = new crypto.X509Certificate(cert);
  return {
    key: fs.readFileSync(keyFile),
    cert,
    ca: caFile && fs.existsSync(caFile) ? fs.readFileSync(caFile) : null,
    fingerprint256: x.fingerprint256,
    sans: certSans(cert),
    dir,
    issued,
  };
}

export interface EnsureTlsOptions {
  openssl?: string;
  now?: number;
  env?: Record<string, string | undefined>;
}

/**
 * Load (or create) the certificate for `hosts`. The server certificate is re-issued when it is missing,
 * expiring, or lacks one of the required names/addresses; the CA is kept, so a phone that trusted it still does.
 */
export function ensureTlsCert(dir: string, hosts: TlsHosts, opts: EnsureTlsOptions = {}): TlsMaterial {
  const env = opts.env ?? process.env;
  if (env.STARGAZER_TLS_CERT && env.STARGAZER_TLS_KEY) {
    return material(path.dirname(env.STARGAZER_TLS_CERT), env.STARGAZER_TLS_KEY, env.STARGAZER_TLS_CERT, null, false);
  }
  const bin = opts.openssl ?? env.OPENSSL ?? 'openssl';
  const now = opts.now ?? Date.now();
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const caFile = path.join(dir, 'ca.crt');
  const want = sanList(hosts);

  if (fs.existsSync(keyFile) && fs.existsSync(certFile) && fs.existsSync(caFile)) {
    try {
      const x = new crypto.X509Certificate(fs.readFileSync(certFile));
      const have = new Set(certSans(fs.readFileSync(certFile)));
      const fresh = new Date(x.validTo).getTime() > now + 14 * 86400e3;
      if (fresh && want.every((s) => have.has(s))) return material(dir, keyFile, certFile, caFile, false);
    } catch {
      /* unreadable: re-issue */
    }
  }
  if (!opensslAvailable(bin)) {
    throw new Error('HTTPS needs the `openssl` command to create a local certificate (install OpenSSL), or set STARGAZER_TLS_CERT and STARGAZER_TLS_KEY to PEM files.');
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  ensureCa(dir, bin, now);
  // keep names from an older certificate too, so a previously used address keeps working
  let old: string[] = [];
  try {
    old = fs.existsSync(certFile) ? certSans(fs.readFileSync(certFile)) : [];
  } catch {
    old = [];
  }
  const sans = [...new Set([...want, ...old.filter((s) => /^(DNS|IP):/.test(s))])].slice(0, 40);
  issueLeaf(dir, bin, sans);
  return material(dir, keyFile, certFile, caFile, true);
}
