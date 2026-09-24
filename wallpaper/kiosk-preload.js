const { ipcRenderer } = require('electron');

// Attached to every kiosk panel (see kiosk-browsers.js), regardless of what
// page is loaded into it.  Real mouse/keyboard activity tells the main process
// "a person is using this panel right now," pausing its auto-browsing loop.
//
// event.isTrusted is false for events dispatched programmatically (e.g. via
// executeJavaScript from the main process), so those never look like customer
// activity.  This prevents the auto-scroll and link-prefetch logic from
// accidentally stopping itself.
['mousedown', 'keydown', 'click', 'wheel'].forEach((evt) => {
  window.addEventListener(evt, (event) => {
    if (!event.isTrusted) return;
    ipcRenderer.send('panel-activity');
  }, true);
});
