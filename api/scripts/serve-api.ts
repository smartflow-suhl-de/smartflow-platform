/** Starts the API. */
import { buildApp } from '../src/kernel/app.ts';
import { ensureDataDir, loadConfig } from '../src/kernel/config.ts';

const config = loadConfig();
ensureDataDir(config);

const { app } = await buildApp({ config });

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`API bereit: http://${config.host}:${config.port}/api/v1/health`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
