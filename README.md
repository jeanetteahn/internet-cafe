# Internet Cafe

The umbrella project for an internet cafe machine setup. Each feature lives
in its own subfolder so pieces can be added, tested, and run independently
as the scope fills in.

## Modules

- **`wallpaper/`** — always-on live desktop background: looping video, a
  live local weather overlay, and a 5-panel browser wall that auto-runs
  search queries. Runs on Linux Mint (or any Linux desktop). See
  `wallpaper/README.md` for setup, the desktop-layer window-manager
  caveats, and its own recommended dev workflow.

More modules (session/time limits, browsing controls, a login or payment
screen — whatever ends up in scope) get added here as sibling folders once
that scope is decided, rather than folded into `wallpaper/`.

## Repo layout

```
internet-cafe/
  wallpaper/     — the live desktop wallpaper (self-contained Electron app)
  README.md      — this file
```

Each module keeps its own `package.json` and can be run independently
(`cd wallpaper && npm install && npm start`) until there's a reason to
combine them into one app.
