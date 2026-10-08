const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kioskClock', {
  onSvg:      (fn) => { ipcRenderer.on('clock-svg',      (_e, svg) => fn(svg)); },
  onTimezone: (fn) => { ipcRenderer.on('clock-timezone', (_e, tz)  => fn(tz)); },
  dragStart:  ()   => { ipcRenderer.send('clock-drag-start'); },
  dragMove:   ()   => { ipcRenderer.send('clock-drag-move'); },
  dragEnd:    ()   => { ipcRenderer.send('clock-drag-end'); },
  dragReset:  ()   => { ipcRenderer.send('clock-drag-reset'); },
});
