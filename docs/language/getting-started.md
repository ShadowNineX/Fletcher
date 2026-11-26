# Getting started with Fletcher

[Language reference](../language.md)

Fletcher turns a `.flt` source file into a playable Logic Arrows Level. You can describe logic as physical arrows, run logic in Script Blocks, or connect both in one map.

## Set up the compiler

Open PowerShell at the root of the Fletcher repository. Install the .NET 11 SDK and Java, then make sure `dotnet` and `java` are on your `PATH`. The repository's SDK selection is in [global.json](../../global.json). Install Logic Arrows to play the generated Levels. Node.js is used by the Fletcher test runner.

```powershell
dotnet --version
java -version
dotnet build src/Fletcher.Cli
New-Item -ItemType Directory -Force artifacts/fletcher-guide
```

If parser generation needs an existing ANTLR JAR, pass its path using the [compiler setup instructions](tooling.md#compiler-development).

## Build a physical half-adder

Save this as `artifacts/fletcher-guide/adder.flt`.

```fletcher
map "Guide Half Adder" {
    input a bit
    input b bit

    circuit {
        output sum bit = a ^ b
        output carry bit = a & b
    }
}
```

Each input creates a button and a tile that holds its signal. The two outputs create lamps. The `circuit` block requires the compiler to place physical arrows for XOR and AND. `--explain` prints the ports' coordinates and route delays.

```powershell
dotnet run --project src/Fletcher.Cli --no-build -- build artifacts/fletcher-guide/adder.flt -o artifacts/fletcher-guide/Guide-Half-Adder.json --explain
```

In Windows, open `%APPDATA%\logic-arrows\save\maps` in File Explorer and copy `Guide-Half-Adder.json` into it. Open the Maps menu in Logic Arrows and select **Guide Half Adder**. Start the simulation and click the buttons. Give the arrows time to propagate after each click.

| A | B | Sum | Carry |
|---|---|---|---|
| Off | Off | Off | Off |
| On | Off | On | Off |
| Off | On | On | Off |
| On | On | Off | On |

## Run a counter in Script Blocks

Save this as `artifacts/fletcher-guide/counter.flt`.

```fletcher
map "Guide Counter" {
    input run bit
    register count bits<4> = 0

    tick {
        if run {
            next count = count + 1
        }
    }

    script {
        output lamps bits<4> = count
    }
}
```

A register holds a value between ticks. `next` stages the new value for the end of the tick. A four-bit counter wraps from 15 to 0. The `script` block forces the lamp bank's driver to use a script and the physical lamps show the four bits.

```powershell
dotnet run --project src/Fletcher.Cli --no-build -- build artifacts/fletcher-guide/counter.flt -o artifacts/fletcher-guide/Guide-Counter.json --explain
```

Copy the JSON into the same Maps folder and open **Guide Counter**. Set a slow tick rate and click the input to start and stop counting. Read the lamps from left to right starting with the least significant bit.

## Connect arrows, scripts, and manual tiles

Save this as `artifacts/fletcher-guide/mixed.flt`.

```fletcher
map "Guide Mixed Map" {
    input a bit at (0, 0)
    input b bit
    register seen bit = false

    circuit {
        wire different bit = a ^ b
    }

    tick {
        next seen = seen | different
    }

    script {
        wire enabled bit = seen
    }

    circuit {
        output indicator bit at (92, 64) = enabled & a
    }

    place wall at (-4, 0) with { color = "blue", glyph = "A" }
}
```

The controller samples the physical XOR wire and remembers whether it has ever been high. The scripted `enabled` wire then feeds a second physical circuit. The manually placed wall labels the first button. The two physical routes and the script bridge each take time to propagate.

```powershell
dotnet run --project src/Fletcher.Cli --no-build -- build artifacts/fletcher-guide/mixed.flt -o artifacts/fletcher-guide/Guide-Mixed-Map.json --explain
dotnet run --project src/Fletcher.Cli --no-build -- inspect artifacts/fletcher-guide/Guide-Mixed-Map.json
```

Copy the JSON to the Maps folder and open **Guide Mixed Map**. With both buttons off, turn **B** on and let the signal settle. Then turn **A** on. The indicator stays lit while **A** is on, even when the two inputs agree. Reopen the map to reset `seen`.

## Where to go next

- Learn [types and values](types.md), [functions and interfaces](functions.md), and [packages](packages.md) as your programs grow.
- Add a [screen](screens.md) or place a [manual circuit](tiles.md).
- For a complete display project, build [Hello Screen](../../examples/hello-screen/main.flt) with the same `build` command.
- Use the [command reference](tooling.md) to check source, inspect maps, and run tests.
