# Fletcher language

Fletcher compiles Go-style `.flt` programs into playable Logic Arrows Levels. A single map can combine compiler-generated arrows, Script Blocks, and manual tiles.

## Build and use

Start with the [getting-started guide](language/getting-started.md). Install the compiler prerequisites, build a physical half-adder, then run a scripted counter and a map that connects both kinds of logic.

Use the [Logic Arrows target guide](logic-arrows.md) for game-specific layout, propagation, and Level file details.

## Types and declarations

Read [types and values](language/types.md) for signal widths, numbers, strings, arrays, structs, value copies, and conversions.

Read [functions, methods, and generics](language/functions.md) to define routines, return multiple values, and use interfaces and type parameters.

## Statements

Read [syntax and control flow](language/syntax.md) for literals, operators, declarations, assignments, conditions, switch cases, and ranges.

The [built-in reference](language/builtins.md) lists the calls provided by the compiler and the contexts that support each one.

## Packages

Read [packages and imports](language/packages.md) to split programs across files and share code between maps.

## Reading files

Read [binary data](language/data.md) to embed local assets and read byte arrays from other scripts.

## Map logic

Read [maps, signals, and backends](language/maps.md) for ports, keyboard inputs, wires, registers, script publishing, and the choice between native and scripted logic.

Read [screens and frames](language/screens.md) to choose a display style, draw pixels, work with palettes, and slice long ticks.

### Placement macros

Read [manual tiles and placement macros](language/tiles.md) for tile names, options, fixed layouts, and reusable placement.

## Testing Fletcher code

Use the [Fletcher test runner](language/tooling.md#testing-fletcher-code) to run source tests and check expected values.

## Inspecting the intermediate representation

The [command reference](language/tooling.md#inspect-the-intermediate-representation) explains compiler flags, typed IR dumps, and backend diagnostics.

## Translating C routines

Use [C translation](language/tooling.md#translating-c-routines) to bring supported integer routines into a local Fletcher package.

## Compiler layout

See [compiler development](language/tooling.md#compiler-development) for the build configuration, parser tooling, and source directory guide.
