import React, { useState } from 'react';
import '@arco-design/web-react/es/_util/react-19-adapter';
import { createRoot } from 'react-dom/client';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../src/renderer/services/i18n/locales/en-US/conversation.json';
import { ResearchComputeCard } from '../src/renderer/components/compute/ResearchComputeCard';
import ComputeConnectionEntry from '../src/renderer/components/compute/ComputeConnectionEntry';
import { openComputeConnection } from '../src/renderer/components/compute/connectionEvents';
import { researchComputeSummary } from '../src/renderer/components/compute/researchComputeSummary';

const target = { target_id: 't1', snapshot_at: Date.now(), profile: { host: 'host-one', port: 22, username: 'tester', workdir: '/work', identity_file: '', auth_method: 'key' }, status: 'reachable', connection_id: 'connection-1', files_available: true,
  snapshot: { python: '3.13', gpus: [{ name: 'TEST GPU' }], gpu_error: null, workdir: { path: '/work', exists: true, writable: true }, host: { ready: true } } };
const data = { project: { name: 'test' }, binding: { target_id: 't1', remote_root: '/work/project', last_snapshot: null }, target };
let mode = 'normal';
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const requests: string[] = [];
Object.assign(window, { __trainerBackend: { token: 'fixture' }, __backendPort: 12345, requests,
  configure: openComputeConnection,
  advanceClock: () => { offset = 61000; },
  resetClock: () => { offset = 0; },
  scenario: (next: string) => { mode = next; window.dispatchEvent(new Event('trainer-compute-change')); },
  checkSummary: () => {
    const summarize = (patch: any) => researchComputeSummary({ ...data, target: { ...target, ...patch } } as any);
    if (summarize({}).state !== 'observed') throw Error('recent connection');
    for (const patch of [{ snapshot_at: Date.now() - 60001 }, { snapshot_at: Date.now() + 10000 }, { snapshot_at: null }, { snapshot: null }, { connection_id: null }, { status: 'disconnected' }]) {
      if (summarize(patch).live) throw Error('invalid observation accepted');
    }
    const changed = summarize({ target_id: 'other' });
    if (changed.host || changed.snapshot || changed.state !== 'targetChanged') throw Error('target isolation');
    return true;
  },
});
window.fetch = async (url, init) => {
  const path = new URL(String(url)).pathname;
  requests.push(`${init?.method} ${path}`);
  if (init?.method !== 'GET') throw Error('Unexpected mutation');
  if (mode === 'error' && path.includes('compute-binding')) return new Response('{}', { status: 500 });
  let result: unknown = target;
  if (path.includes('compute-binding')) result = { ...data,
    binding: mode === 'unbound' || path.includes('/p2/') ? null : data.binding,
    target: { ...target, target_id: mode === 'changed' ? 't2' : 't1', snapshot_at: mode === 'stale' ? Date.now() - 120000 : target.snapshot_at } };
  return new Response(JSON.stringify({ data: result }), { headers: { 'Content-Type': 'application/json' } });
};
async function start() {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { conversation: en } } }, initImmediate: false });
  function Fixture() {
    const [project, setProject] = useState('p1');
    const [tab, setTab] = useState('plan');
    return <><ComputeConnectionEntry /><textarea defaultValue='KEEP DRAFT' />
      <button id='switch' onClick={() => setProject('p2')}>Switch</button><output id='tab'>{tab}</output>
      <ResearchComputeCard projectId={project} active onOpenFiles={() => setTab('files')} /></>;
  }
  createRoot(document.getElementById('root')!).render(<Fixture />);
}
void start();
