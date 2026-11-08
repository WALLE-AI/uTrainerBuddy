import React from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../index.module.css';

const starters = [
  { key: 'improve', icon: '↗', title: 'Improve metrics', detail: 'Diagnose a model and validate a training strategy', prompt: 'Help me improve my model metrics. First ask about the current model, dataset, evaluation protocol and available compute, then propose a minimal experiment.' },
  { key: 'adapt', icon: '◎', title: 'Adapt to a business', detail: 'Start with a scenario and a few real examples', prompt: 'Help me adapt a model to my business. First clarify the use case and acceptance criteria, then identify missing data and a baseline evaluation.' },
  { key: 'build', icon: '◇', title: 'Build from scratch', detail: 'Turn a business goal into a feasible first experiment', prompt: 'I want to build a model solution from scratch. Help me clarify inputs, outputs, constraints and data sources, then propose a minimal validation plan.' },
  { key: 'explore', icon: '✳', title: 'Explore a direction', detail: 'Form a hypothesis and design a small experiment', prompt: 'Help me explore a research direction. First clarify my idea, existing evidence and budget, then formulate testable hypotheses and a minimal experiment.' },
];

export default function ResearchStarters({ onSelect }: { onSelect: (prompt: string) => void }) {
  const { t } = useTranslation();
  return <section className={styles.researchStarters} aria-label={t('guid.research.start', { defaultValue: 'Choose a starting point' })}>
    {starters.map(s => <button type='button' key={s.key} className={styles.researchStarter} onClick={() => onSelect(t(`guid.research.${s.key}.prompt`, { defaultValue: s.prompt }))}>
      <span className={styles.researchIcon} aria-hidden='true'>{s.icon}</span>
      <span><strong>{t(`guid.research.${s.key}.title`, { defaultValue: s.title })}</strong><small>{t(`guid.research.${s.key}.detail`, { defaultValue: s.detail })}</small></span>
      <span className={styles.researchArrow} aria-hidden='true'>↗</span>
    </button>)}
  </section>;
}
