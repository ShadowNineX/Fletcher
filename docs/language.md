# Fletcher language

Fletcher compiles a `.flt` entry point into one Logic Arrows Level map. A standalone file can define its constants, types, and functions before its `map` block. Larger programs can share code across files and import local packages.

## Build and use

Install the .NET 11 SDK and put Java on your `PATH` for ANTLR parser generation. Run `dotnet --version` at the repository root to confirm that `global.json` selects an 11.0 SDK. The compiler, CLI, and C# tests share the `net11.0` target and use C# 15. [Microsoft .NET 11 SDK](https://dotnet.microsoft.com/en-us/download/dotnet/11.0)

Solution builds enforce IDE0028 and the collection expression rules in `.editorconfig`. Use `[]` for collection initialization and `with(...)` when construction needs a comparer, capacity, or seed sequence. [Microsoft IDE0028 documentation](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/style-rules/ide0028) · [C# collection expression arguments](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/operators/collection-expressions#collection-expression-arguments)

```powershell
dotnet build Fletcher.slnx
dotnet format style Fletcher.slnx --no-restore --verify-no-changes --severity info
dotnet run --project src/Fletcher.Cli -- check examples/half-adder.flt
dotnet run --project src/Fletcher.Cli -- build examples/hybrid.flt -o artifacts/hybrid.json --explain
dotnet run --project src/Fletcher.Cli -- inspect artifacts/hybrid.json
dotnet run --project src/Fletcher.Cli -- build examples/hello-screen/main.flt -o artifacts/hello-screen.json
dotnet run --project src/Fletcher.Cli -- build examples/raycaster/main.flt -o artifacts/raycaster.json
```

Run `node tests/smoke.mjs` after building to exercise the CLI, decode its output independently, simulate native timing, and run the generated JavaScript against a model of the game APIs. Add `--lab` to also check the existing Component Lab under your Logic Arrows saves.

## Inspecting the intermediate representation

`build` and `check` both accept `--emit-ir`. The flag writes the typed intermediate representation to `<source>.ir.json` beside the `.flt` file. Pass a path after the flag to name the dump explicitly.

```powershell
dotnet run --project src/Fletcher.Cli -- check examples/hybrid.flt --emit-ir artifacts/hybrid.before.ir.json
dotnet run --project src/Fletcher.Cli -- build examples/hybrid.flt -o artifacts/hybrid.json --emit-ir artifacts/hybrid.after.ir.json
git diff --no-index artifacts/hybrid.before.ir.json artifacts/hybrid.after.ir.json
```

The versioned JSON shows resolved types, operations, symbols, function bodies, and map declarations before backend selection. Recompiling identical source and inputs produces identical JSON. Imported binary data is represented by its byte length and SHA-256. The CLI can still write the IR if binding succeeds and target generation fails, so routing or script failures can be investigated from the same input the backends received.

## Testing Fletcher code

Put named `test` blocks in `*_test.flt` files. Tests can call functions in the same package, import other packages, and use `readFile()` for fixtures. Each test has its own local variables.

```fletcher
test "array elements keep their order" {
    values := [3]int{7, 2, 9}
    assert(values[0] < values[2])
    assertEqual(values, [3]int{7, 2, 9}, "original order")
}
```

Run `fletcher test` to discover tests from the current directory. Pass a directory to limit discovery, or a `.flt` file to run just its tests. `--filter` selects names containing the given text, ignoring case. Package and fixture paths can be set with `--package-root` and `--asset-root`.

```powershell
dotnet run --project src/Fletcher.Cli -- test examples/doom-engine
dotnet run --project src/Fletcher.Cli -- test examples/doom-engine/motion_test.flt --filter gravity
dotnet test --solution Fletcher.slnx
```

The Fletcher runner uses Node.js on `PATH` to run the same generated JavaScript used by the script backend. Assertions report the test and source location, and any failure gives a nonzero exit code. `assert` takes a `bit`. `assertEqual` compares matching scalar, array, or struct values, or two `bytes` values by content. Both accept an optional message. Use `log()` to print test values. Map APIs such as `pixel()` and `currentTick()` require a game session. Regular `build` and `check` skip neighboring `*_test.flt` files. The C# suite uses xUnit v3.

If the ANTLR build task cannot find its JAR, set `FletcherAntlrJar` to the full path of your local `antlr4-4.13.1-complete.jar` before building.

## Translating C routines

`transpile-c` emits a Fletcher library package called `cport`. Put the output in a package directory next to the Fletcher map entry point. This command uses the same compiler build and requires no separate C toolchain.

```powershell
dotnet run --project src/Fletcher.Cli -- transpile-c tests/fixtures/portable-c.c -o artifacts/c-example/cport/kernel.flt
```

Save the following as `artifacts/c-example/main.flt`. The map logs `5` each tick.

```fletcher
package main

import "cport"

map "Portable C" {
    tick {
        log(cport.C_shade(6, 8))
    }
}
```

```powershell
dotnet run --project src/Fletcher.Cli -- build artifacts/c-example/main.flt -o artifacts/c-example.json
```

The translator accepts self-contained routines with 32-bit `int` and `unsigned int`, `void` results, scalar locals, fixed-length local arrays, casts, direct calls, `if`/`else`, and `for (int i = 0; i < limit; i++)`. A loop limit must be an integer literal or a signed scalar that the loop leaves unchanged. C `int` maps to Fletcher `int` and `unsigned int` maps to `bits<32>`. Public functions gain a `C_` prefix and `static` functions stay private to the package. Use one output package directory per C translation unit.

Provide valid, preprocessed C or source without preprocessor directives. Pointers, globals, floating-point types, external calls, recursion, and general control flow such as `while` and `switch` are outside this subset. Unsupported constructs produce a diagnostic in the original file before the command writes any output. Generated routines use Fletcher's 32-bit integer types and two's-complement integer conversions. Fletcher checks constant arithmetic and array bounds in branches even when C would skip evaluating them at runtime.

## Packages

Files in a package directory use the same `package name` header and share top-level declarations. The entry package defines one `map`. A library package contains constants, types, functions, and methods. Use a capital letter to export a declaration, struct field, or method. Imports and their aliases are scoped to the file that declares them.

```fletcher
package main

import "bitmap"

map "Hello World" {
    screen at (0, 0) size (45, 7) with { style = "solid", color = "green" }
    tick {
        bitmap.DrawText(1, 1, "HELLO WORLD")
    }
}
```

The default import name comes from the imported `package` header. Use `import gfx "bitmap"` to choose another name or `import (...)` to group imports. The compiler resolves paths from the entry file's directory. Use `--package-root` to share libraries across entry directories, or `./name` to resolve a package relative to the importing file. Resolution uses local directories. Cycles and incompatible package headers are compile errors. An entry file without a `package` header keeps its standalone scope.

## Types and declarations

- `bit` is Boolean and uses `true` and `false`.
- `bits<N>` is an unsigned signal vector with 1–32 lanes. Arithmetic wraps to the width. Index 0 is the least significant bit. Unsuffixed integer values that fit can initialize a vector. `bits<4>(number)` explicitly takes the low four bits.
- `int` is signed 32-bit. Integer arithmetic wraps and division truncates toward zero. Shifts use the low five bits of an `int` shift count.
- `string` supports literals, concatenation, and equality in scripts. Tile configuration also accepts strings.
- `bytes` is an immutable sequence of file bytes. Indexing returns a `bits<8>` value and `len(data)` returns the number of bytes. The zero value is empty.
- `color` represents the game palette. Use `color.White`, `color.Red`, `color.Blue`, `color.Yellow`, `color.Green`, `color.Orange`, `color.Purple`, or `color.Black`. Its zero value is black.
- `[N]T` is a fixed-length array. An array literal such as `[3]bit{true, false}` uses the zero value for omitted entries.
- `type Name Type` defines a distinct type. `type Name = Type` defines an alias.

Assignments, return values, function arguments, ports, and generic instantiations are checked before either backend runs. Distinct types require an explicit conversion. An untyped literal or constant can adapt to a compatible type if its value fits. For example, `var count bits<4> = 7` is valid, while an existing `int` value needs `bits<4>(value)`.

Use `&` for bitwise AND, `|` for OR, `^` for XOR, and `~` for complement on `int` and `bits<N>`. Boolean `bit` also supports `&`, `|`, and `^`, with `!` for inversion.

Use `<<` and `>>` with an `int` shift count. The result keeps the left operand's type and width. Right shift sign-extends an `int` and zero-fills a `bits<N>` vector.

```fletcher
func toggleFlag(flags bits<8>, index int) bits<8> {
    return flags ^ (bits<8>(1) << index)
}

func highByte(word bits<16>) bits<8> {
    return bits<8>(word >> 8)
}
```

```fletcher
const Width = 4

type Combiner interface {
    Apply(a bit, b bit) bit
}

type Xor struct {}

func (x Xor) Apply(a bit, b bit) bit {
    return a ^ b
}

type Pair<T> struct {
    first T
    second T
}

func (p Pair<T>) First() T {
    return p.first
}

func combine<T extends Combiner>(op T, a bit, b bit) bit {
    return op.Apply(a, b)
}

map "XOR" {
    input a bit
    input b bit
    output lamp bit = combine(Xor{}, a, b)
}
```

Interfaces match method names and signatures implicitly. A variable of interface type can hold a compatible value and dispatch its methods in script code. A constrained generic call with a concrete receiver can specialize to native gates. Infer type arguments from function parameters or write them explicitly, as in `combine<Xor>(Xor{}, a, b)`. Generic bodies are checked as their type arguments are instantiated. Structs, arrays, and value receivers have value semantics. Functions may use a bare `return` with no results or declare one or more result types. Recursion is unsupported.

Declare multiple results with a parenthesized list of types. Return values in that order, and receive them in a short declaration or assignment with the same number of targets. Fletcher evaluates the call once before storing the results. Use `_` to discard a result. A function can forward another call's results with `return otherCall()` when the result types match.

```fletcher
func splitIndex(index int) (int, int) {
    return index >> 8, index & 255
}

test "split an index into a page and offset" {
    page, offset := splitIndex(300)
    assertEqual(page, 1)
    assertEqual(offset, 44)

    page, offset = splitIndex(600)
    assertEqual(page, 2)
    assertEqual(offset, 88)
}
```

## Reading files

Use `readFile(path)` with a compile-time string to import a binary file. By default the path is relative to the `.flt` file containing the call. Pass `--asset-root` to `build` or `check` to resolve all file paths against another directory. The root confines reads to that directory tree and file paths inside it cannot follow symbolic links. Fletcher accepts any file format. Logic Arrows' payload limit applies to the generated map after Fletcher packs its imported files.

`readFileIfPresent(path)` uses the same path and import rules. A missing file returns empty `bytes`. Other file errors remain build diagnostics.

In a Logic Arrows map, `sharedBytes(key)` reads an immutable byte snapshot from a Script Block. The key is a compile-time string. Publish a complete ordinary array of integer bytes in `globalState[key]`. The call returns empty `bytes` while the key is absent, then keeps the first published array as a private snapshot for the controller session.

```fletcher
const Image = readFile("image.gif")
const ImageSize = len(Image)

map "File bytes" {
    tick {
        first := currentTick() % ImageSize
        log(ImageSize, Image[first])
    }
}
```

Fletcher reads files at build time. Constant byte reads and lengths can be folded into the output. Files used at runtime are split across script tiles inside the map's zlib-compressed payload. Fletcher also compresses individual chunks when the savings cover the decoder. The controller decodes and caches those blocks on first use. Images, GIFs, videos, and other formats arrive as raw bytes for your program to decode.

`sameFile(a, b)` compares two immutable `bytes` handles. It returns true for two handles to the same imported source, including the canonical empty value. Separate nonempty imports remain distinct even when their contents match.

## Statements

Use `x := expr` to introduce a local. Use `var x Type` for a zero-initialized local, or add `= expr` for an initializer. Use `const` for compile-time values. `=` updates an existing local. Multi-name declarations and assignments evaluate the values before writing them. `_` discards a value. A short declaration must introduce at least one name in its current scope.

Use a constant array for a lookup table. Its elements must be compile-time values. Fletcher stores a table once per script controller, packs large integer tables when packing makes the script smaller, folds indexing with a constant offset, and makes a value copy when you assign it to a mutable local. When a controller exceeds the per-tile payload limit, Fletcher retries with its packed table data on automatically placed Script Blocks.

```fletcher
const intensities = [4]int{0, 25, 75, 100}

func intensity(index int) int {
    return intensities[index]
}
```

`switch` evaluates one scalar selector once and runs the matching case. List several constant values after one `case` to share its body. Each body has its own scope and ends automatically. Use `default` for unmatched values.

```fletcher
func modeName(mode int) string {
    switch mode {
    case 0:
        return "idle"
    case 1, 2:
        return "active"
    default:
        return "unknown"
    }
}
```

```fletcher
var total int
for i := range 4 {
    total = total + i
}

items := [3]int{1, 2, 3}
for i, item := range items {
    if i > 0 {
        total = total + item
    }
}
```

Integer ranges go from zero up to the bound. A nonpositive bound runs zero times. Array ranges visit indices in order using the array value from loop entry. String ranges yield a zero-based index and a one-character string per Unicode code point. Byte ranges yield a zero-based index and a `bits<8>` value. Use `for range bound` when you do not need the index. Statements normally end at a newline. A semicolon also separates statements on one line.

## Map logic

- `input name bit` creates a button that toggles a held signal. Add `with { key = "W" }` or `with { key = "1" }` to a `bit` input to receive a one-tick pulse from a letter or top-row digit in the game's Key mode. `output name bit = expr` creates a lamp. Both ports accept vector types for ordinary signals and optional `at (x, y)` anchors.
- `wire name Type = expr` defines a value shared by expressions and tick code. A wire can be referenced before its declaration. Combinational cycles are errors.
- `register name Type = constant` declares storage for `bit`, `bits<N>`, `int`, `string`, `bytes`, `color`, interfaces, and fixed arrays or structs built from those types. A `bytes` value retains a read-only reference to the imported file. An interface retains the concrete value as it was at conversion. In `tick { ... }`, use `next name = expr` to stage a whole register value. To update a field, copy the register to a local, edit the local, then stage it. Each `next` captures the value when it runs. Reads see the old value throughout the tick. Unwritten registers keep their value. If a register receives multiple updates, its last executed `next` wins.
- The compiler tries native routing for ordinary bindings. `circuit { ... }` requires native lowering for its outputs and wires. `script { ... }` forces those bindings to become JavaScript. Both blocks contain Fletcher expressions.
- Native circuits support runtime indexing of fixed arrays, bit vectors, and imported constant bytes when Fletcher can prove every possible address is in bounds. For example, `table[int(address)]` works with a `bits<2>` address and a four-element table. A single indexed assignment to a local array or bit vector emits gates that select which element changes. These local values are evaluated as part of the circuit on each input change. Use a map register or placed storage tiles for state across ticks.
- Add `backend circuit` after the file's imports to make its ordinary map bindings require native arrows. Functions declared in that file require native lowering when called. Explicit backend blocks still choose the backend for their own bindings. `tick` runs as script and can sample a wire produced by a native function. `backend script` defaults the file's ordinary map bindings to scripts.
- `currentTick()` reads the game tick. `log(...)` sends values to the game scripting log from a tick block.
- `mouseX()` and `mouseY()` read the latest pointer position as integers from 0 to 1024 across the game window. They return `-1` before the first pointer event and require the script backend.

- `screen at (x, y) size (width, height)` reserves a rectangular pixel grid. The default `style = "lamp"` uses bright green lamps. Choose red, blue, yellow, green, orange, or purple with `color`, and set `bright` with a bit. A `style = "solid"` screen supports white foreground pixels. Both styles use the [Logic Arrows Level limits](./logic-arrows.md#map-files).

`pixel(x, y, on)` draws with the screen's configured foreground at screen-local `int` coordinates. On solid screens, use `pixel(x, y, on, shade)` to choose a `color` per pixel. For example, `pixel(4, 2, true, color.Blue)` paints a blue pixel. Draw each frame from `tick` or a script function it calls. Out-of-bounds writes are clipped, and omitted or off pixels return to the background. In the Hello Screen example, click the button to alternate between text and a moving shape that changes color.

On a solid screen, `pixel(x, y, on, shade, index)` can store a source index between 0 and 255 for the current frame. A write clears the earlier index if it omits the index, turns the pixel off, or supplies an out-of-range index. `pixelIndexAt(x, y)` returns the most recent index written there in the current frame, or `-1` for an unindexed or out-of-bounds position. The indices stay in a transient buffer across slices of a logical tick and reset when the next logical tick starts.

Call `preserveScreen()` before drawing an overlay on a solid screen to start from the last committed tile colors. This clears the transient source indices. Paint the overlay with `pixel()` in the same tick.

`captureScreen(true)` returns the last committed solid-screen frame as a packed string. `captureScreen(false)` captures the current staged frame. To display a transition, pass two captures to `revealScreen(start, end, rows, columnsPerOffset)`. Each entry in the integer array `rows` sets how many rows of the end frame are visible from the top of its column group. The old frame shifts down by that amount in the same group. The result commits with the rest of the logical tick.

Add `hold = true` to a solid screen to keep its previous frame on ticks with no in-bounds pixel calls. The next draw still starts from the background. A call such as `pixel(0, 0, false)` presents an empty frame if no other pixels are drawn that tick.

Add `slice = true` to a solid screen to let a logical Fletcher tick suspend and resume across game ticks. Function calls and loop iterations provide points where a long tick can yield. `currentTick()` counts completed logical ticks from zero. Inputs and mouse coordinates are sampled when a logical tick starts. The screen, registers, logs, and scripted outputs become visible on completion. Scripted output drivers keep publishing the last committed values during a pause. A discontinuity in game ticks discards any unfinished tick.

Use `publish notes [8]bits<13> = packets` to share a named signal or a fixed array of signals with other script tiles on the map. `publish` runs as a script binding and consumes no lamp or driver tiles. It evaluates from the same tick snapshot as an ordinary output. Its value enters the shared frame when that tick commits. See the [script frame reader](./logic-arrows.md#published-script-bindings).

On a sliced screen, `host tick { ... }` runs after each host slice, including slices where the logical `tick` is still suspended. The host block reads committed registers, and each register has one writer block. A logical tick sees its starting register snapshot throughout its work. Host blocks read map values through registers and run to completion in the same game callback. Screen and pointer operations belong to the logical tick.

Use `publish host notes [8]bits<13> = packets` for named signals sampled at the start of each host block. `currentTick()` returns the game host tick while that block and its functions run. The script builtin `hostTimeMillis()` exposes the low 32 bits of the host wall clock in milliseconds. Integer subtraction gives elapsed milliseconds across wraparound for intervals shorter than about 24 days.

Set `with { key = "P", buffer = true }` on a keyboard `bit` input to remember short presses between logical ticks on a sliced screen. The next logical tick sees whether the key was pressed since the previous sample. Multiple presses in that interval share one sample. A discontinuity in game ticks clears pending presses.

The [Raycaster example](../examples/raycaster/main.flt) frames its 192×108 view and starts with an automatic camera pan. Click the orange button below **M** to switch to manual view, **L** or **R** to turn, and **F** to walk. Click **P** to toggle mouse-look. With **M** and the game's **Key mode** enabled, tap **W/S** to step forward or back and **A/D** to turn. The bottom-right speed bar sets the simulation rate. The renderer uses 256 headings and keeps the last frame until the camera moves or turns.

See [Logic Arrows target](logic-arrows.md) for coordinates, map output, and timing.

### Placement macros

Use `macro` to define a reusable layout, then `expand` it in a map. Arguments are typed compile-time constants. A macro can place tiles or expand another macro. It uses its defining file's constants and imports, while its arguments use the caller's scope. Imported macros follow the same export naming rules as functions.

```fletcher
macro XorWithLamp(x int, y int) {
    place xor at (x, y) facing right
    place lamp at (x + 1, y) with { color = "green", bright = true }
}

map "XOR tiles" {
    expand XorWithLamp(4, 8)
    expand XorWithLamp(4, 12)
}
```

Expansion happens before routing. The JSON IR includes the resulting placements.

## Compiler layout

- `src/Fletcher.Compiler/Syntax` converts the ANTLR parse tree into the AST.
- `Semantics` resolves names and types, specializes generics, and lowers the AST into `IR`.
- `IR` defines the typed program model and its versioned JSON dump.
- `CodeGeneration` consumes the IR for Logic Arrows circuits, QuickJS controllers, and Fletcher test scripts.
- `Routing` places arrows, balances path latency, and verifies the resulting tile connections.
- `Maps` models components and reads and writes the v5 format.
- `Translation` parses and translates the supported C subset.
- `src/Fletcher.Cli` exposes the compiler, map inspector, and C translator through System.CommandLine.
