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

// ---- Cookie consent auto-acceptance -----------------------------------------
// Runs in EVERY frame (nodeIntegrationInSubFrames is true), so consent popups
// inside iframes (Sourcepoint, TrustArc, Google/YouTube) are handled too.
// kiosk-cookie-consent.js decides for itself which iframes look like consent
// dialogs and ignores the rest (ads, videos).  It runs in the page's main world
// so it can call consent-platform APIs and is never blocked by page CSP, and it
// guards against running twice in the same document.
(function () {
  var script = '';
  try { script = ipcRenderer.sendSync('get-cookie-consent-script-sync'); } catch (_) {}
  if (!script) return;
  try { webFrame.executeJavaScript(script).catch(function () {}); } catch (_) {}
  // Forward banner-accepted reports from the main world to the main process.
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (ev.source !== window || !d || d.__kioskConsent !== true) return;
    try {
      ipcRenderer.send('cookie-consent-accepted', {
        how: String(d.how || ''), detail: String(d.detail || ''),
        host: String(d.host || ''), top: !!d.top,
      });
    } catch (_) {}
  });
})();

// ---- Custom overlay scrollbar -----------------------------------------------
// Shadow host must be a div — attachShadow throws NotSupportedError on <html>.
// Main-doc bars always visible when content overflows; inner bars show on hover.
function createOverlayScrollbar() {
  var host = document.createElement('div');
  host.id = '__kiosk_sb';
  // z-index one below the hinge layer (2147483647) so brackets always draw over the scroll track.
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;overflow:visible;';

  var shadow;
  try {
    shadow = host.attachShadow({ mode: 'closed' });
  } catch(e) {
    console.warn('[kiosk-sb] attachShadow failed:', e);
    return;
  }

  // Styles are applied directly via .style (not a <style> element) so they
  // work on pages with a strict Content-Security-Policy (e.g. DDG live SERP).
  function makeBar(barCss, isVertical) {
    var bar   = document.createElement('div');
    var thumb = document.createElement('div');
    bar.style.cssText   = barCss;
    thumb.style.cssText = isVertical
      ? 'position:absolute;left:0;right:0;min-height:40px;background:#ea4b00;border:2px solid #fff;border-radius:6px;'
      : 'position:absolute;top:0;bottom:0;min-width:40px;background:#ea4b00;border:2px solid #fff;border-radius:6px;';
    bar.appendChild(thumb);
    shadow.appendChild(bar);
    return { bar: bar, thumb: thumb };
  }

  var KV = makeBar('position:fixed;right:0;top:0;width:12px;bottom:0;background:#fff;pointer-events:auto;', true);
  var KH = makeBar('position:fixed;bottom:0;left:0;right:0;height:12px;background:#fff;pointer-events:auto;', false);
  var corner = document.createElement('div');
  corner.style.cssText = 'position:fixed;right:0;bottom:0;width:12px;height:12px;background:#fff;pointer-events:none;display:none;';
  shadow.appendChild(corner);
  var IV = makeBar('position:fixed;width:12px;background:#fff;pointer-events:auto;display:none;', true);
  var IH = makeBar('position:fixed;height:12px;background:#fff;pointer-events:auto;display:none;', false);

  function ensureHost() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }
  ensureHost();
  new MutationObserver(ensureHost).observe(document.documentElement, { childList: true });

  // ---- Main doc scrollbars ----
  // Cache for getMainScroller — { el, kind } or null (needs refresh).
  var mainScrollerCache = null;
  function invalidateScrollerCache() { mainScrollerCache = null; }

  // Returns the element whose scroll position drives the main bar.
  // Priority: (1) viewport/window scroll, (2) <body> scroll, (3) largest
  // viewport-covering element with overflow:auto/scroll.  Result is cached
  // and only re-scanned after a resize, ResizeObserver callback, or when
  // the cached element is disconnected.
  function getMainScroller() {
    if (mainScrollerCache && mainScrollerCache.el.isConnected) return mainScrollerCache.el;
    mainScrollerCache = null;

    var se = document.scrollingElement || document.documentElement;

    // 1. Viewport scrolls normally.
    if (se.scrollHeight > window.innerHeight + 1) {
      mainScrollerCache = { el: se, kind: 'window' };
      return se;
    }

    // 2. <body> scrolls (html is overflow:hidden, body has overflow:auto/scroll).
    var body = document.body;
    if (body) {
      var bcs = window.getComputedStyle(body);
      if (/auto|scroll/.test(bcs.overflowY + ' ' + bcs.overflow) &&
          body.scrollHeight > body.clientHeight + 1) {
        mainScrollerCache = { el: body, kind: 'body' };
        return body;
      }
    }

    // 3. Largest viewport-covering element (≥80% of both dimensions).
    // Handles wide-layout pages (e.g. DDG at ≥1000 px) where a wrapper div
    // scrolls instead of the window or body.
    var minW = window.innerWidth  * 0.8;
    var minH = window.innerHeight * 0.8;
    var best = null, bestArea = 0;
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el === host) continue;
      var cs = window.getComputedStyle(el);
      if (!/auto|scroll/.test(cs.overflowY + ' ' + cs.overflow)) continue;
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      var r = el.getBoundingClientRect();
      if (r.width < minW || r.height < minH) continue;
      var area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = el; }
    }
    if (best) {
      mainScrollerCache = { el: best, kind: 'element' };
      if (ro) ro.observe(best);  // watch for future size changes
      return best;
    }

    // Nothing overflows — page is shorter than the viewport.
    mainScrollerCache = { el: se, kind: 'none' };
    return se;
  }

  function updateMain() {
    var sc = getMainScroller();
    if (!sc) return;
    var se = document.scrollingElement || document.documentElement;
    var isEl = sc !== se;  // element scroller: use el.scrollTop/clientHeight
    var scrollH = sc.scrollHeight, scrollW = sc.scrollWidth;
    var rect = isEl ? sc.getBoundingClientRect() : null;
    var viewH = isEl ? sc.clientHeight : window.innerHeight;
    var viewW = isEl ? sc.clientWidth  : window.innerWidth;
    var scrollY = isEl ? sc.scrollTop  : window.scrollY;
    var scrollX = isEl ? sc.scrollLeft : window.scrollX;
    var hasV = scrollH > viewH + 1;
    var hasH = scrollW > viewW + 1;

    if (hasV) {
      var trackH = viewH - (hasH ? 12 : 0);
      var thumbH = Math.max(40, (viewH / scrollH) * trackH);
      var maxST = scrollH - viewH;
      var thumbT = maxST > 0 ? (scrollY / maxST) * (trackH - thumbH) : 0;
      // Position bar at the element's right edge, or at the viewport right edge.
      KV.bar.style.right  = isEl ? (window.innerWidth  - rect.right)  + 'px' : '0';
      KV.bar.style.top    = isEl ? rect.top    + 'px' : '0';
      KV.bar.style.bottom = isEl ? (window.innerHeight - rect.bottom) + 'px' : '0';
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
      var thumbL = maxSL > 0 ? (scrollX / maxSL) * (trackW - thumbW) : 0;
      KH.bar.style.bottom = isEl ? (window.innerHeight - rect.bottom) + 'px' : '0';
      KH.bar.style.left   = isEl ? rect.left   + 'px' : '0';
      KH.bar.style.right  = isEl ? (window.innerWidth  - rect.right)  + 'px' : '0';
      KH.bar.style.display = 'block';
      KH.thumb.style.width = thumbW + 'px';
      KH.thumb.style.left = Math.round(thumbL) + 'px';
    } else {
      KH.bar.style.display = 'none';
    }

    corner.style.right  = isEl ? (window.innerWidth  - rect.right)  + 'px' : '0';
    corner.style.bottom = isEl ? (window.innerHeight - rect.bottom) + 'px' : '0';
    corner.style.display = (hasV && hasH) ? 'block' : 'none';
  }

  // ---- KV drag ----
  var kvActive = false, kvStartY = 0, kvStartST = 0;
  KV.thumb.addEventListener('pointerdown', function(e) {
    e.preventDefault(); e.stopPropagation();
    KV.thumb.setPointerCapture(e.pointerId);
    var sc0 = getMainScroller();
    kvActive = true; kvStartY = e.clientY;
    kvStartST = sc0 !== (document.scrollingElement || document.documentElement) ? sc0.scrollTop : window.scrollY;
  });
  KV.thumb.addEventListener('pointermove', function(e) {
    if (!kvActive) return;
    var sc = getMainScroller();
    var isEl = sc !== (document.scrollingElement || document.documentElement);
    var viewH = isEl ? sc.clientHeight : window.innerHeight;
    var viewW = isEl ? sc.clientWidth  : window.innerWidth;
    var hasH = sc.scrollWidth > viewW + 1;
    var trackH = viewH - (hasH ? 12 : 0);
    var thumbH = Math.max(40, (viewH / sc.scrollHeight) * trackH);
    var ratio = (sc.scrollHeight - viewH) / Math.max(1, trackH - thumbH);
    var newY = kvStartST + (e.clientY - kvStartY) * ratio;
    if (isEl) sc.scrollTop = newY; else window.scrollTo(window.scrollX, newY);
    updateMain();
  });
  KV.thumb.addEventListener('pointerup',     function() { kvActive = false; });
  KV.thumb.addEventListener('pointercancel', function() { kvActive = false; });
  KV.thumb.addEventListener('click',         function(e) { e.stopPropagation(); });
  KV.bar.addEventListener('click', function(e) {
    if (e.composedPath()[0] === KV.thumb) return;
    var sc = getMainScroller();
    var isEl = sc !== (document.scrollingElement || document.documentElement);
    var viewH = isEl ? sc.clientHeight : window.innerHeight;
    var rect = KV.bar.getBoundingClientRect();
    var newY = ((e.clientY - rect.top) / rect.height) * (sc.scrollHeight - viewH);
    if (isEl) sc.scrollTop = newY; else window.scrollTo(window.scrollX, newY);
    updateMain();
  });

  // ---- KH drag ----
  var khActive = false, khStartX = 0, khStartSL = 0;
  KH.thumb.addEventListener('pointerdown', function(e) {
    e.preventDefault(); e.stopPropagation();
    KH.thumb.setPointerCapture(e.pointerId);
    var sc0 = getMainScroller();
    khActive = true; khStartX = e.clientX;
    khStartSL = sc0 !== (document.scrollingElement || document.documentElement) ? sc0.scrollLeft : window.scrollX;
  });
  KH.thumb.addEventListener('pointermove', function(e) {
    if (!khActive) return;
    var sc = getMainScroller();
    var isEl = sc !== (document.scrollingElement || document.documentElement);
    var viewH = isEl ? sc.clientHeight : window.innerHeight;
    var viewW = isEl ? sc.clientWidth  : window.innerWidth;
    var hasV = sc.scrollHeight > viewH + 1;
    var trackW = viewW - (hasV ? 12 : 0);
    var thumbW = Math.max(40, (viewW / sc.scrollWidth) * trackW);
    var ratio = (sc.scrollWidth - viewW) / Math.max(1, trackW - thumbW);
    var newX = khStartSL + (e.clientX - khStartX) * ratio;
    if (isEl) sc.scrollLeft = newX; else window.scrollTo(newX, window.scrollY);
    updateMain();
  });
  KH.thumb.addEventListener('pointerup',     function() { khActive = false; });
  KH.thumb.addEventListener('pointercancel', function() { khActive = false; });
  KH.thumb.addEventListener('click',         function(e) { e.stopPropagation(); });
  KH.bar.addEventListener('click', function(e) {
    if (e.composedPath()[0] === KH.thumb) return;
    var sc = getMainScroller();
    var isEl = sc !== (document.scrollingElement || document.documentElement);
    var viewW = isEl ? sc.clientWidth : window.innerWidth;
    var rect = KH.bar.getBoundingClientRect();
    var newX = ((e.clientX - rect.left) / rect.width) * (sc.scrollWidth - viewW);
    if (isEl) sc.scrollLeft = newX; else window.scrollTo(newX, window.scrollY);
    updateMain();
  });

  // ---- Inner scroll containers ----
  var innerEl = null, innerHideTimer = null;

  function findScrollable(el) {
    var mainSc = getMainScroller();
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el === mainSc) return null;
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

  // Capture on document catches both viewport scroll (window.scrollY) and
  // body-only scroll (body.scrollTop), since scroll doesn't bubble but does
  // reach document in capture phase.  Coalesce to one update per frame.
  var mainRaf = 0;
  document.addEventListener('scroll', function() {
    if (mainRaf) return;
    mainRaf = requestAnimationFrame(function() { mainRaf = 0; updateMain(); });
  }, { capture: true, passive: true });
  window.addEventListener('resize', function() {
    invalidateScrollerCache();
    updateMain(); if (innerEl) updateInner();
  }, { passive: true });
  window.addEventListener('load', updateMain, { passive: true });

  // Re-check when content grows after load (lazy images, JS-rendered sections).
  // Also invalidates the scroller cache so getMainScroller() re-scans if needed.
  var resizeRaf = 0;
  var ro = new ResizeObserver(function() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(function() {
      resizeRaf = 0;
      invalidateScrollerCache();
      updateMain();
    });
  });
  ro.observe(document.documentElement);
  if (document.body) ro.observe(document.body);

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
  // z-index at the absolute max so brackets always draw over the scroll bar host (2147483646).
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

  // Synchronous fetch — render into the shadow immediately so the layer is
  // visible as soon as the host is appended, without an async round-trip.
  var syncCfg = null;
  try { syncCfg = ipcRenderer.sendSync('get-panel-hinges-sync'); } catch (_) {}
  if (syncCfg) render(syncCfg);

  // Track the per-documentElement observer so it can be reconnected if the
  // documentElement is replaced (e.g. document.open()).
  var elementObserver = new MutationObserver(ensureHost);
  function attachElementObserver() {
    if (document.documentElement) elementObserver.observe(document.documentElement, { childList: true });
  }

  // Watch document.childList: handles documentElement not yet existing and
  // handles documentElement replacement.
  new MutationObserver(function () {
    ensureHost();
    elementObserver.disconnect();
    attachElementObserver();
  }).observe(document, { childList: true });

  if (document.documentElement) {
    ensureHost();
    attachElementObserver();
  }

  // Async fallback when the sync call returned null (no config stored yet).
  if (!syncCfg) {
    ipcRenderer.invoke('get-panel-hinges').then(render).catch(function () {});
  }

  // Live updates: resize tweaks and navigation backstop pushes from main process.
  ipcRenderer.on('panel-hinges', function (_e, cfg) { render(cfg); });
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
