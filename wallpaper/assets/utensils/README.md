# assets/utensils

UI icon SVGs for the kiosk. Sits alongside `assets/hardware/`
(the orange hinge and bracket pieces) and follows the same conventions:
no raster content, no text elements, fill color `#ea4b00`.

## Files

### spoon-cursor.svg
Custom mouse cursor for the kiosk process. Replaces the system arrow
cursor so the pointer matches the utensil aesthetic of the panels.

The final cursor is **126 × 128 px** — spoon art 110 × 110 px (`CLOCK_SIZE`)
plus shadow padding 6 / 4 / 10 / 14 px (left / top / right / bottom).
Hot spot: `16 4` (bowl tip at viewBox `(3.47, 0)` → 10 px at 110 px art,
then shifted by left/top padding).  A `feDropShadow` filter (dx=0, dy=4,
stdDeviation=5) is baked into the outer SVG wrapper at build time in
`kiosk-browsers.js` (`SPOON_SHADOW_PAD_*` block).

`wallpaper/index.html` (a separate Electron process) contains a hardcoded
base64 copy with the same hotspot; regenerate it from the
`SPOON_SHADOW_PAD_*` block in `kiosk-browsers.js` whenever `CLOCK_SIZE`
or shadow values change.

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
