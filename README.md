# Internet Cafe — Wallpaper App: Project Overview

A one-page reference for what this app is, how it's built, and how it runs
on the target machine. For full setup/troubleshooting detail, see
`wallpaper/README.md` (much more exhaustive — this file is the short
version to draft from or hand to someone else).

## What it is

An always-on Electron application for internet cafe terminals running
Linux Mint (Cinnamon). It sits on the desktop background and has three
parts:

1. **Video wallpaper** — a looping background video (`assets/loop.mp4`)
   filling the whole screen.
2. **Live weather overlay** — temperature, condition, location, and clock,
   auto-refreshed every 15 minutes using IP-based geolocation (no
   permission prompt needed, since nobody may be at the keyboard).
3. **5-panel kiosk browser cluster** -- one larger hub panel and four
   corner panels (topLeft, topRight, bottomLeft, bottomRight), arranged
   in an overlapping pinwheel and layered on top of the video. Each panel
   is a real, usable browser: left alone, it auto-searches a rotating list
   of kid-friendly topics; the moment a customer clicks, types, drags, or
   resizes a panel, it becomes theirs to browse normally until they've been
   idle again for a while.

## Architecture: two processes

This is the one architectural decision worth understanding before
touching the code. The wallpaper and the kiosk cluster are **two
completely separate Electron processes**, launched together but
independent:

- `main.js` — creates only the wallpaper window(s). Uses Electron's
  `type: 'desktop'` hint to try to sit on the desktop background layer.
- `kiosk-main.js` — creates only the 5-panel browser cluster, as an
  ordinary focusable window layered on top.

They used to be one process. That broke on the target hardware: Cinnamon
doesn't reliably honor the `type: 'desktop'` hint, so the app falls back
to a tool called `xwinwrap` to force it onto the background layer.
`xwinwrap` was built around single-window apps (`mpv`-style tools) —
handing it a process that opened a *second*, differently-sized window
(the kiosk cluster) reliably killed the whole thing silently. Splitting
the kiosk cluster into its own process fixed that: `xwinwrap` now only
ever wraps `main.js`, and `kiosk-main.js` runs alongside it, completely
unwrapped.

Since they're separate OS processes, two small coordination pieces exist:

- **`process-pair.js`** -- each process writes a PID file to a shared temp
  directory on startup. The global keyboard shortcut `Ctrl+Alt+Q` (a
  hidden "quit everything" hatch, since the app can end up covering the
  whole screen) is only registerable by whichever process asks the OS
  first, so this lets that one process's handler kill the other one too.
- **`linux/xwinwrap-launch.sh`** -- the main launcher. Starts `xwinwrap`
  (wrapping `main.js`) first, waits 15 seconds for it to fully claim its
  window, *then* starts `kiosk-main.js`. That delay isn't cosmetic --
  starting both windows close together confused `xwinwrap`'s window
  detection and reintroduced the crash even with the process split in
  place.

## How the kiosk panels work

**Five windows in a pinwheel.** `computeClusterLayout()` in
`kiosk-browsers.js` sizes each panel as a fraction of 88% x 82% of the
display work area and positions them in an overlapping arrangement around
the hub. Each panel's starting bounds are saved in the module-level
`homeBounds` Map on creation; the hub window is brought to the front with
`moveTop()` after all five are created.

**Three layers per panel.** Each `BrowserWindow` hosts, stacked in order:

- `kiosk-handle.html` + `kiosk-handle-preload.js` -- a 28 px frameless
  drag strip showing the page title and a Reset button. The strip is
  draggable via `-webkit-app-region: drag`; the button overrides that to
  `no-drag`. Clicking Reset calls `sendPanelHome()`, restoring both
  position and original size.
- A `BrowserView` loaded with `kiosk-preload.js` -- fills the remaining
  height below the handle. This is the panel's live web content.
- A `BrowserView` loaded with `kiosk-resize-grip.html` and
  `kiosk-resize-preload.js` -- an 18 x 18 px corner resize handle. Uses
  `setPointerCapture` so drags work even when the cursor leaves the grip;
  sends `panel-resize-start`, `panel-resize-move`, and `panel-resize-end`
  IPC to the main process.

**Auto mode vs. active mode.** Each panel's state is tracked with a `mode`
field:

- `auto` -- the panel cycles through DuckDuckGo search results, scrolling
  each page to the bottom, jumping back to the top, then loading the next
  search term. Any page-initiated navigation away from `duckduckgo.com` is
  blocked by a `will-navigate` guard.
- `active` -- a customer is using the panel. Triggered by any `isTrusted`
  input event (mousedown, click, keydown, wheel) forwarded from
  `kiosk-preload.js`, or by starting a drag or resize. Customers can
  follow links freely; a `did-navigate` guard redirects back to DuckDuckGo
  if a navigation lands outside `ALLOWED_DOMAINS`.

After `INACTIVITY_TIMEOUT_MS` (120 s) of no activity, the panel returns to
its home position and size and switches back to auto mode.

**Guardrails for anyone editing panel code:**

- Every `BrowserWindow` and `BrowserView` must stay referenced in the
  module-level Maps (`panelWindows`, `panelViews`, `gripViews`). V8
  silently destroys unreferenced `BrowserWindow` instances with no error
  -- see Known issue 4.
- All programmatic window moves must go through `setPanelBoundsIgnored()`
  to prevent the `move` event handler from treating the call as a customer
  drag.
- IPC from panel renderers is routed to the correct panel via
  `webContentsIdToKey`, a module-level Map from `webContents.id` to panel
  key, populated in `attachActivityHandling()`.

**Dev helpers:** `Ctrl+Alt+D` prints a paste-ready `defs` block for
`computeClusterLayout()` reflecting the current live window positions.
`KIOSK_DISPLAY=N` (0-based) places the cluster on a specific monitor.

## Repo layout

```
internet-cafe/
  README.md                        — repo-level overview
  wallpaper/
    README.md                      — full setup + troubleshooting notes
    PROJECT-OVERVIEW.md             — this file
    package.json
    main.js                        — wallpaper process entry point
    kiosk-main.js                  — kiosk cluster process entry point
    kiosk-browsers.js              — kiosk window + panel logic
    kiosk-preload.js               — detects trusted input events inside a panel; sends panel-activity IPC
    kiosk-handle.html              — 28 px drag strip (page title + Reset button) rendered into each panel
    kiosk-handle-preload.js        — exposes title updates and reset-position IPC to the handle
    kiosk-resize-grip.html         — 18 x 18 px corner resize handle rendered as a BrowserView overlay
    kiosk-resize-preload.js        — exposes pointer-drag IPC to the resize grip
    process-pair.js                — cross-process PID coordination
    preload.js                     — shared preload (currently unused, reserved)
    renderer.js                    — clock + weather overlay logic
    index.html                     — wallpaper window's HTML/CSS
    assets/
      loop.mp4                     — background video
      fonts/Apercu.otf
    scripts/
      launch-both.js               — cross-platform dev launcher (npm start)
    linux/
      xwinwrap-launch.sh           — main launcher (xwinwrap + kiosk)
      native-launch.sh             — non-xwinwrap launcher
      install-autostart.sh         — installs XDG autostart entry (login)
      install-desktop-launcher.sh  — installs a double-clickable relaunch icon
      relaunch.sh                  — kills + restarts using current code
      weather-wallpaper.desktop    — XDG desktop entry template
```

## How it runs on the target machine (Mint Cinnamon)

**One-time setup:**
```
cd ~/internet-cafe/wallpaper
npm install
bash linux/install-autostart.sh --xwinwrap   # launch at login
bash linux/install-desktop-launcher.sh        # optional: double-click icon to relaunch
```

**Normal use — after any `git pull`,** relaunch to pick up new code:
```
bash linux/relaunch.sh
```
or double-click the desktop/menu icon installed above. Either kills any
running instance and starts fresh with whatever's currently in the folder.

**Manual/dev launch:**
```
cd ~/internet-cafe/wallpaper
bash linux/xwinwrap-launch.sh
```

**On Mac (dev iteration):** `npm start` runs both processes via
`scripts/launch-both.js`. Everything works identically except the Linux
desktop-layer placement itself — video, weather, and the browser wall's
layout/rotation all behave the same, so most edits should happen here
first since there's no transfer/round-trip involved.

## Known issues already fixed (worth knowing if something regresses)

1. **xwinwrap + two windows in one process → silent crash.** Fixed by the
   process split described above.
2. **xwinwrap `InputOnly` guard-window `BadMatch` crash** on Mutter/Muffin
   compositors (Cinnamon's family) — `xwinwrap` itself needed a source
   patch (see `wallpaper/README.md` for the exact `sed`/rebuild steps).
3. **Startup timing race** — starting the kiosk process too soon after
   `xwinwrap` confused its window detection even post-split. Fixed with
   the 15-second stagger in `xwinwrap-launch.sh`.
4. **Kiosk window silently garbage-collected** -- `kiosk-main.js` created
   the kiosk window but never kept a reference to it, so V8 destroyed it
   automatically a few seconds after launch with no error. The process
   stayed alive (its `window-all-closed` handler is a deliberate no-op),
   so `ps aux` looked completely normal while nothing was ever on screen.
   Fixed by keeping all five windows in module-level Maps in
   `kiosk-browsers.js` (`panelWindows` and companion maps for their
   BrowserViews and grip views), with `kiosk-main.js` also holding the
   returned window array in `kioskWindows` as belt-and-suspenders.

## Open / in progress

- Confirming fix #4 above is actually live on the NucBox5 test machine —
  the fixed `kiosk-browsers.js`/`kiosk-main.js` need to be committed to
  GitHub and pulled down before this can be verified end to end.
- No address bar or browser chrome on kiosk panels yet — customers
  navigate only by clicking links within whatever page is loaded.
- Idle panels make continuous background network requests (auto-search
  rotation) whenever the app is running, worth keeping in mind on a
  metered connection.

## Not yet built (future scope, per repo-level README)

Session/time limits, browsing controls, and a login or payment screen are
explicitly called out as future sibling modules once that scope is
decided — not yet started.
