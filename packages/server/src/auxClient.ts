// TCP AUX client: framing, echo filtering, request/response matching, serialized queue, timeouts, retries.
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { AuxCmd, AuxDevice, AuxFrameParser, commandName, decodePosition, deviceName, encodePacket, type ParsedFrame } from '@stargazer/shared/aux.ts';
import { type AllowContext, checkAllowed } from './allowList.ts';

export { AuxForbiddenError } from './allowList.ts';

export class AuxTimeoutError extends Error {
  constructor(dst: number, cmd: number) {
    super(`AUX timeout: ${commandName(cmd)} to ${deviceName(dst)}`);
    this.name = 'AuxTimeoutError';
  }
}

export class AuxDisconnectedError extends Error {
  constructor(msg = 'AUX link disconnected') {
    super(msg);
    this.name = 'AuxDisconnectedError';
  }
}

export interface RequestOptions {
  timeoutMs?: number;
  retries?: number;
  /** Jump the queue (stop/abort commands). */
  priority?: boolean;
  /** Presence probe: silence is expected, so a timeout is not counted in stats. */
  probe?: boolean;
}

export interface LinkStats {
  /** Median round-trip time of recent requests (ms). */
  medianRttMs: number;
  timeouts: number;
  retries: number;
  /** Bytes discarded by the frame parser (garbage / bad checksums). */
  discardedBytes: number;
}

/** The subset of AuxClient the mount depends on; lets tests inject a fake. */
export interface AuxLink {
  readonly connected: boolean;
  readonly stats?: LinkStats;
  request(dst: number, cmd: number, data?: ArrayLike<number>, opts?: RequestOptions): Promise<Uint8Array>;
  close(): void;
  on(event: 'disconnect', cb: (reason: string) => void): this;
  on(event: 'packet', cb: (frame: ParsedFrame) => void): this;
}

export interface AuxClientOptions {
  host: string;
  port: number;
  source?: number;
  timeoutMs?: number;
  retries?: number;
  connectTimeoutMs?: number;
  /** Called for every frame sent ('tx') or received ('rx'), including echoes and foreign traffic. */
  onTraffic?: (dir: 'tx' | 'rx', frame: ParsedFrame | Uint8Array) => void;
}

interface Job {
  dst: number;
  cmd: number;
  bytes: Uint8Array;
  timeoutMs: number;
  retries: number;
  probe: boolean;
  attempt: number;
  sentAt: number;
  timer?: NodeJS.Timeout;
  resolve: (data: Uint8Array) => void;
  reject: (err: Error) => void;
}

export class AuxClient extends EventEmitter implements AuxLink {
  private sock: net.Socket | null = null;
  private readonly parser = new AuxFrameParser();
  private queue: Job[] = [];
  private current: Job | null = null;
  private closed = false;
  readonly source: number;
  // Bookkeeping for the allow-list (SAFETY.md §4.3).
  private readonly answered = new Set<number>();
  private readonly positions = new Map<number, number>();
  private readonly gotoRunning = new Set<number>();
  private readonly allowCtx: AllowContext = {
    answered: this.answered,
    gotoActive: (dev) => this.gotoRunning.has(dev),
    position: (dev) => this.positions.get(dev) ?? null,
  };
  private rtts: number[] = [];
  private timeoutCount = 0;
  private retryCount = 0;

  constructor(private readonly opts: AuxClientOptions) {
    super();
    this.source = opts.source ?? AuxDevice.APP;
  }

  static async connect(opts: AuxClientOptions): Promise<AuxClient> {
    const c = new AuxClient(opts);
    await c.connect();
    return c;
  }

  get stats(): LinkStats {
    const sorted = [...this.rtts].sort((a, b) => a - b);
    return {
      medianRttMs: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0,
      timeouts: this.timeoutCount,
      retries: this.retryCount,
      discardedBytes: this.parser.discarded,
    };
  }

  /** Devices that answered GET_VER on this connection. */
  get answeredDevices(): ReadonlySet<number> {
    return this.answered;
  }

  get connected(): boolean {
    return !!this.sock && !this.closed && !this.sock.destroyed;
  }

  connect(): Promise<void> {
    const { host, port, connectTimeoutMs = 5000 } = this.opts;
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`connect timeout to ${host}:${port}`));
      }, connectTimeoutMs);
      sock.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      sock.once('connect', () => {
        clearTimeout(timer);
        sock.removeAllListeners('error');
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 5000);
        this.sock = sock;
        sock.on('data', (chunk) => this.onData(chunk));
        sock.on('error', () => {}); // 'close' follows
        sock.on('close', () => this.onClose('connection closed'));
        resolve();
      });
    });
  }

  request(dst: number, cmd: number, data: ArrayLike<number> = [], opts: RequestOptions = {}): Promise<Uint8Array> {
    if (!this.connected) return Promise.reject(new AuxDisconnectedError());
    try {
      checkAllowed(this.source, dst, cmd, data, this.allowCtx);
    } catch (e) {
      return Promise.reject(e);
    }
    return new Promise((resolve, reject) => {
      const job: Job = {
        dst,
        cmd,
        bytes: encodePacket({ src: this.source, dst, cmd, data }),
        timeoutMs: opts.timeoutMs ?? this.opts.timeoutMs ?? 800,
        retries: opts.retries ?? this.opts.retries ?? 2,
        probe: opts.probe ?? false,
        attempt: 0,
        sentAt: 0,
        resolve,
        reject,
      };
      if (opts.priority) this.queue.unshift(job);
      else this.queue.push(job);
      this.pump();
    });
  }

  close(): void {
    if (this.closed) return;
    this.sock?.destroy();
    this.onClose('closed by client');
  }

  private pump(): void {
    if (this.current || !this.queue.length || !this.connected) return;
    this.current = this.queue.shift()!;
    this.send(this.current);
  }

  private send(job: Job): void {
    this.opts.onTraffic?.('tx', job.bytes);
    // A GOTO counts as running from the moment it is sent (conservative for the guide-rate rule).
    if (job.cmd === AuxCmd.GOTO_FAST || job.cmd === AuxCmd.GOTO_SLOW) this.gotoRunning.add(job.dst);
    job.sentAt = performance.now();
    this.sock!.write(job.bytes); // whole packet in one write
    job.timer = setTimeout(() => this.onTimeout(job), job.timeoutMs);
  }

  private onTimeout(job: Job): void {
    if (this.current !== job) return;
    if (job.attempt < job.retries) {
      job.attempt++;
      this.retryCount++;
      this.send(job);
      return;
    }
    this.current = null;
    if (!job.probe) this.timeoutCount++;
    job.reject(new AuxTimeoutError(job.dst, job.cmd));
    this.pump();
  }

  private onData(chunk: Buffer): void {
    for (const frame of this.parser.push(chunk)) {
      this.opts.onTraffic?.('rx', frame);
      this.emit('packet', frame);
      // Echoes (src == us) and traffic between other devices are not addressed to us.
      if (frame.dst !== this.source) continue;
      const job = this.current;
      if (!job || frame.src !== job.dst) continue;
      const quirk = frame.cmd === AuxCmd.QUIRK_F0 && frame.data[0] === job.cmd;
      if (frame.cmd !== job.cmd && !quirk) continue;
      clearTimeout(job.timer);
      this.current = null;
      this.rtts.push(performance.now() - job.sentAt);
      if (this.rtts.length > 50) this.rtts.shift();
      this.track(job, frame.data);
      job.resolve(frame.data);
      this.pump();
    }
  }

  private track(job: Job, data: Uint8Array): void {
    if (job.cmd === AuxCmd.GET_VER) this.answered.add(job.dst);
    else if (job.cmd === AuxCmd.GET_POSITION && data.length >= 3) this.positions.set(job.dst, decodePosition(data, job.dst === AuxDevice.ALT));
    else if (job.cmd === AuxCmd.SLEW_DONE && data[0] === 0xff) this.gotoRunning.delete(job.dst);
  }

  private onClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const err = new AuxDisconnectedError(`AUX link disconnected: ${reason}`);
    const jobs = [...(this.current ? [this.current] : []), ...this.queue];
    this.current = null;
    this.queue = [];
    for (const j of jobs) {
      clearTimeout(j.timer);
      j.reject(err);
    }
    this.emit('disconnect', reason);
  }
}
