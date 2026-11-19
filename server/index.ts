import { pruneAudit } from './audit.ts';
import { pruneLoginFailures, pruneSessions } from './auth.ts';
import { buildApp } from './app.ts';
import { config } from './config.ts';
import { manager } from './manager.ts';
import { APP_VERSION } from './version.ts';

const app = await buildApp();

manager.init();
const housekeeping = () => {
  pruneSessions();
  pruneAudit();
  pruneLoginFailures();
};
housekeeping();
setInterval(housekeeping, 15 * 60 * 1000).unref();

if (!config.cookieSecure) {
  app.log.warn('Serving over plain HTTP. Use HTTPS (TLS_CERT_FILE/TLS_KEY_FILE or a reverse proxy) outside a trusted LAN.');
}

const shutdown = async () => {
  manager.shutdown();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.log.info(`Bambu Controller ${APP_VERSION}`);
await app.listen({ port: config.port, host: config.host });
