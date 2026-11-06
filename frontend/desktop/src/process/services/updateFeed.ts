/**
 * @license
 * Copyright 2025 uBidBuddy
 * SPDX-License-Identifier: Apache-2.0
 */

import { CdnGenericProvider } from './cdnGenericProvider';
import type { CdnGenericProviderConfiguration } from './cdnGenericProvider';

// No update CDN of our own configured yet. `.invalid` is the IANA-reserved
// TLD for exactly this — guaranteed never to resolve — used instead of an
// empty string because electron-updater's GenericProvider constructor parses
// this eagerly with `new URL()` (even though autoUpdaterService.initialize()
// is never called in this build; see src/index.ts) and throws on an invalid
// URL, crashing the app at boot.
export const CDN_UPDATE_BASE_URL = 'https://update.ubidbuddy.invalid/releases';

export type CdnFeedOptions = CdnGenericProviderConfiguration & {
  updateProvider: typeof CdnGenericProvider;
};

export function buildCdnFeedOptions(): CdnFeedOptions {
  return {
    provider: 'custom',
    url: CDN_UPDATE_BASE_URL,
    updateProvider: CdnGenericProvider,
  };
}
