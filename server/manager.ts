import { CameraHub } from './bambu/camera.ts';
import { PrinterFtps } from './bambu/ftps.ts';
import { cameraKindFor } from './bambu/models.ts';
import { PrinterConnection } from './bambu/printer.ts';
import { db, type PrinterRow } from './db.ts';

export interface ManagedPrinter {
  connection: PrinterConnection;
  camera: CameraHub;
  ftps: PrinterFtps;
}

/** Keeps a live connection, camera hub and FTPS client for every configured printer. */
class PrinterManager {
  private printers = new Map<number, ManagedPrinter>();

  init() {
    const rows = db.prepare('SELECT * FROM printers ORDER BY name').all() as unknown as PrinterRow[];
    for (const row of rows) this.add(row);
  }

  private add(row: PrinterRow) {
    const connection = new PrinterConnection(row);
    const camera = new CameraHub(() => ({
      kind: cameraKindFor(connection.row.model, connection.row.camera),
      ip: connection.row.ip,
      accessCode: connection.row.access_code,
    }));
    const ftps = new PrinterFtps(row.ip, row.access_code);
    this.printers.set(row.id, { connection, camera, ftps });
    connection.start();
  }

  get(id: number) {
    return this.printers.get(id);
  }

  all() {
    return [...this.printers.values()].sort((a, b) => a.connection.row.name.localeCompare(b.connection.row.name));
  }

  create(input: Omit<PrinterRow, 'id' | 'created_at'>): PrinterRow {
    const result = db
      .prepare(
        'INSERT INTO printers (name, model, serial, ip, access_code, camera, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(input.name, input.model, input.serial, input.ip, input.access_code, input.camera, Date.now());
    const row = db.prepare('SELECT * FROM printers WHERE id = ?').get(result.lastInsertRowid) as unknown as PrinterRow;
    this.add(row);
    return row;
  }

  update(id: number, input: Omit<PrinterRow, 'id' | 'created_at'>): PrinterRow | null {
    const managed = this.printers.get(id);
    if (!managed) return null;
    db.prepare('UPDATE printers SET name = ?, model = ?, serial = ?, ip = ?, access_code = ?, camera = ? WHERE id = ?').run(
      input.name,
      input.model,
      input.serial,
      input.ip,
      input.access_code,
      input.camera,
      id,
    );
    const row = db.prepare('SELECT * FROM printers WHERE id = ?').get(id) as unknown as PrinterRow;
    managed.connection.update(row);
    managed.ftps.configure(row.ip, row.access_code);
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
