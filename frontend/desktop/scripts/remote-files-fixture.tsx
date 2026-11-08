// Loaded only by the desktop UI verification script. All responses stay local.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SWRConfig } from 'swr';
import i18n from '../src/renderer/services/i18n';
import { RemoteFiles } from '../src/renderer/components/compute/RemoteFiles';

export async function mount() {
  const oldLanguage = i18n.language;
  await i18n.changeLanguage('zh-CN');
  const fetchOriginal = window.fetch;
  let connection = 'ui-a';
  let connected = true;
  const requests: string[] = [];
  const reply = (data: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { success: true, data } : data), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href);
    if (!url.pathname.startsWith('/api/v1/compute/target')) return fetchOriginal(input, options);
    requests.push(url.pathname + url.search);
    if (url.pathname === '/api/v1/compute/target') return reply({ profile: null, status: connected ? 'reachable' : 'disconnected', error: null, last_checked_at: Date.now(), last_confirmed_at: Date.now(), files_available: connected, connection_id: connection, snapshot: { hostname: 'test', os: 'Linux', arch: 'x86_64', python: '3.12', gpus: [], gpu_error: null, host: { installed: false }, workdir: { path: '/workspace', exists: true, writable: true } } });
    if (!connected) return reply({ code: 'SSH_SESSION_CLOSED' }, 409);
    if (url.searchParams.get('connection_id') !== connection) return reply({ code: 'COMPUTE_SESSION_CHANGED' }, 409);
    const path = url.searchParams.get('path') ?? '';
    if (url.pathname.endsWith('/files')) {
      const entries = path === 'data' ? [{ name: 'samples.jsonl', type: 'file', size: 32 }] : Number(url.searchParams.get('cursor')) > 0 ? [{ name: 'more.txt', type: 'file', size: 3 }] : [
        { name: 'data', type: 'dir', size: 0 }, { name: 'config.json', type: 'file', size: 20 }, { name: 'large.bin', type: 'file', size: 90000000 },
      ];
      return reply({ entries, root: '/workspace', next_cursor: path || Number(url.searchParams.get('cursor')) > 0 ? null : 3, truncated: false });
    }
    if (path === 'large.bin') return reply({ code: 'FILE_TOO_LARGE' }, 413);
    const text = path === 'data/samples.jsonl' ? '{"question":"训练样本"}\n' : '{"model":"test"}\n';
    return reply({ path, content_base64: btoa(String.fromCharCode(...new TextEncoder().encode(text))), size: text.length, modified_at: 1700000000 });
  };
  const container = document.createElement('div');
  container.id = 'remote-files-fixture';
  Object.assign(container.style, { position: 'fixed', inset: '0', zIndex: '999', padding: '24px', overflow: 'auto', background: 'var(--bg-1)' });
  document.body.append(container);
  const root = createRoot(container);
  root.render(<SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}><RemoteFiles /></SWRConfig>);
  const notify = () => window.dispatchEvent(new Event('trainer-compute-change'));
  return {
    requests,
    disconnect() { connected = false; notify(); },
    reconnect() { connected = true; connection = 'ui-b'; notify(); },
    async cleanup() { root.unmount(); container.remove(); window.fetch = fetchOriginal; await i18n.changeLanguage(oldLanguage); },
  };
}
