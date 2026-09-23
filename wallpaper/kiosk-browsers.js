const { BrowserWindow, BrowserView, screen, ipcMain } = require('electron');
const path = require('path');

// ---- Tunables ---------------------------------------------------------------
// All 5 panels (hub + 4 corners) behave identically: they auto-search
// through this list on their own while idle, and the instant a customer
// clicks, types, or drags a panel, it stops rotating and becomes a normal
// browser for them — see notePanelActivity() below for that logic.
const SEARCH_TERMS = [
  'weather today',
  'local news',
  'space news',
  'technology news',
  'science news',
  'world news',
];

function buildSearchUrl(term) {
  // DuckDuckGo's no-JS HTML endpoint — far more tolerant of repeated
  // automated requests than a JS-heavy results page from Google/Bing,
  // though "tolerant" isn't the same as "immune." Keep REFRESH_MS
  // conservative rather than pushing it much below a few minutes.
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(term)}`;
}

const REFRESH_MS          = 4 * 60 * 1000; // how often an idle panel jumps to its next search
const STAGGER_MS          = 20 * 1000;      // stagger initial idle starts across the 5 panels
const INACTIVITY_TIMEOUT_MS = 2.5 * 60 * 1000; // idle grace period before auto-search resumes

const HANDLE_HEIGHT        = 28;   // px — height of the draggable title strip on each panel
const RETURN_HOME_WHEN_IDLE = true; // move a panel back to its home position when it goes idle
const MIN_VISIBLE_PX       = 120;  // minimum px of the drag strip that must stay on-screen

// ---- Module-level state (GC protection + shared between helper functions) ---
//
// Every panel window is kept in panelWindows so V8 can never garbage-collect
// it while the process is alive.  Without a surviving JS reference, a
// BrowserWindow is silently destroyed by the GC — no error, no 'closed'
// event you'd notice.  That's exactly the bug this project hit on the
// NucBox5: kiosk-main.js used to call createKioskWindow() and discard the
// return value, and the window vanished a few seconds later while the
// process appeared fully alive in `ps aux`.  See README for the full story.
// Do not remove these module-level Maps or make createKioskWindow() the only
// thing holding panel-window references.
const panelWindows    = new Map(); // key -> BrowserWindow
const homeBounds      = new Map(); // key -> { x, y, width, height }
const panelViews      = {};        // key -> BrowserView (for rotation + activity)
const panelStates     = new Map(); // key -> { mode, rotationIndex, intervalId, inactivityTimer }

// Truthy while a programmatic setBounds is in flight for a given panel.
// The 'move' event debounce handler checks this to avoid mistaking a
// clamping or send-home move for a customer drag.
const ignoreNextMoves = new Map(); // key -> timeout-id | null

// ---- Layout -----------------------------------------------------------------

function computeClusterLayout(screenW, screenH) {
  // Cluster fills 88 % × 82 % of the display so the full layout fits on
  // screen with margin.  Panels overlap on purpose (pinwheel arrangement);
  // z-order — hub behind the four corner windows — controls what's visible
  // in each overlap region.
  const W = Math.round((screenW || 1920) * 0.88);
  const H = Math.round((screenH || 1080) * 0.82);

  const defs = {
    hub:         { rx: 0.20, ry: 0.24, rw: 0.57, rh: 0.52 },
    topLeft:     { rx: 0.03, ry: 0.10, rw: 0.39, rh: 0.40 },
    topRight:    { rx: 0.59, ry: 0.05, rw: 0.39, rh: 0.43 },
    bottomLeft:  { rx: 0.09, ry: 0.53, rw: 0.39, rh: 0.39 },
    bottomRight: { rx: 0.78, ry: 0.51, rw: 0.19, rh: 0.41 },
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

// ---- Programmatic move helpers ----------------------------------------------

// Call this instead of win.setBounds() for any move we initiate ourselves
// (clamping, send-home).  Sets the ignoreNextMoves flag so the 'move' event
// debounce handler doesn't treat the resulting OS move events as customer
// drags.  The flag clears itself after 400 ms — long enough to outlast the
// sequence of 'move' events that a single setBounds() call can produce.
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

// After any customer drag, clamp the window so at least MIN_VISIBLE_PX of
// the drag strip remains horizontally on screen and the strip stays
// vertically on screen (so the customer can always grab it again).
function clampToPrimary(key) {
  const win = panelWindows.get(key);
  if (!win || win.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const { x, y, width, height } = win.getBounds();

  // Horizontal: window may slide off-screen, but at least MIN_VISIBLE_PX
  // of its width must remain visible on each side.
  const cx = Math.max(
    workArea.x - width + MIN_VISIBLE_PX,
    Math.min(x, workArea.x + workArea.width - MIN_VISIBLE_PX)
  );
  // Vertical: the drag strip (HANDLE_HEIGHT px) must remain fully on-screen
  // so the customer can always re-grab the panel.
  const cy = Math.max(
    workArea.y,
    Math.min(y, workArea.y + workArea.height - HANDLE_HEIGHT)
  );

  if (cx !== x || cy !== y) {
    setPanelBoundsIgnored(key, { x: cx, y: cy, width, height });
  }
}

// ---- Activity ---------------------------------------------------------------

// Central activity handler — called from IPC (kiosk-preload.js click/keypress
// in the panel view), the 'move' debounce (customer drag), and the reset-
// position IPC.  Stops idle rotation if running, resets the inactivity clock.
function notePanelActivity(key) {
  const state = panelStates.get(key);
  if (!state) return;

  if (state.mode === 'auto') {
    stopIdleRotation(key);
    state.mode = 'active';
  }

  clearTimeout(state.inactivityTimer);
  state.inactivityTimer = setTimeout(() => {
    if (RETURN_HOME_WHEN_IDLE) sendPanelHome(key);
    startIdleRotation(key);
  }, INACTIVITY_TIMEOUT_MS);
}

// ---- Window creation --------------------------------------------------------

/**
 * Creates five independent, movable panel windows — one per kiosk panel
 * (hub, topLeft, topRight, bottomLeft, bottomRight).  Each window is a
 * frameless, opaque BrowserWindow with a 28 px drag strip (kiosk-handle.html)
 * at the top and the panel's BrowserView content below it.  Panels are opaque
 * (#1a1a1a background) so no compositor is required on the host.
 *
 * Hub is created first, so it sits behind the four corner windows wherever
 * the pinwheel layout causes them to overlap.
 *
 * Returns an array of the five BrowserWindow instances.  Callers should store
 * this array — belt-and-suspenders against GC alongside the module-level
 * panelWindows Map.  See the README's "Known bug" section for why both
 * references matter.
 */
function createKioskWindow() {
  const primary = screen.getPrimaryDisplay();
  const { workArea } = primary;
  const layout = computeClusterLayout(workArea.width, workArea.height);
  const originX = workArea.x + Math.round((workArea.width  - layout.totalWidth)  / 2);
  const originY = workArea.y + Math.round((workArea.height - layout.totalHeight) / 2);

  // Hub first → lowest z-order; corner panels added after appear on top.
  const order = ['hub', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'];

  for (const key of order) {
    const pLayout = layout[key];
    const winW    = pLayout.width;
    const winH    = pLayout.height + HANDLE_HEIGHT;
    const homeX   = originX + pLayout.x;
    const homeY   = originY + pLayout.y;

    const bounds = { x: homeX, y: homeY, width: winW, height: winH };
    homeBounds.set(key, bounds);

    const win = new BrowserWindow({
      x: homeX,
      y: homeY,
      width:  winW,
      height: winH,
      frame:       false,
      resizable:   false,
      movable:     true,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#1a1a1a', // opaque — no compositor required
      webPreferences: {
        preload: path.join(__dirname, 'kiosk-handle-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.loadFile(path.join(__dirname, 'kiosk-handle.html'));

    // Attach the panel content below the drag strip.
    const view = makePanelView();
    win.addBrowserView(view);
    view.setBounds({ x: 0, y: HANDLE_HEIGHT, width: winW, height: winH - HANDLE_HEIGHT });
    view.setAutoResize({ width: true, height: true });

    // Forward the panel page's title to the drag strip.
    view.webContents.on('page-title-updated', (_e, title) => {
      if (!win.isDestroyed()) win.webContents.send('panel-title', title);
    });

    panelViews[key]  = view;
    panelWindows.set(key, win);

    // Drag clamping: debounce 'move' events (the only drag event on Linux)
    // so we only clamp once per finished drag, not on every pixel.
    let moveDebounce = null;
    win.on('move', () => {
      if (ignoreNextMoves.get(key)) return; // programmatic move — skip
      clearTimeout(moveDebounce);
      moveDebounce = setTimeout(() => {
        notePanelActivity(key);
        clampToPrimary(key);
      }, 250);
    });

    win.on('closed', () => {
      panelWindows.delete(key);
      homeBounds.delete(key);
    });
  }

  attachActivityHandling();
  startAllIdleRotation();

  return order.map(key => panelWindows.get(key));
}

// ---- IPC activity handling --------------------------------------------------

function attachActivityHandling() {
  // Map both the panel view's webContents id AND the handle window's
  // webContents id to the panel key, so IPC messages from either context
  // resolve to the right panel.
  const webContentsIdToKey = new Map();
  for (const [key, view] of Object.entries(panelViews)) {
    webContentsIdToKey.set(view.webContents.id, key);
  }
  for (const [key, win] of panelWindows) {
    webContentsIdToKey.set(win.webContents.id, key);
  }

  // Sent by kiosk-preload.js on any click/keypress inside a panel view.
  ipcMain.on('panel-activity', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (key) notePanelActivity(key);
  });

  // Sent by kiosk-handle-preload.js when the customer clicks "Reset position".
  ipcMain.on('panel-reset-position', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (key) sendPanelHome(key);
  });
}

// ---- Idle rotation ----------------------------------------------------------

function startAllIdleRotation() {
  const order = ['hub', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
  order.forEach((key, i) => {
    panelStates.set(key, {
      mode: 'auto',
      rotationIndex: i,
      intervalId: null,
      inactivityTimer: null,
    });
    setTimeout(() => startIdleRotation(key), i * STAGGER_MS);
  });
}

function startIdleRotation(key) {
  const state = panelStates.get(key);
  const view  = panelViews[key];
  if (!state || !view) return;

  // Clear any existing interval before starting a new one — prevents
  // double-up rotation if startIdleRotation is called while already running
  // (e.g., two inactivity timers firing in quick succession).
  clearInterval(state.intervalId);
  clearTimeout(state.inactivityTimer);
  state.mode          = 'auto';
  state.inactivityTimer = null;

  const load = () => {
    const term = SEARCH_TERMS[state.rotationIndex % SEARCH_TERMS.length];
    view.webContents.loadURL(buildSearchUrl(term)).catch(() => {
      /* transient network/DNS errors are fine to ignore here */
    });
    state.rotationIndex += 1;
  };

  load();
  state.intervalId = setInterval(load, REFRESH_MS);
}

function stopIdleRotation(key) {
  const state = panelStates.get(key);
  if (!state) return;
  clearInterval(state.intervalId);
  state.intervalId = null;
}

// ---- Exports ----------------------------------------------------------------

module.exports = {
  createKioskWindow,
  computeClusterLayout,
  getKioskWindows: () => [...panelWindows.values()],
};
