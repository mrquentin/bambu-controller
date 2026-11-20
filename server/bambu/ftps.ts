import { Writable, type Readable } from 'node:stream';
import { Client, type FileInfo } from 'basic-ftp';
import { MAX_PATH_LENGTH } from '../../shared/forms.ts';
import { HttpError } from '../http-error.ts';
import { printerTlsOptions, type PrinterEndpoint } from './tls.ts';

/**
 * Printer storage (SD card / internal storage) over implicit FTPS on port 990,
 * user "bblp", password = access code. Printers accept very few concurrent
 * sessions, so operations are serialized per printer. Failures are reported as
 * HttpError 502 ("FTPS: …"), or 404 for a missing file being streamed.
 */
export class PrinterFtps {
  private queue: Promise<unknown> = Promise.resolve();
  private target: () => PrinterEndpoint;
  /** Always 990 on printers; overridable for tests against a local fake. */
  port = 990;

  constructor(target: () => PrinterEndpoint) {
    this.target = target;
  }

  private async connect(): Promise<Client> {
    const target = this.target();
    const client = new Client(20_000);
    try {
      await client.access({
        host: target.ip,
        port: this.port,
        user: 'bblp',
        password: target.access_code,
        secure: 'implicit',
        // The printer (vsftpd, require_ssl_reuse) only accepts data connections that
        // resume the control connection's TLS session. basic-ftp copies these options
        // onto the data socket; without `host` Node won't resume the session there
        // and the server answers "522 session reuse required".
        // Certificate verification follows the printer's trust policy (tls.ts).
        secureOptions: { ...printerTlsOptions(target), host: target.ip },
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
    return task.catch((err) => {
      throw ftpsError(err);
    });
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
              client.close();
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
    const client = await this.connect().catch((err) => {
      throw ftpsError(err);
    });
    this.activeStream = client;
    const abort = () => client.close();
    signal.addEventListener('abort', abort);
    try {
      if (signal.aborted) return;
      const size = await client.size(path).catch((err) => {
        throw ftpsError(err, { reading: true });
      });
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
        if (!done && !signal.aborted && !dest.destroyed) throw ftpsError(err, { reading: true });
      }
      if (!dest.writableEnded) dest.end();
    } finally {
      signal.removeEventListener('abort', abort);
      client.close();
      if (this.activeStream === client) this.activeStream = null;
    }
  }
}

/**
 * Errors of other origins (e.g. the upload stream's own) keep their status.
 * FTP 550 means "not found" only when reading a file; it also covers
 * permission problems, so writes report it as a 502 with the printer's text.
 */
function ftpsError(err: unknown, { reading = false } = {}): Error {
  if ((err as { statusCode?: number }).statusCode) return err as Error;
  const notFound = reading && (err as { code?: number }).code === 550;
  return new HttpError(notFound ? 404 : 502, `FTPS: ${(err as Error).message}`);
}

/** Reject paths that try to escape with `..` and normalize slashes. */
export function safeRemotePath(input: unknown): string {
  const raw = typeof input === 'string' ? input : '/';
  const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.' || /[\u0000-\u001f\u007f]/.test(p)) || raw.length > MAX_PATH_LENGTH) {
    throw new HttpError(400, 'Invalid path');
  }
  return `/${parts.join('/')}`;
}
