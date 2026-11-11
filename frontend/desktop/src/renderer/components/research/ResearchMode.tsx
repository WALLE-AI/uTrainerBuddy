import React, { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
export type ResearchMode = 'quick' | 'deep';
const key = 'trainerbuddy.research-mode';
const eventName = 'trainerbuddy-research-mode';
export function getResearchMode(): ResearchMode {
  try { return localStorage.getItem(key) === 'deep' ? 'deep' : 'quick'; }
  catch { return 'quick'; }
}
function subscribe(callback: () => void) {
  window.addEventListener(eventName, callback);
  window.addEventListener('storage', callback);
  return () => {
    window.removeEventListener(eventName, callback);
    window.removeEventListener('storage', callback);
  };
}
export function ResearchModeSelector() {
  const { t } = useTranslation();
  const value = useSyncExternalStore(subscribe, getResearchMode);
  return <div className='flex gap-8px mb-8px' role='group' aria-label={t('conversation.researchModes.label')}>
    {(['quick', 'deep'] as const).map(mode => <button
      key={mode}
      type='button'
      className='workbench-button'
      aria-pressed={value === mode}
      onClick={() => {
        localStorage.setItem(key, mode);
        window.dispatchEvent(new Event(eventName));
      }}
    >{value === mode ? '● ' : ''}{t(`conversation.researchModes.${mode}`)}</button>)}
  </div>;
}
