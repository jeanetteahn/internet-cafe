const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kioskCarbon', {
  onSvg:     (fn) => { ipcRenderer.on('carbon-svg',   (_e, svg)           => fn(svg)); },
  onState:   (fn) => { ipcRenderer.on('carbon-state', (_e, state)         => fn(state)); },
  dragStart: ()   => { ipcRenderer.send('carbon-drag-start'); },
  dragMove:  ()   => { ipcRenderer.send('carbon-drag-move'); },
  dragEnd:   ()   => { ipcRenderer.send('carbon-drag-end'); },
  dragReset: ()   => { ipcRenderer.send('carbon-drag-reset'); },
});
