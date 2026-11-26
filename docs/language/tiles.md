# Manual tiles and placement macros

[Language reference](../language.md)

Use `place kind at (x, y)` inside a map to fix a tile at compile-time coordinates. Add `facing up`, `facing right`, `facing down`, or `facing left` to orient a tile. For components that mirror, add `flipped` to reverse the side output. Put constant tile options in a `with { ... }` block.

```fletcher
map "Manual Circuit" {
    place button at (0, 0) facing right
    place arrow at (1, 0) facing right
    place lamp at (2, 0) with { color = "green", bright = true }
    place wall at (0, -1) with { color = "blue", glyph = "A" }
}
```

Manual tiles reserve their positions and keep the game's physical behavior. Fletcher diagnoses overlaps and unintended connections to its generated circuitry. Use an [input tap](maps.md#inputs) to sample a manual tile or a [forwarding output](maps.md#outputs-and-wires) to send a generated signal into one.

## Tile names

Use the following source spellings. The choices match the compiler's tile catalog.

| Family | Component names |
|---|---|
| Basic routing | `arrow`, `blueArrow`, `diagonalArrow`, `iSplitter`, `lSplitter`, `tSplitter`, `blueISplitter`, `blueLSplitter`, `diagonalSplitter` |
| Signal generation and control | `source`, `blocker`, `delay`, `detector`, `pulseGenerator`, `randomizer`, `transmitter`, `interval` |
| Gates and storage | `not`, `and`, `xor`, `latch`, `toggle` |
| Input | `key`, `button` |
| Display and audio | `wall`, `lamp`, `forwardingLamp`, `music`, `message`, `logger` |
| Game script integration | `scriptSource`, `scriptBlock`, `target` |

Alternate identifier spellings include `diagonal`, `pulse`, `tFlipFlop`, `directionalButton`, `light`, `lightBulb`, `forwardingLight`, and `musicArrow`. The mirroring option applies to `lSplitter`, `blueLSplitter`, `diagonalArrow`, and `diagonalSplitter`.

## Tile options

| Kind | Options |
|---|---|
| `key` | `key` is an integer ID from 0 to 59, default 0. Use a [keyboard input](maps.md#inputs) when you want the compiler to look up a key by name. |
| `wall` | `color` accepts a preset name or ID from 0 to 7 and defaults to white. `glyph` accepts blank, one letter, or one digit, or an ID from 0 to 36. |
| `lamp`, `forwardingLamp` | `color` accepts a preset name or ID from 0 to 6 and defaults to white. `bright` defaults to false. |
| `music` | `instrument` is 0–255, `octave` is 0–15, and `note` is 0–11. Defaults are 0, 4, and 0 respectively. |
| `scriptSource`, `scriptBlock`, `target` | `code` is a string of game JavaScript. |
| `message` | `text` is the displayed string. |

Color IDs in order are white, red, blue, yellow, green, orange, purple, and black. Other tiles use their orientation and game-defined signal behavior. See the [Level limits](../logic-arrows.md#map-files) for the payload size allowed in a single tile.

## Placement macros

Use `macro` to declare a reusable layout and `expand` to place it. Its arguments are typed compile-time constants. Macros can place tiles or expand other macros. The body sees the constants and imports in its defining file. The arguments use the caller's scope. A macro with an uppercase name can be imported from another [package](packages.md).

```fletcher
macro XorWithLamp(x int, y int) {
    place xor at (x, y) facing right
    place lamp at (x + 1, y) with { color = "green", bright = true }
}

map "XOR Tiles" {
    expand XorWithLamp(4, 8)
    expand XorWithLamp(4, 12)
}
```

Expansion happens before routing. Use [`--emit-ir`](tooling.md#inspect-the-intermediate-representation) to see the resulting placements.
