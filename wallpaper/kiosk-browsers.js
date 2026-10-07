const { app, BrowserWindow, BrowserView, screen, ipcMain, globalShortcut, session } = require('electron');
const path = require('path');
const fs   = require('fs');

// DDG result cache — one HTML file per panel, loaded as the startup placeholder.
const cacheDir = path.join(app.getPath('userData'), 'ddg-cache');
try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (_) {}

// ---- Spoon cursor -----------------------------------------------------------
// Pre-computed once at module init so every renderer can get the same rule.
const _spoonSvg = fs.readFileSync(path.join(__dirname, 'assets/utensils/spoon-cursor.svg'), 'utf8')
  .replace(/<\?xml[^?]*\?>\n?/, '')
  .replace(/<defs>[\s\S]*?<\/defs>\n?/, '')
  .replace(/\s+id="[^"]+"/g, '')
  .replace(/\s+data-name="[^"]+"/g, '')
  .replace(/class="cls-1"/g, 'fill="#ea4b00"')
  .replace(/<svg /, '<svg width="32" height="32" ')
  .replace(/\n\s*\n/g, '\n')
  .trim();
const SPOON_CURSOR_URI = 'data:image/svg+xml;base64,' + Buffer.from(_spoonSvg).toString('base64');
// hotspot pixel (3,0): spoon bowl tip at (3.47,0) in viewBox 37.78×37.77, rendered at 32×32
const _spoonRule     = `*{cursor:url('${SPOON_CURSOR_URI}') 3 0,auto!important}input,textarea{cursor:text!important}`;
const PANEL_CURSOR_CSS     = _spoonRule;
const HANDLE_CURSOR_CSS    = _spoonRule + '#strip{cursor:grab!important}';
const GRIP_CURSOR_CSS      = _spoonRule + '.grip{cursor:nwse-resize!important}';
const FORKKNIFE_CURSOR_CSS = _spoonRule + '#grip{cursor:grab!important}';

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
// BROWSING_POLICY controls what customers can navigate to while a panel is in
// active mode.
//   'open'      -- any http/https URL is allowed EXCEPT hosts in BLOCKED_DOMAINS.
//   'allowlist' -- only ALLOWED_DOMAINS (strict curated list).
// Non-http(s) schemes (file:, javascript:, chrome:, etc.) are always blocked.
const BROWSING_POLICY = 'open';

// BLOCKED_DOMAINS: hosts whose navigations are cancelled in active 'open' mode.
// Matching is exact hostname or any subdomain.
const BLOCKED_DOMAINS = [
  'reddit.com',
  'tumblr.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  '4chan.org',
  'instagram.com',
  'onlyfans.com',
];

// ALLOWED_DOMAINS is used when BROWSING_POLICY is 'allowlist'.
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
// At the page bottom the panel jumps to the top and immediately moves to the
// next search term.  MIN_SEARCH_INTERVAL_MS is a floor that adds a short extra
// wait only when the page was very short (guards against DDG rate-limiting
// across 5 panels).  SEARCH_INTERVAL_MS is a safety-net ceiling for pages
// that never trigger bottom detection.
const SEARCH_INTERVAL_MS     = 45 * 1000; // max time on a results page (safety net)
const MIN_SEARCH_INTERVAL_MS =  5 * 1000; // min time between searches per panel — floor for very short pages
const BOTTOM_HOLD_MS         = 300;       // brief pause after jumping to top before loading next search
const SCROLL_STEP_PX         = 80;        // px scrolled per tick
const SCROLL_STEP_MS         = 250;       // ms between scroll ticks
const INACTIVITY_TIMEOUT_MS  = 90 * 1000; // idle grace period before auto mode resumes
const LOAD_TIMEOUT_MS        = 15 * 1000; // per-panel watchdog: abort and retry if a DDG load takes longer
const GLOBAL_SEARCH_GAP_MS   =  2 * 1000; // minimum gap between any two panels starting a DDG search
const FOLLOW_RESULT_PROBABILITY = 1.0;        // chance of clicking a result after a search scroll; < 1 mixes in plain searches
const RESULT_DWELL_MS           = 25 * 1000;  // max time on a result page before returning to search
const RESULT_LOAD_TIMEOUT_MS    = 12 * 1000;  // watchdog: abort a stalled result page load, move to next search
const RESULT_HIGHLIGHT_MS       = 600;         // visual highlight duration (ms) on the chosen anchor before navigating
const AUTO_LINK_POLICY          = 'allowlist-preferred'; // 'allowlist-preferred' = prefer ALLOWED_DOMAINS, fall back to isPassesPolicy;
                                                          // 'allowlist' = only ALLOWED_DOMAINS; 'browsing' = use isPassesPolicy

// ---- Window / layout tunables -----------------------------------------------
const HANDLE_HEIGHT         = 28;
const RETURN_HOME_WHEN_IDLE = true;
const MIN_VISIBLE_PX        = 120;
const GRIP_SIZE             = 18;
const MIN_PANEL_WIDTH       = 320;
const MIN_PANEL_HEIGHT      = 220;
const INITIAL_LOAD_STAGGER_MS = 300;

// ---- Hardware-overlay tunables ----------------------------------------------
// HARDWARE_MARGIN: transparent padding (px) on every side of each panel window.
// The frame page (kiosk-handle.html) draws the orange border and hinge SVGs
// inside this margin so they appear to float around the browser content.
const HARDWARE_MARGIN  = 36;
// USE_WINDOW_SHAPE: on Linux, call win.setShape() to cut out the four opaque
// corner squares (HARDWARE_MARGIN × HARDWARE_MARGIN each) so clicks in those
// areas fall through to the wallpaper rather than landing on the transparent
// window surface.  Set to false if setShape() causes compositor artefacts.
const USE_WINDOW_SHAPE = true;

// ---- Forkknife nav control --------------------------------------------------
// Scale matches the spoon cursor: 32 px rendered for a 37.78-unit viewBox.
const UTENSIL_PX_PER_UNIT = 32 / 37.78;
const FK_GRAPHIC_W = Math.round(61.72 * UTENSIL_PX_PER_UNIT); // ~52 px
const FK_GRAPHIC_H = Math.round(21.86 * UTENSIL_PX_PER_UNIT); // ~19 px
const FK_GRIP_W    = 8;  // dotted drag-grip column width (px)
const FK_PAD       = 4;  // padding: top, bottom, and right of graphic (px)
// Default position (px) from the top-left corner of the kiosk display's work area.
const FORKKNIFE_POSITION = { x: 24, y: 24 };
const FORKKNIFE_WIN_W    = FK_GRIP_W + FK_GRAPHIC_W + FK_PAD; // ~64 px
const FORKKNIFE_WIN_H    = FK_GRAPHIC_H + 2 * FK_PAD;         // ~27 px

// ---- Active-panel animation tunables ----------------------------------------
// When a customer starts using a panel it grows to ACTIVE_SCALE × its home
// size; when it goes idle it shrinks back.  The tween runs at ~60 fps via
// setInterval (no platform-native animation API needed — works on Cinnamon).
const ACTIVE_SCALE        = 1.25; // scale factor applied to home width and height
const ACTIVE_ANIM_MS      = 220;  // tween duration in ms (both enlarge and shrink)
const TWEEN_INTERVAL_MS   = 16;   // step interval ms (~60 fps)
const FIRST_CLICK_GRACE_MS = 1500; // grace window for first-click IPC race (see will-navigate comment)

// "Loading…" placeholder shown immediately.  White background matches the
// panel view's setBackgroundColor('#ffffff') so a slow panel looks like a
// blank page rather than a broken black rectangle.
const PLACEHOLDER_URL = 'data:text/html,' + encodeURIComponent(
  '<body style="margin:0;background:#fff;color:#888;' +
  'font:14px/1 sans-serif;display:flex;align-items:center;' +
  'justify-content:center;height:100vh">Loading…</body>'
);

// ---- Startup timing ---------------------------------------------------------
let _t0 = 0;
let windowsCreatedAt = 0; // set when createKioskWindow finishes; move events within 5 s are ignored
// Timestamp of the last doSearch loadURL call across ALL panels.  Enforces
// GLOBAL_SEARCH_GAP_MS so no two panels hit DDG within that window.
let lastSearchStartedAt = 0;
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
                                   //          lastSearchTime, manualLayout,
                                   //          dwellTimer, scrollTimer, rotationStartTimer,
                                   //          autoPhase, recentResultUrls,
                                   //          highlightTimer, resultDwellTimer }
const ignoreNextMoves = new Map(); // key -> timeout-id | null
const resizeState     = new Map(); // key -> { startBounds, cornerDx, cornerDy } | null

// webContentsIdToKey is module-level (not scoped to attachActivityHandling)
// so it is available to any future code that needs to route IPC by view id.
const webContentsIdToKey = new Map();

// ---- Active-panel tween state -----------------------------------------------
// tweenTimers holds the setInterval id for any in-flight size animation so it
// can be cancelled cleanly.  enlargedKey is the one panel currently at active
// size (at most one at a time); null means no panel is enlarged.
// Both must be module-level so V8 cannot GC the interval references.
const tweenTimers = new Map(); // key -> interval-id | null
let   enlargedKey = null;      // panel key currently enlarged, or null
let forkKnifeWindow     = null; // standalone forkknife nav control window
let forkKnifeDragOffset = null; // { dx, dy } set at drag-start, cleared at drag-end
let forkKnifeHomePos    = null; // starting position, restored on double-click

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
  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'kiosk-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Electron 30+ BrowserView defaults to transparent; without this, pages
  // that don't paint their own background (including DDG's /l/ redirect)
  // show the panel window's dark #1a1a1a backdrop instead of white.
  view.setBackgroundColor('#ffffff');
  return view;
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

// ---- Electron version compatibility -----------------------------------------
// navigationHistory.canGoBack() / goBack() arrived in Electron 32.
// Electron 31 exposes the same capability directly on webContents.
// These helpers work on both.

function canGoBack(wc) {
  const nh = wc.navigationHistory;
  return (nh && typeof nh.canGoBack === 'function') ? nh.canGoBack() : wc.canGoBack();
}

function goBack(wc) {
  const nh = wc.navigationHistory;
  if (nh && typeof nh.goBack === 'function') { nh.goBack(); } else { wc.goBack(); }
}

function canGoForward(wc) {
  const nh = wc.navigationHistory;
  return (nh && typeof nh.canGoForward === 'function') ? nh.canGoForward() : wc.canGoForward();
}

function goForward(wc) {
  const nh = wc.navigationHistory;
  if (nh && typeof nh.goForward === 'function') { nh.goForward(); } else { wc.goForward(); }
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

function isDdgHost(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === 'duckduckgo.com' || hostname.endsWith('.duckduckgo.com');
  } catch { return false; }
}

function isDdgSearchUrl(url) {
  // Matches DDG search URLs that carry a query term (q=...) so SafeSearch can
  // be enforced.  Covers both https://duckduckgo.com/?q=... and the HTML
  // endpoint https://html.duckduckgo.com/html/?q=...
  try {
    const parsed = new URL(url);
    return isDdgHost(url) &&
           (parsed.pathname === '/' || parsed.pathname === '/html/') &&
           parsed.searchParams.has('q');
  } catch { return false; }
}

function isPassesPolicy(url) {
  // Returns true if the URL is allowed under the active BROWSING_POLICY.
  // Non-http(s) schemes are always denied regardless of policy.
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (BROWSING_POLICY === 'allowlist') return isDomainAllowed(url);
    // 'open': block only BLOCKED_DOMAINS.
    const { hostname } = parsed;
    return !BLOCKED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch { return false; }
}

function unwrapDdgRedirect(url) {
  // DuckDuckGo routes every result click through https://duckduckgo.com/l/?uddg=<encoded>
  // for click-tracking.  That page renders nothing itself, causing a black
  // panel until the redirect resolves.  Pull the real destination out of the
  // 'uddg' param and return it so the panel can load the target directly.
  // Also handles protocol-relative hrefs (//duckduckgo.com/l/?...) that the
  // browser may return as-is before fully resolving them.
  // Returns null if the URL is not a DDG /l/ redirect or the target is not http/https.
  try {
    if (typeof url === 'string' && url.startsWith('//')) url = 'https:' + url;
    if (!isDdgHost(url)) return null;
    const parsed = new URL(url);
    if (parsed.pathname !== '/l/') return null;
    const raw = parsed.searchParams.get('uddg');
    if (!raw) return null;
    const target = decodeURIComponent(raw);
    const { protocol } = new URL(target);
    return (protocol === 'http:' || protocol === 'https:') ? target : null;
  } catch { return null; }
}

function buildErrorPageUrl(message, failedUrl) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<style>body{margin:0;background:#fff;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;height:100vh;' +
    'font-family:sans-serif;color:#333;}' +
    'p{margin:8px 0;}' +
    'small{color:#999;font-size:12px;word-break:break-all;max-width:80%;text-align:center;}' +
    '</style></head><body>' +
    `<p>${esc(message)}</p>` +
    (failedUrl ? `<small>${esc(failedUrl)}</small>` : '') +
    '<p>Use the Back button above to go back.</p>' +
    '</body></html>';
  return 'data:text/html,' + encodeURIComponent(html);
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
  const M    = HARDWARE_MARGIN;
  const minW = MIN_PANEL_WIDTH  + 2 * M;
  const minH = MIN_PANEL_HEIGHT + HANDLE_HEIGHT + 2 * M;
  return {
    width:  home ? Math.min(minW, home.width)  : minW,
    height: home ? Math.min(minH, home.height) : minH,
  };
}

function positionGrip(key) {
  const win  = panelWindows.get(key);
  const grip = gripViews[key];
  if (!win || win.isDestroyed() || !grip) return;
  const [w, h] = win.getContentSize();
  const M = HARDWARE_MARGIN;
  grip.setBounds({ x: w - GRIP_SIZE - M, y: h - GRIP_SIZE - M, width: GRIP_SIZE, height: GRIP_SIZE });
}

// Which frame corners have hinge pieces (corner-t or corner-hinge) per panel.
// Corners listed here are included in the window shape so clicks on the
// pieces register rather than falling through to the wallpaper.
const PANEL_CORNER_PIECES = {
  hub:         [],
  topLeft:     [],
  topRight:    [],
  bottomLeft:  [],
  bottomRight: [],
};

function updateWindowShape(key) {
  if (!USE_WINDOW_SHAPE || process.platform !== 'linux') return;
  const win = panelWindows.get(key);
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const M = HARDWARE_MARGIN;
  // Base cross: three rects that cover the frame and edge strips, leaving the
  // four M×M corner areas excluded so clicks there fall through to wallpaper.
  const rects = [
    { x: M,     y: 0, width: w - 2 * M, height: h         },
    { x: 0,     y: M, width: M,         height: h - 2 * M },
    { x: w - M, y: M, width: M,         height: h - 2 * M },
  ];
  // Add back any corners that have hinge pieces so those pieces are clickable.
  const corners = PANEL_CORNER_PIECES[key] || [];
  if (corners.includes('corner-tl')) rects.push({ x: 0,     y: 0,     width: M, height: M });
  if (corners.includes('corner-tr')) rects.push({ x: w - M, y: 0,     width: M, height: M });
  if (corners.includes('corner-bl')) rects.push({ x: 0,     y: h - M, width: M, height: M });
  if (corners.includes('corner-br')) rects.push({ x: w - M, y: h - M, width: M, height: M });
  win.setShape(rects);
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
  notePanelActivity(key, 'resize');
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
  // Customer has manually resized while active — disable auto-size animations
  // for the rest of this active session.
  const ps = panelStates.get(key);
  if (ps && ps.mode === 'active' && !ps.manualLayout) {
    ps.manualLayout = true;
    cancelTween(key);
  }
  notePanelActivity(key, 'resize');
}

// ---- Panel size animation ---------------------------------------------------
//
// Panels grow to ACTIVE_SCALE × home size when a customer starts using them,
// and shrink back on idle.  The tween calls setPanelBoundsIgnored every
// TWEEN_INTERVAL_MS so the move handler never mistakes programmatic motion for
// a customer drag.  BrowserView setAutoResize and the 'resize' → positionGrip
// chain handle the grip and content view automatically during the tween.

function cancelTween(key) {
  const id = tweenTimers.get(key);
  if (id != null) {
    clearInterval(id);
    tweenTimers.set(key, null);
  }
}

function tweenBounds(key, from, to, durationMs) {
  cancelTween(key);
  const steps = Math.max(1, Math.round(durationMs / TWEEN_INTERVAL_MS));
  let   step  = 0;
  const id = setInterval(() => {
    step += 1;
    const t    = Math.min(1, step / steps);
    const ease = 1 - Math.pow(1 - t, 2); // quadratic ease-out
    setPanelBoundsIgnored(key, {
      x:      Math.round(from.x      + (to.x      - from.x)      * ease),
      y:      Math.round(from.y      + (to.y      - from.y)      * ease),
      width:  Math.round(from.width  + (to.width  - from.width)  * ease),
      height: Math.round(from.height + (to.height - from.height) * ease),
    });
    if (t >= 1) {
      clearInterval(id);
      tweenTimers.set(key, null);
    }
  }, TWEEN_INTERVAL_MS);
  tweenTimers.set(key, id);
}

// Returns enlarged bounds centred on the panel's current position, scaled
// from home size, clamped so the whole window stays inside the work area.
function computeActiveBounds(key) {
  const home = homeBounds.get(key);
  if (!home) return null;
  const win = panelWindows.get(key);
  if (!win || win.isDestroyed()) return null;

  const cur        = win.getBounds();
  const { workArea } = screen.getDisplayMatching(cur);

  const newW = Math.round(home.width  * ACTIVE_SCALE);
  const newH = Math.round(home.height * ACTIVE_SCALE);
  const cx   = cur.x + cur.width  / 2;
  const cy   = cur.y + cur.height / 2;

  let nx = Math.round(cx - newW / 2);
  let ny = Math.round(cy - newH / 2);
  nx = Math.max(workArea.x, Math.min(nx, workArea.x + workArea.width  - newW));
  ny = Math.max(workArea.y, Math.min(ny, workArea.y + workArea.height - newH));

  return { x: nx, y: ny, width: newW, height: newH };
}

function enlargePanel(key) {
  const activeBounds = computeActiveBounds(key);
  if (!activeBounds) return;
  const win = panelWindows.get(key);
  if (!win || win.isDestroyed()) return;
  tweenBounds(key, win.getBounds(), activeBounds, ACTIVE_ANIM_MS);
  win.moveTop();
}

// Animate the panel back to its home bounds.  Skips animation if the panel is
// already at home (e.g. was never enlarged or was snapped by sendPanelHome).
function shrinkPanelToHome(key) {
  const home = homeBounds.get(key);
  if (!home) return;
  const win = panelWindows.get(key);
  if (!win || win.isDestroyed()) return;
  const cur = win.getBounds();
  if (cur.x === home.x && cur.y === home.y &&
      cur.width === home.width && cur.height === home.height) {
    cancelTween(key);
    return;
  }
  tweenBounds(key, cur, home, ACTIVE_ANIM_MS);
}

// Send panel mode to the handle strip so it can show a visual accent.
function sendModeToHandle(key, mode) {
  const win = panelWindows.get(key);
  if (win && !win.isDestroyed()) win.webContents.send('panel-mode', mode);
}

// Called by the Reset button IPC handler.  Cancels any in-flight tween,
// clears the manual-layout flag, and snaps the panel back to home bounds.
function resetPanelLayout(key) {
  cancelTween(key);
  if (enlargedKey === key) enlargedKey = null;
  const ps = panelStates.get(key);
  if (ps) ps.manualLayout = false;
  sendPanelHome(key);
}

// ---- Forkknife nav helpers --------------------------------------------------

// Returns the key of the most recently active panel, or 'hub' as fallback.
function getActiveKey() {
  let bestKey  = 'hub';
  let bestTime = -1;
  for (const [k, ps] of panelStates) {
    if (ps.mode === 'active' && ps.lastTrustedInputAt > bestTime) {
      bestKey  = k;
      bestTime = ps.lastTrustedInputAt;
    }
  }
  return bestKey;
}

// Sends the current nav state of the active panel to the forkknife window.
function pushForkKnifeNavState() {
  if (!forkKnifeWindow || forkKnifeWindow.isDestroyed()) return;
  const key  = getActiveKey();
  const view = panelViews[key];
  if (!view || view.webContents.isDestroyed()) return;
  const state = {
    canGoBack:    canGoBack(view.webContents),
    canGoForward: canGoForward(view.webContents),
  };
  forkKnifeWindow.webContents.send('forkknife-nav-state', state);
}

// ---- Activity ---------------------------------------------------------------

// eventType is the DOM event type from kiosk-preload.js ('mousedown', 'click',
// 'keydown', 'wheel') or a synthetic label from main-process callers ('move',
// 'resize').  Only mousedown, click, and keydown trigger panel enlargement;
// wheel still counts as activity (idle timer resets) but does not enlarge.
function notePanelActivity(key, eventType) {
  const ps = panelStates.get(key);
  if (!ps) return;

  if (ps.mode === 'auto') {
    console.log(`[kiosk-auto] ${key} -> active (reason: ${eventType})`);
    stopBrowsingLoop(key);
    ps.mode = 'active';
    const _v = panelViews[key];
    if (_v && !_v.webContents.isDestroyed()) _v.webContents.setAudioMuted(false);
    sendModeToHandle(key, 'active');
    pushForkKnifeNavState();
  }

  clearTimeout(ps.inactivityTimer);
  ps.inactivityTimer = setTimeout(() => {
    // Return the panel to home bounds.  If the customer never dragged or
    // resized during this active session, animate the shrink.  If they did
    // (manualLayout), use an instant snap so we don't override their layout
    // choice mid-animation, or skip entirely if RETURN_HOME_WHEN_IDLE is off.
    if (!ps.manualLayout) {
      shrinkPanelToHome(key);
    } else if (RETURN_HOME_WHEN_IDLE) {
      sendPanelHome(key);
    }
    if (enlargedKey === key) enlargedKey = null;
    ps.mode        = 'auto';
    ps.manualLayout = false;
    sendModeToHandle(key, 'auto');
    startBrowsingLoop(key);
    pushForkKnifeNavState();
  }, INACTIVITY_TIMEOUT_MS);

  // Only deliberate events enlarge the panel.
  const isDeliberate = (eventType === 'mousedown' ||
                        eventType === 'click'     ||
                        eventType === 'keydown');
  if (isDeliberate && !ps.manualLayout) {
    // If a different panel is currently enlarged, shrink it (leave its mode
    // and idle timer alone — it is still active until its own timeout fires).
    if (enlargedKey !== null && enlargedKey !== key) {
      const prevPs = panelStates.get(enlargedKey);
      if (prevPs && !prevPs.manualLayout) shrinkPanelToHome(enlargedKey);
      enlargedKey = null;
    }
    // Enlarge this panel if it isn't already.
    if (enlargedKey !== key) {
      enlargedKey = key;
      enlargePanel(key);
    }
  }
}

// ---- View event handler setup -----------------------------------------------

function setupViewEventHandlers(key, win, view) {
  view.webContents.on('page-title-updated', (_e, title) => {
    if (!win.isDestroyed()) win.webContents.send('panel-title', title);
  });

  view.webContents.on('did-finish-load', () => {
    const url = view.webContents.getURL();

    // Placeholder and blank pages are never real content.
    if (url.startsWith('data:') || url === 'about:blank') return;
    // Cached file — start the scroll+dwell loop immediately but don't treat it
    // as a completed DDG search (watchdog, retryCount, and timing logs stay
    // untouched).  We still go through onSearchPageReady so the follow-a-result
    // step is reachable even while waiting for the real DDG response.
    if (url.startsWith('file:')) {
      const ps = panelStates.get(key);
      if (ps && ps.mode === 'auto') onSearchPageReady(key);
      return;
    }

    // [kiosk-timing] first real page per panel.
    if (!firstLoadLogged.has(key)) {
      firstLoadLogged.add(key);
      console.log(`[kiosk-timing] ${key} did-finish-load: +${timingMs()} ms`);
    }

    {
      const ps = panelStates.get(key);
      if (ps && ps.mode === 'auto') {
        clearTimeout(ps.loadTimer);
        ps.loadTimer = null;

        if (ps.autoPhase === 'result') {
          // Result page loaded — do not touch retryCount or write ddg-cache.
          onResultPageReady(key);
        } else {
          // Successful DDG search load — reset backoff and log timing.
          ps.retryCount = 0;
          if (ps.searchLoadStartedAt) {
            const elapsed = Date.now() - ps.searchLoadStartedAt;
            const status  = ps.lastNavStatus || 200;
            console.log(`[kiosk-timing] ${key} search #${ps.searchIndex} took ${elapsed} ms (status ${status})`);
            ps.searchLoadStartedAt = 0;
            ps.lastNavStatus       = 0;
          }
          onSearchPageReady(key);

          // Persist this DDG page so the next startup can show it immediately.
          // Skip write if there are no result links (bot-check / empty SERP).
          if (url.startsWith('https://html.duckduckgo.com/')) {
            view.webContents.executeJavaScript(
              'document.querySelector("a.result__a") ? document.documentElement.outerHTML : null'
            )
              .then(html => {
                if (!html) return;
                const withBase = html.replace('<head>', '<head><base href="https://html.duckduckgo.com/">');
                fs.writeFile(path.join(cacheDir, `${key}.html`), withBase, () => {});
              })
              .catch(() => {});
          }
        }
      }
    }
  });

  view.webContents.on('did-fail-load', (_e, errorCode, _desc, failedUrl, isMainFrame) => {
    if (!isMainFrame) return; // subframe failures (ads, iframes) are not our problem
    // ERR_ABORTED (-3): navigation was cancelled by our own stop() / loadURL()
    // call or by a redirect chain.  The watchdog (if still armed) will handle
    // the stop() case; a redirect-abort is not a real failure.  Skip retry here.
    if (errorCode === -3) return;
    const ps = panelStates.get(key);
    if (!ps) return;
    if (!failedUrl || failedUrl.startsWith('data:') || failedUrl.startsWith('file:')) return;

    // Clear watchdog — the load definitely ended.
    clearTimeout(ps.loadTimer);
    ps.loadTimer = null;

    if (ps.mode === 'active') {
      console.log(`[kiosk-active] ${key} load failed (${errorCode}): ${failedUrl}`);
      view.webContents.loadURL(buildErrorPageUrl("This page couldn't be loaded.", failedUrl)).catch(() => {});
      return;
    }
    if (ps.mode !== 'auto') return;
    console.log(`[kiosk-auto] ${key} load failed (${errorCode}): ${failedUrl}`);
    if (ps.autoPhase === 'result') {
      // A broken third-party page should not slow down DDG searches — skip backoff.
      console.log(`[kiosk-auto] ${key} result failed, skipping`);
      doSearch(key);
    } else {
      scheduleRetry(key, `error-${errorCode}`);
    }
  });

  // Update the handle's Back button after each top-level or in-page navigation.
  view.webContents.on('did-navigate', (_e, url, httpResponseCode, _statusText, isMainFrame) => {
    if (!url || url.startsWith('data:') || url === 'about:blank') return;

    if (isMainFrame) {
      const ps = panelStates.get(key);
      if (ps) {
        ps.lastNavStatus = httpResponseCode;

        // A non-200 response on a DDG search in auto mode means the request
        // was throttled or rejected (e.g. HTTP 429).  Stop the load and retry
        // with backoff rather than showing a partial / error page.
        if (ps.mode === 'auto' && isDdgSearchUrl(url) && httpResponseCode !== 200) {
          console.log(`[kiosk-auto] ${key} DDG search returned HTTP ${httpResponseCode} — retrying`);
          clearTimeout(ps.loadTimer);
          ps.loadTimer = null;
          view.webContents.stop();
          scheduleRetry(key, `http-${httpResponseCode}`);
          return;
        }
      }
    }

    pushForkKnifeNavState();
  });

  view.webContents.on('did-navigate-in-page', () => {
    pushForkKnifeNavState();
  });

  // Navigation guard -- applies to all page-initiated navigations (meta-refresh,
  // JS redirects, link clicks).  webContents.loadURL() from the main process is
  // exempt: will-navigate does not fire for programmatic loads.
  view.webContents.on('will-navigate', (event, url) => {
    const ps = panelStates.get(key);
    if (!ps) return;

    // Always block non-http(s) schemes regardless of mode.
    let proto = '';
    try { proto = new URL(url).protocol; } catch {}
    if (proto !== 'http:' && proto !== 'https:') {
      event.preventDefault();
      console.log(`[kiosk-auto] ${key} blocked non-http navigation: ${url}`);
      return;
    }

    // SafeSearch enforcement: any DDG search URL must carry kp=1.  If it
    // doesn't (e.g. customer typed a raw search), cancel and reload with it.
    if (isDdgSearchUrl(url)) {
      const parsed = new URL(url);
      if (parsed.searchParams.get('kp') !== '1') {
        parsed.searchParams.set('kp', '1');
        const safe = parsed.toString();
        event.preventDefault();
        console.log(`[kiosk-auto] ${key} SafeSearch rewrite: ${safe}`);
        view.webContents.loadURL(safe).catch(() => {});
        return;
      }
    }

    if (ps.mode === 'auto') {
      // First-click race: the renderer's panel-activity IPC (sent from
      // kiosk-preload.js on mousedown/click) travels over an async IPC
      // channel, while will-navigate is dispatched synchronously in the main
      // process as soon as the renderer begins a navigation.  On some loads the
      // will-navigate fires before the panel-activity IPC is processed, leaving
      // ps.mode still 'auto' for what is actually a customer-initiated click.
      // Fix: if trusted input was recorded within FIRST_CLICK_GRACE_MS, treat
      // the panel as active and let the navigation through under active policy.
      const sinceInput = Date.now() - (ps.lastTrustedInputAt || 0);
      if (sinceInput <= FIRST_CLICK_GRACE_MS) {
        console.log(`[kiosk-auto] ${key} first-click race rescued (${sinceInput} ms), activating panel`);
        notePanelActivity(key, 'click'); // transitions ps.mode to 'active'
        // Fall through to active-mode policy below.
      } else if (ps.autoPhase === 'result') {
        // Result page: allow page-initiated redirects (http→https, meta-refresh)
        // that pass AUTO_LINK_POLICY; block everything else.
        const _allowed = (AUTO_LINK_POLICY === 'allowlist') ? isDomainAllowed(url) : isPassesPolicy(url);
        if (_allowed) {
          console.log(`[kiosk-auto] ${key} allowed result-phase navigation: ${url}`);
        } else {
          event.preventDefault();
          console.log(`[kiosk-auto] ${key} blocked result-phase navigation (policy): ${url}`);
        }
        return;
      } else {
        // Search phase with no recent trusted input: only DDG is permitted.
        // This blocks meta-refresh, JS redirects, and link-prefetch navs.
        if (!isDdgHost(url)) {
          event.preventDefault();
          console.log(`[kiosk-auto] ${key} blocked auto-mode navigation: ${url}`);
        } else {
          console.log(`[kiosk-auto] ${key} allowed DDG navigation in auto mode: ${url}`);
        }
        return;
      }
    }

    // Active mode: apply BROWSING_POLICY.
    // DDG wraps every result link through /l/?uddg=<encoded-url> for
    // click-tracking; unwrap to the real target before the policy check so
    // the panel loads the destination directly instead of waiting for the
    // DDG redirect page (which renders nothing and causes a black panel).
    const unwrapped = unwrapDdgRedirect(url);
    if (unwrapped !== null) {
      event.preventDefault();
      if (isPassesPolicy(unwrapped)) {
        console.log(`[kiosk-auto] ${key} DDG redirect unwrapped: ${unwrapped}`);
        view.webContents.loadURL(unwrapped).catch(() => {});
      } else {
        console.log(`[kiosk-auto] ${key} blocked active-mode navigation (blocklist): ${unwrapped}`);
      }
      return;
    }

    if (!isPassesPolicy(url)) {
      event.preventDefault();
      try {
        const { hostname } = new URL(url);
        const onBlocklist = BLOCKED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
        console.log(`[kiosk-auto] ${key} blocked active-mode navigation (${onBlocklist ? 'blocklist' : 'non-http scheme'}): ${url}`);
      } catch {
        console.log(`[kiosk-auto] ${key} blocked active-mode navigation (invalid URL): ${url}`);
      }
    } else {
      console.log(`[kiosk-auto] ${key} allowed navigation: ${url}`);
    }
  });

  // Block new windows (target=_blank, window.open).  In active mode, redirect
  // the URL into the same panel view if it passes the browsing policy; in auto
  // mode ignore it entirely.
  view.webContents.setWindowOpenHandler(({ url }) => {
    const ps = panelStates.get(key);
    if (ps && ps.mode === 'active' && isPassesPolicy(url)) {
      console.log(`[kiosk-auto] ${key} new-tab link redirected to same panel: ${url}`);
      setImmediate(() => view.webContents.loadURL(url).catch(() => {}));
    } else {
      console.log(`[kiosk-auto] ${key} blocked window.open: ${url}`);
    }
    return { action: 'deny' };
  });

  view.webContents.on('dom-ready', () => {
    view.webContents.insertCSS(PANEL_CURSOR_CSS).catch(() => {});
  });

  view.webContents.on('render-process-gone', (_e, details) => {
    console.log(`[kiosk] ${key} render process gone (reason: ${details.reason}, exitCode: ${details.exitCode})`);
    setTimeout(() => {
      if (view.webContents.isDestroyed()) return;
      const ps = panelStates.get(key);
      if (!ps) return;
      if (ps.mode === 'auto') {
        doSearch(key);
      } else {
        view.webContents.loadURL(buildErrorPageUrl('This page stopped working.', '')).catch(() => {});
      }
    }, 500);
  });
}

// ---- Browsing loop (search → result → search) --------------------------------
//
// Auto mode alternates between DuckDuckGo results pages and individual result
// pages.  The per-panel flow is:
//
//   doSearch → DDG page loads → onSearchPageReady → startScrolling
//              (or cached file)                   → SEARCH_INTERVAL_MS dwell cap
//              scroll tick detects bottom ─────────>|
//                                             scrollTo(0,0)
//                                             stopScrolling
//                                             → onSearchBottom
//                                               (respects FOLLOW_RESULT_PROBABILITY)
//                                               ├─ pick eligible result (AUTO_LINK_POLICY,
//                                               │   ad-skip, recentResultUrls filter)
//                                               │  highlight anchor (RESULT_HIGHLIGHT_MS)
//                                               │  ps.autoPhase = 'result'
//                                               │  loadURL(target)
//                                               │  → onResultPageReady → startScrolling
//                                               │                       → RESULT_DWELL_MS cap
//                                               │  scroll detects bottom → doSearch(next) …
//                                               └─ (no eligible result or probability skip)
//                                                  → doSearch(next term) …
//
// Safety rules:
//   • Audio is muted on auto-mode entry; unmuted on customer takeover.
//   • Result pages are never written to the DDG cache.
//   • Load failures/timeouts on result pages skip retryCount so broken
//     third-party sites don't slow down DDG searches.
//   • AUTO_LINK_POLICY guards eligible result targets.
//   • Ads (.result--ad, .badge--ad) are always skipped.
//   • When a DDG search is in-flight (ps.loadTimer set), the search-phase
//     scroll bottom does not advance — onSearchPageReady takes over on landing.

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
      // Scroll one step and check for bottom.  executeJavaScript is not a
      // trusted event so it cannot trigger customer-activity detection in
      // kiosk-preload.js.
      //
      // Bottom detection: document.scrollingElement handles quirks-mode and
      // arbitrary sites.  "scrollY didn't change after scrollBy" is treated
      // as the bottom for pages that scroll an inner container or block
      // window scrolling.
      atBottom = await view.webContents.executeJavaScript(`
        (function () {
          var prevY = (typeof window.__kioskPrevScrollY === 'number')
            ? window.__kioskPrevScrollY : window.scrollY;
          window.scrollBy(0, ${SCROLL_STEP_PX});
          var newY = window.scrollY;
          window.__kioskPrevScrollY = newY;
          if (newY === prevY) return true;
          var scroller = document.scrollingElement || document.documentElement;
          if (!scroller) return true;
          var body = document.body;
          var scrollH = Math.max(scroller.scrollHeight, body ? body.scrollHeight : 0);
          return newY + window.innerHeight >= scrollH - 4;
        })()
      `, false);
    } catch {
      return; // page is navigating — skip tick
    }

    if (!atBottom) return;

    // Snap to top so the panel never looks frozen.
    try {
      await view.webContents.executeJavaScript(`window.scrollTo(0, 0)`, false);
    } catch {
      return; // page is navigating — skip tick
    }

    // Re-check state after the second await.
    if (ps.mode !== 'auto' || ps.scrollTimer === null) return;

    if (ps.autoPhase === 'result') {
      // Result page bottom: wait the normal hold floor then fetch the next search.
      const sinceLastSearch = Date.now() - ps.lastSearchTime;
      const holdMs = Math.max(BOTTOM_HOLD_MS, MIN_SEARCH_INTERVAL_MS - sinceLastSearch);
      stopScrolling(key);
      clearTimeout(ps.resultDwellTimer);
      ps.resultDwellTimer = null;
      console.log(`[kiosk-auto] ${key} result bottom — next search in ${holdMs} ms`);
      ps.dwellTimer = setTimeout(() => {
        ps.dwellTimer = null;
        if (ps.mode === 'auto') doSearch(key);
      }, holdMs);
    } else {
      // Search phase: don't advance if a DDG load is still in-flight — let
      // onSearchPageReady take over when the real page lands.
      if (ps.loadTimer) return;

      stopScrolling(key);
      clearTimeout(ps.dwellTimer);
      ps.dwellTimer = null;
      console.log(`[kiosk-auto] ${key} search bottom — picking result`);
      onSearchBottom(key); // async chain; manages its own timers from here
    }
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
    onSearchBottom(key); // respect FOLLOW_RESULT_PROBABILITY even on the dwell cap
  }, SEARCH_INTERVAL_MS);
}

// Schedules the next doSearch call with per-panel exponential backoff
// (5 s, 10 s, 20 s, … capped at 30 s).  Resets to 0 on a successful load.
function scheduleRetry(key, reason) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;
  const delay = reason === 'timeout-first'
    ? 2_000
    : Math.min(5_000 * Math.pow(2, ps.retryCount), 60_000);
  ps.retryCount += 1;
  clearTimeout(ps.dwellTimer);
  ps.dwellTimer = setTimeout(() => {
    ps.dwellTimer = null;
    if (ps.mode === 'auto') doSearch(key);
  }, delay);
  console.log(`[kiosk-auto] ${key} retry in ${delay} ms (reason: ${reason}, attempt: ${ps.retryCount})`);
}

// Collects eligible result links from the current DDG results page, unwraps
// DDG /l/ redirects, applies AUTO_LINK_POLICY, and returns { domHref, target,
// tier } for a randomly chosen link, null if no eligible links are found, or
// { botCheck: true } if a DDG bot-challenge page is detected (caller should
// scheduleRetry instead of doSearch).
async function pickRandomResult(key) {
  const view = panelViews[key];
  if (!view || view.webContents.isDestroyed()) {
    console.log(`[kiosk-auto] ${key} pickRandomResult: view gone`);
    return null;
  }

  let pageInfo;
  try {
    // Collect hrefs from primary selector and two fallbacks, de-duplicated.
    // a.href is the browser-resolved absolute URL (preserves DDG /l/ redirects).
    // Anything nested inside .result--ad or .badge--ad is skipped.
    pageInfo = await view.webContents.executeJavaScript(`
      (function () {
        var adEls = new Set(Array.from(
          document.querySelectorAll('.result--ad .result__a, .badge--ad .result__a')
        ));
        var seen = new Set();
        var hrefs = [];
        var sels = ['a.result__a', '.result__title a', 'a.result-link'];
        for (var si = 0; si < sels.length; si++) {
          Array.from(document.querySelectorAll(sels[si])).forEach(function (a) {
            if (adEls.has(a)) return;
            var h = a.href;
            if (h && !seen.has(h)) { seen.add(h); hrefs.push(h); }
          });
        }
        // Bot-check: no .result elements, plus a form or bot/challenge text.
        var hasResults = document.querySelectorAll('.result').length > 0;
        var bodyText = document.body ? document.body.innerText.toLowerCase() : '';
        var isBotCheck = !hasResults && (
          document.querySelector('form') !== null ||
          bodyText.indexOf('bot') !== -1 ||
          bodyText.indexOf('challenge') !== -1 ||
          bodyText.indexOf('unusual traffic') !== -1
        );
        return { hrefs: hrefs, isBotCheck: isBotCheck, title: document.title };
      })()
    `, false);
  } catch (err) {
    console.log(`[kiosk-auto] ${key} pickRandomResult: script failed: ${err.message}`);
    return null;
  }

  const { hrefs: domHrefs, isBotCheck, title } = pageInfo;
  const currentUrl = view.webContents.getURL();

  if (!Array.isArray(domHrefs) || domHrefs.length === 0) {
    if (isBotCheck) {
      console.log(`[kiosk-auto] ${key} DDG bot-check page detected`);
      return { botCheck: true };
    }
    console.log(`[kiosk-auto] ${key} pickRandomResult: 0 result links on page (${currentUrl}, title: ${title})`);
    return null;
  }

  const ps = panelStates.get(key);
  const recentUrls = ps ? ps.recentResultUrls : [];
  const total = domHrefs.length;
  let afterPolicy = 0;

  // 'allowlist-preferred': two tiers — prefer ALLOWED_DOMAINS, fall back to isPassesPolicy.
  const allowlistCandidates = [];
  const fallbackCandidates  = [];

  for (let domHref of domHrefs) {
    // Resolve protocol-relative hrefs before unwrapping.
    if (typeof domHref === 'string' && domHref.startsWith('//')) domHref = 'https:' + domHref;

    // Unwrap DDG /l/ redirect; fall through to the raw href if already direct.
    const unwrapped = unwrapDdgRedirect(domHref);
    const target = (unwrapped !== null) ? unwrapped : domHref;

    // Must be http/https.
    let proto = '';
    try { proto = new URL(target).protocol; } catch {}
    if (proto !== 'http:' && proto !== 'https:') continue;

    // Skip recently visited pages.
    if (recentUrls.includes(target)) continue;

    if (AUTO_LINK_POLICY === 'allowlist') {
      if (!isDomainAllowed(target)) continue;
      afterPolicy += 1;
      allowlistCandidates.push({ domHref, target, tier: 'allowlist' });
    } else if (AUTO_LINK_POLICY === 'browsing') {
      if (!isPassesPolicy(target)) continue;
      afterPolicy += 1;
      allowlistCandidates.push({ domHref, target, tier: 'browsing' });
    } else {
      // 'allowlist-preferred': allowlist wins; any policy-passing URL is fallback.
      if (isDomainAllowed(target)) {
        afterPolicy += 1;
        allowlistCandidates.push({ domHref, target, tier: 'allowlist' });
      } else if (isPassesPolicy(target)) {
        afterPolicy += 1;
        fallbackCandidates.push({ domHref, target, tier: 'fallback' });
      }
    }
  }

  const pool = allowlistCandidates.length > 0 ? allowlistCandidates : fallbackCandidates;
  if (pool.length === 0) {
    console.log(`[kiosk-auto] ${key} no eligible results (${total} found, ${afterPolicy} after policy), next search`);
    return null;
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

// Called when a search page hits the bottom (or the SEARCH_INTERVAL_MS dwell
// cap fires).  Respects FOLLOW_RESULT_PROBABILITY; when following, picks a
// random eligible result, highlights it briefly, then loads it in the panel.
async function onSearchBottom(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;

  // Occasionally skip result-following to mix in pure search-only cycles.
  if (Math.random() > FOLLOW_RESULT_PROBABILITY) {
    const sinceLastSearch = Date.now() - ps.lastSearchTime;
    const holdMs = Math.max(BOTTOM_HOLD_MS, MIN_SEARCH_INTERVAL_MS - sinceLastSearch);
    console.log(`[kiosk-auto] ${key} skipping result (probability), next search in ${holdMs} ms`);
    ps.dwellTimer = setTimeout(() => {
      ps.dwellTimer = null;
      if (ps.mode === 'auto') doSearch(key);
    }, holdMs);
    return;
  }

  const result = await pickRandomResult(key);

  // Re-check mode after async operation.
  if (ps.mode !== 'auto') {
    console.log(`[kiosk-auto] ${key} onSearchBottom: mode changed to ${ps.mode}, aborting`);
    return;
  }

  if (result && result.botCheck) {
    console.log(`[kiosk-auto] ${key} onSearchBottom: DDG bot-check, scheduling retry`);
    scheduleRetry(key, 'ddg-challenge');
    return;
  }

  if (!result) {
    const sinceLastSearch = Date.now() - ps.lastSearchTime;
    const holdMs = Math.max(BOTTOM_HOLD_MS, MIN_SEARCH_INTERVAL_MS - sinceLastSearch);
    ps.dwellTimer = setTimeout(() => {
      ps.dwellTimer = null;
      if (ps.mode === 'auto') doSearch(key);
    }, holdMs);
    return;
  }

  console.log(`[kiosk-auto] ${key} following result (${result.tier}): ${result.target}`);

  // Highlight the chosen anchor in-page before navigating.
  const view = panelViews[key];
  if (!view || view.webContents.isDestroyed()) { doSearch(key); return; }
  try {
    await view.webContents.executeJavaScript(`
      (function (href) {
        var el = Array.from(document.querySelectorAll('a.result__a'))
          .find(function (a) { return a.href === href; });
        if (el) {
          el.style.outline = '3px solid #ea4b00';
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      })(${JSON.stringify(result.domHref)})
    `, false);
  } catch {}

  // Re-check mode after the highlight executeJavaScript.
  if (ps.mode !== 'auto') return;

  ps.highlightTimer = setTimeout(() => {
    ps.highlightTimer = null;
    if (ps.mode !== 'auto') return;
    const v = panelViews[key];
    if (!v || v.webContents.isDestroyed()) { doSearch(key); return; }

    ps.autoPhase = 'result';
    ps.recentResultUrls.push(result.target);
    if (ps.recentResultUrls.length > 20) ps.recentResultUrls.shift();

    // Arm result load watchdog — fires if did-finish-load/did-fail-load never arrive.
    clearTimeout(ps.loadTimer);
    ps.loadTimer = setTimeout(() => {
      ps.loadTimer = null;
      if (ps.mode !== 'auto') return;
      console.log(`[kiosk-auto] ${key} result load timed out, skipping`);
      doSearch(key);
    }, RESULT_LOAD_TIMEOUT_MS);

    v.webContents.loadURL(result.target).catch(err => {
      clearTimeout(ps.loadTimer);
      ps.loadTimer = null;
      if (ps.mode !== 'auto') return;
      console.log(`[kiosk-auto] ${key} result load rejected: ${err.message}, skipping`);
      doSearch(key);
    });
  }, RESULT_HIGHLIGHT_MS);
}

// Called after a result page finishes loading.  Starts the scroll loop and
// arms RESULT_DWELL_MS as a safety net in case bottom detection never fires.
function onResultPageReady(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto' || ps.autoPhase !== 'result') return;

  const url = panelViews[key]?.webContents.getURL() || '';
  console.log(`[kiosk-auto] ${key} result page ready: ${url}`);

  startScrolling(key);

  clearTimeout(ps.resultDwellTimer);
  ps.resultDwellTimer = setTimeout(() => {
    ps.resultDwellTimer = null;
    if (ps.mode !== 'auto' || ps.autoPhase !== 'result') return;
    stopScrolling(key);
    doSearch(key);
  }, RESULT_DWELL_MS);
}

function doSearch(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;
  ps.autoPhase = 'search';

  // Global search gate: space out DDG hits across all panels.
  // Skipped for each panel's very first search so windows fill immediately.
  if (ps.firstSearchDone) {
    const gapRemaining = GLOBAL_SEARCH_GAP_MS - (Date.now() - lastSearchStartedAt);
    if (gapRemaining > 0) {
      clearTimeout(ps.dwellTimer);
      ps.dwellTimer = setTimeout(() => {
        ps.dwellTimer = null;
        if (ps.mode === 'auto') doSearch(key);
      }, gapRemaining);
      return;
    }
  }
  const isFirst      = !ps.firstSearchDone; // capture before setting — true only on each panel's first search
  ps.firstSearchDone = true;

  const now = Date.now();
  lastSearchStartedAt    = now;
  ps.lastSearchTime      = now;
  ps.searchLoadStartedAt = now;

  const term = SEARCH_TERMS[ps.searchIndex % SEARCH_TERMS.length];
  ps.searchIndex += 1;

  const url = buildSearchUrl(term);
  console.log(`[kiosk-auto] ${key} search [${ps.searchIndex}]: "${term}"`);

  const view = panelViews[key];
  if (!view || view.webContents.isDestroyed()) return;

  // Arm load watchdog — fires if neither did-finish-load nor did-fail-load
  // arrives within LOAD_TIMEOUT_MS (e.g. request stalled before a response).
  // Use a shorter timeout for the first search so a stalled panel recovers fast.
  const timeoutMs  = isFirst ? 8_000 : LOAD_TIMEOUT_MS;
  clearTimeout(ps.loadTimer);
  ps.loadTimer = setTimeout(() => {
    ps.loadTimer = null;
    if (ps.mode !== 'auto') return;
    const stuckUrl = view.webContents.isDestroyed() ? url : (view.webContents.getURL() || url);
    console.log(`[kiosk-auto] ${key} load timed out after ${timeoutMs} ms: ${stuckUrl}`);
    view.webContents.stop();
    scheduleRetry(key, isFirst ? 'timeout-first' : 'timeout');
  }, timeoutMs);

  view.webContents.loadURL(url).catch(err => {
    clearTimeout(ps.loadTimer);
    ps.loadTimer = null;
    console.log(`[kiosk-auto] ${key} search load rejected: ${err.message}`);
    scheduleRetry(key, 'load-rejected');
  });
}

function startBrowsingLoop(key) {
  const ps = panelStates.get(key);
  if (!ps) return;
  stopBrowsingLoop(key);
  ps.mode      = 'auto';
  ps.autoPhase = 'search';
  const view = panelViews[key];
  if (view && !view.webContents.isDestroyed()) view.webContents.setAudioMuted(true);
  doSearch(key);
}

// Clear all auto-mode timers.  Does NOT modify ps.mode — callers handle that.
function stopBrowsingLoop(key) {
  const ps = panelStates.get(key);
  if (!ps) return;
  clearTimeout(ps.dwellTimer);
  clearInterval(ps.scrollTimer);
  clearTimeout(ps.rotationStartTimer);
  clearTimeout(ps.loadTimer);
  clearTimeout(ps.highlightTimer);    // RESULT_HIGHLIGHT_MS pause before navigating to a result
  clearTimeout(ps.resultDwellTimer);  // RESULT_DWELL_MS cap on result pages
  ps.dwellTimer         = null;
  ps.scrollTimer        = null;
  ps.rotationStartTimer = null;
  ps.loadTimer          = null;
  ps.highlightTimer     = null;
  ps.resultDwellTimer   = null;
}

// ---- Forkknife window -------------------------------------------------------

function createForkKnifeWindow(workArea) {
  if (forkKnifeWindow && !forkKnifeWindow.isDestroyed()) {
    forkKnifeWindow.destroy();
  }
  const homeX = workArea.x + FORKKNIFE_POSITION.x;
  const homeY = workArea.y + FORKKNIFE_POSITION.y;
  forkKnifeHomePos = { x: homeX, y: homeY };

  forkKnifeWindow = new BrowserWindow({
    x:           homeX,
    y:           homeY,
    width:       FORKKNIFE_WIN_W,
    height:      FORKKNIFE_WIN_H,
    frame:       false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable:   false,
    movable:     true,
    webPreferences: {
      preload:          path.join(__dirname, 'kiosk-forkknife-preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    },
  });
  forkKnifeWindow.loadFile(path.join(__dirname, 'kiosk-forkknife.html'));
  forkKnifeWindow.webContents.on('dom-ready', () => {
    forkKnifeWindow.webContents.insertCSS(FORKKNIFE_CURSOR_CSS).catch(() => {});
  });
  forkKnifeWindow.webContents.once('did-finish-load', () => {
    if (USE_WINDOW_SHAPE && process.platform === 'linux') {
      forkKnifeWindow.setShape([
        { x: 0, y: 0, width: FORKKNIFE_WIN_W, height: FORKKNIFE_WIN_H },
      ]);
    }
    pushForkKnifeNavState();
  });
}

// ---- Window creation --------------------------------------------------------

/**
 * Creates five independent, movable, resizable panel windows — one per kiosk
 * panel (hub, topLeft, topRight, bottomLeft, bottomRight).  Each window has:
 *   - a transparent HARDWARE_MARGIN-px border on all sides (for the hinge
 *     overlay rendered by kiosk-handle.html)
 *   - a 28 px drag strip at the top of the browser area
 *   - a BrowserView inset by HARDWARE_MARGIN on every side
 *   - an 18 × 18 px resize grip inset from the window's bottom-right corner
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
    const M      = HARDWARE_MARGIN;
    const panelW = pLayout.width;
    const panelH = pLayout.height;
    const winW   = panelW + 2 * M;
    const winH   = panelH + HANDLE_HEIGHT + 2 * M;
    const homeX  = originX + pLayout.x - M;
    const homeY  = originY + pLayout.y - M;

    homeBounds.set(key, { x: homeX, y: homeY, width: winW, height: winH });

    const win = new BrowserWindow({
      x: homeX, y: homeY, width: winW, height: winH,
      frame:       false,
      resizable:   true,   // required for programmatic setBounds() on all platforms
      movable:     true,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: true,
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
    win.webContents.on('dom-ready', () => {
      win.webContents.insertCSS(HANDLE_CURSOR_CSS).catch(() => {});
    });
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('panel-hardware', { key, margin: M });
      updateWindowShape(key);
    });

    // Panel content view — inset by HARDWARE_MARGIN on all sides so the
    // transparent border is visible.  setAutoResize keeps the right and
    // bottom edges tracking the window edges (distance M preserved).
    const view = makePanelView();
    win.addBrowserView(view);
    view.setBounds({ x: M, y: HANDLE_HEIGHT + M, width: panelW, height: panelH });
    view.setAutoResize({ width: true, height: true });
    const cachedPage = path.join(cacheDir, `${key}.html`);
    if (fs.existsSync(cachedPage)) {
      view.webContents.loadFile(cachedPage);
    } else {
      view.webContents.loadURL(PLACEHOLDER_URL);
    }
    panelViews[key] = view;
    setupViewEventHandlers(key, win, view);

    // Resize grip — added after the panel view so it stays on top.
    const grip = makeGripView();
    win.addBrowserView(grip);
    grip.webContents.loadFile(path.join(__dirname, 'kiosk-resize-grip.html'));
    grip.webContents.on('dom-ready', () => {
      grip.webContents.insertCSS(GRIP_CURSOR_CSS).catch(() => {});
    });
    gripViews[key] = grip;
    positionGrip(key);

    win.on('resize', () => {
      positionGrip(key);
      updateWindowShape(key);
      if (!win.isDestroyed()) win.webContents.send('panel-hardware', { key, margin: M });
    });

    let moveDebounce = null;
    win.on('move', () => {
      if (ignoreNextMoves.get(key)) return;
      if (Date.now() - windowsCreatedAt < 5_000) {
        console.log(`[kiosk-auto] ${key} startup move ignored`);
        return;
      }
      clearTimeout(moveDebounce);
      moveDebounce = setTimeout(() => {
        // Customer dragged the handle while already active — disable auto-size
        // animations for the rest of this active session.
        const ps = panelStates.get(key);
        if (ps && ps.mode === 'active' && !ps.manualLayout) {
          ps.manualLayout = true;
          cancelTween(key);
        }
        notePanelActivity(key, 'move');
        clampToDisplay(key);
      }, 250);
    });

    win.on('closed', () => {
      cancelTween(key);
      if (enlargedKey === key) enlargedKey = null;
      panelWindows.delete(key);
      homeBounds.delete(key);
      delete panelViews[key];
      delete gripViews[key];
      resizeState.delete(key);
      tweenTimers.delete(key);
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
      const M  = HARDWARE_MARGIN;
      // Report browser-area fractions (margin stripped) so values paste
      // directly into computeClusterLayout's defs without adjustment.
      const rx = ((x + M - originX) / layout.totalWidth ).toFixed(3);
      const ry = ((y + M - originY) / layout.totalHeight).toFixed(3);
      const rw = ((width  - 2 * M)  / layout.totalWidth ).toFixed(3);
      const rh = ((height - 2 * M - HANDLE_HEIGHT) / layout.totalHeight).toFixed(3);
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

  createForkKnifeWindow(workArea);

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

  ipcMain.on('panel-activity', (event, eventType) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (!key) return;
    const ps = panelStates.get(key);
    if (ps) ps.lastTrustedInputAt = Date.now();
    notePanelActivity(key, eventType || 'unknown');
  });

  ipcMain.on('forkknife-back', (event) => {
    if (!forkKnifeWindow || forkKnifeWindow.isDestroyed()) return;
    if (event.sender !== forkKnifeWindow.webContents) return;
    const key = getActiveKey();
    const view = panelViews[key];
    if (!view || view.webContents.isDestroyed()) return;
    if (canGoBack(view.webContents)) {
      goBack(view.webContents);
      notePanelActivity(key, 'click');
    }
  });

  ipcMain.on('forkknife-forward', (event) => {
    if (!forkKnifeWindow || forkKnifeWindow.isDestroyed()) return;
    if (event.sender !== forkKnifeWindow.webContents) return;
    const key = getActiveKey();
    const view = panelViews[key];
    if (!view || view.webContents.isDestroyed()) return;
    if (canGoForward(view.webContents)) {
      goForward(view.webContents);
      notePanelActivity(key, 'click');
    }
  });

  ipcMain.on('forkknife-drag-start', (event) => {
    if (!forkKnifeWindow || forkKnifeWindow.isDestroyed()) return;
    if (event.sender !== forkKnifeWindow.webContents) return;
    const cursor = screen.getCursorScreenPoint();
    const pos    = forkKnifeWindow.getPosition();
    forkKnifeDragOffset = { dx: cursor.x - pos[0], dy: cursor.y - pos[1] };
  });

  ipcMain.on('forkknife-drag-move', (event) => {
    if (!forkKnifeWindow || forkKnifeWindow.isDestroyed()) return;
    if (event.sender !== forkKnifeWindow.webContents) return;
    if (!forkKnifeDragOffset) return;
    const cursor       = screen.getCursorScreenPoint();
    const { workArea } = screen.getDisplayMatching(forkKnifeWindow.getBounds());
    const MIN_VIS      = 20;
    let nx = cursor.x - forkKnifeDragOffset.dx;
    let ny = cursor.y - forkKnifeDragOffset.dy;
    nx = Math.max(workArea.x - FORKKNIFE_WIN_W + MIN_VIS,
                  Math.min(nx, workArea.x + workArea.width  - MIN_VIS));
    ny = Math.max(workArea.y,
                  Math.min(ny, workArea.y + workArea.height - FORKKNIFE_WIN_H));
    forkKnifeWindow.setPosition(Math.round(nx), Math.round(ny));
  });

  ipcMain.on('forkknife-drag-end', (event) => {
    if (!forkKnifeWindow || forkKnifeWindow.isDestroyed()) return;
    if (event.sender !== forkKnifeWindow.webContents) return;
    forkKnifeDragOffset = null;
  });

  ipcMain.on('forkknife-drag-reset', (event) => {
    if (!forkKnifeWindow || forkKnifeWindow.isDestroyed()) return;
    if (event.sender !== forkKnifeWindow.webContents) return;
    if (forkKnifeHomePos) {
      forkKnifeWindow.setPosition(forkKnifeHomePos.x, forkKnifeHomePos.y);
    }
  });

  ipcMain.on('panel-reset-position', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (key) resetPanelLayout(key);
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
      searchIndex:        i,     // stagger topics: each panel starts on a different term
      lastSearchTime:     0,     // Date.now() of last doSearch call; 0 = never searched
      manualLayout:       false, // true once customer drags/resizes while active; suppresses auto-size animations
      dwellTimer:         null,  // next-search setTimeout
      scrollTimer:        null,  // scroll setInterval
      rotationStartTimer: null,  // startup stagger setTimeout
      lastTrustedInputAt: 0,     // Date.now() of last panel-activity IPC; used to rescue first-click race
      loadTimer:          null,  // LOAD_TIMEOUT_MS watchdog set in doSearch, cleared on load end
      retryCount:         0,     // exponential-backoff attempt counter; reset on successful load
      firstSearchDone:    false, // set true after first search; skips global gap on first load
      searchLoadStartedAt: 0,    // Date.now() when doSearch called loadURL; used for timing log
      lastNavStatus:      0,     // HTTP response code from did-navigate; carried into did-finish-load log
      autoPhase:          'search', // 'search' | 'result' — current phase of the auto loop
      recentResultUrls:   [],       // recently visited result URLs (max ~20); prevents re-visiting the same page
      highlightTimer:     null,     // RESULT_HIGHLIGHT_MS timeout before navigating to a chosen result
      resultDwellTimer:   null,     // RESULT_DWELL_MS cap on result pages before returning to search
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
  windowsCreatedAt = Date.now();
  console.log(`[kiosk-auto] link-following enabled (policy: ${AUTO_LINK_POLICY}, probability: ${FOLLOW_RESULT_PROBABILITY})`);
}

// ---- Exports ----------------------------------------------------------------

module.exports = {
  createKioskWindow,
  computeClusterLayout,
  getKioskWindows: () => [...panelWindows.values()],
};
