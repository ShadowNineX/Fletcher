# Packages and imports

[Language reference](../language.md)

A small map can live in a standalone file. A file without a `package` header is compiled on its own along with its explicit imports. To group files, put them in one directory and give each the same `package name` header. The entry package supplies one map. A library package supplies constants, types, functions, methods, and placement macros for the entry package to use.

All files in a package share their top-level declarations. An uppercase ASCII first letter exports a declaration, struct field, or method to other packages. Imports and import aliases belong to the file that declares them. Cyclic imports are rejected.

## Define and use a local package

Save this library under `artifacts/fletcher-guide/packages/logic/gates.flt`.

```fletcher
package gates

func Difference(a bit, b bit) bit {
    return a ^ b
}
```

Save the map beside the `logic` directory as `artifacts/fletcher-guide/packages/main.flt`.

```fletcher
package main

import "logic"

map "Imported Gate" {
    input a bit
    input b bit
    output lamp bit = gates.Difference(a, b)
}
```

The import path points to a directory called `logic`. The default name used in expressions is `gates` from the library's package header.

```powershell
dotnet run --project src/Fletcher.Cli --no-build -- build artifacts/fletcher-guide/packages/main.flt -o artifacts/fletcher-guide/Imported-Gate.json
```

Use `import gateset "logic"` to choose the name `gateset`. Group multiple imports in an `import (...)` block with one import per line. For example, [Hello Screen](../../examples/hello-screen/main.flt) imports its text-drawing library.

## Resolve import paths

Ordinary paths are relative to the entry file's directory, including when they appear in an imported library. Use `--package-root` to select a shared library root. A path starting with `./` is relative to the importing file instead. Paths use forward slashes to separate local directory names. The compiler checks the package header in every loaded source file. The ordinary build skips neighboring `*_test.flt` files.

[File imports](data.md) have their own root and resolution rules.
