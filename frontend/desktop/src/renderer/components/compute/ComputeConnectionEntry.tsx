import { Button, Input, InputNumber, Message, Modal, Select, Tooltip } from '@arco-design/web-react';
import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { computeRequest, emptyProfile, type ComputeTarget, type ConnectionProfile } from './api';
import './compute-connection.css';
import { RemoteFiles } from './RemoteFiles';
import { OPEN_COMPUTE_CONNECTION } from './connectionEvents';

const legacyKey = 'trainer.compute.connection.v1';
function legacyProfile(): ConnectionProfile {
  try {
    const saved = JSON.parse(localStorage.getItem(legacyKey) ?? 'null');
    if (saved && typeof saved.host === 'string' && typeof saved.username === 'string' && typeof saved.workdir === 'string' && Number.isInteger(saved.port)) return { ...emptyProfile, host: saved.host, port: saved.port, username: saved.username, workdir: saved.workdir };
  } catch { /* Old local settings are optional. */ }
  return { ...emptyProfile };
}

const ServerIcon = () => (
  <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.5' aria-hidden='true'>
    <rect x='4' y='3' width='16' height='7' rx='2' /><rect x='4' y='14' width='16' height='7' rx='2' />
    <path d='M8 6.5h.01M8 17.5h.01M12 6.5h5M12 17.5h5' strokeLinecap='round' />
  </svg>
);

export default function ComputeConnectionEntry({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation();
  const label = (key: string) => t(`conversation.compute.${key}`);
  const id = useId();
  const [visible, setVisible] = useState(false);
  const [target, setTarget] = useState<ComputeTarget | null>(null);
  const [draft, setDraft] = useState<ConnectionProfile>(emptyProfile);
  const [password, setPassword] = useState('');
  const [view, setView] = useState<'connection' | 'files'>('connection');
  const [busy, setBusy] = useState<'load' | 'save' | 'connect' | 'disconnect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);
  const operation = useRef(false);
  const mounted = useRef(true);
  const dialogOpen = useRef(false);
  dialogOpen.current = visible;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const errorLabel = (code: string) => t(`conversation.compute.errors.${code}`, { defaultValue: label('requestFailed') });

  const load = async (edit: boolean) => {
    if (operation.current) return;
    operation.current = true;
    if (edit) { setBusy('load'); setError(null); }
    try {
      const next = await computeRequest('load');
      if (!mounted.current) return;
      setTarget(next); setAvailable(true);
      if (edit) { setDraft(next.profile ? { ...emptyProfile, ...next.profile } : legacyProfile()); setPassword(''); }
    } catch (e) {
      if (!mounted.current) return;
      setAvailable(false);
      if (edit) { setDraft(legacyProfile()); setError(e instanceof Error ? e.message : 'BACKEND_UNAVAILABLE'); }
    } finally { operation.current = false; if (mounted.current && edit) setBusy(null); }
  };
  useEffect(() => {
    void load(true);
    const timer = window.setInterval(() => { if (!dialogOpen.current) void load(false); }, 15000);
    return () => window.clearInterval(timer);
  }, []);
  const open = () => { setView('connection'); setPassword(''); setDraft(target?.profile ? { ...emptyProfile, ...target.profile } : legacyProfile()); setVisible(true); void load(true); };
  const close = () => { setPassword(''); setVisible(false); };
  useEffect(() => {
    const handleOpen = (event: Event) => {
      event.preventDefault();
      // Repeated requests must not reset an unsaved connection form.
      if (!dialogOpen.current) { dialogOpen.current = true; open(); }
    };
    window.addEventListener(OPEN_COMPUTE_CONNECTION, handleOpen);
    return () => window.removeEventListener(OPEN_COMPUTE_CONNECTION, handleOpen);
  }, [open]);

  const act = async (action: 'save' | 'connect' | 'disconnect') => {
    if (operation.current) return;
    const normalized = { ...draft, host: draft.host.trim(), username: draft.username.trim(), workdir: draft.workdir.trim(), identity_file: draft.identity_file.trim() };
    if (action !== 'disconnect' && (!normalized.host || !normalized.username || !Number.isInteger(normalized.port) || normalized.port < 1 || normalized.port > 65535)) {
      setError('INVALID_COMPUTE_PROFILE'); return;
    }
    if (action === 'connect' && normalized.auth_method === 'password' && !password) { setError('SSH_PASSWORD_REQUIRED'); return; }
    operation.current = true; setBusy(action); setError(null);
    try {
      const next = await computeRequest(action, action === 'disconnect' ? undefined : normalized, action === 'connect' ? password : undefined);
      if (!mounted.current) return;
      setTarget(next); setDraft(next.profile ?? emptyProfile); setAvailable(true);
      if (action === 'save') Message.success(label('saved'));
      try { localStorage.removeItem(legacyKey); } catch { /* Backend persistence is authoritative. */ }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'REQUEST_FAILED'); }
    finally { operation.current = false; if (mounted.current) { setBusy(null); if (action === 'connect' || action === 'disconnect') setPassword(''); } }
  };

  const changed = !!target?.profile && (Object.keys(emptyProfile) as (keyof ConnectionProfile)[]).some(key => target.profile![key] !== draft[key]);
  const status = busy === 'connect' ? 'checking' : !available ? 'backendUnavailable' : changed ? 'unsaved' : target?.status ?? 'disconnected';
  const snapshot = target?.snapshot;
  const date = (at: number | null | undefined) => at ? new Date(at).toLocaleString() : label('never');
  const field = (key: 'host' | 'username' | 'workdir' | 'identity_file', placeholder: string) => (
    <label htmlFor={`${id}-${key}`}>{label(key)}<Input id={`${id}-${key}`} value={draft[key]} placeholder={placeholder} disabled={!!busy} onChange={value => setDraft(previous => ({ ...previous, [key]: value }))} /></label>
  );

  return <>
    <Tooltip content={label('title')} disabled={!collapsed} position='right'>
      <button type='button' className={`compute-connection-entry${collapsed ? ' is-collapsed' : ''}`} aria-label={label('title')} aria-haspopup='dialog' aria-expanded={visible} onClick={open}>
        <span className='compute-connection-icon'><ServerIcon /></span>
        {!collapsed && <span className='compute-connection-label'>{label('title')}</span>}
        <span className={`compute-status-dot ${available ? target?.status ?? '' : ''}`} title={label(`states.${available ? target?.status ?? 'disconnected' : 'backendUnavailable'}`)} />
      </button>
    </Tooltip>
    <Modal visible={visible} title={label('title')} className='compute-connection-modal' style={{ width: 600, maxWidth: 'calc(100vw - 24px)' }} onCancel={close} footer={<>
      <Button onClick={close}>{label('close')}</Button>
      <Button disabled={!!busy} onClick={() => void load(true)}>{label('refresh')}</Button>
      {(target?.files_available || target?.status === 'reachable') && <Button disabled={!!busy || !available} onClick={() => void act('disconnect')}>{label('disconnect')}</Button>}
      <Button loading={busy === 'save'} disabled={!!busy || !available} onClick={() => void act('save')}>{label('save')}</Button>
      <Button type='primary' loading={busy === 'connect'} disabled={!!busy || !available} onClick={() => void act('connect')}>{label('connect')}</Button>
    </>}>
      <div className='compute-connection-status' role='status' aria-live='polite'>
        <ServerIcon /><div><strong>{label(`states.${status}`)}</strong><small>{label('connectionNotice')}</small>
          <small>{label('lastConfirmed')}: {date(target?.last_confirmed_at)}</small>
          <small>{label('lastChecked')}: {date(target?.last_checked_at)}</small>
        </div>
      </div>
      <div className='compute-file-tabs' role='group' aria-label={label('filesSource')}>
        <Button size='small' type={view === 'connection' ? 'primary' : 'secondary'} onClick={() => setView('connection')}>{label('filesConnection')}</Button>
        <Button size='small' type={view === 'files' ? 'primary' : 'secondary'} onClick={() => setView('files')}>{label('filesRemote')}</Button>
      </div>
      {(error || (!changed && target?.error)) && <p className='compute-connection-error' role='alert'>{errorLabel(error ?? target!.error!.code)}</p>}
      {view === 'files' ? <RemoteFiles active={visible} /> : <>
      <div className='compute-connection-form'>
        {field('host', 'gpu.example.com / SSH Host')}
        <label htmlFor={`${id}-port`}>{label('port')}<InputNumber id={`${id}-port`} min={1} max={65535} precision={0} value={draft.port} disabled={!!busy} onChange={port => setDraft(value => ({ ...value, port }))} /></label>
        {field('username', 'researcher')}
        <label htmlFor={`${id}-auth`}>{label('authMethod')}<Select id={`${id}-auth`} value={draft.auth_method} disabled={!!busy} onChange={(auth_method: 'key' | 'password') => { setDraft(previous => ({ ...previous, auth_method })); setPassword(''); setError(null); }} options={[{ value: 'key', label: label('authKey') }, { value: 'password', label: label('authPassword') }]} /></label>
        {draft.auth_method === 'password' && <label htmlFor={`${id}-password`}>{label('password')}<Input.Password id={`${id}-password`} value={password} disabled={!!busy} autoComplete='new-password' placeholder={label('passwordPlaceholder')} onChange={setPassword} /></label>}
        {field('workdir', '/workspace/training')}
        {draft.auth_method === 'key' && field('identity_file', label('identityPlaceholder'))}
      </div>
      <p className='compute-connection-hint'>{label('credentialNotice')}</p>
      <div className='compute-connection-resources'><strong>{label('resources')}</strong>
        {snapshot && <p>{label('snapshotAt')}: {date(target?.snapshot_at)}</p>}
        {snapshot && !changed ? <>
          {(target?.status !== 'reachable' || busy === 'connect') && <p className='compute-snapshot-stale'>{label('historicalSnapshot')}</p>}
          <p>{snapshot.hostname} · {snapshot.os} / {snapshot.arch} · Python {snapshot.python}</p>
          <p>{label('remoteDirectory')}: <code>{snapshot.workdir.path}</code> · {label(snapshot.workdir.exists ? snapshot.workdir.writable ? 'directoryWritable' : 'directoryReadonly' : 'directoryMissing')}</p>
          <p>{label(snapshot.host.installed ? 'hostUnverified' : 'hostMissing')}</p>
          {snapshot.gpus.map(gpu => <div className='compute-gpu' key={gpu.uuid}>
            <strong>{gpu.name}</strong><span>{label('freeMemory')}: {(gpu.memory_free_mib / 1024).toFixed(1)} / {(gpu.memory_total_mib / 1024).toFixed(1)} GiB</span>
            <small>{gpu.uuid} · {label('driver')}: {gpu.driver}</small>
          </div>)}
          {snapshot.gpu_error ? <p>{errorLabel(snapshot.gpu_error)}</p> : !snapshot.gpus.length && <p>{label('noGpu')}</p>}
          <p>{label('snapshotNotice')}</p>
        </> : <p>{label('noResources')}</p>}
      </div>
      </>}
    </Modal>
  </>;
}
