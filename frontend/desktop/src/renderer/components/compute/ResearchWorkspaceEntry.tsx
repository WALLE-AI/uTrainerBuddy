import { Message, Tooltip } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import './compute-connection.css';

export default function ResearchWorkspaceEntry({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const label = t('conversation.researchWorkspace.entry', { defaultValue: '研究工作区' });
  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!window.electronAPI?.openResearchWorkspace) throw new Error('RESEARCH_DESKTOP_REQUIRED');
      const result = await window.electronAPI.openResearchWorkspace();
      if (!result.success) throw new Error(result.code);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'RESEARCH_START_FAILED';
      Message.error(t(`conversation.researchWorkspace.errors.${code}`, { defaultValue: code }));
    } finally { setBusy(false); }
  };
  return <Tooltip content={label} position='right' disabled={!collapsed}>
    <button type='button' className={`compute-connection-entry${collapsed ? ' is-collapsed' : ''}`} title={label} aria-label={label} disabled={busy} onClick={() => void open()}>
      <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.5' aria-hidden='true'><path d='M9 3h6M10 3v7l-6 9a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-6-9V3M8 15h8' /></svg>
      {!collapsed && <span>{busy ? t('conversation.researchWorkspace.opening', { defaultValue: '正在打开研究工作区…' }) : label}</span>}
    </button>
  </Tooltip>;
}
