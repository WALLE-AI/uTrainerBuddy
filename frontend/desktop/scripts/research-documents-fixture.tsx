import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import conversation from '../src/renderer/services/i18n/locales/en-US/conversation.json';
import { PlanDocuments } from '../src/renderer/components/research/PlanDocuments';
import { ResearchModeSelector } from '../src/renderer/components/research/ResearchMode';
import { createQueuedCommandItem } from '../src/renderer/pages/conversation/platforms/useConversationCommandQueue';
import '../src/renderer/components/layout/project-workbench.css';
void i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { conversation } } }, initImmediate: false });
const state = window as any;
state.captureQueue = () => { state.queued = createQueuedCommandItem({ input: 'research question', files: [] }); };
function App() {
  const [index, setIndex] = useState(0);
  const [active, setActive] = useState(true);
  const [preview, setPreview] = useState('');
  const source = state.fixture.sources[index];
  return <><ResearchModeSelector/><textarea id='chat-draft' defaultValue='KEEP CHAT DRAFT'/><button id='switch' onClick={() => setIndex(1-index)}>Switch</button><button id='toggle' onClick={() => setActive(!active)}>Toggle</button><PlanDocuments projectId={source.project_id} conversationId={source.id} active={active} onOpen={doc => setPreview(doc.markdown || '')}/><pre id='preview'>{preview}</pre></>;
}
createRoot(document.getElementById('root')!).render(<App/>);
