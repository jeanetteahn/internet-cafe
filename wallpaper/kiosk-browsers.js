const { BrowserWindow, BrowserView, screen, ipcMain } = require('electron');
const path = require('path');

// ---- Tunables -----------------------------------------------------------
// All 5 panels (center + 4 sides) behave identically: they auto-search
// through this list on their own while idle, and the instant a customer
// clicks or types into one, it stops rotating and becomes a normal browser
// for them to use — see attachActivityHandling() below for that logic.
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

const REFRESH_MS = 4 * 60 * 1000; // how often an idle panel jumps to its next search
const STAGGER_MS = 20 * 1000; // stagger initial idle starts across the 5 panels

// How long a panel waits with no clicks/typing before it goes back to
// auto-searching on its own after a customer was using it.
const INACTIVITY_TIMEOUT_MS = 2.5 * 60 * 1000;

// Panel sizes in pixels (not fractions of the screen) — the cluster's own
// bounding box is computed from these, and the window is sized to exactly
// that, so there's no window content outside the cross shape other than
// its transparent corners (see createKioskWindow).
const PANEL_SIZES = {
  center: { w: 640, h: 480 },
  side: { w: 420, h: 320 },
  gap: 24,
};
// ---------------------------------------------------------------------------

// Module-level reference to the kiosk window. This is NOT optional
// bookkeeping — without it, the BrowserWindow created in
// createKioskWindow() is only reachable from that function's own local
// `win` variable, which V8 is free to garbage-collect the moment the
// function returns (nothing else in the JS object graph points at `win`
// itself; the BrowserViews attached to it are kept alive separately by
// the panelStates/ipcMain closures, but that doesn't save the window).
// Electron's docs call this out explicitly: a BrowserWindow with no
// remaining JS reference gets destroyed automatically by GC, silently,
// with no 'closed' event you'd notice as an error.
//
// That's exactly the bug this project hit on the NucBox: kiosk-main.js
// called `createKioskWindow();` and discarded the return value, so once
// GC ran (usually a handful of seconds after launch — hence `ps aux`
// checks done quickly after launch still showed the process "working"),
// the window was destroyed. `window-all-closed` is a deliberate no-op in
// kiosk-main.js (see its comment), so the process didn't quit either —
// it just sat there alive and doing nothing, which is why the kiosk
// process always showed up in `ps aux` while never actually appearing on
// screen, regardless of transparency, position, or timing. Keeping this
// module-level reference is what fixes it; do not remove it or make
// createKioskWindow() the only thing holding onto `win`.
let kioskWindow = null;

function computeClusterLayout() {
  const { center, side, gap } = PANEL_SIZES;
  const totalWidth = side.w + gap + center.w + gap + side.w;
  const totalHeight = side.h + gap + center.h + gap + side.h;

  const centerX = side.w + gap;
  const centerY = side.h + gap;

  return {
    totalWidth,
    totalHeight,
    center: { x: centerX, y: centerY, width: center.w, height: center.h },
    top: {
      x: centerX + (center.w - side.w) / 2,
      y: 0,
      width: side.w,
      height: side.h,
    },
    bottom: {
      x: centerX + (center.w - side.w) / 2,
      y: centerY + center.h + gap,
      width: side.w,
      height: side.h,
    },
    left: {
      x: 0,
      y: centerY + (center.h - side.h) / 2,
      width: side.w,
      height: side.h,
    },
    right: {
      x: centerX + center.w + gap,
      y: centerY + (center.h - side.h) / 2,
      width: side.w,
      height: side.h,
    },
  };
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

/**
 * Creates the kiosk window: a normal, focusable window (unlike the
 * wallpaper windows in main.js, which are deliberately non-interactive) —
 * this is the one part of the app customers actually click into and use.
 * Sized to exactly the 5-panel cross cluster's bounding box and centered
 * on the primary display, with `transparent: true` so the video wallpaper
 * shows through the four corner gaps the cross shape doesn't cover.
 *
 * Transparency needs a compositor running on the guest to render
 * correctly — Cinnamon (Mint's default) has one on by default via
 * Muffin, so this should just work there. On a window manager with no
 * compositor, the gaps would show solid black instead of the video
 * showing through — a cosmetic downgrade, not a broken app.
 */
function createKioskWindow() {
  const layout = computeClusterLayout();
  const primary = screen.getPrimaryDisplay();
  const x = primary.bounds.x + Math.round((primary.bounds.width - layout.totalWidth) / 2);
  const y = primary.bounds.y + Math.round((primary.bounds.height - layout.totalHeight) / 2);

  const win = new BrowserWindow({
    x,
    y,
    width: layout.totalWidth,
    height: layout.totalHeight,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const panels = {
    center: makePanelView(),
    top: makePanelView(),
    bottom: makePanelView(),
    left: makePanelView(),
    right: makePanelView(),
  };

  Object.entries(panels).forEach(([key, view]) => {
    win.addBrowserView(view);
    view.setBounds(layout[key]);
  });

  attachActivityHandling(panels);
  startAllIdleRotation(panels);

  // Keep the strong reference alive for the life of the process (see the
  // comment on the module-level `kioskWindow` declaration above), and
  // drop it once the window is actually, deliberately closed so it can
  // be GC'd normally at that point instead of leaking forever.
  kioskWindow = win;
  win.on('closed', () => {
    if (kioskWindow === win) kioskWindow = null;
  });

  return win;
}

function attachActivityHandling(panels) {
  // Map each panel's webContents id back to its key, so the shared
  // 'panel-activity' IPC channel (see kiosk-preload.js) can tell which
  // specific panel a click/keypress came from.
  const webContentsIdToKey = new Map();
  Object.entries(panels).forEach(([key, view]) => {
    webContentsIdToKey.set(view.webContents.id, key);
  });

  ipcMain.on('panel-activity', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (!key) return; // activity from some other window/panel — ignore

    const state = panelStates.get(key);
    if (!state) return;

    if (state.mode === 'auto') {
      stopIdleRotation(panels, key);
      state.mode = 'active';
    }

    // Any further activity resets the "how long until we resume
    // auto-search" clock, so an actively-browsing customer never gets
    // interrupted mid-use.
    clearTimeout(state.inactivityTimer);
    state.inactivityTimer = setTimeout(() => {
      startIdleRotation(panels, key);
    }, INACTIVITY_TIMEOUT_MS);
  });
}

const panelStates = new Map();

function startAllIdleRotation(panels) {
  const order = ['center', 'top', 'right', 'bottom', 'left'];
  order.forEach((key, i) => {
    panelStates.set(key, { mode: 'auto', rotationIndex: i, intervalId: null, inactivityTimer: null });
    setTimeout(() => startIdleRotation(panels, key), i * STAGGER_MS);
  });
}

function startIdleRotation(panels, key) {
  const state = panelStates.get(key);
  const view = panels[key];
  if (!state || !view) return;

  clearTimeout(state.inactivityTimer);
  state.mode = 'auto';

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

function stopIdleRotation(panels, key) {
  const state = panelStates.get(key);
  if (!state) return;
  clearInterval(state.intervalId);
  state.intervalId = null;
}

module.exports = {
  createKioskWindow,
  computeClusterLayout,
  getKioskWindow: () => kioskWindow,
};
