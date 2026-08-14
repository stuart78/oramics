/**
 * Dev launcher: start Vite, wait for the port, then start Electron pointed at
 * it. Written by hand rather than with concurrently + wait-on because it is
 * twenty lines and those are two more dependencies to keep current.
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '../app');
const PORT = 5273;
// Not '127.0.0.1': Vite binds IPv6 [::1] by default on macOS, so a hardcoded
// IPv4 literal gets ERR_CONNECTION_REFUSED. Let the resolver pick the family.
const HOST = 'localhost';

const children = [];
const shutdown = (code = 0) => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
};
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const portOpen = () =>
  new Promise((res) => {
    const socket = net.connect(PORT, HOST);
    socket.once('connect', () => {
      socket.destroy();
      res(true);
    });
    socket.once('error', () => {
      socket.destroy();
      res(false);
    });
  });

const waitForPort = async (timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Vite did not open ${HOST}:${PORT} within ${timeoutMs} ms`);
};

const vite = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort'], {
  cwd: appDir,
  stdio: 'inherit',
  shell: false,
});
children.push(vite);
vite.on('exit', (code) => {
  if (code) shutdown(code);
});

await waitForPort();

const electron = spawn('pnpm', ['exec', 'electron', '.'], {
  cwd: here,
  stdio: 'inherit',
  shell: false,
  env: { ...process.env, ORAMICS_DEV_URL: `http://${HOST}:${PORT}/` },
});
children.push(electron);
electron.on('exit', (code) => shutdown(code ?? 0));
