/**
 * MQTT command payloads published to `device/{serial}/request`.
 *
 * Shapes were recovered from the LanBu app (BambuMqtt.*) and cross-checked
 * against openbu. All of them are plain JSON objects.
 */

let seq = 20000;
const nextSeq = () => String(seq++);

export type Command = Record<string, unknown>;

const print = (body: Record<string, unknown>): Command => ({ print: { sequence_id: nextSeq(), ...body } });

export const pushAll = (): Command => ({
  pushing: { sequence_id: nextSeq(), command: 'pushall', version: 1, push_target: 1 },
});

export const getVersion = (): Command => ({ info: { sequence_id: nextSeq(), command: 'get_version' } });

export const pause = () => print({ command: 'pause', param: '' });
export const resume = () => print({ command: 'resume', param: '' });
export const stop = () => print({ command: 'stop', param: '' });

/** 1 = silent, 2 = standard, 3 = sport, 4 = ludicrous */
export const printSpeed = (level: 1 | 2 | 3 | 4) => print({ command: 'print_speed', param: String(level) });

export const gcode = (lines: string) => print({ command: 'gcode_line', param: lines.endsWith('\n') ? lines : `${lines}\n` });

export const light = (node: string, on: boolean): Command => ({
  system: {
    sequence_id: nextSeq(),
    command: 'ledctrl',
    led_node: node,
    led_mode: on ? 'on' : 'off',
    led_on_time: 500,
    led_off_time: 500,
    loop_times: 1,
    interval_time: 1000,
  },
});

export const nozzleTemp = (temp: number) => gcode(`M104 S${temp}`);

/** Multi-extruder printers (H2D): extruder 0 = right, 1 = left. */
export const nozzleTempIndexed = (extruderIndex: number, temp: number) =>
  print({ command: 'set_nozzle_temp', extruder_index: extruderIndex, target_temp: temp });

export const bedTemp = (temp: number) => gcode(`M140 S${temp}`);

/** Chamber temperature target (X1E / H2 series). */
export const chamberTemp = (temp: number) => print({ command: 'set_ctt', ctt_val: temp });

/** fan: 1 = part cooling, 2 = auxiliary, 3 = chamber. percent 0..100 */
export const fanSpeed = (fan: 1 | 2 | 3, percent: number) =>
  gcode(`M106 P${fan} S${Math.round((Math.max(0, Math.min(100, percent)) / 100) * 255)}`);

export const homeAll = () => gcode('G28');

/** Relative jog, same sequence LanBu sends (soft endstops on, relative mode, restore). */
export function jog(axis: 'X' | 'Y' | 'Z', mm: number) {
  const feed = axis === 'Z' ? 900 : 3000;
  return gcode(
    `M211 S \nM211 X1 Y1 Z1\nM1002 push_ref_mode\nG91 \nG1 ${axis}${mm.toFixed(2)} F${feed}\nM1002 pop_ref_mode\nM211 R\n`,
  );
}

/** Extrude (positive) or retract (negative). Nozzle must be above ~170°C. */
export const extrude = (mm: number) => gcode(`M83 \nG0 E${mm.toFixed(2)} F900\n`);

export interface PrintFileOptions {
  url: string;
  fileName: string;
  plate: number;
  bedLeveling: boolean;
  timelapse: boolean;
  useAms: boolean;
  flowCali: boolean;
  vibrationCali: boolean;
  layerInspect: boolean;
  amsMapping?: number[];
}

export function printProjectFile(o: PrintFileOptions): Command {
  return print({
    command: 'project_file',
    param: `Metadata/plate_${o.plate}.gcode`,
    url: o.url,
    file: o.fileName,
    subtask_name: o.fileName.replace(/(\.gcode)?\.3mf$/i, ''),
    md5: '',
    profile_id: '0',
    project_id: '0',
    subtask_id: '0',
    task_id: '0',
    bed_type: 'auto',
    bed_leveling: o.bedLeveling,
    timelapse: o.timelapse,
    use_ams: o.useAms,
    flow_cali: o.flowCali,
    vibration_cali: o.vibrationCali,
    layer_inspect: o.layerInspect,
    ...(o.amsMapping ? { ams_mapping: o.amsMapping } : {}),
  });
}

/** Unload the currently loaded AMS filament. */
export const unloadFilament = () => print({ command: 'unload_filament' });

/** Load an AMS tray (ams 0..3, tray 0..3) or 254 for the external spool. */
export const loadFilament = (trayId: number) =>
  print({ command: 'ams_change_filament', target: trayId, curr_temp: 220, tar_temp: 220 });

/**
 * Skip objects of the running print (`identify_id`s from the job's slice_info.config).
 * Same shape as Bambu Studio's partskip command; the printer reports skipped ids in `s_obj`.
 */
export const skipObjects = (ids: number[]) => print({ command: 'skip_objects', obj_list: ids });
