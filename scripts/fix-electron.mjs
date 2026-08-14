/**
 * Repair a partial Electron install.
 *
 * On macOS, electron's postinstall uses extract-zip, which can silently produce
 * a ~250 KB `dist` instead of the real ~250 MB one — it does not handle the
 * symlinks inside Electron.app (Frameworks, Versions/Current) and gives up
 * without an error or a non-zero exit. The symptom is:
 *
 *   Error: Electron failed to install correctly, please delete node_modules/electron
 *
 * The download itself is usually fine and already cached, so this re-extracts
 * that cached zip with `ditto`, which does understand app bundles.
 *
 * Not wired as an automatic postinstall: it is a macOS-specific workaround for
 * something that does not always happen, and running `ditto` on every install
 * is more machinery than the problem deserves. Run it when you see the error.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve from the shell package, not the repo root: under pnpm's strict
// node_modules layout electron is only visible to the package that depends
// on it.
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../packages/shell/package.json'));

if (process.platform !== 'darwin') {
  console.log('Not macOS — nothing to do.');
  process.exit(0);
}

const pkgPath = require.resolve('electron/package.json');
const dir = join(pkgPath, '..');
const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
const distDir = join(dir, 'dist');
const platformPath = 'Electron.app/Contents/MacOS/Electron';

const sizeOf = (p) => {
  try {
    return Number(execFileSync('du', ['-sk', p], { encoding: 'utf8' }).split('\t')[0]);
  } catch {
    return 0;
  }
};

// A healthy install is a few hundred megabytes; anything under 50 MB is the
// truncated extract rather than a real Electron.
const kb = existsSync(distDir) ? sizeOf(distDir) : 0;
if (kb > 50_000 && existsSync(join(dir, 'path.txt'))) {
  console.log(`Electron ${version} looks fine (${Math.round(kb / 1024)} MB).`);
  process.exit(0);
}

const arch = process.arch === 'x64' ? 'x64' : 'arm64';
const zip = join(homedir(), 'Library/Caches/electron', `electron-v${version}-darwin-${arch}.zip`);
if (!existsSync(zip)) {
  console.error(`No cached zip at ${zip}\nRun \`pnpm install\` once to download it, then re-run this.`);
  process.exit(1);
}

console.log(`Re-extracting ${zip} (${Math.round(statSync(zip).size / 1e6)} MB) with ditto…`);
execFileSync('rm', ['-rf', distDir]);
execFileSync('mkdir', ['-p', distDir]);
execFileSync('ditto', ['-xk', zip, distDir], { stdio: 'inherit' });
writeFileSync(join(dir, 'path.txt'), platformPath);

const out = execFileSync(join(distDir, platformPath), ['--version'], { encoding: 'utf8' }).trim();
console.log(`Repaired: ${out} (${Math.round(sizeOf(distDir) / 1024)} MB)`);
