const { contextBridge, ipcRenderer } = require('electron');

/**
 * The whole surface the renderer gets. Two calls, both explicitly invoked by
 * the user — no filesystem, no shell, no node globals leak across.
 */
contextBridge.exposeInMainWorld('oramics', {
  savePdf: (bytes) => ipcRenderer.invoke('oramics:save-pdf', bytes),
  toggleProjector: () => ipcRenderer.invoke('oramics:toggle-projector'),
});
