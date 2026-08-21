const { contextBridge, ipcRenderer } = require('electron');

/**
 * The whole surface the renderer gets. Every call is one the user explicitly
 * asked for, and each opens a dialog they have to answer — no filesystem, no
 * shell, no node globals leak across.
 */
contextBridge.exposeInMainWorld('oramics', {
  savePdf: (bytes, name) => ipcRenderer.invoke('oramics:save-pdf', bytes, name),
  saveSession: (text) => ipcRenderer.invoke('oramics:save-session', text),
  openSession: () => ipcRenderer.invoke('oramics:open-session'),
  toggleProjector: () => ipcRenderer.invoke('oramics:toggle-projector'),

  // Menu commands travel the other way. Only the command name crosses, never
  // an event object, so nothing from the main process leaks into the page.
  onCommand: (handler) => {
    const listener = (_event, command) => handler(command);
    ipcRenderer.on('oramics:command', listener);
    return () => ipcRenderer.removeListener('oramics:command', listener);
  },
});
