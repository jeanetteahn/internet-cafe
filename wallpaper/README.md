# Weather Wallpaper (Electron)

An always-on live desktop background: looping video, a live local weather
overlay, and an optional 5-panel browser wall that auto-runs search
queries — all sitting on the desktop layer, behind your icons, never
stealing focus or responding to input by disappearing (this is a
wallpaper, not a screensaver — it's visible continuously, not just when
the machine goes idle).

## The honest caveat, up front

There is no single "Linux desktop wallpaper API." What actually happens
depends heavily on your window manager and whether you're on X11 or
Wayland:

- **Lighter X11 window managers** (Openbox, XFCE, many i3/tiling setups)
  generally honor Electron's `type: 'desktop'` window hint out of the box
  — this is what `main.js` uses, and it's the first thing to try.
- **GNOME and KDE Plasma** manage their own desktop/icon layer more
  tightly and don't reliably let an arbitrary app claim the background,
  even with that hint set. If the window shows up on top of everything
  instead of behind your icons, this is why.
- **Wayland** (increasingly the default on GNOME/Fedora/Ubuntu) has no
  standard protocol letting an ordinary client claim the background layer
  at all. Only a couple of compositors (Sway, Hyprland) support a
  background-layer protocol (`wlr-layer-shell`), and Electron doesn't
  implement it. A from-scratch Electron wallpaper is realistically an X11
  (or XWayland-tolerant) thing today.

If the native approach doesn't sit correctly on your setup, use
`linux/xwinwrap-launch.sh` instead (below) — that's the trick most
existing Linux "live wallpaper" tools actually rely on.

## Running it

```bash
npm install
npm start
```

No separate Electron install is needed — `npm install` downloads the exact
Electron binary this project needs straight into `node_modules`, and
`npm start` runs it (via `scripts/launch-both.js`, which spawns the
wallpaper and the kiosk cluster as two separate processes — see "Kiosk
browsers" below for why). The Linux launch scripts
(`linux/xwinwrap-launch.sh`, `linux/native-launch.sh`,
`linux/install-autostart.sh`) reference that same local copy's real
binary directly (`node_modules/electron/dist/electron`) rather than
assuming a global `electron` command is on your `PATH` — a plain `npm
install` never puts one there, so don't try to `apt install electron` or
similar; it isn't needed and isn't how this is meant to run.

Your video goes at `assets/loop.mp4` (the `<video>` tag in `index.html`
points there). It should appear immediately, behind your desktop icons,
and just stay there.

**Emergency exit: `Ctrl+Alt+Q` always quits the app immediately**, no
matter what's on screen or which window (if any) has focus. This matters
because, especially via `xwinwrap`, it's possible for this app to end up
genuinely covering the entire screen with nothing else reachable —
keyboard shortcuts registered through Electron's `globalShortcut` API are
caught before any window gets them, so this works even then. Not
something a customer would stumble into by accident, but worth knowing
about while testing placement on a new machine, and worth reconsidering
(or changing the combo) before this goes into real unattended production
use, if a "hidden exit" isn't something you want customers to ever be
able to find.

If you eventually want this running on a machine without Node/npm
installed at all — a real deployment rather than a dev/test setup —
`npm run build:linux` (via `electron-builder`, already configured in
`package.json`) bundles Electron and the app together into a single
self-contained AppImage. That file runs on its own; nothing needs
installing on the target machine beforehand.

## Font

The weather overlay (temperature, condition, city, clock) uses Apercu,
loaded from `assets/fonts/Apercu.otf` via an `@font-face` rule in
`index.html`. It only applies to text this app directly controls — the
overlay text, not the browser wall's four search panels, since those load
actual DuckDuckGo pages (someone else's HTML/CSS) rather than content this
project renders itself. There's no way to force a font onto a separate
website's own page content.

## Location and weather

- Location comes from IP geolocation (`ip-api.com`), not the browser's
  `navigator.geolocation` — a background app has no user present to grant
  a location permission prompt.
- Weather comes from Open-Meteo (`api.open-meteo.com`), free and no API
  key needed. Refreshes every 15 minutes (`renderer.js`).

## Getting it to actually sit behind your icons

**Try first — native (`main.js` does this already):** `type: 'desktop'`,
`focusable: false`, and an always-on-top level of `'desktop'` (the lowest
level, not the highest — the opposite of what you'd want for something
meant to float on top). Just run `npm start` and see where it lands.

**If that doesn't work — `xwinwrap`:** run `bash linux/xwinwrap-launch.sh`.
It launches Electron wrapped by `xwinwrap`, a small X11 utility that
creates a placeholder window pinned to the desktop layer and reparents
your app's window into it. It isn't packaged in every distro's repos —
the script's comments have the build-from-source steps if `apt`/your
package manager doesn't have it. This is X11-only in practice; under
Wayland it depends on XWayland tolerance and isn't guaranteed.

**Autostart at login:** `bash linux/install-autostart.sh` installs an XDG
autostart entry (`~/.config/autostart/weather-wallpaper.desktop`), which
works the same across GNOME, KDE, XFCE, etc. Pass `--xwinwrap` to have it
launch through `xwinwrap-launch.sh` instead of Electron directly:

```bash
bash linux/install-autostart.sh --xwinwrap
```

**On Mint Cinnamon with X11** (confirmed via `grep EDITION
/etc/linuxmint/info` and `echo $XDG_SESSION_TYPE`): use the `--xwinwrap`
flag above. Cinnamon's compositor generally ignores the native `type:
'desktop'` hint, but X11 means `xwinwrap` itself is fully usable. Install
its build dependencies and `xdotool` first — see the comments at the top
of `linux/xwinwrap-launch.sh` for the exact `apt` packages and the
build-from-source steps.

**Known xwinwrap crash on Mutter/Muffin-family compositors (GNOME,
Cinnamon):** `xwinwrap -ov -fs ...` can fail with `X Error of failed
request: BadMatch (invalid parameter attributes)`. This happens because
these compositors run an invisible, full-screen `InputOnly` "guard
window" that xwinwrap's desktop-window detection can mistake for a real
window to reparent into — and creating a normal window as a child of an
`InputOnly` one is always a `BadMatch` per the X11 protocol, no exceptions.
`linux/xwinwrap-launch.sh` already omits `-fs` (redundant with the
explicit `-g` geometry it passes) since that combination is what tends to
trigger it, but if you still hit this crash, the real fix is patching
xwinwrap itself to skip `InputOnly` windows while searching:

```bash
cd ~/xwinwrap   # wherever you built it from source
sed -i 's/if (attrs.map_state != 0 && ((attrs.width == display_width/if (attrs.map_state != 0 \&\& attrs.class != InputOnly \&\& ((attrs.width == display_width/' xwinwrap.c
make && sudo make install
```

## Restarting after you change the code

Two ways to (re)launch, depending on whether the app is already running:

- **A double-clickable launcher** — run `bash linux/install-desktop-launcher.sh`
  once to add an icon to the Cinnamon menu (and your Desktop, if you have
  one). Clicking it kills any already-running instance and starts fresh
  with whatever code currently exists in the folder — so the flow after
  every `git pull` is just: pull, then click the icon. No terminal needed
  for routine updates once this is installed. (Nemo may treat a
  newly-placed Desktop icon as untrusted the first time — if double-clicking
  does nothing, right-click it once and choose "Allow Launching".)
- **Manually from a terminal** — `bash linux/relaunch.sh` does the same
  kill-then-relaunch, or `bash linux/xwinwrap-launch.sh` directly if you
  know nothing else is currently running.

Either way, `git pull` only updates the files on disk — it does not
restart whatever's already running. You always need one of the two
relaunch steps above afterward to actually see the new code, visuals, or
animations on screen. (`npm install` is also needed again, but only if the
update changed `package.json` — a new dependency or an Electron version
bump — not for ordinary code/asset changes.)

**Safety exit while testing:** `Ctrl+Alt+Q` always force-quits the app
immediately, regardless of what's on screen or what has focus — useful
since a placement/layering issue can otherwise leave the app genuinely
covering the entire display with nothing else reachable.

## Kiosk browsers (5-panel interactive cluster)

`kiosk-browsers.js` creates five independent, movable browser windows arranged
in a pinwheel cluster on the primary display: one larger hub panel and four
corner panels. **These are separate, ordinary, focusable windows from the
wallpaper** — not embedded in it — because a true wallpaper window (`main.js`,
`type: 'desktop'`, `focusable: false`) fundamentally cannot receive clicks or
keyboard input; that's not a limitation of this code, it's how window managers
treat that layer.

Each panel window is **opaque** (`backgroundColor: '#1a1a1a'`) rather than
transparent, so no compositor is required on the host. Each one has a 28 px
drag strip (`kiosk-handle.html`) across the top: customers can grab it to
reposition any panel anywhere on screen. An 18 × 18 px **resize grip**
(`kiosk-resize-grip.html`) sits in each panel's bottom-right corner: customers
can drag it to make a panel larger or smaller. A **Reset** button in the drag
strip snaps the panel back to its home position **and** restores its original
size. If `RETURN_HOME_WHEN_IDLE` is true (the default), panels also return home
(size and position) automatically when their inactivity timer expires. After
any drag, each panel is clamped so at least `MIN_VISIBLE_PX` (120 px by
default) of the strip remains horizontally visible and the strip stays fully on
screen vertically — so a customer can always grab it again.

**It's also a separate *process*, not just a separate window** —
`kiosk-main.js` is its own Electron entry point, launched alongside
`main.js` rather than from inside it. This isn't just tidiness: on a
Mint Cinnamon test machine (a NucBox5), running the kiosk window and the
wallpaper window out of one Electron process, then wrapping that whole
process with `xwinwrap` (see the Cinnamon section below), reliably killed
the entire process — silently, exit status 0 — the instant the kiosk
window was created alongside the wallpaper window. `xwinwrap` was built
around single-window apps like `mpv`; handing it a process that opens a
second, differently-sized top-level window right after the first isn't
something it tolerates. Splitting the kiosk cluster into its own process
(`kiosk-main.js`) sidesteps this: `xwinwrap` only ever wraps `main.js`
(wallpaper, one window), and the kiosk process launches normally,
unwrapped, alongside it — see `linux/xwinwrap-launch.sh` and
`linux/native-launch.sh`, which start both. `npm start` does the same via
`scripts/launch-both.js` for Mac/dev. Set `ENABLE_KIOSK=0` before any of
these to skip the kiosk process (handy for isolating wallpaper-only
issues, which is how this crash was originally tracked down). Since the
two are separate OS processes, the `Ctrl+Alt+Q` safety-quit (below) is
coordinated between them via small PID files (`process-pair.js`) so it
still quits both together.

**All 5 panels behave identically, and the behavior is idle vs. active,
not decorative vs. interactive.** Left alone, each panel cycles through
kid-friendly DuckDuckGo search results pages.  The moment a customer
clicks, types, drags, or resizes a panel, it stops and becomes their
browser until they've been idle for `INACTIVITY_TIMEOUT_MS` (90 s by
default), at which point auto mode resumes.

**Auto mode — search-only loop** (`kiosk-browsers.js` — `startBrowsingLoop`):

Auto mode shows DuckDuckGo HTML search result pages and **nothing else**.
Panels never navigate to individual result links.

1. `doSearch` navigates the panel to `buildSearchUrl(term)` — DuckDuckGo's
   plain HTML endpoint with `&kp=1` (strict SafeSearch).
2. Once loaded (`onSearchPageReady`), the panel auto-scrolls the page via
   `window.scrollBy` (no wheel events fired — cannot trigger the customer-
   activity detector).
3. When scrolling reaches the page bottom, the panel instantly jumps back
   to the top (`window.scrollTo(0, 0)`) and loads the next topic in
   `SEARCH_TERMS` after a `BOTTOM_HOLD_MS` pause.  `SEARCH_INTERVAL_MS`
   (45 s) is a safety-net ceiling for pages that never reach the bottom
   due to dynamic loading.  Repeat indefinitely.

**Navigation guard in auto mode** (`will-navigate`): any page-initiated
navigation whose hostname is not `duckduckgo.com` or a subdomain is blocked
before it happens.  This covers meta-refresh, JavaScript `window.location`
assignments, and any other script the results page might trigger.
`webContents.loadURL()` calls from the main process (used by `doSearch`) are
exempt -- `will-navigate` does not fire for programmatic main-process loads.

A first-click race exists where `will-navigate` fires in the main process
before the renderer's `panel-activity` IPC arrives (async channel vs.
synchronous navigation dispatch).  The guard rescues this: if a trusted input
was recorded within `FIRST_CLICK_GRACE_MS` (1500 ms), the panel is treated as
already active.  This only affects genuine user clicks -- page-initiated
navigations with no recent input are still blocked.

**Customer (active) mode** -- `BROWSING_POLICY` controls what customers can
reach:

- `'open'` (default): any `http`/`https` URL is allowed **except** hosts in
  `BLOCKED_DOMAINS`.  Customers can click search results and browse freely.
- `'allowlist'`: only hostnames in `ALLOWED_DOMAINS` are permitted.

Non-`http(s)` schemes (`file:`, `javascript:`, `chrome:`, etc.) are always
blocked regardless of policy.

**SafeSearch enforcement**: any navigation to a DuckDuckGo search URL (whether
triggered by auto mode or a customer typing a query) must carry `kp=1`.  If
`kp=1` is absent or different, the navigation is cancelled and reloaded with
`kp=1` added.

**New-tab links** (`window.open`, `target="_blank"`): new windows are never
opened.  In active mode the requested URL is loaded in the same panel if it
passes the browsing policy; in auto mode the link is silently ignored.

**Back button**: the handle strip shows a Back button (left of Reset) that is
enabled whenever the panel's navigation history has an entry to go back to.
Clicking Back counts as customer activity (resets the idle timer) and uses
`webContents.navigationHistory.goBack()` (Electron 31 API).

**Activity detection:** `kiosk-preload.js` checks `event.isTrusted` before
sending `panel-activity` IPC, so programmatic scroll via `executeJavaScript`
can never look like customer activity.  Real customer clicks/typing still
stop the loop instantly.

**Tunables** (`kiosk-browsers.js` top section):

| Constant | Default | Effect |
|---|---|---|
| `SEARCH_INTERVAL_MS` | 45 s | Safety-net max time per results page; bottom detection usually fires first |
| `MIN_SEARCH_INTERVAL_MS` | 5 s | Minimum time between consecutive searches on one panel -- prevents hammering DDG when pages are very short |
| `BOTTOM_HOLD_MS` | 300 ms | Brief pause after jumping back to the page top before loading the next search |
| `SCROLL_STEP_PX` / `SCROLL_STEP_MS` | 80 px / 250 ms | Scroll speed -- lower `SCROLL_STEP_PX` or raise `SCROLL_STEP_MS` for slower scroll |
| `INACTIVITY_TIMEOUT_MS` | 90 s | Idle time before auto mode resumes after a customer |
| `INITIAL_LOAD_STAGGER_MS` | 1500 ms | Delay between each panel's first search at launch, so all five don't hit DDG simultaneously |
| `ACTIVE_SCALE` | 1.25 | How much larger an active panel grows (fraction of its home size) |
| `ACTIVE_ANIM_MS` | 220 ms | Duration of the enlarge/shrink tween |
| `BROWSING_POLICY` | `'open'` | `'open'` allows all http/https except `BLOCKED_DOMAINS`; `'allowlist'` restricts to `ALLOWED_DOMAINS` |
| `BLOCKED_DOMAINS` | (8 sites) | Hosts blocked in active `'open'` mode |
| `ALLOWED_DOMAINS` | (15 sites) | Hosts allowed in active `'allowlist'` mode |
| `FIRST_CLICK_GRACE_MS` | 1500 ms | Grace window for rescuing first-click IPC race in auto mode |
| `SEARCH_TERMS` | (10 topics) | Kid-friendly topics cycled during auto mode |

**Removed constants** (were present when auto mode did link-following; no
longer applicable):
`PAGE_DWELL_MIN_MS`, `PAGE_DWELL_MAX_MS`, `MAX_LINK_HOPS`, `POOL_MAX`,
`RECENT_URL_MAX`, `PRELOAD_NEXT_PAGE`, `PRELOAD_TIMEOUT_MS`,
`BLOCKED_KEYWORDS`.

**Known bug (fixed): kiosk windows silently garbage-collected — process
alive, nothing on screen.** After the process split above, `kiosk-main.js`
still called `createKioskWindow()` without keeping its return value:
`createKioskWindow();`. That return value (the `BrowserWindow` instance, or
now the array of five instances) was the *only* thing in the whole JS object
graph pointing at those windows — the `BrowserView` panels attached to each
stay alive separately via the idle-rotation timers and the `ipcMain` activity
listener, but nothing kept the window objects themselves referenced.
Electron's docs are explicit that a `BrowserWindow` with no surviving JS
reference gets destroyed automatically by V8's garbage collector, with no
error and no crash. Once that happened (empirically, anywhere from a couple
seconds to under a minute after launch — inconsistent, since GC timing isn't
deterministic), the kiosk windows vanished. It didn't take the process down
with it, though: `window-all-closed` in `kiosk-main.js` is a deliberate
no-op (the app is meant to run indefinitely), so the process just sat there
alive and idle forever afterward. That combination — confirmed via `ps aux`
that both processes were genuinely running, yet the kiosk cluster was never
visible on screen, on a NucBox5 running Mint Cinnamon — is what made this
one hard to pin down. Fixed by keeping all five windows in a module-level
`panelWindows` Map inside `kiosk-browsers.js` (entries removed only on each
window's own `'closed'` event), so the fix holds regardless of whether
callers remember to keep the return value too — `kiosk-main.js` also keeps
the returned array in `kioskWindows`, belt-and-suspenders. If a future
rewrite drops the module-level Map, this exact symptom — processes alive in
`ps aux`, nothing rendered, no errors anywhere — is what will come back.

**Known bug (fixed): grip.loadFile crash — one empty dark panel, four
missing.** `BrowserView` has no `loadFile` method; that method lives on its
`webContents`.  Calling `grip.loadFile(...)` instead of
`grip.webContents.loadFile(...)` in the `createKioskWindow()` loop threw
"grip.loadFile is not a function" on the very first panel (hub).  Because the
loop ran inside `app.whenReady()` without a `try/catch`, the error was
swallowed as an unhandled promise rejection — nothing printed to the console —
so hub got a `BrowserWindow` (hence one empty dark box on screen) but its grip
content never loaded, the loop never reached the other four panels, and
`startAllIdleRotation()` was never called.  Fixed by using
`grip.webContents.loadFile(...)`.  `kiosk-main.js` and `main.js` now also
install `uncaughtException` and `unhandledRejection` handlers at process
startup with a clear `[kiosk]` / `[wallpaper]` prefix, and both
`app.whenReady()` callbacks wrap their body in `try/catch` and chain a
`.catch()`, so future errors of this class are immediately visible in the
terminal rather than silently aborting mid-loop.

Other things worth knowing:

- **Panels are movable and resizable.** The 28 px drag strip
  (`kiosk-handle.html`) at the top lets customers reposition any panel freely.
  An 18 × 18 px resize grip (`kiosk-resize-grip.html`) in the bottom-right
  corner lets them resize it. The grip uses `setPointerCapture` so dragging
  works even if the cursor leaves the grip area. Resizing is driven entirely by
  this custom grip; native window-manager edge resizing is not relied on (it is
  unreliable for frameless windows on Cinnamon, and the `BrowserView` covers
  the window edges anyway). `resizable: true` is set on the window so that
  programmatic `setBounds()` calls are honoured on all platforms.
- **Minimum sizes.** Each panel's minimum is `Math.min(MIN_PANEL_WIDTH,
  homeWidth)` × `Math.min(MIN_PANEL_HEIGHT, homeHeight)` — capped at the home
  size so that panels narrower than `MIN_PANEL_WIDTH` on small screens (e.g.
  the bottomRight panel on 1366 × 768) can still be reset to their original
  dimensions.
- **Screen-edge limit while resizing.** The right and bottom edges of a panel
  cannot be dragged beyond the display's work area.
- **Reset restores size too.** The **Reset** button in the drag strip and the
  idle return-home both call `sendPanelHome()`, which sets the full home bounds
  (position + original size).
- **Off-screen clamping.** After any drag, the panel is clamped so at least
  `MIN_VISIBLE_PX` (120 px) of the strip stays horizontally on screen, and
  the strip remains fully visible vertically — so there's always something to
  grab. `HANDLE_HEIGHT`, `MIN_VISIBLE_PX`, `RETURN_HOME_WHEN_IDLE`,
  `GRIP_SIZE`, `MIN_PANEL_WIDTH`, and `MIN_PANEL_HEIGHT` are all tunables
  near the top of `kiosk-browsers.js`.
- **Compositor required on Linux.** Each panel window uses `transparent:
  true` so the orange hinge/frame overlay in `kiosk-handle.html` floats
  around the browser content in the transparent margin. On X11/Cinnamon,
  Chromium only requests an ARGB visual when
  `app.commandLine.appendSwitch('enable-transparent-visuals')` is set
  before `app.whenReady()` (done in `kiosk-main.js`). Without Cinnamon's
  Mutter-based compositor running, transparent windows render as a solid
  black rectangle instead of showing the wallpaper through the margin.
  If you need to run without a compositor, set `HARDWARE_MARGIN = 0` and
  `transparent: false` (add `backgroundColor: '#1a1a1a'`) in
  `kiosk-browsers.js` to revert to opaque panels.
- **Multi-display kiosk.** The cluster lands on the primary display by default.
  Set `KIOSK_DISPLAY=N` (a 0-based index into `screen.getAllDisplays()`) before
  launching to place it on a different monitor — e.g.
  `KIOSK_DISPLAY=1 npm start`.  Drag-clamping and resize limits use
  `screen.getDisplayMatching()` on each panel's current bounds, so a panel
  dragged between monitors clamps to whichever screen it occupies at the time.
- **Panel sizes scale with the display** — `computeClusterLayout()` in
  `kiosk-browsers.js` sizes each panel as a fraction of 88 % × 82 % of the
  work area, so the cluster fits any resolution with margin.
- **No address bar or browser chrome yet** — panels show whatever page
  they're on with no navigation controls of their own; customers browse by
  clicking links within the page. Worth adding if that's a problem in
  practice.
- **Guardrail: all windows and views must stay referenced.** Every
  `BrowserWindow` and `BrowserView` must remain in the module-level Maps
  (`panelWindows`, `panelViews`, `gripViews`).  V8 silently destroys any
  `BrowserWindow` with no surviving JS reference -- the process keeps
  running, nothing renders, no errors.  See the GC bug writeup below.
- **Guardrail: programmatic moves go through `setPanelBoundsIgnored(key, bounds)`.** 
  This arms a 400 ms flag checked by the `move` event handler so the
  programmatic call is not treated as a customer drag.
- **IPC routing via `webContentsIdToKey`.** All IPC from panel renderers
  (activity, reset, resize) is dispatched to the correct panel by a
  module-level `Map<webContents.id, key>` populated in
  `attachActivityHandling()`.  If views are ever rebuilt, this Map must be
  updated.
- **Dev helper: `Ctrl+Alt+D` layout dump.** Prints the current window
  positions as a paste-ready `defs` block for `computeClusterLayout()`.
  Useful after manually dragging panels to a preferred arrangement.
- **Network load.** Idle panels each run one DuckDuckGo search per
  scroll-through.  At the default scroll speed, a typical results page
  takes roughly 20-40 seconds to scroll, so expect on the order of 1-3
  requests per panel per minute while auto mode is running.  To reduce
  load, raise `SCROLL_STEP_MS` (slower scroll) or lower `SCROLL_STEP_PX`.

## Recommended workflow

1. **Iterate on the Mac first.** `npm start` runs fine on macOS for
   everything except the Linux-specific desktop-layer placement — video
   playback, weather fetching, and the browser wall's layout/rotation all
   work identically. This is where most edits should happen, since it's
   instant (no transfer, no Mint round-trip).
2. **Sync to Mint with git**, not by re-downloading a zip each time:
   ```bash
   # one-time, on whichever machine creates the remote (e.g. GitHub/GitLab):
   git remote add origin <your-repo-url>
   git push -u origin master

   # on the Mac, after making changes:
   git add -A && git commit -m "..." && git push

   # on Mint, to pick them up:
   git pull
   ```
3. **Validate window placement on Mint only.** Run `npm start` there and
   check whether it settles behind your icons. If not, try
   `bash linux/xwinwrap-launch.sh`. This is the one step that has to happen
   on real Linux hardware — there's no way to shortcut it from the Mac.
4. **Wire up autostart** (`bash linux/install-autostart.sh`) once placement
   is working, so it survives a reboot without manual steps.
5. **Package for real deployment last, not during dev.** `npm run
   build:linux` bundles Electron and the app into a single AppImage —
   worth doing once things are settled, not on every iteration.

## Multi-monitor

`main.js` creates one desktop-layer window per connected display
(`screen.getAllDisplays()`), each independently loading `index.html`, so
every screen gets its own video + weather overlay. The kiosk cluster
(`kiosk-main.js`) appears on the primary display by default; set
`KIOSK_DISPLAY=N` (0-based index) to place it on a different monitor instead.
