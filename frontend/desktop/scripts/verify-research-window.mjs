// Builds an isolated Electron harness around the actual production gateway.
// Does not use existing workspaces, send Agent prompts or connect to user SSH hosts.
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');
const tests = resolve(root, '.tools/research-core/tests');
await mkdir(tests, { recursive: true });
const folder = await mkdtemp(resolve(tests, 'electron-'));
assert.equal(dirname(resolve(folder)), tests, 'Test cleanup must stay in the workspace test directory');
const mainApp = process.argv.includes('--main-app');
try {
  const main = resolve(folder, 'main.cjs');
  await build({ entryPoints: [resolve(desktop, mainApp ? 'scripts/research-main-app-harness.ts' : 'scripts/research-window-harness.ts')], outfile: main,
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning' });
  const env = { ...process.env, TRAINERBUDDY_RESEARCH_TEST_ROOT: root, TRAINERBUDDY_RESEARCH_TEST_DIR: folder };
  if (mainApp) Object.assign(env, { UBIDBUDDY_E2E_TEST: '1',
    TRAINERBUDDY_DESKTOP_DATA_DIR: resolve(folder, 'desktop'), TRAINERBUDDY_DATA_DIR: resolve(folder, 'backend'),
    TRAINERBUDDY_BACKEND_BIN: resolve(root, 'backend/target/debug/trainerbuddy-backend.exe'),
    TRAINERBUDDY_RESEARCH_CORE_DIR: resolve(root, 'research-core/dist/windows-x86_64') });
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  await new Promise((resolveExit, reject) => {
    const child = spawn(resolve(desktop, 'node_modules/electron/dist/electron.exe'), [main],
      { cwd: mainApp ? desktop : folder, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveExit() : reject(Error(`Research window test exited ${code}`)));
  });
} finally {
  // mkdtemp above is the only source of this absolute, workspace-contained path.
  await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
