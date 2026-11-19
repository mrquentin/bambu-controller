# Bambu Lab LAN protocol notes

Recovered by decompiling **LanBu 0.63** (`com.Glowbeast.LanBu`, a Unity IL2CPP app) with
Il2CppDumper and resolving string literals/constants referenced by the ARM64 code of each
method, then cross-checked against [openbu](https://github.com/cygnusx-1-org/openbu).
The printer must be in **LAN Only Mode** (recent firmware also needs **Developer Mode** for
third-party control). Credentials everywhere: user `bblp`, password = 8-char access code.

TLS: every service uses a per-device certificate (CN = serial) signed by the self-signed
"BBL CA" (embedded in LanBu as `bambuCertificateString`; saved here as `server/bambu/bbl-ca.pem`).
This app verifies the chain against that CA and requires CN = the printer's serial number
(verified on an X1C for ports 8883, 990, 6000 and 322).

## Services

| Port | Protocol | Use |
|------|----------|-----|
| 8883 | MQTT 3.1.1 over TLS | status reports + commands |
| 6000 | raw TLS | camera, A1 / A1 mini / P1P / P1S (JPEG frames) |
| 322  | RTSPS | camera, X1 / X1C / X1E / H2* / P2S (H.264, `/streaming/live/1`) |
| 990  | implicit FTPS | SD card / storage (`PBSZ 0`, `PROT P`, `PASV`) |
| 2021, 1990 (UDP) | SSDP | discovery (`NOTIFY` broadcasts, `M-SEARCH` to 239.255.255.250:1990) |

## MQTT

- Subscribe `device/{serial}/report`, publish to `device/{serial}/request`.
- `{"pushing":{"sequence_id":"0","command":"pushall","version":1,"push_target":1}}` → full status.
- `{"info":{"sequence_id":"0","command":"get_version"}}` → firmware modules.
- P1/A1 send **partial** `push_status` reports; merge them into the previous state.

Commands (`sequence_id` is any string):

| Action | Payload |
|--------|---------|
| Pause / resume / stop | `{"print":{"command":"pause"\|"resume"\|"stop","param":""}}` |
| Speed level 1–4 | `{"print":{"command":"print_speed","param":"2"}}` |
| Light | `{"system":{"command":"ledctrl","led_node":"chamber_light","led_mode":"on","led_on_time":500,"led_off_time":500,"loop_times":1,"interval_time":1000}}` |
| G-code | `{"print":{"command":"gcode_line","param":"M104 S220\n"}}` |
| Nozzle temp (multi-extruder) | `{"print":{"command":"set_nozzle_temp","extruder_index":0,"target_temp":220}}` |
| Chamber temp | `{"print":{"command":"set_ctt","ctt_val":40}}` |
| Fan (new firmware) | `{"print":{"command":"set_fan","fan_index":N,"speed":N}}` |
| Print file | `{"print":{"command":"project_file","param":"Metadata/plate_1.gcode","url":"ftp:///cache/x.3mf" or "file:///sdcard/cache/x.3mf","bed_leveling":true,"use_ams":true,"timelapse":false,"flow_cali":true,"vibration_cali":false,"layer_inspect":true,"bed_type":"auto",...}}` |

G-code used by LanBu: `M140 S<t>` bed, `M104 S<t>` nozzle, `M106 P1|P2|P3 S<0-255>` part/aux/chamber fan,
`G28` home, jog = `M211 S\nM211 X1 Y1 Z1\nM1002 push_ref_mode\nG91\nG1 X10.00 F3000\nM1002 pop_ref_mode\nM211 R` (Z uses F900),
extrude = `M83\nG0 E10.00 F900` (nozzle ≥ 170 °C).

## Report fields (`print`)

`gcode_state` (IDLE/PREPARE/RUNNING/PAUSE/FINISH/FAILED), `mc_percent`, `mc_remaining_time` (min),
`layer_num`, `total_layer_num`, `subtask_name`, `stg_cur`, `nozzle_temper`, `nozzle_target_temper`,
`bed_temper`, `bed_target_temper`, `chamber_temper`, `ctt`, `cooling_fan_speed` / `big_fan1_speed` /
`big_fan2_speed` / `heatbreak_fan_speed` (strings 0–15), `spd_lvl`, `spd_mag`, `home_flag`, `wifi_signal`,
`nozzle_diameter`, `nozzle_type`, `lights_report[{node,mode}]`, `hms[{attr,code}]`, `ipcam`, `vt_tray`,
`ams{tray_now,ams[{id,humidity,humidity_raw,temp,tray[{id,tray_type,tray_color,remain,...}]}]}`,
`device{extruder{info[{id,temp,snow}],state},ctc{info{temp}},airduct{parts[{id,func,state}]}}` (H2 series).

Bit layouts (from `BambuUtility`):
- packed temperature (`device.extruder.info[].temp`, `device.ctc.info.temp`): current = `v & 0xFFFF`, target = `v >> 16`
- `extruder.state`: count = `v & 0xF`, active nozzle = `(v >> 4) & 0xF`
- `snow`: slot = `v & 0xFF`, AMS id = `(v >> 8) & 0xFF`
- `fan_gear`: part = `v & 0xFF`, aux = `(v >> 8) & 0xFF`, chamber = `(v >> 16) & 0xFF`
- airduct part: fan id = `(id >> 4) & 0xFF`, speed = `state & 0xFF`
- `home_flag`: X/Y/Z homed = bits 0/1/2, 220V = 3, camera recording = 5, SD present = 8, SD abnormal = 9,
  AMS auto switch = 10, wired network = 18, door open = 23
- HMS code: `HMS_{attr>>16}_{attr&0xFFFF}_{code>>16}_{code&0xFFFF}` (hex), severity = `code >> 16`
  (1 fatal, 2 serious, 3 common, 4 info)

## Camera (port 6000)

Send an 80-byte auth packet: `u32le 0x40`, `u32le 0x3000`, `u32le 0`, `u32le 0`, `"bblp"` NUL-padded
to 32 bytes, access code NUL-padded to 32 bytes. Then read frames: a 16-byte header whose first `u32le`
is the payload size, followed by one JPEG.

## Camera (RTSPS 322)

`rtsps://bblp:<code>@<ip>:322/streaming/live/1`, RTP over TCP interleaved, Digest auth, H.264.
On X1 printers enable *LAN Mode Liveview*.

## Model codes (SSDP `DevModel.bambu.com`)

`BL-P001` X1C · `BL-P002` X1 · `C13` X1E · `C11` P1P · `C12` P1S · `N1` A1 mini · `N2S` A1 · `N6` X2D ·
`N7` P2S · `O1D` H2D · `O1E` H2D Pro · `O1S` H2S · `O1C`/`O1C2` H2C
