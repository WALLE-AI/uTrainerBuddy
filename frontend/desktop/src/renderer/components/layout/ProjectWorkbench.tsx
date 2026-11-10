/**
 * @license
 * Copyright 2025 uBidBuddy
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { useCurrentConversation } from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { ProjectFiles } from './ProjectFiles';
import { ResearchComputeCard } from '../compute/ResearchComputeCard';
import { emitter } from '@/renderer/utils/emitter';
import { Message } from '@arco-design/web-react';
import { Close, FullScreen, Pushpin, Refresh } from '@icon-park/react';
import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import './project-workbench.css';

const tabs = ['plan', 'runs', 'assets', 'activity', 'files'] as const;
type Tab = (typeof tabs)[number];

type ProjectWorkbenchProps = {
  projectId: string;
  collapsed: boolean;
  onCollapse: () => void;
  onToggleWidth?: () => void;
  expanded?: boolean;
};

export function ProjectWorkbench({
  projectId,
  collapsed,
  onCollapse,
  onToggleWidth,
  expanded = false,
}: ProjectWorkbenchProps) {
  const { t } = useTranslation();
  const label = (key: string) => t(`conversation.workbench.${key}`);
  const id = useId();
  const currentConversation = useCurrentConversation();
  const [pinnedConversation, setPinnedConversation] = useState<string | null>(null);
  const conversationId = pinnedConversation ?? currentConversation;
  const [sessionTabs, setSessionTabs] = useState<Record<string, Tab>>({});
  const tab = sessionTabs[conversationId ?? ''] ?? 'plan';
  const selectTab = (next: Tab) => setSessionTabs(previous => ({ ...previous, [conversationId ?? '']: next }));
  const enabled = !collapsed && !!conversationId;
  // Read-only snapshots refresh while visible, including a pinned inactive session.
  // Never keep the previous session's data when the SWR key changes.
  const options = { refreshInterval: collapsed ? 0 : 5000, revalidateOnFocus: !collapsed };
  const conversation = useSWR(
    enabled && tab === 'plan' ? ['workbench-conversation', conversationId] : null,
    () => ipcBridge.conversation.get.invoke({ id: conversationId! }),
    options
  );
  const plan = useSWR(
    enabled && tab === 'plan' ? ['workbench-plan', conversationId] : null,
    () => ipcBridge.database.getLatestConversationMessageOfType.invoke({ conversation_id: conversationId!, type: 'plan' }),
    options
  );
  const entries = plan.data?.type === 'plan' ? plan.data.content.entries : [];
  const completed = entries.filter(entry => entry.status === 'completed').length;
  const source = conversation.data?.name || conversationId;
  const request = plan;
  const reference = (text: string) => {
    if (!currentConversation) return;
    emitter.emit('workbench.reference.append', `${label('referenceSource')}: ${source}\n${text}`, currentConversation);
    Message.success(label('referenceAdded'));
  };
  const empty = (title: string, hint: string) => (
    <div className='workbench-empty'>
      <span aria-hidden='true'>◇</span>
      <h3>{label(title)}</h3>
      <p>{label(hint)}</p>
    </div>
  );

  return <>
    <header className='trainer-workbench-header'>
      <div className='workbench-actions'>
        <button
          type='button'
          title={label(pinnedConversation ? 'unpin' : 'pin')}
          aria-label={label(pinnedConversation ? 'unpin' : 'pin')}
          aria-pressed={!!pinnedConversation}
          disabled={!conversationId}
          onClick={() => setPinnedConversation(pinnedConversation ? null : currentConversation)}
        ><Pushpin size={15} /></button>
        {onToggleWidth && (
          <button
            type='button'
            title={label(expanded ? 'restoreWidth' : 'expandWidth')}
            aria-label={label(expanded ? 'restoreWidth' : 'expandWidth')}
            aria-pressed={expanded}
            onClick={onToggleWidth}
          ><FullScreen size={15} /></button>
        )}
        <button type='button' title={label('collapse')} aria-label={label('collapse')} onClick={onCollapse}>
          <Close size={16} />
        </button>
      </div>
    </header>
    <div className='workbench-tabs' role='tablist' aria-label={label('title')}>
      {tabs.map((item, index) => (
        <button
          key={item}
          id={`${id}-${item}`}
          type='button'
          role='tab'
          aria-selected={tab === item}
          aria-controls={`${id}-${item}-panel`}
          tabIndex={tab === item ? 0 : -1}
          onClick={() => selectTab(item)}
          onKeyDown={event => {
            const next = event.key === 'Home' ? 0
              : event.key === 'End' ? tabs.length - 1
              : event.key === 'ArrowRight' ? (index + 1) % tabs.length
              : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : -1;
            if (next < 0) return;
            event.preventDefault();
            selectTab(tabs[next]);
            document.getElementById(`${id}-${tabs[next]}`)?.focus();
          }}
        >{label(item)}</button>
      ))}
    </div>
    {pinnedConversation && (
      <div className='workbench-pin-banner'>
        <Pushpin size={13} />
        <span>{label('source')}: {source}<small>{label('pinHint')}</small></span>
      </div>
    )}
    {(tab === 'runs' || tab === 'assets' || tab === 'activity') && <section
      id={`${id}-${tab}-panel`}
      role='tabpanel'
      aria-labelledby={`${id}-${tab}`}
      className='workbench-body'
      tabIndex={0}
    />}
    <section id={`${id}-files-panel`} role='tabpanel' aria-labelledby={`${id}-files`} hidden={tab !== 'files'} className='workbench-body workbench-files-panel'>
      <ProjectFiles key={projectId} projectId={projectId} active={tab === 'files' && !collapsed} />
    </section>
    {tab === 'plan' && <section
      id={`${id}-${tab}-panel`}
      role='tabpanel'
      aria-labelledby={`${id}-${tab}`}
      className='workbench-body'
      tabIndex={0}
    >
      {conversationId && <ResearchComputeCard projectId={projectId} active={enabled} onOpenFiles={() => selectTab('files')} />}
      <div className='workbench-section-heading'>
        <h3>{label('latestPlan')}</h3>
        <button
          type='button'
          className='workbench-refresh'
          disabled={!enabled || request.isValidating}
          aria-label={label('refresh')}
          title={label('refresh')}
          onClick={() => {
            void request.mutate();
            void conversation.mutate();
          }}
        ><Refresh size={14} /></button>
      </div>
      {!conversationId ? empty('noConversation', 'noConversationHint') : request.error ? (
        <div className='workbench-notice' role='alert'>
          {label('loadError')}
          <button type='button' className='workbench-button' onClick={() => void request.mutate()}>{label('retry')}</button>
        </div>
      ) : request.isLoading ? <p role='status' className='workbench-note'>{label('loading')}</p> : <>
        {tab === 'plan' && (entries.length ? <>
          <div className='workbench-card'>
            <div className='workbench-section-heading'>
              <strong>{label('planProgress')}</strong><span className='workbench-badge'>{completed} / {entries.length}</span>
            </div>
            <progress value={completed} max={entries.length} aria-label={label('planProgress')} />
            <ol className='workbench-checklist'>
              {entries.map((entry, index) => (
                <li key={index} data-status={entry.status}>
                  <span aria-hidden='true'>{entry.status === 'completed' ? '✓' : index + 1}</span>
                  <div>{entry.content}<small>{label(`steps.${entry.status}`)}</small></div>
                </li>
              ))}
            </ol>
          </div>
          <p className='workbench-note'>{label('planHint')}</p>
          <button
            type='button'
            className='workbench-button'
            disabled={!currentConversation}
            onClick={() => reference(entries.map((entry, index) =>
              `${index + 1}. ${entry.content} (${label(`steps.${entry.status}`)})`
            ).join('\n'))}
          >{label('discussPlan')}</button>
        </> : empty('noPlan', 'noPlanHint'))}
      </>}
    </section>}
  </>;
}
