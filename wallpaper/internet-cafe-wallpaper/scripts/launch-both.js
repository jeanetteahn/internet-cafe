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

const projectDir = path.join(__dirname, '..');

const children = [];

function launch(entry) {
  const child = spawn(electronPath, [entry], {
    cwd: projectDir,
    stdio: 'inherit',
  });
  children.push(child);
  return child;
}

launch(projectDir); // main.js (wallpaper) — package.json "main" resolves it
if (process.env.ENABLE_KIOSK !== '0') {
  launch(path.join(projectDir, 'kiosk-main.js'));
}

function shutdown() {
  children.forEach((child) => {
    if (!child.killed) child.kill();
  });
  process.exit();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
children.forEach((child) => child.on('exit', shutdown));
