const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('kioskShield', {
  move: () => ipcRenderer.send('shield-move-tick'),
  up:   () => ipcRenderer.send('shield-done'),
});
