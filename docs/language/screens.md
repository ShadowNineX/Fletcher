# Screens and frames

[Language reference](../language.md)

`screen at (x, y) size (width, height)` reserves a display at a fixed map position. Coordinates for drawing start at `(0, 0)` at the screen's top left. Width and height describe logical pixels. Scale describes the tile footprint of each pixel, so a 32×24 solid screen at scale 4 uses 128×96 tiles.

## Choose a display style

| Style | Tiles per logical pixel | Use |
|---|---|---|
| `"lamp"`, the default | One lamp | Changes its signal to draw using the screen's fixed foreground. Configure `color` and `bright`. |
| `"solid"` | A square of walls at the selected positive `scale`, default 1 | Paints each pixel using the game's preset colors. |
| `"arrows"` | A fixed 4×4 tile circuit | Holds four lamp signals in native T flip-flops. The display sends a pulse when a channel changes. The last lamp updates three game ticks after the pulse. |
| `"rgb"` | A fixed 2×2 square of walls | Approximates an indexed RGB palette with mixtures of preset wall colors. |
| `"rgb-lamps"` | A fixed 3×3 cell | Approximates a palette with paired red, green, and blue lamps and a black center wall. |

The four palette styles accept `color`, `hold`, `slice`, and `sliceWork`. The foreground defaults to green. Choose a visible preset against the black background. A lamp screen accepts red, blue, yellow, green, orange, or purple and defaults to bright green. See the [target guide](../logic-arrows.md#ticks-and-backend-boundaries) for the physical color layouts and [Level limits](../logic-arrows.md#map-files) for maximum footprints.

## Draw pixels

Call `pixel(x, y, on)` from the logical tick or a drawing function it calls. The coordinates are screen-local integers. Fletcher clips writes outside the screen. A new staged frame starts with the background. On a palette screen, pass a fourth `color` argument for a per-pixel color.

```fletcher
map "Guide Pixel" {
    screen at (0, 0) size (8, 4) with { style = "solid", scale = 2 }

    tick {
        x := currentTick() % 8
        pixel(x, 1, true, color.Blue)
        pixel(x, 2, true, color.White)
    }
}
```

Build and open the map using the [getting-started steps](getting-started.md#build-a-physical-half-adder). The two pixels move horizontally as the game runs.

### Palette indices

On a palette screen, a fifth `int` argument to `pixel` records a source index from 0 to 255 for that pixel. Read it during the same staged frame with `pixelIndexAt(x, y)`. An out-of-bounds or unindexed position returns `-1`. Omitting the index, setting the pixel off, or passing an invalid index clears that pixel's index. Indices stay available across slices and reset when the next logical frame begins.

With `"rgb"` or `"rgb-lamps"`, call `screenPalette(values)` with a `[256]bits<24>` array of packed `0xRRGGBB` colors. Subsequent indexed draws use the palette for the current logical tick. Pass a regular `color` in the fourth argument for fallback. Captured frames retain the rendered color patterns.

## Keep or capture a frame

Use `hold = true` to keep the last presented frame when a tick has no in-bounds pixel calls. The next draw still starts from the background. A single `pixel(0, 0, false)` presents an empty frame when it is the only draw.

Call `preserveScreen()` to copy the last committed frame into the current staged frame before adding an overlay. Use `preserveScreen(firstRow, rowCount)` to copy only a range of rows. Fletcher clips that range to the screen and clears copied rows' transient source indices.

`captureScreen(true)` returns the last committed frame as a packed string. `captureScreen(false)` returns the current staged frame. To draw a wipe, pass two captures into `revealScreen(start, end, rows, columnsPerOffset)`. Each entry in the fixed `int` array `rows` controls how many rows of the end frame are visible from the top of its column group. The start frame moves down by that amount. Use enough groups to cover the screen width. The result commits at the end of the logical tick.

## Slice long ticks

With `slice = true`, the controller can suspend a logical tick at function calls and loop iterations and resume on a later host tick. The screen, logical registers, logs, and scripted outputs become visible on commit. The controller samples inputs and the pointer at the start of the logical tick. Buffered inputs keep pulses between samples. A discontinuity in the host tick number discards unfinished logical work and pending pulses.

`sliceWork` sets the checkpoint budget per host tick. Use 0 for automatic budgeting. Larger values can complete a logical tick in fewer host ticks and spend more time inside each callback. Native arrows keep propagating on host ticks. Use a [host tick](maps.md#publish-values-to-other-scripts) for logic that must run each game tick while drawing is suspended.

For a statically resolved call such as `frame = draw(frame)`, Fletcher can reuse the old local's storage when it is exclusively owned and independent of the other arguments and destinations. A return such as `return draw(frame)` can use the same optimization when the old local's lifetime ends there. Value semantics and the work checkpoints still apply.

For a larger project, see the [Raycaster example](../../examples/raycaster/main.flt). Its orange **M** button switches to manual view. With manual view and **Key mode** enabled, tap **W/S** to move and **A/D** to turn. Use the **P** button to toggle mouse-look.
