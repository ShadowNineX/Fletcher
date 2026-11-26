# Types and values

[Language reference](../language.md)

Fletcher checks types before it generates arrows or scripts. Assignments, arguments, return values, and map ports all use the declared types.

| Type | Values | Zero value |
|---|---|---|
| `bit` | `true` and `false` | `false` |
| `bits<N>` | Unsigned signal vector with 1–32 lanes | All lanes low |
| `int` | Signed 32-bit integer | `0` |
| `string` | Text with concatenation, equality, and range iteration | Empty string |
| `bytes` | Immutable sequence of bytes | Empty sequence |
| `color` | `White`, `Red`, `Blue`, `Yellow`, `Green`, `Orange`, `Purple`, and `Black` under the `color.` qualifier | `color.Black` |
| `[N]T` | Fixed-size array of values of type `T` | A zero value in each element |
| `struct` | Named fields grouped into one value | A zero value in each field |
| `interface` | A snapshot of a compatible concrete value | An empty interface value |

## Numbers and conversions

`int` arithmetic wraps to 32 bits. Arithmetic on `bits<N>` wraps to its width. Division truncates toward zero. A shift count uses the low five bits of its `int` value. Right shifts of `int` preserve the sign. Right shifts of `bits<N>` fill with zeroes.

The width in `bits<N>` and the length in `[N]T` are integer literals or named constants, including exported constants from a package. Lengths may be zero. A literal or untyped constant can adapt to a compatible numeric type when its value fits. For example, `var count bits<4> = 7` works while the value of an `int` local uses `bits<4>(value)`. An explicit conversion to `bits<N>` keeps the low `N` bits.

```fletcher
func toggleFlag(flags bits<8>, index int) bits<8> {
    return flags ^ (bits<8>(1) << index)
}

func highByte(word bits<16>) bits<8> {
    return bits<8>(word >> 8)
}
```

`type Name Type` defines a distinct type. Use explicit conversions when exchanging compatible scalar values with its underlying type. `type Name = Type` declares an alias for the same type.

## Arrays and structs

Use `[3]int{7, 2}` to create an array and `array[0]` to read its first value. An array literal uses the zero value for omitted elements. Constant arrays make lookup tables.

```fletcher
const intensities = [4]int{0, 25, 75, 100}

func intensity(index int) int {
    return intensities[index]
}
```

The compiler folds a constant offset into a lookup at build time. At runtime, a script controller can share one read-only lookup table and copy a value when it becomes a mutable local. Fletcher can pack large tables and move their data into additional Script Blocks when the controller approaches the per-tile payload limit.

Declare a struct with `type Name struct { ... }`. A literal such as `Point{X: 3}` initializes the named fields and zeroes the rest. Use `point.X` to read a field or assign to a field of a mutable local.

```fletcher
type Point struct {
    X int
    Y int
}

func moveRight(point Point) Point {
    point.X = point.X + 1
    return point
}
```

Arrays and structs are copied by value in assignments, calls, and returns. Changing a parameter or a value receiver changes that local copy. Use the result of a function to replace the caller's value. An interface stores the value present when it receives a concrete argument. See [interfaces](functions.md#interfaces) for method dispatch.

## Indexing

An index is a zero-based `int`. An array returns its element type, a `bits<N>` value returns a `bit` with lane zero at the least significant end, and `bytes` returns `bits<8>`. Use range iteration to read characters in a string.

Fletcher rejects out-of-bounds constant indices when the bound is known. The script backend checks dynamic indices when needed. The native backend requires proof that each possible index fits. For example, a `bits<2>` converted with `int(address)` fits a four-element table. See [file data](data.md) for immutable byte sequences.
