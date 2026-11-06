/**
 * @license
 * Copyright 2025 uBidBuddy
 * SPDX-License-Identifier: Apache-2.0
 */

import { getPlatformServices } from '@/common/platform';

/**
 * Returns baseName unchanged in release builds, or baseName + '-dev' in dev builds.
 * When UBIDBUDDY_MULTI_INSTANCE=1, appends '-2' to isolate the second dev instance.
 * Used to isolate symlink and directory names between environments.
 *
 * @example
 * getEnvAwareName('.ubidbuddy')        // release → '.ubidbuddy',        dev → '.ubidbuddy-dev'
 * getEnvAwareName('.ubidbuddy-config') // release → '.ubidbuddy-config', dev → '.ubidbuddy-config-dev'
 * // with UBIDBUDDY_MULTI_INSTANCE=1:  dev → '.ubidbuddy-dev-2'
 */
export function getEnvAwareName(baseName: string): string {
  if (getPlatformServices().paths.isPackaged() === true) return baseName;
  const suffix = process.env.UBIDBUDDY_MULTI_INSTANCE === '1' ? '-dev-2' : '-dev';
  return `${baseName}${suffix}`;
}
