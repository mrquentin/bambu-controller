import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import tls from 'node:tls';
import { config } from '../config.ts';
import type { CameraKind } from './models.ts';
import { BBL_CA_FILE, describeTlsError, printerTlsOptions } from './tls.ts';

export interface CameraTarget {
  kind: CameraKind;
  ip: string;
  accessCode: string;
  serial: string;
  tls_verify: number;
}

interface FrameSource {
  on(event: 'frame', listener: (jpeg: Buffer) => void): this;
  on(event: 'end', listener: (reason: string) => void): this;
  stop(): void;
}

/**
 * A1 / P1 camera: TLS socket on port 6000.
 * Auth packet (80 bytes, little-endian): 0x40, 0x3000, 0, 0, then the username
 * "bblp" and the access code, each NUL-padded to 32 bytes. The printer then
 * sends frames as a 16-byte header (u32 LE payload size first) followed by a JPEG.
 */
class JpegTcpSource extends EventEmitter implements FrameSource {
  private socket: tls.TLSSocket;
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(target: CameraTarget) {
    super();
    this.socket = tls.connect({ host: target.ip, port: 6000, timeout: 15_000, ...printerTlsOptions(target) });
    this.socket.on('secureConnect', () => {
      const auth = Buffer.alloc(80);
      auth.writeUInt32LE(0x40, 0);
      auth.writeUInt32LE(0x3000, 4);
      auth.write('bblp', 16, 32, 'ascii');
      auth.write(target.accessCode, 48, 32, 'ascii');
      this.socket.write(auth);
    });
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('timeout', () => this.finish('Camera connection timed out'));
    this.socket.on('error', (err) => this.finish(describeTlsError(err) ?? err.message));
    this.socket.on('close', () => this.finish('Camera connection closed'));
  }

  private onData(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 16) {
      const size = this.buffer.readUInt32LE(0);
      if (size === 0 || size > 8 * 1024 * 1024) {
        this.finish(`Unexpected camera frame header (size ${size}) — wrong access code?`);
        return;
      }
      if (this.buffer.length < 16 + size) return;
      const frame = this.buffer.subarray(16, 16 + size);
      this.buffer = this.buffer.subarray(16 + size);
      if (frame[0] === 0xff && frame[1] === 0xd8) this.emit('frame', Buffer.from(frame));
    }
  }

  private finish(reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.socket.destroy();
    this.emit('end', reason);
  }

  stop() {
    this.ended = true;
    this.socket.destroy();
  }
}

/**
 * X1 / H2 / P2S camera: RTSPS on port 322, path /streaming/live/1, user "bblp".
 * Browsers can't play RTSP, so ffmpeg transcodes H.264 to an MJPEG frame pipe.
 */
class RtspsFfmpegSource extends EventEmitter implements FrameSource {
  private proc: ChildProcess;
  private buffer: Buffer = Buffer.alloc(0);
  private stderr = '';
  private ended = false;

  constructor(target: CameraTarget) {
    super();
    const url = `rtsps://bblp:${encodeURIComponent(target.accessCode)}@${target.ip}:322/streaming/live/1`;
    this.proc = spawn(
      config.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-rtsp_transport', 'tcp',
        // Same trust policy as the other clients: Bambu CA + CN must equal the serial.
        // (Newer ffmpeg verifies by default; without a CA it would always fail.)
        ...(target.tls_verify
          ? ['-tls_verify', '1', '-ca_file', BBL_CA_FILE, '-verifyhost', target.serial.toUpperCase()]
          : ['-tls_verify', '0']),
        '-timeout', '10000000', // socket I/O timeout (µs)
        '-fflags', 'nobuffer',
        '-flags', 'low_delay',
        '-i', url,
        '-an',
        '-vf', 'fps=15',
        '-c:v', 'mjpeg',
        '-q:v', '5',
        '-f', 'image2pipe',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    this.proc.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2000);
    });
    this.proc.on('error', (err: NodeJS.ErrnoException) =>
      this.finish(err.code === 'ENOENT' ? 'ffmpeg not found — install it or set FFMPEG_PATH' : err.message),
    );
    this.proc.on('exit', (code) => {
      const detail = this.stderr.trim().split('\n').pop()?.replace(target.accessCode, '***');
      this.finish(`ffmpeg exited (${code})${detail ? `: ${detail}` : ''}`);
    });
  }

  private onData(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const start = this.buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const end = this.buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        if (start > 0) this.buffer = this.buffer.subarray(start);
        return;
      }
      this.emit('frame', Buffer.from(this.buffer.subarray(start, end + 2)));
      this.buffer = this.buffer.subarray(end + 2);
    }
  }

  private finish(reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.proc.kill('SIGKILL');
    this.emit('end', reason);
  }

  stop() {
    this.ended = true;
    this.proc.kill('SIGKILL');
  }
}

/**
 * Shares one upstream camera connection between all viewers of a printer.
 * The upstream is opened on the first subscriber and closed shortly after the last leaves.
 */
export class CameraHub extends EventEmitter {
  latest: Buffer | null = null;
  latestAt = 0;
  error: string | null = null;
  private source: FrameSource | null = null;
  private subscribers = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay = 2_000;
  private getTarget: () => CameraTarget;

  constructor(getTarget: () => CameraTarget) {
    super();
    this.getTarget = getTarget;
    this.setMaxListeners(100);
  }

  subscribe(onFrame: (jpeg: Buffer) => void): () => void {
    this.subscribers++;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.on('frame', onFrame);
    if (!this.source && !this.retryTimer) this.open();
    return () => {
      this.off('frame', onFrame);
      this.subscribers--;
      if (this.subscribers <= 0) {
        this.subscribers = 0;
        this.idleTimer = setTimeout(() => this.close(), 10_000);
      }
    };
  }

  /** Wait for the next frame (or return a fresh cached one). */
  snapshot(timeoutMs = 10_000): Promise<Buffer> {
    if (this.latest && Date.now() - this.latestAt < 2_000) return Promise.resolve(this.latest);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(this.error ?? 'Timed out waiting for a camera frame'));
      }, timeoutMs);
      const unsubscribe = this.subscribe((jpeg) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(jpeg);
      });
    });
  }

  /** Force a reconnect, e.g. after the printer settings changed. */
  restart() {
    const hadSubscribers = this.subscribers > 0;
    this.close();
    if (hadSubscribers) this.open();
  }

  private open() {
    const target = this.getTarget();
    if (target.kind === 'none') {
      this.error = 'Camera disabled for this printer';
      return;
    }
    const source: FrameSource =
      target.kind === 'jpeg' ? new JpegTcpSource(target) : new RtspsFfmpegSource(target);
    this.source = source;

    // Treat a silent upstream as dead so viewers get an error and a reconnect.
    let watchdog: NodeJS.Timeout;
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        source.stop();
        onEnd('No video received from the camera (timed out)');
      }, 20_000);
    };
    armWatchdog();

    source.on('frame', (jpeg) => {
      armWatchdog();
      this.error = null;
      this.retryDelay = 2_000;
      this.latest = jpeg;
      this.latestAt = Date.now();
      this.emit('frame', jpeg);
    });
    const onEnd = (reason: string) => {
      clearTimeout(watchdog);
      if (this.source !== source) return;
      this.source = null;
      this.error = reason;
      this.emit('status');
      if (this.subscribers > 0) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (this.subscribers > 0) this.open();
        }, this.retryDelay);
        this.retryDelay = Math.min(30_000, this.retryDelay * 2);
      }
    };
    source.on('end', onEnd);
  }

  close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.idleTimer = this.retryTimer = null;
    this.source?.stop();
    this.source = null;
  }
}
