/**
 * @license
 * Copyright 2025 uBidBuddy
 * SPDX-License-Identifier: Apache-2.0
 */

import i18n from 'i18next';
import { ProcessConfig } from '@process/utils/initStorage';
import {
  DEFAULT_LANGUAGE,
  normalizeLanguageCode,
  mergeWithFallback,
  ensureAndSwitch,
  type LocaleData,
} from '@/common/config/i18n';

// Static imports – Vite bundles these into the main-process output so they
// work correctly in both development and production (no fs.readFile needed).
//
// Only `common` + `pet` namespaces are imported per locale (the only ones the
// tray/menu/pet code actually reads via i18n.t()) rather than each locale's
// full barrel (`locales/<lang>/index.ts`, ~19 namespace files including large
// ones like settings.json/mcp.json). Importing the full barrel for many
// locales trips an electron-vite bug: its CJS-shim-insertion pass (a regex
// scan for the last `import ... from '...'` in the bundled main-process
// output) miscomputes its splice offset once the bundle contains that many
// inlined JSON modules, corrupting a string literal ("Unterminated string
// literal" at build time). Scoping to the 2 namespaces actually needed here
// avoids it; re-widen if more namespaces are needed in the main process, but
// verify the build still succeeds.
import commonEnUS from '@renderer/services/i18n/locales/en-US/common.json';
import petEnUS from '@renderer/services/i18n/locales/en-US/pet.json';
import commonZhCN from '@renderer/services/i18n/locales/zh-CN/common.json';
import petZhCN from '@renderer/services/i18n/locales/zh-CN/pet.json';
import commonZhTW from '@renderer/services/i18n/locales/zh-TW/common.json';
import petZhTW from '@renderer/services/i18n/locales/zh-TW/pet.json';
import commonJaJP from '@renderer/services/i18n/locales/ja-JP/common.json';
import petJaJP from '@renderer/services/i18n/locales/ja-JP/pet.json';
import commonKoKR from '@renderer/services/i18n/locales/ko-KR/common.json';
import petKoKR from '@renderer/services/i18n/locales/ko-KR/pet.json';
import commonTrTR from '@renderer/services/i18n/locales/tr-TR/common.json';
import petTrTR from '@renderer/services/i18n/locales/tr-TR/pet.json';
import commonRuRU from '@renderer/services/i18n/locales/ru-RU/common.json';
import petRuRU from '@renderer/services/i18n/locales/ru-RU/pet.json';
import commonUkUA from '@renderer/services/i18n/locales/uk-UA/common.json';
import petUkUA from '@renderer/services/i18n/locales/uk-UA/pet.json';
import commonPtBR from '@renderer/services/i18n/locales/pt-BR/common.json';
import petPtBR from '@renderer/services/i18n/locales/pt-BR/pet.json';
import commonDeDE from '@renderer/services/i18n/locales/de-DE/common.json';
import petDeDE from '@renderer/services/i18n/locales/de-DE/pet.json';
import commonEsES from '@renderer/services/i18n/locales/es-ES/common.json';
import petEsES from '@renderer/services/i18n/locales/es-ES/pet.json';
import commonFrFR from '@renderer/services/i18n/locales/fr-FR/common.json';
import petFrFR from '@renderer/services/i18n/locales/fr-FR/pet.json';
import commonFaIR from '@renderer/services/i18n/locales/fa-IR/common.json';
import petFaIR from '@renderer/services/i18n/locales/fa-IR/pet.json';

// All locale data keyed by language code.
// NOTE: When adding a new language, add the two namespace imports above and
// an entry here. These MUST be static imports (not dynamic) because the main
// process is bundled by Vite and the JSON files won't exist on disk in
// production.
const localeData: LocaleData = {
  'en-US': { common: commonEnUS, pet: petEnUS },
  'zh-CN': { common: commonZhCN, pet: petZhCN },
  'zh-TW': { common: commonZhTW, pet: petZhTW },
  'ja-JP': { common: commonJaJP, pet: petJaJP },
  'ko-KR': { common: commonKoKR, pet: petKoKR },
  'tr-TR': { common: commonTrTR, pet: petTrTR },
  'ru-RU': { common: commonRuRU, pet: petRuRU },
  'uk-UA': { common: commonUkUA, pet: petUkUA },
  'pt-BR': { common: commonPtBR, pet: petPtBR },
  'de-DE': { common: commonDeDE, pet: petDeDE },
  'es-ES': { common: commonEsES, pet: petEsES },
  'fr-FR': { common: commonFrFR, pet: petFrFR },
  'fa-IR': { common: commonFaIR, pet: petFaIR },
};

const fallbackData = localeData[DEFAULT_LANGUAGE] ?? {};

function getLocaleModules(locale: string): Record<string, unknown> {
  const data = localeData[locale];
  if (!data) return fallbackData;
  if (locale === DEFAULT_LANGUAGE) return data;
  return mergeWithFallback(fallbackData, data);
}

/** Resolves when i18n is fully initialized with the user's language */
export const i18nReady = (async (): Promise<void> => {
  await i18n.init({
    resources: {
      [DEFAULT_LANGUAGE]: { translation: getLocaleModules(DEFAULT_LANGUAGE) },
    },
    fallbackLng: DEFAULT_LANGUAGE,
    debug: false,
    interpolation: { escapeValue: false },
  });

  const language = await ProcessConfig.get('language');
  if (language) {
    await ensureAndSwitch(i18n, language, getLocaleModules);
  }
})().catch((error) => {
  console.error('[Main Process] Failed to initialize i18n:', error);
});

/**
 * Set initial language (called after storage is ready)
 */
export async function setInitialLanguage(language: string | undefined): Promise<void> {
  await i18nReady;
  if (language) {
    await ensureAndSwitch(i18n, language, getLocaleModules);
  }
}

/**
 * Change language
 */
export async function changeLanguage(language: string): Promise<void> {
  await i18nReady;
  await ensureAndSwitch(i18n, language, getLocaleModules);
}

export { normalizeLanguageCode };
export default i18n;
