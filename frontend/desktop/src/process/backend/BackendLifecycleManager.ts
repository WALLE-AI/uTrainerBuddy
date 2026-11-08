import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { mkdir, realpath } from 'node:fs/promises';
import { toNamespacedPath } from 'node:path';
import type { BackendStartupFailureInfo } from '@/common/types/platform/electron';

type Handshake = { type: 'ready'; protocol_version: number; instance_id: string; workspace_id: string; port: number; data_dir: string };

/** Owns only the backend it starts. Business state and Codex processes live in Rust. */
export class BackendLifecycleManager {
  port = 0;
  readonly token = randomBytes(32).toString('hex');
  instanceId = '';
  failure: BackendStartupFailureInfo | null = null;
  private child?: ChildProcessWithoutNullStreams;
  private stopping = false;

  constructor(private readonly options: { binary: string; dataDir: string; origin: string; onFailure: (failure: BackendStartupFailureInfo) => void }) {}

  async start(): Promise<void> {
    await mkdir(this.options.dataDir, { recursive: true });
    const child = spawn(this.options.binary, ['--data-dir', this.options.dataDir], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child = child;
    // Process exit/handshake handling reports the failure; a closed stdin must
    // not turn it into an unhandled EPIPE exception in Electron.
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout });
    let diagnostic = '';
    child.stderr.on('data', (data: Buffer) => { diagnostic = (diagnostic + data.toString()).slice(-4000); });
    child.once('exit', () => {
      if (this.stopping) return;
      this.failure = { reason: 'backend_startup_exited', backendBoundaryStage: 'process_exit' };
      this.options.onFailure(this.failure);
    });
    try {
      const handshake = await new Promise<Handshake>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Rust Backend startup handshake timed out')); }, 20_000);
        const cleanup = () => { clearTimeout(timer); lines.off('line', onLine); child.off('error', onError); child.off('exit', onExit); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onExit = () => { cleanup(); reject(new Error(`Rust Backend exited during startup: ${diagnostic}`)); };
        const onLine = (line: string) => {
          try {
            const value = JSON.parse(line) as Handshake;
            if (value.type !== 'ready' || value.protocol_version !== 1 || !value.instance_id || !value.workspace_id || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('Invalid Backend handshake');
            cleanup(); resolve(value);
          } catch (error) { cleanup(); reject(error); }
        };
        lines.on('line', onLine); child.once('error', onError); child.once('exit', onExit);
        // stdin is the private startup channel; no secrets in command arguments, URLs or logs.
        child.stdin.write(JSON.stringify({ token: this.token, origin: this.options.origin }) + '\n');
      });
      const response = await fetch(`http://127.0.0.1:${handshake.port}/api/v1/health`, {
        headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Backend health check failed (${response.status})`);
      const { data } = await response.json() as { data: { service: string; instance_id: string; protocol_version: number; workspace_id: string; data_dir: string } };
      if (data.service !== 'utrainerbuddy-backend' || data.protocol_version !== 1 || data.instance_id !== handshake.instance_id || data.workspace_id !== handshake.workspace_id || data.data_dir !== handshake.data_dir) throw new Error('Backend identity mismatch');
      const expectedDir = toNamespacedPath(await realpath(this.options.dataDir));
      if (process.platform === 'win32' ? data.data_dir.toLowerCase() !== expectedDir.toLowerCase() : data.data_dir !== expectedDir) throw new Error('Backend data directory mismatch');
      this.port = handshake.port; this.instanceId = handshake.instance_id; this.failure = null;
    } catch (error) {
      await this.stop();
      this.failure = { reason: 'backend_startup_failed', backendBoundaryStage: 'handshake' };
      throw error;
    } finally { lines.close(); }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end('shutdown\n');
    });
  }
}
