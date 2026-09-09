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
`npm start` runs that local copy. `linux/xwinwrap-launch.sh` and
`linux/install-autostart.sh` both also reference that same local copy
(`node_modules/.bin/electron`) directly, rather than assuming a global
`electron` command is on your `PATH` — a plain `npm install` never puts
one there, so don't try to `apt install electron` or similar; it isn't
needed and isn't how this is meant to run.

Your video goes at `assets/loop.mp4` (the `<video>` tag in `index.html`
points there). It should appear immediately, behind your desktop icons,
and just stay there.

If you eventually want this running on a machine without Node/npm
installed at all — a real deployment rather than a dev/test setup —
`npm run build:linux` (via `electron-builder`, already configured in
`package.json`) bundles Electron and the app together into a single
self-contained AppImage. That file runs on its own; nothing needs
installing on the target machine beforehand.

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
works the same across GNOME, KDE, XFCE, etc. Edit that `.desktop` file's
`Exec=` line first if you want it to launch via the `xwinwrap` script
instead of Electron directly.

## Browser wall (5-panel search cluster)

`browser-wall.js` overlays five independent `BrowserView` panels on top of
the video, arranged in a cross/bracket cluster centered on screen: one
larger center panel, and four smaller panels above/below/left/right of it.
The video still shows through everywhere outside that cluster. It's only
attached to the primary display (`ENABLE_BROWSER_WALL` in `main.js`) —
attaching it per-monitor would multiply live search traffic for no real
benefit.

**The four side panels run live search queries**, cycling through
`SEARCH_TERMS` in `browser-wall.js` on staggered timers. They hit
DuckDuckGo's plain HTML endpoint (`html.duckduckgo.com/html/?q=...`)
rather than Google or a JS-heavy results page, since that endpoint
tolerates repeated automated requests noticeably better — though
"tolerates better" isn't "immune." Push `SIDE_REFRESH_MS` much below a few
minutes and expect CAPTCHAs or blocks eventually. The center panel rotates
through `MAIN_URLS` on a slower timer.

Since this now runs continuously rather than only while idle, that live
search traffic is also continuous for as long as the app is running —
worth keeping in mind if you're on a metered or unusual connection.

Other things worth knowing:

- **Panels are opaque, not blended.** `BrowserView` renders as a solid
  native layer, so these tiles fully cover the video where they sit — no
  CSS transparency across that boundary. The alternative is the
  `<webview>` tag instead of `BrowserView`, which lives in the DOM and can
  take CSS opacity, at some cost to isolation/performance.
- **Layout is fraction-based** — `LAYOUT_FRACTIONS` in `browser-wall.js`
  controls cluster size and how much bare video shows around it.
- **The panels don't need focus or clicks** to work, since navigation is
  driven entirely by the timers in `browser-wall.js`, not by anyone
  interacting with them — which fits a background wallpaper that
  generally shouldn't be grabbing input anyway.

## Multi-monitor

`main.js` creates one desktop-layer window per connected display
(`screen.getAllDisplays()`), each independently loading `index.html`, so
every screen gets its own video + weather overlay. Only the primary
display gets the browser wall.
