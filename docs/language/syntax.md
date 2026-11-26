# Syntax and control flow

[Language reference](../language.md)

## Source files

A `.flt` file starts with an optional `package` header, then imports, an optional `backend` directive, and declarations. A map belongs at the end of its file. [Packages](packages.md) explains how several files make up one compilation.

Identifiers are case-sensitive and start with an ASCII letter or an underscore. The rest can also contain digits. A newline normally separates statements. You can also use `;` to put multiple statements on one line. Use `//` for a line comment and `/* … */` for a block comment.

Write integer literals in decimal, hexadecimal with `0x`, or binary with `0b`. You can group digits with underscores, as in `0b1010_0011`. Strings use double quotes and support escapes such as `\n`, `\t`, `\\`, `\"`, and `\u0061`. Boolean literals are `true` and `false`.

## Declarations and assignments

Use `const name = expression` at file or block scope. A constant may have a type annotation. Its expression must be known at compile time. Use `var name Type` for a zero-initialized local, `var name Type = value` for a typed initializer, or `var name = value` to infer the type.

`name := expression` introduces a local with an inferred type. A multi-name short declaration may reuse mutable locals in the current scope when it also introduces at least one new name. Blocks, branches, loop bodies, and switch cases each have a local scope.

`=` updates an existing local, which can be a whole value, a field, or an indexed element. When assigning several values, Fletcher evaluates the right-hand side before writing the targets. Use `_` to discard a value or a [function result](functions.md#multiple-results).

```fletcher
func swapExample() (int, int) {
    a, b := 3, 8
    a, b = b, a
    return a, b
}
```

## Operators

Operator families are listed from highest to lowest precedence. Within a binary family, operators associate left to right. Use parentheses to group expressions.

| Operators | Use |
|---|---|
| `f(x)`, `x.Field`, `x[i]` | Calls, member access, indexing |
| Unary `+`, `-`, `~`, `^`, `!` | Numeric sign, complement, or Boolean inversion |
| `*`, `/`, `%`, `<<`, `>>`, `&` | Multiplication, division, remainder, shifts, or bitwise AND |
| `+`, `-`, `\|`, `^` | Addition, subtraction, bitwise OR, or XOR. `+` also concatenates strings. |
| `==`, `!=`, `<`, `<=`, `>`, `>=` | Equality or order comparisons |
| `&&` | Short-circuit Boolean AND |
| `\|\|` | Short-circuit Boolean OR |

For `bit` use `!` to invert and `&`, `|`, or `^` for Boolean logic. For numeric types use unary `~` or `^` to complement every bit. Equality operators compare values of compatible scalar types. Order comparisons apply to `int` and `bits<N>`. Use [`assertEqual`](builtins.md#test-assertions) for content comparisons in tests.

The compiler folds constant expressions. In scripts, division or remainder by zero raises a runtime error when reached. `&&` and `||` skip evaluation of their right operand when the left operand determines the result. The compiler still checks types and constant bounds in both operands.

## Branches and loops

An `if` condition has type `bit`. Follow its block with `else if` or `else` on the same line as the closing brace.

```fletcher
func classify(value int) string {
    if value < 0 {
        return "negative"
    } else if value == 0 {
        return "zero"
    } else {
        return "positive"
    }
}
```

`switch` evaluates its scalar selector once. Each `case` lists one or more distinct compile-time values of the selector type. The matching body runs and ends automatically. Add `default` for unmatched selectors.

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

Use `for i := range bound` to visit the indices from zero up to, and excluding, an integer bound. A nonpositive bound has zero iterations. Use `for range bound` when the index is unnecessary. The range source is evaluated when the loop begins.

Range loops use a fixed bound or collection for each run. Use an `if` inside the body to skip an iteration's work. Use `return` when you want to finish the enclosing function early, or keep a local flag if the code after the loop still needs to run.

Fixed arrays, strings, and bytes also support `for index, value := range source`. Array iteration uses a copy taken when the loop begins. Strings give one character per Unicode code point. Bytes give `bits<8>` values. In all three cases, a single loop name denotes the index. Write `for _, value := range source` to keep just the value.

```fletcher
func sumExample() int {
    total := 0
    for _, item := range [3]int{1, 2, 3} {
        total = total + item
    }
    return total
}
```

See [backend requirements](maps.md#choose-a-backend) when branching or looping in a function that will become physical arrows.
