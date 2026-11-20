/** Printer storage: paths and the file types the app handles. */

/** `dir` + `name` on the printer's storage (paths are absolute, "/" is the root). */
export const joinPath = (dir: string, name: string) => `${dir === '/' ? '' : dir}/${name}`;

const extensionOf = (name: string) => /\.([^./]+)$/.exec(name)?.[1].toLowerCase() ?? '';

/** Files the printer can print: the only types accepted for upload. */
export const UPLOADABLE = /\.(3mf|gcode)$/i;
/** Sliced projects, which this app can start (project_file command). */
export const PROJECT_FILE = /\.3mf$/i;

/** A project's name: its file name without `.gcode.3mf` / `.3mf` (what printers report as `subtask_name`). */
export const projectName = (fileName: string) => fileName.replace(/(\.gcode)?\.3mf$/i, '');

/** Media served from storage: how the browser shows them, and those ffmpeg converts to MP4 first (no seeking). */
const MEDIA: Record<string, { kind: 'video' | 'image'; type: string; transcoded?: true }> = {
  mp4: { kind: 'video', type: 'video/mp4' },
  m4v: { kind: 'video', type: 'video/mp4' },
  mov: { kind: 'video', type: 'video/quicktime' },
  webm: { kind: 'video', type: 'video/webm' },
  avi: { kind: 'video', type: 'video/mp4', transcoded: true },
  mkv: { kind: 'video', type: 'video/mp4', transcoded: true },
  jpg: { kind: 'image', type: 'image/jpeg' },
  jpeg: { kind: 'image', type: 'image/jpeg' },
  png: { kind: 'image', type: 'image/png' },
  gif: { kind: 'image', type: 'image/gif' },
  bmp: { kind: 'image', type: 'image/bmp' },
};

export const mediaOf = (name: string) => MEDIA[extensionOf(name)] ?? null;
