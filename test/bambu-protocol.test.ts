import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { safeRemotePath } from '../server/bambu/ftps.ts';
import { cameraKindFor, modelFromCode, printUrlFor, supportsChamberControl } from '../server/bambu/models.ts';
import { mergeState } from '../server/bambu/printer.ts';
import { parseSsdp } from '../server/bambu/ssdp.ts';
import { BBL_CA_FILE, describeTlsError, printerTlsOptions } from '../server/bambu/tls.ts';

describe('models', () => {
  it('maps SSDP model codes', () => {
    assert.equal(modelFromCode('BL-P001'), 'X1C');
    assert.equal(modelFromCode('N2S'), 'A1');
    assert.equal(modelFromCode('O1D'), 'H2D');
    assert.equal(modelFromCode('ZZZ'), 'ZZZ');
  });

  it('picks the camera transport by model unless overridden', () => {
    assert.equal(cameraKindFor('P1S', 'auto'), 'jpeg');
    assert.equal(cameraKindFor('A1 Mini', 'auto'), 'jpeg');
    assert.equal(cameraKindFor('X1C', 'auto'), 'rtsps');
    assert.equal(cameraKindFor('H2D', 'auto'), 'rtsps');
    assert.equal(cameraKindFor('X1C', 'none'), 'none');
    assert.equal(cameraKindFor('P1S', 'rtsps'), 'rtsps');
  });

  it('builds print URLs per model family', () => {
    assert.equal(printUrlFor('P1S', '/cache/a.3mf'), 'ftp:///cache/a.3mf');
    assert.equal(printUrlFor('X1C', '/cache/a.3mf'), 'file:///sdcard/cache/a.3mf');
  });

  it('knows which printers have chamber heating', () => {
    assert.equal(supportsChamberControl('X1E'), true);
    assert.equal(supportsChamberControl('H2D'), true);
    assert.equal(supportsChamberControl('X1C'), false);
  });
});

describe('status merging (partial P1/A1 reports)', () => {
  it('deep-merges objects and keeps fields not present in the patch', () => {
    const state: any = { nozzle_temper: 20, ipcam: { timelapse: 'enable', ipcam_record: 'enable' } };
    mergeState(state, { nozzle_temper: 200, ipcam: { timelapse: 'disable' } });
    assert.equal(state.nozzle_temper, 200);
    assert.deepEqual(state.ipcam, { timelapse: 'disable', ipcam_record: 'enable' });
  });

  it('replaces ordinary arrays', () => {
    const state: any = { hms: [{ attr: 1, code: 2 }] };
    mergeState(state, { hms: [] });
    assert.deepEqual(state.hms, []);
  });

  it('merges AMS units and trays by id', () => {
    const state: any = {
      ams: {
        ams: [{ id: '0', humidity: '4', tray: [{ id: '0', tray_type: 'PLA', remain: 80 }, { id: '1', tray_type: 'PETG' }] }],
      },
    };
    mergeState(state, { ams: { ams: [{ id: '0', temp: '25', tray: [{ id: '0', remain: 75 }] }] } });
    const unit = state.ams.ams[0];
    assert.equal(unit.humidity, '4');
    assert.equal(unit.temp, '25');
    assert.deepEqual(unit.tray[0], { id: '0', tray_type: 'PLA', remain: 75 });
  });
});

describe('SSDP discovery parsing', () => {
  const notify = [
    'NOTIFY * HTTP/1.1',
    'HOST: 239.255.255.250:1990',
    'Server: UPnP/1.0',
    'Location: 192.168.1.50',
    'NT: urn:bambulab-com:device:3dprinter:1',
    'USN: 01S00A000000001',
    'DevModel.bambu.com: C12',
    'DevName.bambu.com: Workshop P1S',
    'DevConnect.bambu.com: lan',
    'DevSignal.bambu.com: -40',
    '',
    '',
  ].join('\r\n');

  it('extracts serial, IP, model and name', () => {
    const p = parseSsdp(notify, '10.0.0.9');
    assert.deepEqual(p && { serial: p.serial, ip: p.ip, model: p.model, name: p.name, mode: p.connectMode }, {
      serial: '01S00A000000001',
      ip: '192.168.1.50',
      model: 'P1S',
      name: 'Workshop P1S',
      mode: 'lan',
    });
  });

  it('ignores non-Bambu announcements', () => {
    assert.equal(parseSsdp('NOTIFY * HTTP/1.1\r\nUSN: uuid:tv\r\n\r\n', '10.0.0.9'), null);
  });
});

describe('remote path sanitizing', () => {
  it('normalizes slashes', () => {
    assert.equal(safeRemotePath('cache//a.3mf'), '/cache/a.3mf');
    assert.equal(safeRemotePath('\\model\\b.3mf'), '/model/b.3mf');
    assert.equal(safeRemotePath(undefined), '/');
  });

  it('rejects traversal and control characters with status 400', () => {
    for (const bad of ['/../etc', '/cache/./x', '/a\u0000b', 'x'.repeat(2000)]) {
      assert.throws(() => safeRemotePath(bad), (err: any) => err.statusCode === 400);
    }
  });
});

describe('printer TLS trust', () => {
  it('ships the Bambu Lab CA and it is still valid', () => {
    const ca = new crypto.X509Certificate(fs.readFileSync(BBL_CA_FILE));
    assert.match(ca.subject, /CN=BBL CA/);
    assert.ok(new Date(ca.validTo) > new Date(), `BBL CA expired on ${ca.validTo}`);
  });

  it('verifies the chain and requires CN = serial', () => {
    const opts = printerTlsOptions({ serial: '00m09c450700001', tls_verify: 1 });
    assert.equal(opts.rejectUnauthorized, true);
    assert.equal(opts.ca?.length, 1);
    const ok = opts.checkServerIdentity!('192.168.1.5', { subject: { CN: '00M09C450700001' } } as any);
    const bad = opts.checkServerIdentity!('192.168.1.5', { subject: { CN: '00M09C450799999' } } as any);
    assert.equal(ok, undefined);
    assert.ok(bad instanceof Error);
    assert.match(describeTlsError(bad)!, /Check the serial number/);
  });

  it('can be disabled per printer', () => {
    assert.deepEqual(printerTlsOptions({ serial: 'X', tls_verify: 0 }), { rejectUnauthorized: false });
  });

  it('explains CA verification failures', () => {
    const err = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
    assert.match(describeTlsError(err)!, /Verify printer certificate/);
    assert.equal(describeTlsError(new Error('connect ECONNREFUSED')), null);
  });
});
