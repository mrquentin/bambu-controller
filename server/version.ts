import fs from 'node:fs';
import path from 'node:path';

/**
 * Release version. CI injects APP_VERSION (from semantic-release) into the
 * Docker image; local runs fall back to package.json.
 */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'));
    return String(pkg.version);
  } catch {
    return 'dev';
  }
}

export const APP_VERSION = process.env.APP_VERSION || packageVersion();
