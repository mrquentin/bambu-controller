import { CameraHub } from './bambu/camera.ts';
import { PrinterFtps } from './bambu/ftps.ts';
import { JobObjectsCache } from './bambu/job-objects.ts';
import { cameraKindFor } from './bambu/models.ts';
import { PrinterConnection } from './bambu/printer.ts';
import { db, type PrinterRow } from './db.ts';
import { history } from './history.ts';
import { notifyPrinterEvent } from './push.ts';
import { decrypt, encrypt, isEncrypted } from './secrets.ts';

/**
 * A configured printer and its live clients. They all read the printer's
 * settings from `connection.row`, so an edit only has to replace that row.
 */
export interface ManagedPrinter {
  connection: PrinterConnection;
  camera: CameraHub;
  ftps: PrinterFtps;
  /** Objects of the running print (skip objects). */
  jobObjects: JobObjectsCache;
}

export type PrinterInput = Omit<PrinterRow, 'id' | 'created_at'>;

/** Rows are stored with the access code encrypted; in memory it is decrypted. */
function loadRow(id: number | bigint): PrinterRow {
  const row = db.prepare('SELECT * FROM printers WHERE id = ?').get(id) as unknown as PrinterRow;
  return { ...row, access_code: decrypt(row.access_code) };
}

/** Keeps a live connection, camera hub and FTPS client for every configured printer. */
class PrinterManager {
  private printers = new Map<number, ManagedPrinter>();

  init() {
    // One-time migration: encrypt access codes stored in plain text by earlier versions.
    const plain = db.prepare('SELECT id, access_code FROM printers').all() as { id: number; access_code: string }[];
    for (const r of plain.filter((r) => !isEncrypted(r.access_code))) {
      db.prepare('UPDATE printers SET access_code = ? WHERE id = ?').run(encrypt(r.access_code), r.id);
    }
    history.closeOrphans();
    const ids = db.prepare('SELECT id FROM printers ORDER BY name').all() as { id: number }[];
    for (const { id } of ids) this.add(loadRow(id));
  }

  private add(row: PrinterRow) {
    const connection = new PrinterConnection(row);
    const camera = new CameraHub(() => ({ ...connection.row, kind: cameraKindFor(connection.row.model, connection.row.camera) }));
    const ftps = new PrinterFtps(() => connection.row);
    this.printers.set(row.id, { connection, camera, ftps, jobObjects: new JobObjectsCache(ftps) });
    history.watch(connection);
    connection.on('event', (event) => void notifyPrinterEvent(connection.row, event));
    connection.start();
  }

  get(id: number) {
    return this.printers.get(id);
  }

  all() {
    return [...this.printers.values()].sort((a, b) => a.connection.row.name.localeCompare(b.connection.row.name));
  }

  create(input: PrinterInput): PrinterRow {
    const result = db
      .prepare(
        'INSERT INTO printers (name, model, serial, ip, access_code, camera, tls_verify, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.name,
        input.model,
        input.serial,
        input.ip,
        encrypt(input.access_code),
        input.camera,
        input.tls_verify,
        Date.now(),
      );
    const row = loadRow(result.lastInsertRowid);
    this.add(row);
    return row;
  }

  update(managed: ManagedPrinter, input: PrinterInput) {
    const id = managed.connection.row.id;
    db.prepare(
      'UPDATE printers SET name = ?, model = ?, serial = ?, ip = ?, access_code = ?, camera = ?, tls_verify = ? WHERE id = ?',
    ).run(input.name, input.model, input.serial, input.ip, encrypt(input.access_code), input.camera, input.tls_verify, id);
    managed.connection.update(loadRow(id));
    managed.camera.restart();
  }

  remove(managed: ManagedPrinter) {
    const id = managed.connection.row.id;
    this.close(managed, { removed: true });
    this.printers.delete(id);
    db.prepare('DELETE FROM printers WHERE id = ?').run(id);
  }

  shutdown() {
    for (const managed of this.printers.values()) this.close(managed);
  }

  private close({ connection, camera }: ManagedPrinter, options: { removed?: boolean } = {}) {
    history.unwatch(connection.row.id, options);
    connection.stop();
    connection.removeAllListeners('event');
    camera.close();
  }
}

export const manager = new PrinterManager();
