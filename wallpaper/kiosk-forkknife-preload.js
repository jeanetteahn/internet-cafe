const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kioskForkKnife', {
  onNavState: (fn) => {
    ipcRenderer.on('forkknife-nav-state', (_event, state) => fn(state));
  },
  goBack: () => {
    ipcRenderer.send('forkknife-back');
  },
  goForward: () => {
    ipcRenderer.send('forkknife-forward');
  },
  dragStart: () => { ipcRenderer.send('forkknife-drag-start'); },
  dragMove:  () => { ipcRenderer.send('forkknife-drag-move'); },
  dragEnd:   () => { ipcRenderer.send('forkknife-drag-end'); },
  dragReset: () => { ipcRenderer.send('forkknife-drag-reset'); },
});
