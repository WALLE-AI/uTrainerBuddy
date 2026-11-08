import { Button, Modal } from '@arco-design/web-react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { computeRequest, remoteFileRequest, type RemoteDirectory, type RemoteFile } from './api';
import './remote-files.css';
import { syncRequest, type BindingData } from './ProjectPublish';

export function RemoteFiles({ active = true, projectId }: { active?: boolean; projectId?: string }) {
  const { t } = useTranslation();
  const label = (key: string) => t(`conversation.compute.${key}`);
  const target = useSWR(active && !projectId ? 'compute-file-target' : null, () => computeRequest('load'), { refreshInterval: active ? 10000 : 0, revalidateOnFocus: active });
  const project = useSWR(active && projectId ? ['project-sync-binding', projectId] : null, () => syncRequest<BindingData>('GET', `projects/${projectId}/compute-binding`), { refreshInterval: active ? 10000 : 0, shouldRetryOnError: false });
  useEffect(() => {
    const refresh = () => { void target.mutate(); void project.mutate(); };
    window.addEventListener('trainer-compute-change', refresh);
    window.addEventListener('trainer-project-sync-change', refresh);
    return () => { window.removeEventListener('trainer-compute-change', refresh); window.removeEventListener('trainer-project-sync-change', refresh); };
  }, [target.mutate, project.mutate]);
  const data = projectId ? project.data?.target : target.data;
  const id = data?.connection_id;
  if (!active) return null;
  if (projectId && project.data && (!project.data.binding || !project.data.binding.last_snapshot)) return <p className='remote-files-note'>{label('filesProjectPublish')}</p>;
  if (projectId && project.data?.binding && project.data.binding.target_id !== data?.target_id) return <p className='remote-files-note'>{label('filesTargetChanged')}</p>;
  if (!data?.files_available || !id) return <div className='remote-files-note'>
    <p>{target.isLoading ? label('filesLoading') : label('filesReconnect')}</p>
    <Button size='small' onClick={() => void target.mutate()}>{label('refresh')}</Button>
  </div>;
  const release = project.data?.binding?.last_snapshot;
  return <RemoteDirectoryView key={`${id}/${projectId ?? ''}/${release?.id ?? ''}`} connectionId={id} projectId={projectId} root={`${data.snapshot?.workdir.path ?? ''}${release ? `/${release.receipt.repo_path}` : ''}`} />;
}

function RemoteDirectoryView({ connectionId, root, projectId }: { connectionId: string; root: string; projectId?: string }) {
  const { t } = useTranslation();
  const label = (key: string) => t(`conversation.compute.${key}`);
  const errorLabel = (error: unknown) => t(`conversation.compute.errors.${error instanceof Error ? error.message : ''}`, { defaultValue: label('requestFailed') });
  const [path, setPath] = useState('');
  const [pages, setPages] = useState<RemoteDirectory[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [file, setFile] = useState<{ path: string; data: RemoteFile; text: string | null; url: string; mime: string } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const requestId = useRef(0);
  const previewId = useRef(0);
  const live = useRef(true);
  const requestFile = <T,>(action: 'files' | 'file', path: string, cursor = 0) => projectId ? syncRequest<T>('GET', `projects/${projectId}/remote-${action === 'files' ? 'files' : 'file'}?${new URLSearchParams({ connection_id: connectionId, path, cursor: String(cursor) })}`) : remoteFileRequest<T>(action, connectionId, path, cursor);
  useEffect(() => { live.current = true; return () => { live.current = false; requestId.current++; previewId.current++; }; }, []);
  useEffect(() => () => { if (file) URL.revokeObjectURL(file.url); }, [file]);
  const load = async (directory: string, cursor = 0) => {
    const request = ++requestId.current;
    setBusy(true); setError(null);
    if (!cursor) setPages([]);
    try {
      const result = await requestFile<RemoteDirectory>('files', directory, cursor);
      if (live.current && request === requestId.current) setPages(previous => cursor ? [...previous, result] : [result]);
    } catch (e) { if (live.current && request === requestId.current) setError(e); }
    finally { if (live.current && request === requestId.current) setBusy(false); }
  };
  useEffect(() => { void load(path); }, [path, connectionId]);
  const navigate = (directory: string) => { if (directory === path) return; requestId.current++; previewId.current++; setPages([]); setOpening(null); setError(null); setPath(directory); };
  const open = async (name: string) => {
    const request = ++previewId.current;
    const relative = path ? `${path}/${name}` : name;
    setOpening(relative); setError(null);
    try {
      const data = await requestFile<RemoteFile>('file', relative);
      if (!live.current || request !== previewId.current) return;
      const bytes = Uint8Array.from(atob(data.content_base64), char => char.charCodeAt(0));
      const ext = name.split('.').pop()?.toLowerCase() ?? '';
      const images: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif' };
      const mime = images[ext] ?? (ext === 'pdf' ? 'application/pdf' : 'text/plain;charset=utf-8');
      const text = mime.startsWith('text/') ? new TextDecoder().decode(bytes) : null;
      setFile({ path: relative, data, text, mime, url: URL.createObjectURL(new Blob([bytes], { type: mime })) });
    } catch (e) { if (live.current && request === previewId.current) setError(e); }
    finally { if (live.current && request === previewId.current) setOpening(null); }
  };
  const entries = [...new Map(pages.flatMap(page => page.entries).map(entry => [entry.name, entry])).values()];
  const last = pages.at(-1);
  const size = (bytes: number | null) => bytes === null ? '—' : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return <div className='remote-files'>
    <div className='remote-files-toolbar'>
      <Button size='small' disabled={!path || busy} onClick={() => navigate(path.split('/').slice(0, -1).join('/'))}>{label('filesUp')}</Button>
      <Button size='small' disabled={busy} onClick={() => void load(path)}>{label('refresh')}</Button>
    </div>
    <nav className='remote-files-path' aria-label={label('filesPath')}>
      <button onClick={() => navigate('')}>{projectId ? root : pages[0]?.root || root || '/'}</button>
      {path.split('/').filter(Boolean).map((part, index, all) => <React.Fragment key={index}><span>/</span><button onClick={() => navigate(all.slice(0, index + 1).join('/'))}>{part}</button></React.Fragment>)}
    </nav>
    <p className='remote-files-note'>{label('filesReadOnly')}</p>
    {error !== null && <p className='compute-connection-error' role='alert'>{errorLabel(error)}</p>}
    <div className='remote-files-list' aria-busy={busy || !!opening}>
      {entries.map(entry => <div className='remote-file-item' key={entry.name}><button className='remote-file-row' disabled={entry.type === 'special' || !!opening || busy} onClick={() => entry.type === 'dir' ? navigate(path ? `${path}/${entry.name}` : entry.name) : void open(entry.name)}>
        <span aria-hidden='true'>{entry.type === 'dir' ? '▸' : '·'}</span>
        <span className='remote-file-name'>{entry.name}{entry.symlink ? ' ↗' : ''}</span>
        <small>{entry.type === 'dir' ? label('filesDirectory') : size(entry.size)}</small>
      </button>{projectId && entry.type === 'file' && <Button size='mini' disabled={!!opening || busy} onClick={() => { const selected = path ? `${path}/${entry.name}` : entry.name; void syncRequest('POST', `projects/${projectId}/remote-download`, { request_id: crypto.randomUUID(), path: selected }).catch(setError); }}>{label('filesDownload')}</Button>}</div>)}
    </div>
    {(busy || opening) && <p className='remote-files-note' role='status'>{label('filesLoading')}</p>}
    {!busy && !error && pages.length > 0 && entries.length === 0 && <p className='remote-files-note'>{label('filesEmpty')}</p>}
    {last?.next_cursor !== null && last?.next_cursor !== undefined && <Button size='small' disabled={busy} onClick={() => void load(path, last.next_cursor!)}>{label('filesMore')}</Button>}
    {last?.truncated && <p className='remote-files-note'>{label('filesTruncated')}</p>}
    <Modal visible={!!file} title={file?.path} onCancel={() => setFile(null)} style={{ width: 900, maxWidth: 'calc(100vw - 32px)' }} footer={file && <><a className='remote-file-download' href={file.url} download={file.path.split('/').pop()}>{label('filesDownload')}</a><Button onClick={() => setFile(null)}>{label('close')}</Button></>}>
      {file && <>
        <p className='remote-files-note'>{size(file.data.size)} · {new Date(file.data.modified_at * 1000).toLocaleString()} · {label('filesReadOnly')}</p>
        {file.text !== null ? <pre className='remote-file-text'>{file.text}</pre> : file.mime.startsWith('image/') ? <img className='remote-file-image' src={file.url} alt={file.path} /> : <p>{label('filesPdfDownload')}</p>}
      </>}
    </Modal>
  </div>;
}
