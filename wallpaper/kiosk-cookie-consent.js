(function () {
  'use strict';

  // Only run in top-level frames of kiosk panels.
  if (window.top !== window) return;

  // ---- CMP-specific selectors (tried in order) --------------------------------
  // Each entry: { name, accept } where accept is a CSS selector for the primary
  // "Accept all" / "Accept cookies" button.  Tried in order; first match wins.
  var CMPS = [
    // OneTrust (onetrust.com) — used by many major sites
    { name: 'OneTrust',       accept: '#onetrust-accept-btn-handler' },
    // Cookiebot
    { name: 'Cookiebot',      accept: '#CybotCookiebotDialogBodyButtonAccept' },
    // Quantcast Choice
    { name: 'Quantcast',      accept: '.qc-cmp2-summary-buttons button:last-child' },
    // Google Funding Choices / consent.google.com frame
    { name: 'Google FC',      accept: 'form[action*="consent"] button[jsname="b3VHJd"]' },
    // TrustArc
    { name: 'TrustArc',       accept: '.trustarc-agree-btn, #truste-consent-button' },
    // Sourcepoint
    { name: 'Sourcepoint',    accept: 'button[title="Accept All"], button[aria-label="Accept All"]' },
    // Didomi
    { name: 'Didomi',         accept: '#didomi-notice-agree-button' },
    // Usercentrics
    { name: 'Usercentrics',   accept: '[data-testid="uc-accept-all-button"]' },
    // CookieYes
    { name: 'CookieYes',      accept: '.cky-btn-accept' },
    // Borlabs Cookie
    { name: 'Borlabs',        accept: '#borlabs-cookie-accept' },
    // Complianz
    { name: 'Complianz',      accept: '.cmplz-btn.cmplz-accept' },
    // Iubenda
    { name: 'Iubenda',        accept: '#iubFooterBtn, .iubenda-cs-accept-btn' },
    // Cookie Notice (cookienotice.js)
    { name: 'CookieNotice',   accept: '#cn-accept-cookie' },
    // WP Cookie Consent (WPCC)
    { name: 'WPCC',           accept: '.wpcc-btn' },
    // EZCookies / generic EU law bar
    { name: 'EZCookies',      accept: '.ez-cookie-btn-accept, .cc-btn.cc-allow' },
  ];

  // Generic fallback phrases — matched case-insensitively against button text
  var ACCEPT_PHRASES = [
    'accept all cookies',
    'accept all',
    'accept cookies',
    'allow all cookies',
    'allow all',
    'allow cookies',
    'i accept',
    'i agree',
    'agree to all',
    'ok, i agree',
    'got it',
  ];

  // Shadow-DOM–aware querySelector: searches el and each shadow root recursively.
  function deepQuery(root, selector) {
    var el = root.querySelector(selector);
    if (el) return el;
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var sr = all[i].shadowRoot;
      if (sr) {
        el = deepQuery(sr, selector);
        if (el) return el;
      }
    }
    return null;
  }

  // Returns the visible, enabled button matching any CMP selector, or null.
  function findCmpButton(root) {
    for (var i = 0; i < CMPS.length; i++) {
      var el = deepQuery(root, CMPS[i].accept);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  // Generic fallback: scan all visible buttons for accept phrases.
  function findGenericButton(root) {
    var buttons = root.querySelectorAll(
      'button, [role="button"], input[type="button"], input[type="submit"], a.btn, a.button'
    );
    for (var i = 0; i < buttons.length; i++) {
      var el = buttons[i];
      if (!isVisible(el)) continue;
      var txt = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
      for (var j = 0; j < ACCEPT_PHRASES.length; j++) {
        if (txt === ACCEPT_PHRASES[j] || txt.indexOf(ACCEPT_PHRASES[j]) !== -1) return el;
      }
    }
    return null;
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
  }

  var clicked = typeof WeakSet !== 'undefined' ? new WeakSet() : null;

  function tryClick(el, cmpName) {
    if (!el) return false;
    if (clicked && clicked.has(el)) return false;
    if (clicked) clicked.add(el);
    // Dispatch a trusted-enough synthetic click (el.click() is untrusted but
    // sufficient for most CMP SDKs; they only reject synthetic events when they
    // specifically look for isTrusted, which most don't).
    el.click();
    window.postMessage({ __kioskCookieAccepted: true, cmp: cmpName || 'generic' }, '*');
    return true;
  }

  function scan() {
    var root = document;
    var el = findCmpButton(root) || findGenericButton(root);
    if (el) {
      var name = 'generic';
      for (var i = 0; i < CMPS.length; i++) {
        if (deepQuery(root, CMPS[i].accept) === el) { name = CMPS[i].name; break; }
      }
      tryClick(el, name);
    }
  }

  // Run immediately, then watch for late-mounting banners.
  scan();

  var observer = new MutationObserver(function () { scan(); });
  observer.observe(document.documentElement || document, { childList: true, subtree: true });

  // Safety cut-off: stop watching after 30 s — banners show quickly or not at all.
  setTimeout(function () { observer.disconnect(); }, 30000);
})();
