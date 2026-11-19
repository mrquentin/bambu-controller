/**
 * Tiny implicit-FTPS server for the fake printer and tests: just the commands
 * basic-ftp uses (login, EPSV/PASV, LIST, SIZE, REST + RETR, STOR, DELE),
 * files kept in memory. Not a general-purpose FTP server.
 */
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';

export interface FakeFtpsOptions {
  host: string;
  port: number;
  password: string;
  tlsOptions: tls.TlsOptions;
  /** Absolute path → content. Directories are implied by the paths. */
  files: Map<string, Buffer>;
}

const normalize = (p: string) => `/${p.split('/').filter(Boolean).join('/')}`;

export function startFakeFtps(opts: FakeFtpsOptions): Promise<tls.Server> {
  const server = tls.createServer(opts.tlsOptions, (control) => {
    control.setEncoding('utf8');
    control.on('error', () => {});
    const reply = (line: string) => control.writable && control.write(`${line}\r\n`);
    let authed = false;
    let restAt = 0;
    let data: Promise<tls.TLSSocket> | null = null;

    // Passive data connection: one listener per transfer.
    const openPassive = () =>
      new Promise<number>((resolve) => {
        const listener = tls.createServer(opts.tlsOptions);
        data = new Promise((accept) => {
          listener.once('secureConnection', (socket) => {
            socket.on('error', () => {});
            listener.close();
            accept(socket);
          });
        });
        listener.listen(0, opts.host, () => resolve((listener.address() as AddressInfo).port));
      });

    const withData = async (fn: (socket: tls.TLSSocket) => Promise<void> | void) => {
      if (!data) return reply('425 Use PASV or EPSV first');
      const pending = data;
      data = null;
      reply('150 Opening data connection');
      const socket = await pending;
      await fn(socket);
    };

    const handle = async (line: string) => {
      const [verb, ...rest] = line.split(' ');
      const arg = rest.join(' ');
      const cmd = verb.toUpperCase();
      if (!authed && !['USER', 'PASS', 'FEAT', 'QUIT'].includes(cmd)) return reply('530 Please login');
      switch (cmd) {
        case 'USER':
          return reply(arg === 'bblp' ? '331 Password required' : '530 Login incorrect');
        case 'PASS':
          authed = arg === opts.password;
          return reply(authed ? '230 Logged in' : '530 Login incorrect');
        case 'FEAT':
          return reply('211-Features:\r\n EPSV\r\n PASV\r\n SIZE\r\n REST STREAM\r\n UTF8\r\n211 End');
        case 'TYPE':
        case 'STRU':
        case 'OPTS':
        case 'PBSZ':
        case 'PROT':
          return reply('200 OK');
        case 'PWD':
          return reply('257 "/"');
        case 'EPSV':
          return reply(`229 Entering Extended Passive Mode (|||${await openPassive()}|)`);
        case 'PASV': {
          const port = await openPassive();
          return reply(`227 Entering Passive Mode (${opts.host.replace(/\./g, ',')},${port >> 8},${port & 255})`);
        }
        case 'SIZE': {
          const file = opts.files.get(normalize(arg));
          return reply(file ? `213 ${file.length}` : '550 No such file');
        }
        case 'REST':
          restAt = Number(arg) || 0;
          return reply(`350 Restarting at ${restAt}`);
        case 'RETR': {
          const file = opts.files.get(normalize(arg));
          const start = restAt;
          restAt = 0;
          if (!file) return reply('550 No such file');
          return withData((socket) => {
            socket.end(file.subarray(start), () => reply('226 Transfer complete'));
          });
        }
        case 'LIST': {
          const dir = normalize(arg.replace(/^-a\s*/, '') || '/');
          const prefix = dir === '/' ? '/' : `${dir}/`;
          const names = new Map<string, number | null>();
          for (const [path, buf] of opts.files) {
            if (!path.startsWith(prefix)) continue;
            const [first, ...more] = path.slice(prefix.length).split('/');
            names.set(first, more.length ? null : buf.length);
          }
          return withData((socket) => {
            const lines = [...names].map(([name, size]) =>
              size === null
                ? `drwxr-xr-x 1 bblp bblp 0 Jan 01 12:00 ${name}`
                : `-rw-r--r-- 1 bblp bblp ${size} Jan 01 12:00 ${name}`,
            );
            socket.end(lines.map((l) => `${l}\r\n`).join(''), () => reply('226 Transfer complete'));
          });
        }
        case 'STOR':
          return withData(
            (socket) =>
              new Promise<void>((resolve) => {
                const chunks: Buffer[] = [];
                socket.on('data', (c: Buffer) => chunks.push(c));
                socket.on('end', () => {
                  opts.files.set(normalize(arg), Buffer.concat(chunks));
                  reply('226 Transfer complete');
                  resolve();
                });
              }),
          );
        case 'DELE':
          return reply(opts.files.delete(normalize(arg)) ? '250 Deleted' : '550 No such file');
        case 'QUIT':
          reply('221 Bye');
          return control.end();
        default:
          return reply('502 Not implemented');
      }
    };

    // Commands are handled strictly in order.
    let queue: Promise<unknown> = Promise.resolve();
    let buffer = '';
    control.on('data', (chunk: string) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        queue = queue.then(() => handle(line)).catch(() => control.destroy());
      }
    });
    reply('220 Fake printer FTPS ready');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}
