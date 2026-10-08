const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kioskAddressBar', {
  onUrl: (fn) => {
    ipcRenderer.on('addressbar-url', (_event, url) => fn(url));
  },
  navigate:  (url) => { ipcRenderer.send('addressbar-navigate', url); },
  focus:     ()    => { ipcRenderer.send('addressbar-focus'); },
  keydown:   ()    => { ipcRenderer.send('addressbar-keydown'); },
  escape:    ()    => { ipcRenderer.send('addressbar-escape'); },
  dragStart: ()    => { ipcRenderer.send('addressbar-drag-start'); },
  dragMove:  ()    => { ipcRenderer.send('addressbar-drag-move'); },
  dragEnd:   ()    => { ipcRenderer.send('addressbar-drag-end'); },
  dock:      ()    => { ipcRenderer.send('addressbar-dock'); },
});
