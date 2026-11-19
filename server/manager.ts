import { CameraHub } from './bambu/camera.ts';
import { PrinterFtps } from './bambu/ftps.ts';
import { cameraKindFor } from './bambu/models.ts';
import { PrinterConnection } from './bambu/printer.ts';
import { db, type PrinterRow } from './db.ts';
import { decrypt, encrypt, isEncrypted } from './secrets.ts';

export interface ManagedPrinter {
  connection: PrinterConnection;
  camera: CameraHub;
  ftps: PrinterFtps;
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
    const ids = db.prepare('SELECT id FROM printers ORDER BY name').all() as { id: number }[];
    for (const { id } of ids) this.add(loadRow(id));
  }

  private add(row: PrinterRow) {
    const connection = new PrinterConnection(row);
    const camera = new CameraHub(() => ({
      kind: cameraKindFor(connection.row.model, connection.row.camera),
      ip: connection.row.ip,
      accessCode: connection.row.access_code,
      serial: connection.row.serial,
      tls_verify: connection.row.tls_verify,
    }));
    const ftps = new PrinterFtps(row.ip, row.access_code, row);
    this.printers.set(row.id, { connection, camera, ftps });
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

  update(id: number, input: PrinterInput): PrinterRow | null {
    const managed = this.printers.get(id);
    if (!managed) return null;
    db.prepare(
      'UPDATE printers SET name = ?, model = ?, serial = ?, ip = ?, access_code = ?, camera = ?, tls_verify = ? WHERE id = ?',
    ).run(input.name, input.model, input.serial, input.ip, encrypt(input.access_code), input.camera, input.tls_verify, id);
    const row = loadRow(id);
    managed.connection.update(row);
    managed.ftps.configure(row.ip, row.access_code, row);
    managed.camera.restart();
    return row;
  }

  remove(id: number) {
    const managed = this.printers.get(id);
    if (!managed) return false;
    managed.connection.stop();
    managed.camera.close();
    this.printers.delete(id);
    db.prepare('DELETE FROM printers WHERE id = ?').run(id);
    return true;
  }

  shutdown() {
    for (const { connection, camera } of this.printers.values()) {
      connection.stop();
      camera.close();
    }
  }
}

export const manager = new PrinterManager();
