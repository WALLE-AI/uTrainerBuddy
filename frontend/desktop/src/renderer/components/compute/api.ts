import { ApiError, createApiClient } from '@/renderer/api';

export type ConnectionProfile = { host: string; port: number; username: string; workdir: string; identity_file: string; auth_method: 'key' | 'password' };
export const emptyProfile: ConnectionProfile = { host: '', port: 22, username: '', workdir: '', identity_file: '', auth_method: 'key' };
export type ComputeTarget = {
  target_id: string;
  snapshot_at: number | null;
  profile: ConnectionProfile | null;
  status: 'disconnected' | 'unchecked' | 'checking' | 'reachable' | 'unreachable';
  last_checked_at: number | null;
  last_confirmed_at: number | null;
  error: { code: string } | null;
  files_available: boolean;
  connection_id: string | null;
  snapshot: {
    hostname: string; os: string; arch: string; python: string;
    gpus: { uuid: string; name: string; memory_total_mib: number; memory_free_mib: number; driver: string }[];
    gpu_error: string | null;
    workdir: { path: string; exists: boolean; writable: boolean };
    host: { installed: boolean; ready: boolean; protocol_version: number | null };
  } | null;
};

export async function computeRequest(action: 'load' | 'save' | 'connect' | 'disconnect', profile?: ConnectionProfile, password?: string): Promise<ComputeTarget> {
  if (!window.__trainerBackend || !window.__backendPort) throw new Error('BACKEND_UNAVAILABLE');
  const api = createApiClient(`http://127.0.0.1:${window.__backendPort}`);
  const path = '/api/v1/compute/target';
  try {
    const result = action === 'load' ? await api.get<{ data: ComputeTarget }>(path)
      : action === 'save' ? await api.put<{ data: ComputeTarget }>(path, profile)
        : await api.post<{ data: ComputeTarget }>(`${path}/${action}`, action === 'connect' && profile?.auth_method === 'password' ? { ...profile, password } : profile);
    if (action !== 'load') window.dispatchEvent(new Event('trainer-compute-change'));
    return result.data;
  } catch (error) {
    if (error instanceof ApiError && error.body && typeof error.body === 'object' && 'code' in error.body) throw new Error(String(error.body.code));
    throw error;
  }
}

export type RemoteDirectory = { entries: { name: string; type: 'dir' | 'file' | 'special'; size: number | null; symlink: boolean }[]; next_cursor: number | null; truncated: boolean; root: string };
export type RemoteFile = { content_base64: string; size: number; modified_at: number; path: string };
export async function remoteFileRequest<T>(action: 'files' | 'file', connectionId: string, path: string, cursor = 0): Promise<T> {
  if (!window.__trainerBackend || !window.__backendPort) throw new Error('BACKEND_UNAVAILABLE');
  const api = createApiClient(`http://127.0.0.1:${window.__backendPort}`);
  const query = new URLSearchParams({ connection_id: connectionId, path, cursor: String(cursor) });
  try { return (await api.get<{ data: T }>(`/api/v1/compute/target/${action}?${query}`)).data; }
  catch (error) {
    if (error instanceof ApiError && error.body && typeof error.body === 'object' && 'code' in error.body) throw new Error(String(error.body.code));
    throw error;
  }
}
