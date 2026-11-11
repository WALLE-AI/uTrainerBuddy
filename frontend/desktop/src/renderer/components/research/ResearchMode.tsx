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
  return <select
      data-testid='research-mode-select'
      aria-label={t('conversation.researchModes.label')}
      value={value}
      style={{ height: 28, maxWidth: 124, flexShrink: 0, padding: '0 6px', border: 'none', borderRadius: 6, background: 'var(--color-fill-2)', color: 'var(--color-text-1)', fontSize: 12, cursor: 'pointer' }}
      onChange={event => {
        localStorage.setItem(key, event.target.value);
        window.dispatchEvent(new Event(eventName));
      }}
    >
      {(['quick', 'deep'] as const).map(mode => <option key={mode} value={mode}>{t(`conversation.researchModes.${mode}`)}</option>)}
    </select>;
}
