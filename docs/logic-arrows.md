# Logic Arrows target

Fletcher emits a Steam Logic Arrows Level JSON wrapper with v5 binary payloads. Build into a workspace file first. To play it, copy that JSON under a fresh filename in `%APPDATA%\logic-arrows\save\maps`, then select it from the game's Maps menu.

## Layout

`input a bit at (0, 0)` fixes the button at that coordinate. Its holding tile occupies the cell immediately to the right. Vector input buttons run down the same column in least-significant-bit order, eight cells apart. Vector output lamps run to the right, also eight cells apart. Omitting `at` lets the compiler choose the coordinates.

```fletcher
place wall at (-4, 0) with { color = "blue", glyph = "A" }
place lamp at (5, 10) with { color = "green", bright = true }
place button at (12, 10) facing left
place logger at (11, 10)
```

Standalone tiles use the game's physical rules. Fixed tiles reserve their coordinates during routing. An overlap or unintended connection between manual and generated circuitry produces a diagnostic. The automatic router uses eastbound signal rails and downward branches. For a forced circuit, an anchor outside routable geometry produces an error with the routing reason. Automatic bindings can use a scripted driver at a free neighbor of the lamp.

Use `output enabled bit at (4, 8) with { forward = "down" } = value` to continue that output into a manually placed circuit. Each lane uses a forwarding lamp facing the given direction. The tile at the destination must be empty or part of the manual layout so the connection is explicit. Output lamps default to bright green. Use `with { color = "red", bright = false }` to set their fixed color and brightness. A native signal turns the lamp on and off.

Use `facing up`, `facing right`, `facing down`, or `facing left` on directional tiles. Use `flipped` for components that support mirroring. Component names include `arrow`, `blueArrow`, `iSplitter`, `lSplitter`, `tSplitter`, `not`, `and`, `xor`, `toggle`, `key`, `button`, `wall`, `lamp`, `forwardingLamp`, `music`, `message`, `logger`, and `interval`. Key tiles take a key ID. Walls take `color` and `glyph`. Lamps take `color` and `bright`. Music tiles take `instrument`, `octave`, and `note`. Messages take `text`.

## Ticks and backend boundaries

Use `circuit { output carry bit = a & b }` to require a physical circuit. Fletcher places a native AND, XOR, or NOT tile for the corresponding logic. OR can use a regular arrow that accepts either incoming signal. Ordinary, blue, diagonal, and splitter arrows connect the gates. `circuit` reports a build error if Fletcher cannot lower or route the expression.

Native logic carries sustained levels and one-tick events through physical hops. A blue arrow skips a cell in one tick. Fletcher synchronizes physical arrivals at native joins and aligns live lanes of a vector where they are sampled together. Use `--explain` to see each binding's backend, the reason for automatic fallback, and output hop counts.

Fletcher folds redundant logic, shares identical gates, and compares factored and unfactored layouts when factoring could affect gate sharing. The router tries several spacing profiles and favors the smallest rectangular footprint for the generated circuitry. It uses tile count to break ties. Single-use scalar lamps can sit beside their drivers, and automatic scripted outputs use the first available row. The router shortens straight runs with blue arrows, turns with diagonal arrows, and branches with blue L-splitters.

In hybrid maps, the standard layout establishes the script tap's sample tick. Smaller layouts must match that tick on every live lane. The router can move delay onto a shared wire after a join to shorten both incoming branches. It can fold a long scalar tap wire into nearby free cells without changing its hop count. Other visible outputs can arrive sooner. Use `--explain` for the generated coordinates and hop counts.

The map controller samples current native inputs and circuit taps in its game tick callback. Then it evaluates scripted bindings and commits register updates. A scripted Source drives the value published in the preceding tick, independently of the callback order within the current tick. The path from that Source to a lamp or native gate adds its own physical latency. For a hybrid path, allow both the bridge and route times before sampling a stable output.

On a sliced screen, the compiler groups buffered keyboard ports in sets of four when there is room. Four Key tiles feed a blue Arrow that serves as a native OR gate. The controller skips the four individual reads when the gate is idle. The gate and individual key signals arrive on the same host tick, so presses still reach the same logical tic. Ports outside a group use individual reads.

### Published script bindings

Read the previous host tick's shared frame so the observer sees the same value in either script callback order. The `p` member holds read-only snapshots of `publish` bindings by name. It can be absent before the first logical tick completes or when the host tick number skips. On a sliced screen, the controller republishes the last completed values until the next commit.

`publish host` entries share the same frame and refresh every host tick, even while the logical tick is suspended.

```javascript
const tick = world.getTick() - 1;
const frame = tick % 2 === 0 ? globalState.__fletcherEven : globalState.__fletcherOdd;
const notes = tick >= 0 && frame?.t === tick ? frame.p?.notes : undefined;
```

## Map files

`fletcher inspect map.json` decodes the main payload. Add `--preview` to decode the map-card payload. To use an editor-created Level wrapper and retain its metadata, supply it to `build` using `--template level.json`. The preview omits script bodies and uses a 64-by-36 window near the origin for larger maps. The main payload contains the full map.

The codec reads raw and zlib v5 payloads and preserves unknown payload bytes when round-tripping tiles. The format stores up to 65,535 occupied chunks of 16 by 16 cells. Tile coordinates run from −524,272 to 524,287 on either axis. A script or message payload can contain up to 65,535 UTF-8 bytes including any format prefix. The Steam Level loader allows 16 MiB for the body after the three-byte v5 header and checks the same limit after expansion. Fletcher checks the actual encoded layout and packed imports, with no separate tile count cap. A 76,803-tile probe loaded and powered a lamp in its final chunk in Logic Arrows 20261112.

The Steam preview reader allows 20 chunks and 1 MiB. Fletcher crops the preview and omits script bodies. If other tile payloads would exceed the preview limit, the map card keeps their tile icons and the full Level keeps their data.

REA verified these limits in the 20261112 Windows executable. Its Level and preview loaders call the v5 decoder at `0x1408F6030` with `0x1000000` and `0x100000` bytes, respectively. The preview loader also checks the 16-bit chunk count against 20.

When a Fletcher controller exceeds the per-tile limit, the compiler first moves packed lookup tables to nearby Script Blocks. If the controller still exceeds the limit, it places the code in additional blocks and assembles it once when the map runs. Function calls and register updates share the same controller across those blocks. Solid screens with `slice = true` can also spread a logical tick across several game ticks. The extra blocks are part of the Level payload.

## Game parity checks

After a Release build, run `node tests/game-parity.mjs` to generate five disposable maps in `artifacts/game-parity/`. Copy them into the local Maps folder and open each **Fletcher Parity** map at the fastest tick rate. The fixtures cover native half-adder pulses, vector alignment, a scripted counter, both directions of the hybrid bridge, and a controller split across multiple Script Blocks. In **Fletcher Parity Split**, enable Key mode, press **B**, and move the pointer over the map until the probe reports PASS. Reopen the Level to repeat the reset check.

The counter and hybrid fixtures replace their buttons with drive arrows during startup. This lets the probe send repeatable pulses through the same native toggles. The regular examples still use Directional buttons.

After a Debug build, run `node tests/logic-arrows-backend-bench.mjs` to generate `Fletcher XOR Arrows` and `Fletcher XOR Script` in `artifacts/backend-bench/`. Open each map at Unlimited tick speed. Each timing window reports 240 ticks and verifies 1,024 settled XOR outputs. The scripted map uses one Script Source per output, so the measurement includes callback dispatch and signal reads and writes through the host API.

Run `node tests/logic-arrows-active-backend-bench.mjs` for the comparison against one batched Script Block. It builds two 3,075-tile maps under `artifacts/active-backend-bench/` and verifies their signals with the simulator. Open each at Unlimited speed, enable Key mode, and press **B**. Both drive 512 XORs with the same changing input sequence and time 480 host ticks. They check 4,096 physical output samples in separate windows before and after timing. The scripted test includes two host reads and one host write per XOR, as it would when bridging to physical tiles.
