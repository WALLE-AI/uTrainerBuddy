import { Message, Tooltip } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useCurrentProject } from '@/renderer/pages/conversation/explorer/currentProjectStore';
import { useCurrentConversation } from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { dispatchProjectWorkbenchOpen } from '@/renderer/utils/workspace/workspaceEvents';
import './compute-connection.css';

export default function ResearchWorkspaceEntry({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation();
  const projectId = useCurrentProject();
  const conversationId = useCurrentConversation();
  const label = t('conversation.researchWorkspace.entry', { defaultValue: '研究工作区' });
  const open = () => {
    if (!projectId || !conversationId) {
      Message.info(t('conversation.researchWorkspace.selectConversation', { defaultValue: '请先从左侧选择项目中的 Agent 会话，或在首页打开项目并创建会话。' }));
      return;
    }
    if (!dispatchProjectWorkbenchOpen(projectId)) {
      Message.info(t('conversation.researchWorkspace.panelUnavailable', { defaultValue: '当前工作台尚未就绪，请稍后重试。' }));
    }
  };
  return <Tooltip content={label} position='right' disabled={!collapsed}>
    <button type='button' data-testid='research-workbench-entry' className={`compute-connection-entry${collapsed ? ' is-collapsed' : ''}`} title={label} aria-label={label} onClick={open}>
      <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.5' aria-hidden='true'><path d='M9 3h6M10 3v7l-6 9a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-6-9V3M8 15h8' /></svg>
      {!collapsed && <span>{label}</span>}
    </button>
  </Tooltip>;
}
