import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../src/renderer/services/i18n/locales/en-US/conversation.json';
import { ResearchGoals } from '../src/renderer/components/research/ResearchGoals';
import '../src/renderer/components/layout/project-workbench.css';

const fixture = (window as any).fixture;
const originalFetch = window.fetch.bind(window);
(window as any).loseNextSave = false;
window.fetch = async (...args) => {
  if ((window as any).failGoalReads && args[1]?.method === 'GET' && String(args[0]).includes('/research')) {
    return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  const response = await originalFetch(...args);
  if ((window as any).loseNextSave && args[1]?.method === 'POST') {
    (window as any).loseNextSave = false;
    throw new TypeError('Simulated response loss after actual server commit');
  }
  return response;
};
window.confirm = () => true;
async function start() {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { conversation: en } } }, initImmediate: false });
  function Fixture() {
    const [index, setIndex] = useState(0);
    const [active, setActive] = useState(true);
    const source = fixture.sources[index];
    return <main className='trainer-project-workbench'>
      <textarea id='chat-draft' defaultValue='KEEP CHAT DRAFT' />
      <button id='switch' onClick={() => setIndex(value => 1 - value)}>Switch scope</button>
      <button id='toggle' onClick={() => setActive(value => !value)}>Toggle tab</button>
      <div hidden={!active}><ResearchGoals projectId={source.project_id} conversationId={source.id} active={active} /></div>
    </main>;
  }
  createRoot(document.getElementById('root')!).render(<Fixture />);
}
void start();
