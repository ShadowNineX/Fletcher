# Built-in functions

[Language reference](../language.md)

## Time, input, and logging

| Call | Result or effect |
|---|---|
| `currentTick()` | Returns the game tick as an `int`. In a sliced logical tick it counts logical ticks from zero. In `host tick` and its functions it returns the host tick. |
| `hostTimeMillis()` | Returns the signed low 32 bits of wall-clock time in milliseconds. Subtract two readings as `int` values to find elapsed time across wraparound for intervals shorter than about 24 days. |
| `mouseX()`, `mouseY()` | Return the last pointer position in window coordinates normalized to 0–1024, or `-1` before the first event. Use them in logical script work. |
| `log(value, ...)` | Writes values to the game script log from a tick block, or to test output when a Fletcher test runs. |

Use [ports](maps.md#inputs) for keyboard and tile signals. See [sliced ticks](screens.md#slice-long-ticks) for when inputs, screen changes, and log entries become visible.

## File and shared data

| Call | Result |
|---|---|
| `readFile(path)` | Imports a file as `bytes` at build time using a compile-time path. |
| `readFileIfPresent(path)` | Imports a file or returns empty bytes when it is missing. |
| `sharedBytes(key)` | Snapshots a byte array that a game script publishes under a compile-time key. |
| `len(data)` | Returns the length of a `bytes` value as an `int`. |
| `sameFile(a, b)` | Returns a `bit` comparing byte handles by identity. |

See [binary data](data.md) for file roots, optional reads, and the shared snapshot protocol.

## Screen drawing

| Call | Result or effect |
|---|---|
| `pixel(x, y, on)` | Stages a pixel in the screen's foreground color or background. |
| `pixel(x, y, on, shade)` | Chooses a color on a palette screen. |
| `pixel(x, y, on, shade, index)` | Sets the color and a source palette index. |
| `pixelIndexAt(x, y)` | Returns a staged source index or `-1`. |
| `screenPalette(values)` | Sets 256 packed RGB entries for an RGB wall or lamp screen. |
| `preserveScreen()`, `preserveScreen(firstRow, rowCount)` | Starts the staged frame or selected rows from the last committed frame. |
| `captureScreen(committed)` | Returns a packed frame string. Pass true for the committed frame or false for the staged frame. |
| `revealScreen(start, end, rows, columnsPerOffset)` | Stages a wipe between captured frames. |

See [screens and frames](screens.md) for style requirements, coordinate types, and commit timing.

## Test assertions

| Call | Effect |
|---|---|
| `assert(condition)` or `assert(condition, message)` | Fails a test unless the `bit` condition is true. |
| `assertEqual(actual, expected)` or `assertEqual(actual, expected, message)` | Compares matching scalar values, arrays or structs with comparable members, or two byte sequences by content. |

Use a string for the optional message. See [testing Fletcher code](tooling.md#testing-fletcher-code).
