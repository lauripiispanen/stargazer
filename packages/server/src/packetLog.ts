// Rotating TX/RX packet log (SAFETY.md §7 req. 30): one line per frame, ISO timestamp + direction + hex.
import fs from 'node:fs';
import path from 'node:path';
import { describePacket, type ParsedFrame, toHex } from '@stargazer/shared/aux.ts';

export class PacketLog {
  private size = 0;
  private broken = false;

  constructor(
    private readonly file: string,
    private readonly maxBytes = 5 * 1024 * 1024,
  ) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    } catch {
      this.broken = true;
    }
  }

  write(dir: 'tx' | 'rx', frame: ParsedFrame | Uint8Array): void {
    if (this.broken) return;
    const raw = 'raw' in frame ? frame.raw : frame;
    const desc = 'raw' in frame ? `  ${describePacket(frame)}` : '';
    const line = `${new Date().toISOString()} ${dir} ${toHex(raw)}${desc}\n`;
    try {
      if (this.size + line.length > this.maxBytes) {
        fs.renameSync(this.file, `${this.file}.1`);
        this.size = 0;
      }
      fs.appendFileSync(this.file, line);
      this.size += line.length;
    } catch {
      this.broken = true; // never let logging break telescope control
    }
  }
}
