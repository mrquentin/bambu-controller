/**
 * Loaded before every test file (node --import). Modules read their config at
 * import time, so the environment must be prepared first: an isolated data
 * directory and a fixed encryption key.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bambu-controller-test-'));
process.env.APP_SECRET = 'test-secret-key-for-unit-tests-only';
process.env.LOG_LEVEL = 'silent';
