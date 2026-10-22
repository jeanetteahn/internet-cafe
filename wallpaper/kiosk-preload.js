const { ipcRenderer, webFrame } = require('electron');

// Suppress native HTML5 drag so X11 never hands cursor control to the system
// drag layer during a mousedown+move in the panels.
window.addEventListener('dragstart', (event) => { event.preventDefault(); }, true);

// Remove the browser's built-in draggable-element cursor hint at user origin
// so it beats any site stylesheet including !important.
try { webFrame.insertCSS('*{-webkit-user-drag:none!important}', { cssOrigin: 'user' }); } catch (_) {}

// Hide all native scrollbars — the custom overlay scrollbar (below) replaces
// them so the system cursor never appears over a scrollbar thumb.
// cssOrigin:'user' beats any page !important; the author-origin fallback covers
// Chromium builds that ignore ::-webkit-scrollbar in user sheets.
const KIOSK_HIDE_SCROLLBAR_CSS =
  '*::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}' +
  '*{scrollbar-width:none!important}';

function injectScrollbarCss() {
  try { webFrame.insertCSS(KIOSK_HIDE_SCROLLBAR_CSS, { cssOrigin: 'user' }); } catch (e) {}
  try { webFrame.insertCSS(KIOSK_HIDE_SCROLLBAR_CSS); } catch (e) {}
}
injectScrollbarCss();
window.addEventListener('DOMContentLoaded', injectScrollbarCss, { once: true });

// Request the spoon cursor rule from the main process and inject it at user
// origin so it beats any page style, including inline styles applied during
// drags.  Runs in every (sub)frame when nodeIntegrationInSubFrames is true.
ipcRenderer.invoke('get-cursor-css').then(function(css) {
  if (!css) return;
  try { webFrame.insertCSS(css, { cssOrigin: 'user' }); } catch (_) {}
  window.addEventListener('DOMContentLoaded', function() {
    try { webFrame.insertCSS(css, { cssOrigin: 'user' }); } catch (_) {}
  }, { once: true });
}).catch(function() {});

// ---- Custom overlay scrollbar -----------------------------------------------
// Built from plain divs in a closed shadow root on <html>.  Only tracks the
// main-document scroll (window.scrollY / scrollX); does not affect layout
// (position:fixed).  The spoon cursor is inherited from the user-origin CSS
// injected above.  Fade-in on scroll/hover, fade-out after 1.5 s idle.
function createOverlayScrollbar() {
  try {
    var shadow = document.documentElement.attachShadow({ mode: 'closed' });

    var style = document.createElement('style');
    style.textContent =
      '.v,.h{position:fixed;z-index:2147483647;pointer-events:none;' +
        'opacity:0;transition:opacity .25s;}' +
      '.v{right:2px;top:0;width:8px;bottom:0;}' +
      '.h{bottom:2px;left:0;height:8px;right:0;}' +
      '.vt{position:absolute;left:0;right:0;background:rgba(0,0,0,.42);' +
        'border-radius:4px;min-height:24px;}' +
      '.ht{position:absolute;top:0;bottom:0;background:rgba(0,0,0,.42);' +
        'border-radius:4px;min-width:24px;}' +
      '.vt:hover,.ht:hover{background:rgba(0,0,0,.65);}';
    shadow.appendChild(style);

    var vBar   = document.createElement('div'); vBar.className = 'v';
    var vThumb = document.createElement('div'); vThumb.className = 'vt';
    vBar.appendChild(vThumb);
    shadow.appendChild(vBar);

    var hBar   = document.createElement('div'); hBar.className = 'h';
    var hThumb = document.createElement('div'); hThumb.className = 'ht';
    hBar.appendChild(hThumb);
    shadow.appendChild(hBar);

    var hideTimer = null;

    function showBars() {
      clearTimeout(hideTimer);
      vBar.style.opacity = '1';
      vBar.style.pointerEvents = 'auto';
      hBar.style.opacity = '1';
      hBar.style.pointerEvents = 'auto';
      hideTimer = setTimeout(function() {
        vBar.style.opacity = '0';
        vBar.style.pointerEvents = 'none';
        hBar.style.opacity = '0';
        hBar.style.pointerEvents = 'none';
      }, 1500);
    }

    function updateBars() {
      var sc = document.scrollingElement || document.documentElement;
      if (!sc) return;
      var scrollH = sc.scrollHeight;
      var scrollW = sc.scrollWidth;
      var ih = window.innerHeight;
      var iw = window.innerWidth;
      var st = window.scrollY;
      var sl = window.scrollX;

      if (scrollH > ih + 1) {
        var trackH = ih - 4;
        var thumbH = Math.max(24, (ih / scrollH) * trackH);
        var thumbT = (scrollH - ih) > 0 ? (st / (scrollH - ih)) * (trackH - thumbH) : 0;
        vBar.style.display = '';
        vThumb.style.height = thumbH + 'px';
        vThumb.style.top    = Math.round(thumbT) + 'px';
      } else {
        vBar.style.display = 'none';
      }

      if (scrollW > iw + 1) {
        var trackW = iw - 4;
        var thumbW = Math.max(24, (iw / scrollW) * trackW);
        var thumbL = (scrollW - iw) > 0 ? (sl / (scrollW - iw)) * (trackW - thumbW) : 0;
        hBar.style.display = '';
        hThumb.style.width = thumbW + 'px';
        hThumb.style.left  = Math.round(thumbL) + 'px';
      } else {
        hBar.style.display = 'none';
      }
    }

    // ---- Vertical thumb drag ----
    var vActive = false, vStartY = 0, vStartST = 0;
    vThumb.addEventListener('pointerdown', function(e) {
      e.preventDefault(); e.stopPropagation();
      vThumb.setPointerCapture(e.pointerId);
      vActive = true; vStartY = e.clientY; vStartST = window.scrollY;
    });
    vThumb.addEventListener('pointermove', function(e) {
      if (!vActive) return;
      var sc = document.scrollingElement || document.documentElement;
      var trackH = window.innerHeight - 4;
      var thumbH = Math.max(24, (window.innerHeight / sc.scrollHeight) * trackH);
      var ratio  = (sc.scrollHeight - window.innerHeight) / Math.max(1, trackH - thumbH);
      window.scrollTo(window.scrollX, vStartST + (e.clientY - vStartY) * ratio);
      showBars(); updateBars();
    });
    vThumb.addEventListener('pointerup',     function() { vActive = false; });
    vThumb.addEventListener('pointercancel', function() { vActive = false; });
    vThumb.addEventListener('click', function(e) { e.stopPropagation(); });

    // ---- Horizontal thumb drag ----
    var hActive = false, hStartX = 0, hStartSL = 0;
    hThumb.addEventListener('pointerdown', function(e) {
      e.preventDefault(); e.stopPropagation();
      hThumb.setPointerCapture(e.pointerId);
      hActive = true; hStartX = e.clientX; hStartSL = window.scrollX;
    });
    hThumb.addEventListener('pointermove', function(e) {
      if (!hActive) return;
      var sc = document.scrollingElement || document.documentElement;
      var trackW = window.innerWidth - 4;
      var thumbW = Math.max(24, (window.innerWidth / sc.scrollWidth) * trackW);
      var ratio  = (sc.scrollWidth - window.innerWidth) / Math.max(1, trackW - thumbW);
      window.scrollTo(hStartSL + (e.clientX - hStartX) * ratio, window.scrollY);
      showBars(); updateBars();
    });
    hThumb.addEventListener('pointerup',     function() { hActive = false; });
    hThumb.addEventListener('pointercancel', function() { hActive = false; });
    hThumb.addEventListener('click', function(e) { e.stopPropagation(); });

    // ---- Click track scrolls to that position ----
    vBar.addEventListener('click', function(e) {
      if (e.composedPath()[0] === vThumb) return;
      var rect = vBar.getBoundingClientRect();
      var sc   = document.scrollingElement || document.documentElement;
      window.scrollTo(window.scrollX,
        ((e.clientY - rect.top) / rect.height) * (sc.scrollHeight - window.innerHeight));
      showBars(); updateBars();
    });
    hBar.addEventListener('click', function(e) {
      if (e.composedPath()[0] === hThumb) return;
      var rect = hBar.getBoundingClientRect();
      var sc   = document.scrollingElement || document.documentElement;
      window.scrollTo(
        ((e.clientX - rect.left) / rect.width) * (sc.scrollWidth - window.innerWidth),
        window.scrollY);
      showBars(); updateBars();
    });

    window.addEventListener('scroll',    function() { updateBars(); showBars(); }, { passive: true });
    window.addEventListener('resize',    updateBars,  { passive: true });
    window.addEventListener('load',      updateBars,  { passive: true });
    window.addEventListener('mousemove', showBars,    { passive: true });

    updateBars();
  } catch(e) {}
}

window.addEventListener('DOMContentLoaded', createOverlayScrollbar, { once: true });

// ---- Panel activity IPC ----
// Notifies the main process that a customer is actively using this panel.
// event.isTrusted filters out programmatic events (executeJavaScript auto-scroll
// etc.) so they never accidentally trigger panel-active mode.
['mousedown', 'keydown', 'click', 'wheel'].forEach((evt) => {
  window.addEventListener(evt, (event) => {
    if (!event.isTrusted) return;
    ipcRenderer.send('panel-activity', event.type);
  }, true);
});
