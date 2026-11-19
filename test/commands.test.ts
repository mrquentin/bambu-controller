import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as cmd from '../server/bambu/commands.ts';

const print = (c: cmd.Command) => (c as any).print;

describe('MQTT command payloads', () => {
  it('pushall uses the pushing envelope', () => {
    const c = cmd.pushAll() as any;
    assert.equal(c.pushing.command, 'pushall');
    assert.equal(c.pushing.push_target, 1);
  });

  it('pause / resume / stop', () => {
    assert.deepEqual(
      [cmd.pause(), cmd.resume(), cmd.stop()].map((c) => print(c).command),
      ['pause', 'resume', 'stop'],
    );
  });

  it('every command gets a unique sequence id', () => {
    const ids = new Set([cmd.pause(), cmd.pause(), cmd.stop()].map((c) => print(c).sequence_id));
    assert.equal(ids.size, 3);
  });

  it('gcode lines are newline-terminated', () => {
    assert.equal(print(cmd.gcode('G28')).param, 'G28\n');
    assert.equal(print(cmd.gcode('G28\n')).param, 'G28\n');
  });

  it('temperatures map to the right G-code / commands', () => {
    assert.equal(print(cmd.nozzleTemp(220)).param, 'M104 S220\n');
    assert.equal(print(cmd.bedTemp(60)).param, 'M140 S60\n');
    assert.deepEqual(
      { c: print(cmd.chamberTemp(40)).command, v: print(cmd.chamberTemp(40)).ctt_val },
      { c: 'set_ctt', v: 40 },
    );
    const indexed = print(cmd.nozzleTempIndexed(1, 250));
    assert.deepEqual([indexed.command, indexed.extruder_index, indexed.target_temp], ['set_nozzle_temp', 1, 250]);
  });

  it('fan percent is scaled to 0..255 and clamped', () => {
    assert.equal(print(cmd.fanSpeed(1, 100)).param, 'M106 P1 S255\n');
    assert.equal(print(cmd.fanSpeed(2, 50)).param, 'M106 P2 S128\n');
    assert.equal(print(cmd.fanSpeed(3, 150)).param, 'M106 P3 S255\n');
    assert.equal(print(cmd.fanSpeed(3, -5)).param, 'M106 P3 S0\n');
  });

  it('jog uses relative moves with soft endstops, Z slower than XY', () => {
    const xy = print(cmd.jog('X', 10)).param as string;
    assert.match(xy, /G91 \nG1 X10\.00 F3000\n/);
    assert.match(xy, /^M211 S \nM211 X1 Y1 Z1\nM1002 push_ref_mode/);
    assert.match(xy, /M1002 pop_ref_mode\nM211 R\n$/);
    assert.match(print(cmd.jog('Z', -1)).param, /G1 Z-1\.00 F900/);
  });

  it('extrude', () => {
    assert.equal(print(cmd.extrude(-5)).param, 'M83 \nG0 E-5.00 F900\n');
  });

  it('light control uses the system envelope', () => {
    const c = cmd.light('chamber_light', true) as any;
    assert.equal(c.system.command, 'ledctrl');
    assert.equal(c.system.led_node, 'chamber_light');
    assert.equal(c.system.led_mode, 'on');
    assert.equal((cmd.light('work_light', false) as any).system.led_mode, 'off');
  });

  it('print speed level is sent as a string param', () => {
    assert.equal(print(cmd.printSpeed(4)).param, '4');
  });

  it('project_file print command', () => {
    const p = print(
      cmd.printProjectFile({
        url: 'ftp:///cache/benchy.gcode.3mf',
        fileName: 'benchy.gcode.3mf',
        plate: 2,
        bedLeveling: true,
        timelapse: false,
        useAms: true,
        flowCali: true,
        vibrationCali: false,
        layerInspect: true,
      }),
    );
    assert.equal(p.command, 'project_file');
    assert.equal(p.param, 'Metadata/plate_2.gcode');
    assert.equal(p.subtask_name, 'benchy');
    assert.equal(p.use_ams, true);
    assert.equal('ams_mapping' in p, false);
  });
});
