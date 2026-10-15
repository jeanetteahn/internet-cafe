// Cross-platform dev launcher for `npm start`: spawns the wallpaper
// (main.js) and kiosk cluster (kiosk-main.js) as two separate Electron
// processes, same as the Linux launch scripts do, but without hardcoding
// a Linux-only binary path — `require('electron')` resolves to whatever
// this OS's Electron binary actually is (works on the Mac dev workflow
// the README recommends, and on Linux too).
//
// The split into two processes exists because of a confirmed crash: a
// single process opening both the wallpaper window(s) and the kiosk
// cluster window crashed `xwinwrap` on Linux (see xwinwrap-launch.sh) —
// keeping dev/`npm start` structured the same way means what you test on
// the Mac matches what actually runs on the target machine.
const { spawn } = require('child_process');
const path = require('path');
const electronPath = require('electron');
const { isQuitRequested } = require('../process-pair');

const projectDir = path.join(__dirname, '..');

let wallpaperChild = null;
let kioskChild     = null;
let quitting       = false;

function launch(entry) {
  const child = spawn(electronPath, [entry], {
    cwd: projectDir,
    stdio: 'inherit',
  });
  return child;
}

function shutdown() {
  if (quitting) return;
  quitting = true;
  if (wallpaperChild && !wallpaperChild.killed) wallpaperChild.kill();
  if (kioskChild     && !kioskChild.killed)     kioskChild.kill();
  process.exit();
}

function startKiosk() {
  kioskChild = launch(path.join(projectDir, 'kiosk-main.js'));
  kioskChild.on('exit', (code) => {
    if (quitting) return;
    // If Ctrl+Alt+Q wrote the quit flag, honour it and shut everything down.
    if (isQuitRequested()) {
      shutdown();
      return;
    }
    // Otherwise restart the kiosk after a short delay (mirrors the Linux
    // supervisor loop in linux/xwinwrap-launch.sh).
    console.log(`[launch-both] kiosk exited (code=${code}) — restarting in 3 s`);
    setTimeout(() => {
      if (!quitting) startKiosk();
    }, 3000);
  });
}

wallpaperChild = launch(projectDir); // main.js (wallpaper) — package.json "main" resolves it
wallpaperChild.on('exit', shutdown);  // if the wallpaper dies, everything goes down

if (process.env.ENABLE_KIOSK !== '0') {
  startKiosk();
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
