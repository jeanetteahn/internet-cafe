const { BrowserView } = require('electron');
const path = require('path');

// ---- Tunables ---------------------------------------------------------
// Terms the four side panels rotate through. Each panel walks this list
// independently starting from a different offset, so they don't all show
// the same term at the same time.
const SEARCH_TERMS = [
  'weather today',
  'local news',
  'space news',
  'technology news',
  'science news',
  'world news',
];

// How the search URL is built. DuckDuckGo's no-JS HTML endpoint is used
// deliberately: it's far more tolerant of repeated automated requests than
// a JS-heavy results page from Google/Bing, though "tolerant" isn't the
// same as "guaranteed safe" — keep the refresh interval conservative.
function buildSearchUrl(term) {
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(term)}`;
}

const SIDE_REFRESH_MS = 4 * 60 * 1000; // refresh each side panel every 4 min
const SIDE_STAGGER_MS = 20 * 1000; // stagger panel starts by 20s each

// Center ("main") panel: a smaller, fixed rotation, refreshed less often.
const MAIN_URLS = ['https://duckduckgo.com/'];
const MAIN_REFRESH_MS = 10 * 60 * 1000;

// Layout: fractions of the screen, describing a cross-shaped cluster
// centered on screen. Everything outside this cluster still shows the
// video background untouched.
const LAYOUT_FRACTIONS = {
  center: { w: 0.30, h: 0.30 },
  side: { w: 0.20, h: 0.20 }, // top/bottom/left/right panels
  gap: 0.015, // gap between panels, as a fraction of width
};
// -------------------------------------------------------------------------

function computeBracketLayout(width, height) {
  const gapPx = LAYOUT_FRACTIONS.gap * width;
  const cW = LAYOUT_FRACTIONS.center.w * width;
  const cH = LAYOUT_FRACTIONS.center.h * height;
  const sW = LAYOUT_FRACTIONS.side.w * width;
  const sH = LAYOUT_FRACTIONS.side.h * height;

  const cx = (width - cW) / 2;
  const cy = (height - cH) / 2;

  return {
    center: { x: Math.round(cx), y: Math.round(cy), width: Math.round(cW), height: Math.round(cH) },
    top: {
      x: Math.round(cx + (cW - sW) / 2),
      y: Math.round(cy - gapPx - sH),
      width: Math.round(sW),
      height: Math.round(sH),
    },
    bottom: {
      x: Math.round(cx + (cW - sW) / 2),
      y: Math.round(cy + cH + gapPx),
      width: Math.round(sW),
      height: Math.round(sH),
    },
    left: {
      x: Math.round(cx - gapPx - sW),
      y: Math.round(cy + (cH - sH) / 2),
      width: Math.round(sW),
      height: Math.round(sH),
    },
    right: {
      x: Math.round(cx + cW + gapPx),
      y: Math.round(cy + (cH - sH) / 2),
      width: Math.round(sW),
      height: Math.round(sH),
    },
  };
}

function makeView() {
  return new BrowserView({
    webPreferences: {
      // Reuses preload.js, which attaches the same "report activity"
      // listeners here as on the main weather window, so moving the
      // mouse over a search panel dismisses the screensaver instantly
      // too, not just the video background.
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

function startRotation(view, urlList, startIndexOffset, intervalMs, buildUrl) {
  let index = startIndexOffset % urlList.length;

  const load = () => {
    const term = urlList[index];
    const url = buildUrl ? buildUrl(term) : term;
    view.webContents.loadURL(url).catch(() => {
      /* transient network/DNS errors are fine to ignore here */
    });
    index = (index + 1) % urlList.length;
  };

  load();
  const intervalId = setInterval(load, intervalMs);
  return intervalId;
}

/**
 * Attaches the 5-panel browser wall to a BrowserWindow. Returns a handle
 * with destroy() to tear everything down (used when the screensaver closes,
 * so it doesn't keep making network requests in the background).
 */
function attachBrowserWall(win) {
  const panels = {
    center: makeView(),
    top: makeView(),
    bottom: makeView(),
    left: makeView(),
    right: makeView(),
  };

  Object.values(panels).forEach((view) => win.addBrowserView(view));

  const applyLayout = () => {
    const { width, height } = win.getContentBounds();
    const bounds = computeBracketLayout(width, height);
    Object.entries(panels).forEach(([key, view]) => view.setBounds(bounds[key]));
  };

  applyLayout();
  win.on('resize', applyLayout);

  const intervalIds = [];

  // Center panel: slower rotation, starts immediately.
  intervalIds.push(startRotation(panels.center, MAIN_URLS, 0, MAIN_REFRESH_MS));

  // Side panels: staggered starts (0s, 20s, 40s, 60s) so their periodic
  // refreshes land at different times too, avoiding a burst of four
  // simultaneous requests every interval.
  const sideOrder = ['top', 'right', 'bottom', 'left'];
  sideOrder.forEach((key, i) => {
    setTimeout(() => {
      intervalIds.push(
        startRotation(panels[key], SEARCH_TERMS, i, SIDE_REFRESH_MS, buildSearchUrl)
      );
    }, i * SIDE_STAGGER_MS);
  });

  return {
    destroy() {
      win.removeListener('resize', applyLayout);
      intervalIds.forEach((id) => clearInterval(id));
      Object.values(panels).forEach((view) => {
        try {
          win.removeBrowserView(view);
        } catch (e) {
          /* window may already be closed */
        }
      });
    },
  };
}

module.exports = { attachBrowserWall, computeBracketLayout };
