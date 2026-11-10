import React, { useState } from 'react';
import '@arco-design/web-react/es/_util/react-19-adapter';
import { createRoot } from 'react-dom/client';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ResearchWorkspaceEntry from '../src/renderer/components/compute/ResearchWorkspaceEntry';
import { useProjectPanelCollapse } from '../src/renderer/hooks/ui/useProjectPanelCollapse';
import { setCurrentProject, useCurrentProject } from '../src/renderer/pages/conversation/explorer/currentProjectStore';
import { setCurrentConversation } from '../src/renderer/pages/conversation/explorer/currentConversationStore';
import { dispatchProjectWorkbenchOpen, dispatchWorkspaceToggleEvent } from '../src/renderer/utils/workspace/workspaceEvents';

async function start() {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: {} } }, initImmediate: false });
  function Fixture() {
    const project = useCurrentProject();
    const [mobile, setMobile] = useState(false);
    const [draft, setDraft] = useState('KEEP DRAFT');
    const { collapsed } = useProjectPanelCollapse({ projectId: project, isMobile: mobile, active: !!project });
    return <><ResearchWorkspaceEntry /><button id='project' onClick={() => { setCurrentProject('p1'); setCurrentConversation('c1'); }}>Project</button>
      <button id='none' onClick={() => { setCurrentProject(null); setCurrentConversation(null); }}>Home</button>
      <button id='mobile' onClick={() => setMobile(value => !value)}>Mobile</button>
      <button id='toggle' onClick={() => dispatchWorkspaceToggleEvent()}>Toggle</button>
      <textarea value={draft} onChange={event => setDraft(event.target.value)} />
      <div id='panel' data-collapsed={String(collapsed)} data-project={project ?? ''} /></>;
  }
  localStorage.setItem('project-panel-collapse:p1', 'collapsed');
  (window as any).openWrongProject = () => dispatchProjectWorkbenchOpen('wrong');
  createRoot(document.getElementById('root')!).render(<Fixture />);
}
void start();
