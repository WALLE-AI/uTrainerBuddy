import React from 'react';
import { createRoot } from 'react-dom/client';
import { SWRConfig } from 'swr';
import { Modal } from '@arco-design/web-react';
import i18n from '../src/renderer/services/i18n';
import { ProjectPublish } from '../src/renderer/components/compute/ProjectPublish';

export async function mount() {
  Modal.destroyAll();
  const oldLanguage = i18n.language; await i18n.changeLanguage('zh-CN');
  const original = window.fetch;
  let revision = 0, ready = false, dirty = true, polls = 0, target = 'server-one';
  let binding: any = null;
  let task: any = null;
  let selectedRoot = 'F:/fixture/project';
  const requests: { method: string; path: string; body: any }[] = [];
  const reply = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    const method = options?.method ?? 'GET';
    if (!url.pathname.includes('/projects/ui-sync/') && !url.pathname.includes('/compute/target/host')) return original(input, options);
    const body = typeof options?.body === 'string' ? JSON.parse(options.body) : null;
    requests.push({ method, path: url.pathname, body });
    if (url.pathname.endsWith('/host/install')) { ready = true; return reply({ protocol_version: 1 }); }
    if (url.pathname.endsWith('/host')) return reply({ ready, connection_id: 'test-session', package: { size: 1000, sha256: 'a'.repeat(64) }, installation_directory: '/workspace/.trainerbuddy/hosts/test/trainerbuddy-host' });
    if (url.pathname.endsWith('/compute-binding')) {
      if (method === 'PUT') { revision++; selectedRoot = body.local_root; binding = { id: 'binding-one', target_id: target, local_root: selectedRoot, remote_subdir: body.remote_subdir, revision, remote_root: '/workspace', last_snapshot: null }; return reply(binding); }
      return reply({ project: { name: 'Fixture project', local_root: selectedRoot, state: 'ready' }, binding, target: { target_id: target, profile: { host: 'fixture' }, files_available: true, connection_id: 'test-session', snapshot: { workdir: { path: '/workspace' } } } });
    }
    if (url.pathname.endsWith('/snapshot-preview')) return reply(dirty ? { can_publish: false, dirty: true, commit: 'a'.repeat(40), changes: [' M train.py'] } : { can_publish: true, dirty: false, commit: 'a'.repeat(40), file_count: 2, size: 4096, sha256: 'b'.repeat(64), manifest: [{ path: 'train.py', size: 20 }, { path: 'config.yaml', size: 30 }] });
    if (url.pathname.endsWith('/publish')) { task = { id: 'transfer-one', kind: 'publish', status: 'queued', confirmed_bytes: 0, total_bytes: 4096 }; return reply(task); }
    if (url.pathname.endsWith('/transfers')) {
      if (task) { polls++; task.status = polls > 1 ? 'completed' : 'verifying'; task.confirmed_bytes = 4096; if (task.status === 'completed') { task.receipt = { repo_path: '.trainerbuddy/projects/ui-sync/releases/snapshot/repo' }; binding.last_snapshot = { id: 'snapshot', commit: 'a'.repeat(40), sha256: 'b'.repeat(64), receipt: task.receipt }; } }
      return reply(task ? [task] : []);
    }
    return reply(null);
  };
  const container = document.createElement('div'); container.id = 'project-publish-fixture';
  Object.assign(container.style, { position: 'fixed', inset: '0', zIndex: '999', background: 'var(--bg-1)', padding: '24px', overflow: 'auto' }); document.body.append(container);
  const root = createRoot(container); root.render(<SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}><ProjectPublish projectId='ui-sync' active onBindingChanged={() => {}} /></SWRConfig>);
  return { requests, clean() { dirty = false; }, changeTarget() { target = 'server-two'; window.dispatchEvent(new Event('trainer-compute-change')); }, async cleanup() { root.unmount(); Modal.destroyAll(); container.remove(); window.fetch = original; await i18n.changeLanguage(oldLanguage); } };
}
