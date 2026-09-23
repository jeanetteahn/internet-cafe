const { contextBridge, ipcRenderer } = require('electron');

// Preload for kiosk-handle.html — the 28 px drag strip at the top of each
// panel window. Mirrors the pattern in kiosk-preload.js: contextIsolation +
// sandbox, no node access in the renderer.
contextBridge.exposeInMainWorld('kioskHandle', {
  // Call fn(title) whenever the attached panel page changes its title.
  onTitle: (fn) => {
    ipcRenderer.on('panel-title', (_event, title) => fn(title));
  },

  // Ask the main process to send this panel back to its home position.
  resetPosition: () => {
    ipcRenderer.send('panel-reset-position');
  },
});
