# assets/utensils

UI icon SVGs for the kiosk panels. Sits alongside `assets/hardware/`
(the orange hinge and bracket pieces) and follows the same conventions:
no raster content, no text elements, fill color `#ea4b00`.

## Files

### spoon-cursor.svg
Custom mouse cursor for the kiosk process. Replaces the system arrow
cursor so the pointer matches the utensil aesthetic of the panels.

### forkknife.svg
Source file containing both utensil shapes as separate paths:
- **Top path** — fork (will be exported / split into `fork.svg`)
- **Bottom path** — knife (will be exported / split into `knife.svg`)

Once split:
- `fork.svg` — **forward** navigation button on each panel handle
- `knife.svg` — **back** navigation button on each panel handle

Both derived icons use the `#ea4b00` fill, matching `spoon-cursor.svg`
and complementing the `#e74e25` hardware pieces.
