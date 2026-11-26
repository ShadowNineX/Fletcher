# Functions, methods, and generics

[Language reference](../language.md)

## Functions

Use `func name(arg Type) ResultType { ... }` to declare a function. The parameters are local values. Functions that declare a result must return it on every path. Omit the result type for a procedure. A procedure can reach the end or use a bare `return`. Call a function by name, and use a call as its own statement when you only need its effects.

```fletcher
func offset(value int, amount int) int {
    return value + amount
}
```

Functions use acyclic call graphs. Use [range loops](syntax.md#branches-and-loops) for repeated work. A native binding can call a function when its specialized body can lower to gates. Screen drawing and other host effects need a script context. See [backend selection](maps.md#choose-a-backend).

## Multiple results

Declare two or more result types in parentheses. Return them in that order, then use a short declaration or assignment with the same number of targets. Fletcher evaluates the source call once. Use `_` to discard an output, or forward matching results with `return otherCall()`.

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

    _, offset = splitIndex(12)
    assertEqual(offset, 12)
}
```

Save the example as a `*_test.flt` file and run it with [`test`](tooling.md#testing-fletcher-code).

## Methods

Declare a method with `func (receiver Type) Name(...) Result { ... }`. The receiver type is a locally defined named type. Call the method with `value.Name(...)`. A receiver is passed by value, so return the updated copy and assign it back to change the caller's value.

```fletcher
type Counter struct {
    value int
}

func (counter Counter) Advance() Counter {
    counter.value = counter.value + 1
    return counter
}

test "advance a copy" {
    var start Counter
    finish := start.Advance()
    assertEqual(start.value, 0)
    assertEqual(finish.value, 1)
}
```

## Interfaces

An interface lists required method names, parameter types, and result types. A concrete type satisfies the interface when its methods match those signatures. Assign a compatible value to an interface local, argument, or register to store a snapshot of the concrete value. A method call on an interface value uses script dispatch. Initialize the interface with a concrete value before calling its methods.

## Generic types and functions

Types and functions can declare type parameters such as `<T>`. Use an interface to constrain the parameter, as in `<T extends Combiner>`. Fletcher checks a generic body when it specializes for specific type arguments. A method on a generic type uses the receiver's type parameters.

At a function call, Fletcher infers type arguments from parameter and argument types. Pass them explicitly when the function needs more information. A generic call on a concrete receiver can specialize to physical logic when its operations support native lowering.

```fletcher
type Combiner interface {
    Apply(a bit, b bit) bit
}

type Xor struct {}

func (operation Xor) Apply(a bit, b bit) bit {
    return a ^ b
}

type Pair<T> struct {
    first T
    second T
}

func (pair Pair<T>) First() T {
    return pair.first
}

func combine<T extends Combiner>(operation T, a bit, b bit) bit {
    return operation.Apply(a, b)
}

map "Generic XOR" {
    input a bit
    input b bit
    circuit {
        output inferred bit = combine(Xor{}, a, b)
        output explicit bit = combine<Xor>(Xor{}, a, b)
    }
}
```
