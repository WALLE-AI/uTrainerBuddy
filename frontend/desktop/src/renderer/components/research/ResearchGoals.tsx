import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { ApiError } from '@/renderer/api';
import { goalPath, researchRequest, type GoalFields, type ResearchGoal } from './api';

const fields = ['title', 'objective', 'evaluation', 'constraints'] as const;
type Draft = { id: string | null; revision: number; fields: GoalFields; requestId: string; attempted: boolean };
// Window-local drafts survive component/project remounts; no credentials are stored.
const drafts = new Map<string, Draft>();
const pick = (goal: GoalFields): GoalFields => ({ title: goal.title, objective: goal.objective, evaluation: goal.evaluation, constraints: goal.constraints });

export function ResearchGoals(props: { projectId: string; conversationId: string; active: boolean }) {
  const scope = JSON.stringify([props.projectId, props.conversationId]);
  return <ScopedGoals key={scope} {...props} scope={scope} />;
}

function ScopedGoals({ projectId, conversationId, active, scope }: { projectId: string; conversationId: string; active: boolean; scope: string }) {
  const { t } = useTranslation();
  const label = (key: string) => t(`conversation.workbench.research.${key}`);
  const fieldId = useId();
  const [draft, setDraft] = useState<Draft | null>(() => drafts.get(scope) ?? null);
  const [selected, setSelected] = useState(draft?.id ?? '');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const path = goalPath(projectId);
  const list = useSWR(active ? ['research-goals', projectId, conversationId] : null,
    () => researchRequest<ResearchGoal[]>('get', `${path}?conversation_id=${encodeURIComponent(conversationId)}`),
    { refreshInterval: 10000, keepPreviousData: false, shouldRetryOnError: false });
  const goals = (list.data ?? []).filter(goal => goal.project_id === projectId && goal.origin_conversation_id === conversationId);
  const current = goals.find(goal => goal.id === selected);
  const changeDraft = (value: Draft | null) => {
    if (value) drafts.set(scope, value); else drafts.delete(scope);
    if (mounted.current) setDraft(value);
  };
  const begin = (goal?: ResearchGoal) => {
    setError(''); setSaved(false);
    changeDraft({ id: goal?.id ?? null, revision: goal?.revision ?? 0, fields: goal ? pick(goal) : { title: '', objective: '', evaluation: '', constraints: '' }, requestId: crypto.randomUUID(), attempted: false });
  };
  const finish = (goal: ResearchGoal) => {
    changeDraft(null);
    if (mounted.current) { setSelected(goal.id); setSaved(true); setError(''); }
    // Update only the originating scope, even if the user switched while saving.
    void list.mutate(previous => [goal, ...(previous ?? []).filter(item => item.id !== goal.id)], { revalidate: true }).catch(() => {});
  };
  const save = async () => {
    if (!draft || busyRef.current || !active) return;
    busyRef.current = true; setBusy(true); setError('');
    const sent = { ...draft, attempted: true };
    changeDraft(sent);
    try {
      const goal = await researchRequest<ResearchGoal>(sent.id ? 'patch' : 'post', sent.id ? `${path}/${encodeURIComponent(sent.id)}` : path,
        sent.id ? { ...sent.fields, expected_revision: sent.revision } : { ...sent.fields, request_id: sent.requestId, origin_conversation_id: conversationId });
      finish(goal);
    } catch (failure) {
      const code = failure instanceof ApiError && failure.body && typeof failure.body === 'object' && 'code' in failure.body ? String(failure.body.code) : '';
      if (code === 'RESEARCH_REVISION_CONFLICT' && sent.id) {
        try {
          const latest = await researchRequest<ResearchGoal>('get', `${path}/${encodeURIComponent(sent.id)}`);
          // A prior PATCH may have committed before its response was lost.
          if (latest.revision === sent.revision + 1 && fields.every(field => latest[field] === sent.fields[field])) { finish(latest); return; }
        } catch { /* Preserve the draft and require an explicit refresh. */ }
        if (mounted.current) setError('conflict');
        changeDraft({ ...sent, attempted: false });
      } else if ((failure instanceof ApiError && failure.status >= 400 && failure.status < 500) || (failure instanceof Error && failure.message === 'BACKEND_UNAVAILABLE')) {
        changeDraft({ ...sent, attempted: false });
        if (mounted.current) setError(code === 'NOT_FOUND' ? 'missing' : 'saveError');
      } else {
        // An ambiguous outcome must retry the exact payload/key, not create another goal.
        if (mounted.current) setError('uncertain');
      }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const reload = async () => {
    if (!draft?.id || busyRef.current || !window.confirm(label('replaceConfirm'))) return;
    busyRef.current = true; setBusy(true);
    try { const goal = await researchRequest<ResearchGoal>('get', `${path}/${encodeURIComponent(draft.id)}`); if (mounted.current) begin(goal); }
    catch { if (mounted.current) setError('loadError'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const valid = draft && draft.fields.title.trim() && draft.fields.objective.trim()
    && fields.every(field => Array.from(draft.fields[field]).length <= (field === 'title' ? 200 : 16000));
  return <section className='workbench-card research-goals' data-testid='research-goals'>
    <div className='workbench-section-heading'><h3>{label('heading')}</h3>
      <button type='button' className='workbench-refresh' disabled={!active || list.isValidating} onClick={() => void list.mutate().catch(() => {})}>{label('refresh')}</button>
    </div>
    <p className='workbench-note'>{label('scope')}</p>
    {list.error ? <p role='alert'>{label('loadError')}</p> : list.isLoading ? <p role='status'>{label('loading')}</p> : !goals.length && <p>{label('empty')}</p>}
    <label htmlFor={`${fieldId}-select`}>{label('select')}</label>
    <select id={`${fieldId}-select`} data-testid='goal-select' value={selected} disabled={!!draft || busy || !active || !!list.error} onChange={event => { setSelected(event.target.value); setSaved(false); }}>
      <option value=''>{label('choose')}</option>
      {goals.map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}
    </select>
    {!draft && <div className='workbench-compute-actions'>
      <button type='button' data-testid='goal-new' className='workbench-button' disabled={!active || !!list.error || !list.data} onClick={() => begin()}>{label('create')}</button>
      <button type='button' data-testid='goal-edit' className='workbench-button' disabled={!active || !current || !!list.error} onClick={() => current && begin(current)}>{label('edit')}</button>
    </div>}
    {!draft && current && !list.error && <dl className='research-goal-detail'>{fields.map(field => <div key={field}><dt>{label(field)}</dt><dd>{current[field] || label('unspecified')}</dd></div>)}<div><dt>{label('revision')}</dt><dd>{current.revision}</dd></div></dl>}
    {draft && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <p className='workbench-note'>{label(draft.attempted ? 'uncertain' : 'draftHint')}</p>
      {fields.map(field => <label key={field} htmlFor={`${fieldId}-${field}`}>{label(field)}
        <textarea id={`${fieldId}-${field}`} data-field={field} rows={field === 'title' ? 1 : 3} required={field === 'title' || field === 'objective'}
          disabled={busy || draft.attempted || !active} value={draft.fields[field]}
          onChange={event => { changeDraft({ ...draft, fields: { ...draft.fields, [field]: event.target.value } }); setSaved(false); }} />
      </label>)}
      <div className='workbench-compute-actions'>
        <button type='submit' data-testid='goal-save' className='workbench-button' disabled={!valid || busy || !active}>{label(busy ? 'saving' : draft.attempted ? 'retry' : 'save')}</button>
        <button type='button' className='workbench-button' disabled={busy || draft.attempted} onClick={() => { if (window.confirm(label('discardConfirm'))) { changeDraft(null); setError(''); } }}>{label('discard')}</button>
        {draft.id && error === 'conflict' && <button type='button' data-testid='goal-reload' className='workbench-button' disabled={busy} onClick={() => void reload()}>{label('reload')}</button>}
      </div>
      {!valid && <p className='workbench-note'>{label('validation')}</p>}
    </form>}
    {error && <p role='alert'>{label(error)}</p>}
    {saved && <p role='status'>{label('saved')}</p>}
  </section>;
}
