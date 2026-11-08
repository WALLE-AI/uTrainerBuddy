// Only loaded by verify-workbench.mjs in an isolated Electron test profile.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SWRConfig } from 'swr';
import { ipcBridge } from '../src/common';
import { ProjectPanelHost } from '../src/renderer/components/layout/ProjectPanelHost';
import { ProjectPanelMobileOverlay } from '../src/renderer/components/layout/ProjectPanelMobileOverlay';
import { PreviewProvider } from '../src/renderer/pages/conversation/Preview';
import { setCurrentProject } from '../src/renderer/pages/conversation/explorer/currentProjectStore';
import { setCurrentConversation } from '../src/renderer/pages/conversation/explorer/currentConversationStore';
import { useProjectExplorerColumnWidth } from '../src/renderer/hooks/ui/useProjectExplorerColumnWidth';
import { emitter } from '../src/renderer/utils/emitter';
import i18n from '../src/renderer/services/i18n';
import '../src/renderer/styles/trainer-workspace.css';

export async function mount() {
  await i18n.changeLanguage('zh-CN');
  const originals = [ipcBridge.project.get.invoke, ipcBridge.conversation.get.invoke,
    ipcBridge.database.getLatestConversationMessageOfType.invoke, ipcBridge.database.getConversationMessages.invoke];
  let failPlan = false;
  ipcBridge.project.get.invoke = async ({ project_id }) => ({ project_id, name: 'Fixture', explorer: { workspace_pe_id: '', entries: [] } });
  ipcBridge.conversation.get.invoke = async ({ id }) => ({
    id, name: id === 'workbench-a' ? '长尾场景优化' : '构建售后数据集', type: 'acp',
    runtime: { state: 'running', is_processing: true, pending_confirmations: 0, turn_id: 'turn-test' },
  }) as any;
  ipcBridge.database.getLatestConversationMessageOfType.invoke = async ({ conversation_id }) => {
    if (failPlan) throw new Error('Fixture read error');
    if (conversation_id !== 'workbench-a') return null;
    return { id: 'plan-test', conversation_id, type: 'plan', content: { session_id: conversation_id, entries: [
      { content: '审计业务条件覆盖', status: 'completed', priority: 'high' },
      { content: '补充长尾样本与单变量训练', status: 'in_progress', priority: 'high' },
      { content: '按同一协议进行独立评测', status: 'pending', priority: 'medium' },
    ] } };
  };
  ipcBridge.database.getConversationMessages.invoke = async ({ conversation_id }) => ({ items: [
    { id: 'message-test', conversation_id, type: 'text', created_at: Date.now(), content: { content: '已完成业务条件覆盖审计，继续检查长尾样本。' } },
  ], has_more_before: false, has_more_after: false }) as any;
  const container = document.createElement('div');
  container.id = 'workbench-fixture';
  Object.assign(container.style, { position: 'fixed', inset: '0', zIndex: '99999', background: 'var(--bg-1)' });
  document.body.append(container);
  const root = createRoot(container);
  function Fixture() {
    const [collapsed, setCollapsed] = useState(false);
    const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
    const [draft, setDraft] = useState('KEEP_EXISTING_DRAFT');
    const { widthPx, createDragHandle, toggleWidth, expanded } = useProjectExplorerColumnWidth(1000, false, true);
    useEffect(() => {
      const resize = () => setViewportWidth(window.innerWidth);
      const toggle = (event: Event) => { event.preventDefault(); setCollapsed(value => !value); };
      const append = (text: string, target: string) => setDraft(previous => `${previous}\n${target}\n${text}`);
      window.addEventListener('ubidbuddy-workspace-toggle', toggle);
      window.addEventListener('resize', resize);
      emitter.on('workbench.reference.append', append);
      return () => { window.removeEventListener('resize', resize); window.removeEventListener('ubidbuddy-workspace-toggle', toggle); emitter.off('workbench.reference.append', append); };
    }, []);
    return <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}><PreviewProvider>
      <div style={{ display: 'flex', height: '100%' }}>
        <main style={{ flex: 1, minWidth: 0, padding: 24 }}>
          <h2>工作台交互验收 · 测试数据</h2>
          <button id='fixture-a' onClick={() => setCurrentConversation('workbench-a')}>会话 A</button>
          <button id='fixture-b' onClick={() => setCurrentConversation('workbench-b')}>会话 B</button>
          <button id='fixture-project' onClick={() => setCurrentProject('workbench-project-b')}>切换项目</button>
          <button id='fixture-reopen' onClick={() => setCollapsed(false)}>展开工作台</button>
          <textarea aria-label='Fixture draft' value={draft} onChange={event => setDraft(event.target.value)} style={{ display: 'block', width: '100%', height: 200, marginTop: 24 }} />
        </main>
        {viewportWidth < 768
          ? <ProjectPanelMobileOverlay projectId='workbench-project-a' collapsed={collapsed} onCollapse={() => setCollapsed(true)} widthPx={Math.min(420, viewportWidth * .85)} />
          : <ProjectPanelHost widthPx={widthPx} collapsed={collapsed} onToggleWidth={toggleWidth} expanded={expanded} dragHandle={createDragHandle({ className: 'absolute start-0 top-0 bottom-0 z-20', reverse: true })} />}
      </div>
    </PreviewProvider></SWRConfig>;
  }
  setCurrentProject('workbench-project-a');
  setCurrentConversation('workbench-a');
  root.render(<Fixture />);
  return {
    failPlan: (value: boolean) => { failPlan = value; },
    cleanup: () => {
      root.unmount(); container.remove(); setCurrentProject(null); setCurrentConversation(null);
      [ipcBridge.project.get.invoke, ipcBridge.conversation.get.invoke,
        ipcBridge.database.getLatestConversationMessageOfType.invoke, ipcBridge.database.getConversationMessages.invoke] = originals;
    },
  };
}
