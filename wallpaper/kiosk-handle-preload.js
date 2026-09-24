const { contextBridge, ipcRenderer } = require('electron');

// Preload for kiosk-handle.html — the 28 px drag strip at the top of each
// panel window. Mirrors the pattern in kiosk-preload.js: contextIsolation +
// sandbox, no node access in the renderer.
contextBridge.exposeInMainWorld('kioskHandle', {
  // Call fn(title) whenever the attached panel page changes its title.
  onTitle: (fn) => {
    ipcRenderer.on('panel-title', (_event, title) => fn(title));
  },

  // Call fn('active' | 'auto') whenever the panel's mode changes.
  onMode: (fn) => {
    ipcRenderer.on('panel-mode', (_event, mode) => fn(mode));
  },

  // Call fn({ canGoBack }) after each navigation so the Back button can
  // enable or disable itself.
  onNavState: (fn) => {
    ipcRenderer.on('panel-nav-state', (_event, state) => fn(state));
  },

  // Ask the main process to send this panel back to its home position.
  resetPosition: () => {
    ipcRenderer.send('panel-reset-position');
  },

  // Ask the main process to navigate the panel back one step in history.
  goBack: () => {
    ipcRenderer.send('panel-back');
  },
});
