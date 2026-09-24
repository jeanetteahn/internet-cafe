const { BrowserWindow, BrowserView, screen, ipcMain, globalShortcut, session } = require('electron');
const path = require('path');

// ---- Search topics ----------------------------------------------------------
// Kid-friendly only.  'local news' and 'world news' removed — too likely to
// surface crime or conflict.  Add or swap terms freely; panels cycle through
// the list in order, staggered so all five show different content at launch.
const SEARCH_TERMS = [
  'space pictures',
  'animal facts',
  'weather today',
  'science for kids',
  'ocean animals',
  'dinosaur discoveries',
  'planets solar system',
  'nature photography',
  'inventions history',
  'national parks',
];

// ---- Content-safety lists ---------------------------------------------------
// Layer 1: domain allowlist.  Only hostnames that exactly match or are a
// subdomain of an entry are navigated to during idle auto-browsing.  Manual
// customer browsing is not filtered by any of these.
const ALLOWED_DOMAINS = [
  'nasa.gov',
  'noaa.gov',
  'weather.gov',
  'nationalgeographic.com',
  'smithsonianmag.com',
  'si.edu',
  'pbs.org',
  'npr.org',
  'bbc.com',
  'bbc.co.uk',
  'britannica.com',
  'kids.nationalgeographic.com',
  'sciencenewsexplores.org',
  'space.com',
  'earthobservatory.nasa.gov',
];

// Layer 2: keyword blocklist.  Links whose title or URL contains any of these
// strings (case-insensitive) are skipped.  Also covers account/navigation
// pages that would be useless to auto-browse.
const BLOCKED_KEYWORDS = [
  // violence / crime / weapons
  'murder', 'shooting', 'stabbing', 'violence', 'weapon',
  'gun', 'bomb', 'terror', 'attack', 'crime', 'criminal', 'arrest',
  // adult / explicit
  'porn', 'sex', 'nude', 'naked', 'adult', 'explicit', 'xxx',
  // substances
  'drug', 'marijuana', 'cocaine', 'alcohol', 'beer', 'wine', 'cigarette',
  // gambling
  'gambling', 'casino', 'bet', 'poker', 'lottery',
  // account / transaction pages (useless to auto-browse)
  'login', 'signin', 'sign-up', 'register', 'subscribe',
  'cart', 'checkout', 'password', 'account',
];

// ---- Browsing-loop tunables -------------------------------------------------
const SEARCH_INTERVAL_MS  = 90 * 1000;  // min ms between DuckDuckGo searches per panel
const PAGE_DWELL_MIN_MS   = 8_000;      // min ms spent on each page before hopping
const PAGE_DWELL_MAX_MS   = 12_000;     // max ms spent on each page before hopping
const SCROLL_STEP_PX      = 80;         // px scrolled per interval tick
const SCROLL_STEP_MS      = 250;        // ms between scroll ticks
const MAX_LINK_HOPS       = 5;          // hops from the link pool before forcing a new search
const POOL_MAX            = 30;         // max links in each panel's pool at once
const RECENT_URL_MAX      = 20;         // how many recently-visited URLs to remember (avoid repeats)
const PRELOAD_NEXT_PAGE   = true;       // load the next page in background during dwell
const PRELOAD_TIMEOUT_MS  = 10_000;     // max ms to wait for a preload before loading directly
const INACTIVITY_TIMEOUT_MS = 90 * 1000; // idle grace period before auto-browsing resumes

// ---- Window / layout tunables ----------------------------------------------
const HANDLE_HEIGHT         = 28;   // px — draggable title strip on each panel
const RETURN_HOME_WHEN_IDLE = true; // snap panel back to home position when it goes idle
const MIN_VISIBLE_PX        = 120;  // px of drag strip that must remain on-screen after drag
const GRIP_SIZE             = 18;   // px — bottom-right resize grip square
const MIN_PANEL_WIDTH       = 320;
const MIN_PANEL_HEIGHT      = 220;
const INITIAL_LOAD_STAGGER_MS = 1500; // ms between each panel's first page load at launch

// "Loading…" page shown immediately so panels are never an empty dark box.
const PLACEHOLDER_URL = 'data:text/html,' + encodeURIComponent(
  '<body style="margin:0;background:#1a1a1a;color:#555;' +
  'font:14px/1 sans-serif;display:flex;align-items:center;' +
  'justify-content:center;height:100vh">Loading…</body>'
);

// ---- Startup timing ---------------------------------------------------------
// Set at the start of createKioskWindow().  Grep [kiosk-timing] to measure.
let _t0 = 0;
const timingMs = () => Date.now() - _t0;
const firstLoadLogged = new Set(); // panels whose first real page load has been logged

// ---- Module-level state (GC protection) ------------------------------------
//
// All BrowserWindows and BrowserViews MUST be kept in module-level Maps/objects
// so V8's garbage collector can never silently destroy them.  Without these
// references, the process stays alive but all windows vanish — see README for
// the full post-mortem.  Do NOT remove these Maps or make createKioskWindow()
// the only holder of these references.
const panelWindows    = new Map(); // key -> BrowserWindow
const homeBounds      = new Map(); // key -> { x, y, width, height }
const panelViews      = {};        // key -> BrowserView  (currently visible)
const preloadViews    = {};        // key -> BrowserView  (offscreen preload — GC protection)
const gripViews       = {};        // key -> BrowserView  (resize grip overlay)
const panelStates     = new Map(); // key -> browsing + activity state object
const panelPools      = new Map(); // key -> string[]  (shuffled URL pool)
const recentUrls      = new Map(); // key -> string[]  (recently visited, capped)

// Truthy while a programmatic setBounds is in flight; prevents the 'move'
// debounce handler from treating clamping / send-home moves as customer drags.
const ignoreNextMoves = new Map();
const resizeState     = new Map();

// webContentsIdToKey is module-level (not local to attachActivityHandling) so
// preload-view swaps can keep IPC routing correct after every swap.
const webContentsIdToKey = new Map();

// ---- Layout -----------------------------------------------------------------

function computeClusterLayout(screenW, screenH) {
  // Cluster fills 88 % × 82 % of the display so the full layout fits on
  // screen with margin.  Panels overlap on purpose (pinwheel arrangement);
  // z-order is managed in createKioskWindow: hub is created first (lowest
  // z-order) then brought to the front with moveTop() after all five windows
  // exist, so hub sits on top in each overlap region.
  const W = Math.round((screenW || 1920) * 0.88);
  const H = Math.round((screenH || 1080) * 0.82);

  const defs = {
    hub:         { rx: 0.196,  ry: 0.147,  rw: 0.601, rh: 0.634 },
    topLeft:     { rx: -0.068, ry: -0.103, rw: 0.477, rh: 0.552 },
    topRight:    { rx: 0.517,  ry: -0.079, rw: 0.471, rh: 0.553 },
    bottomLeft:  { rx: -0.033, ry: 0.551,  rw: 0.463, rh: 0.492 },
    bottomRight: { rx: 0.506,  ry: 0.550,  rw: 0.488, rh: 0.494 },
  };

  const result = { totalWidth: W, totalHeight: H };
  for (const [key, d] of Object.entries(defs)) {
    result[key] = {
      x:      Math.round(d.rx * W),
      y:      Math.round(d.ry * H),
      width:  Math.round(d.rw * W),
      height: Math.round(d.rh * H),
    };
  }
  return result;
}

function makePanelView() {
  return new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'kiosk-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

function makeGripView() {
  return new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'kiosk-resize-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

// ---- Content safety ---------------------------------------------------------

function buildSearchUrl(term) {
  // &kp=1 enables DuckDuckGo strict SafeSearch (layer 1 of content filtering).
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(term)}&kp=1`;
}

function isDomainAllowed(url) {
  try {
    const { hostname } = new URL(url);
    return ALLOWED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

function hasBlockedKeyword(text) {
  const lower = text.toLowerCase();
  return BLOCKED_KEYWORDS.some(kw => lower.includes(kw));
}

function isSkippableUrl(url) {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return true;
  if (/\.(pdf|zip|exe|dmg|apk|mp3|mp4|mov|doc|docx|xls|xlsx)(\?|#|$)/i.test(url)) return true;
  return false;
}

// DuckDuckGo HTML result links are often redirect URLs:
//   https://duckduckgo.com/l/?uddg=ENCODED_REAL_URL&rut=…
// Decode to the real destination before checking the domain allowlist.
function decodeDdgRedirect(url) {
  try {
    const u = new URL(url);
    if ((u.hostname === 'duckduckgo.com' || u.hostname.endsWith('.duckduckgo.com'))
        && u.pathname === '/l/') {
      const dest = u.searchParams.get('uddg');
      if (dest) return decodeURIComponent(dest);
    }
  } catch {}
  return url;
}

// Returns the real destination URL if a link passes all filters, or null with
// a [kiosk-auto] log if it is blocked.
function filterLink(href, linkText) {
  if (isSkippableUrl(href)) return null;

  const real = decodeDdgRedirect(href);
  if (isSkippableUrl(real)) return null;

  try {
    const { hostname } = new URL(real);
    // Skip DuckDuckGo-internal links (ads, navigation, etc.)
    if (hostname === 'duckduckgo.com' || hostname.endsWith('.duckduckgo.com')) return null;
  } catch {
    return null;
  }

  if (!isDomainAllowed(real)) {
    console.log(`[kiosk-auto] blocked (domain): ${real}`);
    return null;
  }

  const combined = real + ' ' + (linkText || '');
  if (hasBlockedKeyword(combined)) {
    console.log(`[kiosk-auto] blocked (keyword): ${real}`);
    return null;
  }

  return real;
}

// Collect and filter all links on the current page via executeJavaScript
// (does not fire click/wheel events; does not trigger panel-activity).
async function collectLinks(webContents) {
  try {
    const url = webContents.getURL();
    if (!url || url.startsWith('data:') || url === 'about:blank') return [];

    const raw = await webContents.executeJavaScript(`
      (function () {
        const out = [];
        document.querySelectorAll('a[href]').forEach(function (a) {
          const href = a.href;
          const text = (a.textContent || a.title || a.getAttribute('aria-label') || '')
                       .trim().slice(0, 200);
          if (href) out.push([href, text]);
        });
        return out;
      })()
    `, false);

    const seen = new Set();
    const results = [];
    for (const [href, text] of raw) {
      const allowed = filterLink(href, text);
      if (allowed && !seen.has(allowed)) {
        seen.add(allowed);
        results.push(allowed);
      }
    }
    return results;
  } catch (err) {
    console.log('[kiosk-auto] collectLinks error:', err.message);
    return [];
  }
}

// ---- Pool management --------------------------------------------------------

function pushToPool(key, urls) {
  let pool = panelPools.get(key);
  if (!pool) { pool = []; panelPools.set(key, pool); }

  // Shuffle incoming URLs before merging so panels don't always hop in the
  // same link order from a given results page.
  const shuffled = [...urls].sort(() => Math.random() - 0.5);
  for (const url of shuffled) {
    if (!pool.includes(url) && pool.length < POOL_MAX) {
      pool.push(url);
    }
  }
  console.log(`[kiosk-auto] ${key} pool: ${pool.length} links`);
}

// Pop the next unvisited URL from the front of the pool.  Returns null if
// the pool is empty or all remaining entries are recent (pool effectively
// exhausted).
function pickNextUrl(key) {
  const pool = panelPools.get(key);
  if (!pool) return null;
  while (pool.length > 0) {
    const url = pool.shift();
    if (!isRecentUrl(key, url)) return url;
    console.log(`[kiosk-auto] ${key} skip recent: ${url}`);
  }
  return null;
}

function addToRecent(key, url) {
  let recent = recentUrls.get(key);
  if (!recent) { recent = []; recentUrls.set(key, recent); }
  if (!recent.includes(url)) {
    recent.push(url);
    if (recent.length > RECENT_URL_MAX) recent.shift();
  }
}

function isRecentUrl(key, url) {
  const recent = recentUrls.get(key);
  return recent ? recent.includes(url) : false;
}

// ---- Programmatic move/resize helpers --------------------------------------

function setPanelBoundsIgnored(key, bounds) {
  const existing = ignoreNextMoves.get(key);
  if (existing) clearTimeout(existing);
  ignoreNextMoves.set(key, setTimeout(() => ignoreNextMoves.set(key, null), 400));
  const win = panelWindows.get(key);
  if (win && !win.isDestroyed()) win.setBounds(bounds);
}

function sendPanelHome(key) {
  const bounds = homeBounds.get(key);
  if (bounds) setPanelBoundsIgnored(key, bounds);
}

function clampToDisplay(key) {
  const win = panelWindows.get(key);
  if (!win || win.isDestroyed()) return;
  const { workArea } = screen.getDisplayMatching(win.getBounds());
  const { x, y, width, height } = win.getBounds();

  const cx = Math.max(
    workArea.x - width + MIN_VISIBLE_PX,
    Math.min(x, workArea.x + workArea.width - MIN_VISIBLE_PX)
  );
  const cy = Math.max(
    workArea.y,
    Math.min(y, workArea.y + workArea.height - HANDLE_HEIGHT)
  );

  if (cx !== x || cy !== y) {
    setPanelBoundsIgnored(key, { x: cx, y: cy, width, height });
  }
}

// ---- Resize helpers ---------------------------------------------------------

function minSizeFor(key) {
  const home = homeBounds.get(key);
  return {
    width:  home ? Math.min(MIN_PANEL_WIDTH,  home.width)  : MIN_PANEL_WIDTH,
    height: home ? Math.min(MIN_PANEL_HEIGHT, home.height) : MIN_PANEL_HEIGHT,
  };
}

function positionGrip(key) {
  const win  = panelWindows.get(key);
  const grip = gripViews[key];
  if (!win || win.isDestroyed() || !grip) return;
  const [w, h] = win.getContentSize();
  grip.setBounds({ x: w - GRIP_SIZE, y: h - GRIP_SIZE, width: GRIP_SIZE, height: GRIP_SIZE });
}

function startResize(key, offset) {
  const win = panelWindows.get(key);
  if (!win || win.isDestroyed()) return;
  const ox = Math.max(0, Math.min(GRIP_SIZE, offset.x));
  const oy = Math.max(0, Math.min(GRIP_SIZE, offset.y));
  resizeState.set(key, {
    startBounds: win.getBounds(),
    cornerDx: GRIP_SIZE - ox,
    cornerDy: GRIP_SIZE - oy,
  });
  notePanelActivity(key);
}

function updateResize(key) {
  const state = resizeState.get(key);
  if (!state) return;
  const win = panelWindows.get(key);
  if (!win || win.isDestroyed()) return;

  const cursor   = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayMatching(win.getBounds());
  const { startBounds, cornerDx, cornerDy } = state;
  const minSize  = minSizeFor(key);

  let newW = cursor.x + cornerDx - startBounds.x;
  let newH = cursor.y + cornerDy - startBounds.y;

  newW = Math.max(minSize.width,  newW);
  newH = Math.max(minSize.height, newH);
  newW = Math.min(newW, workArea.x + workArea.width  - startBounds.x);
  newH = Math.min(newH, workArea.y + workArea.height - startBounds.y);

  setPanelBoundsIgnored(key, {
    x: startBounds.x, y: startBounds.y,
    width: Math.round(newW), height: Math.round(newH),
  });
}

function endResize(key) {
  updateResize(key);
  resizeState.set(key, null);
  notePanelActivity(key);
}

// ---- Activity ---------------------------------------------------------------

function notePanelActivity(key) {
  const state = panelStates.get(key);
  if (!state) return;

  if (state.mode === 'auto') {
    stopBrowsingLoop(key);
    state.mode = 'active';
  }

  clearTimeout(state.inactivityTimer);
  state.inactivityTimer = setTimeout(() => {
    if (RETURN_HOME_WHEN_IDLE) sendPanelHome(key);
    state.mode = 'auto';
    startBrowsingLoop(key);
  }, INACTIVITY_TIMEOUT_MS);
}

// ---- View event handler setup -----------------------------------------------
//
// Called once per BrowserView at creation time (both the visible view and the
// preload view).  Handlers close over `key` and reference panelViews[key] /
// preloadViews[key] dynamically, so they work correctly after a preload swap.

function setupViewEventHandlers(key, win, view) {
  // Title forwarding — only from the currently visible view.
  view.webContents.on('page-title-updated', (_e, title) => {
    if (view === panelViews[key] && !win.isDestroyed()) {
      win.webContents.send('panel-title', title);
    }
  });

  view.webContents.on('did-finish-load', () => {
    const url = view.webContents.getURL();

    if (view === panelViews[key]) {
      // ---- Visible view finished loading ------------------------------------
      // [kiosk-timing] first real page per panel.
      if (!firstLoadLogged.has(key) && !url.startsWith('data:')) {
        firstLoadLogged.add(key);
        console.log(`[kiosk-timing] ${key} did-finish-load: +${timingMs()} ms`);
      }
      // Hand off to the browsing loop.
      if (!url.startsWith('data:') && url !== 'about:blank') {
        const ps = panelStates.get(key);
        if (ps && ps.mode === 'auto') onVisiblePageReady(key);
      }

    } else if (view === preloadViews[key]) {
      // ---- Preload view finished loading ------------------------------------
      if (url.startsWith('data:') || url === 'about:blank') return;
      const ps = panelStates.get(key);
      if (!ps) return;
      ps.preloadReady = true;
      console.log(`[kiosk-auto] ${key} preload ready: ${url}`);

      if (ps.awaitingPreload && ps.mode === 'auto') {
        // Dwell already expired while we were waiting for this preload.
        clearTimeout(ps.preloadTimer);
        ps.preloadTimer = null;
        swapToPreloaded(key);
      }
    }
  });

  view.webContents.on('did-fail-load', (_e, errorCode, _desc, failedUrl) => {
    if (errorCode === -3) return; // ERR_ABORTED — normal cancelled navigation
    const ps = panelStates.get(key);
    if (!ps || ps.mode !== 'auto') return;
    if (!failedUrl || failedUrl.startsWith('data:')) return;

    if (view === panelViews[key]) {
      console.log(`[kiosk-auto] ${key} load failed (${errorCode}): ${failedUrl}`);
      // Only advance if the browsing loop isn't already running (no dwell/scroll).
      if (!ps.dwellTimer && !ps.scrollTimer) {
        setTimeout(() => { if (ps.mode === 'auto') advancePage(key); }, 800);
      }
    } else if (view === preloadViews[key]) {
      console.log(`[kiosk-auto] ${key} preload failed (${errorCode}): ${failedUrl}`);
      ps.preloadUrl   = null;
      ps.preloadReady = false;
      if (ps.awaitingPreload) {
        ps.awaitingPreload = false;
        clearTimeout(ps.preloadTimer);
        ps.preloadTimer = null;
        advancePage(key);
      }
    }
  });

  // Redirect/off-allowlist guard.  Fires after navigation commits (redirects
  // resolved) for both visible and preload views.
  view.webContents.on('did-navigate', (_e, url) => {
    if (!url || url.startsWith('data:') || url === 'about:blank') return;
    const ps = panelStates.get(key);
    if (!ps || ps.mode !== 'auto') return;

    // DuckDuckGo search pages are expected to be off-allowlist.
    try {
      const { hostname } = new URL(url);
      if (hostname === 'duckduckgo.com' || hostname.endsWith('.duckduckgo.com')) return;
    } catch { return; }

    if (isDomainAllowed(url)) return; // fine

    if (view === panelViews[key]) {
      console.log(`[kiosk-auto] ${key} blocked (redirect off-allowlist): ${url}`);
      stopScrolling(key);
      clearTimeout(ps.dwellTimer);
      ps.dwellTimer = null;
      cancelPreload(key);
      advancePage(key);
    } else if (view === preloadViews[key]) {
      console.log(`[kiosk-auto] ${key} preload redirect off-allowlist: ${url}`);
      cancelPreload(key);
    }
  });
}

// ---- Browsing loop ----------------------------------------------------------

function randomDwell() {
  return PAGE_DWELL_MIN_MS + Math.random() * (PAGE_DWELL_MAX_MS - PAGE_DWELL_MIN_MS);
}

function startScrolling(key) {
  const ps = panelStates.get(key);
  if (!ps) return;
  stopScrolling(key);
  ps.scrollTimer = setInterval(() => {
    if (ps.mode !== 'auto') { stopScrolling(key); return; }
    const view = panelViews[key];
    if (!view || view.webContents.isDestroyed()) return;
    // scrollBy via executeJavaScript does NOT fire wheel events, so it cannot
    // trigger panel-activity detection in kiosk-preload.js.
    view.webContents.executeJavaScript(
      `window.scrollBy(0, ${SCROLL_STEP_PX})`, false
    ).catch(() => {});
  }, SCROLL_STEP_MS);
}

function stopScrolling(key) {
  const ps = panelStates.get(key);
  if (!ps) return;
  clearInterval(ps.scrollTimer);
  ps.scrollTimer = null;
}

function cancelPreload(key) {
  const ps = panelStates.get(key);
  if (!ps) return;
  clearTimeout(ps.preloadTimer);
  ps.preloadTimer    = null;
  ps.preloadUrl      = null;
  ps.preloadReady    = false;
  ps.awaitingPreload = false;
  const pv = preloadViews[key];
  if (pv && !pv.webContents.isDestroyed()) pv.webContents.stop();
}

// Swap the preload view into the visible slot.
// - The old visible view is removed from the window and becomes the new preload.
// - The preload view is given the same bounds and added to the window.
// - The resize grip is re-stacked on top.
// - webContentsIdToKey is updated so IPC keeps routing correctly.
// - onVisiblePageReady is called immediately (the page already loaded).
function swapToPreloaded(key) {
  const win = panelWindows.get(key);
  if (!win || win.isDestroyed()) return;

  const visView  = panelViews[key];
  const prevView = preloadViews[key];
  if (!prevView) return;

  const ps = panelStates.get(key);
  if (!ps) return;

  const bounds = visView.getBounds();

  win.removeBrowserView(visView);
  prevView.setBounds(bounds);
  prevView.setAutoResize({ width: true, height: true });
  win.addBrowserView(prevView);

  const grip = gripViews[key];
  if (grip) win.setTopBrowserView(grip);

  // Swap module-level references (old visible → new preload, and vice versa).
  panelViews[key]   = prevView;
  preloadViews[key] = visView;

  // Both views already have entries in webContentsIdToKey pointing at key,
  // so IPC routing is unaffected — no update needed.

  // Reset preload state.
  ps.preloadUrl      = null;
  ps.preloadReady    = false;
  ps.awaitingPreload = false;
  ps.preloadTimer    = null;

  console.log(`[kiosk-auto] ${key} swapped to preloaded page`);

  // The newly visible page has already loaded; kick off browsing logic for it.
  if (ps.mode === 'auto') onVisiblePageReady(key);
}

// Called after the visible view finishes loading a page.  Collects links,
// starts scrolling, starts preloading the next page, and sets the dwell timer.
async function onVisiblePageReady(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;

  const view = panelViews[key];
  if (!view || view.webContents.isDestroyed()) return;

  const url = view.webContents.getURL();
  if (!url || url.startsWith('data:')) return;

  console.log(`[kiosk-auto] ${key} page ready (hop ${ps.hopCount}): ${url}`);

  // Collect links and fill the pool.
  const links = await collectLinks(view.webContents);
  if (links.length > 0) pushToPool(key, links);

  // Guard: customer may have taken over during the async collectLinks call.
  if (ps.mode !== 'auto') return;

  startScrolling(key);

  // Pick next URL and start preloading during this dwell.
  if (PRELOAD_NEXT_PAGE) {
    const nextUrl = pickNextUrl(key);
    if (nextUrl) {
      ps.preloadUrl   = nextUrl;
      ps.preloadReady = false;
      addToRecent(key, nextUrl);
      const pv = preloadViews[key];
      if (pv && !pv.webContents.isDestroyed()) {
        console.log(`[kiosk-auto] ${key} preloading: ${nextUrl}`);
        const preloadStart = Date.now();
        pv.webContents.loadURL(nextUrl).then(() => {
          console.log(`[kiosk-auto] ${key} preload navigated in ${Date.now() - preloadStart} ms`);
        }).catch(err => {
          console.log(`[kiosk-auto] ${key} preload load error: ${err.message}`);
          ps.preloadUrl = null;
        });
      }
    }
  }

  startDwell(key);
}

function startDwell(key) {
  const ps = panelStates.get(key);
  if (!ps) return;
  clearTimeout(ps.dwellTimer);

  ps.dwellTimer = setTimeout(() => {
    ps.dwellTimer = null;
    if (ps.mode !== 'auto') return;

    stopScrolling(key);

    if (PRELOAD_NEXT_PAGE && ps.preloadUrl) {
      if (ps.preloadReady) {
        // Preload finished before dwell ended — swap instantly.
        swapToPreloaded(key);
      } else {
        // Dwell ended while preload is still in flight.
        // Wait up to PRELOAD_TIMEOUT_MS for it; then fall back to direct load.
        ps.awaitingPreload = true;
        ps.preloadTimer = setTimeout(() => {
          ps.preloadTimer    = null;
          ps.awaitingPreload = false;
          console.log(`[kiosk-auto] ${key} preload timed out, loading directly`);
          cancelPreload(key);
          advancePage(key);
        }, PRELOAD_TIMEOUT_MS);
      }
    } else {
      advancePage(key);
    }
  }, randomDwell());
}

// Decide what page to show next: hop from pool or run a new search.
function advancePage(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;

  const poolEmpty   = (panelPools.get(key) || []).length === 0;
  const needsSearch = ps.hopCount >= MAX_LINK_HOPS || poolEmpty;

  if (needsSearch) {
    const elapsed = Date.now() - ps.lastSearchTime;
    if (ps.lastSearchTime === 0 || elapsed >= SEARCH_INTERVAL_MS) {
      doSearch(key);
    } else {
      const wait = SEARCH_INTERVAL_MS - elapsed;
      console.log(`[kiosk-auto] ${key} search interval: waiting ${Math.round(wait / 1000)} s`);
      startScrolling(key);
      ps.dwellTimer = setTimeout(() => {
        ps.dwellTimer = null;
        if (ps.mode === 'auto') advancePage(key);
      }, wait);
    }
    return;
  }

  const nextUrl = pickNextUrl(key);
  if (!nextUrl) {
    // Pool exhausted between page-load and now.
    const elapsed = Date.now() - ps.lastSearchTime;
    if (ps.lastSearchTime === 0 || elapsed >= SEARCH_INTERVAL_MS) {
      doSearch(key);
    } else {
      const wait = SEARCH_INTERVAL_MS - elapsed;
      startScrolling(key);
      ps.dwellTimer = setTimeout(() => {
        ps.dwellTimer = null;
        if (ps.mode === 'auto') advancePage(key);
      }, wait);
    }
    return;
  }

  ps.hopCount += 1;
  addToRecent(key, nextUrl);
  console.log(`[kiosk-auto] ${key} hop ${ps.hopCount}/${MAX_LINK_HOPS}: ${nextUrl}`);

  const view = panelViews[key];
  if (!view || view.webContents.isDestroyed()) return;
  view.webContents.loadURL(nextUrl).catch(err => {
    console.log(`[kiosk-auto] ${key} hop load failed: ${err.message}`);
    setTimeout(() => { if (ps.mode === 'auto') advancePage(key); }, 800);
  });
}

function doSearch(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;

  ps.hopCount      = 0;
  ps.lastSearchTime = Date.now();
  panelPools.set(key, []); // fresh pool for each new search

  const term = SEARCH_TERMS[ps.searchIndex % SEARCH_TERMS.length];
  ps.searchIndex += 1;
  const url = buildSearchUrl(term);
  console.log(`[kiosk-auto] ${key} search [${ps.searchIndex}]: "${term}"`);

  addToRecent(key, url);
  const view = panelViews[key];
  if (!view || view.webContents.isDestroyed()) return;
  view.webContents.loadURL(url).catch(err => {
    console.log(`[kiosk-auto] ${key} search load failed: ${err.message}`);
  });
}

// Start (or restart) idle auto-browsing for a panel.
function startBrowsingLoop(key) {
  const ps = panelStates.get(key);
  if (!ps) return;

  stopBrowsingLoop(key);
  ps.mode = 'auto';
  panelPools.set(key, []);

  doSearch(key);
}

// Stop all timers and cancel any pending preload.  Does NOT change ps.mode —
// callers set that themselves.
function stopBrowsingLoop(key) {
  const ps = panelStates.get(key);
  if (!ps) return;

  clearTimeout(ps.dwellTimer);
  clearInterval(ps.scrollTimer);
  clearTimeout(ps.preloadTimer);
  clearTimeout(ps.rotationStartTimer);

  ps.dwellTimer        = null;
  ps.scrollTimer       = null;
  ps.preloadTimer      = null;
  ps.rotationStartTimer = null;
  ps.awaitingPreload   = false;
  ps.preloadUrl        = null;
  ps.preloadReady      = false;

  const pv = preloadViews[key];
  if (pv && !pv.webContents.isDestroyed()) pv.webContents.stop();
}

// ---- Window creation --------------------------------------------------------

/**
 * Creates five independent, movable, resizable panel windows — one per kiosk
 * panel (hub, topLeft, topRight, bottomLeft, bottomRight).  Each window is a
 * frameless BrowserWindow with:
 *   - a 28 px drag strip (kiosk-handle.html) at the top
 *   - a visible BrowserView for page content
 *   - a hidden BrowserView used to preload the next page during dwell
 *   - an 18 × 18 px resize grip (kiosk-resize-grip.html) on the bottom-right
 *
 * Returns an array of the five BrowserWindow instances.  Callers should store
 * this array alongside the module-level panelWindows Map — belt-and-suspenders
 * GC protection (see README "Known bug" section).
 */
function createKioskWindow() {
  _t0 = Date.now();
  session.defaultSession.preconnect({ url: 'https://html.duckduckgo.com' });

  const allDisplays  = screen.getAllDisplays();
  const envIndex     = parseInt(process.env.KIOSK_DISPLAY, 10);
  const kioskDisplay = (Number.isFinite(envIndex) && envIndex >= 0 && envIndex < allDisplays.length)
    ? allDisplays[envIndex]
    : screen.getPrimaryDisplay();

  const { workArea } = kioskDisplay;
  const layout  = computeClusterLayout(workArea.width, workArea.height);
  const originX = workArea.x + Math.round((workArea.width  - layout.totalWidth)  / 2);
  const originY = workArea.y + Math.round((workArea.height - layout.totalHeight) / 2);

  // Hub first → lowest z-order during construction.
  const order = ['hub', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'];

  for (const key of order) {
    const pLayout = layout[key];
    const winW    = pLayout.width;
    const winH    = pLayout.height + HANDLE_HEIGHT;
    const homeX   = originX + pLayout.x;
    const homeY   = originY + pLayout.y;

    homeBounds.set(key, { x: homeX, y: homeY, width: winW, height: winH });

    const win = new BrowserWindow({
      x: homeX, y: homeY, width: winW, height: winH,
      frame:       false,
      resizable:   true,   // required for programmatic setBounds() on all platforms
      movable:     true,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#1a1a1a',
      webPreferences: {
        preload: path.join(__dirname, 'kiosk-handle-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    panelWindows.set(key, win);
    console.log(`[kiosk-timing] ${key} window created: +${timingMs()} ms`);

    const minSize = minSizeFor(key);
    win.setMinimumSize(minSize.width, minSize.height);
    win.loadFile(path.join(__dirname, 'kiosk-handle.html'));

    // Visible panel view.
    const view = makePanelView();
    win.addBrowserView(view);
    view.setBounds({ x: 0, y: HANDLE_HEIGHT, width: winW, height: winH - HANDLE_HEIGHT });
    view.setAutoResize({ width: true, height: true });
    view.webContents.loadURL(PLACEHOLDER_URL);
    panelViews[key] = view;
    setupViewEventHandlers(key, win, view);

    // Preload view — NOT added to window here; sits offscreen until swap.
    // Must be held in preloadViews for GC protection.
    const preloadView = makePanelView();
    preloadViews[key] = preloadView;
    setupViewEventHandlers(key, win, preloadView);

    // Resize grip — added after both panel views so it stays on top.
    const grip = makeGripView();
    win.addBrowserView(grip);
    grip.webContents.loadFile(path.join(__dirname, 'kiosk-resize-grip.html'));
    gripViews[key] = grip;
    positionGrip(key);

    win.on('resize', () => positionGrip(key));

    let moveDebounce = null;
    win.on('move', () => {
      if (ignoreNextMoves.get(key)) return;
      clearTimeout(moveDebounce);
      moveDebounce = setTimeout(() => {
        notePanelActivity(key);
        clampToDisplay(key);
      }, 250);
    });

    win.on('closed', () => {
      panelWindows.delete(key);
      homeBounds.delete(key);
      delete panelViews[key];
      delete preloadViews[key];
      delete gripViews[key];
      resizeState.delete(key);
      panelPools.delete(key);
      recentUrls.delete(key);
    });
  }

  // Re-stack hub on top now that all five windows exist.
  const hubWin = panelWindows.get('hub');
  if (hubWin && !hubWin.isDestroyed()) hubWin.moveTop();

  attachActivityHandling();
  startAllIdleRotation();

  // Dev-only layout dump: Ctrl+Alt+D prints current panel fractions as a
  // paste-ready defs block for computeClusterLayout.
  const dumpRegistered = globalShortcut.register('Control+Alt+D', () => {
    const lines = order.map(key => {
      const win = panelWindows.get(key);
      if (!win || win.isDestroyed()) return `    ${key}: (window gone)`;
      const { x, y, width, height } = win.getBounds();
      const rx = ((x - originX) / layout.totalWidth ).toFixed(3);
      const ry = ((y - originY) / layout.totalHeight).toFixed(3);
      const rw = (width              / layout.totalWidth ).toFixed(3);
      const rh = ((height - HANDLE_HEIGHT) / layout.totalHeight).toFixed(3);
      const pad = ' '.repeat(12 - key.length);
      return `    ${key}:${pad}{ rx: ${rx}, ry: ${ry}, rw: ${rw}, rh: ${rh} },`;
    });
    console.log('[kiosk] Ctrl+Alt+D — current layout (paste over defs in computeClusterLayout):');
    console.log('  const defs = {');
    console.log(lines.join('\n'));
    console.log('  };');
  });
  if (!dumpRegistered) {
    console.error('[kiosk] Ctrl+Alt+D already claimed — layout dump unavailable');
  }

  return order.map(key => panelWindows.get(key));
}

// ---- IPC activity handling --------------------------------------------------

function attachActivityHandling() {
  // Populate the module-level webContentsIdToKey map.  Both panel views and
  // preload views are registered so IPC works correctly on either, before and
  // after any preload swaps.
  webContentsIdToKey.clear();
  for (const [key, view] of Object.entries(panelViews)) {
    webContentsIdToKey.set(view.webContents.id, key);
  }
  for (const [key, view] of Object.entries(preloadViews)) {
    webContentsIdToKey.set(view.webContents.id, key);
  }
  for (const [key, win] of panelWindows) {
    webContentsIdToKey.set(win.webContents.id, key);
  }
  for (const [key, grip] of Object.entries(gripViews)) {
    webContentsIdToKey.set(grip.webContents.id, key);
  }

  ipcMain.on('panel-activity', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (key) notePanelActivity(key);
  });

  ipcMain.on('panel-reset-position', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (key) sendPanelHome(key);
  });

  ipcMain.on('panel-resize-start', (event, offset) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (key) startResize(key, offset);
  });

  ipcMain.on('panel-resize-move', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (key) updateResize(key);
  });

  ipcMain.on('panel-resize-end', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (key) endResize(key);
  });
}

// ---- Startup ----------------------------------------------------------------

function startAllIdleRotation() {
  const order = ['hub', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
  order.forEach((key, i) => {
    panelPools.set(key, []);
    recentUrls.set(key, []);
    panelStates.set(key, {
      mode:             'auto',
      inactivityTimer:  null,
      // Browsing loop:
      hopCount:         0,
      lastSearchTime:   0,
      searchIndex:      i,           // stagger topics across panels at launch
      dwellTimer:       null,
      scrollTimer:      null,
      preloadTimer:     null,
      preloadUrl:       null,
      preloadReady:     false,
      awaitingPreload:  false,
      rotationStartTimer: null,      // holds the startup stagger setTimeout id
    });

    // Stagger initial loads by INITIAL_LOAD_STAGGER_MS (1.5 s apart) so all
    // five panels show content within a few seconds of launch.
    const timer = setTimeout(() => {
      const ps = panelStates.get(key);
      if (ps) ps.rotationStartTimer = null;
      startBrowsingLoop(key);
    }, i * INITIAL_LOAD_STAGGER_MS);

    panelStates.get(key).rotationStartTimer = timer;
  });
}

// ---- Exports ----------------------------------------------------------------

module.exports = {
  createKioskWindow,
  computeClusterLayout,
  getKioskWindows: () => [...panelWindows.values()],
};
