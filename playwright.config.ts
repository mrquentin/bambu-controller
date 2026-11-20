import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests: the built frontend + app server against the fake printer
 * (scripts/fake-printer.ts). Everything runs on 127.0.0.1 with a throwaway
 * DATA_DIR. The fake printer needs the real printer ports (MQTT 8883, camera
 * 6000, FTPS 990: the app always dials those), so don't run `npm run
 * fake-printer` at the same time. On Linux, binding 990 needs
 * `sysctl net.ipv4.ip_unprivileged_port_start=0` (see the CI workflow).
 *
 * The config is evaluated again in every worker: values are kept in env vars
 * so all processes agree on the same ports and data directory.
 */

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

process.env.E2E_APP_PORT ||= String(await freePort());
process.env.E2E_CONTROL_PORT ||= String(await freePort());
process.env.E2E_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'bambu-controller-e2e-'));

const appPort = process.env.E2E_APP_PORT;
const controlPort = process.env.E2E_CONTROL_PORT;
const baseURL = `http://127.0.0.1:${appPort}`;
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  // One app server and one fake printer are shared by every test.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // First run (creates the admin) and login/logout; saves the session for the rest.
    { name: 'setup', testMatch: /auth\.setup\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'chromium',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'test-results/.auth/admin.json' },
    },
  ],
  webServer: [
    {
      command: 'node scripts/fake-printer.ts',
      url: `http://127.0.0.1:${controlPort}/health`,
      env: {
        FAKE_HOST: '127.0.0.1',
        FAKE_AUTO_PRINT: '0',
        FAKE_DETERMINISTIC: '1',
        FAKE_CONTROL_PORT: controlPort,
      },
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npm run build && node server/index.ts',
      url: `${baseURL}/api/health`,
      env: {
        HOST: '127.0.0.1',
        PORT: appPort,
        DATA_DIR: process.env.E2E_DATA_DIR,
        APP_SECRET: 'e2e-test-secret-not-for-production',
        LOG_LEVEL: 'warn',
      },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
