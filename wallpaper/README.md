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

## Kiosk browsers (5-panel interactive cluster)

`kiosk-browsers.js` creates five real, usable browser panels arranged in a
cross/bracket cluster: one larger center panel, and four smaller panels
above/below/left/right of it. **This is a separate, ordinary, focusable
window from the wallpaper** — not embedded in it — because a true
wallpaper window (`main.js`, `type: 'desktop'`, `focusable: false`)
fundamentally cannot receive clicks or keyboard input; that's not a
limitation of this code, it's how window managers treat that layer. The
kiosk window is sized to exactly the cluster's bounding box and uses
`transparent: true` so the video wallpaper shows through its four corner
gaps (the cross shape doesn't fill its own bounding rectangle) — this
needs a compositor running on the guest, which Cinnamon has by default via
Muffin; on a non-compositing window manager the gaps would show solid
black instead, a cosmetic downgrade rather than a broken app. It only
appears on the primary display (`ENABLE_KIOSK_BROWSERS` in `main.js`).

**All 5 panels behave identically, and the behavior is idle vs. active,
not decorative vs. interactive:** left alone, each one auto-searches
through `SEARCH_TERMS` on its own staggered timer (`REFRESH_MS` between
jumps), hitting DuckDuckGo's plain HTML endpoint
(`html.duckduckgo.com/html/?q=...`) rather than Google or a JS-heavy
results page, since that endpoint tolerates repeated automated requests
noticeably better — though "tolerates better" isn't "immune," so don't
push `REFRESH_MS` much below a few minutes. The moment a customer clicks
or types into any panel (detected via `kiosk-preload.js`, attached
regardless of what page is loaded), that panel's rotation stops and it
becomes a normal browser for them — clicking search results navigates
like any real browser, since it's a genuine, isolated `BrowserView`, not a
simulation. After `INACTIVITY_TIMEOUT_MS` (2.5 minutes by default) with no
further clicks or typing in that panel, it automatically goes back to
auto-searching on its own, ready for the next customer.

Other things worth knowing:

- **Panel sizes are pixel-based**, not fractions of the screen —
  `PANEL_SIZES` in `kiosk-browsers.js` controls the cluster's dimensions
  directly, and the window is sized to match automatically.
- **No address bar or browser chrome yet** — panels show whatever page
  they're on with no navigation controls of their own; customers browse by
  clicking links within the page. Worth adding if that's a problem in
  practice.
- Since idle panels are now making network requests continuously
  whenever the app is running (not just during customer use), that's
  worth keeping in mind on a metered or unusual connection.

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

One practical note while testing the browser wall specifically: it's
useful to temporarily drop `SIDE_REFRESH_MS` in `browser-wall.js` to
something short (a few seconds) so you can see the rotation working
without waiting minutes — just remember to set it back to a
multi-minute value before leaving it running for real, since a short
interval is what risks getting rate-limited.

## Multi-monitor

`main.js` creates one desktop-layer window per connected display
(`screen.getAllDisplays()`), each independently loading `index.html`, so
every screen gets its own video + weather overlay. Only the primary
display gets the browser wall.
