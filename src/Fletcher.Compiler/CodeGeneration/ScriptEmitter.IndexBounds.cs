using System.Numerics;
using Fletcher.Compiler.IR;

namespace Fletcher.Compiler.CodeGeneration;

internal sealed partial class ScriptEmitter
{
    private readonly Dictionary<Variable, List<BoundExpression>> indexWrites = [];
    private readonly Dictionary<Variable, BoundExpression> indexLoops = [];
    private readonly HashSet<Variable> initializedIndexLocals = [];
    private readonly Dictionary<Variable, NumberBounds> indexVariableBounds = [];
    private readonly HashSet<Variable> resolvingIndexBounds = [];

    private void AnalyzeIndexBounds(IEnumerable<BoundBlock?> bodies)
    {
        // Gather every possible scalar write, including assignments after the
        // read. Cycles are conservative, and loop indices have an implicit write.
        foreach (var statement in bodies.SelectMany(BoundTree.Statements))
        {
            switch (statement)
            {
                case BoundLocals locals:
                    for (var i = 0; i < locals.Symbols.Length; i++)
                    {
                        var symbol = locals.Symbols[i];
                        if (locals.IsNew[i] && symbol?.Type.Shape.Kind == TypeKind.Int)
                            initializedIndexLocals.Add(symbol);
                        RecordIndexWrite(symbol, locals.Values[i]);
                    }
                    break;
                case BoundAssignment assignment:
                    for (var i = 0; i < assignment.Targets.Length; i++)
                        if (assignment.Targets[i] is BoundVariable target)
                            RecordIndexWrite(target.Symbol, assignment.Values[i]);
                    break;
                case BoundRange { Index: { } index, Collection.Type.Shape.Kind: TypeKind.Int or TypeKind.Array } loop:
                    initializedIndexLocals.Add(index);
                    indexLoops[index] = loop.Collection;
                    break;
            }
        }
    }

    private void RecordIndexWrite(Variable? symbol, BoundExpression source)
    {
        if (symbol?.Kind != SymbolKind.Local || symbol.Type.Shape.Kind != TypeKind.Int)
            return;
        if (!indexWrites.TryGetValue(symbol, out var writes))
            indexWrites.Add(symbol, writes = []);
        writes.Add(source);
    }

    private NumberBounds IndexBounds(BoundExpression expression)
    {
        var domain = NumberBounds.For(expression.Type);
        NumberBounds candidate = expression switch
        {
            BoundLiteral { Value: int value } => new(value, value),
            BoundLiteral { Value: uint value } => new(value, value),
            BoundVariable { Symbol: var symbol } when symbol.Type.Shape.Kind == TypeKind.Int =>
                IndexBoundsForVariable(symbol),
            BoundConversion { InterfaceTag: null, Operand.Type.IsNumber: true } conversion =>
                IndexBounds(conversion.Operand),
            BoundBinary binary when binary.Left.Type.IsNumber && binary.Right.Type.IsNumber =>
                BoundsForBinary(binary, domain),
            _ => domain
        };
        return candidate.Min >= domain.Min && candidate.Max <= domain.Max ? candidate : domain;
    }

    private NumberBounds IndexBoundsForVariable(Variable symbol)
    {
        // Parameters and range elements can enter with values that do not
        // appear in the assignment list.
        if (!initializedIndexLocals.Contains(symbol))
            return NumberBounds.Int;
        if (indexVariableBounds.TryGetValue(symbol, out var known))
            return known;
        if (!resolvingIndexBounds.Add(symbol))
            return NumberBounds.Int;

        NumberBounds? bounds = null;
        if (indexLoops.TryGetValue(symbol, out var collection))
        {
            var length = collection.Type.Shape.Kind == TypeKind.Array
                ? collection.Type.Shape.Size : IndexBounds(collection).Max;
            bounds = new(0, Math.Max(0, length - 1));
        }
        if (indexWrites.TryGetValue(symbol, out var writes))
        {
            foreach (var write in writes)
            {
                var candidate = IndexBounds(write);
                bounds = bounds is { } previous
                    ? new(Math.Min(previous.Min, candidate.Min), Math.Max(previous.Max, candidate.Max))
                    : candidate;
            }
        }
        resolvingIndexBounds.Remove(symbol);
        return indexVariableBounds[symbol] = bounds ?? NumberBounds.Int;
    }

    private NumberBounds BoundsForBinary(BoundBinary binary, NumberBounds domain)
    {
        var left = IndexBounds(binary.Left);
        var right = IndexBounds(binary.Right);
        return binary.Operator switch
        {
            BinaryOperator.Add => new(left.Min + right.Min, left.Max + right.Max),
            BinaryOperator.Subtract => new(left.Min - right.Max, left.Max - right.Min),
            BinaryOperator.BitwiseAnd when left.Min >= 0 && right.Min >= 0 => new(0, Math.Min(left.Max, right.Max)),
            BinaryOperator.BitwiseAnd when left.Min >= 0 => new(0, left.Max),
            BinaryOperator.BitwiseAnd when right.Min >= 0 => new(0, right.Max),
            BinaryOperator.BitwiseOr or BinaryOperator.BitwiseXor when left.Min >= 0 && right.Min >= 0 =>
                new(0, LowBitsMask(Math.Max(left.Max, right.Max))),
            BinaryOperator.ShiftLeft when right.Min == right.Max =>
                new(left.Min << (int)(right.Min & 31), left.Max << (int)(right.Min & 31)),
            BinaryOperator.ShiftRight when right.Min == right.Max =>
                new(left.Min >> (int)(right.Min & 31), left.Max >> (int)(right.Min & 31)),
            _ => domain
        };
    }

    private static long LowBitsMask(long max) => (long)BitOperations.RoundUpToPowerOf2((ulong)max + 1) - 1;

    private readonly record struct NumberBounds(long Min, long Max)
    {
        public static NumberBounds Int => new(int.MinValue, int.MaxValue);

        public static NumberBounds For(DataType type) => type.Shape.Kind == TypeKind.Bits
            ? new(0, (1L << type.Width) - 1) : Int;
    }
}
