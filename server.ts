/**
 * Root entry point for production deployment.
 * Executes the compiled Angular SSR Express server from dist/app/server/server.mjs.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const distServer = join(process.cwd(), 'dist', 'app', 'server', 'server.mjs');

if (existsSync(distServer)) {
  await import(distServer);
} else {
  // If running in development where dist is not built yet, delegate to src/server.ts
  await import('./src/server.ts');
}
