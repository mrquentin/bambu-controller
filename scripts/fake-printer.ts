/**
 * Minimal Bambu printer simulator for local development (A1/P1-style).
 *
 *   npm run fake-printer
 *
 * Then add a printer with IP 127.0.0.1, serial 01P00A000000001, access code
 * 12345678, model P1S. Provides:
 *   - MQTT over TLS on :8883 (user bblp / access code) with push_status reports
 *   - JPEG camera over TLS on :6000 (frames from ffmpeg's test source if available)
 *   - implicit FTPS on :990 (FAKE_FTP_PORT) with an in-memory storage holding a
 *     sample project for the running job (/cache/Benchy.gcode.3mf), so "Skip
 *     objects" works; add the printer with certificate verification off.
 *
 * The next demo print starts by itself shortly after one finishes or is stopped
 * (set FAKE_AUTO_PRINT=0 to disable), which keeps the print history moving.
 * Type a key + Enter to drive print-job events (for notifications):
 * s start · p pause (runout) · r resume · f finish · x fail · h HMS alert ·
 * z stop/resume reporting (the MQTT socket stays open, like a printer whose
 * Wi-Fi dropped or that went to sleep: the app flags it stale, then reconnects) · ? help.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline';
import tls from 'node:tls';
import { Aedes } from 'aedes';
import selfsigned from 'selfsigned';
import { startFakeFtps } from './fake-ftps.ts';
import { buildSample3mf } from './sample-3mf.ts';

const SERIAL = process.env.FAKE_SERIAL ?? '01P00A000000001';
const ACCESS_CODE = process.env.FAKE_ACCESS_CODE ?? '12345678';
const HOST = process.env.FAKE_HOST ?? '127.0.0.1';
const FTP_PORT = Number(process.env.FAKE_FTP_PORT ?? 990);

const pems = await selfsigned.generate([{ name: 'commonName', value: SERIAL }], { keySize: 2048 });
const tlsOptions = { key: pems.private, cert: pems.cert };

// ---------------------------------------------------------------- state

const state: Record<string, any> = {
  command: 'push_status',
  gcode_state: 'RUNNING',
  mc_percent: 12,
  mc_remaining_time: 95,
  layer_num: 18,
  total_layer_num: 150,
  subtask_name: 'Benchy',
  gcode_file: '/data/Metadata/plate_1.gcode',
  s_obj: [],
  stg_cur: 0,
  nozzle_temper: 219.8,
  nozzle_target_temper: 220,
  bed_temper: 54.9,
  bed_target_temper: 55,
  chamber_temper: 31,
  cooling_fan_speed: '15',
  big_fan1_speed: '7',
  big_fan2_speed: '0',
  heatbreak_fan_speed: '15',
  spd_lvl: 2,
  spd_mag: 100,
  wifi_signal: '-48dBm',
  nozzle_diameter: '0.4',
  nozzle_type: 'stainless_steel',
  home_flag: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 8),
  lights_report: [{ node: 'chamber_light', mode: 'on' }],
  hms: [{ attr: 0x07008000, code: 0x00030001 }],
  ipcam: { ipcam_record: 'enable', timelapse: 'disable' },
  vt_tray: { id: '254', tray_type: '', tray_color: '00000000' },
  ams: {
    tray_now: '1',
    ams: [
      {
        id: '0',
        humidity: '4',
        temp: '24.5',
        tray: [
          { id: '0', tray_type: 'PLA', tray_sub_brands: 'PLA Basic', tray_color: 'FFFFFFFF', remain: 80 },
          { id: '1', tray_type: 'PLA', tray_sub_brands: 'PLA Matte', tray_color: '161616FF', remain: 45 },
          { id: '2', tray_type: 'PETG', tray_sub_brands: 'PETG HF', tray_color: 'E4572EFF', remain: 100 },
          { id: '3' },
        ],
      },
    ],
  },
};

// ---------------------------------------------------------------- MQTT

const broker = await Aedes.createBroker();
broker.authenticate = (_client, username, password, done) => {
  const ok = username === 'bblp' && password?.toString() === ACCESS_CODE;
  done(ok ? null : Object.assign(new Error('Bad username or password'), { returnCode: 4 }), ok);
};

const reportTopic = `device/${SERIAL}/report`;
/** Toggled with `z`: keep connections open but send nothing (simulates a silent printer). */
let silent = false;
const publish = (payload: unknown) =>
  !silent &&
  broker.publish(
    { cmd: 'publish', topic: reportTopic, payload: Buffer.from(JSON.stringify(payload)), qos: 0, retain: false, dup: false },
    () => {},
  );

/** Start a print: PREPARE, then RUNNING a few seconds later. */
function startJob(name: string, totalLayers = 150) {
  Object.assign(state, {
    gcode_state: 'PREPARE',
    mc_percent: 0,
    layer_num: 0,
    total_layer_num: totalLayers,
    mc_remaining_time: 100,
    subtask_name: name,
    print_error: 0,
    s_obj: [],
  });
  const { gcode_state, mc_percent, layer_num, total_layer_num, mc_remaining_time, subtask_name, print_error, s_obj } = state;
  publish({
    print: { command: 'push_status', gcode_state, mc_percent, layer_num, total_layer_num, mc_remaining_time, subtask_name, print_error, s_obj },
  });
  setTimeout(() => {
    if (state.gcode_state !== 'PREPARE') return;
    state.gcode_state = 'RUNNING';
    publish({ print: { command: 'push_status', gcode_state: 'RUNNING' } });
  }, 4000);
}

const AUTO_PRINT = process.env.FAKE_AUTO_PRINT !== '0';
const DEMO_JOBS: [string, number][] = [
  ['Calibration cube', 100],
  ['Cable clip', 40],
  ['Benchy', 150],
];
let demoIndex = 0;
let nextDemo: NodeJS.Timeout | null = null;

/** After a print ends, queue the next demo print. */
function scheduleNextJob() {
  if (!AUTO_PRINT || nextDemo) return;
  nextDemo = setTimeout(() => {
    nextDemo = null;
    if (state.gcode_state !== 'FINISH' && state.gcode_state !== 'FAILED' && state.gcode_state !== 'IDLE') return;
    const [name, layers] = DEMO_JOBS[demoIndex++ % DEMO_JOBS.length];
    console.log(`starting demo print "${name}"`);
    startJob(name, layers);
  }, 20_000);
}

broker.on('publish', (packet, client) => {
  if (!client || packet.topic !== `device/${SERIAL}/request`) return;
  const msg = JSON.parse(packet.payload.toString());
  console.log('<-', JSON.stringify(msg));
  const p = msg.print;
  if (msg.pushing?.command === 'pushall') return publish({ print: state });
  if (msg.info?.command === 'get_version') {
    return publish({
      info: {
        command: 'get_version',
        sequence_id: msg.info.sequence_id,
        module: [
          { name: 'ota', sw_ver: '01.08.02.00', hw_ver: '', sn: SERIAL },
          { name: 'mc', sw_ver: '00.00.29.40', hw_ver: 'MC07', sn: 'N/A' },
        ],
      },
    });
  }
  if (msg.system?.command === 'ledctrl') {
    state.lights_report = [{ node: msg.system.led_node, mode: msg.system.led_mode }];
    publish({ system: { ...msg.system, result: 'success' } });
    return publish({ print: { command: 'push_status', lights_report: state.lights_report } });
  }
  if (!p) return;
  const patch: Record<string, unknown> = {};
  switch (p.command) {
    case 'pause':
      patch.gcode_state = 'PAUSE';
      break;
    case 'resume':
      patch.gcode_state = 'RUNNING';
      break;
    case 'stop':
      patch.gcode_state = 'FAILED';
      scheduleNextJob();
      break;
    case 'print_speed':
      patch.spd_lvl = Number(p.param);
      break;
    case 'project_file':
      startJob(String(p.subtask_name || 'Untitled'));
      break;
    case 'skip_objects': {
      const ids = Array.isArray(p.obj_list) ? p.obj_list.filter((v: unknown) => Number.isInteger(v)) : [];
      if (!ids.length) {
        return publish({ print: { command: p.command, sequence_id: p.sequence_id, result: 'fail', reason: 'empty obj_list' } });
      }
      patch.s_obj = [...new Set([...state.s_obj, ...ids])];
      break;
    }
    case 'gcode_line': {
      const m104 = /M104 S(\d+)/.exec(p.param);
      const m140 = /M140 S(\d+)/.exec(p.param);
      const m106 = /M106 P(\d) S(\d+)/.exec(p.param);
      if (m104) patch.nozzle_target_temper = Number(m104[1]);
      if (m140) patch.bed_target_temper = Number(m140[1]);
      if (m106) {
        const key = { 1: 'cooling_fan_speed', 2: 'big_fan1_speed', 3: 'big_fan2_speed' }[Number(m106[1])];
        if (key) patch[key] = String(Math.round((Number(m106[2]) / 255) * 15));
      }
      break;
    }
  }
  Object.assign(state, patch);
  publish({ print: { command: p.command, sequence_id: p.sequence_id, result: 'success', reason: '' } });
  if (Object.keys(patch).length) publish({ print: { command: 'push_status', ...patch } });
});

// Partial updates once per second, like a P1/A1.
setInterval(() => {
  const approach = (cur: number, target: number) => cur + (target - cur) * 0.3 + (Math.random() - 0.5) * 0.4;
  state.nozzle_temper = Math.round(approach(state.nozzle_temper, state.nozzle_target_temper || 25) * 10) / 10;
  state.bed_temper = Math.round(approach(state.bed_temper, state.bed_target_temper || 25) * 10) / 10;
  const patch: Record<string, unknown> = {
    command: 'push_status',
    nozzle_temper: state.nozzle_temper,
    bed_temper: state.bed_temper,
  };
  if (state.gcode_state === 'RUNNING' && Math.random() < 0.2) {
    state.mc_percent = Math.min(100, state.mc_percent + 1);
    state.layer_num = Math.min(state.total_layer_num, state.layer_num + 1);
    state.mc_remaining_time = Math.max(0, state.mc_remaining_time - 1);
    Object.assign(patch, { mc_percent: state.mc_percent, layer_num: state.layer_num, mc_remaining_time: state.mc_remaining_time });
    if (state.mc_percent >= 100) {
      patch.gcode_state = state.gcode_state = 'FINISH';
      scheduleNextJob();
    }
  }
  publish({ print: patch });
}, 1000);

tls.createServer(tlsOptions, broker.handle as (socket: net.Socket) => void).listen(8883, HOST, () =>
  console.log(`MQTT (TLS)   ${HOST}:8883`),
);

// ---------------------------------------------------------------- camera

let latestFrame: Buffer | null = null;
const ff = spawn(
  'ffmpeg',
  ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=5', '-c:v', 'mjpeg', '-q:v', '6', '-f', 'image2pipe', 'pipe:1'],
  { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
);
ff.on('error', () => console.warn('ffmpeg not found: camera will not produce frames'));
let pending: Buffer = Buffer.alloc(0);
ff.stdout.on('data', (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const start = pending.indexOf(Buffer.from([0xff, 0xd8]));
    const end = start < 0 ? -1 : pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) break;
    latestFrame = pending.subarray(start, end + 2);
    pending = pending.subarray(end + 2);
  }
});

tls
  .createServer(tlsOptions, (socket) => {
    let authed = false;
    let buf: Buffer = Buffer.alloc(0);
    let timer: NodeJS.Timeout | null = null;
    socket.on('data', (chunk) => {
      if (authed) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 80) return;
      const user = buf.subarray(16, 48).toString('ascii').replace(/\0+$/, '');
      const code = buf.subarray(48, 80).toString('ascii').replace(/\0+$/, '');
      if (buf.readUInt32LE(0) !== 0x40 || buf.readUInt32LE(4) !== 0x3000 || user !== 'bblp' || code !== ACCESS_CODE) {
        console.log('camera: bad auth packet');
        return socket.destroy();
      }
      authed = true;
      console.log('camera: client authenticated');
      timer = setInterval(() => {
        if (!latestFrame) return;
        const header = Buffer.alloc(16);
        header.writeUInt32LE(latestFrame.length, 0);
        socket.write(Buffer.concat([header, latestFrame]));
      }, 200);
    });
    const cleanup = () => timer && clearInterval(timer);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  })
  .listen(6000, HOST, () => console.log(`Camera (TLS) ${HOST}:6000`));

// ---------------------------------------------------------------- keyboard

const HELP = 'Keys (+ Enter): s start · p pause (runout) · r resume · f finish · x fail · h HMS alert · z silence on/off · ? help';
const update = (patch: Record<string, unknown>) => {
  Object.assign(state, patch);
  publish({ print: { command: 'push_status', ...patch } });
  console.log('->', JSON.stringify(patch));
};
const actions: Record<string, () => void> = {
  s: () => {
    update({ gcode_state: 'PREPARE', mc_percent: 0, layer_num: 0, mc_remaining_time: 95, print_error: 0, s_obj: [], subtask_name: `Benchy ${new Date().toLocaleTimeString()}` });
    setTimeout(() => update({ gcode_state: 'RUNNING' }), 3000);
  },
  p: () => update({ gcode_state: 'PAUSE', print_error: 0x07008011 }), // AMS filament ran out
  r: () => update({ gcode_state: 'RUNNING', print_error: 0 }),
  f: () => update({ gcode_state: 'FINISH', mc_percent: 100, layer_num: state.total_layer_num, mc_remaining_time: 0, print_error: 0 }),
  x: () => update({ gcode_state: 'FAILED', print_error: 0x0300400c }),
  h: () => update({ hms: [...state.hms, { attr: 0x03001000, code: 0x00020000 + Math.floor(Math.random() * 0xffff) }] }),
  z: () => {
    silent = !silent;
    console.log(silent ? 'silent: reports stopped (connections stay open)' : 'reporting again');
  },
  '?': () => console.log(HELP),
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const action = actions[line.trim().toLowerCase()];
  if (action) action();
  else if (line.trim()) console.log(HELP);
});

// ---------------------------------------------------------------- storage (FTPS)

const files = new Map<string, Buffer>([['/cache/Benchy.gcode.3mf', buildSample3mf()]]);
startFakeFtps({ host: HOST, port: FTP_PORT, password: ACCESS_CODE, tlsOptions, files }).then(
  () => console.log(`FTPS         ${HOST}:${FTP_PORT}`),
  (err) => console.warn(`FTPS not available on port ${FTP_PORT}: ${err.message} (set FAKE_FTP_PORT)`),
);

console.log(`Fake printer serial=${SERIAL} access code=${ACCESS_CODE}`);
console.log(HELP);
