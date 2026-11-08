// The native IPC provider protocol replies through a subscription event;
// ipcRenderer.invoke itself only acknowledges delivery of the request.
const requests = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
const maximizeListeners = new Set<(maximized: boolean) => void>();
export function onWindowMaximizedChanged(listener: (maximized: boolean) => void): () => void {
  maximizeListeners.add(listener);
  return () => { maximizeListeners.delete(listener); };
}
window.electronAPI?.on(({ value }) => {
  try {
    const event = JSON.parse(value) as { name: string; data: unknown };
    if (event.name === 'windowControls.maximizedChanged') {
      const maximized = (event.data as { is_maximized: boolean }).is_maximized;
      for (const listener of maximizeListeners) listener(maximized);
    }
    const request = requests.get(event.name);
    if (!request) return;
    clearTimeout(request.timeout);
    requests.delete(event.name);
    request.resolve(event.data);
  } catch { /* Ignore unrelated bridge messages. */ }
});

export function windowControl(action: 'minimize' | 'maximize' | 'unmaximize' | 'close' | 'isMaximized'): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const name = `windowControls.${action}`;
    const key = `subscribe.callback-${name}${id}`;
    const timeout = setTimeout(() => { requests.delete(key); reject(new Error('Window control timed out')); }, 5000);
    requests.set(key, { resolve, reject, timeout });
    Promise.resolve(window.electronAPI?.emit(`subscribe-${name}`, { id })).catch(error => {
      clearTimeout(timeout); requests.delete(key); reject(error);
    });
  });
}
