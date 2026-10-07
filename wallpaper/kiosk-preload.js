const { ipcRenderer, webFrame } = require('electron');

// Inject scrollbar CSS at the user-agent cascade origin so it beats any site
// CSS (including the site's own !important rules).  The author-origin fallback
// covers Chromium builds that ignore ::-webkit-scrollbar in user sheets.
// Both calls are repeated at DOMContentLoaded so they survive any early-load
// style reset the page might apply.
const KIOSK_SCROLLBAR_CSS =
  '*:not(#__kiosk){scrollbar-color:auto!important;scrollbar-width:auto!important}' +
  '*:not(#__kiosk)::-webkit-scrollbar{width:12px!important;height:12px!important;background:#ffffff!important;display:block!important}' +
  '*:not(#__kiosk)::-webkit-scrollbar-track{background:#ffffff!important}' +
  '*:not(#__kiosk)::-webkit-scrollbar-thumb{background:#ea4b00!important;border-radius:6px!important;border:2px solid #ffffff!important;min-height:40px!important}' +
  '*:not(#__kiosk)::-webkit-scrollbar-thumb:hover{background:#ea4b00!important}' +
  '*:not(#__kiosk)::-webkit-scrollbar-corner{background:#ffffff!important}';

function injectScrollbarCss() {
  try { webFrame.insertCSS(KIOSK_SCROLLBAR_CSS, { cssOrigin: 'user' }); } catch (e) {}
  try { webFrame.insertCSS(KIOSK_SCROLLBAR_CSS); } catch (e) {}
}
injectScrollbarCss();
window.addEventListener('DOMContentLoaded', injectScrollbarCss, { once: true });

// Attached to every kiosk panel (see kiosk-browsers.js), regardless of what
// page is loaded into it.  Real mouse/keyboard activity tells the main process
// "a person is using this panel right now," pausing its auto-browsing loop.
//
// event.isTrusted is false for events dispatched programmatically (e.g. via
// executeJavaScript from the main process), so those never look like customer
// activity.  This prevents the auto-scroll and link-prefetch logic from
// accidentally stopping itself.
// Send the event type so the main process can distinguish deliberate input
// (mousedown, click, keydown — triggers panel enlargement) from incidental
// input (wheel — resets the idle timer but does not enlarge the panel).
['mousedown', 'keydown', 'click', 'wheel'].forEach((evt) => {
  window.addEventListener(evt, (event) => {
    if (!event.isTrusted) return;
    ipcRenderer.send('panel-activity', event.type);
  }, true);
});
