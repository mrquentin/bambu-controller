import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';

/** config.ts reads the environment at import time, so load it in a child process. */
function loadConfig(env: Record<string, string>) {
  const configUrl = new URL('../server/config.ts', import.meta.url).href;
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `const { config } = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify(config));`],
    { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' },
  );
  return JSON.parse(out);
}

describe('configuration from environment variables', () => {
  it('uses defaults when variables are unset', () => {
    const c = loadConfig({});
    assert.equal(c.port, 8080);
    assert.equal(c.sessionIdleMs, 72 * 3600_000);
    assert.equal(c.cookieSecure, false);
  });

  it('treats empty values as unset (Unraid passes blank template fields)', () => {
    const c = loadConfig({ PORT: '', SESSION_IDLE_HOURS: '', SESSION_TTL_DAYS: ' ', DATA_DIR: '', RATE_LIMIT_PER_MINUTE: '' });
    assert.equal(c.port, 8080);
    assert.equal(c.sessionIdleMs, 72 * 3600_000);
    assert.equal(c.sessionTtlMs, 30 * 24 * 3600_000);
    assert.equal(c.rateLimitPerMinute, 600);
    assert.equal(c.dataDir, path.resolve('./data'));
  });

  it('reads explicit values', () => {
    const c = loadConfig({ PORT: '9090', SESSION_IDLE_HOURS: '12', COOKIE_SECURE: 'TRUE' });
    assert.equal(c.port, 9090);
    assert.equal(c.sessionIdleMs, 12 * 3600_000);
    assert.equal(c.cookieSecure, true);
  });

  it('rejects invalid numbers instead of silently using 0', () => {
    assert.throws(() => loadConfig({ PORT: 'abc' }), /Invalid PORT/);
    assert.throws(() => loadConfig({ SESSION_IDLE_HOURS: '0' }), /Invalid SESSION_IDLE_HOURS/);
  });
});
