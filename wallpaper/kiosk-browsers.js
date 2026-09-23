const { BrowserWindow, BrowserView, screen, ipcMain, globalShortcut, session } = require('electron');
const path = require('path');

// ---- Tunables ---------------------------------------------------------------
// All 5 panels (hub + 4 corners) behave identically: they auto-search
// through this list on their own while idle, and the instant a customer
// clicks, types, drags, or resizes a panel, it stops rotating and becomes a
// normal browser for them — see notePanelActivity() below for that logic.
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

const REFRESH_MS              = 4 * 60 * 1000; // how often an idle panel cycles to its next search
const STAGGER_MS              = 20 * 1000;      // spread between each panel's ongoing rotation cycle
// Startup-only stagger: panels show content within a few seconds of launch.
// STAGGER_MS still controls the offset between ongoing 4-minute cycles so
// all five panels don't hit DuckDuckGo at the same moment.
const INITIAL_LOAD_STAGGER_MS = 1500;
const INACTIVITY_TIMEOUT_MS   = 2.5 * 60 * 1000; // idle grace period before auto-search resumes

const HANDLE_HEIGHT         = 28;   // px — height of the draggable title strip on each panel
const RETURN_HOME_WHEN_IDLE = true; // send panel back to home position when it goes idle
const MIN_VISIBLE_PX        = 120;  // minimum px of the drag strip that must stay on-screen

const GRIP_SIZE             = 18;  // px — width/height of the bottom-right resize grip square
const MIN_PANEL_WIDTH       = 320; // px — minimum panel window width
const MIN_PANEL_HEIGHT      = 220; // px — minimum panel window height (includes the drag strip)

// "Loading..." placeholder shown immediately in each panel so customers never
// see a dark empty box while the first network request is in flight.
const PLACEHOLDER_URL = 'data:text/html,' + encodeURIComponent(
  '<body style="margin:0;background:#1a1a1a;color:#555;' +
  'font:14px/1 sans-serif;display:flex;align-items:center;' +
  'justify-content:center;height:100vh">Loading…</body>'
);

// ---- Startup timing ---------------------------------------------------------
// Set at the top of createKioskWindow(); used by [kiosk-timing] console logs.
// Grep for [kiosk-timing] on the NucBox5 to measure improvements.
let _t0 = 0;
const timingMs = () => Date.now() - _t0;
const firstLoadLogged = new Set(); // panels whose first real page load has been logged

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
const gripViews       = {};        // key -> BrowserView (the resize grip overlay)
const panelStates     = new Map(); // key -> { mode, rotationIndex, intervalId, inactivityTimer }

// Truthy while a programmatic setBounds is in flight for a given panel.
// The 'move' event debounce handler checks this to avoid mistaking a
// clamping, send-home, or resize-update move for a customer drag.
const ignoreNextMoves = new Map(); // key -> timeout-id | null

// Active resize drag state per panel.
const resizeState     = new Map(); // key -> { startBounds, cornerDx, cornerDy } | null

// ---- Layout -----------------------------------------------------------------

function computeClusterLayout(screenW, screenH) {
  // Cluster fills 88 % × 82 % of the display so the full layout fits on
  // screen with margin.  Panels overlap on purpose (pinwheel arrangement);
  // z-order is managed in createKioskWindow: hub is created first (so it
  // starts below the corners) then moved to the front with moveTop() after
  // all five windows exist, so hub sits on top in each overlap region.
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

// ---- Programmatic move/resize helpers ---------------------------------------

// Call this instead of win.setBounds() for any bounds change we initiate
// ourselves (clamping, send-home, resize updates).  Sets the ignoreNextMoves
// flag so the 'move' event debounce handler doesn't treat the resulting OS
// events as customer drags.  The flag clears itself after 400 ms — long enough
// to outlast the 'move' events a single setBounds() call can produce.
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
// Uses the display the panel is currently on (not always the primary) so
// that a panel on a secondary monitor via KIOSK_DISPLAY clamps correctly.
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

// Minimum size for a panel: the smaller of the fixed constants and that
// panel's home size.  On small screens (e.g. 1366 × 768) some panels start
// narrower than MIN_PANEL_WIDTH; using a hard floor would stop reset from
// ever restoring the original size.
function minSizeFor(key) {
  const home = homeBounds.get(key);
  return {
    width:  home ? Math.min(MIN_PANEL_WIDTH,  home.width)  : MIN_PANEL_WIDTH,
    height: home ? Math.min(MIN_PANEL_HEIGHT, home.height) : MIN_PANEL_HEIGHT,
  };
}

// Pin the grip view to the bottom-right corner of its window.  Called once
// at creation and again on every 'resize' event.
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
  // Clamp the in-grip offset so a press right at the edge doesn't produce a
  // wildly wrong corner distance.
  const ox = Math.max(0, Math.min(GRIP_SIZE, offset.x));
  const oy = Math.max(0, Math.min(GRIP_SIZE, offset.y));
  // Store the fixed distance from the press point to the window's
  // bottom-right corner.  We do NOT record the cursor's screen position here:
  // by the time this IPC message arrives the cursor may have already moved,
  // and recording it would cause the first drag movement to be lost.
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

  // cursor.x + cornerDx is the desired right edge of the window.
  // The top-left corner stays fixed at startBounds.x / startBounds.y.
  let newW = cursor.x + cornerDx - startBounds.x;
  let newH = cursor.y + cornerDy - startBounds.y;

  newW = Math.max(minSize.width,  newW);
  newH = Math.max(minSize.height, newH);

  // Don't let the window extend past the right or bottom of the work area.
  newW = Math.min(newW, workArea.x + workArea.width  - startBounds.x);
  newH = Math.min(newH, workArea.y + workArea.height - startBounds.y);

  setPanelBoundsIgnored(key, {
    x:      startBounds.x,
    y:      startBounds.y,
    width:  Math.round(newW),
    height: Math.round(newH),
  });
}

function endResize(key) {
  updateResize(key);
  resizeState.set(key, null);
  notePanelActivity(key);
}

// ---- Activity ---------------------------------------------------------------

// Central activity handler — called from IPC (kiosk-preload.js click/keypress
// in the panel view), the 'move' debounce (customer drag), resize start/end,
// and the reset IPC.  Stops idle rotation if running, resets the inactivity
// clock.
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
 * Creates five independent, movable, resizable panel windows — one per kiosk
 * panel (hub, topLeft, topRight, bottomLeft, bottomRight).  Each window is a
 * frameless, opaque BrowserWindow with:
 *   - a 28 px drag strip (kiosk-handle.html) at the top
 *   - the panel's BrowserView content below it
 *   - an 18 × 18 px resize grip (kiosk-resize-grip.html) overlaid on the
 *     bottom-right corner
 *
 * Panels are opaque (#1a1a1a background) so no compositor is required.
 * Hub is created first, so it sits behind the four corner windows wherever
 * the pinwheel layout causes them to overlap.
 *
 * Returns an array of the five BrowserWindow instances.  Callers should store
 * this array — belt-and-suspenders against GC alongside the module-level
 * panelWindows Map.  See the README's "Known bug" section for why both
 * references matter.
 */
function createKioskWindow() {
  _t0 = Date.now();
  // Warm the DNS + TCP connection to DuckDuckGo before any panel navigates,
  // shaving time off the first real loadURL call on a cold NucBox5.
  session.defaultSession.preconnect({ url: 'https://html.duckduckgo.com' });

  // Determine which display to host the cluster on.  KIOSK_DISPLAY is a
  // 0-based index into screen.getAllDisplays(); falls back to the primary
  // display when the variable is absent or out of range.
  const allDisplays = screen.getAllDisplays();
  const envIndex    = parseInt(process.env.KIOSK_DISPLAY, 10);
  const kioskDisplay = (Number.isFinite(envIndex) && envIndex >= 0 && envIndex < allDisplays.length)
    ? allDisplays[envIndex]
    : screen.getPrimaryDisplay();

  const { workArea } = kioskDisplay;
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
      // resizable: true is required so that programmatic setBounds() is
      // honoured on all platforms.  Resizing is driven entirely by the custom
      // grip; native window-manager edge dragging is not relied on (it's
      // unreliable for frameless windows on Cinnamon, and the BrowserView
      // covers the edges anyway).
      resizable:   true,
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

    // Store in panelWindows early — positionGrip and event listeners need it.
    panelWindows.set(key, win);
    console.log(`[kiosk-timing] ${key} window created: +${timingMs()} ms`);

    // Native minimum: belt-and-suspenders alongside the custom grip's clamp.
    // Uses minSizeFor() which caps at the home size, so small-screen panels
    // never get a native minimum that exceeds their home dimensions.
    const minSize = minSizeFor(key);
    win.setMinimumSize(minSize.width, minSize.height);

    win.loadFile(path.join(__dirname, 'kiosk-handle.html'));

    // Attach the panel content below the drag strip.
    const view = makePanelView();
    win.addBrowserView(view);
    view.setBounds({ x: 0, y: HANDLE_HEIGHT, width: winW, height: winH - HANDLE_HEIGHT });
    view.setAutoResize({ width: true, height: true });

    // Show a "Loading…" placeholder immediately so panels never look like
    // empty dark boxes while waiting for the first network request.
    view.webContents.loadURL(PLACEHOLDER_URL);

    // Timing: log the first real page load per panel.  Skip the data: URL
    // placeholder — getURL() returns the current URL when the event fires.
    view.webContents.on('did-finish-load', () => {
      if (!firstLoadLogged.has(key) && !view.webContents.getURL().startsWith('data:')) {
        firstLoadLogged.add(key);
        console.log(`[kiosk-timing] ${key} did-finish-load: +${timingMs()} ms`);
      }
    });

    // Forward the panel page's title to the drag strip.
    view.webContents.on('page-title-updated', (_e, title) => {
      if (!win.isDestroyed()) win.webContents.send('panel-title', title);
    });

    panelViews[key] = view;

    // Resize grip — added AFTER the panel view so it sits on top of the
    // page content in the bottom-right corner.
    const grip = makeGripView();
    win.addBrowserView(grip);
    grip.webContents.loadFile(path.join(__dirname, 'kiosk-resize-grip.html'));
    gripViews[key] = grip;
    positionGrip(key);

    // Keep the grip pinned to the corner as the window size changes.
    win.on('resize', () => positionGrip(key));

    // Drag clamping: debounce 'move' events (the only drag event on Linux)
    // so we only clamp once per finished drag, not on every pixel.
    let moveDebounce = null;
    win.on('move', () => {
      if (ignoreNextMoves.get(key)) return; // programmatic move — skip
      clearTimeout(moveDebounce);
      moveDebounce = setTimeout(() => {
        notePanelActivity(key);
        clampToDisplay(key);
      }, 250);
    });

    win.on('closed', () => {
      panelWindows.delete(key);
      homeBounds.delete(key);
      delete gripViews[key];
      resizeState.delete(key);
    });
  }

  // Re-stack hub on top now that all five windows exist. Hub was created
  // first (lowest z-order) so the corners could be layered above it during
  // construction; moveTop() reverses that, making hub the frontmost panel.
  const hubWin = panelWindows.get('hub');
  if (hubWin && !hubWin.isDestroyed()) hubWin.moveTop();

  attachActivityHandling();
  startAllIdleRotation();

  // Dev-only tuning aid: Ctrl+Alt+D dumps the current panel positions and
  // sizes as ready-to-paste fractions in the shape computeClusterLayout's
  // defs block expects.  Drag/resize panels to taste, hit the shortcut,
  // and copy-paste the output straight over the existing defs.
  //
  // Remove this shortcut — along with the drag strip (kiosk-handle.html),
  // the Reset button, and the resize grip (kiosk-resize-grip.html) — once
  // the layout is finalized for production.
  const dumpRegistered = globalShortcut.register('Control+Alt+D', () => {
    const lines = order.map(key => {
      const win = panelWindows.get(key);
      if (!win || win.isDestroyed()) return `    ${key}: (window gone)`;
      const { x, y, width, height } = win.getBounds();
      const rx = ((x - originX) / layout.totalWidth ).toFixed(3);
      const ry = ((y - originY) / layout.totalHeight).toFixed(3);
      const rw = (width              / layout.totalWidth ).toFixed(3);
      // rh is the content height (strip excluded) so it pastes back correctly.
      const rh = ((height - HANDLE_HEIGHT) / layout.totalHeight).toFixed(3);
      const pad = ' '.repeat(12 - key.length); // align '{' with bottomRight
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
  // Map each context's webContents id to its panel key: the panel view
  // (kiosk-preload.js), the handle window (kiosk-handle-preload.js), and the
  // grip view (kiosk-resize-preload.js) — so IPC from any of the three reaches
  // the right panel.
  const webContentsIdToKey = new Map();
  for (const [key, view] of Object.entries(panelViews)) {
    webContentsIdToKey.set(view.webContents.id, key);
  }
  for (const [key, win] of panelWindows) {
    webContentsIdToKey.set(win.webContents.id, key);
  }
  for (const [key, grip] of Object.entries(gripViews)) {
    webContentsIdToKey.set(grip.webContents.id, key);
  }

  // Sent by kiosk-preload.js on any click/keypress inside a panel view.
  ipcMain.on('panel-activity', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (key) notePanelActivity(key);
  });

  // Sent by kiosk-handle-preload.js when the customer clicks "Reset".
  ipcMain.on('panel-reset-position', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (key) sendPanelHome(key);
  });

  // Resize IPC from kiosk-resize-preload.js.
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

// ---- Idle rotation ----------------------------------------------------------

function startAllIdleRotation() {
  const order = ['hub', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
  order.forEach((key, i) => {
    panelStates.set(key, {
      mode: 'auto',
      rotationIndex: i,
      intervalId: null,
      inactivityTimer: null,
      rotationStartTimer: null,
    });
    // INITIAL_LOAD_STAGGER_MS: fast stagger so all five panels show content
    // within a few seconds of launch.  i * STAGGER_MS is passed as a rotation
    // offset so the ongoing 4-minute cycles remain spread across panels and
    // don't burst DuckDuckGo together on every cycle.
    setTimeout(() => startIdleRotation(key, i * STAGGER_MS), i * INITIAL_LOAD_STAGGER_MS);
  });
}

// rotationOffset: additional delay before the repeating setInterval fires.
// Used only at startup (from startAllIdleRotation) to keep ongoing 4-minute
// cycles spread across panels.  Omit (defaults to 0) when resuming after
// customer inactivity — the interval should start immediately in that case.
function startIdleRotation(key, rotationOffset = 0) {
  const state = panelStates.get(key);
  const view  = panelViews[key];
  if (!state || !view) return;

  // Clear all timers before starting fresh — prevents double-up rotation if
  // startIdleRotation fires while already running (e.g., two inactivity
  // timers in quick succession) or while a startup offset is still pending.
  clearInterval(state.intervalId);
  clearTimeout(state.inactivityTimer);
  clearTimeout(state.rotationStartTimer);
  state.mode             = 'auto';
  state.intervalId       = null;
  state.inactivityTimer  = null;
  state.rotationStartTimer = null;

  const load = () => {
    const term = SEARCH_TERMS[state.rotationIndex % SEARCH_TERMS.length];
    if (!firstLoadLogged.has(key)) {
      console.log(`[kiosk-timing] ${key} first loadURL: +${timingMs()} ms`);
    }
    view.webContents.loadURL(buildSearchUrl(term)).catch(() => {
      /* transient network/DNS errors are fine to ignore here */
    });
    state.rotationIndex += 1;
  };

  load();

  if (rotationOffset > 0) {
    // Delay the interval so cycles fire REFRESH_MS after the offset point,
    // keeping multi-panel refreshes spread across time.  The first load above
    // already happened; only the rhythm of subsequent loads is offset here.
    state.rotationStartTimer = setTimeout(() => {
      state.rotationStartTimer = null;
      if (state.mode === 'auto' && !state.intervalId) {
        state.intervalId = setInterval(load, REFRESH_MS);
      }
    }, rotationOffset);
  } else {
    state.intervalId = setInterval(load, REFRESH_MS);
  }
}

function stopIdleRotation(key) {
  const state = panelStates.get(key);
  if (!state) return;
  clearInterval(state.intervalId);
  clearTimeout(state.rotationStartTimer);
  state.intervalId = null;
  state.rotationStartTimer = null;
}

// ---- Exports ----------------------------------------------------------------

module.exports = {
  createKioskWindow,
  computeClusterLayout,
  getKioskWindows: () => [...panelWindows.values()],
};
