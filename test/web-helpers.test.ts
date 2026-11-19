import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HOME_FLAGS,
  chamber,
  fanPercent,
  formatBytes,
  formatDuration,
  gcodeStateInfo,
  hasFlag,
  hmsInfo,
  nozzles,
  stageLabel,
  trayColor,
} from '../web/src/lib/bambu.ts';

describe('report interpretation (web UI helpers)', () => {
  it('fan speeds 0..15 become percentages rounded to 10', () => {
    assert.equal(fanPercent('15'), 100);
    assert.equal(fanPercent('7'), 50);
    assert.equal(fanPercent('0'), 0);
    assert.equal(fanPercent(undefined), null);
  });

  it('decodes packed temperatures for dual-nozzle printers', () => {
    const packed = (current: number, target: number) => (target << 16) | current;
    const list = nozzles({ device: { extruder: { info: [{ id: 0, temp: packed(215, 220) }, { id: 1, temp: packed(30, 0) }] } } });
    assert.deepEqual(
      list.map((n) => [n.label, n.current, n.target]),
      [
        ['Right nozzle', 215, 220],
        ['Left nozzle', 30, 0],
      ],
    );
    assert.deepEqual(chamber({ device: { ctc: { info: { temp: packed(35, 40) } } } }), { current: 35, target: 40 });
  });

  it('falls back to the single-nozzle fields', () => {
    assert.deepEqual(nozzles({ nozzle_temper: 219.6, nozzle_target_temper: 220 })[0], {
      index: null,
      label: 'Nozzle',
      current: 219.6,
      target: 220,
    });
  });

  it('formats HMS codes and severity', () => {
    const info = hmsInfo({ attr: 0x07008000, code: 0x00030001 });
    assert.equal(info.code, '0700_8000_0003_0001');
    assert.equal(info.severity.label, 'Common');
    assert.match(info.url, /e=0700800000030001/);
  });

  it('reads home_flag bits', () => {
    const s = { home_flag: HOME_FLAGS.doorOpen | HOME_FLAGS.sdCardPresent };
    assert.equal(hasFlag(s, HOME_FLAGS.doorOpen), true);
    assert.equal(hasFlag(s, HOME_FLAGS.xHomed), false);
  });

  it('labels states and stages', () => {
    assert.equal(gcodeStateInfo('RUNNING').label, 'Printing');
    assert.equal(gcodeStateInfo(undefined).label, 'Unknown');
    assert.equal(stageLabel({ stg_cur: 2 }), 'Heatbed preheating');
    assert.equal(stageLabel({ stg_cur: 255 }), null);
  });

  it('formats durations, sizes and colors', () => {
    assert.equal(formatDuration(95), '1h 35m');
    assert.equal(formatDuration(5), '5m');
    assert.equal(formatDuration(null), '—');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(trayColor('FF8800FF'), '#FF8800');
    assert.equal(trayColor(''), 'transparent');
  });
});
