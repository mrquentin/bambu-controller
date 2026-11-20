import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeState } from '../server/bambu/printer.ts';

/**
 * `mergeState` folds the partial reports of P1/A1 printers into the full
 * state. The basics (deep merge, array replacement, AMS by id) are covered in
 * bambu-protocol.test.ts; these are the edge cases seen on real printers.
 */

type Json = Record<string, any>;

const fullReport = (): Json => ({
  command: 'push_status',
  gcode_state: 'RUNNING',
  mc_percent: 12,
  subtask_name: 'Benchy',
  nozzle_temper: 219.8,
  bed_temper: 54.9,
  lights_report: [{ node: 'chamber_light', mode: 'on' }],
  ipcam: { ipcam_record: 'enable', timelapse: 'disable', resolution: '1080p' },
  upgrade_state: { status: 'IDLE', progress: '0', new_ver_list: [{ name: 'ota', new_ver: '01.08.03.00' }] },
  ams: {
    tray_now: '1',
    ams_exist_bits: '1',
    ams: [
      {
        id: '0',
        humidity: '4',
        temp: '24.5',
        tray: [
          { id: '0', tray_type: 'PLA', tray_color: 'FFFFFFFF', remain: 80 },
          { id: '1', tray_type: 'PETG', tray_color: '161616FF', remain: 45 },
        ],
      },
      { id: '1', humidity: '3', temp: '25.0', tray: [{ id: '0', tray_type: 'ABS', remain: 10 }] },
    ],
  },
});

describe('mergeState', () => {
  it('applies a sequence of partial P1/A1 deltas without losing earlier fields', () => {
    const state: Json = {};
    mergeState(state, fullReport());
    mergeState(state, { command: 'push_status', nozzle_temper: 220.1 });
    mergeState(state, { command: 'push_status', mc_percent: 13, layer_num: 19 });
    mergeState(state, { command: 'push_status', gcode_state: 'PAUSE' });

    assert.equal(state.nozzle_temper, 220.1);
    assert.equal(state.mc_percent, 13);
    assert.equal(state.layer_num, 19);
    assert.equal(state.gcode_state, 'PAUSE');
    assert.equal(state.subtask_name, 'Benchy');
    assert.equal(state.bed_temper, 54.9);
    assert.deepEqual(state.ams, fullReport().ams);
  });

  it('merges nested objects at every depth', () => {
    const state = fullReport();
    mergeState(state, { upgrade_state: { status: 'DOWNLOADING', progress: '40' }, ipcam: { timelapse: 'enable' } });
    assert.deepEqual(state.ipcam, { ipcam_record: 'enable', timelapse: 'enable', resolution: '1080p' });
    assert.equal(state.upgrade_state.status, 'DOWNLOADING');
    assert.equal(state.upgrade_state.progress, '40');
    assert.deepEqual(state.upgrade_state.new_ver_list, [{ name: 'ota', new_ver: '01.08.03.00' }]);
  });

  it('creates nested objects that did not exist yet', () => {
    const state: Json = { gcode_state: 'IDLE' };
    mergeState(state, { xcam: { buildplate_marker_detector: true } });
    assert.deepEqual(state.xcam, { buildplate_marker_detector: true });
  });

  it('replaces arrays wholesale (no index-wise merge, no concatenation)', () => {
    const state = fullReport();
    mergeState(state, { lights_report: [{ node: 'work_light', mode: 'off' }] });
    assert.deepEqual(state.lights_report, [{ node: 'work_light', mode: 'off' }]);

    mergeState(state, { upgrade_state: { new_ver_list: [] } });
    assert.deepEqual(state.upgrade_state.new_ver_list, []);
  });

  it('replaces values whose type changes', () => {
    const state: Json = { a: { nested: 1 }, b: 'text', c: [1, 2] };
    mergeState(state, { a: 'flat', b: { now: 'object' }, c: { not: 'an array' } });
    assert.deepEqual(state, { a: 'flat', b: { now: 'object' }, c: { not: 'an array' } });
  });

  it('keeps explicit nulls, zeros and empty strings from the printer', () => {
    const state = fullReport();
    mergeState(state, { mc_percent: 0, subtask_name: '', print_error: null });
    assert.equal(state.mc_percent, 0);
    assert.equal(state.subtask_name, '');
    assert.equal(state.print_error, null);
  });

  it('ignores undefined values', () => {
    const state = fullReport();
    mergeState(state, { mc_percent: undefined, ipcam: { timelapse: undefined } });
    assert.equal(state.mc_percent, 12);
    assert.equal(state.ipcam.timelapse, 'disable');
  });

  describe('AMS', () => {
    it('merges a unit that only reports humidity, keeping its trays', () => {
      const state = fullReport();
      mergeState(state, { ams: { ams: [{ id: '0', humidity: '5' }, { id: '1' }] } });
      const [unit0, unit1] = state.ams.ams;
      assert.equal(unit0.humidity, '5');
      assert.equal(unit0.temp, '24.5');
      assert.equal(unit0.tray.length, 2);
      assert.equal(unit0.tray[1].tray_type, 'PETG');
      assert.deepEqual(unit1, fullReport().ams.ams[1]);
      assert.equal(state.ams.tray_now, '1', 'sibling fields of the unit list are kept');
    });

    it('matches units by id, not by position', () => {
      const state = fullReport();
      mergeState(state, { ams: { ams: [{ id: '1', humidity: '2' }, { id: '0', humidity: '1' }] } });
      const byId = Object.fromEntries(state.ams.ams.map((u: Json) => [u.id, u]));
      assert.equal(byId['0'].humidity, '1');
      assert.equal(byId['0'].temp, '24.5');
      assert.equal(byId['1'].humidity, '2');
      assert.equal(byId['1'].tray[0].tray_type, 'ABS');
    });

    it('adds a newly connected unit as is', () => {
      const state = fullReport();
      const unit2 = { id: '2', humidity: '5', tray: [{ id: '0', tray_type: 'TPU' }] };
      mergeState(state, { ams: { ams: [...fullReport().ams.ams, unit2] } });
      assert.equal(state.ams.ams.length, 3);
      assert.deepEqual(state.ams.ams[2], unit2);
    });

    it('takes the unit list from the report, dropping units no longer present', () => {
      const state = fullReport();
      mergeState(state, { ams: { ams: [{ id: '0' }] } });
      assert.deepEqual(
        state.ams.ams.map((u: Json) => u.id),
        ['0'],
      );
    });

    it('merges a partial tray update, keeping its other fields', () => {
      const state = fullReport();
      mergeState(state, { ams: { ams: [{ id: '0', tray: [{ id: '1', remain: 40 }] }] } });
      const tray = state.ams.ams[0].tray;
      assert.deepEqual(tray, [{ id: '1', tray_type: 'PETG', tray_color: '161616FF', remain: 40 }]);
    });

    it('matches trays by id and accepts trays it has not seen yet', () => {
      const state = fullReport();
      mergeState(state, {
        ams: {
          ams: [
            {
              id: '0',
              tray: [
                { id: '1', remain: 44 },
                { id: '0', remain: 79 },
                { id: '3', tray_type: 'PLA-CF' },
              ],
            },
          ],
        },
      });
      const byId = Object.fromEntries(state.ams.ams[0].tray.map((t: Json) => [t.id, t]));
      assert.deepEqual(byId['0'], { id: '0', tray_type: 'PLA', tray_color: 'FFFFFFFF', remain: 79 });
      assert.deepEqual(byId['1'], { id: '1', tray_type: 'PETG', tray_color: '161616FF', remain: 44 });
      assert.deepEqual(byId['3'], { id: '3', tray_type: 'PLA-CF' });
    });

    it('overwrites only the tray fields present in the report, even blank ones', () => {
      const state = fullReport();
      mergeState(state, { ams: { ams: [{ id: '0', tray: [{ id: '0', tray_type: '', tray_color: '00000000' }] }] } });
      assert.equal(state.ams.ams[0].tray[0].tray_type, '');
      assert.equal(state.ams.ams[0].tray[0].remain, 80);
    });

    it('deep-merges nested unit fields', () => {
      const state: Json = { ams: { ams: [{ id: '0', info: { a: 1, b: 2 }, tray: [] }] } };
      mergeState(state, { ams: { ams: [{ id: '0', info: { b: 3 } }] } });
      assert.deepEqual(state.ams.ams[0].info, { a: 1, b: 3 });
    });

    it('takes the first AMS report as is', () => {
      const state: Json = { gcode_state: 'IDLE' };
      const ams = fullReport().ams;
      mergeState(state, { ams });
      assert.deepEqual(state.ams, fullReport().ams);
    });

    it('does not alias the report objects into the previous state', () => {
      const state = fullReport();
      const before = state.ams.ams[0];
      mergeState(state, { ams: { ams: [{ id: '0', humidity: '5' }] } });
      assert.equal(before.humidity, '4', 'the previous unit object is not mutated');
      assert.notEqual(state.ams.ams[0], before);
    });
  });
});
