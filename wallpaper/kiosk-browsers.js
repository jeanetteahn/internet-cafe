const { BrowserWindow, BrowserView, screen, ipcMain, globalShortcut, session } = require('electron');
const path = require('path');

// ---- Search topics ----------------------------------------------------------
// Kid-friendly only.  Panels cycle through the list in order, staggered so
// all five show different topics at launch.
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
// ALLOWED_DOMAINS is checked in did-navigate while a panel is in active
// (customer) mode — if a redirect lands somewhere off this list the panel
// returns to a DuckDuckGo search.  Auto mode never leaves DuckDuckGo at all
// (the will-navigate guard below blocks it), so the list has no effect there.
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

// ---- Tunables ---------------------------------------------------------------
// A results page stays visible until the bottom is reached, then BOTTOM_HOLD_MS
// elapses before the next search.  SEARCH_INTERVAL_MS is a safety-net ceiling
// in case the bottom is never detected (very long or dynamic page).
const SEARCH_INTERVAL_MS     = 45 * 1000; // max time on a results page
const MIN_SEARCH_INTERVAL_MS = 20 * 1000; // min time between searches per panel — guards against DDG rate-limiting when pages are very short
const BOTTOM_HOLD_MS         = 3_000;     // pause at the page bottom before advancing to the next search
const SCROLL_STEP_PX         = 80;        // px scrolled per tick
const SCROLL_STEP_MS         = 250;       // ms between scroll ticks
const INACTIVITY_TIMEOUT_MS  = 90 * 1000; // idle grace period before auto mode resumes

// ---- Window / layout tunables -----------------------------------------------
const HANDLE_HEIGHT         = 28;
const RETURN_HOME_WHEN_IDLE = true;
const MIN_VISIBLE_PX        = 120;
const GRIP_SIZE             = 18;
const MIN_PANEL_WIDTH       = 320;
const MIN_PANEL_HEIGHT      = 220;
const INITIAL_LOAD_STAGGER_MS = 1500;

// "Loading…" placeholder shown immediately so panels are never a dark box.
const PLACEHOLDER_URL = 'data:text/html,' + encodeURIComponent(
  '<body style="margin:0;background:#1a1a1a;color:#555;' +
  'font:14px/1 sans-serif;display:flex;align-items:center;' +
  'justify-content:center;height:100vh">Loading…</body>'
);

// ---- Startup timing ---------------------------------------------------------
let _t0 = 0;
const timingMs = () => Date.now() - _t0;
const firstLoadLogged = new Set();

// ---- Module-level state (GC protection) ------------------------------------
//
// All BrowserWindows and BrowserViews MUST live in module-level Maps/objects.
// Without a surviving JS reference, V8 silently destroys a BrowserWindow —
// the process stays alive but nothing renders.  See README for the full
// post-mortem.  Do NOT remove these Maps.
const panelWindows    = new Map(); // key -> BrowserWindow
const homeBounds      = new Map(); // key -> { x, y, width, height }
const panelViews      = {};        // key -> BrowserView (visible panel content)
const gripViews       = {};        // key -> BrowserView (resize grip overlay)
const panelStates     = new Map(); // key -> { mode, inactivityTimer, searchIndex,
                                   //          lastSearchTime, dwellTimer, scrollTimer, rotationStartTimer }
const ignoreNextMoves = new Map(); // key -> timeout-id | null
const resizeState     = new Map(); // key -> { startBounds, cornerDx, cornerDy } | null

// webContentsIdToKey is module-level (not scoped to attachActivityHandling)
// so it is available to any future code that needs to route IPC by view id.
const webContentsIdToKey = new Map();

// ---- Layout -----------------------------------------------------------------

function computeClusterLayout(screenW, screenH) {
  // Cluster fills 88 % × 82 % of the display so the full layout fits on
  // screen with margin.  Panels overlap on purpose (pinwheel arrangement);
  // z-order is managed in createKioskWindow: hub is created first then
  // brought to the front with moveTop() after all five windows exist.
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
  // &kp=1 enables DuckDuckGo strict SafeSearch.
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

// ---- Programmatic move/resize helpers ---------------------------------------

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

  const cursor    = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayMatching(win.getBounds());
  const { startBounds, cornerDx, cornerDy } = state;
  const minSize   = minSizeFor(key);

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
  const ps = panelStates.get(key);
  if (!ps) return;

  if (ps.mode === 'auto') {
    stopBrowsingLoop(key);
    ps.mode = 'active';
  }

  clearTimeout(ps.inactivityTimer);
  ps.inactivityTimer = setTimeout(() => {
    if (RETURN_HOME_WHEN_IDLE) sendPanelHome(key);
    ps.mode = 'auto';
    startBrowsingLoop(key);
  }, INACTIVITY_TIMEOUT_MS);
}

// ---- View event handler setup -----------------------------------------------

function setupViewEventHandlers(key, win, view) {
  view.webContents.on('page-title-updated', (_e, title) => {
    if (!win.isDestroyed()) win.webContents.send('panel-title', title);
  });

  view.webContents.on('did-finish-load', () => {
    const url = view.webContents.getURL();

    // [kiosk-timing] first real page per panel.
    if (!firstLoadLogged.has(key) && !url.startsWith('data:')) {
      firstLoadLogged.add(key);
      console.log(`[kiosk-timing] ${key} did-finish-load: +${timingMs()} ms`);
    }

    if (!url.startsWith('data:') && url !== 'about:blank') {
      const ps = panelStates.get(key);
      if (ps && ps.mode === 'auto') onSearchPageReady(key);
    }
  });

  view.webContents.on('did-fail-load', (_e, errorCode, _desc, failedUrl) => {
    if (errorCode === -3) return; // ERR_ABORTED — cancelled navigation, not a real error
    const ps = panelStates.get(key);
    if (!ps || ps.mode !== 'auto') return;
    if (!failedUrl || failedUrl.startsWith('data:')) return;
    console.log(`[kiosk-auto] ${key} load failed (${errorCode}): ${failedUrl}`);
    // Retry the same search after a brief pause.
    clearTimeout(ps.dwellTimer);
    ps.dwellTimer = setTimeout(() => {
      ps.dwellTimer = null;
      if (ps.mode === 'auto') doSearch(key);
    }, 5_000);
  });

  // Active-mode guard: if a customer-driven navigation lands somewhere off the
  // allowlist (e.g. a redirect chain from an approved site), send the panel
  // back to a DuckDuckGo search rather than leaving it there.
  view.webContents.on('did-navigate', (_e, url) => {
    if (!url || url.startsWith('data:') || url === 'about:blank') return;
    const ps = panelStates.get(key);
    if (!ps || ps.mode !== 'active') return; // only relevant while a customer is browsing

    try {
      const { hostname } = new URL(url);
      if (hostname === 'duckduckgo.com' || hostname.endsWith('.duckduckgo.com')) return;
    } catch { return; }

    if (isDomainAllowed(url)) return;

    console.log(`[kiosk-auto] ${key} active-mode redirect off-allowlist: ${url}`);
    const term = SEARCH_TERMS[ps.searchIndex % SEARCH_TERMS.length];
    view.webContents.loadURL(buildSearchUrl(term)).catch(() => {});
  });

  // Auto-mode navigation guard: block any page-initiated navigation whose
  // host is not duckduckgo.com while the panel is in auto mode.  This covers
  // meta-refresh, JavaScript redirects, and anything else a results page
  // might trigger.  webContents.loadURL() (used by doSearch) is exempt —
  // will-navigate does not fire for programmatic main-process loads.
  view.webContents.on('will-navigate', (event, url) => {
    const ps = panelStates.get(key);
    if (!ps || ps.mode !== 'auto') return;

    let allowed = false;
    try {
      const { hostname } = new URL(url);
      allowed = hostname === 'duckduckgo.com' || hostname.endsWith('.duckduckgo.com');
    } catch {}

    if (!allowed) {
      event.preventDefault();
      console.log(`[kiosk-auto] ${key} blocked auto-mode navigation: ${url}`);
    }
  });

  // Block window.open() / target="_blank" in all modes — new windows have no
  // place in a kiosk panel with no address bar or browser chrome.
  view.webContents.setWindowOpenHandler(({ url }) => {
    console.log(`[kiosk-auto] ${key} blocked window.open: ${url}`);
    return { action: 'deny' };
  });
}

// ---- Browsing loop (search-only) -------------------------------------------
//
// Auto mode shows DuckDuckGo result pages ONLY.  No link following, no pool,
// no preloading.  The flow per panel is:
//
//   doSearch → page loads → onSearchPageReady → startScrolling
//                                              → max-dwell timer (SEARCH_INTERVAL_MS)
//                                                    |
//              scroll tick detects bottom ──────────>|
//                                              stopScrolling
//                                              → hold BOTTOM_HOLD_MS (or MIN_SEARCH_INTERVAL_MS remainder)
//                                              → doSearch …

function startScrolling(key) {
  const ps = panelStates.get(key);
  if (!ps) return;
  stopScrolling(key);
  ps.scrollTimer = setInterval(async () => {
    if (ps.mode !== 'auto') { stopScrolling(key); return; }
    const view = panelViews[key];
    if (!view || view.webContents.isDestroyed()) return;

    let atBottom = false;
    try {
      // Scroll one step and return whether the page bottom has been reached.
      // executeJavaScript does NOT dispatch wheel events, so it cannot trigger
      // the isTrusted customer-activity check in kiosk-preload.js.
      atBottom = await view.webContents.executeJavaScript(`
        (function () {
          window.scrollBy(0, ${SCROLL_STEP_PX});
          return window.scrollY + window.innerHeight >= document.body.scrollHeight - 4;
        })()
      `, false);
    } catch {
      return; // page is navigating — skip tick
    }

    // By the time the await resolves the panel may have changed state.
    // ps.scrollTimer === null means stopBrowsingLoop already fired.
    if (!atBottom || ps.mode !== 'auto' || ps.scrollTimer === null) return;

    stopScrolling(key);
    clearTimeout(ps.dwellTimer); // cancel the max-dwell safety net
    ps.dwellTimer = null;

    // Never search sooner than MIN_SEARCH_INTERVAL_MS since the last search,
    // even when a page is very short.
    const sinceLastSearch = Date.now() - ps.lastSearchTime;
    const holdMs = Math.max(BOTTOM_HOLD_MS, MIN_SEARCH_INTERVAL_MS - sinceLastSearch);
    console.log(`[kiosk-auto] ${key} bottom reached, next search in ${Math.round(holdMs / 1000)} s`);

    ps.dwellTimer = setTimeout(() => {
      ps.dwellTimer = null;
      if (ps.mode === 'auto') doSearch(key);
    }, holdMs);
  }, SCROLL_STEP_MS);
}

function stopScrolling(key) {
  const ps = panelStates.get(key);
  if (!ps) return;
  clearInterval(ps.scrollTimer);
  ps.scrollTimer = null;
}

// Called after the visible view finishes loading a DuckDuckGo results page.
// Starts the scroll loop and arms a max-dwell safety net in case bottom
// detection never fires (e.g. very long or dynamically loading pages).
function onSearchPageReady(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;

  const url = panelViews[key]?.webContents.getURL() || '';
  console.log(`[kiosk-auto] ${key} search page ready: ${url}`);

  startScrolling(key);

  clearTimeout(ps.dwellTimer);
  ps.dwellTimer = setTimeout(() => {
    ps.dwellTimer = null;
    if (ps.mode !== 'auto') return;
    stopScrolling(key);
    doSearch(key);
  }, SEARCH_INTERVAL_MS);
}

function doSearch(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;

  ps.lastSearchTime = Date.now();

  const term = SEARCH_TERMS[ps.searchIndex % SEARCH_TERMS.length];
  ps.searchIndex += 1;

  const url = buildSearchUrl(term);
  console.log(`[kiosk-auto] ${key} search [${ps.searchIndex}]: "${term}"`);

  const view = panelViews[key];
  if (!view || view.webContents.isDestroyed()) return;

  view.webContents.loadURL(url).catch(err => {
    console.log(`[kiosk-auto] ${key} search load failed: ${err.message}`);
    clearTimeout(ps.dwellTimer);
    ps.dwellTimer = setTimeout(() => {
      ps.dwellTimer = null;
      if (ps.mode === 'auto') doSearch(key);
    }, 5_000);
  });
}

function startBrowsingLoop(key) {
  const ps = panelStates.get(key);
  if (!ps) return;
  stopBrowsingLoop(key);
  ps.mode = 'auto';
  doSearch(key);
}

// Clear all auto-mode timers.  Does NOT modify ps.mode — callers handle that.
function stopBrowsingLoop(key) {
  const ps = panelStates.get(key);
  if (!ps) return;
  clearTimeout(ps.dwellTimer);
  clearInterval(ps.scrollTimer);
  clearTimeout(ps.rotationStartTimer);
  ps.dwellTimer        = null;
  ps.scrollTimer       = null;
  ps.rotationStartTimer = null;
}

// ---- Window creation --------------------------------------------------------

/**
 * Creates five independent, movable, resizable panel windows — one per kiosk
 * panel (hub, topLeft, topRight, bottomLeft, bottomRight).  Each window has:
 *   - a 28 px drag strip (kiosk-handle.html) at the top
 *   - a BrowserView for panel content
 *   - an 18 × 18 px resize grip (kiosk-resize-grip.html) on the bottom-right
 *
 * Returns an array of the five BrowserWindow instances.  Callers should store
 * this array — belt-and-suspenders GC protection alongside panelWindows.
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

    // Panel content view.
    const view = makePanelView();
    win.addBrowserView(view);
    view.setBounds({ x: 0, y: HANDLE_HEIGHT, width: winW, height: winH - HANDLE_HEIGHT });
    view.setAutoResize({ width: true, height: true });
    view.webContents.loadURL(PLACEHOLDER_URL);
    panelViews[key] = view;
    setupViewEventHandlers(key, win, view);

    // Resize grip — added after the panel view so it stays on top.
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
      delete gripViews[key];
      resizeState.delete(key);
    });
  }

  // Re-stack hub on top now that all five windows exist.
  const hubWin = panelWindows.get('hub');
  if (hubWin && !hubWin.isDestroyed()) hubWin.moveTop();

  attachActivityHandling();
  startAllIdleRotation();

  // Dev-only layout dump: Ctrl+Alt+D prints current fractions as a
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
  webContentsIdToKey.clear();
  for (const [key, view] of Object.entries(panelViews)) {
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
    panelStates.set(key, {
      mode:               'auto',
      inactivityTimer:    null,
      searchIndex:        i,    // stagger topics: each panel starts on a different term
      lastSearchTime:     0,    // Date.now() of last doSearch call; 0 = never searched
      dwellTimer:         null, // next-search setTimeout
      scrollTimer:        null, // scroll setInterval
      rotationStartTimer: null, // startup stagger setTimeout
    });

    // Stagger first loads by INITIAL_LOAD_STAGGER_MS so all five panels show
    // content within a few seconds of launch without hammering DDG at once.
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
