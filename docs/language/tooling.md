# Compiler and test commands

[Language reference](../language.md)

Build the CLI with `dotnet build src/Fletcher.Cli`. The examples below use PowerShell from the repository root.

## Commands

| Command | What it does |
|---|---|
| `check file.flt` | Checks syntax, types, backend lowering, and map layout without writing a Level. |
| `build file.flt -o map.json` | Compiles a playable Level. |
| `inspect map.json` | Prints the decoded main tile payload as JSON. Add `--preview` for the map-card payload. |
| `test [path]` | Runs Fletcher source tests through Node.js. |
| `transpile-c file.c -o kernel.flt` | Translates supported integer routines into a local Fletcher package. |

```powershell
dotnet run --project src/Fletcher.Cli --no-build -- check examples/half-adder.flt
dotnet run --project src/Fletcher.Cli --no-build -- build examples/hybrid.flt -o artifacts/hybrid.json --explain
dotnet run --project src/Fletcher.Cli --no-build -- inspect artifacts/hybrid.json
```

`check` and `build` accept `--explain` for backend choices and route timing, `--package-root` for shared [packages](packages.md), and `--asset-root` for [binary imports](data.md).

Pass `--template level.json` to `build` to reuse an editor-created Level wrapper and generate a new name and preview. Pass `--update-from level.json` to replace only the tile payload and keep the existing name, preview, tags, and Workshop metadata. Use a new output file for an update. See [updating a Workshop map](../logic-arrows.md#update-a-workshop-map).

## Inspect the intermediate representation

`check` and `build` accept `--emit-ir` to write the typed intermediate representation as JSON. The flag alone writes `<source>.ir.json` beside the source. Pass an explicit path to send it elsewhere.

```powershell
dotnet run --project src/Fletcher.Cli --no-build -- check examples/hybrid.flt --emit-ir artifacts/hybrid.before.ir.json
dotnet run --project src/Fletcher.Cli --no-build -- build examples/hybrid.flt -o artifacts/hybrid.json --emit-ir artifacts/hybrid.after.ir.json
```

The versioned dump shows resolved types, symbols, operations, function bodies, and map declarations before backend selection. It lists file imports by length and SHA-256. Identical source and inputs produce identical IR. If binding succeeds, the CLI can write the IR even when target generation fails.

## Testing Fletcher code

Put named `test` blocks in `*_test.flt` files. Each test has independent locals. Tests can call package functions and import packages or fixture bytes. Use `assert` for a bit condition, `assertEqual` for value or byte-content comparisons, and `log` to inspect a value. Each assertion can include an optional message.

```fletcher
test "array elements keep their order" {
    values := [3]int{7, 2, 9}
    assert(values[0] < values[2])
    assertEqual(values, [3]int{7, 2, 9}, "original order")
}
```

Save the example as `artifacts/fletcher-guide/order_test.flt`. Run `test` with a file or a directory. With no path it discovers tests under the current directory. Add `--filter` to select test names by a case-insensitive substring. The command also accepts `--package-root` and `--asset-root`.

```powershell
dotnet run --project src/Fletcher.Cli --no-build -- test artifacts/fletcher-guide/order_test.flt --filter order
dotnet run --project src/Fletcher.Cli --no-build -- test examples/doom-engine
```

The runner uses Node.js from `PATH` to evaluate the generated test scripts. Failed assertions report the source location and make the command exit with a nonzero status. Map APIs such as `pixel()` and `currentTick()` need a running map.

## Translating C routines

Use `transpile-c` with a valid C translation unit whose preprocessor directives have been resolved. Put the generated `cport` package directory alongside the map that imports it. The translator runs inside Fletcher and needs only the built CLI.

```powershell
dotnet run --project src/Fletcher.Cli --no-build -- transpile-c tests/fixtures/portable-c.c -o artifacts/fletcher-guide/c-example/cport/kernel.flt
```

Save this as `artifacts/fletcher-guide/c-example/main.flt`.

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
dotnet run --project src/Fletcher.Cli --no-build -- build artifacts/fletcher-guide/c-example/main.flt -o artifacts/fletcher-guide/c-example/Portable-C.json
```

The example logs `5` each tick. The translator accepts self-contained routines with 32-bit `int` and `unsigned int`, `void` results, scalar locals, fixed-length local arrays, casts, direct calls, `if` and `else`, and counted loops written as `for (int i = 0; i < limit; i++)`. The limit must be an integer literal or a signed scalar left unchanged by the loop. Public functions get a `C_` prefix. Static functions stay private. C signed integers become Fletcher `int` values and unsigned integers become `bits<32>`. Unsupported constructs produce a source diagnostic before any translated output is written.

## Compiler development

The projects target .NET 11 and use C# 15. Build the full solution with `dotnet build Fletcher.slnx`. Run `node tests/smoke.mjs` to check the CLI and generated maps. The optional `--lab` flag also checks an installed Component Lab.

The build generates parser code using ANTLR. If ANTLR cannot locate its JAR, pass `-p:FletcherAntlrJar="C:\path\to\antlr4-4.13.1-complete.jar"` to `dotnet build`. Keep Java on `PATH`. Solution builds enforce collection expression rules from [the editor configuration](../../.editorconfig).

| Directory | Responsibility |
|---|---|
| `src/Fletcher.Compiler/Syntax` | Parses source files and imports. |
| `src/Fletcher.Compiler/Semantics` | Resolves names and types, specializes generics, and binds statements. |
| `src/Fletcher.Compiler/IR` | Defines the typed program and its JSON dump. |
| `src/Fletcher.Compiler/CodeGeneration` | Emits native logic, controllers, and test scripts. |
| `src/Fletcher.Compiler/Routing` | Places and verifies arrows and balances signal arrivals. |
| `src/Fletcher.Compiler/Maps` | Models tiles and reads and writes the v5 Level format. |
| `src/Fletcher.Compiler/Translation` | Parses and translates the supported C subset. |
| `src/Fletcher.Cli` | Provides the commands and test runner entry point. |
