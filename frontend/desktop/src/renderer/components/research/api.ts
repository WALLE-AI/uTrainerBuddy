import { createApiClient } from '@/renderer/api';

export async function researchRequest<T>(method: 'get' | 'post' | 'patch', path: string, body?: unknown): Promise<T> {
  if (!window.__trainerBackend || !window.__backendPort) throw new Error('BACKEND_UNAVAILABLE');
  const client = createApiClient(`http://127.0.0.1:${window.__backendPort}`);
  const options = { signal: AbortSignal.timeout(15000) };
  const result = method === 'get' ? await client.get<{ data: T }>(path, options) : await client[method]<{ data: T }>(path, body, options);
  return result.data;
}
