import React, { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { useTranslation } from 'react-i18next';
import { researchRequest } from './api';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview/context';

type Run = { id: string; title: string; state: string; spec_hash: string; evidence_state: string; evidence_error?: string; evaluation?: { dataset: string; dataset_version: string; split: string; metric: string; direction: string; seed: number }; argv: string[]; timeout_seconds: number; snapshot: { commit: string; sha256: string }; plan: { title: string; markdown: string }; receipt?: { exit_code: number | null; error?: string }; error?: string };
type Evidence = { log: string; next_offset: number; metrics: { metric: string; step: number; value: number }[]; metric_error?: string; artifacts: { name: string; size: number }[] };
type Props = { projectId: string; conversationId: string; active: boolean; tab: 'runs' | 'assets' | 'activity' };

export function ResearchRuns(props: Props) {
  return <ScopedRuns key={`${props.projectId}:${props.conversationId}:${props.tab}`} {...props} />;
}
function ScopedRuns({ projectId, conversationId, active, tab }: Props) {
  const { t } = useTranslation();
  const label = (key: string) => t(`conversation.researchRuns.${key}`);
  const preview = usePreviewContext();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/runs`;
  const query = `?conversation_id=${encodeURIComponent(conversationId)}`;
  const controlBase = `/api/v1/projects/${encodeURIComponent(projectId)}`;
  const control = useSWR(active ? ['research-control', projectId, conversationId] : null,
    () => researchRequest<{ paused: boolean; revision: number }>('get', `${controlBase}/research-control${query}`), { refreshInterval: 1500, keepPreviousData: false });
  const notices = useSWR(active ? ['run-notices', projectId, conversationId] : null,
    () => researchRequest<{ run_id: string; status: string; attempts: number; next_attempt_at: number; last_error?: string }[]>('get', `${controlBase}/run-notices${query}`), { refreshInterval: 1500, keepPreviousData: false });
  const list = useSWR(active ? ['research-runs', projectId, conversationId] : null,
    () => researchRequest<Run[]>('get', base + query), { refreshInterval: 1500, keepPreviousData: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = list.data?.find(r => r.id === selected) ?? list.data?.[0];
  const notice = notices.data?.find(n => n.run_id === run?.id);
  const togglePause = async () => {
    if (!control.data) return;
    setBusy(true); setError('');
    try { await researchRequest('put', `${controlBase}/research-control${query}`, { paused: !control.data.paused, expected_revision: control.data.revision }); await control.mutate(); }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); await control.mutate(); }
    finally { if (mounted.current) setBusy(false); }
  };
  const retryNotice = async () => {
    if (!run) return;
    setBusy(true); setError('');
    try { await researchRequest('post', `${controlBase}/run-notices/${run.id}/retry${query}`, {}); await notices.mutate(); }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const evidence = useSWR(active && run ? ['run-evidence', projectId, conversationId, run.id] : null,
    () => researchRequest<Evidence>('get', `${base}/${run!.id}/evidence${query}`), { refreshInterval: 1500, keepPreviousData: false });
  const events = useSWR(active && tab === 'activity' ? ['run-events', projectId, conversationId] : null,
    () => researchRequest<{ seq: number; kind: string; run_id: string; state?: string; at: number }[]>('get', `${base}/events${query}`), { refreshInterval: 1500 });
  const action = async (name: 'approve' | 'cancel') => {
    if (!run) return;
    setBusy(true); setError('');
    try { await researchRequest('post', `${base}/${run.id}/${name}${query}`, { spec_hash: run.spec_hash }); await list.mutate(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const openArtifact = async (name: string) => {
    if (!run) return;
    setError('');
    try {
      const file = await researchRequest<{ name: string; content: string }>('get', `${base}/${run.id}/artifact${query}&name=${encodeURIComponent(name)}`);
      if (!mounted.current) return;
      preview.openPreview(file.content, file.name.endsWith('.md') ? 'markdown' : 'code', { title: file.name, file_name: file.name, editable: false });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return <div data-testid='research-runs' style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
    <p className='workbench-note'>{label('hint')}</p>
    <article className='workbench-card'>
      <strong data-testid='research-control-state'>{label(control.data?.paused ? 'researchPaused' : 'researchActive')}</strong>
      <p className='workbench-note'>{label('pauseHint')}</p>
      <button data-testid='toggle-research-pause' className='workbench-button' disabled={busy || !control.data} onClick={() => void togglePause()}>{label(control.data?.paused ? 'resumeResearch' : 'pauseResearch')}</button>
    </article>
    {(error || list.error || evidence.error || events.error || control.error || notices.error) && <p role='alert'>{error || String(list.error || evidence.error || events.error || control.error || notices.error)}</p>}
    {list.isLoading && <p role='status'>{label('loading')}</p>}
    {list.data?.length === 0 && <p>{label('empty')}</p>}
    {list.data && list.data.length > 0 && <label>{label('select')} <select style={{ maxWidth: '100%' }} aria-label={label('select')} value={run?.id ?? ''} onChange={e => setSelected(e.target.value)}>
      {list.data.map(item => <option key={item.id} value={item.id}>{item.title} · {item.id.slice(0, 8)} · {label(item.state)}</option>)}
    </select></label>}
    {tab === 'activity' ? events.data?.map(event => <article className='workbench-card' key={event.seq}>
      <strong>{event.state ? label(event.state) : label('submitted')}</strong><p>{event.run_id}</p><time>{new Date(event.at).toLocaleString()}</time>
    </article>) : run && <>
      <article className='workbench-card'>
        <strong>{run.title} · {label(run.state)}</strong><p className='workbench-note'>{run.id}</p>
        {run.error && <p role='alert'>{run.error}</p>}
        {run.evidence_error && <p role='alert'>{run.evidence_error}</p>}
        <p>{label('target')}: {label('local')} · {label('timeout')}: {run.timeout_seconds}s</p>
        {run.evaluation && <p data-testid='evaluation-spec'>{label('evaluation')}: {run.evaluation.dataset} / {run.evaluation.dataset_version} / {run.evaluation.split}<br />{run.evaluation.metric} ({label(run.evaluation.direction)}), seed: {run.evaluation.seed}</p>}
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(run.argv)}</pre>
        <p className='workbench-note'>commit: {run.snapshot.commit}<br />SHA-256: {run.snapshot.sha256}</p>
        <button className='workbench-button' onClick={() => preview.openPreview(run.plan.markdown, 'markdown', { title: run.plan.title, editable: false })}>{label('plan')}</button>
        {run.state === 'prepared' && <button data-testid='approve-run' className='workbench-button' disabled={busy || !control.data || control.data.paused} onClick={() => void action('approve')}>{label('approve')}</button>}
        {['prepared', 'preparing', 'running', 'unknown'].includes(run.state) && <button className='workbench-button' disabled={busy} onClick={() => void action('cancel')}>{label('cancel')}</button>}
        {run.receipt && <p>{label('exit')}: {run.receipt.exit_code ?? '—'} {run.receipt.error ?? ''}</p>}
      </article>
      {notice && <article className='workbench-card' data-testid='run-notice'>
        <strong>{label('resultDelivery')}: {label(`notice_${notice.status}`)}</strong>
        <p>{label('deliveryAttempts')}: {notice.attempts}</p>
        {notice.status === 'pending' && control.data?.paused && <p>{label('heldWhilePaused')}</p>}
        {notice.status === 'pending' && notice.next_attempt_at > 0 && <p>{label('nextDelivery')}: {new Date(notice.next_attempt_at).toLocaleString()}</p>}
        {notice.last_error && <p role='alert'>{notice.last_error}</p>}
        {notice.status === 'failed' && <button data-testid='retry-run-notice' className='workbench-button' disabled={busy} onClick={() => void retryNotice()}>{label('retryDelivery')}</button>}
        <p className='workbench-note'>{label('deliveryHint')}</p>
      </article>}
      {tab === 'runs' && <RunComparison key={run.id} base={base} query={query} candidate={run} runs={list.data ?? []} active={active} />}
      {evidence.data && <article className='workbench-card'>
        {tab === 'runs' && <>
          <h3>{label('metrics')}</h3>
          {evidence.data.metric_error && <p role='alert'>{evidence.data.metric_error}</p>}
          {evidence.data.metrics.length === 0 ? <p>{label('noMetrics')}</p> : <table><thead><tr><th>{label('metric')}</th><th>step</th><th>{label('value')}</th></tr></thead><tbody>{evidence.data.metrics.slice(-30).map((m, i) => <tr key={i}><td>{m.metric}</td><td>{m.step}</td><td>{m.value}</td></tr>)}</tbody></table>}
          <h3>{label('logs')}</h3><p className='workbench-note'>{label('logLimit')}</p><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' }}>{evidence.data.log || label('noLogs')}</pre>
        </>}
        <h3>{label('artifacts')}</h3>
        {evidence.data.artifacts.length === 0 ? <p>{label('noArtifacts')}</p> : evidence.data.artifacts.map(a => <p key={a.name}><button className='workbench-button' data-testid='open-run-artifact' onClick={() => void openArtifact(a.name)}>{a.name}</button> · {a.size} bytes</p>)}
      </article>}
    </>}
  </div>;
}

type Comparison = { comparable: boolean; reason?: string; baseline_run_id: string; candidate_run_id: string; delta?: number; improvement?: number; outcome?: string; baseline_metric?: { value: number }; candidate_metric?: { value: number } };
function RunComparison({ base, query, candidate, runs, active }: { base: string; query: string; candidate: Run; runs: Run[]; active: boolean }) {
  const { t } = useTranslation();
  const label = (key: string) => t(`conversation.researchRuns.${key}`);
  const [baseline, setBaseline] = useState('');
  const number = (value?: number) => value === undefined ? '—' : new Intl.NumberFormat(undefined, { maximumSignificantDigits: 8 }).format(value);
  const result = useSWR(active && baseline ? ['run-comparison', base, query, baseline, candidate.id] : null,
    () => researchRequest<Comparison>('post', `${base}/compare${query}`, { baseline_run_id: baseline, candidate_run_id: candidate.id }), { refreshInterval: 1500, keepPreviousData: false });
  return <article className='workbench-card' data-testid='run-comparison'>
    <h3>{label('comparison')}</h3>
    <p>{label('candidate')}: {candidate.title} · {candidate.id}</p>
    <label>{label('baseline')} <select data-testid='comparison-baseline' style={{ maxWidth: '100%' }} value={baseline} onChange={e => setBaseline(e.target.value)}>
      <option value=''>{label('selectBaseline')}</option>
      {runs.filter(r => r.id !== candidate.id).map(r => <option key={r.id} value={r.id}>{r.title} · {r.id.slice(0, 8)}</option>)}
    </select></label>
    {result.isLoading && <p role='status'>{label('loading')}</p>}
    {result.error && <p role='alert'>{String(result.error)}</p>}
    {result.data && (result.data.comparable ? <div data-testid='comparison-result'>
      <p>{label(result.data.outcome ?? 'tied')}</p>
      <table><thead><tr><th>{label('baseline')}</th><th>{label('candidate')}</th><th>{label('delta')}</th></tr></thead><tbody><tr><td>{number(result.data.baseline_metric?.value)}</td><td>{number(result.data.candidate_metric?.value)}</td><td>{number(result.data.delta)}</td></tr></tbody></table>
    </div> : <p data-testid='comparison-rejected'>{label('notComparable')}: {label(result.data.reason ?? 'unknown')}</p>)}
    <p className='workbench-note'>{label('comparisonLimit')}</p>
  </article>;
}
