import { Writable, type Readable } from 'node:stream';
import { Client, type FileInfo } from 'basic-ftp';
import { printerTlsOptions, type TlsTarget } from './tls.ts';

/**
 * Printer storage (SD card / internal storage) over implicit FTPS on port 990,
 * user "bblp", password = access code. Printers accept very few concurrent
 * sessions, so operations are serialized per printer.
 */
export class PrinterFtps {
  private queue: Promise<unknown> = Promise.resolve();
  private ip: string;
  private accessCode: string;
  private trust: TlsTarget;
  /** Always 990 on printers; overridable for tests against a local fake. */
  port = 990;

  constructor(ip: string, accessCode: string, trust: TlsTarget) {
    this.ip = ip;
    this.accessCode = accessCode;
    this.trust = trust;
  }

  configure(ip: string, accessCode: string, trust: TlsTarget) {
    this.ip = ip;
    this.accessCode = accessCode;
    this.trust = trust;
  }

  private async connect(): Promise<Client> {
    const client = new Client(20_000);
    try {
      await client.access({
        host: this.ip,
        port: this.port,
        user: 'bblp',
        password: this.accessCode,
        secure: 'implicit',
        // The printer (vsftpd, require_ssl_reuse) only accepts data connections that
        // resume the control connection's TLS session. basic-ftp copies these options
        // onto the data socket; without `host` Node won't resume the session there
        // and the server answers "522 session reuse required".
        // Certificate verification follows the printer's trust policy (tls.ts).
        secureOptions: { ...printerTlsOptions(this.trust), host: this.ip },
      });
      return client;
    } catch (err) {
      client.close();
      throw err;
    }
  }

  private run<T>(op: (client: Client) => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const client = await this.connect();
      try {
        return await op(client);
      } finally {
        client.close();
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  list(dir: string) {
    return this.run(async (client) => {
      const entries: FileInfo[] = await client.list(dir);
      return entries
        .filter((e) => e.name !== '.' && e.name !== '..')
        .map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory,
          size: e.size,
          modifiedAt: e.modifiedAt?.toISOString() ?? e.rawModifiedAt ?? null,
        }))
        .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
    });
  }

  download(path: string, destination: Writable) {
    return this.run((client) => client.downloadTo(destination, path));
  }

  upload(path: string, source: Readable) {
    return this.run((client) => client.uploadFrom(source, path));
  }

  remove(path: string) {
    return this.run((client) => client.remove(path));
  }

  /** First path that exists (one session, SIZE per candidate), with its size. */
  firstExisting(paths: string[]) {
    return this.run(async (client) => {
      for (const path of paths) {
        try {
          return { path, size: await client.size(path) };
        } catch (err) {
          // 550 = no such file; anything else (connection lost…) is a real error.
          if ((err as { code?: number }).code !== 550) throw err;
        }
      }
      return null;
    });
  }

  /** Download `length` bytes starting at `start` (REST), then hang up the transfer. */
  readRange(path: string, start: number, length: number) {
    return this.run(async (client) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let done = length <= 0;
      if (done) return Buffer.alloc(0);
      const sink = new Writable({
        write(chunk: Buffer, _enc, callback) {
          if (!done) {
            const part = chunk.subarray(0, length - received);
            chunks.push(part);
            received += part.length;
            if (received >= length) {
              done = true;
              client.close(); // ends the transfer early; the session is discarded anyway
            }
          }
          callback();
        },
      });
      try {
        await client.downloadTo(sink, path, start);
      } catch (err) {
        if (!done) throw err;
      }
      return Buffer.concat(chunks, received);
    });
  }

  private activeStream: Client | null = null;

  /**
   * Stream bytes [start, end] of a file for media playback. Runs on its own
   * connection outside the queue (a player keeps a request open for a long
   * time), and starting a new stream cancels the previous one — browsers
   * issue a new range request each time the user seeks.
   *
   * `open` is called once the file size is known; it returns the destination
   * (or null to abort, e.g. for an unsatisfiable range).
   */
  async stream(
    path: string,
    range: { start?: number; end?: number; suffix?: number },
    open: (size: number, start: number, end: number) => Writable | null,
    signal: AbortSignal,
  ): Promise<void> {
    this.activeStream?.close();
    const client = await this.connect();
    this.activeStream = client;
    const abort = () => client.close();
    signal.addEventListener('abort', abort);
    try {
      if (signal.aborted) return;
      const size = await client.size(path);
      let start = range.start ?? 0;
      let end = Math.min(range.end ?? size - 1, size - 1);
      if (range.suffix !== undefined) {
        start = Math.max(0, size - range.suffix);
        end = size - 1;
      }
      const dest = open(size, start, end);
      if (!dest || start > end) return;

      const length = end - start + 1;
      let sent = 0;
      let done = false;
      // Forward exactly `length` bytes, then hang up the FTP transfer.
      const limiter = new Writable({
        write(chunk: Buffer, _enc, callback) {
          if (done) return callback();
          const part = chunk.length > length - sent ? chunk.subarray(0, length - sent) : chunk;
          sent += part.length;
          const flushed = dest.write(part);
          if (sent >= length) {
            done = true;
            dest.end();
            client.close();
            return callback();
          }
          if (flushed) callback();
          else dest.once('drain', () => callback());
        },
      });
      dest.on('close', abort);
      try {
        await client.downloadTo(limiter, path, start);
      } catch (err) {
        // Closing the client on purpose (range complete / viewer left) is not an error.
        if (!done && !signal.aborted && !dest.destroyed) throw err;
      }
      if (!dest.writableEnded) dest.end();
    } finally {
      signal.removeEventListener('abort', abort);
      client.close();
      if (this.activeStream === client) this.activeStream = null;
    }
  }
}

/** Reject paths that try to escape with `..` and normalize slashes. */
export function safeRemotePath(input: unknown): string {
  const raw = typeof input === 'string' ? input : '/';
  const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.' || /[\u0000-\u001f\u007f]/.test(p)) || raw.length > 1024) {
    throw Object.assign(new Error('Invalid path'), { statusCode: 400 });
  }
  return `/${parts.join('/')}`;
}
