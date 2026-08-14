/**
 * Copy the built renderer into the shell package so the packaged app has a
 * self-contained layout.
 *
 * Without this the main process would reach across the workspace into
 * ../app/dist, which exists in the repo but not inside an .app bundle. Staging
 * it means `files` in the electron-builder config is four entries and the
 * packaged app needs no node_modules whatsoever — everything the renderer uses
 * is already bundled by Vite.
 */

import { cp, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '../app/dist');
const target = join(here, 'renderer');

try {
  await stat(join(source, 'index.html'));
} catch {
  console.error(`No renderer build at ${source}\nRun \`pnpm --filter @oramics/app run build\` first.`);
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
console.log(`staged renderer -> ${target}`);
