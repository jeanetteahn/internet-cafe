Internet Cafe — Wallpaper App: Project Overview

A one-page reference for what this app is, how it's built, and how it runs on the target machine. For full setup/troubleshooting detail, see wallpaper/README.md (much more exhaustive — this file is the short version to draft from or hand to someone else).

What it is

An always-on Electron application for internet cafe terminals running Linux Mint (Cinnamon). It sits on the desktop background and has three parts:

Video wallpaper — a looping background video (assets/loop.mp4) filling the whole screen.
Live weather overlay — temperature, condition, location, and clock, auto-refreshed every 15 minutes using IP-based geolocation (no permission prompt needed, since nobody may be at the keyboard).
5-panel kiosk browser cluster — one large center panel plus four smaller panels above/below/left/right, arranged in a cross shape and layered on top of the video. Each panel is a real, usable browser: left alone, it auto-searches a rotating list of topics; the moment a customer clicks or types into it, it becomes theirs to browse normally until they've been idle again for a while.
Architecture: two separate processes

This is the one architectural decision worth understanding before touching the code. The wallpaper and the kiosk cluster are two completely separate Electron processes, launched together but independent:

main.js — creates only the wallpaper window(s). Uses Electron's type: 'desktop' hint to try to sit on the desktop background layer.
kiosk-main.js — creates only the 5-panel browser cluster, as an ordinary focusable window layered on top.

They used to be one process. That broke on the target hardware: Cinnamon doesn't reliably honor the type: 'desktop' hint, so the app falls back to a tool called xwinwrap to force it onto the background layer. xwinwrap was built around single-window apps (mpv-style tools) — handing it a process that opened a second, differently-sized window (the kiosk cluster) reliably killed the whole thing silently. Splitting the kiosk cluster into its own process fixed that: xwinwrap now only ever wraps main.js, and kiosk-main.js runs alongside it, completely unwrapped.

Since they're separate OS processes, two small coordination pieces exist:

process-pair.js — each process writes a PID file to a shared temp directory on startup. The global keyboard shortcut Ctrl+Alt+Q (a hidden "quit everything" hatch, since the app can end up covering the whole screen) is only registerable by whichever process asks the OS first, so this lets that one process's handler kill the other one too.
linux/xwinwrap-launch.sh — the main launcher. Starts xwinwrap (wrapping main.js) first, waits 15 seconds for it to fully claim its window, then starts kiosk-main.js. That delay isn't cosmetic — starting both windows close together confused xwinwrap's window detection and reintroduced the crash even with the process split in place.
Repo layout
internet-cafe/
  README.md                        — repo-level overview
  wallpaper/
    README.md                      — full setup + troubleshooting notes
    PROJECT-OVERVIEW.md             — this file
    package.json
    main.js                        — wallpaper process entry point
    kiosk-main.js                  — kiosk cluster process entry point
    kiosk-browsers.js              — kiosk window + panel logic
    kiosk-preload.js               — detects clicks/typing inside a panel
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
How it runs on the target machine (Mint Cinnamon)

One-time setup:

cd ~/internet-cafe/wallpaper
npm install
bash linux/install-autostart.sh --xwinwrap   # launch at login
bash linux/install-desktop-launcher.sh        # optional: double-click icon to relaunch

Normal use — after any git pull, relaunch to pick up new code:

bash linux/relaunch.sh

or double-click the desktop/menu icon installed above. Either kills any running instance and starts fresh with whatever's currently in the folder.

Manual/dev launch:

cd ~/internet-cafe/wallpaper
bash linux/xwinwrap-launch.sh

On Mac (dev iteration): npm start runs both processes via scripts/launch-both.js. Everything works identically except the Linux desktop-layer placement itself — video, weather, and the browser wall's layout/rotation all behave the same, so most edits should happen here first since there's no transfer/round-trip involved.

Known issues already fixed (worth knowing if something regresses)
xwinwrap + two windows in one process → silent crash. Fixed by the process split described above.
xwinwrap InputOnly guard-window BadMatch crash on Mutter/Muffin compositors (Cinnamon's family) — xwinwrap itself needed a source patch (see wallpaper/README.md for the exact sed/rebuild steps).
Startup timing race — starting the kiosk process too soon after xwinwrap confused its window detection even post-split. Fixed with the 15-second stagger in xwinwrap-launch.sh.
Kiosk window silently garbage-collected — kiosk-main.js created the kiosk window but never kept a reference to it, so V8 destroyed it automatically a few seconds after launch with no error. The process stayed alive (its window-all-closed handler is a deliberate no-op), so ps aux looked completely normal while nothing was ever on screen. Fixed by keeping a module-level reference to the window in kiosk-browsers.js.
Open / in progress
Confirming fix #4 above is actually live on the NucBox5 test machine — the fixed kiosk-browsers.js/kiosk-main.js need to be committed to GitHub and pulled down before this can be verified end to end.
No address bar or browser chrome on kiosk panels yet — customers navigate only by clicking links within whatever page is loaded.
Idle panels make continuous background network requests (auto-search rotation) whenever the app is running, worth keeping in mind on a metered connection.
Not yet built (future scope, per repo-level README)

Session/time limits, browsing controls, and a login or payment screen are explicitly called out as future sibling modules once that scope is decided — not yet started.
