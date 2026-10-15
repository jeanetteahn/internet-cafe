# assets/utensils

UI icon SVGs for the kiosk. Sits alongside `assets/hardware/`
(the orange hinge and bracket pieces) and follows the same conventions:
no raster content, no text elements, fill color `#ea4b00`.

## Files

### spoon-cursor.svg
Custom mouse cursor for the kiosk process. Replaces the system arrow
cursor so the pointer matches the utensil aesthetic of the panels.

The final cursor is **128 × 128 px** — spoon art 74 × 74 px plus shadow
padding 27 / 23 / 27 / 31 px (left / top / right / bottom).
Hot spot: `34 24` (bowl tip at viewBox `(3.47, 0.50)`, scaled and shifted
by padding).

**Sizing logic:** the art size is derived at startup from `forkknife.svg`
so the spoon matches the fork/knife nav buttons visually.
1. Extract the x-extent of the fork paths (first two `<path>` elements in
   `forkknife.svg`) using a path-token parser → ≈ 58.93 SVG units.
2. Scale to pixels: `forkExtent × CLOCK_SIZE / forkViewBoxW` ≈ 105 px.
3. Compute the spoon viewBox diagonal
   `√(37.78² + 37.77²)` ≈ 53.42 units.
4. Uniform scale: `spoonScale = forkRenderedPx / spoonDiag` ≈ 1.966×.
5. Art size: `round(37.78 × scale)` = 74 px (square, since viewBox is square).

**Shadow** matches the fork/knife overlay: `feDropShadow` dx=0, dy=4,
stdDeviation=9, opacity=0.42.  At 3σ = 27 px the outer cursor lands
exactly on the 128-px Chromium cursor-size limit.

The cursor SVG is built in `kiosk-browsers.js` (the `_pathXBounds` /
`SPOON_SHADOW_PAD_*` block that follows the forkknife constants).
`wallpaper/index.html` (a separate Electron process) contains a hardcoded
base64 copy; regenerate it by running:

```
node scripts/build-spoon-cursor.js
```

### forkknife.svg
Combined fork-and-knife graphic used as the standalone navigation
control (`kiosk-forkknife.html`):
- **Top half** — fork shape → Forward button
- **Bottom half** — knife shape → Back button

The control is a separate always-on-top transparent window managed by
`kiosk-browsers.js` (`createForkKnifeWindow`). It tracks whichever
panel was most recently active and shows that panel's back/forward
state. Rendered width equals `CLOCK_SIZE` (110 px); height (~39 px) is
derived from the `0 0 61.72 21.86` viewBox aspect ratio at startup.
