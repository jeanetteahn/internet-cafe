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
  return spawn(electronPath, [entry], {
    cwd: projectDir,
    stdio: 'inherit',
  });
}

function shutdown() {
  if (quitting) return;
  quitting = true;
  if (wallpaperChild && !wallpaperChild.killed) wallpaperChild.kill();
  if (kioskChild     && !kioskChild.killed)     kioskChild.kill();
  process.exit();
}

function startWallpaper() {
  wallpaperChild = launch(projectDir); // main.js (wallpaper) — package.json "main" resolves it
  wallpaperChild.on('exit', (code) => {
    if (quitting) return;
    if (isQuitRequested()) {
      shutdown();
      return;
    }
    console.log(`[launch-both] wallpaper exited (code=${code}) — restarting in 3 s`);
    setTimeout(() => {
      if (!quitting) startWallpaper();
    }, 3000);
  });
}

function startKiosk() {
  kioskChild = launch(path.join(projectDir, 'kiosk-main.js'));
  kioskChild.on('exit', (code) => {
    if (quitting) return;
    if (isQuitRequested()) {
      shutdown();
      return;
    }
    console.log(`[launch-both] kiosk exited (code=${code}) — restarting in 3 s`);
    setTimeout(() => {
      if (!quitting) startKiosk();
    }, 3000);
  });
}

startWallpaper();

if (process.env.ENABLE_KIOSK !== '0') {
  // Delay kiosk start slightly to let the wallpaper window establish first,
  // mirroring the 15 s delay in the Linux launch scripts.
  setTimeout(() => {
    if (!quitting) startKiosk();
  }, 5000);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
