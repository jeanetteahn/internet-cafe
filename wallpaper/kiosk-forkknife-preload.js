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
});
