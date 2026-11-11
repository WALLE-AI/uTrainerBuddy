import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import conversation from '../src/renderer/services/i18n/locales/en-US/conversation.json';
import { ResearchRuns } from '../src/renderer/components/research/ResearchRuns';
import { PreviewProvider, usePreviewContext } from '../src/renderer/pages/conversation/Preview/context';
import '../src/renderer/components/layout/project-workbench.css';
void i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { conversation } } }, initImmediate: false });
const fixture = (window as any).fixture;
function App() {
  const [index, setIndex] = useState(0);
  const [tab, setTab] = useState<'runs' | 'assets' | 'activity'>('runs');
  const preview = usePreviewContext();
  const source = fixture.sources[index];
  return <><textarea id='draft' defaultValue='KEEP DRAFT'/><button id='switch' onClick={() => setIndex(1-index)}>Switch conversation</button><button id='assets' onClick={() => setTab('assets')}>Artifacts</button><button id='activity' onClick={() => setTab('activity')}>Activity</button><button id='runs' onClick={() => setTab('runs')}>Runs</button><ResearchRuns projectId={source.project_id} conversationId={source.id} active tab={tab}/><pre id='preview'>{preview.tabs.map(t => t.content).join('\n')}</pre></>;
}
createRoot(document.getElementById('root')!).render(<PreviewProvider><App/></PreviewProvider>);
