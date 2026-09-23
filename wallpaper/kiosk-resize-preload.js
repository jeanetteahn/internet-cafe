const { contextBridge, ipcRenderer } = require('electron');

// Preload for kiosk-resize-grip.html — the 18 × 18 px corner resize handle.
// Same isolation/sandbox pattern as the other kiosk preloads.
contextBridge.exposeInMainWorld('kioskResize', {
  // Sent on pointerdown with the in-grip press coordinates so the main process
  // can compute the fixed cursor-to-corner distance.
  startResize: (offset) => ipcRenderer.send('panel-resize-start', offset),

  // Sent on each rAF tick while dragging; no payload — main process reads the
  // live cursor position itself via screen.getCursorScreenPoint().
  moveResize: () => ipcRenderer.send('panel-resize-move'),

  // Sent on pointerup / pointercancel / lostpointercapture.
  endResize: () => ipcRenderer.send('panel-resize-end'),
});
