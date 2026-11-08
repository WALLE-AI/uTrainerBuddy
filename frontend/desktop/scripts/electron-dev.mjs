import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cargo, run, repoRoot, rustEnv } from '../../../backend/scripts/toolchain.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await run(cargo, ['build']);
const dataRoot = resolve(repoRoot, '.data');
mkdirSync(dataRoot, { recursive: true });
const child = spawn(process.execPath, [resolve(desktopRoot, 'node_modules/electron-vite/bin/electron-vite.js'), 'dev', '--config', 'electron.vite.config.ts', ...process.argv.slice(2)], {
  cwd: desktopRoot, stdio: 'inherit', windowsHide: true,
  env: { ...rustEnv,
    TRAINERBUDDY_DATA_DIR: process.env.TRAINERBUDDY_DATA_DIR || resolve(dataRoot, 'backend'),
    TRAINERBUDDY_DESKTOP_DATA_DIR: process.env.TRAINERBUDDY_DESKTOP_DATA_DIR || resolve(dataRoot, 'desktop'),
  },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
