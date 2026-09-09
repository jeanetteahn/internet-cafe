const { ipcRenderer } = require('electron');

// Attached to every kiosk panel (see kiosk-browsers.js), regardless of what
// page is loaded into it — a real DuckDuckGo search page, or wherever a
// customer has since navigated to. Any real mouse/keyboard activity here
// tells the main process "a person is using this panel right now," which
// is what pauses its auto-search rotation until they're done.
['mousedown', 'keydown', 'click', 'wheel'].forEach((evt) => {
  window.addEventListener(evt, () => ipcRenderer.send('panel-activity'), true);
});
