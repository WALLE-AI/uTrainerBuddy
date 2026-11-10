import { realpath, stat } from 'node:fs/promises';
import { relative, isAbsolute, resolve } from 'node:path';

// Read-only gate: never provision a sandbox or read credentials during preflight.
export async function verifyAgentPrerequisites({ binary, nativeHome, tests }) {
  const failures = [];
  let canonicalBinary;
  let canonicalHome;
  if (!binary) failures.push('Pass --codex-binary with the exact installed codex.exe path');
  else {
    try {
      canonicalBinary = await realpath(binary);
      if (!(await stat(canonicalBinary)).isFile()) throw new Error('not a file');
    } catch { failures.push('Codex binary unavailable: ' + binary); }
  }
  if (!nativeHome) failures.push('Pass --agent-home with an explicitly prepared isolated test home');
  else {
    try {
      const canonicalTests = await realpath(tests);
      canonicalHome = await realpath(nativeHome);
      const subpath = relative(canonicalTests, canonicalHome);
      if (!subpath || subpath === '..' || subpath.startsWith('../') || subpath.startsWith('..\\') || isAbsolute(subpath)) {
        throw new Error('home must be inside the isolated research tests directory');
      }
      if (!(await stat(resolve(canonicalHome, '.sandbox/setup_marker.json'))).isFile()) {
        throw new Error('sandbox setup marker is not a file');
      }
    } catch (error) {
      failures.push('Prepared test home unavailable: ' + nativeHome + ' (' + (error.code ?? error.message) + ')');
    }
  }
  if (failures.length) throw new Error('Agent prerequisites failed; no test services, workspace or model call were started:\n- ' + failures.join('\n- '));
  return { binary: canonicalBinary, nativeHome: canonicalHome };
}
