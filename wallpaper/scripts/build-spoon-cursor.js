#!/usr/bin/env node
// Standalone cursor builder — no Electron dependency.
// Prints the computed dimensions and the full CSS cursor rule with an embedded
// base64 data URI that can be pasted into index.html.
//
// Usage:  node scripts/build-spoon-cursor.js
//
// The sizing logic is intentionally identical to the module-init block in
// kiosk-browsers.js.  If you change one, change the other, then re-run this
// script and copy the output into index.html.
'use strict';
const fs   = require('fs');
const path = require('path');

const ASSETS  = path.join(__dirname, '..', 'assets', 'utensils');
const CLOCK_SIZE = 110;

// ---- Parse fork path x-extent -----------------------------------------------
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

// ---- Forkknife geometry ------------------------------------------------------
const fkRaw  = fs.readFileSync(path.join(ASSETS, 'forkknife.svg'), 'utf8');
const fkVbM  = fkRaw.match(/viewBox="([\d.\s]+)"/);
const fkVbP  = fkVbM ? fkVbM[1].trim().split(/\s+/) : ['0','0','61.72','21.86'];
const fkVbW  = parseFloat(fkVbP[2]);
const fkAllDs      = [...fkRaw.matchAll(/\sd="([^"]+)"/g)].map(m => m[1]);
const forkExtUnits = _pathXBounds(fkAllDs.slice(0, 2)).extent; // first 2 paths = fork group
const forkRendPx   = forkExtUnits * CLOCK_SIZE / fkVbW;        // ≈105 px

// ---- Spoon geometry ----------------------------------------------------------
const spoonRaw  = fs.readFileSync(path.join(ASSETS, 'spoon-cursor.svg'), 'utf8');
const spoonVbM  = spoonRaw.match(/viewBox="([\d.\s]+)"/);
const spoonVbP  = spoonVbM ? spoonVbM[1].trim().split(/\s+/) : ['0','0','37.78','37.77'];
const spoonVbW  = parseFloat(spoonVbP[2]);
const spoonVbH  = parseFloat(spoonVbP[3]);

const spoonDiag  = Math.sqrt(spoonVbW * spoonVbW + spoonVbH * spoonVbH);
const spoonScale = forkRendPx / spoonDiag;
const artW       = Math.round(spoonVbW * spoonScale);
const artH       = Math.round(spoonVbH * spoonScale);

// ---- Shadow ------------------------------------------------------------------
const SD = 9, DX = 0, DY = 4;
const SIGMA3   = Math.ceil(3 * SD);              // 27
const padLeft  = SIGMA3;                          // 27
const padTop   = Math.max(0, SIGMA3 - DY);       // 23
const padRight = SIGMA3;                          // 27
const padBot   = SIGMA3 + DY;                    // 31
const outerW   = artW + padLeft + padRight;
const outerH   = artH + padTop  + padBot;

if (outerW > 128 || outerH > 128) {
  console.warn(`WARNING: cursor ${outerW}×${outerH} exceeds 128 px — Chromium will ignore it`);
}

// ---- Hotspot -----------------------------------------------------------------
const hotX = Math.round(3.47 * spoonScale) + padLeft;
const hotY = Math.round(0.50 * spoonScale) + padTop;

// ---- Build SVG ---------------------------------------------------------------
const stripped = spoonRaw
  .replace(/<\?xml[^?]*\?>\n?/, '')
  .replace(/<defs>[\s\S]*?<\/defs>\n?/, '')
  .replace(/\s+id="[^"]+"/g, '')
  .replace(/\s+data-name="[^"]+"/g, '')
  .replace(/class="cls-1"/g, 'fill="#ea4b00"')
  .replace(/\n\s*\n/g, '\n')
  .trim();
const bodyM  = stripped.match(/^<svg[^>]*>([\s\S]*)<\/svg>$/);
const body   = bodyM ? bodyM[1].trim() : stripped;

const fRegX = `${-Math.ceil(padLeft / artW * 100)}%`;
const fRegY = `${-Math.ceil(padTop  / artH * 100)}%`;
const fRegW = `${Math.ceil(outerW / artW * 100) + 1}%`;
const fRegH = `${Math.ceil(outerH / artH * 100) + 1}%`;

const svg = [
  `<svg width="${outerW}" height="${outerH}" xmlns="http://www.w3.org/2000/svg">`,
  `<defs><filter id="s" x="${fRegX}" y="${fRegY}" width="${fRegW}" height="${fRegH}" color-interpolation-filters="sRGB">`,
  `<feDropShadow dx="${DX}" dy="${DY}" stdDeviation="${SD}" flood-color="#000" flood-opacity="0.42"/>`,
  `</filter></defs>`,
  `<svg x="${padLeft}" y="${padTop}" width="${artW}" height="${artH}" viewBox="0 0 ${spoonVbW} ${spoonVbH}" filter="url(#s)">`,
  body,
  `</svg>`,
  `</svg>`,
].join('');

const b64  = Buffer.from(svg).toString('base64');
const uri  = `data:image/svg+xml;base64,${b64}`;

// ---- Output ------------------------------------------------------------------
console.log(`fork rendered:  ${forkRendPx.toFixed(1)} px  (extent=${forkExtUnits.toFixed(2)} units × ${CLOCK_SIZE}/${fkVbW})`);
console.log(`spoon diagonal: ${(spoonDiag * spoonScale).toFixed(1)} px  (${spoonDiag.toFixed(2)} units × ${spoonScale.toFixed(4)})`);
console.log(`art size:       ${artW}×${artH} px`);
console.log(`outer size:     ${outerW}×${outerH} px  (pad L${padLeft}/T${padTop}/R${padRight}/B${padBot})`);
console.log(`hotspot:        (${hotX}, ${hotY})`);
console.log('');
console.log(`/* ${outerW}×${outerH} px (${artW}px art + shadow ${padLeft}/${padTop}/${padRight}/${padBot} L/T/R/B), hotspot (${hotX}, ${hotY}) */`);
console.log(`cursor: url('${uri}') ${hotX} ${hotY}, auto;`);
