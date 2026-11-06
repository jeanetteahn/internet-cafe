// kiosk-cookie-consent.js — auto-accepts cookie / consent banners in kiosk panels.
//
// This file is NOT required by Node.  kiosk-browsers.js reads it as text once
// at startup and hands it to kiosk-preload.js, which runs it in the page's
// MAIN world via webFrame.executeJavaScript in every frame.  Main world is
// needed so it can call consent-platform JS APIs (OneTrust.AllowAll(), etc.)
// and so page CSP never blocks it.  Keep it plain ES5-ish browser JS with no
// require/import.
//
// Strategy, in order:
//   1. Known consent platforms (OneTrust, Cookiebot, Didomi, Quantcast,
//      Sourcepoint, Usercentrics, TrustArc, Google, ...): click their
//      documented "Accept all" button, or call their JS API if the banner is
//      showing but the button isn't reachable.
//   2. Generic fallback: a visible button whose label is an "accept" phrase
//      AND which sits inside something that looks like a cookie banner.
//      Weak labels like "OK" / "Got it" / "Continue" are only clicked inside
//      a clearly cookie-related container, so ordinary page buttons are safe.
//
// Clicks made here are untrusted (event.isTrusted === false), so they never
// flip a panel from auto mode to active mode.
//
// Scanning is bounded: on DOMContentLoaded, load, and debounced DOM
// mutations, for SCAN_WINDOW_MS after the document starts, at most MAX_SCANS
// scans and MAX_CLICKS clicks per document.  Cheap enough for the NucBox.
(function () {
  'use strict';
  if (window.__kioskConsentInstalled) return;
  window.__kioskConsentInstalled = true;

  var SCAN_WINDOW_MS = 30000;  // stop watching this long after the document starts
  var DEBOUNCE_MS    = 400;    // coalesce mutation bursts into one scan
  var MAX_SCANS      = 40;     // hard cap on scans per document
  var MAX_CLICKS     = 4;      // two-layer banners (notice -> confirm) need >1
  var CLICK_COOLDOWN = 1200;   // give the CMP time to close/animate before rescanning

  var isTop = (function () { try { return window.top === window; } catch (e) { return false; } })();
  var startedAt  = Date.now();
  var scans      = 0;
  var clicks     = 0;
  var lastClick  = 0;
  var timer      = null;
  var observer   = null;
  var done       = false;
  var clickedEls = typeof WeakSet === 'function' ? new WeakSet() : null;

  // ---- Reporting -----------------------------------------------------------
  // kiosk-preload.js listens for this message (isolated world) and forwards it
  // to the main process for logging.
  function report(how, detail) {
    try {
      window.postMessage({ __kioskConsent: true, how: how, detail: String(detail || '').slice(0, 80),
                           host: location.hostname, top: isTop }, '*');
    } catch (e) {}
  }

  // ---- Visibility / DOM helpers -------------------------------------------
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var rects = el.getClientRects();
    if (!rects.length) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var cs = window.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) return false;
    if (el.disabled) return false;
    return true;
  }

  // CMPs that use shadow DOM attach their host to <body> or <html>.  Only
  // those top-level hosts are searched (recursively), not every element on
  // the page, to keep scans cheap.
  function shadowRoots() {
    var roots = [];
    function collect(root, depth) {
      if (depth > 4) return;
      var kids = root.children || [];
      for (var i = 0; i < kids.length; i++) {
        var sr = kids[i].shadowRoot;
        if (sr) { roots.push(sr); collect(sr, depth + 1); }
      }
    }
    if (document.documentElement) collect(document.documentElement, 0);
    if (document.body) collect(document.body, 0);
    // One level deeper inside each found shadow root.
    var n = roots.length;
    for (var j = 0; j < n; j++) {
      var all = roots[j].querySelectorAll('*');
      for (var k = 0; k < all.length && k < 3000; k++) {
        if (all[k].shadowRoot) roots.push(all[k].shadowRoot);
      }
    }
    return roots;
  }

  function queryAll(selector, roots) {
    var out = [];
    var scopes = [document].concat(roots || []);
    for (var i = 0; i < scopes.length; i++) {
      var found;
      try { found = scopes[i].querySelectorAll(selector); } catch (e) { continue; }
      for (var j = 0; j < found.length; j++) out.push(found[j]);
    }
    return out;
  }

  function firstVisible(selector, roots) {
    var els = queryAll(selector, roots);
    for (var i = 0; i < els.length; i++) if (isVisible(els[i])) return els[i];
    return null;
  }

  // textContent, not innerText: innerText forces layout, and this runs over
  // thousands of elements per scan on big pages.
  function labelOf(el) {
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) t = el.value || el.getAttribute('aria-label') || el.title || '';
    return String(t).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // An <a> is only safe to click if it doesn't navigate somewhere real.
  function isSafeLink(el) {
    if (el.tagName !== 'A') return true;
    var href = (el.getAttribute('href') || '').trim();
    return href === '' || href.charAt(0) === '#' || /^javascript:/i.test(href);
  }

  function doClick(el, how, detail) {
    if (clickedEls) { if (clickedEls.has(el)) return false; clickedEls.add(el); }
    try {
      el.click();
    } catch (e) {
      try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch (_) { return false; }
    }
    clicks += 1;
    lastClick = Date.now();
    report(how, detail);
    return true;
  }

  // ---- 1. Known consent platforms -----------------------------------------
  // button:   "Accept all" selectors, tried in order.
  // banner:   container that means the banner is showing (for the API fallback).
  // api:      called when the banner is visible but no button was clickable.
  var CMPS = [
    { name: 'onetrust',
      button: '#onetrust-accept-btn-handler, #accept-recommended-btn-handler, .optanon-allow-all',
      banner: '#onetrust-banner-sdk, #onetrust-consent-sdk .ot-sdk-container',
      api: function () { if (window.OneTrust && OneTrust.AllowAll) { OneTrust.AllowAll(); return true; }
                         if (window.Optanon && Optanon.AllowAll) { Optanon.AllowAll(); return true; } } },
    { name: 'cookiebot',
      button: '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, #CybotCookiebotDialogBodyButtonAccept, #CybotCookiebotDialogBodyLevelButtonAccept',
      banner: '#CybotCookiebotDialog',
      api: function () { var c = window.Cookiebot || window.CookieConsent;
                         if (c && c.submitCustomConsent) { c.submitCustomConsent(true, true, true); return true; } } },
    { name: 'didomi',
      button: '#didomi-notice-agree-button, .didomi-continue-without-agreeing ~ button.didomi-button-highlight',
      banner: '#didomi-notice, #didomi-popup',
      api: function () { if (window.Didomi && Didomi.setUserAgreeToAll) { Didomi.setUserAgreeToAll(); return true; } } },
    { name: 'usercentrics',
      button: '[data-testid="uc-accept-all-button"], #uc-btn-accept-banner',
      banner: '#usercentrics-root, #usercentrics-cmp-ui, #uc-banner-modal',
      api: function () { if (window.UC_UI && UC_UI.acceptAllConsents) { UC_UI.acceptAllConsents(); return true; }
                         if (window.__ucCmp && __ucCmp.acceptAllConsents) { __ucCmp.acceptAllConsents(); return true; } } },
    { name: 'quantcast',
      button: '.qc-cmp2-summary-buttons button[mode="primary"], #qc-cmp2-ui button[mode="primary"]',
      banner: '#qc-cmp2-ui, .qc-cmp2-container' },
    { name: 'sourcepoint',   // usually inside a cross-origin iframe; this script runs there too
      button: 'button.sp_choice_type_11, button[title="Accept all" i], button[title="Accept All" i], button[aria-label="Accept all" i]',
      banner: '.message-container, [class*="sp_message"]' },
    { name: 'trustarc',
      button: '#truste-consent-button, .truste-button1, .call[onclick*="acceptAll"]',
      banner: '#truste-consent-track, #consent_blackbar' },
    { name: 'google-fc',     // Google Funding Choices (publisher sites)
      button: 'button.fc-cta-consent, .fc-cta-consent',
      banner: '.fc-consent-root' },
    { name: 'google',        // google.com / youtube.com EU consent dialogs
      button: '#L2AGLb, button[aria-label="Accept all" i], form[action*="consent.google"] button[aria-label*="Accept" i], ytd-consent-bump-v2-lightbox button[aria-label*="Accept" i], tp-yt-paper-dialog button[aria-label*="Accept" i]' },
    { name: 'osano',
      button: '.osano-cm-accept-all, .osano-cm-accept, .cc-btn.cc-allow, .cc-btn.cc-dismiss',
      banner: '.osano-cm-dialog, .cc-window' },
    { name: 'cookieyes',     button: '.cky-btn-accept, #cookie_action_close_header, #wt-cli-accept-all-btn' },
    { name: 'complianz',     button: '.cmplz-accept, .cmplz-btn.cmplz-accept' },
    { name: 'iubenda',       button: '.iubenda-cs-accept-btn' },
    { name: 'hubspot',       button: '#hs-eu-confirmation-button' },
    { name: 'axeptio',       button: '#axeptio_btn_acceptAll' },
    { name: 'civic',         button: '#ccc-notify-accept, #ccc-recommended-settings' },
    { name: 'klaro',         button: '.cm-btn-accept-all, .cm-btn.cm-btn-success' },
    { name: 'termly',        button: '[data-tid="banner-accept"]' },
    { name: 'shopify',       button: '#shopify-pc__banner__btn-accept' },
    { name: 'amazon',        button: '#sp-cc-accept' },
    { name: 'bbc',           button: '#bbccookies-continue-button, button[data-testid="accept-button"]' },
    { name: 'meta',          button: 'button[data-cookiebanner="accept_button"], [data-testid="cookie-policy-manage-dialog-accept-button"]' },
    { name: 'cookie-notice', button: '#cn-accept-cookie, .cn-set-cookie[data-cookie-set="accept"]' },
    { name: 'borlabs',       button: '#BorlabsCookieBox a._brlbs-btn-accept-all, #BorlabsCookieBox ._brlbs-btn-accept-all' },
    { name: 'moove',         button: '.moove-gdpr-infobar-allow-all' },
    { name: 'ezoic',         button: '#ez-accept-all' },
  ];

  function tryKnown(roots) {
    for (var i = 0; i < CMPS.length; i++) {
      var cmp = CMPS[i];
      var btn = firstVisible(cmp.button, roots);
      if (btn && isSafeLink(btn)) {
        if (doClick(btn, 'cmp:' + cmp.name, labelOf(btn))) return true;
      }
      if (cmp.api && cmp.banner && isTop && firstVisible(cmp.banner, roots)) {
        try {
          if (cmp.api()) {
            clicks += 1; lastClick = Date.now();
            report('api:' + cmp.name, '');
            return true;
          }
        } catch (e) {}
      }
    }
    return false;
  }

  // ---- 2. Generic fallback -------------------------------------------------
  // STRONG: unambiguous on their own (mention cookies, or are standard CMP wording).
  // MEDIUM: "accept" / "agree" wording; needs a consent-ish container.
  // WEAK:   generic dismiss wording; needs a consent-ish container.
  var STRONG = /^(accept|allow|agree to|enable|ok,? accept) (all )?cookies?( (and|&) (close|continue))?$|^(accept|allow) all( cookies)?$|^alle (cookies )?akzeptieren$|^tout accepter$|^aceptar (todo|todas|todas las cookies)$|^accetta (tutto|tutti)$|^aceitar (tudo|todos)$|^alles accepteren$/;
  var MEDIUM = /^(accept|i accept|agree|i agree|agree (and|&) (close|continue|proceed)|accept (and|&) (close|continue|proceed)|yes,? i('| a)?m happy|yes,? i agree|consent|allow|accept recommended( settings)?|akzeptieren|zustimmen|accepter|j'accepte|aceptar|acepto|accetta|accetto|aceitar|akkoord|accepteren)$/;
  var WEAK   = /^(ok|okay|ok!|got it|got it!|understood|i understand|continue|close|dismiss|that's ok|that's fine|sounds good|fine by me|no problem)$/;

  var CONTEXT_ATTR = /cookie|consent|gdpr|ccpa|\bcmp\b|cmp[-_]|privacy[-_]?(banner|notice|bar|popup|modal|overlay)|tracking[-_]?notice|onetrust|didomi|cookiebot|usercentrics|truste|cc[-_]banner|cc[-_]window/i;
  var CONTEXT_TEXT = /cookie|consent|personal data|we and our partners|your privacy|privacy settings|tracking technologies|legitimate interest/i;

  function attrsOf(el) {
    return (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '') + ' ' +
           (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('aria-describedby') || '') + ' ' +
           (el.getAttribute('data-nosnippet') !== null ? 'nosnippet ' : '') + (el.getAttribute('role') || '');
  }

  // True if el sits inside a container that looks like a consent banner:
  // either a consent-ish id/class/aria on an ancestor, or a fixed/sticky/dialog
  // ancestor whose own text talks about cookies or consent.
  function inConsentContext(el) {
    var node = el, depth = 0;
    while (node && depth < 12) {
      if (node.nodeType === 1) {
        if (CONTEXT_ATTR.test(attrsOf(node))) return true;
        var role = node.getAttribute('role');
        var pos = window.getComputedStyle(node).position;
        if (role === 'dialog' || role === 'alertdialog' || role === 'region' ||
            pos === 'fixed' || pos === 'sticky' || node.tagName === 'DIALOG') {
          var txt = (node.innerText || node.textContent || '').slice(0, 3000);
          if (CONTEXT_TEXT.test(txt)) return true;
        }
      }
      // Step out of shadow roots into their host.
      node = node.parentNode && node.parentNode.nodeType === 11 ? node.parentNode.host : node.parentNode;
      depth += 1;
    }
    // In a consent iframe (Sourcepoint, TrustArc, ...) the whole document is the banner.
    return !isTop && frameLooksLikeConsent();
  }

  var CANDIDATES = 'button, [role="button"], input[type="button"], input[type="submit"], a';

  function tryGeneric(roots) {
    var els = queryAll(CANDIDATES, roots);
    var best = null, bestRank = 0;
    for (var i = 0; i < els.length && i < 4000; i++) {
      var el = els[i];
      var label = labelOf(el);
      if (!label || label.length > 40) continue;
      var rank = STRONG.test(label) ? 3 : MEDIUM.test(label) ? 2 : WEAK.test(label) ? 1 : 0;
      if (!rank || rank < bestRank) continue;
      if (!isSafeLink(el) || !isVisible(el)) continue;
      // Even STRONG labels need some consent context unless they say "cookie".
      if (!(rank === 3 && /cookie/.test(label)) && !inConsentContext(el)) continue;
      if (rank > bestRank) { best = el; bestRank = rank; }
      if (bestRank === 3) break;
    }
    if (best) return doClick(best, 'generic', labelOf(best));
    return false;
  }

  // ---- Subframe gating -----------------------------------------------------
  // Pages are full of ad/video iframes; only work inside frames that look
  // like a consent dialog.
  var FRAME_HOST = /consent|privacy|cmp|sourcepoint|privacy-mgmt|trustarc|truste|cookie|didomi|onetrust|usercentrics|cookiebot|quantcast|fundingchoices/i;
  var frameVerdict = null;
  function frameLooksLikeConsent() {
    if (frameVerdict !== null) return frameVerdict;
    var hp = location.hostname + location.pathname;
    if (FRAME_HOST.test(hp) || /consent|cookie|privacy|sp_message/i.test(document.title + ' ' + window.name)) {
      frameVerdict = true;
    } else if (document.querySelector('[class*="sp_choice_type"], [class*="consent" i], [id*="consent" i], [class*="cookie" i], [id*="cookie" i]')) {
      frameVerdict = true;
    } else {
      return false; // not cached: the frame may still be filling in
    }
    return frameVerdict;
  }

  // ---- Scan loop -----------------------------------------------------------
  function stop() {
    done = true;
    clearTimeout(timer);
    if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
  }

  function scan() {
    timer = null;
    if (done) return;
    if (Date.now() - startedAt > SCAN_WINDOW_MS || scans >= MAX_SCANS || clicks >= MAX_CLICKS) { stop(); return; }
    if (Date.now() - lastClick < CLICK_COOLDOWN) { schedule(CLICK_COOLDOWN); return; }
    if (!document.body) { schedule(DEBOUNCE_MS); return; }
    if (!isTop && !frameLooksLikeConsent()) { scans += 1; return; }
    scans += 1;
    var roots = shadowRoots();
    try {
      if (tryKnown(roots)) { schedule(CLICK_COOLDOWN); return; }
      if (tryGeneric(roots)) { schedule(CLICK_COOLDOWN); return; }
    } catch (e) {}
  }

  function schedule(ms) {
    if (done || timer) return;
    timer = setTimeout(scan, ms);
  }

  function start() {
    schedule(50);
    try {
      observer = new MutationObserver(function () { schedule(DEBOUNCE_MS); });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
                                                   attributeFilter: ['class', 'style', 'hidden', 'open'] });
    } catch (e) {}
    window.addEventListener('load', function () { schedule(DEBOUNCE_MS); }, { once: true });
    // Final safety stop.
    setTimeout(stop, SCAN_WINDOW_MS + 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
