# Maps, signals, and backends

[Language reference](../language.md)

A `map "Name" { ... }` block describes one Logic Arrows Level. It may contain ports, wires, registers, a screen, a logical tick, a host tick, and manual placements. Compile-time coordinates use `(x, y)` in game tiles. The [target guide](../logic-arrows.md#layout) explains how they constrain routing.

## Inputs

Use `input name bit` for one signal or `input name bits<N>` for a bus. Ordinary inputs generate buttons with holding tiles. A bus reads from top to bottom, starting with its least significant lane. Use `at (x, y)` to anchor the first lane. The default vertical lane pitch is eight tiles.

| Input option | What it does |
|---|---|
| `key = "W"` | Creates a Key tile for a `bit` port. With Key mode enabled, the game sends a pulse for that key. |
| `tap = true` | Samples a tile already placed at a fixed anchor. For a bus, place one tile per lane. |
| `tapPitch = 2` | Changes lane spacing for a vector tap. |
| `keys = "WASD"` | Places a physical group of two to four distinct keys around the anchor of a `bit` port. |
| `combine = "xor"` | Uses XOR for exactly two keys in a group. The default `"or"` uses a Blue Arrow as the collector. |
| `buffer = true` | On a sliced screen, keeps a positive pulse on an individual key, group, or one-bit tap until the next logical tick samples it. Multiple pulses share one sample. |
| `gateReads = true` | Uses a buffered OR group sampled by the script tick to skip matching reads while its physical collector is idle. |

Use one input source per port. A group needs a fixed anchor and uses either `keys` with compact letter or digit names such as `"AD"`, or space-separated names such as `"R Ctrl"`. Group signals arrive on the same host tick as individual key signals. Sliced tick interruptions clear pending pulses.

Key names include `A`–`Z`, top-row `0`–`9`, `F1`–`F12`, `Space`, `Enter`, `Tab`, `Shift`, `Ctrl`, `Alt`, `Backspace`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, and `ArrowRight`.

## Outputs and wires

`output name bit = expression` creates a lamp. A `bits<N>` output creates one lamp per lane, left to right from the least significant bit. Use `at (x, y)` to anchor the first lane.

| Output option | What it does |
|---|---|
| `color = "red"` | Sets the lamp color. The default is green. |
| `bright = false` | Sets lamp brightness. The default is true. |
| `pitch = 2` | Changes a vector output's horizontal spacing. The default is eight tiles. |
| `forward = "down"` | Uses forwarding lamps at a fixed output position. Directions are `up`, `right`, `down`, and `left`. |

Horizontal forwarding for a multi-lane bus needs at least two tiles of pitch. A forwarding destination must be free or be one of your manual tiles. Use `wire name Type = expression` to share a binding between other expressions and ticks. Wires can be referenced before their declaration. The compiler diagnoses combinational cycles. Read a shared wire in your expressions and use an output just to deliver its signal.

## Choose a backend

| Form | Behavior |
|---|---|
| Ordinary `wire` or `output` | Asks Fletcher to try physical lowering and routing, with script fallback when available. |
| `circuit { ... }` | Requires physical logic for each enclosed wire or output. A failure yields a lowering or routing diagnostic. |
| `script { ... }` | Runs the enclosed wire and output expressions in generated JavaScript. |
| `backend circuit` | Uses physical logic by default in the file and requires native lowering for functions declared there and their callers. |
| `backend script` | Uses script by default for ordinary map bindings in the file. |

A file backend directive goes after imports. An explicit backend block can choose how to emit its bindings. Functions marked native by their file still require circuit lowering. To use the result of such a function in a tick, call it in a circuit wire and sample that wire from the tick.

Native bindings produce `bit` or `bits<N>` signals. They can lower live Boolean logic, bitwise operators, addition and subtraction, equality, and constant shifts. Native functions can use local values, arrays, structs, compile-time-sized ranges, supported branches, and indices proven to fit. For a conditional driven by a live signal, assign a result in the branches or return a value from both. A single indexed assignment to a local array or bit vector can emit gates. Dynamic interface dispatch, screen operations, and live multiplication or division require scripts. Use `--explain` to see which bindings used arrows and where fallback occurred.

The [getting-started mixed map](getting-started.md#connect-arrows-scripts-and-manual-tiles) uses a native wire as a script input, then feeds a script wire into a physical circuit. Read [target timing](../logic-arrows.md#ticks-and-backend-boundaries) when you need to account for propagation and callback order.

## Registers and ticks

`register name Type = constant` creates storage for scalars, arrays, structs, or interface values. In `tick { ... }`, use `next name = value` to stage a whole register update. All reads in the block see the value at the start of the tick. Each `next` captures its value when it executes. The last executed update wins, and an unwritten register keeps its value. To update a field, copy the register to a local, modify the local, and stage it with `next`.

`tick { ... }` runs as script. It samples its map inputs and native wires, evaluates the logical work, and commits its staged outputs and state. A [sliced screen](screens.md#slice-long-ticks) can spread that work across game ticks. Physical arrows continue to propagate each game tick.

Use `currentTick()` for the current tick number, `hostTimeMillis()` for wall-clock milliseconds, and `log(...)` from a tick block to log values. See [built-ins](builtins.md#time-input-and-logging) for units and context.

## Publish values to other scripts

`publish name Type = expression` shares a bit, signal vector, or fixed array of signals. It makes no lamp. It evaluates as a script binding and publishes a read-only snapshot when the logical tick commits. A hand-written script reads the previous host tick's shared frame. The controller republishes its last logical result while a new logical tick is suspended. See the [script frame reader](../logic-arrows.md#published-script-bindings) for the JavaScript lookup.

On a sliced palette screen, `host tick { ... }` runs after each logical slice and completes in the same game callback. It reads committed registers and can stage its own updates. Give each register a single writer block. The logical tick retains its starting register snapshot even if the host block changes a register while it is suspended.

`publish host name Type = expression` samples at the start of the host block and updates every host tick. Host work reads map state through registers. Host publications are available to script tiles. Screen and pointer operations belong to logical ticks.

## Manual layouts

Use `place` and `expand` for fixed tiles and reusable layouts. See the [tile and macro reference](tiles.md) for their syntax and options.
