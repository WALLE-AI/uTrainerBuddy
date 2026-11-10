export const OPEN_COMPUTE_CONNECTION = 'trainer-open-compute-connection';

/** Open the existing connection dialog without navigating away from the conversation. */
export function openComputeConnection(): boolean {
  const event = new CustomEvent(OPEN_COMPUTE_CONNECTION, { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
