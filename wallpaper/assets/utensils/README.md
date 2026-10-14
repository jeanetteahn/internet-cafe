# assets/utensils

UI icon SVGs for the kiosk. Sits alongside `assets/hardware/`
(the orange hinge and bracket pieces) and follows the same conventions:
no raster content, no text elements, fill color `#ea4b00`.

## Files

### spoon-cursor.svg
Custom mouse cursor for the kiosk process. Replaces the system arrow
cursor so the pointer matches the utensil aesthetic of the panels.
Hot spot: `10 0` (spoon bowl tip at approximately `(3.47, 0)` in the
`0 0 37.78 37.77` viewBox, rendered at 110 × 110 px — matches `CLOCK_SIZE`
in `kiosk-browsers.js`). Also referenced in `wallpaper/index.html`.

### forkknife.svg
Combined fork-and-knife graphic used as the standalone navigation
control (`kiosk-forkknife.html`):
- **Top half** — fork shape → Forward button
- **Bottom half** — knife shape → Back button

The control is a separate always-on-top transparent window managed by
`kiosk-browsers.js` (`createForkKnifeWindow`). It tracks whichever
panel was most recently active and shows that panel's back/forward
state.
