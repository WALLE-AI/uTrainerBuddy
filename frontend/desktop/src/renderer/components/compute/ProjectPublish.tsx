import { ApiError, createApiClient } from '@/renderer/api';
import { Button, Input, Message, Modal } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import type { ComputeTarget } from './api';
import './project-publish.css';

export async function syncRequest<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  if (!window.__trainerBackend || !window.__backendPort) throw new Error('BACKEND_UNAVAILABLE');
  const api = createApiClient(`http://127.0.0.1:${window.__backendPort}`);
  try {
    const value = method === 'GET' ? await api.get<{ data: T }>(`/api/v1/${path}`) : method === 'PUT' ? await api.put<{ data: T }>(`/api/v1/${path}`, body) : await api.post<{ data: T }>(`/api/v1/${path}`, body);
    if (method !== 'GET') window.dispatchEvent(new Event('trainer-project-sync-change'));
    return value.data;
  } catch (error) {
    if (error instanceof ApiError && error.body && typeof error.body === 'object' && 'code' in error.body) throw new Error(String(error.body.code));
    throw error;
  }
}
export type ProjectBinding = { id: string; target_id: string; local_root: string; remote_subdir: string; remote_root: string; revision: number; last_snapshot: null | { id: string; commit: string; sha256: string; receipt: { repo_path: string } } };
export type BindingData = { project: { name: string; local_root: string | null; state: string }; binding: ProjectBinding | null; target: ComputeTarget & { target_id: string } };
type Snapshot = { can_publish: boolean; dirty: boolean; commit: string; changes?: string[]; sha256?: string; size?: number; file_count?: number; manifest?: { path: string; size: number }[] };
type Transfer = { id: string; kind: string; status: string; confirmed_bytes: number; total_bytes: number; error: string | null; local_path?: string; receipt?: { repo_path: string } };

export function ProjectPublish({ projectId, active, onBindingChanged }: { projectId: string; active: boolean; onBindingChanged: () => void }) {
  const { t } = useTranslation();
  const label = (key: string) => t(`conversation.sync.${key}`);
  const errorText = (error: unknown) => t(`conversation.sync.errors.${error instanceof Error ? error.message : ''}`, { defaultValue: error instanceof Error ? error.message : label('failed') });
  const config = useSWR(active ? ['project-sync-binding', projectId] : null, () => syncRequest<BindingData>('GET', `projects/${projectId}/compute-binding`), { refreshInterval: 10000, shouldRetryOnError: false });
  const transfers = useSWR(active ? ['project-sync-transfers', projectId] : null, () => syncRequest<Transfer[]>('GET', `projects/${projectId}/transfers`), { refreshInterval: 2000, shouldRetryOnError: false });
  const host = useSWR(active && config.data?.target.files_available ? ['project-sync-host', config.data.target.connection_id] : null, () => syncRequest<{ ready: boolean; package: { size: number; sha256: string }; connection_id: string; installation_directory: string }>('GET', 'compute/target/host'), { shouldRetryOnError: false });
  const [localRoot, setLocalRoot] = useState('');
  const [remoteSubdir, setRemoteSubdir] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [publishKey, setPublishKey] = useState<string | null>(null);
  const binding = config.data?.binding;
  const target = config.data?.target;
  const completedTransfers = transfers.data?.filter(task => task.status === 'completed').map(task => task.id).join(',');
  useEffect(() => { if (completedTransfers) void config.mutate(); }, [completedTransfers, config.mutate]);
  useEffect(() => { if (config.data) { setLocalRoot(binding?.local_root ?? config.data.project.local_root ?? ''); setRemoteSubdir(binding?.remote_subdir ?? ''); setSnapshot(null); setPublishKey(null); } }, [projectId, binding?.revision, config.data?.project.local_root]);
  useEffect(() => {
    const refresh = () => { void config.mutate(); void transfers.mutate(); void host.mutate(); };
    window.addEventListener('trainer-project-sync-change', refresh); window.addEventListener('trainer-compute-change', refresh);
    return () => { window.removeEventListener('trainer-project-sync-change', refresh); window.removeEventListener('trainer-compute-change', refresh); };
  }, [config.mutate, transfers.mutate, host.mutate]);
  const changed = !binding || binding.local_root !== localRoot || binding.remote_subdir !== remoteSubdir;
  const matchesTarget = binding?.target_id === target?.target_id;
  const act = async (name: string, action: () => Promise<void>) => { setBusy(name); setError(null); try { await action(); } catch (e) { setError(e); } finally { setBusy(null); } };
  const save = () => act('save', async () => {
    await syncRequest('PUT', `projects/${projectId}/compute-binding`, { local_root: localRoot, remote_subdir: remoteSubdir, expected_revision: binding?.revision ?? 0 });
    await config.mutate(); setSnapshot(null); setPublishKey(null); onBindingChanged();
  });
  const preview = () => act('preview', async () => { setSnapshot(await syncRequest('POST', `projects/${projectId}/snapshot-preview`)); setPublishKey(null); });
  const install = () => {
    if (!host.data) { setError(host.error ?? new Error('HOST_PACKAGE_MISSING')); return; }
    const plan = host.data;
    Modal.confirm({ title: label('installTitle'), content: <div><p>{label('installNotice')}</p><p className='project-publish-path'>{plan.installation_directory}</p><small>{(plan.package.size / 1024 / 1024).toFixed(1)} MiB · SHA256 {plan.package.sha256}</small></div>, okText: label('install'), cancelText: label('close'), onOk: () => act('install', async () => { await syncRequest('POST', 'compute/target/host/install', { connection_id: plan.connection_id }); await host.mutate(); }) });
  };
  const publish = () => act('publish', async () => {
    const key = publishKey ?? crypto.randomUUID(); setPublishKey(key);
    await syncRequest('POST', `projects/${projectId}/publish`, { request_id: key, commit: snapshot?.commit });
    await transfers.mutate(); Message.success(label('accepted'));
  });
  return <section className='project-publish'>
    <h3>{label('title')}</h3>
    <p className='project-publish-note'>{label('notice')}</p>
    {(error || config.error) && <p className='compute-connection-error' role='alert'>{errorText(error ?? config.error)}</p>}
    <label>{label('localRoot')}<Input value={localRoot} disabled={!!busy} onChange={value => { setLocalRoot(value); setSnapshot(null); }} /></label>
    <label>{label('remoteSubdir')}<Input value={remoteSubdir} disabled={!!busy} placeholder={label('remotePlaceholder')} onChange={value => { setRemoteSubdir(value); setSnapshot(null); }} /></label>
    <p className='project-publish-path'>{target?.snapshot?.workdir.path ?? label('connectFirst')}{remoteSubdir ? `/${remoteSubdir}` : ''}/.trainerbuddy/projects/{projectId}</p>
    {binding && !matchesTarget && <p className='compute-connection-error'>{label('targetChanged')}</p>}
    <div className='project-publish-actions'>
      <Button size='small' disabled={!!busy || !config.data || !target?.files_available} loading={busy === 'save'} onClick={() => void save()}>{label('saveBinding')}</Button>
      <Button size='small' disabled={!!busy || changed || !matchesTarget} loading={busy === 'preview'} onClick={() => void preview()}>{label('preview')}</Button>
      <Button size='small' disabled={!!busy || !target?.files_available || host.data?.ready} loading={busy === 'install'} onClick={install}>{host.data?.ready ? label('hostReady') : label('enableHost')}</Button>
      <Button size='small' type='primary' disabled={!!busy || changed || !matchesTarget || !snapshot?.can_publish || !host.data?.ready} loading={busy === 'publish'} onClick={() => void publish()}>{label('publish')}</Button>
    </div>
    {host.error && <p className='project-publish-note'>{errorText(host.error)}</p>}
    {snapshot && <div className='project-publish-snapshot'>
      <strong>Commit {snapshot.commit.slice(0, 12)}</strong>
      {snapshot.dirty ? <><p>{label('dirty')}</p><pre>{snapshot.changes?.join('\n')}</pre></> : <>
        <p>{snapshot.file_count} {label('files')} · {((snapshot.size ?? 0) / 1024).toFixed(1)} KiB</p>
        <details><summary>{label('manifest')}</summary><p className='project-publish-path'>SHA256 {snapshot.sha256}</p><pre>{snapshot.manifest?.slice(0, 100).map(file => `${file.path} (${file.size} B)`).join('\n')}</pre></details>
      </>}
    </div>}
    {binding?.last_snapshot && <p className='project-publish-note'>{label('lastPublished')}: {binding.last_snapshot.commit.slice(0, 12)}</p>}
    {(transfers.data?.length ?? 0) > 0 && <div className='project-publish-transfers'><h4>{label('transfers')}</h4>{transfers.data!.slice(0, 8).map(task => <div className='project-transfer' key={task.id}>
      <strong>{label(task.kind === 'download' ? 'download' : 'publish')} · {t(`conversation.sync.states.${task.status}`, { defaultValue: task.status })}</strong>
      <progress max={task.total_bytes || 1} value={task.confirmed_bytes} />
      <small>{(task.confirmed_bytes / 1024).toFixed(1)} / {(task.total_bytes / 1024).toFixed(1)} KiB</small>
      {task.error && <p className='compute-connection-error'>{errorText(new Error(task.error))}</p>}
      {task.local_path && <p className='project-publish-path'>{task.local_path}<Button size='mini' onClick={() => void navigator.clipboard.writeText(task.local_path!)}>{label('copyPath')}</Button></p>}
      {task.receipt && <p className='project-publish-path'>{task.receipt.repo_path}</p>}
      <div className='project-publish-actions'>
        {['failed', 'waiting_connection', 'unreconciled', 'paused'].includes(task.status) && <Button size='mini' disabled={!!busy} onClick={() => void act('resume', async () => { await syncRequest('POST', `transfers/${task.id}/resume`); await transfers.mutate(); await config.mutate(); })}>{label('resume')}</Button>}
        {!['completed', 'cancelled'].includes(task.status) && <Button size='mini' disabled={!!busy} onClick={() => void act('cancel', async () => { await syncRequest('POST', `transfers/${task.id}/cancel`); await transfers.mutate(); })}>{label('cancel')}</Button>}
      </div>
    </div>)}</div>}
  </section>;
}
