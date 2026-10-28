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
// Shadow host must be a div — attachShadow throws NotSupportedError on <html>.
// Main-doc bars always visible when content overflows; inner bars show on hover.
function createOverlayScrollbar() {
  var host = document.createElement('div');
  host.id = '__kiosk_sb';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:visible;';

  var shadow;
  try {
    shadow = host.attachShadow({ mode: 'closed' });
  } catch(e) {
    console.warn('[kiosk-sb] attachShadow failed:', e);
    return;
  }

  var sty = document.createElement('style');
  sty.textContent =
    '.kv{position:fixed;right:0;top:0;width:12px;bottom:0;background:#fff;pointer-events:auto;}' +
    '.kh{position:fixed;bottom:0;left:0;right:0;height:12px;background:#fff;pointer-events:auto;}' +
    '.kc{position:fixed;right:0;bottom:0;width:12px;height:12px;background:#fff;pointer-events:none;}' +
    '.iv{position:fixed;width:12px;background:#fff;pointer-events:auto;}' +
    '.ih{position:fixed;height:12px;background:#fff;pointer-events:auto;}' +
    '.kv .t,.iv .t{position:absolute;left:0;right:0;min-height:40px;' +
      'background:#ea4b00;border:2px solid #fff;border-radius:6px;}' +
    '.kh .t,.ih .t{position:absolute;top:0;bottom:0;min-width:40px;' +
      'background:#ea4b00;border:2px solid #fff;border-radius:6px;}';
  shadow.appendChild(sty);

  function makeBar(cls) {
    var bar = document.createElement('div'); bar.className = cls;
    var thumb = document.createElement('div'); thumb.className = 't';
    bar.appendChild(thumb);
    shadow.appendChild(bar);
    return { bar: bar, thumb: thumb };
  }

  var KV = makeBar('kv');
  var KH = makeBar('kh');
  var corner = document.createElement('div'); corner.className = 'kc'; shadow.appendChild(corner);
  var IV = makeBar('iv');
  var IH = makeBar('ih');
  IV.bar.style.display = 'none';
  IH.bar.style.display = 'none';
  corner.style.display = 'none';

  function ensureHost() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }
  ensureHost();
  new MutationObserver(ensureHost).observe(document.documentElement, { childList: true });

  // ---- Main doc scrollbars ----
  function updateMain() {
    var sc = document.scrollingElement || document.documentElement;
    if (!sc) return;
    var scrollH = sc.scrollHeight, scrollW = sc.scrollWidth;
    var viewH = window.innerHeight, viewW = window.innerWidth;
    var hasV = scrollH > viewH + 1;
    var hasH = scrollW > viewW + 1;

    if (hasV) {
      var trackH = viewH - (hasH ? 12 : 0);
      var thumbH = Math.max(40, (viewH / scrollH) * trackH);
      var maxST = scrollH - viewH;
      var thumbT = maxST > 0 ? (window.scrollY / maxST) * (trackH - thumbH) : 0;
      KV.bar.style.display = 'block';
      KV.thumb.style.height = thumbH + 'px';
      KV.thumb.style.top = Math.round(thumbT) + 'px';
    } else {
      KV.bar.style.display = 'none';
    }

    if (hasH) {
      var trackW = viewW - (hasV ? 12 : 0);
      var thumbW = Math.max(40, (viewW / scrollW) * trackW);
      var maxSL = scrollW - viewW;
      var thumbL = maxSL > 0 ? (window.scrollX / maxSL) * (trackW - thumbW) : 0;
      KH.bar.style.display = 'block';
      KH.thumb.style.width = thumbW + 'px';
      KH.thumb.style.left = Math.round(thumbL) + 'px';
    } else {
      KH.bar.style.display = 'none';
    }

    corner.style.display = (hasV && hasH) ? 'block' : 'none';
  }

  // ---- KV drag ----
  var kvActive = false, kvStartY = 0, kvStartST = 0;
  KV.thumb.addEventListener('pointerdown', function(e) {
    e.preventDefault(); e.stopPropagation();
    KV.thumb.setPointerCapture(e.pointerId);
    kvActive = true; kvStartY = e.clientY; kvStartST = window.scrollY;
  });
  KV.thumb.addEventListener('pointermove', function(e) {
    if (!kvActive) return;
    var sc = document.scrollingElement || document.documentElement;
    var hasH = sc.scrollWidth > window.innerWidth + 1;
    var trackH = window.innerHeight - (hasH ? 12 : 0);
    var thumbH = Math.max(40, (window.innerHeight / sc.scrollHeight) * trackH);
    var ratio = (sc.scrollHeight - window.innerHeight) / Math.max(1, trackH - thumbH);
    window.scrollTo(window.scrollX, kvStartST + (e.clientY - kvStartY) * ratio);
    updateMain();
  });
  KV.thumb.addEventListener('pointerup',     function() { kvActive = false; });
  KV.thumb.addEventListener('pointercancel', function() { kvActive = false; });
  KV.thumb.addEventListener('click',         function(e) { e.stopPropagation(); });
  KV.bar.addEventListener('click', function(e) {
    if (e.composedPath()[0] === KV.thumb) return;
    var sc = document.scrollingElement || document.documentElement;
    var rect = KV.bar.getBoundingClientRect();
    window.scrollTo(window.scrollX,
      ((e.clientY - rect.top) / rect.height) * (sc.scrollHeight - window.innerHeight));
    updateMain();
  });

  // ---- KH drag ----
  var khActive = false, khStartX = 0, khStartSL = 0;
  KH.thumb.addEventListener('pointerdown', function(e) {
    e.preventDefault(); e.stopPropagation();
    KH.thumb.setPointerCapture(e.pointerId);
    khActive = true; khStartX = e.clientX; khStartSL = window.scrollX;
  });
  KH.thumb.addEventListener('pointermove', function(e) {
    if (!khActive) return;
    var sc = document.scrollingElement || document.documentElement;
    var hasV = sc.scrollHeight > window.innerHeight + 1;
    var trackW = window.innerWidth - (hasV ? 12 : 0);
    var thumbW = Math.max(40, (window.innerWidth / sc.scrollWidth) * trackW);
    var ratio = (sc.scrollWidth - window.innerWidth) / Math.max(1, trackW - thumbW);
    window.scrollTo(khStartSL + (e.clientX - khStartX) * ratio, window.scrollY);
    updateMain();
  });
  KH.thumb.addEventListener('pointerup',     function() { khActive = false; });
  KH.thumb.addEventListener('pointercancel', function() { khActive = false; });
  KH.thumb.addEventListener('click',         function(e) { e.stopPropagation(); });
  KH.bar.addEventListener('click', function(e) {
    if (e.composedPath()[0] === KH.thumb) return;
    var sc = document.scrollingElement || document.documentElement;
    var rect = KH.bar.getBoundingClientRect();
    window.scrollTo(
      ((e.clientX - rect.left) / rect.width) * (sc.scrollWidth - window.innerWidth),
      window.scrollY);
    updateMain();
  });

  // ---- Inner scroll containers ----
  var innerEl = null, innerHideTimer = null;

  function findScrollable(el) {
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      var cs = window.getComputedStyle(el);
      if (/auto|scroll/.test(cs.overflow + ' ' + cs.overflowY + ' ' + cs.overflowX)) {
        if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function updateInner() {
    if (!innerEl || !innerEl.isConnected) {
      IV.bar.style.display = 'none'; IH.bar.style.display = 'none'; return;
    }
    var rect = innerEl.getBoundingClientRect();
    var scrollH = innerEl.scrollHeight, scrollW = innerEl.scrollWidth;
    var ch = innerEl.clientHeight, cw = innerEl.clientWidth;
    var hasV = scrollH > ch + 1;
    var hasH = scrollW > cw + 1;

    if (hasV) {
      var barH = ch - (hasH ? 12 : 0);
      var thumbH = Math.max(40, (ch / scrollH) * barH);
      var maxST = scrollH - ch;
      var thumbT = maxST > 0 ? (innerEl.scrollTop / maxST) * (barH - thumbH) : 0;
      IV.bar.style.top     = rect.top + 'px';
      IV.bar.style.height  = barH + 'px';
      IV.bar.style.left    = (rect.right - 12) + 'px';
      IV.bar.style.display = 'block';
      IV.thumb.style.height = thumbH + 'px';
      IV.thumb.style.top    = Math.round(thumbT) + 'px';
    } else {
      IV.bar.style.display = 'none';
    }

    if (hasH) {
      var barW = cw - (hasV ? 12 : 0);
      var thumbW = Math.max(40, (cw / scrollW) * barW);
      var maxSL = scrollW - cw;
      var thumbL = maxSL > 0 ? (innerEl.scrollLeft / maxSL) * (barW - thumbW) : 0;
      IH.bar.style.left    = rect.left + 'px';
      IH.bar.style.width   = barW + 'px';
      IH.bar.style.top     = (rect.bottom - 12) + 'px';
      IH.bar.style.display = 'block';
      IH.thumb.style.width = thumbW + 'px';
      IH.thumb.style.left  = Math.round(thumbL) + 'px';
    } else {
      IH.bar.style.display = 'none';
    }
  }

  function activateInnerEl(el) {
    if (el._kioskSbBound) return;
    el._kioskSbBound = true;
    el.addEventListener('scroll', function() {
      if (innerEl === el) updateInner();
    }, { passive: true });
  }

  function showInner(el) {
    clearTimeout(innerHideTimer);
    innerEl = el;
    updateInner();
    innerHideTimer = setTimeout(function() {
      innerEl = null;
      IV.bar.style.display = 'none';
      IH.bar.style.display = 'none';
    }, 1500);
  }

  // ---- IV drag ----
  var ivActive = false, ivStartY = 0, ivStartST = 0;
  IV.thumb.addEventListener('pointerdown', function(e) {
    e.preventDefault(); e.stopPropagation();
    IV.thumb.setPointerCapture(e.pointerId);
    ivActive = true; ivStartY = e.clientY; ivStartST = innerEl ? innerEl.scrollTop : 0;
  });
  IV.thumb.addEventListener('pointermove', function(e) {
    if (!ivActive || !innerEl) return;
    var ch = innerEl.clientHeight;
    var hasH = innerEl.scrollWidth > innerEl.clientWidth + 1;
    var barH = ch - (hasH ? 12 : 0);
    var thumbH = Math.max(40, (ch / innerEl.scrollHeight) * barH);
    var ratio = (innerEl.scrollHeight - ch) / Math.max(1, barH - thumbH);
    innerEl.scrollTop = ivStartST + (e.clientY - ivStartY) * ratio;
    updateInner();
  });
  IV.thumb.addEventListener('pointerup',     function() { ivActive = false; });
  IV.thumb.addEventListener('pointercancel', function() { ivActive = false; });
  IV.thumb.addEventListener('click',         function(e) { e.stopPropagation(); });
  IV.bar.addEventListener('click', function(e) {
    if (!innerEl || e.composedPath()[0] === IV.thumb) return;
    var rect = IV.bar.getBoundingClientRect();
    innerEl.scrollTop =
      ((e.clientY - rect.top) / rect.height) * (innerEl.scrollHeight - innerEl.clientHeight);
    updateInner();
  });

  // ---- IH drag ----
  var ihActive = false, ihStartX = 0, ihStartSL = 0;
  IH.thumb.addEventListener('pointerdown', function(e) {
    e.preventDefault(); e.stopPropagation();
    IH.thumb.setPointerCapture(e.pointerId);
    ihActive = true; ihStartX = e.clientX; ihStartSL = innerEl ? innerEl.scrollLeft : 0;
  });
  IH.thumb.addEventListener('pointermove', function(e) {
    if (!ihActive || !innerEl) return;
    var cw = innerEl.clientWidth;
    var hasV = innerEl.scrollHeight > innerEl.clientHeight + 1;
    var barW = cw - (hasV ? 12 : 0);
    var thumbW = Math.max(40, (cw / innerEl.scrollWidth) * barW);
    var ratio = (innerEl.scrollWidth - cw) / Math.max(1, barW - thumbW);
    innerEl.scrollLeft = ihStartSL + (e.clientX - ihStartX) * ratio;
    updateInner();
  });
  IH.thumb.addEventListener('pointerup',     function() { ihActive = false; });
  IH.thumb.addEventListener('pointercancel', function() { ihActive = false; });
  IH.thumb.addEventListener('click',         function(e) { e.stopPropagation(); });
  IH.bar.addEventListener('click', function(e) {
    if (!innerEl || e.composedPath()[0] === IH.thumb) return;
    var rect = IH.bar.getBoundingClientRect();
    innerEl.scrollLeft =
      ((e.clientX - rect.left) / rect.width) * (innerEl.scrollWidth - innerEl.clientWidth);
    updateInner();
  });

  // ---- Detect inner scrollable on pointer hover / wheel ----
  var pmThrottle = false;
  window.addEventListener('pointermove', function(e) {
    if (pmThrottle || !e.target || e.target === host) return;
    pmThrottle = true;
    setTimeout(function() { pmThrottle = false; }, 50);
    var el = findScrollable(e.target);
    if (el) { activateInnerEl(el); showInner(el); }
  }, { passive: true, capture: true });

  window.addEventListener('wheel', function(e) {
    if (!e.target || e.target === host) return;
    var el = findScrollable(e.target);
    if (el) { activateInnerEl(el); showInner(el); }
  }, { passive: true, capture: true });

  // Scroll fires every frame during auto-scroll and wheel scrolling; reading
  // scrollHeight each time forces layout, so coalesce to one update per frame.
  var mainRaf = 0;
  window.addEventListener('scroll', function() {
    if (mainRaf) return;
    mainRaf = requestAnimationFrame(function() { mainRaf = 0; updateMain(); });
  }, { passive: true });
  window.addEventListener('resize', function() { updateMain(); if (innerEl) updateInner(); }, { passive: true });
  window.addEventListener('load',   updateMain,                                                { passive: true });

  updateMain();
}

window.addEventListener('DOMContentLoaded', createOverlayScrollbar, { once: true });

// ---- Hinge overlap layer ----------------------------------------------------
// The orange hinges are drawn by kiosk-handle.html, which sits UNDER this
// BrowserView, so any part reaching past the border is hidden by the page.
// This layer redraws the same hinges (same placements, shifted into page
// coordinates) on top of the page; the page viewport clips everything
// outside it, so the two layers join seamlessly.  pointer-events:none keeps
// the page fully clickable underneath.
function createHingeLayer() {
  if (window.top !== window) return; // main frame only

  var host = document.createElement('div');
  host.id = '__kiosk_hinges';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;';
  var shadow;
  try { shadow = host.attachShadow({ mode: 'closed' }); } catch (e) { return; }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var pieces = [];

  // The handle page's 1 px orange border sits exactly on the page's left,
  // right and bottom edges, so the page hides it there — redraw those lines.
  var edges = ['left:0;top:0;bottom:0;width:1px', 'right:0;top:0;bottom:0;width:1px',
               'left:0;right:0;bottom:0;height:1px'].map(function (pos) {
    var line = document.createElement('div');
    line.style.cssText = 'position:absolute;display:none;' + pos;
    shadow.appendChild(line);
    return line;
  });

  function render(cfg) {
    if (!cfg) return;
    edges.forEach(function (line) {
      line.style.display = 'block';
      line.style.background = cfg.borderColor;
    });
    var list = cfg.hinges || [];
    if (pieces.length !== list.length) {
      pieces.forEach(function (p) { p.remove(); });
      pieces = list.map(function (h) {
        var el  = document.createElement('div');
        var svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', h.viewBox);
        svg.style.cssText = 'display:block;width:100%;height:100%;overflow:visible;';
        h.shapes.forEach(function (s) {
          var shape = document.createElementNS(SVG_NS, s.tag);
          Object.keys(s.attrs).forEach(function (k) { shape.setAttribute(k, s.attrs[k]); });
          svg.appendChild(shape);
        });
        el.appendChild(svg);
        shadow.appendChild(el);
        return el;
      });
    }
    list.forEach(function (h, i) {
      pieces[i].style.cssText =
        'position:absolute;margin:0;padding:0;' +
        'left:'   + (h.left - cfg.offsetX) + 'px;' +
        'top:'    + (h.top  - cfg.offsetY) + 'px;' +
        'width:'  + h.w + 'px;height:' + h.h + 'px;' +
        'transform:' + (h.transform || 'none') + ';';
    });
  }

  function ensureHost() {
    if (document.documentElement && !host.isConnected) document.documentElement.appendChild(host);
  }

  function mount() {
    ensureHost();
    new MutationObserver(ensureHost).observe(document.documentElement, { childList: true });
    ipcRenderer.invoke('get-panel-hinges').then(render).catch(function () {});
    ipcRenderer.on('panel-hinges', function (_e, cfg) { render(cfg); });
  }

  // Mount as early as possible so the overlap doesn't flicker on navigation.
  if (document.documentElement) mount();
  else window.addEventListener('DOMContentLoaded', mount, { once: true });
}
createHingeLayer();

// ---- Panel activity IPC ----
// Notifies the main process that a customer is actively using this panel.
// event.isTrusted filters out programmatic events (executeJavaScript auto-scroll
// etc.) so they never accidentally trigger panel-active mode.
// Wheel fires dozens of times per second while scrolling; it only needs to
// reset the idle timer, so send at most one wheel IPC per WHEEL_IPC_MS.
const WHEEL_IPC_MS = 250;
let lastWheelSent = 0;
['mousedown', 'keydown', 'click', 'wheel'].forEach((evt) => {
  window.addEventListener(evt, (event) => {
    if (!event.isTrusted) return;
    if (event.type === 'wheel') {
      const now = Date.now();
      if (now - lastWheelSent < WHEEL_IPC_MS) return;
      lastWheelSent = now;
    }
    ipcRenderer.send('panel-activity', event.type);
  }, { capture: true, passive: true });
});
