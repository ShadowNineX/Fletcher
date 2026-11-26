# Binary data

[Language reference](../language.md)

Use `readFile(path)` with a compile-time string to import a binary file. Paths are relative to the `.flt` file with the call. Use `--asset-root` to resolve paths from a shared directory. The relative path must stay within the root and use ordinary files and directories. The root applies to imports in all packages.

`readFileIfPresent(path)` follows the same rules and returns empty `bytes` if the file or a parent directory is missing. Other read failures are build errors. The compiled program receives immutable bytes in their original format. Decode image, audio, or other file formats in your Fletcher code.

## Read and inspect an asset

Make the example directory and file.

```powershell
New-Item -ItemType Directory -Force artifacts/fletcher-guide/data
[IO.File]::WriteAllBytes((Join-Path (Get-Location) 'artifacts/fletcher-guide/data/sample.bin'), [byte[]](8, 16, 32))
```

Save this as `artifacts/fletcher-guide/data/main.flt`.

```fletcher
const Sample = readFile("sample.bin")
const SampleSize = len(Sample)

map "File Bytes" {
    tick {
        if SampleSize > 0 {
            index := currentTick() % SampleSize
            log(SampleSize, Sample[index])
        }
    }
}
```

```powershell
dotnet run --project src/Fletcher.Cli --no-build -- build artifacts/fletcher-guide/data/main.flt -o artifacts/fletcher-guide/File-Bytes.json
```

`len(data)` returns an `int` byte count. Indexing returns a `bits<8>` byte at an `int` offset. Use `for index, value := range data` to read bytes in order.

`sameFile(a, b)` tests whether two `bytes` values refer to the same imported data handle. Separate nonempty files have different handles even when their contents match. Empty imports share the canonical empty value. For content equality in tests, use `assertEqual`.

## Receive bytes from a script

Publish an ordinary array of integers from 0 through 255 in a hand-written Script Block using `globalState[key]`. In Fletcher, call `sharedBytes("key")` with a compile-time key. The call returns an empty sequence while the key is absent, then snapshots the first published array for the controller session.

## How file data fits in a map

The compiler can fold constant lengths and byte reads. Runtime data occupies automatically placed Script Blocks. Fletcher packs and lazily decodes imported data when packing saves space. The final map must fit the [Logic Arrows Level payload limits](../logic-arrows.md#map-files).
