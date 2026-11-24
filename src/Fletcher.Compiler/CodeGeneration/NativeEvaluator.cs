using System.Text;
using Fletcher.Compiler.IR;
using Fletcher.Compiler.Semantics;
using static Fletcher.Compiler.CodeGeneration.NativeGraph;

namespace Fletcher.Compiler.CodeGeneration;

internal sealed class NativeEvaluator(NativeGraph graph, Func<Variable, int[]> readMapValue)
{
    private interface IValue { }
    private sealed record Signal(int[] Bits) : IValue;
    private sealed record Literal(BoundLiteral Scalar) : IValue;
    private sealed record Structure(Dictionary<string, IValue> Fields) : IValue;
    private sealed record ArrayValue(IValue[] Items) : IValue;
    private sealed record InterfaceValue(int Tag, IValue Contained) : IValue;
    private sealed record Returned(IValue? Value);
    private readonly Dictionary<ConstantArray, ArrayValue> constantArrays = [];

    public int[] Lower(BoundExpression expression)
    {
        if (!expression.Type.IsSignal)
            throw new NativeException($"'{expression.Type}' has no native signal representation.");
        return ToBits(Evaluate(expression, []));
    }

    private IValue Evaluate(BoundExpression expression, Dictionary<Variable, IValue> locals)
    {
        return expression switch
        {
            BoundLiteral literal => Lift(literal),
            BoundVariable { Symbol.IsMapValue: true } variable => new Signal(readMapValue(variable.Symbol)),
            BoundVariable variable => locals[variable.Symbol],
            BoundUnary unary => Unary(unary, Evaluate(unary.Operand, locals)),
            BoundBinary binary => Binary(binary, locals),
            BoundConversion conversion => Convert(conversion, Evaluate(conversion.Operand, locals)),
            BoundCall call => Invoke(call.Function, call.Receiver is { } receiver ? Evaluate(receiver, locals) : null,
                [.. call.Arguments.Select(argument => Evaluate(argument, locals))]),
            BoundDispatch => throw new NativeException("Dynamic interface dispatch requires script."),
            BoundMember member => ((Structure)Evaluate(member.Receiver, locals)).Fields[member.Name],
            BoundIndex index => Index(index, locals),
            BoundStruct structure => new Structure(structure.Fields.ToDictionary(field => field.Key, field => Evaluate(field.Value, locals), StringComparer.Ordinal)),
            BoundArray array => new ArrayValue([.. array.Elements.Select(element => Evaluate(element, locals))]),
            BoundCurrentTick => throw new NativeException("currentTick() requires script."),
            BoundHostTimeMillis => throw new NativeException("hostTimeMillis() requires script."),
            BoundSharedBytes => throw new NativeException("sharedBytes() requires script."),
            BoundPixelIndexAt => throw new NativeException("pixelIndexAt() requires script."),
            _ => throw new NativeException("Expression has no native lowering.")
        };
    }

    private IValue Invoke(Function function, IValue? receiver, IValue[] arguments)
    {
        Dictionary<Variable, IValue> locals = [];
        for (var index = 0; index < arguments.Length; index++)
            locals.Add(function.Parameters[index], arguments[index]);
        if (function.Receiver is { } variable)
            locals.Add(variable, receiver ?? throw new NativeException("Native method has no receiver."));
        var result = Execute(function.Body ?? throw new NativeException("Function has no body."), locals);
        return result?.Value ?? throw new NativeException("Void functions require script.");
    }

    private Returned? Execute(BoundStatement statement, Dictionary<Variable, IValue> locals)
    {
        switch (statement)
        {
            case BoundBlock block:
                foreach (var child in block.Statements)
                {
                    if (Execute(child, locals) is { } returned)
                        return returned;
                }
                return null;
            case BoundLocals declaration:
            {
                var values = EvaluateValues(declaration.Values, declaration.ResultSource, locals);
                for (var i = 0; i < values.Length; i++)
                {
                    if (declaration.Symbols[i] is { } variable)
                        locals[variable] = values[i];
                }
                return null;
            }
            case BoundAssignment assignment:
            {
                if (assignment.Targets is [BoundIndex { Receiver: BoundVariable { Symbol.IsMapValue: false } target } index])
                {
                    var receiver = locals[target.Symbol];
                    var (address, variableBits) = IndexAddress(index, index.Receiver.Type.Shape.Size, locals);
                    var value = EvaluateValues(assignment.Values, assignment.ResultSource, locals)[0];
                    locals[target.Symbol] = UpdateIndex(receiver, address, variableBits, value);
                    return null;
                }
                var values = EvaluateValues(assignment.Values, assignment.ResultSource, locals);
                for (var i = 0; i < values.Length; i++)
                {
                    if (assignment.Targets[i] is BoundVariable variable)
                        locals[variable.Symbol] = values[i];
                    else if (assignment.Targets[i] is not null)
                        throw new NativeException("This indexed or field assignment requires script.");
                }
                return null;
            }
            case BoundReturn returned:
                return new Returned(returned.Value is { } expression ? Evaluate(expression, locals) : null);
            case BoundIf conditional:
                return ExecuteIf(conditional, locals);
            case BoundSwitch selection:
                return ExecuteSwitch(selection, locals);
            case BoundRange loop:
                return ExecuteRange(loop, locals);
            default:
                throw new NativeException("Effectful statements require script.");
        }
    }

    private Returned? ExecuteIf(BoundIf conditional, Dictionary<Variable, IValue> locals)
    {
        var test = ToBits(Evaluate(conditional.Condition, locals))[0];
        if (test == High)
            return Execute(conditional.Then, locals);
        if (test == Low)
            return conditional.Else is { } alternative ? Execute(alternative, locals) : null;

        Dictionary<Variable, IValue> yes = [with(locals)];
        Dictionary<Variable, IValue> no = [with(locals)];
        var yesResult = Execute(conditional.Then, yes);
        var noResult = conditional.Else is { } alternate ? Execute(alternate, no) : null;
        return MergeBranches(test, locals, yes, no, yesResult, noResult);
    }

    private Returned? ExecuteSwitch(BoundSwitch selection, Dictionary<Variable, IValue> locals)
    {
        var selector = Evaluate(selection.Selector, locals);
        if (selector is Literal literal)
        {
            var clause = Array.Find(selection.Cases, clause =>
                Array.Exists(clause.Values, value => Equals(value.Value, literal.Scalar.Value)));
            var body = clause?.Body ?? selection.Default;
            return body is null ? null : Execute(body, locals);
        }

        var bits = ToBits(selector);
        List<(int Match, BoundBlock Body)> branches = [];
        foreach (var clause in selection.Cases)
        {
            var match = Low;
            foreach (var value in clause.Values)
                match = graph.Or(match, Equality(bits, ToBits(new Literal(value)), equal: true));
            if (match == High)
                return Execute(clause.Body, locals);
            if (match != Low)
                branches.Add((match, clause.Body));
        }

        if (branches.Count == 0)
            return selection.Default is null ? null : Execute(selection.Default, locals);
        Dictionary<Variable, IValue> initial = [with(locals)];
        Dictionary<Variable, IValue> merged = [with(initial)];
        var outcome = selection.Default is { } otherwise ? Execute(otherwise, merged) : null;
        for (var i = branches.Count - 1; i >= 0; i--)
        {
            var (match, body) = branches[i];
            Dictionary<Variable, IValue> branch = [with(initial)];
            var result = Execute(body, branch);
            outcome = MergeBranches(match, locals, branch, merged, result, outcome);
            merged = locals;
        }
        return outcome;
    }

    private Returned? MergeBranches(int test, Dictionary<Variable, IValue> locals, Dictionary<Variable, IValue> yes,
        Dictionary<Variable, IValue> no, Returned? yesResult, Returned? noResult)
    {
        if (yesResult is null && noResult is null)
        {
            foreach (var local in locals.Keys.ToArray())
                locals[local] = Merge(test, yes[local], no[local]);
            return null;
        }
        if (yesResult?.Value is { } a && noResult?.Value is { } b)
            return new Returned(Merge(test, a, b));
        throw new NativeException("Conditional early return requires script unless both branches return a value.");
    }

    private IValue[] EvaluateValues(BoundExpression[] values, BoundResultSource? source, Dictionary<Variable, IValue> locals)
    {
        if (source is not null)
            locals[source.Temporary] = Evaluate(source.Call, locals);
        IValue[] result = [.. values.Select(value => Evaluate(value, locals))];
        if (source is not null)
            locals.Remove(source.Temporary);
        return result;
    }

    private IValue Lift(BoundLiteral literal)
    {
        if (literal.Value is not ConstantArray array)
            return new Literal(literal);
        if (!constantArrays.TryGetValue(array, out var value))
        {
            value = new ArrayValue([.. array.Items.Select(Lift)]);
            constantArrays.Add(array, value);
        }
        return value;
    }

    private Returned? ExecuteRange(BoundRange loop, Dictionary<Variable, IValue> locals)
    {
        var source = Evaluate(loop.Collection, locals);
        if (source is Literal { Scalar.Value: string text })
            source = new ArrayValue([.. text.EnumerateRunes().Select(rune => new Literal(new BoundLiteral(DataType.String, rune.ToString())))]);
        var length = source switch
        {
            ArrayValue array => array.Items.Length,
            Literal { Scalar.Value: int count } => Math.Max(0, count),
            _ => throw new NativeException("A native range requires a constant length.")
        };
        for (var i = 0; i < length; i++)
        {
            if (loop.Index is { } index)
                locals[index] = new Literal(new BoundLiteral(DataType.Int, i));
            if (loop.Value is { } item)
                locals[item] = ((ArrayValue)source).Items[i];
            if (Execute(loop.Body, locals) is { } returned)
                return returned;
        }
        return null;
    }

    private IValue Merge(int test, IValue yes, IValue no)
    {
        if (test == High || Equals(yes, no))
            return yes;
        if (test == Low)
            return no;
        if (yes is ArrayValue a && no is ArrayValue b)
            return new ArrayValue([.. a.Items.Zip(b.Items, (left, right) => Merge(test, left, right))]);
        if (yes is Structure first && no is Structure second)
            return new Structure(first.Fields.ToDictionary(field => field.Key, field => Merge(test, field.Value, second.Fields[field.Key]), StringComparer.Ordinal));
        return new Signal([.. ToBits(yes).Zip(ToBits(no), (left, right) => graph.Select(test, left, right))]);
    }

    private IValue Unary(BoundUnary unary, IValue operand)
    {
        if (operand is Literal literal)
            return new Literal(Constants.Unary(unary.Type, unary.Operator, literal.Scalar));
        var bits = ToBits(operand);
        return unary.Operator switch
        {
            UnaryOperator.Plus => operand,
            UnaryOperator.LogicalNot or UnaryOperator.BitwiseNot => new Signal([.. bits.Select(graph.Not)]),
            UnaryOperator.Negate => new Signal(Add([.. Enumerable.Repeat(Low, bits.Length)], [.. bits.Select(graph.Not)], High)),
            _ => throw new NativeException($"Operator '{OperatorText.Symbol(unary.Operator)}' requires script.")
        };
    }

    private IValue Binary(BoundBinary binary, Dictionary<Variable, IValue> locals)
    {
        var left = Evaluate(binary.Left, locals);
        if (left is Literal { Scalar.Value: bool constant } &&
            (binary.Operator == BinaryOperator.LogicalAnd && !constant || binary.Operator == BinaryOperator.LogicalOr && constant))
            return left;
        var right = Evaluate(binary.Right, locals);
        if (left is Literal a && right is Literal b)
        {
            try
            {
                return new Literal(Constants.Binary(binary.Type, binary.Operator, a.Scalar, b.Scalar));
            }
            catch (ArithmeticException)
            {
                throw new NativeException("Invalid arithmetic during circuit elaboration.");
            }
        }

        var bits = ToBits(left);
        if (binary.Operator is BinaryOperator.ShiftLeft or BinaryOperator.ShiftRight && right is Literal { Scalar.Value: int shift })
        {
            shift &= 31;
            var fill = binary.Operator == BinaryOperator.ShiftRight && binary.Left.Type.Shape.Kind == TypeKind.Int
                ? bits[^1] : Low;
            return new Signal([.. Enumerable.Range(0, bits.Length).Select(index =>
            {
                var source = binary.Operator == BinaryOperator.ShiftLeft ? index - shift : index + shift;
                return source >= 0 && source < bits.Length ? bits[source] : fill;
            })]);
        }
        var other = ToBits(right);
        return binary.Operator switch
        {
            BinaryOperator.BitwiseAnd or BinaryOperator.LogicalAnd => Pair(bits, other, graph.And),
            BinaryOperator.BitwiseOr or BinaryOperator.LogicalOr => Pair(bits, other, graph.Or),
            BinaryOperator.BitwiseXor => Pair(bits, other, graph.Xor),
            BinaryOperator.Add => new Signal(Add(bits, other, Low)),
            BinaryOperator.Subtract => new Signal(Add(bits, [.. other.Select(graph.Not)], High)),
            BinaryOperator.Equal or BinaryOperator.NotEqual => new Signal([Equality(bits, other, binary.Operator == BinaryOperator.Equal)]),
            _ => throw new NativeException($"Operator '{OperatorText.Symbol(binary.Operator)}' requires script for live values.")
        };
    }

    private static Signal Pair(int[] left, int[] right, Func<int, int, int> operation) => new([.. left.Zip(right, operation)]);

    private int Equality(int[] left, int[] right, bool equal)
    {
        var difference = Low;
        for (var i = 0; i < left.Length; i++)
            difference = graph.Or(difference, graph.Xor(left[i], right[i]));
        return equal ? graph.Not(difference) : difference;
    }

    private int[] Add(int[] left, int[] right, int carry)
    {
        var sum = new int[left.Length];
        for (var i = 0; i < sum.Length; i++)
        {
            var xor = graph.Xor(left[i], right[i]);
            sum[i] = graph.Xor(xor, carry);
            if (i < sum.Length - 1)
                carry = graph.Or(graph.And(left[i], right[i]), graph.And(xor, carry));
        }
        return sum;
    }

    private static IValue Convert(BoundConversion conversion, IValue value)
    {
        if (conversion.InterfaceTag is int tag)
            return new InterfaceValue(tag, value);
        if (value is Literal literal)
            return new Literal(Constants.Convert(conversion.Type, literal.Scalar));
        var width = conversion.Type.Shape.Kind == TypeKind.Int ? 32 : conversion.Type.IsSignal ? conversion.Type.Width : 0;
        if (width == 0)
            throw new NativeException($"Conversion to '{conversion.Type}' requires script.");
        var bits = ToBits(value);
        return new Signal([.. Enumerable.Range(0, width).Select(index => index < bits.Length ? bits[index] : Low)]);
    }

    private IValue Index(BoundIndex index, Dictionary<Variable, IValue> locals)
    {
        var receiver = Evaluate(index.Receiver, locals);
        if (receiver is Literal { Scalar.Value: ImportedFile file })
        {
            var (offset, selectors) = IndexAddress(index, file.Data.Length, locals);
            return ReadIndex(offset, selectors, 0, i => new Literal(new BoundLiteral(index.Type, (uint)file.Data.Span[i])));
        }
        if (index.Receiver.Type.Shape.Kind == TypeKind.Bytes)
            throw new NativeException("Reading a runtime byte buffer requires script.");
        var (address, variableBits) = IndexAddress(index, index.Receiver.Type.Shape.Size, locals);
        if (receiver is ArrayValue array)
            return ReadIndex(address, variableBits, 0, i => array.Items[i]);
        var bits = ToBits(receiver);
        return ReadIndex(address, variableBits, 0, i => new Signal([bits[i]]));
    }

    private (int Address, (int Position, int Signal)[] VariableBits) IndexAddress(
        BoundIndex index, int count, Dictionary<Variable, IValue> locals)
    {
        var selector = Evaluate(index.Index, locals);
        if (selector is Literal { Scalar.Value: int offset })
        {
            if (offset < 0 || offset >= count)
                throw new NativeException($"Index {offset} is outside the native value's {count} elements.");
            return (offset, []);
        }

        var bits = ToBits(selector);
        uint address = 0;
        uint maximum = 0;
        List<(int Position, int Signal)> variableBits = [];
        for (var position = 0; position < bits.Length; position++)
        {
            var bit = bits[position];
            if (bit != Low)
                maximum |= 1u << position;
            if (bit == High)
                address |= 1u << position;
            else if (bit != Low)
                variableBits.Add((position, bit));
        }
        if (maximum >= (uint)count)
            throw new NativeException($"The native index can be outside the value's {count} elements.");
        return ((int)address, [.. variableBits]);
    }

    private IValue ReadIndex(int address, (int Position, int Signal)[] variableBits, int depth, Func<int, IValue> read)
    {
        if (depth == variableBits.Length)
            return read(address);
        var (position, bit) = variableBits[depth];
        return Merge(bit,
            ReadIndex(address | (1 << position), variableBits, depth + 1, read),
            ReadIndex(address, variableBits, depth + 1, read));
    }

    private IValue UpdateIndex(IValue receiver, int address, (int Position, int Signal)[] variableBits, IValue value)
    {
        if (receiver is ArrayValue array)
        {
            IValue[] items = [.. array.Items];
            Update(address, 0, High, (offset, enable) => items[offset] = Merge(enable, value, items[offset]));
            return new ArrayValue(items);
        }

        int[] bits = [.. ToBits(receiver)];
        var newBit = ToBits(value)[0];
        Update(address, 0, High, (offset, enable) => bits[offset] = graph.Select(enable, newBit, bits[offset]));
        return new Signal(bits);

        void Update(int offset, int depth, int enable, Action<int, int> assign)
        {
            if (depth == variableBits.Length)
            {
                assign(offset, enable);
                return;
            }
            var (position, bit) = variableBits[depth];
            Update(offset, depth + 1, graph.And(enable, graph.Not(bit)), assign);
            Update(offset | (1 << position), depth + 1, graph.And(enable, bit), assign);
        }
    }

    private static int[] ToBits(IValue value) => value switch
    {
        Signal signal => signal.Bits,
        Literal { Scalar.Value: bool bit } => [bit ? High : Low],
        Literal { Scalar.Value: uint bits } literal => LiteralBits(bits, literal.Scalar.Type.Width),
        Literal { Scalar.Value: int number } => LiteralBits(unchecked((uint)number), 32),
        _ => throw new NativeException("Value has no native signal representation.")
    };

    private static int[] LiteralBits(uint value, int width) =>
        [.. Enumerable.Range(0, width).Select(index => (value & (1u << index)) != 0 ? High : Low)];
}
