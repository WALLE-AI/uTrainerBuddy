import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { Message } from '@arco-design/web-react';
import { syncRequest, type BindingData } from './ProjectPublish';
import { openComputeConnection } from './connectionEvents';
import { researchComputeSummary } from './researchComputeSummary';

export function ResearchComputeCard({ projectId, active, onOpenFiles }: { projectId: string; active: boolean; onOpenFiles: () => void }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const label = (key: string) => t(`conversation.workbench.compute.${key}`);
  const request = useSWR(active ? ['project-sync-binding', projectId] : null,
    () => syncRequest<BindingData>('GET', `projects/${encodeURIComponent(projectId)}/compute-binding`),
    { refreshInterval: active ? 10000 : 0, revalidateOnFocus: active, shouldRetryOnError: false, keepPreviousData: false });
  useEffect(() => {
    if (!active) return;
    // SWR may retain equal response data; observation age must still advance.
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 10000);
    const refresh = () => { void request.mutate(); };
    window.addEventListener('trainer-compute-change', refresh);
    window.addEventListener('trainer-project-sync-change', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('trainer-compute-change', refresh);
      window.removeEventListener('trainer-project-sync-change', refresh);
    };
  }, [active, request.mutate]);
  const summary = request.data ? researchComputeSummary(request.data, Math.max(now, Date.now())) : null;
  const date = (value: number | null) => value ? new Date(value).toLocaleString() : label('never');
  return <section className='workbench-card' data-testid='research-compute'>
    <div className='workbench-section-heading'><h3>{label('title')}</h3>
      <button type='button' className='workbench-refresh' disabled={!active || request.isValidating} onClick={() => void request.mutate()}>{label('refresh')}</button>
    </div>
    {request.error ? <p className='workbench-note' role='alert'>{label('loadError')}</p>
      : !summary ? <p className='workbench-note' role='status'>{label('loading')}</p>
        : <><p className='workbench-note' role='status' data-compute-state={summary.state}>{label(summary.state)}</p>
          {summary.targetId && <dl className='workbench-facts'>
            <div><dt>{label('target')}</dt><dd>{summary.host ?? summary.targetId}</dd></div>
            <div><dt>{label('remoteRoot')}</dt><dd>{summary.remoteRoot ?? label('unknown')}</dd></div>
            <div><dt>{label('snapshot')}</dt><dd>{summary.commit?.slice(0, 12) ?? label('notPublished')}</dd></div>
            <div><dt>{label('observedAt')}</dt><dd>{date(summary.observedAt)}</dd></div>
          </dl>}
          {summary.snapshot && <p className='workbench-note'>
            {!summary.live && <strong>{label('historical')} · </strong>}
            Python {summary.snapshot.python || label('unknown')}<br />
            {summary.snapshot.gpu_error ? label('gpuUnknown') : summary.snapshot.gpus.length
              ? summary.snapshot.gpus.map(gpu => gpu.name).join(' / ') : label('noGpu')}
          </p>}
        </>}
    <p className='workbench-note'>{label('boundary')}</p>
    <div className='workbench-compute-actions'>
      <button type='button' className='workbench-button' onClick={() => { if (!openComputeConnection()) Message.info(label('unavailable')); }}>{label('configure')}</button>
      <button type='button' className='workbench-button' onClick={onOpenFiles}>{label('binding')}</button>
    </div>
  </section>;
}
