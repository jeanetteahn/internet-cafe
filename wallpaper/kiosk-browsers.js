const { app, BrowserWindow, BrowserView, screen, ipcMain, globalShortcut, session } = require('electron');
const path = require('path');
const fs   = require('fs');
const http = require('http');
const { kioskLog } = require('./kiosk-log');
const { useSystemSpoonCursor } = require('./spoon-theme');

// DDG result cache — one HTML file per panel, loaded as the startup placeholder.
const cacheDir = path.join(app.getPath('userData'), 'ddg-cache');
try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (_) {}
// Per-term SERP HTML files live in a 'serp/' subdirectory.
const serpDir = path.join(cacheDir, 'serp');
try { fs.mkdirSync(serpDir, { recursive: true }); } catch (_) {}

// Returns true only if the saved SERP file starts with <!DOCTYPE (standards mode).
// Files saved before this fix lack the doctype and must be regenerated.
function serpFileValid(fp) {
  try {
    const buf = Buffer.allocUnsafe(16);
    const fd  = fs.openSync(fp, 'r');
    const n   = fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('latin1').toLowerCase().startsWith('<!doctype');
  } catch { return false; }
}

// ---- Clock / cursor size -----------------------------------------------------
// Used for clock/carbon window sizes, FK_GRAPHIC_W, and spoon cursor scaling.
const CLOCK_SIZE = 110; // window width and height (px)


// ---- Clock SVG ---------------------------------------------------------------
// Read once at startup; sent to the clock renderer over IPC on did-finish-load.
// The file must not be modified — the renderer works with the raw bytes.
const _clockSvgText = fs.readFileSync(path.join(__dirname, 'assets/clock/clock.svg'), 'utf8');

// ---- Carbon SVG + CO2.js ----------------------------------------------------
const _carbonSvgText = fs.readFileSync(path.join(__dirname, 'assets/carbon/carboncircle.svg'), 'utf8');
// Fail-soft: co2Instance is null when @tgwf/co2 is not installed (should not
// happen after npm install, but avoids a hard crash on first-launch if the
// node_modules directory is stale).
let co2Instance = null;
try {
  const { co2 } = require('@tgwf/co2');
  co2Instance = new co2({ model: 'swd' });
} catch (e) {
  console.error('[kiosk-carbon] @tgwf/co2 not installed — carbon indicator will show neutral:', e.message);
}

// ---- Search topics ----------------------------------------------------------
// Kid-safe ONLY: no news/current events, no words that commonly pull adult or
// violent content.  All terms must be safe for under-18 viewers.
//
// Each group carries a list of ALLOWED_DOMAINS that are relevant for its terms.
// doSearch picks 2-3 group domains + 1 general domain and appends site: filters
// to the DDG query so results land on approved pages.
const SEARCH_TERM_GROUPS = [
  {
    label: 'Space',
    domains: ['nasa.gov', 'space.com', 'si.edu', 'earthobservatory.nasa.gov'],
    terms: [
      'space pictures', 'planets solar system', 'mars rover photos',
      'international space station', 'galaxy telescope images', 'moon phases',
      'constellations for beginners', 'northern lights', 'how stars form',
      'comets and asteroids', 'saturn rings', 'jupiter facts',
      'james webb telescope images', 'astronaut training', 'solar eclipse facts',
    ],
  },
  {
    label: 'Animals',
    domains: ['nationalgeographic.com', 'worldwildlife.org', 'allaboutbirds.org', 'montereybayaquarium.org', 'sdzwildlifeexplorers.org'],
    terms: [
      'animal facts', 'ocean animals', 'coral reef animals', 'rainforest animals',
      'desert animals', 'arctic animals', 'penguin facts', 'whales and dolphins',
      'honey bee facts', 'butterfly life cycle', 'bird migration',
      'deep sea creatures', 'zoo animals', 'aquarium fish',
      'endangered animals conservation', 'octopus facts', 'sea turtles',
      'elephant facts', 'giraffe facts', 'owl facts', 'frog life cycle',
      'koala facts', 'panda bears', 'hummingbirds', 'baby animals',
    ],
  },
  {
    label: 'Earth and nature',
    domains: ['noaa.gov', 'usgs.gov', 'nps.gov', 'britannica.com'],
    terms: [
      'weather today', 'nature photography', 'national parks',
      'how volcanoes form', 'how rainbows form', 'types of clouds', 'water cycle',
      'ocean tides', 'rocks and minerals', 'mountains of the world',
      'waterfalls of the world', 'how caves form', 'glaciers and icebergs',
      'seasons explained', 'rainforest plants', 'desert plants',
      'tallest trees in the world', 'wildflowers', 'how rivers form',
      'dinosaur fossils',
    ],
  },
  {
    label: 'Science and technology',
    domains: ['britannica.com', 'phet.colorado.edu', 'khanacademy.org', 'sciencenewsexplores.org'],
    terms: [
      'science for kids', 'simple science experiments', 'how magnets work',
      'how plants grow', 'how electricity works', 'states of matter',
      'how light works', 'how sound works', 'chemistry experiments for kids',
      'robots for kids', 'coding for beginners', 'how computers work',
      'renewable energy', 'solar power', 'how batteries work',
    ],
  },
  {
    label: 'Inventions and history',
    domains: ['britannica.com', 'smithsonianmag.com', 'si.edu', 'loc.gov'],
    terms: [
      'inventions history', 'famous inventors', 'history of flight',
      'how airplanes fly', 'ancient egypt pyramids', 'ancient greece facts',
      'ancient rome architecture', 'history of the telephone',
      'history of trains', 'castles of the world', 'great wall of china',
      'maya civilization', 'history of the bicycle', 'famous scientists',
      'space exploration history',
    ],
  },
  {
    label: 'Geography and culture',
    domains: ['nationalgeographic.com', 'britannica.com', 'natgeokids.com'],
    terms: [
      'world landmarks', 'world geography', 'famous bridges',
      'countries of the world', 'world flags', 'seven wonders of the world',
      'famous lighthouses', 'islands of the world', 'famous museums',
      'world capitals', 'maps for kids', 'festivals around the world',
      'world languages', 'famous skyscrapers', 'longest rivers in the world',
    ],
  },
  {
    label: 'Arts and hobbies',
    domains: ['pbs.org', 'britannica.com', 'smithsonianmag.com'],
    terms: [
      'musical instruments', 'origami for beginners', 'how to draw animals',
      'gardening for beginners', 'easy paper crafts',
      'watercolor painting for beginners', 'how to build a birdhouse',
      'lego building ideas', 'knitting for beginners',
      'photography tips for beginners', 'learn to play ukulele',
      'chess for beginners', 'easy magic tricks', 'kite making',
      'pottery for beginners',
    ],
  },
  {
    label: 'Food',
    domains: ['britannica.com', 'pbs.org', 'easyscienceforkids.com'],
    terms: [
      'healthy snack ideas', 'easy baking recipes for kids',
      'fruits around the world', 'how bread is made', 'how chocolate is made',
      'how cheese is made', 'history of pizza', 'vegetable garden',
      'smoothie recipes', 'easy cookie recipes',
    ],
  },
  {
    label: 'Sports and outdoors',
    domains: ['nps.gov', 'britannica.com', 'pbs.org'],
    terms: [
      'how to ride a bike', 'soccer skills for beginners',
      'basketball drills for kids', 'swimming tips for beginners',
      'olympic sports history', 'skateboarding basics', 'yoga for kids',
      'hiking trails',
    ],
  },
];

// Flat term list for the shuffle-bag deck — derived from groups above.
// Declared with let so rebuildTopics() can extend it with local terms.
let SEARCH_TERMS = SEARCH_TERM_GROUPS.flatMap(g => g.terms);

// Map from every term to its group's approved domain list (built once at startup).
// Also declared with let so rebuildTopics() can add local-term entries.
let TERM_GROUP_DOMAINS = new Map(
  SEARCH_TERM_GROUPS.flatMap(g => g.terms.map(t => [t, g.domains]))
);

// ---- Local-topic constants --------------------------------------------------
// Template terms filled with the kiosk's geolocation city/region at startup.
// Kid-safe: nothing that pulls news, crime, nightlife, or sports schedules.
const LOCAL_TERM_TEMPLATES = [
  // Places and things to do
  '{city} weather', 'things to do in {city}', '{city} parks', '{city} museums',
  '{city} landmarks', '{city} zoo', '{city} public library', '{city} nature trails',
  '{city} {region} travel guide',
  // Food
  'family restaurants in {city}', 'places to eat in {city}', 'foods {city} is known for',
  // History and culture
  '{city} history', 'how {city} got its name', '{city} architecture',
  '{region} state symbols',
  // Nature and science
  'birds of {region}', '{region} wildlife', '{region} state parks',
  '{city} rivers and lakes', '{city} climate', '{city} science center',
];
// Approved source domains for local search terms (site: filters for DDG queries).
// nps.gov, weather.gov, kiddle.co, britannica.com, allaboutbirds.org, si.edu are
// already in ALLOWED_DOMAINS; en.wikivoyage.org and en.wikipedia.org are not.
const LOCAL_GROUP_DOMAINS = [
  'en.wikivoyage.org', 'en.wikipedia.org', 'nps.gov',
  'weather.gov', 'kiddle.co', 'britannica.com', 'allaboutbirds.org', 'si.edu',
];
// Extra allowed domains for auto-link following when a panel's current term is
// local.  NOT added to the global ALLOWED_DOMAINS — scoped to local panels only.
const LOCAL_EXTRA_DOMAINS = ['en.wikivoyage.org', 'en.wikipedia.org'];
// Probability of drawing a local term on each drawNextTerm call.
const LOCAL_TERM_RATIO = 1 / 8;
// How long to cache the kiosk's geolocation result before refreshing.
const LOCATION_REFRESH_MS = 6 * 60 * 60 * 1000; // 6 hours

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

// ALLOWED_DOMAINS is used in two places: (1) AUTO_LINK_POLICY='allowlist' controls
// which result links auto mode is allowed to follow; (2) BROWSING_POLICY='allowlist'
// controls what customers can navigate to in active mode (currently BROWSING_POLICY
// is 'open', so this list does not restrict customer browsing right now).
// Matching is exact hostname or any subdomain (see isDomainAllowed).
const ALLOWED_DOMAINS = [
  // US government / science
  'nasa.gov',
  'noaa.gov',
  'weather.gov',
  'nps.gov',
  'usgs.gov',
  'loc.gov',
  // Natural history & science museums
  'si.edu',
  'amnh.org',
  'nhm.ac.uk',
  'exploratorium.edu',
  'montereybayaquarium.org',
  // Nature / wildlife
  'nationalgeographic.com',
  'kids.nationalgeographic.com',
  'natgeokids.com',
  'worldwildlife.org',
  'allaboutbirds.org',
  'audubon.org',
  // Educational publishers / encyclopedias
  'britannica.com',
  'smithsonianmag.com',
  'sciencenewsexplores.org',
  'ducksters.com',
  'kiddle.co',
  'sciencekids.co.nz',
  // Space / astronomy
  'space.com',
  'earthobservatory.nasa.gov',
  // Public media
  'pbs.org',
  'pbskids.org',
  // Science education / interactive
  'phet.colorado.edu',
  'khanacademy.org',
  'libretexts.org',
  'ck12.org',
  'easyscienceforkids.com',
  // Kids reference / general
  'coolkidfacts.com',
  // Wildlife
  'sdzwildlifeexplorers.org',
  // Notes: kids.britannica.com is covered by britannica.com above.
  //        nationalzoo.si.edu is covered by si.edu above.
];

// Startup check: every domain in SEARCH_TERM_GROUPS must be in ALLOWED_DOMAINS.
for (const _g of SEARCH_TERM_GROUPS) {
  for (const _d of _g.domains) {
    if (!ALLOWED_DOMAINS.includes(_d)) {
      console.warn(`[kiosk] WARNING: group domain "${_d}" in group "${_g.label}" is not in ALLOWED_DOMAINS`);
    }
  }
}

// AD_TRACKER_DOMAINS: every request to these hosts (and their subdomains) is
// cancelled in all modes when AD_BLOCKING_ENABLED is true.  Result pages embed
// dozens of ad/sync iframes, and Chromium gives each cross-site iframe its own
// renderer process — a single National Geographic page took the kiosk from ~27
// to ~79 processes, which the NucBox can't sustain all day.  Blocking them also
// keeps ads off a kids' exhibit.  This does not touch site isolation or any
// other security setting.
// Flip AD_BLOCKING_ENABLED to true to re-enable the blocker if the process
// count becomes a problem again.
const AD_BLOCKING_ENABLED = false; // turns the ad/tracker request blocker on or off for all kiosk panels
const COOKIE_AUTO_ACCEPT_ENABLED = true; // auto-dismiss cookie consent banners in every panel
const AD_TRACKER_DOMAINS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'googletagservices.com', 'adservice.google.com', 'amazon-adsystem.com',
  'adnxs.com', 'adsrvr.org', 'rubiconproject.com', 'pubmatic.com',
  'openx.net', 'casalemedia.com', 'indexww.com', 'criteo.com', 'criteo.net',
  'taboola.com', 'outbrain.com', 'teads.tv', '3lift.com', 'sharethrough.com',
  'yieldmo.com', 'smartadserver.com', 'adform.net', 'bidswitch.net',
  'lijit.com', 'sovrn.com', 'media.net', 'gumgum.com', 'kargo.com',
  'adyoulike.com', 'omnitagjs.com', 'programmaticx.ai', 'colossusssp.com',
  '33across.com', 'id5-sync.com', 'rlcdn.com', 'demdex.net', 'krxd.net',
  'bluekai.com', 'agkn.com', 'everesttech.net', 'moatads.com',
  'scorecardresearch.com', 'quantserve.com', 'spotxchange.com',
  'tremorhub.com', 'adsafeprotected.com', 'doubleverify.com',
];

// ---- Tunables ---------------------------------------------------------------
// At the page bottom the panel jumps to the top and immediately moves to the
// next search term.  MIN_SEARCH_INTERVAL_MS is a floor that adds a short extra
// wait only when the page was very short (guards against DDG rate-limiting
// across 5 panels).  SEARCH_INTERVAL_MIN/MAX_MS is a randomised safety-net
// ceiling for pages that never trigger bottom detection.
const SEARCH_INTERVAL_MIN_MS = 35 * 1000; // random safety-net cap on a search page — minimum
const SEARCH_INTERVAL_MAX_MS = 60 * 1000; // random safety-net cap on a search page — maximum
const MIN_SEARCH_INTERVAL_MS =  5 * 1000; // min time between searches per panel — floor for very short pages
const BOTTOM_HOLD_MS         = 300;       // brief pause after jumping to top before loading next search
const SCROLL_STEP_PX         = 80;        // px scrolled per tick (tick rate; speed is now random per page)
const SCROLL_STEP_MS         = 250;       // ms between scroll ticks (bottom checks)
const SCROLL_SPEED_MIN_PX_S  = 200;       // slowest random auto-scroll speed (px/s)
const SCROLL_SPEED_MAX_PX_S  = 450;       // fastest random auto-scroll speed (px/s)
const AUTO_SCROLL_FRAME_MS   = 33;        // in-page auto-scroll frame interval (~30 fps); 16 = 60 fps if the GPU can afford it
const INACTIVITY_TIMEOUT_MS  = 120 * 1000; // idle grace period before auto mode resumes
const LOAD_TIMEOUT_MS        = 15 * 1000; // per-panel watchdog: abort and retry if a DDG load takes longer
const GLOBAL_SEARCH_GAP_MS   = 20 * 1000; // minimum gap between any two panels starting a DDG search
const FIRST_SEARCH_GAP_MS    =  3 * 1000; // shorter gap for each panel's very first search (lets windows fill faster)
const FOLLOW_RESULT_PROBABILITY = 1.0;        // chance of clicking a result after a search scroll; < 1 mixes in plain searches
const RESULT_DWELL_MIN_MS       = 15 * 1000;  // random dwell on a result page before returning to search — minimum
const RESULT_DWELL_MAX_MS       = 35 * 1000;  // random dwell on a result page before returning to search — maximum
const RESULT_LOAD_TIMEOUT_MS    = 12 * 1000;  // watchdog: abort a stalled result page load, move to next search
const RESULT_HIGHLIGHT_MS       = 600;         // visual highlight duration (ms) on the chosen anchor before navigating
const AUTO_LINK_POLICY          = 'allowlist'; // 'allowlist' = only ALLOWED_DOMAINS (strict, kid-safe);
                                               // 'allowlist-preferred' = prefer ALLOWED_DOMAINS, fall back to isPassesPolicy;
                                               // 'browsing' = use isPassesPolicy (BROWSING_POLICY rules)
const SHARED_RECENT_URLS_MAX    = 300;         // how many cross-panel recent result URLs to remember
const TERM_MISS_LIMIT           = 3;           // consecutive "no eligible results" before auto-skipping a term

// ---- Auto-mode error-page blocking ------------------------------------------
// Set AUTO_ERROR_BLOCK_ENABLED = false for a quick rollback: edit on Mac,
// push, then git pull + relaunch on Linux.  All blocking is skipped.
const AUTO_ERROR_BLOCK_ENABLED  = true;
const BAD_DOMAIN_TTL_MS         = 3 * 60 * 60 * 1000; // 3 hours in-memory; cleared on relaunch
// URL path extensions that indicate a downloadable file, not a web page.
// Matching URLs are skipped in pickRandomResult and filterCachedUrls.
const NON_PAGE_EXTENSIONS = [
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp', '.rtf', '.csv',
  '.zip', '.rar', '.7z', '.gz', '.tar',
  '.exe', '.dmg', '.pkg', '.deb', '.apk', '.iso',
  '.mp3', '.mp4', '.mov', '.wav', '.epub',
];
const RESULTS_PER_SEARCH_MIN    = 3;             // minimum result pages to visit per SERP before returning to search
const RESULTS_PER_SEARCH_MAX    = 4;             // maximum result pages to visit per SERP
const SERP_CACHE_TTL_MS         = 60 * 60 * 1000; // cache SERP result URLs per term for 1 hour
const SHOW_SERP_EVERY_N         = 5;             // show a real DDG SERP every Nth cached use; others skip DDG entirely
const DDG_PAUSE_BASE_MS         =  1 * 60 * 1000; // first bot-check all-panel pause: 1 min, doubles each strike
const DDG_PAUSE_MAX_MS          =  5 * 60 * 1000; // pause ceiling regardless of strike count
const SERP_RETURN_MAX_MS        = 15 * 1000;       // scroll cap on a return visit to the same results page
const DDG_STRIKE_RESET_MS       = 15 * 60 * 1000; // reset strike count after 15 min with no bot-checks
const DDG_MIN_STRIKE_GAP_MS     = 60 * 1000;      // ignore a new strike if one was counted within this window
// Approved pages shown on all panels during a DDG pause; must pass isDomainAllowed.
// Verified reachable (HTTP 200) via curl from the dev machine.
const PAUSE_START_URLS = [
  'https://spaceplace.nasa.gov/',
  'https://kids.nationalgeographic.com/',
  'https://www.ducksters.com/',
  'https://www.nasa.gov/',
  'https://sciencenewsexplores.org/',
];
// General-purpose approved domains added as one extra site: filter per search
// (after 2-3 group-specific domains are picked).
const GENERAL_DOMAINS = ['britannica.com', 'ducksters.com', 'kiddle.co', 'sciencekids.co.nz'];
const SOFT_ERROR_MAX_TEXT       = 1500; // body-phrase check only runs when page text is under this length

// Body phrases that indicate an error or gate page; checked only on short pages
// (real articles can mention "404" or "forbidden" in passing).
const SOFT_ERROR_BODY_PHRASES = [
  'access denied',
  "you don't have permission to access",
  '403 forbidden',
  'forbidden',
  '404 not found',
  'page not found',
  'domain is for sale',
  'buy this domain',
  'domain may be for sale',
  'this domain has expired',
  'checking your browser',
  'verify you are human',
  'are you a robot',
  'enable javascript and cookies to continue',
  'request blocked',
  'has been blocked',
  'error 1020',
  'something went wrong',
  'internal server error',
  'service unavailable',
  'bad gateway',
  'temporarily unavailable',
  'too many requests',
];

// Title phrases — kept narrow to avoid false-positives on real sites.
const SOFT_ERROR_TITLE_PHRASES = [
  'access denied',
  'page not found',
  '404 not found',
  '403 forbidden',
  'just a moment',
  'attention required',
  'are you a robot',
  'domain for sale',
  'service unavailable',
  'internal server error',
  'bad gateway',
  'site not found',
  'request blocked',
];

// Titles that are just a bare status code, e.g. "404", "Error 503",
// "500 - Error", "404 | Page Not Found".  The code must stand alone or be
// immediately followed by a separator/error word so "404 Media" and "500px"
// are NOT matched.
const SOFT_ERROR_TITLE_STATUS_RE =
  /^\s*(error\s*)?[45]\d\d\s*($|[-–—|:.,!]|error|not found|forbidden|unavailable)/i;

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
// Graphic width matches CLOCK_SIZE; height is derived from the SVG aspect ratio.
const _fkSvgRaw   = fs.readFileSync(path.join(__dirname, 'assets/utensils/forkknife.svg'), 'utf8');
const _fkVbMatch  = _fkSvgRaw.match(/viewBox="([\d.\s]+)"/);
const _fkVbParts  = _fkVbMatch ? _fkVbMatch[1].trim().split(/\s+/) : ['0', '0', '61.72', '21.86'];
const _fkVbW      = parseFloat(_fkVbParts[2]); // viewBox width  in SVG units
const _fkVbH      = parseFloat(_fkVbParts[3]); // viewBox height in SVG units
const FK_GRAPHIC_W = CLOCK_SIZE;                                   // 110 px
const FK_GRAPHIC_H = Math.round(FK_GRAPHIC_W * _fkVbH / _fkVbW); // ~39 px
// Transparent border for CSS drop-shadow — same approach and value as CLOCK_SHADOW_PAD /
// CARBON_SHADOW_PAD (declared below; literal here to avoid forward-reference).
// All positioning subtracts this pad so the graphic stays in the same on-screen spot.
const FK_SHADOW_PAD = 24; // px on each side; tune alongside --shadow-* in kiosk-forkknife.html
// Default position (px from work-area top-left) of the graphic face (not the window origin).
const FORKKNIFE_POSITION = { x: 24, y: 24 };
const FORKKNIFE_WIN_W    = FK_GRAPHIC_W + 2 * FK_SHADOW_PAD; // ~158 px
const FORKKNIFE_WIN_H    = FK_GRAPHIC_H + 2 * FK_SHADOW_PAD; // ~87 px

// ---- Spoon cursor -----------------------------------------------------------
// Pre-computed once at module init so every renderer can get the same rule.
// Sized so the spoon's diagonal (its viewBox extent rotated 45°) equals the
// fork element's rendered pixel length — visual parity with the nav buttons.
// To regenerate the index.html base64, run:  node scripts/build-spoon-cursor.js

// Walk SVG path d-attribute tokens and return { min, max, extent } for x.
function _pathXBounds(ds) {
  let minX = Infinity, maxX = -Infinity;
  const hit = x => { if (x < minX) minX = x; if (x > maxX) maxX = x; };
  for (const d of ds) {
    const toks = [...d.matchAll(/([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g)].map(m => m[0]);
    let i = 0, cx = 0, cmd = '';
    const n = () => { const v = parseFloat(toks[i] || '0'); i++; return isNaN(v) ? 0 : v; };
    while (i < toks.length) {
      if (/[MmLlHhVvCcSsQqTtAaZz]/.test(toks[i])) { cmd = toks[i++]; continue; }
      switch (cmd) {
        case 'M': cx=n();n();hit(cx);cmd='L';break; case 'm':cx+=n();n();hit(cx);cmd='l';break;
        case 'L': cx=n();n();hit(cx);break;         case 'l':cx+=n();n();hit(cx);break;
        case 'H': cx=n();hit(cx);break;              case 'h':cx+=n();hit(cx);break;
        case 'V': n();break;                          case 'v':n();break;
        case 'C': n();n();n();n();cx=n();n();hit(cx);break; case 'c':n();n();n();n();cx+=n();n();hit(cx);break;
        case 'S': n();n();cx=n();n();hit(cx);break;  case 's':n();n();cx+=n();n();hit(cx);break;
        case 'Q': n();n();cx=n();n();hit(cx);break;  case 'q':n();n();cx+=n();n();hit(cx);break;
        case 'T': cx=n();n();hit(cx);break;           case 't':cx+=n();n();hit(cx);break;
        case 'A': n();n();n();n();n();cx=n();n();hit(cx);break; case 'a':n();n();n();n();n();cx+=n();n();hit(cx);break;
        case 'Z': case 'z': break;
        default: i++; break;
      }
    }
  }
  return { min: minX===Infinity?0:minX, max: maxX===-Infinity?0:maxX,
           extent: (maxX===-Infinity?0:maxX) - (minX===Infinity?0:minX) };
}

const _fkAllDs         = [..._fkSvgRaw.matchAll(/\sd="([^"]+)"/g)].map(m => m[1]);
const _forkExtentUnits = _pathXBounds(_fkAllDs.slice(0, 2)).extent; // first 2 paths = fork group
const _forkRenderedPx  = _forkExtentUnits * FK_GRAPHIC_W / _fkVbW; // ≈105 px

const _spoonSvgRaw  = fs.readFileSync(path.join(__dirname, 'assets/utensils/spoon-cursor.svg'), 'utf8');
const _spoonVbMatch = _spoonSvgRaw.match(/viewBox="([\d.\s]+)"/);
const _spoonVbParts = _spoonVbMatch ? _spoonVbMatch[1].trim().split(/\s+/) : ['0', '0', '37.78', '37.77'];
const _spoonVbW     = parseFloat(_spoonVbParts[2]);
const _spoonVbH     = parseFloat(_spoonVbParts[3]);

// Uniform scale: map spoon viewBox diagonal → fork rendered length.
const _spoonDiagUnits  = Math.sqrt(_spoonVbW * _spoonVbW + _spoonVbH * _spoonVbH);
const _spoonScale      = _forkRenderedPx / _spoonDiagUnits;
const SPOON_CURSOR_W   = Math.round(_spoonVbW * _spoonScale); // ≈74 px
const SPOON_CURSOR_H   = Math.round(_spoonVbH * _spoonScale); // ≈74 px

// Shadow matches fork/knife nav buttons: stdDeviation=9, dy=4, opacity=0.42.
// At 3σ=27 px the outer cursor lands exactly on the 128-px Chromium limit.
const _SHADOW_SD  = 9, _SHADOW_DX = 0, _SHADOW_DY = 4;
const _SIGMA3     = Math.ceil(3 * _SHADOW_SD);                       // 27
const SPOON_SHADOW_PAD_LEFT   = _SIGMA3;                              // 27
const SPOON_SHADOW_PAD_TOP    = Math.max(0, _SIGMA3 - _SHADOW_DY);   // 23
const SPOON_SHADOW_PAD_RIGHT  = _SIGMA3;                              // 27
const SPOON_SHADOW_PAD_BOTTOM = _SIGMA3 + _SHADOW_DY;                // 31
const SPOON_OUTER_W = SPOON_CURSOR_W + SPOON_SHADOW_PAD_LEFT + SPOON_SHADOW_PAD_RIGHT;
const SPOON_OUTER_H = SPOON_CURSOR_H + SPOON_SHADOW_PAD_TOP  + SPOON_SHADOW_PAD_BOTTOM;

if (SPOON_OUTER_W > 128 || SPOON_OUTER_H > 128) {
  console.warn(`[kiosk-cursor] spoon cursor ${SPOON_OUTER_W}×${SPOON_OUTER_H} exceeds 128 px — Chromium will ignore the custom cursor`);
}

// Hotspot: bowl tip at viewBox (3.47, 0.50), scaled and offset by padding.
// Must stay in sync with index.html (separate process — see sync comment there).
const _spoonHotX = Math.round(3.47 * _spoonScale) + SPOON_SHADOW_PAD_LEFT;
const _spoonHotY = Math.round(0.50 * _spoonScale) + SPOON_SHADOW_PAD_TOP;

console.log(
  `[kiosk-cursor] fork=${Math.round(_forkRenderedPx)}px ` +
  `spoon-diag=${Math.round(_spoonDiagUnits * _spoonScale)}px ` +
  `art=${SPOON_CURSOR_W}×${SPOON_CURSOR_H} ` +
  `outer=${SPOON_OUTER_W}×${SPOON_OUTER_H} ` +
  `hotspot=(${_spoonHotX},${_spoonHotY})`
);

const _spoonStripped = _spoonSvgRaw
  .replace(/<\?xml[^?]*\?>\n?/, '')
  .replace(/<defs>[\s\S]*?<\/defs>\n?/, '')
  .replace(/\s+id="[^"]+"/g, '')
  .replace(/\s+data-name="[^"]+"/g, '')
  .replace(/class="cls-1"/g, 'fill="#ea4b00"')
  .replace(/\n\s*\n/g, '\n')
  .trim();
const _spoonBodyMatch = _spoonStripped.match(/^<svg[^>]*>([\s\S]*)<\/svg>$/);
const _spoonBody      = _spoonBodyMatch ? _spoonBodyMatch[1].trim() : _spoonStripped;

// Filter region percentages: must contain the full shadow bleed beyond the art box.
const _fRegX = `${-Math.ceil(SPOON_SHADOW_PAD_LEFT / SPOON_CURSOR_W * 100)}%`;
const _fRegY = `${-Math.ceil(SPOON_SHADOW_PAD_TOP  / SPOON_CURSOR_H * 100)}%`;
const _fRegW = `${Math.ceil(SPOON_OUTER_W / SPOON_CURSOR_W * 100) + 1}%`;
const _fRegH = `${Math.ceil(SPOON_OUTER_H / SPOON_CURSOR_H * 100) + 1}%`;

const _spoonSvg = [
  `<svg width="${SPOON_OUTER_W}" height="${SPOON_OUTER_H}" xmlns="http://www.w3.org/2000/svg">`,
  `<defs><filter id="s" x="${_fRegX}" y="${_fRegY}" width="${_fRegW}" height="${_fRegH}" color-interpolation-filters="sRGB">`,
  `<feDropShadow dx="${_SHADOW_DX}" dy="${_SHADOW_DY}" stdDeviation="${_SHADOW_SD}" flood-color="#000" flood-opacity="0.42"/>`,
  `</filter></defs>`,
  `<svg x="${SPOON_SHADOW_PAD_LEFT}" y="${SPOON_SHADOW_PAD_TOP}" width="${SPOON_CURSOR_W}" height="${SPOON_CURSOR_H}" viewBox="0 0 ${_spoonVbW} ${_spoonVbH}" filter="url(#s)">`,
  _spoonBody,
  `</svg>`,
  `</svg>`,
].join('');
const SPOON_CURSOR_URI = 'data:image/svg+xml;base64,' + Buffer.from(_spoonSvg).toString('base64');

// Chromium only shows a custom cursor bigger than 32×32 when the WHOLE image
// fits inside the page's viewport; otherwise it skips to the next cursor in
// the list.  The big spoon extends ~94 px right / ~104 px down of the
// pointer, so near every panel's right/bottom edge — and over the small
// overlay windows (grip, address bar, fork/knife, clock, carbon) — it was
// skipped straight to the system arrow.  A 32×32 spoon (exempt from that
// check) sits in between so the pointer is always a spoon.
const SPOON_SMALL_SIZE = 32;
const _SMALL_PAD       = 2;
const _smallArt        = SPOON_SMALL_SIZE - 2 * _SMALL_PAD;
const _smallScale      = _smallArt / Math.max(_spoonVbW, _spoonVbH);
const _spoonSmallHotX  = Math.round(3.47 * _smallScale) + _SMALL_PAD;
const _spoonSmallHotY  = Math.round(0.50 * _smallScale) + _SMALL_PAD;
const _spoonSmallSvg = [
  `<svg width="${SPOON_SMALL_SIZE}" height="${SPOON_SMALL_SIZE}" xmlns="http://www.w3.org/2000/svg">`,
  `<defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">`,
  `<feDropShadow dx="0" dy="1" stdDeviation="0.8" flood-color="#000" flood-opacity="0.42"/>`,
  `</filter></defs>`,
  `<svg x="${_SMALL_PAD}" y="${_SMALL_PAD}" width="${_smallArt}" height="${_smallArt}" viewBox="0 0 ${_spoonVbW} ${_spoonVbH}" filter="url(#s)">`,
  _spoonBody,
  `</svg>`,
  `</svg>`,
].join('');
const SPOON_SMALL_CURSOR_URI = 'data:image/svg+xml;base64,' + Buffer.from(_spoonSmallSvg).toString('base64');

// Single rule covers every state (grab, grabbing, resize, pointer, text).
// Linux with the "spoon" X11 theme active (see spoon-theme.js): force the
// native `default` cursor, which the theme draws as the spoon at one size
// everywhere — also overriding pages that set their own cursor.
// Otherwise (Windows/macOS dev, or theme missing): big spoon → small spoon →
// `default` (only if both images fail to load).
const SYSTEM_SPOON_CURSOR = useSystemSpoonCursor();
const _spoonRule = SYSTEM_SPOON_CURSOR
  ? '*{cursor:default!important}'
  : `*{cursor:url('${SPOON_CURSOR_URI}') ${_spoonHotX} ${_spoonHotY},` +
    `url('${SPOON_SMALL_CURSOR_URI}') ${_spoonSmallHotX} ${_spoonSmallHotY},default!important}`;
console.log(`[kiosk-cursor] ${SYSTEM_SPOON_CURSOR ? 'using system spoon theme' : 'using CSS spoon cursor'}`);
const PANEL_CURSOR_CSS      = _spoonRule;
const HANDLE_CURSOR_CSS     = _spoonRule;
const GRIP_CURSOR_CSS       = _spoonRule;
const FORKKNIFE_CURSOR_CSS  = _spoonRule;
const ADDRESSBAR_CURSOR_CSS = _spoonRule;

// Busy cursor for active panels that are slow to load (> 1500 ms).
// On Linux with the system spoon theme: `progress` maps to spoon-busy.cursor
// (animated 24-frame spinner).  On dev machines (CSS cursor): CSS cannot
// animate, so we keep the static spoon and just log the state changes.
const PANEL_BUSY_CSS = SYSTEM_SPOON_CURSOR
  ? '*{cursor:progress!important}'
  : PANEL_CURSOR_CSS;

// ---- Clock window ------------------------------------------------------------
// SVG viewBox is 87.2×87.2; the window is square.
// CLOCK_SIZE is declared at the top of the file.
// Offset from the work area's top-left corner.
// Tuned for 1920×1080: centers the clock on the top-right panel's top edge.
const CLOCK_POSITION = { x: 1332, y: 20 };
const CLOCK_TZ_REFETCH_MS = 60 * 60 * 1000; // re-check timezone once per hour
// Transparent border so the CSS drop-shadow has room to render — same approach
// as CARBON_SHADOW_PAD.  All positioning subtracts this pad so the clock face
// stays in the same on-screen spot.
const CLOCK_SHADOW_PAD = 24; // px on each side; tune alongside --shadow-* in kiosk-clock.html
const CLOCK_WIN_SIZE   = CLOCK_SIZE + 2 * CLOCK_SHADOW_PAD; // actual BrowserWindow size

// ---- Address bar window -------------------------------------------------------
// Dimensions match the SVG viewBox (310.59 × 43.62 → 311 × 44 px).
const AB_WIN_W                   = 311; // address bar window width
const AB_WIN_H                   = 44;  // address bar window height
const ADDRESSBAR_DOCK_OVERHANG_X   = 100; // bar overhangs hub browser-area left edge by this many px
const ADDRESSBAR_DOCK_BOTTOM_INSET = 58;  // bar bottom sits this many px above hub browser-area bottom
const ADDRESSBAR_MAX_W             = 900; // maximum expanded width (px)

// ---- Carbon indicator window -------------------------------------------------
const CARBON_SIZE       = CLOCK_SIZE; // match clock window size exactly
// Transparent border added around the window so the CSS drop-shadow has room to
// render.  The circle stays at the same on-screen position — all positioning
// code subtracts this pad so the window origin moves left/up by the same amount.
const CARBON_SHADOW_PAD = 24; // px on each side; tune alongside the CSS shadow values
const CARBON_WIN_SIZE   = CARBON_SIZE + 2 * CARBON_SHADOW_PAD; // actual BrowserWindow size
// Offset from the panel window's top-left corner to the carbon circle position.
const CARBON_ANCHOR  = { x: 140, y: 120 };
// CO2 thresholds (grams per page view) for the score log scale.
// 0.1 g → score 0 (blue, clean); 1.0 g → score 1 (orange, dirty).
const CARBON_CLEAN_G = 0.1;
const CARBON_DIRTY_G = 1.0;

// ---- Active-panel animation tunables ----------------------------------------
// When a customer starts using a panel it grows to ACTIVE_SCALE × its home
// size; when it goes idle it shrinks back.  The tween runs at ~60 fps via
// setInterval (no platform-native animation API needed — works on Cinnamon).
const ACTIVE_SCALE        = 1.25; // scale factor applied to home width and height
const ACTIVE_ANIM_MS      = 220;  // tween duration in ms (both enlarge and shrink)
const TWEEN_INTERVAL_MS   = 16;   // step interval ms (~60 fps)
const FIRST_CLICK_GRACE_MS = 1500; // grace window for first-click IPC race (see will-navigate comment)

// "Loading…" placeholder shown immediately.  Its own white body background
// keeps the page area solid during the brief moment before the target page
// paints (the panel view is transparent; #pagefill in kiosk-handle.html
// provides the white behind it).
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

// ---- DDG shared backoff state -----------------------------------------------
// All panels share these; a single bot-check pauses DDG for everyone.
let ddgPausedUntil    = 0;    // timestamp: skip DDG until Date.now() > this
let ddgBotStrikes     = 0;    // consecutive bot-check count for exponential pause length
let ddgStrikeResetTimer = null; // setTimeout: resets ddgBotStrikes after DDG_STRIKE_RESET_MS clean

// ---- SERP cache (per-term) --------------------------------------------------
// After each real DDG search, we cache the policy-approved result URLs for
// that term so future draws of the same term can skip the DDG page entirely.
const serpCache         = new Map(); // term -> { urls: [...], fetchedAt: timestamp }
const serpCacheUseCount = new Map(); // term -> consecutive cached uses since last real SERP fetch

// ---- DDG rate stats (10-min rolling window) ---------------------------------
let ddgStats = { searches: 0, cacheHits: 0, savedSerpShows: 0, resultsVisited: 0, botChecks: 0, noEligibleMisses: 0, downloadsBlocked: 0, local: 0, windowStart: 0 };
let ddgSummaryTimer = null; // module-level so V8 keeps it alive
let ddgLastStrikeAt = 0;   // Date.now() of the last counted bot-check strike (60 s guard)
let parkUrlIndex    = 0;   // round-robin index into PAUSE_START_URLS
const blockedDownloadUrls = new Set(); // URLs that triggered a download this session; never picked again

// ---- Location state (local topics) -----------------------------------------
// Set by startLocationWatch() and updated by refreshLocationInBackground().
// Null means no location is known; panels run static topics only.
let kioskLocation       = null;  // { city, regionName, country, countryCode, lat, lon }
let LOCAL_TERMS         = new Set(); // filled-in local search terms (rebuilt by rebuildTopics)
let localWeatherTerm    = null;      // the "{city} weather" term for the current location
let localSearchDeck     = [];        // separate shuffle bag for local terms
let _locationRefreshTimer = null;    // setInterval id for LOCATION_REFRESH_MS periodic refresh
const LOCATION_CACHE_FILE = path.join(app.getPath('userData'), 'kiosk-location.json');

// Delete per-term SERP HTML files older than the in-memory TTL at startup.
try {
  const _cutoff = Date.now() - SERP_CACHE_TTL_MS;
  for (const _f of fs.readdirSync(serpDir)) {
    if (!_f.endsWith('.html')) continue;
    try {
      const _fp = path.join(serpDir, _f);
      if (fs.statSync(_fp).mtimeMs < _cutoff) fs.unlinkSync(_fp);
    } catch (_) {}
  }
} catch (_) {}

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
const panelStates     = new Map(); // key -> { mode, inactivityTimer, currentTerm,
                                   //          lastSearchTime, manualLayout,
                                   //          dwellTimer, scrollTimer, rotationStartTimer,
                                   //          autoPhase, recentResultUrls,
                                   //          highlightTimer, resultDwellTimer, searchCount }
const ignoreNextMoves  = new Map(); // key -> timeout-id | null
const resizeState      = new Map(); // key -> { startBounds, cornerDx, cornerDy } | null
const panelDragOffsets = new Map(); // key -> { dx, dy } | null

// ---- Drag shield state -------------------------------------------------------
const dragShields     = [];    // one BrowserWindow per display, created at startup
let shieldDragType    = null;  // 'forkknife'|'clock'|'panel'|'resize'|'addressbar'|'carbon'
let shieldDragKey     = null;  // panel key when shieldDragType is 'panel' or 'resize'
let shieldSafetyTimer = null;

// webContentsIdToKey is module-level (not scoped to attachActivityHandling)
// so it is available to any future code that needs to route IPC by view id.
const webContentsIdToKey = new Map();

// key -> latest hinge placements reported by that panel's kiosk-handle.html.
const panelHinges = new Map();
const HINGE_BORDER_COLOR = '#e74e25'; // must match #border in kiosk-handle.html

// ---- Busy-cursor state -------------------------------------------------------
// Active only for panels in 'active' mode that are slow to load (> 1500 ms).
const panelBusyOnsetTimers = new Map(); // key -> timer id — fires after 1500 ms still-loading
const panelBusyCapTimers   = new Map(); // key -> timer id — 20 s safety cap
const panelBusyActive      = new Map(); // key -> bool     — busy cursor currently shown
const panelCursorCssKeys   = new Map(); // key -> string   — insertCSS key for current rule

// ---- Bad-domain memory (auto-mode error blocking) ---------------------------
// hostname -> expiry timestamp.  In-memory only; a relaunch on Linux clears it.
const badDomains = new Map();

// ---- Shared auto-browse coordination ----------------------------------------
// Module-level (not in panelStates) so all five panels read the same data.
// Never let skippedTerms shrink the deck below 20 terms (TERM_MISS_LIMIT guard).
const sharedOnScreenUrls = new Map(); // key -> result URL currently displayed in that panel
const sharedRecentUrls   = [];        // last SHARED_RECENT_URLS_MAX result URLs, any panel
const termMissCounts     = new Map(); // term -> consecutive-miss count; reset on first success
const skippedTerms       = new Set(); // terms auto-dropped this session (miss limit reached)
let   searchDeck         = [];        // shuffle-bag deck: terms not yet drawn this round

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// Returns the registrable base domain so sub-domain variants of the same site
// compare equal (kids.nationalgeographic.com === nationalgeographic.com, etc.).
function baseDomain(hostname) {
  if (!hostname) return '';
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  // Country-code TLD + 2nd-level word (co.uk, co.nz, com.au, gov.uk, ac.uk …)
  if (tld.length === 2 && sld.length <= 4) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

// Mark a domain bad for BAD_DOMAIN_TTL_MS.  Only logs the first time a host is
// added so the log stays readable when the same domain is refreshed.
function markBadDomain(url, reason) {
  if (!AUTO_ERROR_BLOCK_ENABLED) return;
  const host = hostnameOf(url);
  if (!host || isDdgHost(url)) return;
  const expiry = Date.now() + BAD_DOMAIN_TTL_MS;
  if (!badDomains.has(host)) {
    console.log(`[kiosk-auto] bad domain marked: ${host} (${reason})`);
  }
  badDomains.set(host, expiry);
}

// Returns true if the hostname is currently in the bad-domain list.
// Deletes expired entries on lookup.
function isBadDomain(url) {
  if (!AUTO_ERROR_BLOCK_ENABLED) return false;
  const host = hostnameOf(url);
  if (!host) return false;
  const expiry = badDomains.get(host);
  if (expiry === undefined) return false;
  if (Date.now() > expiry) { badDomains.delete(host); return false; }
  return true;
}

function hingePayload(key) {
  const hinges = panelHinges.get(key);
  if (!hinges) return null;
  return {
    hinges,
    borderColor: HINGE_BORDER_COLOR,
    offsetX: HARDWARE_MARGIN,                 // page view's origin inside the window
    offsetY: HARDWARE_MARGIN + HANDLE_HEIGHT,
  };
}

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
let clockWindow     = null; // analog clock overlay window
let clockDragOffset = null; // { dx, dy } set at drag-start, cleared at drag-end
let clockHomePos    = null; // home position, restored when all panels go idle
let clockTimezone   = null; // IANA timezone from ip-api.com, null = use system time
let clockTzTimer    = null; // setInterval id for hourly re-fetch
let addressBarWindow     = null;     // floating address bar for the active panel
let addressBarDragOffset = null;     // { dx, dy } set at drag-start, cleared at drag-end
let addressBarDocked     = true;     // true = follows target; false = free-floating
let addressBarKey        = 'hub';    // which panel the address bar currently tracks
let addressBarLiveUrl    = '';       // current URL shown in the bar
let addressBarCurrentW   = AB_WIN_W; // current window width (AB_WIN_W when collapsed)
let carbonWindow      = null;  // carbon indicator overlay window
let carbonDragOffset  = null;  // { dx, dy } set at drag-start, cleared at drag-end
let carbonDocked      = true;  // true = follows hub; false = free-floating after drag

// Set in createKioskWindow; needed by health check and crash recovery to recreate
// overlay windows without requiring the caller to pass workArea again.
let _lastWorkArea = null;

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

// ---- Drag move throttling ---------------------------------------------------
// Renderers send a *-drag-move IPC on every pointermove — hundreds a second
// with a high-rate mouse — and each one is a window move (an X11 round trip,
// plus two more for the hub's address bar and carbon overlays).  Every move
// handler reads the live cursor position, so dropping the in-between calls
// loses nothing: run at most once per frame, always with a trailing call so
// the final position lands.
const DRAG_FRAME_MS = 16;

function frameThrottle(fn) {
  let last = 0, timer = null, lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (timer) return;
    const wait = DRAG_FRAME_MS - (Date.now() - last);
    if (wait <= 0) { last = Date.now(); fn(...lastArgs); return; }
    timer = setTimeout(() => { timer = null; last = Date.now(); fn(...lastArgs); }, wait);
  };
}

// ---- Drag shield helpers ----------------------------------------------------

function isShieldSender(wc) {
  return dragShields.some(w => !w.isDestroyed() && w.webContents === wc);
}

function createDragShields() {
  if (dragShields.length > 0) return;
  for (const display of screen.getAllDisplays()) {
    const { x, y, width, height } = display.bounds;
    const w = new BrowserWindow({
      x, y, width, height,
      frame:       false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable:   false,
      show:        false,
      webPreferences: {
        preload:          path.join(__dirname, 'kiosk-drag-shield-preload.js'),
        contextIsolation: true,
        nodeIntegration:  false,
        sandbox:          true,
      },
    });
    w.loadFile(path.join(__dirname, 'kiosk-drag-shield.html'));
    w.webContents.on('dom-ready', () => {
      w.webContents.insertCSS(PANEL_CURSOR_CSS, { cssOrigin: 'user' }).catch(() => {});
    });
    keepOnAllWorkspaces(w);
    dragShields.push(w);
  }
}

function showDragShield(type, key) {
  shieldDragType = type;
  shieldDragKey  = key || null;
  clearTimeout(shieldSafetyTimer);
  shieldSafetyTimer = setTimeout(hideDragShield, 2000);
  for (const w of dragShields) {
    if (!w.isDestroyed()) w.showInactive();
  }
}

function hideDragShield() {
  clearTimeout(shieldSafetyTimer);
  shieldSafetyTimer = null;
  shieldDragType = null;
  shieldDragKey  = null;
  for (const w of dragShields) {
    if (!w.isDestroyed()) w.hide();
  }
  // Every drag/resize ends here.  The window manager may have raised the
  // dragged window over the clock/carbon/fork-knife (all alwaysOnTop peers),
  // burying them — put the overlays back on top.
  restackOverlays();
}

// Workspace switches and "Show Desktop" would otherwise take kiosk windows
// with them.  No-op on Windows.
function keepOnAllWorkspaces(win) {
  try { win.setVisibleOnAllWorkspaces(true); } catch (_) {}
}

// Factored-out move logic — called by both the original source-window IPC
// handler (pointer still inside the source window) and the shield IPC handler.
function doForkknifeDragMove() {
  if (!forkKnifeWindow || forkKnifeWindow.isDestroyed()) return;
  if (!forkKnifeDragOffset) return;
  const cursor       = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayMatching(forkKnifeWindow.getBounds());
  const MIN_VIS      = 20;
  let nx = cursor.x - forkKnifeDragOffset.dx;
  let ny = cursor.y - forkKnifeDragOffset.dy;
  nx = Math.max(workArea.x - FK_GRAPHIC_W + MIN_VIS - FK_SHADOW_PAD,
                Math.min(nx, workArea.x + workArea.width  - MIN_VIS - FK_SHADOW_PAD));
  ny = Math.max(workArea.y - FK_SHADOW_PAD,
                Math.min(ny, workArea.y + workArea.height - FK_GRAPHIC_H - FK_SHADOW_PAD));
  forkKnifeWindow.setPosition(Math.round(nx), Math.round(ny));
}

function doClockDragMove() {
  if (!clockWindow || clockWindow.isDestroyed()) return;
  if (!clockDragOffset) return;
  const cursor       = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayMatching(clockWindow.getBounds());
  const MIN_VIS      = 20;
  let nx = cursor.x - clockDragOffset.dx;
  let ny = cursor.y - clockDragOffset.dy;
  nx = Math.max(workArea.x - CLOCK_SIZE + MIN_VIS - CLOCK_SHADOW_PAD,
                Math.min(nx, workArea.x + workArea.width  - MIN_VIS - CLOCK_SHADOW_PAD));
  ny = Math.max(workArea.y - CLOCK_SHADOW_PAD,
                Math.min(ny, workArea.y + workArea.height - CLOCK_SIZE - CLOCK_SHADOW_PAD));
  clockWindow.setPosition(Math.round(nx), Math.round(ny));
}

function doPanelDragMove(key) {
  const win = panelWindows.get(key);
  if (!win || win.isDestroyed()) return;
  const offset = panelDragOffsets.get(key);
  if (!offset) return;
  const cursor = screen.getCursorScreenPoint();
  win.setPosition(Math.round(cursor.x - offset.dx), Math.round(cursor.y - offset.dy));
}

function doAddressBarDragMove() {
  if (!addressBarWindow || addressBarWindow.isDestroyed()) return;
  if (!addressBarDragOffset) return;
  const cursor       = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayMatching(addressBarWindow.getBounds());
  const MIN_VIS      = 20;
  let nx = cursor.x - addressBarDragOffset.dx;
  let ny = cursor.y - addressBarDragOffset.dy;
  nx = Math.max(workArea.x - AB_WIN_W + MIN_VIS, Math.min(nx, workArea.x + workArea.width  - MIN_VIS));
  ny = Math.max(workArea.y, Math.min(ny, workArea.y + workArea.height - AB_WIN_H));
  addressBarWindow.setPosition(Math.round(nx), Math.round(ny));
}

function doCarbonDragMove() {
  if (!carbonWindow || carbonWindow.isDestroyed()) return;
  if (!carbonDragOffset) return;
  const cursor       = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayMatching(carbonWindow.getBounds());
  const MIN_VIS      = 20;
  let nx = cursor.x - carbonDragOffset.dx;
  let ny = cursor.y - carbonDragOffset.dy;
  nx = Math.max(workArea.x - CARBON_SIZE + MIN_VIS - CARBON_SHADOW_PAD,
                Math.min(nx, workArea.x + workArea.width  - MIN_VIS - CARBON_SHADOW_PAD));
  ny = Math.max(workArea.y - CARBON_SHADOW_PAD,
                Math.min(ny, workArea.y + workArea.height - CARBON_SIZE - CARBON_SHADOW_PAD));
  carbonWindow.setPosition(Math.round(nx), Math.round(ny));
}

// Frame-throttled entry points used by the drag/resize IPC handlers.
// (updateResize is declared further down; function declarations hoist.)
const dragMove = {
  forkknife:  frameThrottle(doForkknifeDragMove),
  clock:      frameThrottle(doClockDragMove),
  panel:      frameThrottle(doPanelDragMove),
  resize:     frameThrottle(updateResize),
  addressbar: frameThrottle(doAddressBarDragMove),
  carbon:     frameThrottle(doCarbonDragMove),
};

// ---- Panel view factory ------------------------------------------------------

function makePanelView() {
  const view = new BrowserView({
    webPreferences: {
      preload:                    path.join(__dirname, 'kiosk-preload.js'),
      contextIsolation:           true,
      nodeIntegration:            false,
      sandbox:                    true,
      nodeIntegrationInSubFrames: true,
    },
  });
  // Transparent so the full brackets and orange border lines remain visible
  // while a new page is loading.  kiosk-handle.html's #pagefill div covers
  // exactly the page area with white, so the panel looks solid during loads
  // even though the view itself is see-through.
  view.setBackgroundColor('#00000000');
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

// Converts a search term to a safe filename slug for serpDir.
function termToSlug(term) {
  return term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function buildSearchUrl(term, sites) {
  // &kp=1 enables DuckDuckGo strict SafeSearch.
  // sites is an optional array of domain strings; if provided, appends
  // "site:d1 OR site:d2 ..." so results land on approved pages.
  let q = term;
  if (sites && sites.length > 0) {
    q += ' ' + sites.map(d => 'site:' + d).join(' OR ');
  }
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kp=1`;
}

// opts.local: when true, also allow LOCAL_EXTRA_DOMAINS and any .gov hostname.
// These extras apply only while a panel's currentTerm is in LOCAL_TERMS.
function isDomainAllowed(url, opts = {}) {
  try {
    const { hostname } = new URL(url);
    if (ALLOWED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) return true;
    if (opts.local) {
      if (LOCAL_EXTRA_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) return true;
      if (hostname.endsWith('.gov')) return true; // any .gov domain (city, state, federal)
    }
    return false;
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

// Cancels every request to AD_TRACKER_DOMAINS.  The URL filter is matched
// natively, so only blocked requests ever reach this JS callback.
let adBlockInstalled = false;
let adBlockCount     = 0;
function installAdTrackerBlock() {
  if (adBlockInstalled) return;
  adBlockInstalled = true;
  const urls = AD_TRACKER_DOMAINS.flatMap(d => [`*://${d}/*`, `*://*.${d}/*`]);
  session.defaultSession.webRequest.onBeforeRequest({ urls }, (_details, callback) => {
    adBlockCount += 1;
    callback({ cancel: true });
  });
  setInterval(() => {
    if (adBlockCount > 0) kioskLog(`ad/tracker requests blocked in last 5 min: ${adBlockCount}`);
    adBlockCount = 0;
  }, 5 * 60 * 1000);
}

let _cookieConsentScript = null;
function getCookieConsentScript() {
  if (_cookieConsentScript !== null) return _cookieConsentScript;
  try {
    _cookieConsentScript = fs.readFileSync(path.join(__dirname, 'kiosk-cookie-consent.js'), 'utf8');
  } catch (e) {
    kioskLog('cookie consent script missing:', e.message);
    _cookieConsentScript = '';
  }
  return _cookieConsentScript;
}

let cookieConsentCount = 0;

// Blocks 4xx/5xx responses for auto-mode result-phase loads at the network
// layer, before any page content is transferred.  Cancelling the request makes
// Chromium fire did-fail-load with ERR_ABORTED (-3), which we filter out in the
// normal did-fail-load handler.  Instead we schedule onResultRejected directly
// via setTimeout so backups are tried without waiting for the full page.
//
// Only one onHeadersReceived listener is allowed per session; installAdTrackerBlock
// uses onBeforeRequest (not onHeadersReceived), so there is no conflict.
function installAutoErrorBlock() {
  if (!AUTO_ERROR_BLOCK_ENABLED) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    try {
      if (details.resourceType === 'mainFrame' && details.statusCode >= 400) {
        const key = webContentsIdToKey.get(details.webContentsId);
        const ps  = key ? panelStates.get(key) : null;
        if (ps && ps.mode === 'auto' && ps.autoPhase === 'result') {
          const reason = `http-${details.statusCode}`;
          console.log(`[kiosk-auto] ${key} HTTP ${details.statusCode} blocked on result: ${details.url}`);
          markBadDomain(details.url, reason);
          // did-fail-load fires with ERR_ABORTED (-3) which we filter out, so
          // trigger the rejection here instead.
          setTimeout(() => onResultRejected(key, details.url, reason, false), 0);
          callback({ cancel: true });
          return;
        }
      }
    } catch (_) {}
    callback({});
  });
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

function isNonPageUrl(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    return NON_PAGE_EXTENSIONS.some(ext => p.endsWith(ext));
  } catch { return false; }
}

// Prevents any file download from opening a save dialog on any panel.
// Auto result phase: cancel, skip the URL, try next queued result.
// Active mode: cancel, show friendly error page.
function installDownloadBlock() {
  session.defaultSession.on('will-download', (event, item, webContents) => {
    event.preventDefault();
    item.cancel();
    const key  = webContents ? webContentsIdToKey.get(webContents.id) : undefined;
    const ps   = key ? panelStates.get(key) : null;
    const url      = item.getURL();
    const filename = item.getFilename();
    const mode     = ps ? ps.mode : 'unknown';
    kioskLog(`[kiosk-download] ${key || 'unknown'} blocked download (${mode}): ${url} (${filename})`);
    ddgStats.downloadsBlocked++;
    blockedDownloadUrls.add(url);
    if (!ps) return;
    if (ps.mode === 'auto' && ps.autoPhase === 'result') {
      clearTimeout(ps.loadTimer);
      ps.loadTimer = null;
      onResultRejected(key, url, 'download', false);
    } else if (ps.mode === 'active') {
      const v = panelViews[key];
      if (v && !v.webContents.isDestroyed()) {
        v.webContents.loadURL(
          buildErrorPageUrl("Downloads aren't available on this computer.", url)
        ).catch(() => {});
      }
    }
  });
}

// ---- Programmatic move/resize helpers ---------------------------------------

function setPanelBoundsIgnored(key, bounds) {
  const existing = ignoreNextMoves.get(key);
  if (existing) clearTimeout(existing);
  ignoreNextMoves.set(key, setTimeout(() => ignoreNextMoves.set(key, null), 400));
  const win = panelWindows.get(key);
  if (win && !win.isDestroyed()) win.setBounds(bounds);
  if (key === 'hub') repositionAddressBarTo(bounds);
  if (key === 'hub') repositionCarbonTo(bounds);
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
  topLeft:     ['corner-tr'],
  topRight:    [],
  bottomLeft:  [],
  bottomRight: ['corner-tr'],
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
  restackOverlays();
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

// ---- Panel layering ---------------------------------------------------------
// panelOrder is the back-to-front stacking of the five panels (last = front).
// Any deliberate use of a panel (click, key, drag, resize) brings it to the
// front; restackAll() replays this order instead of always forcing the hub on
// top, so the 30 s health check no longer undoes the customer's layering.
// When every panel is idle again the default order (hub on top) returns.
const DEFAULT_PANEL_ORDER = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'hub'];
let panelOrder = [...DEFAULT_PANEL_ORDER];
let frontKey   = null; // panel the customer is using now; only its strip is highlighted

function bringPanelToFront(key, force) {
  if (!panelWindows.has(key)) return;
  const alreadyFront = panelOrder[panelOrder.length - 1] === key && frontKey === key;
  if (alreadyFront && !force) return;
  panelOrder = panelOrder.filter(k => k !== key).concat(key);
  const win = panelWindows.get(key);
  if (win && !win.isDestroyed()) win.moveTop();
  restackOverlays();
  setFrontPanel(key);
}

// Highlight (grey strip) only the front panel, and only while it is active;
// every other strip stays transparent.
function setFrontPanel(key) {
  frontKey = key;
  for (const k of panelWindows.keys()) {
    const ps = panelStates.get(k);
    sendModeToHandle(k, (k === frontKey && ps && ps.mode === 'active') ? 'active' : 'auto');
  }
}

// Called by the Reset button IPC handler.  Cancels any in-flight tween,
// clears the manual-layout flag, and snaps the panel back to home bounds.
function resetPanelLayout(key) {
  cancelTween(key);
  if (enlargedKey === key) enlargedKey = null;
  const ps = panelStates.get(key);
  if (ps) ps.manualLayout = false;
  if (key === 'hub') addressBarDocked = true;
  if (key === 'hub') { carbonDocked = true; kioskLog('[kiosk-carbon] re-docked on hub reset'); repositionCarbon(); }
  sendPanelHome(key);
  restackAll();
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

// ---- Address bar helpers ----------------------------------------------------

function repositionAddressBarTo(hubBounds) {
  if (!addressBarWindow || addressBarWindow.isDestroyed()) return;
  if (!addressBarDocked) return;
  const M  = HARDWARE_MARGIN;
  const ax = hubBounds.x + M - ADDRESSBAR_DOCK_OVERHANG_X;
  const ay = hubBounds.y + hubBounds.height - M - ADDRESSBAR_DOCK_BOTTOM_INSET - AB_WIN_H;
  addressBarWindow.setPosition(Math.round(ax), Math.round(ay));
}

function repositionAddressBar() {
  const win = panelWindows.get('hub');
  if (!win || win.isDestroyed()) return;
  repositionAddressBarTo(win.getBounds());
}

function repositionCarbonTo(hubBounds) {
  if (!carbonWindow || carbonWindow.isDestroyed()) return;
  if (!carbonDocked) return;
  carbonWindow.setPosition(
    Math.round(hubBounds.x + CARBON_ANCHOR.x - CARBON_SHADOW_PAD),
    Math.round(hubBounds.y + CARBON_ANCHOR.y - CARBON_SHADOW_PAD)
  );
}

function repositionCarbon() {
  const win = panelWindows.get('hub');
  if (!win || win.isDestroyed()) return;
  repositionCarbonTo(win.getBounds());
}

function retargetAddressBar(key) {
  if (key === addressBarKey) return;
  addressBarKey = key;
  const view = panelViews[key];
  if (view && !view.webContents.isDestroyed()) {
    const url = view.webContents.getURL();
    if (url) pushAddressBarUrl(url);
  }
}

function pushAddressBarUrl(url) {
  if (!url || url.startsWith('data:') || url === 'about:blank') return;
  addressBarLiveUrl = url;
  if (addressBarWindow && !addressBarWindow.isDestroyed()) {
    addressBarWindow.webContents.send('addressbar-url', url);
  }
}

function restackOverlays() {
  if (addressBarWindow && !addressBarWindow.isDestroyed()) addressBarWindow.moveTop();
  if (carbonWindow     && !carbonWindow.isDestroyed())     carbonWindow.moveTop();
  if (clockWindow      && !clockWindow.isDestroyed())      clockWindow.moveTop();
  if (forkKnifeWindow  && !forkKnifeWindow.isDestroyed())  forkKnifeWindow.moveTop();
}

// Enforce the full stacking order: panels in panelOrder (back to front), then
// overlays.  Uses moveTop() only — never focus() or show() — to avoid
// stealing focus.
function restackAll() {
  for (const key of panelOrder) {
    const win = panelWindows.get(key);
    if (win && !win.isDestroyed()) win.moveTop();
  }
  restackOverlays();
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
    sharedOnScreenUrls.delete(key);
    ps.currentTerm = null;
    const _v = panelViews[key];
    if (_v && !_v.webContents.isDestroyed()) _v.webContents.setAudioMuted(false);
    pushForkKnifeNavState();
    pushCarbonState(key);
    retargetAddressBar(key);
  }

  // Wheel only resets the idle timer; everything else is deliberate use and
  // raises the panel.  A click always re-raises, in case the window manager
  // reshuffled the stack since this panel last came forward.
  if (eventType !== 'wheel') bringPanelToFront(key, eventType === 'mousedown');

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
    clearBusyCursor(key, 'panel went auto');
    ps.manualLayout = false;
    if (Array.from(panelStates.values()).every(s => s.mode === 'auto')) {
      panelOrder = [...DEFAULT_PANEL_ORDER]; // nobody at the kiosk: hub back on top
      setFrontPanel(null);
    } else if (frontKey === key) {
      setFrontPanel(getActiveKey());       // highlight passes to the next-most-recent panel
    } else {
      sendModeToHandle(key, 'auto');
    }
    startBrowsingLoop(key);
    pushForkKnifeNavState();
    // Once every panel is back in auto mode, return the forkknife to its home position.
    if (forkKnifeWindow && !forkKnifeWindow.isDestroyed() && forkKnifeHomePos) {
      const allAuto = Array.from(panelStates.values()).every(s => s.mode === 'auto');
      if (allAuto) forkKnifeWindow.setPosition(forkKnifeHomePos.x, forkKnifeHomePos.y);
    }
    // Same for the clock.
    if (clockWindow && !clockWindow.isDestroyed() && clockHomePos) {
      const allAuto = Array.from(panelStates.values()).every(s => s.mode === 'auto');
      if (allAuto) clockWindow.setPosition(clockHomePos.x, clockHomePos.y);
    }
    // Address bar re-docks to hub when all panels are idle.
    if (addressBarWindow && !addressBarWindow.isDestroyed()) {
      const allAuto = Array.from(panelStates.values()).every(s => s.mode === 'auto');
      if (allAuto) { addressBarDocked = true; repositionAddressBar(); }
    }
    // Carbon re-docks to hub when all panels are idle.
    if (carbonWindow && !carbonWindow.isDestroyed()) {
      const allAuto = Array.from(panelStates.values()).every(s => s.mode === 'auto');
      if (allAuto) { carbonDocked = true; kioskLog('[kiosk-carbon] re-docked all panels idle'); repositionCarbon(); }
    }
    // Push carbon state for whichever panel is now active (or hub if all idle).
    pushCarbonState(getActiveKey());
    retargetAddressBar(getActiveKey());
    restackAll();
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
  if (isDeliberate) retargetAddressBar(key);
}

// ---- Busy-cursor helpers -----------------------------------------------------

// Cancel the onset and cap timers without touching the CSS on the current page.
// Use before replacing a view so we don't try to modify a document being torn down.
function cancelBusyTimers(key) {
  clearTimeout(panelBusyOnsetTimers.get(key));
  panelBusyOnsetTimers.set(key, null);
  clearTimeout(panelBusyCapTimers.get(key));
  panelBusyCapTimers.set(key, null);
}

// Cancel timers, reset the busy flag, and swap the cursor CSS back to normal.
// Called when loading ends, the panel goes auto, or the safety cap fires.
function clearBusyCursor(key, reason) {
  cancelBusyTimers(key);
  if (!panelBusyActive.get(key)) return;
  panelBusyActive.set(key, false);
  kioskLog(`panel ${key} busy cursor off (${reason})`);
  if (!SYSTEM_SPOON_CURSOR) return; // non-Linux: CSS cursor is static; nothing to swap
  const view = panelViews[key];
  if (!view || view.webContents.isDestroyed()) return;
  const oldKey = panelCursorCssKeys.get(key);
  if (oldKey) view.webContents.removeInsertedCSS(oldKey).catch(() => {});
  view.webContents.insertCSS(PANEL_CURSOR_CSS, { cssOrigin: 'user' })
    .then(k => { panelCursorCssKeys.set(key, k); })
    .catch(() => {});
}

// ---- View event handler setup -----------------------------------------------

function setupViewEventHandlers(key, win, view) {
  view.webContents.on('page-title-updated', (_e, title) => {
    if (panelViews[key] !== view) return;
    if (!win.isDestroyed()) win.webContents.send('panel-title', title);
  });

  // Attach CDP so we can tally transferred bytes for the carbon indicator.
  try {
    view.webContents.debugger.attach('1.3');
    // Only byte counts are needed.  Plain Network.enable makes DevTools keep a
    // copy of every response body (up to ~100 MB per panel), which costs CPU
    // and memory on every page load across all five panels — so turn the
    // body buffers off.  Fall back to the plain call if a Chromium build
    // rejects the parameters, so the carbon indicator keeps working.
    const dbg = view.webContents.debugger;
    dbg.sendCommand('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 })
      .catch(() => dbg.sendCommand('Network.enable').catch(() => {}));
    view.webContents.debugger.on('message', (_event, method, params) => {
      if (panelViews[key] !== view) return;
      if (method !== 'Network.loadingFinished') return;
      const ps = panelStates.get(key);
      if (ps) ps.carbonBytes += Math.max(0, params.encodedDataLength || 0);
    });
    view.webContents.debugger.on('detach', (_event, reason) => {
      if (panelViews[key] !== view) return;
      console.log(`[kiosk-carbon] ${key} debugger detached (${reason})`);
    });
  } catch (e) {
    console.error(`[kiosk-carbon] ${key} debugger attach failed:`, e.message);
  }

  // Reset carbon byte counter at the start of each main-frame navigation so the
  // score reflects only the current page's transferred data.
  view.webContents.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
    if (panelViews[key] !== view) return;
    if (!isMainFrame || isInPlace) return;
    if (!url || url.startsWith('data:') || url === 'about:blank' || url.startsWith('file:')) return;
    const ps = panelStates.get(key);
    if (!ps) return;
    ps.carbonBytes   = 0;
    ps.carbonLoading = true;
    pushCarbonState(key);
  });

  view.webContents.on('did-finish-load', () => {
    if (panelViews[key] !== view) return;
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
        } else if (ps.autoPhase === 'parked') {
          // Parked page (DDG pause): scroll like a result page, no SERP logic.
          onParkedPageReady(key);
        } else {
          // 'search' phase: treat the page as a SERP if it's on a DDG URL or if
          // we explicitly loaded a saved SERP file (ps.loadingSerp).  Any other
          // URL here gets parked rather than triggering SERP logic.
          const isDdgUrl   = url.startsWith('https://html.duckduckgo.com/') ||
                             url.startsWith('https://duckduckgo.com/');
          const isSerpFile = !!ps.loadingSerp;
          ps.loadingSerp = false;
          if (isDdgUrl || isSerpFile) {
            ps.retryCount = 0;
            if (isDdgUrl && ps.searchLoadStartedAt) {
              const elapsed = Date.now() - ps.searchLoadStartedAt;
              const status  = ps.lastNavStatus || 200;
              console.log(`[kiosk-timing] ${key} search #${ps.searchCount || 0} took ${elapsed} ms (status ${status})`);
              ps.searchLoadStartedAt = 0;
              ps.lastNavStatus       = 0;
            }
            onSearchPageReady(key);

            // For real DDG pages: persist both the per-panel startup cache and
            // the per-term SERP file used by the cache-hit path.
            // Skip write if there are no result links (bot-check / empty SERP).
            if (isDdgUrl && url.startsWith('https://html.duckduckgo.com/')) {
              const termAtSave = ps.currentTerm;
              view.webContents.executeJavaScript(
                `(function(){
                  if (!document.querySelector('a.result__a')) return null;
                  var c = document.documentElement.cloneNode(true);
                  ['#__kiosk_sb','#__kiosk_hinges'].forEach(function(s){var e=c.querySelector(s);if(e)e.remove();});
                  return '<!DOCTYPE html>\\n' + c.outerHTML;
                })()`
              )
                .then(html => {
                  if (!html) return;
                  const withBase = html.replace('<head>', '<head><base href="https://html.duckduckgo.com/">');
                  kioskLog(`[ddg] ${key} saving cleaned SERP for "${termAtSave || ''}"`);
                  // Per-panel startup placeholder (unchanged).
                  fs.writeFile(path.join(cacheDir, `${key}.html`), withBase, () => {});
                  // Per-term SERP file — lets cache hits show the search step.
                  if (termAtSave) {
                    const filePath = path.join(serpDir, termToSlug(termAtSave) + '.html');
                    fs.writeFile(filePath, withBase, err => {
                      if (err) return;
                      const entry = serpCache.get(termAtSave);
                      if (entry) entry.filePath = filePath;
                    });
                  }
                })
                .catch(() => {});
            }
          } else {
            // Non-DDG, non-SERP-file URL while in search phase — park it.
            kioskLog(`[ddg] ${key} non-DDG URL in search phase (${url}) — parking`);
            ps.autoPhase = 'parked';
            onParkedPageReady(key);
          }
        }
      }
    }

    // Carbon: main-frame load finished — compute grams and push state.
    {
      const ps = panelStates.get(key);
      if (ps) {
        ps.carbonLoading = false;
        if (co2Instance && ps.carbonBytes > 0) {
          ps.carbonGrams = co2Instance.perByte(ps.carbonBytes, false);
        } else {
          ps.carbonGrams = ps.carbonGrams || 0;
        }
        console.log(`[kiosk-carbon] ${key} bytes=${ps.carbonBytes} grams=${(ps.carbonGrams || 0).toFixed(4)}`);
        pushCarbonState(key);
      }
    }
  });

  view.webContents.on('did-fail-load', (_e, errorCode, _desc, failedUrl, isMainFrame) => {
    if (panelViews[key] !== view) return;
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
    clearBusyCursor(key, 'did-fail-load');

    if (ps.mode === 'active') {
      console.log(`[kiosk-active] ${key} load failed (${errorCode}): ${failedUrl}`);
      view.webContents.loadURL(buildErrorPageUrl("This page couldn't be loaded.", failedUrl)).catch(() => {});
      ps.carbonLoading = false;
      pushCarbonState(key);
      return;
    }
    if (ps.mode !== 'auto') return;
    console.log(`[kiosk-auto] ${key} load failed (${errorCode}): ${failedUrl}`);
    ps.carbonLoading = false;
    pushCarbonState(key);
    if (ps.autoPhase === 'result') {
      // Connection errors are not the site's fault; don't mark the domain bad.
      const isConnectionError = errorCode === -106 || errorCode === -21;
      onResultRejected(key, failedUrl, `fail-${errorCode}`, !isConnectionError);
    } else if (ps.autoPhase === 'parked') {
      // Parked start URL failed — try the next one.
      parkNextPage(key);
    } else {
      scheduleRetry(key, `error-${errorCode}`);
    }
  });

  // Update the handle's Back button after each top-level or in-page navigation.
  view.webContents.on('did-navigate', (_e, url, httpResponseCode, _statusText, isMainFrame) => {
    if (panelViews[key] !== view) return;
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
    if (key === addressBarKey) pushAddressBarUrl(url);
  });

  view.webContents.on('did-navigate-in-page', () => {
    if (panelViews[key] !== view) return;
    pushForkKnifeNavState();
    if (key === addressBarKey) pushAddressBarUrl(view.webContents.getURL());
  });

  // Navigation guard -- applies to all page-initiated navigations (meta-refresh,
  // JS redirects, link clicks).  webContents.loadURL() from the main process is
  // exempt: will-navigate does not fire for programmatic loads.
  view.webContents.on('will-navigate', (event, url) => {
    if (panelViews[key] !== view) return; // stale view — allow navigation (view is being destroyed)
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
        const isLocal = LOCAL_TERMS.has(ps.currentTerm);
        const _allowed = (AUTO_LINK_POLICY === 'allowlist') ? isDomainAllowed(url, { local: isLocal }) : isPassesPolicy(url);
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
    if (panelViews[key] !== view) return { action: 'deny' };
    const ps = panelStates.get(key);
    if (ps && ps.mode === 'active' && isPassesPolicy(url)) {
      console.log(`[kiosk-auto] ${key} new-tab link redirected to same panel: ${url}`);
      setImmediate(() => view.webContents.loadURL(url).catch(() => {}));
    } else {
      console.log(`[kiosk-auto] ${key} blocked window.open: ${url}`);
    }
    return { action: 'deny' };
  });

  // Switch to the busy spinner after 1500 ms of continued loading.  Only for
  // active-mode panels; auto-mode panels reload constantly and must never spin.
  view.webContents.on('did-start-loading', () => {
    if (panelViews[key] !== view) return;
    // Clear any pending onset timer so rapid navigations don't stack up.
    clearTimeout(panelBusyOnsetTimers.get(key));
    panelBusyOnsetTimers.set(key, setTimeout(() => {
      panelBusyOnsetTimers.set(key, null);
      if (panelViews[key] !== view) return;
      if (view.webContents.isDestroyed()) return;
      const ps = panelStates.get(key);
      if (!ps || ps.mode !== 'active') return;
      if (!view.webContents.isLoading()) return; // already finished before timer fired
      panelBusyActive.set(key, true);
      kioskLog(`panel ${key} busy cursor on (loading > 1500 ms)`);
      if (SYSTEM_SPOON_CURSOR) {
        const oldKey = panelCursorCssKeys.get(key);
        if (oldKey) view.webContents.removeInsertedCSS(oldKey).catch(() => {});
        view.webContents.insertCSS(PANEL_BUSY_CSS, { cssOrigin: 'user' })
          .then(k => { panelCursorCssKeys.set(key, k); })
          .catch(() => {});
      }
      // Safety cap: revert to the normal spoon after 20 s so it never spins forever.
      clearTimeout(panelBusyCapTimers.get(key));
      panelBusyCapTimers.set(key, setTimeout(() => {
        panelBusyCapTimers.set(key, null);
        clearBusyCursor(key, '20 s safety cap');
      }, 20000));
    }, 1500));
  });

  view.webContents.on('did-stop-loading', () => {
    if (panelViews[key] !== view) return;
    clearBusyCursor(key, 'did-stop-loading');
  });

  // Inject the correct cursor rule into each new document.  dom-ready fires for
  // fresh documents, so the rule matches whatever state the panel is in right now.
  view.webContents.on('dom-ready', () => {
    if (panelViews[key] !== view) return;
    const rule = panelBusyActive.get(key) ? PANEL_BUSY_CSS : PANEL_CURSOR_CSS;
    view.webContents.insertCSS(rule, { cssOrigin: 'user' })
      .then(k => { panelCursorCssKeys.set(key, k); })
      .catch(() => {});
  });

  // Backstop: re-push hinge config on each new document so the overlap layer
  // renders immediately without waiting for the preload's async fetch.
  function sendHinges() {
    if (panelViews[key] !== view) return;
    if (view.webContents.isDestroyed()) return;
    const payload = hingePayload(key);
    if (payload) view.webContents.send('panel-hinges', payload);
  }
  view.webContents.on('did-navigate', (_e, _url, _code, _status, isMainFrame) => {
    if (isMainFrame) sendHinges();
  });
  view.webContents.on('dom-ready', sendHinges);
  view.webContents.on('did-finish-load', sendHinges);

  // Inject cursor CSS into cross-origin subframes (iframes) via executeJavaScript.
  // Author-origin with !important; belt-and-suspenders alongside the preload's
  // user-origin injection that runs when nodeIntegrationInSubFrames is true.
  view.webContents.on('frame-created', (_e, { frame }) => {
    if (panelViews[key] !== view) return;
    if (!frame.parent) return;
    setTimeout(() => {
      // WebFrameMain has no isDestroyed() in Electron 31 (calling it threw on
      // every iframe, so iframes never got the spoon); `detached` is the
      // equivalent, and executeJavaScript can still throw on a disposed frame.
      if (frame.detached) return;
      try {
        frame.executeJavaScript(
          '(function(){try{var s=document.createElement("style");s.textContent=' +
          JSON.stringify(_spoonRule) +
          ';(document.head||document.documentElement).appendChild(s);}catch(_){}})();'
        ).catch(() => {});
      } catch (_) {}
    }, 100);
  });

  view.webContents.on('render-process-gone', (_e, details) => {
    if (panelViews[key] !== view) return;
    const msg = `panel ${key} view render-process-gone reason=${details.reason} exitCode=${details.exitCode}`;
    console.log(`[kiosk] ${msg}`);
    kioskLog(msg);
    setTimeout(() => {
      if (panelViews[key] !== view) return;
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

  view.webContents.on('unresponsive', () => {
    if (panelViews[key] !== view) return;
    kioskLog(`panel ${key} view webContents unresponsive`);
  });
}

// ---- Browsing loop (search → result → search) --------------------------------
//
// Auto mode alternates between DuckDuckGo results pages and individual result
// pages.  The per-panel flow is:
//
//   doSearch → DDG page loads → onSearchPageReady → startScrolling (picks random speed)
//              (or cached file)                   → random search cap (SEARCH_INTERVAL_MIN/MAX_MS)
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
//                                               │  → onResultPageReady → startScrolling (picks random speed)
//                                               │                       → random dwell (RESULT_DWELL_MIN/MAX_MS)
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

function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

function startScrolling(key) {
  const ps = panelStates.get(key);
  if (!ps) return;
  stopScrolling(key);
  ps.scrollPxS = randBetween(SCROLL_SPEED_MIN_PX_S, SCROLL_SPEED_MAX_PX_S);
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
      //
      // The scrolling itself runs in-page on requestAnimationFrame at the
      // same average speed (SCROLL_STEP_PX per SCROLL_STEP_MS) instead of
      // jumping 80 px four times a second, which looked like stutter.  Each
      // tick is a heartbeat: the in-page loop stops on its own if ticks stop
      // arriving, so it can never outlive the auto-mode loop.
      atBottom = await view.webContents.executeJavaScript(`
        (function () {
          var a = window.__kioskAutoScroll;
          if (!a) a = window.__kioskAutoScroll = { until: 0, last: 0, acc: 0, raf: 0 };
          a.until = performance.now() + ${SCROLL_STEP_MS * 3};
          if (!a.raf) {
            a.last = performance.now();
            var frame = function (now) {
              if (now > a.until) { a.raf = 0; a.acc = 0; return; }
              var dt = now - a.last;
              if (dt >= ${AUTO_SCROLL_FRAME_MS}) {
                a.acc += dt * ${ps.scrollPxS / 1000};
                a.last = now;
                var px = Math.floor(a.acc);
                if (px >= 1) { window.scrollBy({ top: px, behavior: 'instant' }); a.acc -= px; }
              }
              a.raf = requestAnimationFrame(frame);
            };
            a.raf = requestAnimationFrame(frame);
          }
          var hasPrev = typeof window.__kioskPrevScrollY === 'number';
          var prevY = hasPrev ? window.__kioskPrevScrollY : window.scrollY;
          var newY = window.scrollY;
          window.__kioskPrevScrollY = newY;
          if (!hasPrev) return false; // first tick: the in-page loop has not moved yet
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
      await view.webContents.executeJavaScript(
        `if (window.__kioskAutoScroll) window.__kioskAutoScroll.until = 0; window.scrollTo(0, 0)`, false);
    } catch {
      return; // page is navigating — skip tick
    }

    // Re-check state after the second await.
    if (ps.mode !== 'auto' || ps.scrollTimer === null) return;

    if (ps.autoPhase === 'result' || ps.autoPhase === 'parked') {
      // Result/parked page bottom: wait the normal hold floor then move to next step.
      const sinceLastSearch = Date.now() - ps.lastSearchTime;
      const holdMs = Math.max(BOTTOM_HOLD_MS, MIN_SEARCH_INTERVAL_MS - sinceLastSearch);
      const phase  = ps.autoPhase;
      stopScrolling(key);
      clearTimeout(ps.resultDwellTimer);
      ps.resultDwellTimer = null;
      console.log(`[kiosk-auto] ${key} ${phase} bottom — next step in ${holdMs} ms`);
      ps.dwellTimer = setTimeout(() => {
        ps.dwellTimer = null;
        if (ps.mode !== 'auto') return;
        if (ps.autoPhase === 'parked') parkNextPage(key);
        else nextAutoStep(key);
      }, holdMs);
    } else {
      // Search phase: don't advance if a DDG load is still in-flight.
      if (ps.loadTimer) return;
      // Don't interrupt a pending next-search gap timer (e.g. the no-result
      // slow-scroll wait set by onSearchBottom).  Let the timer fire doSearch.
      if (ps.dwellTimer) return;

      stopScrolling(key);
      console.log(`[kiosk-auto] ${key} search bottom — picking result`);
      onSearchBottom(key); // async chain; manages its own timers from here
    }
  }, SCROLL_STEP_MS);
}

function stopScrolling(key) {
  const ps = panelStates.get(key);
  if (!ps) return;
  const wasScrolling = ps.scrollTimer !== null;
  clearInterval(ps.scrollTimer);
  ps.scrollTimer = null;
  // Halt the in-page scroll loop now rather than waiting for its heartbeat
  // to lapse, so it never fights a customer who just took over.
  const view = panelViews[key];
  if (wasScrolling && view && !view.webContents.isDestroyed()) {
    view.webContents.executeJavaScript(
      'if (window.__kioskAutoScroll) window.__kioskAutoScroll.until = 0;', false
    ).catch(() => {});
  }
}

// Called after the visible view finishes loading a DuckDuckGo results page.
// Starts the scroll loop and arms a max-dwell safety net in case bottom
// detection never fires (e.g. very long or dynamically loading pages).
function onSearchPageReady(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;

  const url = panelViews[key]?.webContents.getURL() || '';
  console.log(`[kiosk-auto] ${key} search page ready: ${url}`);

  // Track the SERP source so nextAutoStep can return to it between results.
  ps.lastSerpFile = url.startsWith('file://') ? url.slice('file://'.length) : null;
  // Reset the per-SERP-load bottom guard so onSearchBottom runs once per load.
  ps.serpBottomHandled = false;

  startScrolling(key); // sets ps.scrollPxS

  // Return visits (pendingQueuedPick is set) use a shorter cap so the second
  // scroll through the same SERP page is noticeably faster.
  const isReturnVisit = !!ps.pendingQueuedPick;
  const searchCapMs   = isReturnVisit
    ? SERP_RETURN_MAX_MS
    : randBetween(SEARCH_INTERVAL_MIN_MS, SEARCH_INTERVAL_MAX_MS);
  kioskLog(`[kiosk-auto] ${key} speed=${Math.round(ps.scrollPxS)}px/s cap=${Math.round(searchCapMs / 1000)}s${isReturnVisit ? ' (return visit)' : ''}`);

  clearTimeout(ps.dwellTimer);
  ps.dwellTimer = setTimeout(() => {
    ps.dwellTimer = null;
    if (ps.mode !== 'auto') return;
    stopScrolling(key);
    onSearchBottom(key); // respect FOLLOW_RESULT_PROBABILITY even on the dwell cap
  }, searchCapMs);
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
        // Narrow DDG bot-check detection: specific challenge signals only.
        // Excludes 'bot' (matches 'robot','bottom') and generic 'form' (too broad).
        // Caller also verifies the URL is on duckduckgo.com before acting.
        var hasResults = document.querySelectorAll('.result').length > 0;
        var bodyText = document.body ? document.body.innerText.toLowerCase() : '';
        var isBotCheck = !hasResults && (
          !!document.getElementById('challenge-running') ||
          !!document.getElementById('challenge-form') ||
          !!document.querySelector('input[name="vc"]') ||
          bodyText.indexOf('unusual traffic') !== -1 ||
          bodyText.indexOf('are you a robot') !== -1 ||
          bodyText.indexOf('complete the following') !== -1
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
      if (currentUrl.includes('duckduckgo.com')) {
        console.log(`[kiosk-auto] ${key} DDG bot-check page detected`);
        return { botCheck: true };
      }
      kioskLog(`[ddg] bot-check ignored (non-DDG URL: ${currentUrl})`);
    }
    console.log(`[kiosk-auto] ${key} pickRandomResult: 0 result links on page (${currentUrl}, title: ${title})`);
    return null;
  }

  const ps = panelStates.get(key);
  const isLocal    = LOCAL_TERMS.has(ps ? ps.currentTerm : null);
  const recentUrls = ps ? ps.recentResultUrls : [];
  const total = domHrefs.length;
  let afterPolicy   = 0;
  let badDomainSkips = 0;
  let fileSkips      = 0;

  // 'allowlist-preferred': two tiers — prefer ALLOWED_DOMAINS, fall back to isPassesPolicy.
  const allowlistCandidates   = [];
  const fallbackCandidates    = [];
  const panelRecentCandidates = []; // pause-mode Fallback 3: panel-recent URLs still passing policy

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

    // Skip document/binary file links and previously-blocked download URLs.
    if (isNonPageUrl(target) || blockedDownloadUrls.has(target)) { fileSkips += 1; continue; }

    // Skip recently visited pages (collect for pause-mode Fallback 3).
    if (recentUrls.includes(target)) {
      if (!isBadDomain(target)) {
        if (AUTO_LINK_POLICY === 'allowlist' && isDomainAllowed(target, { local: isLocal }))
          panelRecentCandidates.push({ domHref, target, tier: 'allowlist' });
        else if (AUTO_LINK_POLICY === 'browsing' && isPassesPolicy(target))
          panelRecentCandidates.push({ domHref, target, tier: 'browsing' });
        else if (AUTO_LINK_POLICY !== 'allowlist' && AUTO_LINK_POLICY !== 'browsing') {
          if (isDomainAllowed(target, { local: isLocal })) panelRecentCandidates.push({ domHref, target, tier: 'allowlist' });
          else if (isPassesPolicy(target))                 panelRecentCandidates.push({ domHref, target, tier: 'fallback' });
        }
      }
      continue;
    }

    // Skip domains currently in the bad-domain list.
    if (isBadDomain(target)) { badDomainSkips += 1; continue; }

    if (AUTO_LINK_POLICY === 'allowlist') {
      if (!isDomainAllowed(target, { local: isLocal })) continue;
      afterPolicy += 1;
      allowlistCandidates.push({ domHref, target, tier: 'allowlist' });
    } else if (AUTO_LINK_POLICY === 'browsing') {
      if (!isPassesPolicy(target)) continue;
      afterPolicy += 1;
      allowlistCandidates.push({ domHref, target, tier: 'browsing' });
    } else {
      // 'allowlist-preferred': allowlist wins; any policy-passing URL is fallback.
      if (isDomainAllowed(target, { local: isLocal })) {
        afterPolicy += 1;
        allowlistCandidates.push({ domHref, target, tier: 'allowlist' });
      } else if (isPassesPolicy(target)) {
        afterPolicy += 1;
        fallbackCandidates.push({ domHref, target, tier: 'fallback' });
      }
    }
  }

  const pool = allowlistCandidates.length > 0 ? allowlistCandidates : fallbackCandidates;
  if (badDomainSkips > 0) {
    console.log(`[kiosk-auto] ${key} skipped ${badDomainSkips} result(s) for bad domain(s)`);
  }
  if (pool.length === 0) {
    console.log(`[kiosk-auto] ${key} no eligible results (${total} found, ${afterPolicy} after policy)`);
    return null;
  }

  // ---- Shared cross-panel filtering with progressive fallback -----------------
  // Collect what other panels are showing right now and their base domains.
  const otherOnScreenUrls    = new Set();
  const otherOnScreenDomains = new Set();
  for (const [k, url] of sharedOnScreenUrls) {
    if (k !== key && url) {
      otherOnScreenUrls.add(url);
      const bd = baseDomain(hostnameOf(url));
      if (bd) otherOnScreenDomains.add(bd);
    }
  }
  const sharedRecentSet = new Set(sharedRecentUrls);

  // Count items blocked by each rule (for the log) using the strictest applicable rule.
  let sameUrlCount = 0, sameSiteCount = 0, sharedRecentCount = 0;
  for (const c of pool) {
    const url = c.target;
    if (otherOnScreenUrls.has(url))                              sameUrlCount++;
    else if (otherOnScreenDomains.has(baseDomain(hostnameOf(url)))) sameSiteCount++;
    else if (sharedRecentSet.has(url))                           sharedRecentCount++;
  }

  // Level 0 (strict): exclude same-URL, same-site, and shared-recent.
  let candidates = pool.filter(c => {
    const url = c.target;
    if (otherOnScreenUrls.has(url))                              return false;
    if (otherOnScreenDomains.has(baseDomain(hostnameOf(url))))   return false;
    if (sharedRecentSet.has(url))                                return false;
    return true;
  });
  let fallbackUsed = 'none';

  if (candidates.length === 0) {
    // Fallback 1: allow same site, still exclude same-URL and shared-recent.
    candidates = pool.filter(c => {
      if (otherOnScreenUrls.has(c.target)) return false;
      if (sharedRecentSet.has(c.target))   return false;
      return true;
    });
    if (candidates.length > 0) {
      fallbackUsed = 'same-site-ok';
      kioskLog(`[kiosk-auto] ${key} fallback relaxed: allowing same site as another panel`);
    }
  }

  if (candidates.length === 0) {
    // Fallback 2: allow shared-recent, still never on-screen in another panel right now.
    candidates = pool.filter(c => !otherOnScreenUrls.has(c.target));
    if (candidates.length > 0) {
      fallbackUsed = 'shared-recent-ok';
      kioskLog(`[kiosk-auto] ${key} fallback relaxed: allowing shared-recent URLs`);
    }
  }

  if (candidates.length === 0 && ddgPausedUntil > Date.now()) {
    // Fallback 3 (pause only): allow this panel's own recently-visited URLs,
    // still never the same URL as another panel right now.
    candidates = panelRecentCandidates.filter(c => !otherOnScreenUrls.has(c.target));
    if (candidates.length > 0) {
      fallbackUsed = 'panel-recent-ok';
      kioskLog(`[kiosk-auto] ${key} fallback relaxed: allowing panel-recent URLs (pause mode)`);
    }
  }

  if (candidates.length === 0) {
    // No candidates at all after all fallbacks — keep existing "next search" behavior.
    console.log(`[kiosk-auto] ${key} no eligible results after all shared filters (pool=${pool.length})`);
    return null;
  }

  // Cache the full policy-approved pool for this term before shared filtering
  // so future draws can skip the DDG page; filterCachedUrls() re-applies
  // cross-panel rules at use time.
  if (ps && ps.currentTerm) {
    const cachedUrls  = pool.map(c => c.target);
    const prevEntry   = serpCache.get(ps.currentTerm);
    const isRealDdg   = currentUrl.startsWith('https://html.duckduckgo.com/') ||
                        currentUrl.startsWith('https://duckduckgo.com/');
    // Resolve filePath: keep the previous one; if none, check the deterministic path.
    let filePath = prevEntry ? prevEntry.filePath : undefined;
    if (!filePath) {
      const computedPath = path.join(serpDir, termToSlug(ps.currentTerm) + '.html');
      try { fs.accessSync(computedPath); filePath = computedPath; } catch {}
    }
    serpCache.set(ps.currentTerm, {
      urls:      cachedUrls,
      // For saved-file pages, don't reset fetchedAt so the TTL isn't extended
      // on every return visit and the "real refresh every SHOW_SERP_EVERY_N uses"
      // counter stays meaningful.
      fetchedAt: isRealDdg ? Date.now() : (prevEntry ? prevEntry.fetchedAt : Date.now()),
      filePath,
    });
    if (isRealDdg) {
      serpCacheUseCount.set(ps.currentTerm, 0);
      kioskLog(`[ddg] cache: stored "${ps.currentTerm}" ${cachedUrls.length} URLs`);
    }
  }

  // Shuffle candidates, then sort so different-hostname entries come first
  // (a single broken site can't occupy all queue slots).
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const pick     = candidates[0];
  const pickHost = hostnameOf(pick.target);
  const others   = candidates.slice(1);
  others.sort((a, b) => {
    const aMatch = hostnameOf(a.target) === pickHost ? 1 : 0;
    const bMatch = hostnameOf(b.target) === pickHost ? 1 : 0;
    return aMatch - bMatch; // different-hostname backups come first
  });
  if (ps) {
    ps.queuedResults  = others; // all remaining candidates (visit RESULTS_PER_SEARCH_MIN–MAX per SERP)
    ps.resultsGoal    = Math.floor(randBetween(RESULTS_PER_SEARCH_MIN, RESULTS_PER_SEARCH_MAX + 1));
    ps.resultsVisited = 0;
  }

  kioskLog(`[kiosk-auto] ${key} result host=${hostnameOf(pick.target)} (filtered: ${sameUrlCount} same-url, ${sameSiteCount} same-site, ${sharedRecentCount} shared-recent, ${fileSkips} file-links, fallback=${fallbackUsed})`);

  return pick;
}

// Arms the result load watchdog and calls loadURL.  Extracted from the
// highlightTimer callback in onSearchBottom so the same path is reused when
// trying queued results from ps.queuedResults.
function loadResult(key, result) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;
  const v = panelViews[key];
  if (!v || v.webContents.isDestroyed()) { doSearch(key); return; }

  ps.autoPhase = 'result';
  ps.recentResultUrls.push(result.target);
  if (ps.recentResultUrls.length > 20) ps.recentResultUrls.shift();
  sharedOnScreenUrls.set(key, result.target);
  sharedRecentUrls.push(result.target);
  if (sharedRecentUrls.length > SHARED_RECENT_URLS_MAX) sharedRecentUrls.shift();

  // Increment attempt token before arming the watchdog; onResultRejected also
  // increments it so stale callbacks can detect they are superseded.
  ps.resultAttempt = (ps.resultAttempt || 0) + 1;
  const attempt = ps.resultAttempt;

  clearTimeout(ps.loadTimer);
  ps.loadTimer = setTimeout(() => {
    ps.loadTimer = null;
    if (ps.mode !== 'auto' || ps.resultAttempt !== attempt) return;
    console.log(`[kiosk-auto] ${key} result load timed out: ${result.target}`);
    v.webContents.stop();
    onResultRejected(key, result.target, 'timeout', true);
  }, RESULT_LOAD_TIMEOUT_MS);

  v.webContents.loadURL(result.target).catch(err => {
    // ERR_ABORTED: cancelled by our own stop() call or by onHeadersReceived.
    if (err.message === 'ERR_ABORTED') return;
    // Superseded: another loadResult call has already taken over.
    if (ps.resultAttempt !== attempt) return;
    clearTimeout(ps.loadTimer);
    ps.loadTimer = null;
    if (ps.mode !== 'auto') return;
    console.log(`[kiosk-auto] ${key} result load rejected: ${err.message}`);
    onResultRejected(key, result.target, 'load-rejected', false);
  });
}

// Called when a result-page load fails or is blocked.  Tries the next entry
// from ps.queuedResults (same SERP) before triggering a new search.
function onResultRejected(key, url, reason, markBad) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto' || ps.autoPhase !== 'result') return;

  // Increment token so any pending callbacks from the previous load bail out.
  ps.resultAttempt = (ps.resultAttempt || 0) + 1;

  clearTimeout(ps.loadTimer);
  ps.loadTimer = null;
  clearTimeout(ps.resultDwellTimer);
  ps.resultDwellTimer = null;
  stopScrolling(key);

  if (markBad) markBadDomain(url, reason);

  // Try the next queued result before giving up and searching again.
  const queue = ps.queuedResults || [];
  while (queue.length > 0) {
    const next = queue.shift();
    if (isBadDomain(next.target)) {
      console.log(`[kiosk-auto] ${key} queued result skipped (bad domain): ${hostnameOf(next.target)}`);
      continue;
    }
    console.log(`[kiosk-auto] ${key} trying queued result (${reason}): ${next.target}`);
    loadResult(key, next);
    return;
  }

  console.log(`[kiosk-auto] ${key} result rejected (${reason}), queue empty — next auto step`);
  nextAutoStep(key);
}

// Called when a search page hits the bottom (or the random search-cap timer fires).  Respects FOLLOW_RESULT_PROBABILITY; when following, picks a
// random eligible result, highlights it briefly, then loads it in the panel.
async function onSearchBottom(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;

  // Guard: run at most once per SERP page load.  The slow re-scroll in the
  // no-eligible path must not re-trigger this handler.
  if (ps.serpBottomHandled) return;
  ps.serpBottomHandled = true;

  // Occasionally skip result-following to mix in pure search-only cycles
  // (but always honour a pending queued pick from nextAutoStep).
  if (!ps.pendingQueuedPick && Math.random() > FOLLOW_RESULT_PROBABILITY) {
    const sinceLastSearch = Date.now() - ps.lastSearchTime;
    const holdMs = Math.max(BOTTOM_HOLD_MS, MIN_SEARCH_INTERVAL_MS - sinceLastSearch);
    console.log(`[kiosk-auto] ${key} skipping result (probability), next search in ${holdMs} ms`);
    clearTimeout(ps.dwellTimer);
    ps.dwellTimer = setTimeout(() => {
      ps.dwellTimer = null;
      if (ps.mode === 'auto') doSearch(key);
    }, holdMs);
    return;
  }

  // If nextAutoStep sent us back to the SERP with a pre-picked result, use it;
  // otherwise fall through to pickRandomResult.
  let result;
  const isReturnVisit = !!ps.pendingQueuedPick;
  if (ps.pendingQueuedPick) {
    const pre = ps.pendingQueuedPick;
    ps.pendingQueuedPick = null;
    // Re-validate the pre-pick before using it.
    if (!isDomainAllowed(pre.target) || isBadDomain(pre.target)) {
      kioskLog(`[kiosk-auto] ${key} pendingQueuedPick failed policy re-check — fresh pick`);
      result = await pickRandomResult(key);
    } else {
      const otherUrls = new Set([...sharedOnScreenUrls.values()].filter(Boolean));
      if (otherUrls.has(pre.target)) {
        kioskLog(`[kiosk-auto] ${key} pendingQueuedPick now on another panel — fresh pick`);
        result = await pickRandomResult(key);
      } else {
        result = pre;
      }
    }
  } else {
    result = await pickRandomResult(key);
  }

  // Re-check mode after async operation.
  if (ps.mode !== 'auto') {
    console.log(`[kiosk-auto] ${key} onSearchBottom: mode changed to ${ps.mode}, aborting`);
    return;
  }

  if (result && result.botCheck) {
    console.log(`[kiosk-auto] ${key} onSearchBottom: DDG bot-check detected`);
    noteDdgBotCheck(key);
    return;
  }

  if (!result) {
    // Track consecutive misses for this term and auto-skip if the limit is hit.
    // serpBottomHandled guarantees we only count once per SERP load.
    const term = ps.currentTerm;
    if (term) {
      const count = (termMissCounts.get(term) || 0) + 1;
      termMissCounts.set(term, count);
      kioskLog(`[kiosk-auto] ${key} no eligible results for "${term}" (miss ${count}/${TERM_MISS_LIMIT})`);
      if (count >= TERM_MISS_LIMIT && !skippedTerms.has(term)) {
        const eligibleCount = SEARCH_TERMS.filter(t => !skippedTerms.has(t)).length;
        if (eligibleCount - 1 >= 20) {
          skippedTerms.add(term);
          const idx = searchDeck.indexOf(term);
          if (idx !== -1) searchDeck.splice(idx, 1);
          kioskLog(`[kiosk-deck] auto-skipped term "${term}" (${count} consecutive misses). Skipped: ${[...skippedTerms].join(', ')}`);
        } else {
          kioskLog(`[kiosk-deck] term "${term}" hit miss limit but skipping would drop deck below 20 (${eligibleCount} eligible)`);
        }
      }
    } else {
      kioskLog(`[kiosk-auto] ${key} no eligible results (no current term)`);
    }
    ddgStats.noEligibleMisses++;

    // Try to show a cached SERP so the panel doesn't sit on a dead-looking page.
    for (const [cachedTerm, cEntry] of serpCache) {
      if (Date.now() - cEntry.fetchedAt >= SERP_CACHE_TTL_MS) continue;
      if (!cEntry.filePath) continue;
      if (!serpFileValid(cEntry.filePath)) continue;
      const cEligible = filterCachedUrls(key, cEntry.urls);
      if (cEligible.length === 0) continue;
      kioskLog(`[ddg] ${key} no eligible results — loading cached SERP for "${cachedTerm}"`);
      ddgStats.savedSerpShows++;
      ps.currentTerm = cachedTerm;
      ps.autoPhase   = 'search';
      ps.loadingSerp = true;
      const v2 = panelViews[key];
      if (!v2 || v2.webContents.isDestroyed()) break;
      v2.webContents.loadURL('file://' + cEntry.filePath).catch(() => {
        ps.loadingSerp = false;
        if (ps.mode === 'auto') doSearch(key);
      });
      return;
    }

    // No suitable cached SERP: schedule next search and restart slow scroll so
    // the panel looks active while waiting.
    const sinceLastSearch = Date.now() - ps.lastSearchTime;
    const holdMs = Math.max(BOTTOM_HOLD_MS, MIN_SEARCH_INTERVAL_MS - sinceLastSearch);
    clearTimeout(ps.dwellTimer);
    ps.dwellTimer = setTimeout(() => {
      ps.dwellTimer = null;
      if (ps.mode === 'auto') doSearch(key);
    }, holdMs);
    startScrolling(key);
    ps.scrollPxS = SCROLL_SPEED_MIN_PX_S; // slow scroll during the gap
    return;
  }

  // Successful result pick — reset the miss counter for this term.
  if (ps.currentTerm) termMissCounts.set(ps.currentTerm, 0);

  const pickN = (ps.resultsVisited || 0) + 1;
  const pickM = ps.resultsGoal || 1;
  kioskLog(`[kiosk-auto] ${key} following result (${result.tier}, pick ${pickN}/${pickM}, ${isReturnVisit ? 'return' : 'fresh'}): ${result.target}`);

  // Highlight the chosen anchor in-page before navigating.
  // Match by domHref (the page's a.href) OR by unwrapping the uddg= target from
  // the redirect href, so cached/queued picks with direct URLs still highlight.
  const view = panelViews[key];
  if (!view || view.webContents.isDestroyed()) { doSearch(key); return; }
  try {
    await view.webContents.executeJavaScript(`
      (function (domHref, target) {
        function getUddg(href) {
          try {
            var u = new URL(href);
            if ((u.hostname === 'duckduckgo.com' || u.hostname.endsWith('.duckduckgo.com')) && u.pathname === '/l/') {
              return decodeURIComponent(u.searchParams.get('uddg') || '');
            }
          } catch {}
          return null;
        }
        var el = Array.from(document.querySelectorAll('a.result__a'))
          .find(function (a) {
            if (a.href === domHref) return true;
            var uddg = getUddg(a.href);
            return uddg && uddg === target;
          });
        if (el) {
          el.style.outline = '3px solid #ea4b00';
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      })(${JSON.stringify(result.domHref)}, ${JSON.stringify(result.target)})
    `, false);
  } catch {}

  // Re-check mode after the highlight executeJavaScript.
  if (ps.mode !== 'auto') return;

  clearTimeout(ps.highlightTimer);
  ps.highlightTimer = setTimeout(() => {
    ps.highlightTimer = null;
    if (ps.mode !== 'auto') return;
    loadResult(key, result);
  }, RESULT_HIGHLIGHT_MS);
}

// Starts scrolling a result page and arms a random dwell cap as a safety net in
// case bottom detection never fires.  Called by onResultPageReady after the
// soft-error check passes.
function beginResultDwell(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto' || ps.autoPhase !== 'result') return;
  ps.resultsVisited = (ps.resultsVisited || 0) + 1;
  ddgStats.resultsVisited++;
  startScrolling(key); // sets ps.scrollPxS
  const resultDwellMs = randBetween(RESULT_DWELL_MIN_MS, RESULT_DWELL_MAX_MS);
  kioskLog(`[kiosk-auto] ${key} speed=${Math.round(ps.scrollPxS)}px/s dwell=${Math.round(resultDwellMs / 1000)}s`);
  clearTimeout(ps.resultDwellTimer);
  ps.resultDwellTimer = setTimeout(() => {
    ps.resultDwellTimer = null;
    if (ps.mode !== 'auto' || ps.autoPhase !== 'result') return;
    stopScrolling(key);
    nextAutoStep(key);
  }, resultDwellMs);
}

// Checks the loaded result page for Cloudflare challenges, bare status codes
// in the title, known error/gate title phrases, and (on short pages only)
// known error phrases in the body text.  Returns a reason string when a soft
// error is detected, null for normal pages.
async function detectSoftErrorPage(view) {
  try {
    const info = await view.webContents.executeJavaScript(`
      (function () {
        var title = (document.title || '').trim().toLowerCase()
          .replace(/[\\u2018\\u2019]/g, "'").replace(/[\\u201c\\u201d]/g, '"');
        var body = '';
        var fullLen = 0;
        try {
          var raw = document.body ? (document.body.innerText || '') : '';
          fullLen = raw.length;
          body = raw.split(/\\s+/).join(' ').slice(0, 4000).toLowerCase()
            .replace(/[\\u2018\\u2019]/g, "'").replace(/[\\u201c\\u201d]/g, '"');
        } catch (_) {}
        var cfMarker = !!(
          document.getElementById('challenge-form') ||
          document.getElementById('challenge-running') ||
          document.getElementById('cf-challenge-running') ||
          document.querySelector('.cf-browser-verification') ||
          document.querySelector('[id^="cf-chl"]') ||
          document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]')
        );
        return { title: title, body: body, fullLen: fullLen, cfMarker: cfMarker };
      })()
    `, false);
    if (!info) return null;
    if (info.cfMarker) return 'cloudflare-challenge';
    if (SOFT_ERROR_TITLE_STATUS_RE.test(info.title)) return 'title-status-code';
    for (const phrase of SOFT_ERROR_TITLE_PHRASES) {
      if (info.title.includes(phrase)) return 'title:' + phrase;
    }
    // Body check only on short pages — real articles can mention error terms in passing.
    if (info.fullLen < SOFT_ERROR_MAX_TEXT) {
      for (const phrase of SOFT_ERROR_BODY_PHRASES) {
        if (info.body.includes(phrase)) return 'body:' + phrase;
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Called after a result page finishes loading.  Runs a soft-error check
// (Cloudflare challenges, bare status-code titles, error phrases) before
// starting the scroll/dwell loop.  Skips the check when AUTO_ERROR_BLOCK_ENABLED
// is false to fully restore the old behaviour.
async function onResultPageReady(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto' || ps.autoPhase !== 'result') return;

  const view = panelViews[key];
  const url  = view ? view.webContents.getURL() : '';
  console.log(`[kiosk-auto] ${key} result page ready: ${url}`);

  if (!AUTO_ERROR_BLOCK_ENABLED) {
    beginResultDwell(key);
    return;
  }

  if (!view || view.webContents.isDestroyed()) { doSearch(key); return; }

  const reason = await detectSoftErrorPage(view);

  // Re-check state after the async detectSoftErrorPage call.
  const ps2 = panelStates.get(key);
  if (!ps2 || ps2.mode !== 'auto' || ps2.autoPhase !== 'result') return;
  const viewNow = panelViews[key];
  if (!viewNow || viewNow.webContents.isDestroyed()) { doSearch(key); return; }
  if (viewNow.webContents.getURL() !== url) return; // navigated away during the check

  if (reason) {
    console.log(`[kiosk-auto] ${key} soft error detected (${reason}): ${url}`);
    onResultRejected(key, url, 'soft-error:' + reason, true);
    return;
  }

  beginResultDwell(key);
}

// ---- Search deck (shuffle-bag) -----------------------------------------------

// Rebuilds SEARCH_TERMS, TERM_GROUP_DOMAINS, and LOCAL_TERMS from the static
// SEARCH_TERM_GROUPS plus, if a location is provided, the filled-in local
// templates.  Clears both shuffle bags so the next drawNextTerm reshuffles
// with the updated term set.
function rebuildTopics(location) {
  const prevHadLocal = LOCAL_TERMS.size > 0;
  SEARCH_TERMS       = SEARCH_TERM_GROUPS.flatMap(g => g.terms);
  TERM_GROUP_DOMAINS = new Map(SEARCH_TERM_GROUPS.flatMap(g => g.terms.map(t => [t, g.domains])));
  LOCAL_TERMS        = new Set();
  localWeatherTerm   = null;

  if (!location || !location.city) {
    kioskLog('[kiosk-local] skipped: no location');
    searchDeck      = [];
    localSearchDeck = [];
    return;
  }

  const city   = location.city;
  const region = location.regionName || city;

  for (const tmpl of LOCAL_TERM_TEMPLATES) {
    const term = tmpl.replace(/{city}/g, city).replace(/{region}/g, region);
    SEARCH_TERMS.push(term);
    TERM_GROUP_DOMAINS.set(term, LOCAL_GROUP_DOMAINS);
    LOCAL_TERMS.add(term);
  }
  localWeatherTerm = `${city} weather`;

  searchDeck      = [];
  localSearchDeck = [];

  if (prevHadLocal) {
    kioskLog(`[kiosk-local] rebuilt for ${city}`);
  } else {
    kioskLog(`[kiosk-local] added ${LOCAL_TERMS.size} local terms`);
  }
}

// Fisher-Yates shuffle of all non-skipped terms, with currently-active terms
// pushed to the end so a reshuffle doesn't immediately repeat on-screen topics.
function reshuffleDeck(activeTerms) {
  const eligible = SEARCH_TERMS.filter(t => !skippedTerms.has(t));
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }
  const front = eligible.filter(t => !activeTerms.has(t));
  const back  = eligible.filter(t =>  activeTerms.has(t));
  searchDeck  = [...front, ...back];
  kioskLog(`[kiosk-deck] reshuffled: ${searchDeck.length} terms (${skippedTerms.size} skipped${skippedTerms.size ? ': ' + [...skippedTerms].join(', ') : ''})`);
}

// Shuffle of LOCAL_TERMS not in skippedTerms, active terms at the end.
function reshuffleLocalDeck(activeTerms) {
  const eligible = [...LOCAL_TERMS].filter(t => !skippedTerms.has(t));
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }
  const front = eligible.filter(t => !activeTerms.has(t));
  const back  = eligible.filter(t =>  activeTerms.has(t));
  localSearchDeck = [...front, ...back];
}

// Draws the next term from the deck for panel `key`, skipping terms that other
// panels are currently searching or browsing.  Reshuffles automatically when
// the deck runs dry.  With probability LOCAL_TERM_RATIO, tries the local deck
// first (separate bag so local terms don't repeat back-to-back; only one panel
// shows a local term at a time — enforced by the otherTerms skip).
function drawNextTerm(key) {
  const otherTerms = new Set();
  for (const [k, ops] of panelStates) {
    if (k !== key && ops.currentTerm) otherTerms.add(ops.currentTerm);
  }

  // Try a local term with probability LOCAL_TERM_RATIO.
  if (LOCAL_TERMS.size > 0 && Math.random() < LOCAL_TERM_RATIO) {
    if (localSearchDeck.length === 0) reshuffleLocalDeck(otherTerms);
    for (let i = 0; i < localSearchDeck.length; i++) {
      if (!otherTerms.has(localSearchDeck[i])) {
        const [term] = localSearchDeck.splice(i, 1);
        ddgStats.local++;
        return term;
      }
    }
    // All local terms currently on another panel — fall through to main deck.
  }

  // Scan the deck for the first term that isn't currently active on another panel.
  for (let i = 0; i < searchDeck.length; i++) {
    if (!otherTerms.has(searchDeck[i])) {
      const [term] = searchDeck.splice(i, 1);
      return term;
    }
  }

  // Deck empty or all remaining terms are in use — reshuffle and try again.
  reshuffleDeck(otherTerms);
  for (let i = 0; i < searchDeck.length; i++) {
    if (!otherTerms.has(searchDeck[i])) {
      const [term] = searchDeck.splice(i, 1);
      return term;
    }
  }

  // Edge case: more panels searching than terms (shouldn't happen with 150+ terms).
  return searchDeck.length > 0 ? searchDeck.shift() : SEARCH_TERMS[0];
}

// Returns cached URLs for `term` that still pass current shared-state filters.
function filterCachedUrls(key, urls, opts = {}) {
  const ps = panelStates.get(key);
  const isLocal = LOCAL_TERMS.has(ps ? ps.currentTerm : null);
  const otherOnScreen    = new Set();
  const otherOnScreenBDs = new Set();
  for (const [k, url] of sharedOnScreenUrls) {
    if (k !== key && url) {
      otherOnScreen.add(url);
      const bd = baseDomain(hostnameOf(url));
      if (bd) otherOnScreenBDs.add(bd);
    }
  }
  const sharedRecentSet = new Set(sharedRecentUrls);
  const panelRecentSet  = new Set(ps ? ps.recentResultUrls : []);
  return urls.filter(url => {
    if (isBadDomain(url))                                                              return false;
    if (!isDomainAllowed(url, { local: isLocal }))                                     return false;
    if (isNonPageUrl(url))                                                             return false;
    if (blockedDownloadUrls.has(url))                                                  return false;
    if (otherOnScreen.has(url))                                                        return false;
    if (!opts.duringPause && otherOnScreenBDs.has(baseDomain(hostnameOf(url))))        return false;
    if (!opts.duringPause && sharedRecentSet.has(url))                                 return false;
    if (panelRecentSet.has(url))                                                       return false;
    return true;
  });
}

// If the panel has more results to visit from the current SERP, load the next
// one; otherwise start a fresh search cycle.
function nextAutoStep(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;
  if (ps.resultsVisited < ps.resultsGoal && ps.queuedResults && ps.queuedResults.length > 0) {
    while (ps.queuedResults.length > 0) {
      const next = ps.queuedResults.shift();
      if (isBadDomain(next.target)) {
        console.log(`[kiosk-auto] ${key} queued result skipped (bad domain): ${hostnameOf(next.target)}`);
        continue;
      }
      // Re-check whether another panel has taken this URL since we queued it.
      const otherUrls = new Set([...sharedOnScreenUrls.values()].filter(Boolean));
      if (otherUrls.has(next.target)) {
        console.log(`[kiosk-auto] ${key} queued result skipped (on another panel): ${next.target}`);
        continue;
      }
      // Go back to the results page before loading the next result, so the
      // viewer sees the search step between every two result pages.
      ps.pendingQueuedPick = next;
      const v = panelViews[key];
      if (!v || v.webContents.isDestroyed()) { ps.pendingQueuedPick = null; doSearch(key); return; }
      const pickN = (ps.resultsVisited || 0) + 1;
      const pickM = ps.resultsGoal || 1;
      if (ps.lastSerpFile) {
        const fileOk = serpFileValid(ps.lastSerpFile);
        if (!fileOk) ps.lastSerpFile = null;
        if (fileOk) {
          kioskLog(`[kiosk-auto] ${key} back to results page (saved-file) for pick ${pickN}/${pickM}`);
          ps.autoPhase   = 'search';
          ps.loadingSerp = true;
          v.webContents.loadURL('file://' + ps.lastSerpFile).catch(() => {
            ps.loadingSerp = false;
            ps.pendingQueuedPick = null;
            kioskLog(`[kiosk-auto] ${key} direct result load (no way back to results page): ${next.target}`);
            loadResult(key, next);
          });
          return;
        }
      }
      if (v.webContents.canGoBack()) {
        kioskLog(`[kiosk-auto] ${key} back to results page (history) for pick ${pickN}/${pickM}`);
        ps.autoPhase = 'search';
        v.webContents.goBack();
        return;
      }
      kioskLog(`[kiosk-auto] ${key} direct result load (no way back to results page): ${next.target}`);
      ps.pendingQueuedPick = null;
      loadResult(key, next);
      return;
    }
  }
  doSearch(key);
}

// Round-robins through PAUSE_START_URLS, skipping sites another panel shows.
function pickParkUrl(key) {
  const otherBDs = new Set();
  const otherUrls = new Set();
  for (const [k, url] of sharedOnScreenUrls) {
    if (k !== key && url) {
      otherUrls.add(url);
      otherBDs.add(baseDomain(hostnameOf(url)));
    }
  }
  for (let i = 0; i < PAUSE_START_URLS.length; i++) {
    const url = PAUSE_START_URLS[(parkUrlIndex + i) % PAUSE_START_URLS.length];
    if (!otherUrls.has(url) && !otherBDs.has(baseDomain(hostnameOf(url)))) {
      parkUrlIndex = (parkUrlIndex + i + 1) % PAUSE_START_URLS.length;
      return url;
    }
  }
  parkUrlIndex = (parkUrlIndex + 1) % PAUSE_START_URLS.length;
  return PAUSE_START_URLS[parkUrlIndex] || null;
}

// Loads a PAUSE_START_URL on this panel.  Called when no saved SERP is available.
function showParkUrl(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;
  const remaining = Math.max(ddgPausedUntil - Date.now(), 0);
  const parkUrl   = pickParkUrl(key);
  const v         = panelViews[key];
  if (!parkUrl || !v || v.webContents.isDestroyed()) {
    clearTimeout(ps.pauseResumeTimer);
    ps.pauseResumeTimer = setTimeout(() => {
      ps.pauseResumeTimer = null;
      if (ps.mode === 'auto') doSearch(key);
    }, remaining + 1000);
    return;
  }
  kioskLog(`[ddg] ${key} parked: ${parkUrl} (pause ${Math.round(remaining / 1000)}s left)`);
  ps.autoPhase = 'parked';
  sharedOnScreenUrls.set(key, parkUrl);
  clearTimeout(ps.pauseResumeTimer);
  ps.pauseResumeTimer = setTimeout(() => {
    ps.pauseResumeTimer = null;
    // Only yank truly idle 'parked' panels; 'result'/'search' panels finish
    // their current step and naturally reach doSearch on their own.
    if (ps.mode === 'auto' && ps.autoPhase === 'parked') doSearch(key);
  }, remaining + 1000);
  v.webContents.loadURL(parkUrl).catch(() => {});
}

// During a DDG pause, finds the best saved SERP file to show on a panel.
// Three-pass rotation: 1) unique to this panel (not current term, not other panels),
// 2) not on other panels (allow this panel's current term),
// 3) allow any term. Uses relaxed URL filtering (duringPause).
// Parks on PAUSE_START_URLS only when no SERP files exist at all.
function showSavedSerpDuringPause(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;
  const v = panelViews[key];
  if (!v || v.webContents.isDestroyed()) { showParkUrl(key); return; }

  const otherTerms = new Set();
  for (const [k, ops] of panelStates) {
    if (k !== key && ops.currentTerm) otherTerms.add(ops.currentTerm);
  }

  const passFilters = [
    (term) => term !== ps.currentTerm && !otherTerms.has(term),
    (term) => !otherTerms.has(term),
    (term) => true,
  ];
  for (const passFilter of passFilters) {
    for (const [cachedTerm, entry] of serpCache) {
      if (Date.now() - entry.fetchedAt >= SERP_CACHE_TTL_MS) continue;
      if (!entry.filePath) continue;
      if (!serpFileValid(entry.filePath)) continue;
      if (!passFilter(cachedTerm)) continue;
      const eligible = filterCachedUrls(key, entry.urls, { duringPause: true });
      if (eligible.length === 0) continue;
      kioskLog(`[ddg] ${key} pause: showing saved SERP "${cachedTerm}" (relaxed, ${eligible.length} eligible)`);
      ddgStats.cacheHits++;
      ddgStats.savedSerpShows++;
      ps.currentTerm     = cachedTerm;
      ps.firstSearchDone = true;
      ps.autoPhase       = 'search';
      ps.loadingSerp     = true;
      v.webContents.loadURL('file://' + entry.filePath).catch(() => {
        ps.loadingSerp = false;
        showParkUrl(key);
      });
      return;
    }
  }

  // Files exist but all have 0 eligible URLs with relaxed rules — show any file
  // rather than parking; park only when no SERP files exist at all.
  for (const [anyTerm, entry] of serpCache) {
    if (!entry.filePath) continue;
    if (!serpFileValid(entry.filePath)) continue;
    kioskLog(`[ddg] ${key} pause: showing saved SERP "${anyTerm}" (relaxed, 0 eligible)`);
    ddgStats.savedSerpShows++;
    ps.currentTerm     = anyTerm;
    ps.firstSearchDone = true;
    ps.autoPhase       = 'search';
    ps.loadingSerp     = true;
    v.webContents.loadURL('file://' + entry.filePath).catch(() => {
      ps.loadingSerp = false;
      showParkUrl(key);
    });
    return;
  }

  showParkUrl(key);
}

// Called at the end of a parked-page dwell, on scroll-bottom for 'parked' phase,
// or when a parked load fails.  Decides what the panel shows next during the pause.
function parkNextPage(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;

  // Pause has ended — resume normal browsing.
  if (ddgPausedUntil <= Date.now()) {
    clearTimeout(ps.pauseResumeTimer);
    ps.pauseResumeTimer = null;
    doSearch(key);
    return;
  }

  showSavedSerpDuringPause(key);
}

// Navigates a panel off a bot-check (or any unwanted) page during a DDG pause.
// Shows a saved SERP file; falls back to a PAUSE_START_URL parked page.
function navigateToParkedPage(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;
  stopBrowsingLoop(key);
  ps.mode          = 'auto';
  ps.queuedResults = [];
  ps.resultsGoal   = 0;
  ps.resultsVisited = 0;
  showSavedSerpDuringPause(key);
}

// Scrolls a parked page and arms a random dwell before calling parkNextPage.
function onParkedPageReady(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto' || ps.autoPhase !== 'parked') return;
  const url = panelViews[key]?.webContents.getURL() || '';
  console.log(`[kiosk-auto] ${key} parked page ready: ${url}`);
  startScrolling(key);
  const dwellMs = randBetween(RESULT_DWELL_MIN_MS, RESULT_DWELL_MAX_MS);
  kioskLog(`[kiosk-auto] ${key} speed=${Math.round(ps.scrollPxS)}px/s dwell=${Math.round(dwellMs / 1000)}s (parked)`);
  clearTimeout(ps.resultDwellTimer);
  ps.resultDwellTimer = setTimeout(() => {
    ps.resultDwellTimer = null;
    if (ps.mode !== 'auto' || ps.autoPhase !== 'parked') return;
    stopScrolling(key);
    parkNextPage(key);
  }, dwellMs);
}

// Called when any panel hits a DDG bot-check page.  Sets a shared pause so
// all panels stop hitting DDG, with exponential back-off per strike.
// Also navigates the triggering panel away from the challenge page.
function noteDdgBotCheck(key) {
  const now = Date.now();

  // Guard: cap at one new strike per DDG_MIN_STRIKE_GAP_MS to prevent runaway
  // escalation if a neutral page falsely triggers the bot-check test.
  if (ddgLastStrikeAt > 0 && now - ddgLastStrikeAt < DDG_MIN_STRIKE_GAP_MS) {
    kioskLog(`[ddg] bot-check ignored (last strike ${Math.round((now - ddgLastStrikeAt) / 1000)}s ago) — moving ${key} off page`);
    navigateToParkedPage(key);
    return;
  }
  ddgLastStrikeAt = now;

  clearTimeout(ddgStrikeResetTimer);
  ddgStrikeResetTimer = null;

  ddgBotStrikes += 1;
  const pauseMs  = Math.min(DDG_PAUSE_BASE_MS * Math.pow(2, ddgBotStrikes - 1), DDG_PAUSE_MAX_MS);
  ddgPausedUntil = Date.now() + pauseMs;
  ddgStats.botChecks++;
  kioskLog(`[ddg] bot-check: strike ${ddgBotStrikes}, pausing all DDG for ${Math.round(pauseMs / 60000)} min`);

  // Schedule strike reset after a clean period with no bot-checks.
  ddgStrikeResetTimer = setTimeout(() => {
    ddgStrikeResetTimer = null;
    ddgBotStrikes   = 0;
    ddgLastStrikeAt = 0;
    let parkCount = 0;
    for (const [, pstate] of panelStates) {
      if (pstate.autoPhase === 'parked') parkCount++;
    }
    ddgPausedUntil = 0;
    kioskLog(`[ddg] pause ended — strike counter reset, ${parkCount} parked panel(s) resuming`);
  }, DDG_STRIKE_RESET_MS);

  // Navigate the triggering panel off the bot-check page.
  navigateToParkedPage(key);
}

// Starts the 10-minute rolling [ddg] summary log.
function startDdgSummaryTimer() {
  ddgStats.windowStart = Date.now();
  ddgSummaryTimer = setInterval(() => {
    const now     = Date.now();
    const minutes = (now - ddgStats.windowStart) / 60000;
    const rate    = minutes > 0 ? (ddgStats.searches / minutes).toFixed(2) : '0';
    kioskLog(`[ddg] 10-min summary: searches=${ddgStats.searches} cache=${ddgStats.cacheHits} saved-serp=${ddgStats.savedSerpShows} results=${ddgStats.resultsVisited} bot-checks=${ddgStats.botChecks} no-eligible=${ddgStats.noEligibleMisses} downloads-blocked=${ddgStats.downloadsBlocked} local=${ddgStats.local} rate=${rate}/min`);
    ddgStats = { searches: 0, cacheHits: 0, savedSerpShows: 0, resultsVisited: 0, botChecks: 0, noEligibleMisses: 0, downloadsBlocked: 0, local: 0, windowStart: now };
  }, 10 * 60 * 1000);
}

function doSearch(key) {
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;
  ps.autoPhase     = 'search';
  ps.queuedResults  = []; // discard any leftovers from the previous SERP
  ps.resultsGoal   = 0;
  ps.resultsVisited = 0;

  // ---- DDG global pause (bot-check backoff) ----------------------------------
  // During a pause never make a real DDG request.  Show a saved SERP file so
  // the panel continues the normal search → result browsing loop.
  const pauseMs = ddgPausedUntil - Date.now();
  if (pauseMs > 0) {
    sharedOnScreenUrls.delete(key);
    showSavedSerpDuringPause(key);
    return;
  }

  // ---- Part 4: Global search gap (now covers first search with shorter gap) --
  const gap          = ps.firstSearchDone ? GLOBAL_SEARCH_GAP_MS : FIRST_SEARCH_GAP_MS;
  const gapRemaining = gap - (Date.now() - lastSearchStartedAt);
  if (gapRemaining > 0) {
    clearTimeout(ps.dwellTimer);
    ps.dwellTimer = setTimeout(() => {
      ps.dwellTimer = null;
      if (ps.mode === 'auto') doSearch(key);
    }, gapRemaining);
    return;
  }

  const isFirst      = !ps.firstSearchDone;
  ps.firstSearchDone = true;

  const now = Date.now();
  ps.lastSearchTime = now;

  // Panel is leaving any result page — clear its on-screen entry.
  sharedOnScreenUrls.delete(key);

  const term = drawNextTerm(key);
  ps.currentTerm = term;
  ps.searchCount = (ps.searchCount || 0) + 1;

  // Log term draw with deck state.
  const otherTermStrs = [];
  for (const [k, ops] of panelStates) {
    if (k !== key && ops.currentTerm) otherTermStrs.push(`${k}='${ops.currentTerm}'`);
  }
  const totalEligible = SEARCH_TERMS.length - skippedTerms.size;
  kioskLog(`[kiosk-deck] ${key} term='${term}' deck=${searchDeck.length}/${totalEligible}${otherTermStrs.length ? ` (others: ${otherTermStrs.join(', ')})` : ''}`);

  // ---- Part 5: weather direct page (US only) ---------------------------------
  // When the drawn term is the "{city} weather" local term and the kiosk is in
  // the US, skip DuckDuckGo and load forecast.weather.gov directly.
  if (term === localWeatherTerm && kioskLocation && kioskLocation.countryCode === 'US') {
    const lat        = kioskLocation.lat.toFixed(4);
    const lon        = kioskLocation.lon.toFixed(4);
    const weatherUrl = `https://forecast.weather.gov/MapClick.php?lat=${lat}&lon=${lon}`;
    kioskLog(`[kiosk-local] ${key} weather direct: ${weatherUrl}`);
    ps.lastSearchTime = now;
    ps.resultsGoal    = 1;
    ps.queuedResults  = [];
    ps.resultsVisited = 0;
    loadResult(key, { target: weatherUrl, domHref: weatherUrl, tier: 'local-weather' });
    return;
  }

  // ---- Part 3: SERP cache check (skip DDG if we have fresh results) ----------
  const serpEntry = serpCache.get(term);
  if (serpEntry && Date.now() - serpEntry.fetchedAt < SERP_CACHE_TTL_MS) {
    const eligible = filterCachedUrls(key, serpEntry.urls);
    if (eligible.length > 0) {
      let useCt = (serpCacheUseCount.get(term) || 0) + 1;
      serpCacheUseCount.set(term, useCt);
      if (useCt % SHOW_SERP_EVERY_N !== 0) {
        kioskLog(`[ddg] ${key} search="${term}" type=saved-serp use=${useCt}`);
        ddgStats.cacheHits++;
        // Show the saved SERP file so the panel displays the search step.
        if (serpEntry.filePath && serpFileValid(serpEntry.filePath)) {
          ddgStats.savedSerpShows++;
          ps.loadingSerp = true;
          const v = panelViews[key];
          if (!v || v.webContents.isDestroyed()) return;
          v.webContents.loadURL('file://' + serpEntry.filePath).catch(() => {
            ps.loadingSerp = false;
            serpCache.delete(term); // force fresh fetch on retry
            doSearch(key);
          });
          return;
        }
        // No file yet — fall back to jumping directly to a result page.
        ps.queuedResults = eligible.slice(1).map(u => ({ target: u, domHref: u, tier: 'cache' }));
        ps.resultsGoal   = Math.floor(randBetween(RESULTS_PER_SEARCH_MIN, RESULTS_PER_SEARCH_MAX + 1));
        loadResult(key, { target: eligible[0], domHref: eligible[0], tier: 'cache' });
        return;
      }
      kioskLog(`[ddg] ${key} search="${term}" type=real (SERP refresh, every ${SHOW_SERP_EVERY_N} uses)`);
    } else {
      kioskLog(`[ddg] ${key} search="${term}" type=real (cache empty after filters)`);
    }
  } else {
    kioskLog(`[ddg] ${key} search="${term}" type=real (no cache)`);
  }

  // ---- Real DDG search -------------------------------------------------------
  ddgStats.searches++;
  lastSearchStartedAt    = now;
  ps.searchLoadStartedAt = now;

  // Build site: filter list: 2-3 group-specific domains + 1 general domain.
  // Skip domains that are bad or already on-screen in another panel.
  const groupDomains = TERM_GROUP_DOMAINS.get(term) || [];
  const onScreenDomains = new Set();
  for (const [, _u] of sharedOnScreenUrls) {
    if (_u) { try { onScreenDomains.add(new URL(_u).hostname); } catch {} }
  }
  const domainIsOnScreen = _d => [...onScreenDomains].some(_h => _h === _d || _h.endsWith('.' + _d));
  const eligibleGroupDomains = groupDomains.filter(_d =>
    !isBadDomain('https://' + _d + '/') && !domainIsOnScreen(_d)
  );
  for (let _i = eligibleGroupDomains.length - 1; _i > 0; _i--) {
    const _j = Math.floor(Math.random() * (_i + 1));
    [eligibleGroupDomains[_i], eligibleGroupDomains[_j]] = [eligibleGroupDomains[_j], eligibleGroupDomains[_i]];
  }
  const sites = eligibleGroupDomains.slice(0, Math.floor(randBetween(2, 4)));
  const general = GENERAL_DOMAINS.find(_d =>
    !sites.includes(_d) && !isBadDomain('https://' + _d + '/') && !domainIsOnScreen(_d)
  );
  if (general) sites.push(general);
  kioskLog(`[ddg] ${key} search="${term}" sites=${sites.length > 0 ? sites.join(',') : 'none'} type=real`);

  const url = buildSearchUrl(term, sites.length > 0 ? sites : null);
  console.log(`[kiosk-auto] ${key} search #${ps.searchCount}: "${term}"`);

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
  clearTimeout(ps.resultDwellTimer);  // random dwell cap on result pages
  clearTimeout(ps.pauseResumeTimer);  // safety-net for DDG pause expiry
  ps.dwellTimer         = null;
  ps.scrollTimer        = null;
  ps.rotationStartTimer = null;
  ps.loadTimer          = null;
  ps.highlightTimer     = null;
  ps.resultDwellTimer   = null;
  ps.pauseResumeTimer   = null;
  ps.pendingQueuedPick  = null; // discard any pending queued pick on customer takeover
  ps.serpBottomHandled  = false;
}

// ---- Forkknife window -------------------------------------------------------

function createForkKnifeWindow(workArea) {
  if (forkKnifeWindow && !forkKnifeWindow.isDestroyed()) {
    forkKnifeWindow.destroy();
  }
  const homeX = workArea.x + FORKKNIFE_POSITION.x - FK_SHADOW_PAD;
  const homeY = workArea.y + FORKKNIFE_POSITION.y - FK_SHADOW_PAD;
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
    focusable:   false, // never takes focus, so clicking it cannot reshuffle the always-on-top stack
    resizable:   false,
    movable:     true,
    webPreferences: {
      preload:          path.join(__dirname, 'kiosk-forkknife-preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    },
  });
  keepOnAllWorkspaces(forkKnifeWindow);
  forkKnifeWindow.loadFile(path.join(__dirname, 'kiosk-forkknife.html'));
  forkKnifeWindow.webContents.on('dom-ready', () => {
    forkKnifeWindow.webContents.insertCSS(FORKKNIFE_CURSOR_CSS, { cssOrigin: 'user' }).catch(() => {});
  });
  forkKnifeWindow.webContents.once('did-finish-load', () => {
    if (USE_WINDOW_SHAPE && process.platform === 'linux') {
      forkKnifeWindow.setShape([
        { x: 0, y: 0, width: FORKKNIFE_WIN_W, height: FORKKNIFE_WIN_H },
      ]);
    }
    pushForkKnifeNavState();
  });

  forkKnifeWindow.webContents.on('render-process-gone', (_e, details) => {
    const msg = `forkknife render-process-gone reason=${details.reason} exitCode=${details.exitCode}`;
    console.error(`[kiosk] ${msg}`);
    kioskLog(msg);
    setTimeout(() => {
      if (!forkKnifeWindow || forkKnifeWindow.isDestroyed()) return;
      forkKnifeWindow.webContents.once('did-finish-load', () => {
        if (USE_WINDOW_SHAPE && process.platform === 'linux') {
          forkKnifeWindow.setShape([{ x: 0, y: 0, width: FORKKNIFE_WIN_W, height: FORKKNIFE_WIN_H }]);
        }
        pushForkKnifeNavState();
        restackOverlays();
      });
      forkKnifeWindow.loadFile(path.join(__dirname, 'kiosk-forkknife.html'));
    }, 500);
  });
  forkKnifeWindow.on('unresponsive', () => {
    kioskLog('forkknife window unresponsive');
  });
}

// ---- Clock window -------------------------------------------------------------

function fetchClockTimezone() {
  // Deliberately plain http:// — ip-api.com's free tier has no https.
  // See the identical comment in renderer.js for the full explanation.
  http.get('http://ip-api.com/json/', (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.timezone) {
          clockTimezone = parsed.timezone;
          if (clockWindow && !clockWindow.isDestroyed()) {
            clockWindow.webContents.send('clock-timezone', clockTimezone);
          }
        }
      } catch (e) {
        console.error('[kiosk-clock] timezone parse failed:', e.message);
      }
    });
  }).on('error', (e) => {
    console.error('[kiosk-clock] timezone fetch failed:', e.message);
  });
}

function createClockWindow(workArea) {
  if (clockWindow && !clockWindow.isDestroyed()) {
    clockWindow.destroy();
  }
  const homeX = workArea.x + CLOCK_POSITION.x - CLOCK_SHADOW_PAD;
  const homeY = workArea.y + CLOCK_POSITION.y - CLOCK_SHADOW_PAD;
  clockHomePos = { x: homeX, y: homeY };

  clockWindow = new BrowserWindow({
    x:           homeX,
    y:           homeY,
    width:       CLOCK_WIN_SIZE,
    height:      CLOCK_WIN_SIZE,
    frame:       false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable:   false, // never takes focus, so clicking it cannot reshuffle the always-on-top stack
    resizable:   false,
    movable:     true,
    webPreferences: {
      preload:          path.join(__dirname, 'kiosk-clock-preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    },
  });

  keepOnAllWorkspaces(clockWindow);
  clockWindow.loadFile(path.join(__dirname, 'kiosk-clock.html'));
  clockWindow.webContents.on('dom-ready', () => {
    clockWindow.webContents.insertCSS(FORKKNIFE_CURSOR_CSS, { cssOrigin: 'user' }).catch(() => {});
  });
  clockWindow.webContents.once('did-finish-load', () => {
    if (USE_WINDOW_SHAPE && process.platform === 'linux') {
      clockWindow.setShape([{ x: 0, y: 0, width: CLOCK_WIN_SIZE, height: CLOCK_WIN_SIZE }]);
    }
    clockWindow.webContents.send('clock-svg', _clockSvgText);
    if (clockTimezone) clockWindow.webContents.send('clock-timezone', clockTimezone);
  });

  clockWindow.webContents.on('render-process-gone', (_e, details) => {
    const msg = `clock render-process-gone reason=${details.reason} exitCode=${details.exitCode}`;
    console.error(`[kiosk] ${msg}`);
    kioskLog(msg);
    setTimeout(() => {
      if (!clockWindow || clockWindow.isDestroyed()) return;
      // dom-ready handler (attached with 'on') will re-inject CSS automatically.
      clockWindow.webContents.once('did-finish-load', () => {
        if (USE_WINDOW_SHAPE && process.platform === 'linux') {
          clockWindow.setShape([{ x: 0, y: 0, width: CLOCK_WIN_SIZE, height: CLOCK_WIN_SIZE }]);
        }
        clockWindow.webContents.send('clock-svg', _clockSvgText);
        if (clockTimezone) clockWindow.webContents.send('clock-timezone', clockTimezone);
        restackOverlays();
      });
      clockWindow.loadFile(path.join(__dirname, 'kiosk-clock.html'));
    }, 500);
  });
  clockWindow.on('unresponsive', () => {
    kioskLog('clock window unresponsive');
  });
}

// ---- Address bar window -------------------------------------------------------

function createAddressBarWindow(workArea) {
  if (addressBarWindow && !addressBarWindow.isDestroyed()) {
    addressBarWindow.destroy();
  }

  const hubWin = panelWindows.get('hub');
  let startX = workArea.x;
  let startY = workArea.y;
  if (hubWin && !hubWin.isDestroyed()) {
    const b = hubWin.getBounds();
    startX = b.x + HARDWARE_MARGIN - ADDRESSBAR_DOCK_OVERHANG_X;
    startY = b.y + b.height - HARDWARE_MARGIN - ADDRESSBAR_DOCK_BOTTOM_INSET - AB_WIN_H;
  }

  addressBarDocked   = true;
  addressBarKey      = 'hub';
  addressBarLiveUrl  = '';
  addressBarCurrentW = AB_WIN_W;

  addressBarWindow = new BrowserWindow({
    x:               Math.round(startX),
    y:               Math.round(startY),
    width:           AB_WIN_W,
    height:          AB_WIN_H,
    frame:           false,
    transparent:     false,
    backgroundColor: '#ffffff',
    alwaysOnTop:     true,
    skipTaskbar:     true,
    resizable:       true,   // required for programmatic setBounds() on Linux (window is frameless so users still can't resize by hand)
    focusable:       true,
    webPreferences: {
      preload:          path.join(__dirname, 'kiosk-addressbar-preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    },
  });

  keepOnAllWorkspaces(addressBarWindow);
  addressBarWindow.loadFile(path.join(__dirname, 'kiosk-addressbar.html'));

  addressBarWindow.webContents.on('dom-ready', () => {
    addressBarWindow.webContents.insertCSS(ADDRESSBAR_CURSOR_CSS, { cssOrigin: 'user' }).catch(() => {});
  });

  addressBarWindow.webContents.once('did-finish-load', () => {
    if (USE_WINDOW_SHAPE && process.platform === 'linux') {
      addressBarWindow.setShape([{ x: 0, y: 0, width: AB_WIN_W, height: AB_WIN_H }]);
    }
    const targetView = panelViews[addressBarKey];
    if (targetView && !targetView.webContents.isDestroyed()) {
      pushAddressBarUrl(targetView.webContents.getURL());
    }
  });

  addressBarWindow.webContents.on('render-process-gone', (_e, details) => {
    const msg = `addressbar render-process-gone reason=${details.reason} exitCode=${details.exitCode}`;
    console.error(`[kiosk] ${msg}`);
    kioskLog(msg);
    setTimeout(() => {
      if (!addressBarWindow || addressBarWindow.isDestroyed()) return;
      addressBarWindow.webContents.once('did-finish-load', () => {
        if (USE_WINDOW_SHAPE && process.platform === 'linux') {
          addressBarWindow.setShape([{ x: 0, y: 0, width: addressBarCurrentW, height: AB_WIN_H }]);
        }
        if (addressBarLiveUrl) addressBarWindow.webContents.send('addressbar-url', addressBarLiveUrl);
        restackOverlays();
      });
      addressBarWindow.loadFile(path.join(__dirname, 'kiosk-addressbar.html'));
    }, 500);
  });
  addressBarWindow.on('unresponsive', () => {
    kioskLog('addressbar window unresponsive');
  });
}

// ---- Carbon indicator helpers -----------------------------------------------

// Maps grams of CO2 to a 0–1 score on a log scale between CARBON_CLEAN_G and
// CARBON_DIRTY_G.  0 = clean (blue), 1 = dirty (orange).
function computeCarbonScore(grams) {
  if (!grams || grams <= 0) return 0.5;
  const lo = Math.log(CARBON_CLEAN_G);
  const hi = Math.log(CARBON_DIRTY_G);
  const v  = Math.log(grams);
  return Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
}

// Send the current carbon state of the given key to the carbon window.
// Only sends when that key is the currently active panel, and only when the
// carbon window exists.
function pushCarbonState(key) {
  if (!carbonWindow || carbonWindow.isDestroyed()) return;
  if (key !== getActiveKey()) return;
  const ps = panelStates.get(key);
  if (!ps) return;
  const score = computeCarbonScore(ps.carbonGrams || 0);
  carbonWindow.webContents.send('carbon-state', { score, loading: !!ps.carbonLoading });
}

// ---- Carbon window ------------------------------------------------------------

function createCarbonWindow(workArea) {
  if (carbonWindow && !carbonWindow.isDestroyed()) {
    carbonWindow.destroy();
  }

  const hubWin  = panelWindows.get('hub');
  let startX = workArea.x + CARBON_ANCHOR.x - CARBON_SHADOW_PAD;
  let startY = workArea.y + CARBON_ANCHOR.y - CARBON_SHADOW_PAD;
  if (hubWin && !hubWin.isDestroyed()) {
    const b = hubWin.getBounds();
    startX  = b.x + CARBON_ANCHOR.x - CARBON_SHADOW_PAD;
    startY  = b.y + CARBON_ANCHOR.y - CARBON_SHADOW_PAD;
  }

  carbonDocked = true;

  carbonWindow = new BrowserWindow({
    x:           Math.round(startX),
    y:           Math.round(startY),
    width:       CARBON_WIN_SIZE,
    height:      CARBON_WIN_SIZE,
    frame:       false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable:   false, // never takes focus, so clicking it cannot reshuffle the always-on-top stack
    resizable:   false,
    movable:     true,
    webPreferences: {
      preload:          path.join(__dirname, 'kiosk-carbon-preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    },
  });

  keepOnAllWorkspaces(carbonWindow);
  carbonWindow.loadFile(path.join(__dirname, 'kiosk-carbon.html'));
  carbonWindow.webContents.on('dom-ready', () => {
    carbonWindow.webContents.insertCSS(FORKKNIFE_CURSOR_CSS, { cssOrigin: 'user' }).catch(() => {});
  });
  carbonWindow.webContents.once('did-finish-load', () => {
    if (USE_WINDOW_SHAPE && process.platform === 'linux') {
      carbonWindow.setShape([{ x: 0, y: 0, width: CARBON_WIN_SIZE, height: CARBON_WIN_SIZE }]);
    }
    carbonWindow.webContents.send('carbon-svg', _carbonSvgText);
    // Push initial neutral loading state.
    carbonWindow.webContents.send('carbon-state', { score: 0.5, loading: false });
  });

  carbonWindow.webContents.on('render-process-gone', (_e, details) => {
    const msg = `carbon render-process-gone reason=${details.reason} exitCode=${details.exitCode}`;
    console.error(`[kiosk] ${msg}`);
    kioskLog(msg);
    setTimeout(() => {
      if (!carbonWindow || carbonWindow.isDestroyed()) return;
      carbonWindow.webContents.once('did-finish-load', () => {
        if (USE_WINDOW_SHAPE && process.platform === 'linux') {
          carbonWindow.setShape([{ x: 0, y: 0, width: CARBON_WIN_SIZE, height: CARBON_WIN_SIZE }]);
        }
        carbonWindow.webContents.send('carbon-svg', _carbonSvgText);
        pushCarbonState(getActiveKey());
        restackOverlays();
      });
      carbonWindow.loadFile(path.join(__dirname, 'kiosk-carbon.html'));
    }, 500);
  });
  carbonWindow.on('unresponsive', () => {
    kioskLog('carbon window unresponsive');
  });
}

// ---- Location lookup and local-topic wiring ---------------------------------

// Calls back with { city, regionName, country, countryCode, lat, lon } or null.
// Uses ip-api.com via plain http:// — the free tier has no HTTPS; see the
// identical comment in renderer.js and fetchClockTimezone().
function getKioskLocation(callback) {
  http.get(
    'http://ip-api.com/json/?fields=status,city,regionName,country,countryCode,lat,lon',
    (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.status !== 'success' || !parsed.city) { callback(null); return; }
          callback({
            city:        parsed.city,
            regionName:  parsed.regionName  || '',
            country:     parsed.country     || '',
            countryCode: parsed.countryCode || '',
            lat:         parsed.lat || 0,
            lon:         parsed.lon || 0,
          });
        } catch (_) { callback(null); }
      });
    }
  ).on('error', () => callback(null));
}

function saveLocationCache(loc) {
  try {
    fs.writeFileSync(LOCATION_CACHE_FILE, JSON.stringify({ ...loc, savedAt: Date.now() }));
  } catch (e) {
    console.error('[kiosk-local] failed to save location cache:', e.message);
  }
}

function loadLocationCache() {
  try {
    const data = JSON.parse(fs.readFileSync(LOCATION_CACHE_FILE, 'utf8'));
    if (data && data.city) return data;
  } catch (_) {}
  return null;
}

// Fetches a fresh location in the background; rebuilds local topics if the city changed.
function refreshLocationInBackground() {
  getKioskLocation(loc => {
    if (!loc) return; // network error; keep existing state
    saveLocationCache(loc);
    const prevCity = kioskLocation ? kioskLocation.city : null;
    kioskLocation  = loc;
    if (!prevCity || prevCity !== loc.city) {
      kioskLog(`[kiosk-local] location: ${loc.city}, ${loc.regionName}, ${loc.countryCode} (live)`);
      rebuildTopics(loc); // logs "added N local terms" or "rebuilt for <city>"
    }
  });
}

// Called once from createKioskWindow before panels start browsing.  Loads any
// cached location synchronously so the full topic deck is ready before the first
// drawNextTerm call, then kicks off a background refresh and a periodic 6-hour
// refresh interval.  Never blocks panel startup — if neither cache nor live
// lookup succeeds, panels run with static topics only (identical to before this
// feature was added).
function startLocationWatch() {
  // Testing override: KIOSK_FAKE_LOCATION="City|Region|CC|lat|lon"
  const fake = process.env.KIOSK_FAKE_LOCATION;
  if (fake) {
    const p = fake.split('|');
    if (p.length === 5) {
      const loc = {
        city: p[0], regionName: p[1], country: p[2], countryCode: p[2],
        lat: parseFloat(p[3]), lon: parseFloat(p[4]),
      };
      kioskLog(`[kiosk-local] location: ${loc.city}, ${loc.regionName}, ${loc.countryCode} (fake)`);
      kioskLocation = loc;
      rebuildTopics(loc);
    } else {
      rebuildTopics(null);
    }
    return; // skip ip-api and the refresh timer when using a fake location
  }

  const cached = loadLocationCache();
  if (cached && cached.city) {
    kioskLog(`[kiosk-local] location: ${cached.city}, ${cached.regionName}, ${cached.countryCode} (cache)`);
    kioskLocation = cached;
    rebuildTopics(cached);
  } else {
    rebuildTopics(null); // logs "skipped: no location"
  }

  // Kick off an immediate background refresh, then repeat every LOCATION_REFRESH_MS.
  refreshLocationInBackground();
  if (!_locationRefreshTimer) {
    _locationRefreshTimer = setInterval(refreshLocationInBackground, LOCATION_REFRESH_MS);
  }
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
  if (AD_BLOCKING_ENABLED) {
    installAdTrackerBlock();
  } else {
    kioskLog('ad/tracker blocking disabled (AD_BLOCKING_ENABLED = false)');
  }
  installAutoErrorBlock(); // no-op when AUTO_ERROR_BLOCK_ENABLED = false
  installDownloadBlock();

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
    keepOnAllWorkspaces(win);
    // Clicking anywhere on a panel (strip, frame or page) focuses it: record
    // it as the front panel and put the overlays back above it, since the
    // window manager raised it over every other alwaysOnTop window.
    win.on('focus', () => {
      // Each new window takes focus as it is created; skip those so startup
      // keeps the default order (same 5 s grace as the move handler).
      if (!windowsCreatedAt || Date.now() - windowsCreatedAt < 5_000) return;
      bringPanelToFront(key);
    });
    console.log(`[kiosk-timing] ${key} window created: +${timingMs()} ms`);

    const minSize = minSizeFor(key);
    win.setMinimumSize(minSize.width, minSize.height);
    win.loadFile(path.join(__dirname, 'kiosk-handle.html'));
    win.webContents.on('dom-ready', () => {
      win.webContents.insertCSS(HANDLE_CURSOR_CSS, { cssOrigin: 'user' }).catch(() => {});
    });
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('panel-hardware', { key, margin: M });
      updateWindowShape(key);
    });

    win.webContents.on('render-process-gone', (_e, details) => {
      const msg = `panel ${key} handle render-process-gone reason=${details.reason} exitCode=${details.exitCode}`;
      console.error(`[kiosk] ${msg}`);
      kioskLog(msg);
      setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        win.webContents.once('did-finish-load', () => {
          win.webContents.send('panel-hardware', { key, margin: M });
          updateWindowShape(key);
        });
        win.loadFile(path.join(__dirname, 'kiosk-handle.html'));
      }, 500);
    });
    win.on('unresponsive', () => {
      kioskLog(`panel ${key} handle window unresponsive`);
    });

    // Panel content view — inset by HARDWARE_MARGIN on all sides so the
    // transparent border is visible.  setAutoResize keeps the right and
    // bottom edges tracking the window edges (distance M preserved).
    const view = makePanelView();
    win.addBrowserView(view);
    view.setBounds({ x: M, y: HANDLE_HEIGHT + M, width: panelW, height: panelH });
    view.setAutoResize({ width: true, height: true });
    const cachedPage = path.join(cacheDir, `${key}.html`);
    if (serpFileValid(cachedPage)) {
      view.webContents.loadFile(cachedPage);
    } else {
      if (fs.existsSync(cachedPage)) {
        fs.unlink(cachedPage, () => {});
        kioskLog(`[ddg] ${key} stale startup cache skipped (no DOCTYPE) — loading placeholder`);
      }
      view.webContents.loadURL(PLACEHOLDER_URL);
    }
    panelViews[key] = view;
    setupViewEventHandlers(key, win, view);

    // Resize grip — added after the panel view so it stays on top.
    const grip = makeGripView();
    win.addBrowserView(grip);
    grip.webContents.loadFile(path.join(__dirname, 'kiosk-resize-grip.html'));
    grip.webContents.on('dom-ready', () => {
      grip.webContents.insertCSS(GRIP_CURSOR_CSS, { cssOrigin: 'user' }).catch(() => {});
    });
    gripViews[key] = grip;
    positionGrip(key);

    grip.webContents.on('render-process-gone', (_e, details) => {
      const msg = `panel ${key} grip render-process-gone reason=${details.reason} exitCode=${details.exitCode}`;
      console.error(`[kiosk] ${msg}`);
      kioskLog(msg);
      setTimeout(() => {
        if (!grip || grip.webContents.isDestroyed()) return;
        grip.webContents.loadFile(path.join(__dirname, 'kiosk-resize-grip.html'));
      }, 500);
    });

    // The handle page re-renders its border/hinges from its own window
    // 'resize' listener, so no panel-hardware IPC is needed here.
    win.on('resize', () => {
      positionGrip(key);
      updateWindowShape(key);
      if (key === 'hub') repositionAddressBar();
      if (key === 'hub') repositionCarbon();
    });

    let moveDebounce = null;
    win.on('move', () => {
      if (key === 'hub') repositionAddressBar();
      if (key === 'hub') repositionCarbon();
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
      // homeBounds intentionally NOT deleted — health check needs it to rebuild.
      delete panelViews[key];
      delete gripViews[key];
      resizeState.delete(key);
      tweenTimers.delete(key);
    });
  }

  // Re-stack hub on top now that all five windows exist.
  const hubWin = panelWindows.get('hub');
  if (hubWin && !hubWin.isDestroyed()) hubWin.moveTop();
  restackOverlays();

  startLocationWatch(); // load location from cache; refresh in background
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

  _lastWorkArea = workArea;

  createForkKnifeWindow(workArea);
  createClockWindow(workArea);
  createAddressBarWindow(workArea);
  createCarbonWindow(workArea);

  // Start timezone fetch for the clock.  The interval is created only once so
  // a future re-layout call doesn't spawn duplicate timers.
  fetchClockTimezone();
  if (!clockTzTimer) {
    clockTzTimer = setInterval(fetchClockTimezone, CLOCK_TZ_REFETCH_MS);
  }

  startHealthCheck();
  startCacheClearTimer();
  startViewRecycleTimer();
  startNightlyRestartTimer();

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

  createDragShields();

  // Preload requests this to inject the spoon rule at user origin in every frame.
  ipcMain.handle('get-cursor-css', () => PANEL_CURSOR_CSS);

  // Hinge overlap: the handle page reports its hinge placements (window
  // coordinates); forward them to that panel's page so kiosk-preload.js can
  // draw the part that overlaps the page.  New documents fetch the latest
  // placements with get-panel-hinges.
  ipcMain.on('panel-hinges', (event, hinges) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (!key) return;
    const win = panelWindows.get(key);
    if (!win || win.isDestroyed() || win.webContents !== event.sender) return;
    panelHinges.set(key, hinges);
    const view = panelViews[key];
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.send('panel-hinges', hingePayload(key));
    }
  });
  ipcMain.handle('get-panel-hinges', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    return key ? hingePayload(key) : null;
  });
  ipcMain.on('get-panel-hinges-sync', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    event.returnValue = key ? hingePayload(key) : null;
  });

  // Cookie consent: preload requests the script once per document via sendSync.
  ipcMain.on('get-cookie-consent-script-sync', (event) => {
    event.returnValue = COOKIE_AUTO_ACCEPT_ENABLED ? getCookieConsentScript() : '';
  });
  // Preload forwards banner-accepted reports from the main world.
  ipcMain.on('cookie-consent-accepted', (event, info) => {
    const key = webContentsIdToKey.get(event.sender.id) || '?';
    const i = (info && typeof info === 'object') ? info : { how: String(info || 'generic') };
    cookieConsentCount += 1;
    console.log(`[kiosk-consent] ${key} accepted on ${i.host || '?'}${i.top === false ? ' (iframe)' : ''} via ${i.how} "${i.detail || ''}"`);
  });
  if (COOKIE_AUTO_ACCEPT_ENABLED) {
    setInterval(() => {
      if (cookieConsentCount > 0) {
        kioskLog(`cookie banners auto-accepted in last 5 min: ${cookieConsentCount}`);
        cookieConsentCount = 0;
      }
    }, 5 * 60 * 1000);
  }

  // Shield window sends shield-move-tick on every pointermove.
  // Resets the 2 s safety timer and drives the active drag/resize.
  ipcMain.on('shield-move-tick', (event) => {
    if (!isShieldSender(event.sender)) return;
    clearTimeout(shieldSafetyTimer);
    shieldSafetyTimer = setTimeout(hideDragShield, 2000);
    switch (shieldDragType) {
      case 'forkknife':  dragMove.forkknife(); break;
      case 'clock':      dragMove.clock(); break;
      case 'panel':      if (shieldDragKey) dragMove.panel(shieldDragKey); break;
      case 'resize':     if (shieldDragKey) dragMove.resize(shieldDragKey); break;
      case 'addressbar': dragMove.addressbar(); break;
      case 'carbon':     dragMove.carbon(); break;
    }
  });

  // Shield window sends shield-done on pointerup/pointercancel.
  ipcMain.on('shield-done', (event) => {
    if (!isShieldSender(event.sender)) return;
    switch (shieldDragType) {
      case 'forkknife':  forkKnifeDragOffset = null; break;
      case 'clock':      clockDragOffset = null; break;
      case 'panel':
        if (shieldDragKey) { panelDragOffsets.set(shieldDragKey, null); clampToDisplay(shieldDragKey); }
        break;
      case 'resize':     if (shieldDragKey) endResize(shieldDragKey); break;
      case 'addressbar': addressBarDragOffset = null; break;
      case 'carbon':     carbonDragOffset = null; break;
    }
    hideDragShield();
  });

  ipcMain.on('panel-activity', (event, eventType) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (!key) return;
    const ps = panelStates.get(key);
    if (ps) ps.lastTrustedInputAt = Date.now();
    notePanelActivity(key, eventType || 'unknown');
  });

  ipcMain.on('kiosk-sb-diag', (event, info) => {
    const key  = webContentsIdToKey.get(event.sender.id) || '?';
    const kind = String(info.kind || '').slice(0, 80);
    const tag  = String(info.tag  || '').slice(0, 80);
    const id   = String(info.id   || '').slice(0, 80);
    const cls  = String(info.cls  || '').slice(0, 80);
    const w    = Math.round(Number(info.w)  || 0);
    const h    = Math.round(Number(info.h)  || 0);
    const sh   = Math.round(Number(info.sh) || 0);
    const vw   = Math.round(Number(info.vw) || 0);
    const vh   = Math.round(Number(info.vh) || 0);
    const host = String(info.host || '').slice(0, 80);
    kioskLog(`[kiosk-sb] ${key} main=${kind} <${tag}#${id}.${cls}> ${w}x${h} scrollH=${sh} view=${vw}x${vh} host=${host}`);
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
    showDragShield('forkknife');
  });

  ipcMain.on('forkknife-drag-move', (event) => {
    if (!forkKnifeWindow || forkKnifeWindow.isDestroyed()) return;
    if (event.sender !== forkKnifeWindow.webContents) return;
    dragMove.forkknife();
  });

  ipcMain.on('forkknife-drag-end', (event) => {
    if (!forkKnifeWindow || forkKnifeWindow.isDestroyed()) return;
    if (event.sender !== forkKnifeWindow.webContents) return;
    forkKnifeDragOffset = null;
    hideDragShield();
  });

  ipcMain.on('forkknife-drag-reset', (event) => {
    if (!forkKnifeWindow || forkKnifeWindow.isDestroyed()) return;
    if (event.sender !== forkKnifeWindow.webContents) return;
    if (forkKnifeHomePos) {
      forkKnifeWindow.setPosition(forkKnifeHomePos.x, forkKnifeHomePos.y);
    }
  });

  ipcMain.on('clock-drag-start', (event) => {
    if (!clockWindow || clockWindow.isDestroyed()) return;
    if (event.sender !== clockWindow.webContents) return;
    const cursor = screen.getCursorScreenPoint();
    const pos    = clockWindow.getPosition();
    clockDragOffset = { dx: cursor.x - pos[0], dy: cursor.y - pos[1] };
    showDragShield('clock');
  });

  ipcMain.on('clock-drag-move', (event) => {
    if (!clockWindow || clockWindow.isDestroyed()) return;
    if (event.sender !== clockWindow.webContents) return;
    dragMove.clock();
  });

  ipcMain.on('clock-drag-end', (event) => {
    if (!clockWindow || clockWindow.isDestroyed()) return;
    if (event.sender !== clockWindow.webContents) return;
    clockDragOffset = null;
    hideDragShield();
  });

  ipcMain.on('clock-drag-reset', (event) => {
    if (!clockWindow || clockWindow.isDestroyed()) return;
    if (event.sender !== clockWindow.webContents) return;
    if (clockHomePos) {
      clockWindow.setPosition(clockHomePos.x, clockHomePos.y);
    }
  });

  ipcMain.on('panel-reset-position', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (key) resetPanelLayout(key);
  });

  // Pointer-event drag from the handle strip (replaces -webkit-app-region: drag).
  ipcMain.on('panel-drag-start', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (!key) return;
    const win = panelWindows.get(key);
    if (!win || win.isDestroyed()) return;
    cancelTween(key);
    const cursor = screen.getCursorScreenPoint();
    const pos    = win.getPosition();
    panelDragOffsets.set(key, { dx: cursor.x - pos[0], dy: cursor.y - pos[1] });
    bringPanelToFront(key, true);
    showDragShield('panel', key);
  });

  ipcMain.on('panel-drag-move', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (!key) return;
    dragMove.panel(key);
  });

  ipcMain.on('panel-drag-end', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (!key) return;
    doPanelDragMove(key); // land on the release point (moves are frame-throttled)
    panelDragOffsets.set(key, null);
    clampToDisplay(key);
    hideDragShield();
  });

  ipcMain.on('panel-resize-start', (event, offset) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (!key) return;
    startResize(key, offset);
    showDragShield('resize', key);
  });

  ipcMain.on('panel-resize-move', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (key) dragMove.resize(key);
  });

  ipcMain.on('panel-resize-end', (event) => {
    const key = webContentsIdToKey.get(event.sender.id);
    if (!key) return;
    endResize(key);
    hideDragShield();
  });

  ipcMain.on('addressbar-navigate', (event, raw) => {
    if (!addressBarWindow || addressBarWindow.isDestroyed()) return;
    if (event.sender !== addressBarWindow.webContents) return;
    let url = (raw || '').trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      url = /^[^\s]+\.[^\s]+$/.test(url) ? 'https://' + url : buildSearchUrl(url);
    }
    if (isDdgSearchUrl(url)) {
      try {
        const p = new URL(url);
        if (p.searchParams.get('kp') !== '1') { p.searchParams.set('kp', '1'); url = p.toString(); }
      } catch {}
    }
    if (!isPassesPolicy(url)) { console.log(`[kiosk] addressbar blocked: ${url}`); return; }
    const targetView = panelViews[addressBarKey];
    if (!targetView || targetView.webContents.isDestroyed()) return;
    targetView.webContents.loadURL(url).catch(() => {});
    notePanelActivity(addressBarKey, 'click');
    const targetWin = panelWindows.get(addressBarKey);
    if (targetWin && !targetWin.isDestroyed()) { targetWin.focus(); targetView.webContents.focus(); }
  });

  ipcMain.on('addressbar-focus', (event) => {
    if (!addressBarWindow || addressBarWindow.isDestroyed()) return;
    if (event.sender !== addressBarWindow.webContents) return;
    const ps = panelStates.get(addressBarKey);
    if (ps) ps.lastTrustedInputAt = Date.now();
    notePanelActivity(addressBarKey, 'click');
  });

  ipcMain.on('addressbar-keydown', (event) => {
    if (!addressBarWindow || addressBarWindow.isDestroyed()) return;
    if (event.sender !== addressBarWindow.webContents) return;
    const ps = panelStates.get(addressBarKey);
    if (ps) ps.lastTrustedInputAt = Date.now();
    notePanelActivity(addressBarKey, 'keydown');
  });

  ipcMain.on('addressbar-escape', (event) => {
    if (!addressBarWindow || addressBarWindow.isDestroyed()) return;
    if (event.sender !== addressBarWindow.webContents) return;
    pushAddressBarUrl(addressBarLiveUrl);
    const targetWin  = panelWindows.get(addressBarKey);
    const targetView = panelViews[addressBarKey];
    if (targetWin  && !targetWin.isDestroyed())              targetWin.focus();
    if (targetView && !targetView.webContents.isDestroyed()) targetView.webContents.focus();
  });

  ipcMain.on('addressbar-drag-start', (event) => {
    if (!addressBarWindow || addressBarWindow.isDestroyed()) return;
    if (event.sender !== addressBarWindow.webContents) return;
    const cursor = screen.getCursorScreenPoint();
    const pos    = addressBarWindow.getPosition();
    addressBarDragOffset = { dx: cursor.x - pos[0], dy: cursor.y - pos[1] };
    addressBarDocked = false;
    showDragShield('addressbar');
  });

  ipcMain.on('addressbar-drag-move', (event) => {
    if (!addressBarWindow || addressBarWindow.isDestroyed()) return;
    if (event.sender !== addressBarWindow.webContents) return;
    dragMove.addressbar();
  });

  ipcMain.on('addressbar-drag-end', (event) => {
    if (!addressBarWindow || addressBarWindow.isDestroyed()) return;
    if (event.sender !== addressBarWindow.webContents) return;
    addressBarDragOffset = null;
    hideDragShield();
  });

  ipcMain.on('addressbar-dock', (event) => {
    if (!addressBarWindow || addressBarWindow.isDestroyed()) return;
    if (event.sender !== addressBarWindow.webContents) return;
    addressBarDocked = true;
    repositionAddressBar();
  });

  ipcMain.on('addressbar-resize', (event, neededW) => {
    if (!addressBarWindow || addressBarWindow.isDestroyed()) return;
    if (event.sender !== addressBarWindow.webContents) return;
    const { workArea } = screen.getDisplayMatching(addressBarWindow.getBounds());
    const pos          = addressBarWindow.getPosition();
    // Clamp: [AB_WIN_W, ADDRESSBAR_MAX_W] and must not overflow work area right edge.
    let w = Math.max(AB_WIN_W, Math.min(Math.round(neededW || AB_WIN_W), ADDRESSBAR_MAX_W));
    w = Math.min(w, workArea.x + workArea.width - pos[0]);
    w = Math.max(w, AB_WIN_W);
    if (w === addressBarCurrentW) return;
    addressBarCurrentW = w;
    // setBounds keeps position stable and resizes atomically; setSize alone on
    // Linux with resizable:false previously failed to apply.  pos is already
    // fetched above for the right-edge clamp.
    addressBarWindow.setBounds({ x: pos[0], y: pos[1], width: w, height: AB_WIN_H });
    if (USE_WINDOW_SHAPE && process.platform === 'linux') {
      addressBarWindow.setShape([{ x: 0, y: 0, width: w, height: AB_WIN_H }]);
    }
  });

  ipcMain.on('addressbar-shrink', (event) => {
    if (!addressBarWindow || addressBarWindow.isDestroyed()) return;
    if (event.sender !== addressBarWindow.webContents) return;
    if (addressBarCurrentW === AB_WIN_W) return;
    addressBarCurrentW = AB_WIN_W;
    const pos = addressBarWindow.getPosition();
    addressBarWindow.setBounds({ x: pos[0], y: pos[1], width: AB_WIN_W, height: AB_WIN_H });
    if (USE_WINDOW_SHAPE && process.platform === 'linux') {
      addressBarWindow.setShape([{ x: 0, y: 0, width: AB_WIN_W, height: AB_WIN_H }]);
    }
  });

  ipcMain.on('carbon-drag-start', (event) => {
    if (!carbonWindow || carbonWindow.isDestroyed()) return;
    if (event.sender !== carbonWindow.webContents) return;
    const cursor = screen.getCursorScreenPoint();
    const pos    = carbonWindow.getPosition();
    carbonDragOffset = { dx: cursor.x - pos[0], dy: cursor.y - pos[1] };
    carbonDocked = false;
    kioskLog('[kiosk-carbon] undocked on drag-start');
    showDragShield('carbon');
  });

  ipcMain.on('carbon-drag-move', (event) => {
    if (!carbonWindow || carbonWindow.isDestroyed()) return;
    if (event.sender !== carbonWindow.webContents) return;
    dragMove.carbon();
  });

  ipcMain.on('carbon-drag-end', (event) => {
    if (!carbonWindow || carbonWindow.isDestroyed()) return;
    if (event.sender !== carbonWindow.webContents) return;
    carbonDragOffset = null;
    hideDragShield();
  });

  ipcMain.on('carbon-drag-reset', (event) => {
    if (!carbonWindow || carbonWindow.isDestroyed()) return;
    if (event.sender !== carbonWindow.webContents) return;
    carbonDocked = true;
    kioskLog('[kiosk-carbon] re-docked on double-click');
    repositionCarbon();
  });
}

// ---- Startup ----------------------------------------------------------------

function startAllIdleRotation() {
  const order = ['hub', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
  order.forEach((key, i) => {
    panelStates.set(key, {
      mode:               'auto',
      inactivityTimer:    null,
      currentTerm:        null,  // term currently being searched or displayed (draw from shuffle-bag)
      searchCount:        0,     // total searches on this panel (for timing logs)
      lastSearchTime:     0,     // Date.now() of last doSearch call; 0 = never searched
      manualLayout:       false, // true once customer drags/resizes while active; suppresses auto-size animations
      dwellTimer:         null,  // next-search setTimeout
      scrollTimer:        null,  // scroll setInterval
      scrollPxS:          0,     // current page's random scroll speed (px/s), set by startScrolling
      rotationStartTimer: null,  // startup stagger setTimeout
      lastTrustedInputAt: 0,     // Date.now() of last panel-activity IPC; used to rescue first-click race
      loadTimer:          null,  // LOAD_TIMEOUT_MS watchdog set in doSearch, cleared on load end
      retryCount:         0,     // exponential-backoff attempt counter; reset on successful load
      firstSearchDone:    false, // set true after first search; skips global gap on first load
      searchLoadStartedAt: 0,    // Date.now() when doSearch called loadURL; used for timing log
      lastNavStatus:      0,     // HTTP response code from did-navigate; carried into did-finish-load log
      autoPhase:          'search', // 'search' | 'result' | 'parked' — current phase of the auto loop
      loadingSerp:        false,    // true while a saved SERP file:// URL is loading (did-finish-load guard)
      lastSerpFile:       null,     // file:// path of the last SERP shown (null for real DDG pages)
      serpBottomHandled:  false,    // true once onSearchBottom has run for this SERP load; reset by onSearchPageReady
      pendingQueuedPick:  null,     // { target, domHref, tier } set by nextAutoStep when going back to SERP
      recentResultUrls:   [],       // recently visited result URLs (max ~20); prevents re-visiting the same page
      queuedResults:      [],       // remaining result pages to visit from the current SERP
      resultsGoal:        0,        // how many results to visit from the current SERP (randomised per SERP)
      resultsVisited:     0,        // how many results visited so far from the current SERP
      resultAttempt:      0,        // incremented on each loadResult; guards against double-handling
      highlightTimer:     null,     // RESULT_HIGHLIGHT_MS timeout before navigating to a chosen result
      resultDwellTimer:   null,     // random dwell cap on result pages before returning to search
      pauseResumeTimer:   null,     // safety-net: resume from DDG pause when it expires
      carbonBytes:        0,        // running total of CDP encodedDataLength for current page load
      carbonGrams:        0,        // CO2 grams from last completed page load
      carbonLoading:      false,    // true while a main-frame navigation is in progress
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
  startDdgSummaryTimer();
  console.log(`[kiosk-auto] link-following enabled (policy: ${AUTO_LINK_POLICY}, probability: ${FOLLOW_RESULT_PROBABILITY})`);
}

// ---- Self-healing: health check, cache clear, view recycle, nightly restart ---

// Returns true if any part of the window overlaps a connected display.
// (It used to test the window's centre, but drag clamping only keeps
// MIN_VIS = 20 px of an overlay on screen, so a customer could park the clock
// or carbon circle mostly off-screen and the health check would destroy it and
// recreate it at home — which looked like it had vanished.)
function _windowOnDisplay(win) {
  if (!win || win.isDestroyed()) return false;
  const { x, y, width, height } = win.getBounds();
  return screen.getAllDisplays().some(d =>
    x < d.bounds.x + d.bounds.width  && x + width  > d.bounds.x &&
    y < d.bounds.y + d.bounds.height && y + height > d.bounds.y
  );
}

// Every 30 s: verify each panel window and overlay window exists and is
// visible.  Rebuild or re-show anything that fails, then re-assert
// alwaysOnTop and re-stack.  Uses showInactive() so the health check never
// steals focus from a customer.
function startHealthCheck() {
  setInterval(() => {
    if (!_lastWorkArea) return;
    let repairs = 0;

    // ---- Check the 5 panel windows -----------------------------------------
    const panelOrder = ['hub', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
    for (const key of panelOrder) {
      const win = panelWindows.get(key);
      if (!win || win.isDestroyed()) {
        kioskLog(`health: panel ${key} window destroyed — rebuilding`);
        rebuildPanelWindow(key);
        repairs++;
        continue;
      }
      if (win.isMinimized() || !win.isVisible()) {
        kioskLog(`health: panel ${key} window hidden/minimized — showing`);
        try { win.showInactive(); } catch (_) {}
        repairs++;
      }
      // If the view's renderer crashed or was destroyed, recycle it.
      const view = panelViews[key];
      if (!view || view.webContents.isDestroyed()) {
        kioskLog(`health: panel ${key} view destroyed — recycling`);
        recyclePanelView(key);
        repairs++;
      }
    }

    // ---- Check overlay windows ----------------------------------------------
    function checkOverlay(name, getWin, recreate, restore) {
      const win = getWin();
      if (!win || win.isDestroyed()) {
        kioskLog(`health: ${name} destroyed — recreating`);
        recreate();
        if (restore) restore();
        repairs++;
        return;
      }
      if (!win.isVisible()) {
        kioskLog(`health: ${name} hidden — showing`);
        try { win.showInactive(); } catch (_) {}
        repairs++;
      }
      if (!_windowOnDisplay(win)) {
        kioskLog(`health: ${name} off-display — recreating`);
        try { win.destroy(); } catch (_) {}
        recreate();
        if (restore) restore();
        repairs++;
      }
    }

    checkOverlay('clock',
      () => clockWindow,
      () => createClockWindow(_lastWorkArea),
      null
    );
    checkOverlay('forkknife',
      () => forkKnifeWindow,
      () => createForkKnifeWindow(_lastWorkArea),
      () => pushForkKnifeNavState()
    );
    checkOverlay('addressbar',
      () => addressBarWindow,
      () => createAddressBarWindow(_lastWorkArea),
      null
    );
    checkOverlay('carbon',
      () => carbonWindow,
      () => createCarbonWindow(_lastWorkArea),
      () => { repositionCarbon(); pushCarbonState(getActiveKey()); }
    );

    // Re-assert alwaysOnTop. Overlays first, then panels in corners-before-hub
    // order so hub is the last one touched and sits highest among alwaysOnTop peers.
    for (const w of [clockWindow, forkKnifeWindow, addressBarWindow, carbonWindow]) {
      if (w && !w.isDestroyed()) {
        try { w.setAlwaysOnTop(true); } catch (_) {}
      }
    }
    for (const key of ['topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'hub']) {
      const win = panelWindows.get(key);
      if (win && !win.isDestroyed()) {
        try { win.setAlwaysOnTop(true); } catch (_) {}
      }
    }

    restackAll();

    if (repairs > 0) {
      kioskLog(`health: repaired ${repairs} window(s)`);
    }
  }, 30_000);

  // Safety net: re-enforce hub-above-corners while nobody is using the kiosk.
  setInterval(() => {
    const allAuto = Array.from(panelStates.values()).every(s => s.mode === 'auto');
    if (allAuto) restackAll();
  }, 5_000);
}

// Every 30 min: clear the browser cache to prevent unbounded memory growth.
function startCacheClearTimer() {
  setInterval(() => {
    session.defaultSession.clearCache()
      .then(() => { kioskLog('cache cleared'); })
      .catch(e => { kioskLog(`cache clear failed: ${e.message}`); });
  }, 30 * 60 * 1000);
}

// Replace the BrowserView for one auto-mode panel to release renderer memory.
// Never touches active panels or all five at once.
function recyclePanelView(key) {
  const win = panelWindows.get(key);
  if (!win || win.isDestroyed()) return;
  const ps = panelStates.get(key);
  if (!ps || ps.mode !== 'auto') return;

  const beforeMetrics = app.getAppMetrics();
  kioskLog(`recycle ${key}: start processes=${beforeMetrics.length}`);

  stopBrowsingLoop(key);
  sharedOnScreenUrls.delete(key);

  const oldView = panelViews[key];
  if (oldView) {
    if (!oldView.webContents.isDestroyed()) {
      const oldWcId = oldView.webContents.id;
      // Detach CDP debugger so no more 'message' events fire from the old view.
      try { oldView.webContents.debugger.detach(); } catch (_) {}
      // Remove all webContents listeners — prevents stale callbacks from
      // acting on the new view's panelStates entries after the swap.
      oldView.webContents.removeAllListeners();
      // Destroy the renderer process; close() is graceful (Electron 22+),
      // destroy() is the hard fallback for older versions.
      try {
        if (typeof oldView.webContents.close === 'function') {
          oldView.webContents.close();
        } else {
          oldView.webContents.destroy();
        }
      } catch (_) {}
      webContentsIdToKey.delete(oldWcId);
    }
    try { win.removeBrowserView(oldView); } catch (_) {}
  }

  const M     = HARDWARE_MARGIN;
  const [winW, winH] = win.getContentSize();
  const panelW = winW - 2 * M;
  const panelH = winH - HANDLE_HEIGHT - 2 * M;

  const view = makePanelView();
  win.addBrowserView(view);
  view.setBounds({ x: M, y: HANDLE_HEIGHT + M, width: panelW, height: panelH });
  view.setAutoResize({ width: true, height: true });

  cancelBusyTimers(key);
  panelBusyActive.set(key, false);
  panelViews[key] = view;
  webContentsIdToKey.set(view.webContents.id, key);
  setupViewEventHandlers(key, win, view);

  // Ensure grip stays on top of the new panel view.
  const grip = gripViews[key];
  if (grip) {
    try { win.removeBrowserView(grip); win.addBrowserView(grip); } catch (_) {}
  }

  startBrowsingLoop(key);
  restackAll();
  kioskLog(`recycled panel view for ${key}`);

  // Log process count after a short delay to confirm the old renderer is gone.
  setTimeout(() => {
    try {
      const afterMetrics = app.getAppMetrics();
      kioskLog(`recycle ${key}: done processes=${afterMetrics.length} (was ${beforeMetrics.length})`);
    } catch (e) {
      kioskLog(`recycle ${key}: process count check failed: ${e.message}`);
    }
  }, 2000);
}

// Rebuild a destroyed (or missing) panel window at its home bounds.
// Called by the health check when panelWindows.get(key) is gone.
function rebuildPanelWindow(key) {
  const bounds = homeBounds.get(key);
  if (!bounds) {
    kioskLog(`health: rebuildPanelWindow ${key}: no home bounds, cannot rebuild`);
    return;
  }
  const M      = HARDWARE_MARGIN;
  const panelW = bounds.width  - 2 * M;
  const panelH = bounds.height - HANDLE_HEIGHT - 2 * M;

  // Clean up any stale state from before the crash.
  const oldWin = panelWindows.get(key);
  if (oldWin && !oldWin.isDestroyed()) {
    webContentsIdToKey.delete(oldWin.webContents.id);
    try { oldWin.destroy(); } catch (_) {}
  }
  panelWindows.delete(key);

  const oldView = panelViews[key];
  if (oldView && !oldView.webContents.isDestroyed()) {
    const oldWcId = oldView.webContents.id;
    try { oldView.webContents.debugger.detach(); } catch (_) {}
    oldView.webContents.removeAllListeners();
    try {
      if (typeof oldView.webContents.close === 'function') oldView.webContents.close();
      else oldView.webContents.destroy();
    } catch (_) {}
    webContentsIdToKey.delete(oldWcId);
  }
  delete panelViews[key];

  const oldGrip = gripViews[key];
  if (oldGrip && !oldGrip.webContents.isDestroyed()) {
    webContentsIdToKey.delete(oldGrip.webContents.id);
    oldGrip.webContents.removeAllListeners();
    try { oldGrip.webContents.destroy(); } catch (_) {}
  }
  delete gripViews[key];

  // Create the new panel window at home bounds.
  const win = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    frame:       false,
    resizable:   true,
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
  keepOnAllWorkspaces(win);
  win.on('focus', () => {
    if (!windowsCreatedAt || Date.now() - windowsCreatedAt < 5_000) return; // see createKioskWindow
    bringPanelToFront(key);
  });
  webContentsIdToKey.set(win.webContents.id, key);

  const minSize = minSizeFor(key);
  win.setMinimumSize(minSize.width, minSize.height);
  win.loadFile(path.join(__dirname, 'kiosk-handle.html'));

  win.webContents.on('dom-ready', () => {
    win.webContents.insertCSS(HANDLE_CURSOR_CSS, { cssOrigin: 'user' }).catch(() => {});
  });
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('panel-hardware', { key, margin: M });
    updateWindowShape(key);
    if (USE_WINDOW_SHAPE && process.platform === 'linux') updateWindowShape(key);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    const msg = `panel ${key} handle render-process-gone reason=${details.reason} exitCode=${details.exitCode}`;
    console.error(`[kiosk] ${msg}`);
    kioskLog(msg);
    setTimeout(() => {
      const w = panelWindows.get(key);
      if (!w || w !== win || w.isDestroyed()) return;
      w.webContents.once('did-finish-load', () => {
        w.webContents.send('panel-hardware', { key, margin: M });
        updateWindowShape(key);
      });
      w.loadFile(path.join(__dirname, 'kiosk-handle.html'));
    }, 500);
  });
  win.on('unresponsive', () => {
    kioskLog(`panel ${key} handle window unresponsive`);
  });

  // Panel content view.
  const view = makePanelView();
  win.addBrowserView(view);
  view.setBounds({ x: M, y: HANDLE_HEIGHT + M, width: panelW, height: panelH });
  view.setAutoResize({ width: true, height: true });
  const cachedPage = path.join(cacheDir, `${key}.html`);
  if (serpFileValid(cachedPage)) {
    view.webContents.loadFile(cachedPage);
  } else {
    if (fs.existsSync(cachedPage)) {
      fs.unlink(cachedPage, () => {});
      kioskLog(`[ddg] ${key} stale startup cache skipped (no DOCTYPE) — loading placeholder`);
    }
    view.webContents.loadURL(PLACEHOLDER_URL);
  }
  panelViews[key] = view;
  webContentsIdToKey.set(view.webContents.id, key);
  setupViewEventHandlers(key, win, view);

  // Resize grip.
  const grip = makeGripView();
  win.addBrowserView(grip);
  grip.webContents.loadFile(path.join(__dirname, 'kiosk-resize-grip.html'));
  grip.webContents.on('dom-ready', () => {
    grip.webContents.insertCSS(GRIP_CURSOR_CSS, { cssOrigin: 'user' }).catch(() => {});
  });
  gripViews[key] = grip;
  webContentsIdToKey.set(grip.webContents.id, key);
  positionGrip(key);

  grip.webContents.on('render-process-gone', (_e, details) => {
    const msg = `panel ${key} grip render-process-gone reason=${details.reason} exitCode=${details.exitCode}`;
    console.error(`[kiosk] ${msg}`);
    kioskLog(msg);
    setTimeout(() => {
      const g = gripViews[key];
      if (!g || g !== grip || g.webContents.isDestroyed()) return;
      g.webContents.loadFile(path.join(__dirname, 'kiosk-resize-grip.html'));
    }, 500);
  });

  win.on('resize', () => {
    positionGrip(key);
    updateWindowShape(key);
    if (key === 'hub') repositionAddressBar();
    if (key === 'hub') repositionCarbon();
  });

  let moveDebounce = null;
  win.on('move', () => {
    if (key === 'hub') repositionAddressBar();
    if (key === 'hub') repositionCarbon();
    if (ignoreNextMoves.get(key)) return;
    if (Date.now() - windowsCreatedAt < 5_000) {
      console.log(`[kiosk-auto] ${key} startup move ignored`);
      return;
    }
    clearTimeout(moveDebounce);
    moveDebounce = setTimeout(() => {
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
    // homeBounds intentionally NOT deleted — health check needs it to rebuild.
    delete panelViews[key];
    delete gripViews[key];
    resizeState.delete(key);
    tweenTimers.delete(key);
  });

  if (key === 'hub') repositionAddressBar();
  if (key === 'hub') repositionCarbon();

  // Resume the browsing loop on the new view.
  const ps = panelStates.get(key);
  if (ps) {
    ps.mode        = 'auto';
    ps.manualLayout = false;
    startBrowsingLoop(key);
  }

  restackAll();
  kioskLog(`health: rebuilt panel window ${key}`);
}

// Every 30 min: recycle auto-mode panel views one at a time (staggered by 1 min).
function startViewRecycleTimer() {
  const RECYCLE_INTERVAL_MS = 30 * 60 * 1000;
  const RECYCLE_STAGGER_MS  =       60 * 1000;
  const recycleOrder = ['hub', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
  setInterval(() => {
    let delay = 0;
    for (const key of recycleOrder) {
      const ps = panelStates.get(key);
      if (ps && ps.mode === 'auto') {
        setTimeout(() => recyclePanelView(key), delay);
        delay += RECYCLE_STAGGER_MS;
      }
    }
  }, RECYCLE_INTERVAL_MS);
}

// Nightly restart: exit cleanly at a configured hour so the supervisor
// relaunches with a fresh renderer stack.  Only fires when all panels are
// in auto mode (no customer is using a panel).
// Enabled by env KIOSK_NIGHTLY_RESTART_HOUR (0-23); disabled when unset.
function startNightlyRestartTimer() {
  const rawHour = process.env.KIOSK_NIGHTLY_RESTART_HOUR;
  if (rawHour === undefined || rawHour === '') return;
  const hour = parseInt(rawHour, 10);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return;

  let lastFiredDay = -1; // prevent firing twice in the same hour
  setInterval(() => {
    const now = new Date();
    if (now.getHours() !== hour) return;
    if (now.getDate() === lastFiredDay) return;
    const allAuto = Array.from(panelStates.values()).every(s => s.mode === 'auto');
    if (!allAuto) return;
    lastFiredDay = now.getDate();
    kioskLog(`nightly restart at hour ${hour} — exiting cleanly for supervisor restart`);
    // No quit flag: this is an intentional restart, not a shutdown.
    app.quit();
  }, 60_000);
}

// ---- Exports ----------------------------------------------------------------

module.exports = {
  createKioskWindow,
  computeClusterLayout,
  getKioskWindows: () => [...panelWindows.values()],
  areAllPanelsAuto: () => Array.from(panelStates.values()).every(s => s.mode === 'auto'),
};
