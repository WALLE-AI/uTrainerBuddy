import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { researchRequest } from './api';

type Document = { id: string; title: string; path: string; revision: number; sha256: string; markdown?: string };
type Props = { projectId: string; conversationId: string; active: boolean; onOpen: (document: Document) => void };

export function PlanDocuments(props: Props) {
  return <ScopedDocuments key={JSON.stringify([props.projectId, props.conversationId])} {...props} />;
}

function ScopedDocuments({ projectId, conversationId, active, onOpen }: Props) {
  const { t } = useTranslation();
  const label = (key: string) => t(`conversation.planDocuments.${key}`);
  const current = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    current.current = true;
    return () => { current.current = false; };
  }, []);
  const [error, setError] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/research-documents`;
  const query = `?conversation_id=${encodeURIComponent(conversationId)}`;
  const list = useSWR(
    active ? ['plan-documents', projectId, conversationId] : null,
    () => researchRequest<Document[]>('get', base + query),
    { refreshInterval: 3000, keepPreviousData: false, shouldRetryOnError: false }
  );
  const open = async (id: string) => {
    setOpening(id);
    setError(false);
    try {
      const doc = await researchRequest<Document>('get', `${base}/${encodeURIComponent(id)}${query}`);
      if (current.current && activeRef.current) onOpen(doc);
    } catch {
      if (current.current) setError(true);
    } finally {
      if (current.current) setOpening(null);
    }
  };
  return <section className='workbench-card' data-testid='plan-documents'>
    <div className='workbench-section-heading'>
      <h3>{label('heading')}</h3>
      <button className='workbench-refresh' type='button' disabled={!active || list.isValidating}
        onClick={() => void list.mutate().catch(() => {})}>{label('refresh')}</button>
    </div>
    <p className='workbench-note'>{label('hint')}</p>
    {(list.error || error) && <p role='alert'>{label('error')}</p>}
    {list.isLoading && <p role='status'>{label('loading')}</p>}
    {!list.error && list.data?.length === 0 && <p className='workbench-note'>{label('empty')}</p>}
    {!list.error && list.data?.map(doc => <article key={doc.id} className='workbench-card'>
      <strong>{doc.title}</strong><p className='workbench-note'>{doc.path}</p>
      <button data-testid='open-plan' className='workbench-button' type='button' disabled={!active || !!opening}
        onClick={() => void open(doc.id)}>{opening === doc.id ? label('loading') : label('open')}</button>
    </article>)}
  </section>;
}
