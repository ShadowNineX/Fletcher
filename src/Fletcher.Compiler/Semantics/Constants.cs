using System.Collections.Immutable;
using Fletcher.Compiler.IR;

namespace Fletcher.Compiler.Semantics;

internal static class Constants
{
    public static BoundLiteral? EvaluateDeclaration(BoundExpression value)
    {
        if (value is not BoundArray array)
            return Evaluate(value);

        var items = ImmutableArray.CreateBuilder<BoundLiteral>(array.Elements.Length);
        foreach (var element in array.Elements)
        {
            if (EvaluateDeclaration(element) is not { } constant)
                return null;
            items.Add(constant with { IsUntyped = false });
        }
        return new BoundLiteral(array.Type, new ConstantArray(items.MoveToImmutable()));
    }

    public static BoundExpression? EvaluateRegisterInitializer(BoundExpression value)
    {
        if (value is BoundConversion { InterfaceTag: not null } box)
        {
            return EvaluateRegisterInitializer(box.Operand) is { } payload ? box with { Operand = payload } : null;
        }
        if (value is BoundArray array)
        {
            var elements = new BoundExpression[array.Elements.Length];
            for (var i = 0; i < elements.Length; i++)
            {
                if (EvaluateRegisterInitializer(array.Elements[i]) is not { } element)
                    return null;
                elements[i] = element;
            }
            return array with { Elements = elements };
        }
        if (value is BoundStruct structure)
        {
            Dictionary<string, BoundExpression> fields = [with(structure.Fields.Count, StringComparer.Ordinal)];
            foreach (var (name, expression) in structure.Fields)
            {
                if (EvaluateRegisterInitializer(expression) is not { } field)
                    return null;
                fields.Add(name, field);
            }
            return structure with { Fields = fields };
        }
        return Evaluate(value);
    }

    public static BoundLiteral? Evaluate(BoundExpression value)
    {
        if (value is BoundLiteral literal)
            return literal;

        if (value is BoundBinary { Operator: BinaryOperator.LogicalAnd or BinaryOperator.LogicalOr } logic &&
            Evaluate(logic.Left) is { Value: bool left } first &&
            (logic.Operator == BinaryOperator.LogicalAnd ? !left : left))
        {
            return new BoundLiteral(value.Type, left, first.IsUntyped && logic.Right is BoundLiteral { IsUntyped: true });
        }

        return value switch
        {
            BoundUnary unary when Evaluate(unary.Operand) is { } operand => Unary(unary.Type, unary.Operator, operand),
            BoundBinary binary when Evaluate(binary.Left) is { } a && Evaluate(binary.Right) is { } b
                => Binary(binary.Type, binary.Operator, a, b),
            BoundConversion { InterfaceTag: null } conversion when Evaluate(conversion.Operand) is { } operand
                => Convert(conversion.Type, operand),
            _ => null
        };
    }

    public static BoundLiteral Unary(DataType type, UnaryOperator op, BoundLiteral operand)
    {
        object result = operand.Value switch
        {
            bool bit when op == UnaryOperator.LogicalNot => !bit,
            int number => op switch
            {
                UnaryOperator.Plus => number,
                UnaryOperator.Negate => unchecked(-number),
                UnaryOperator.BitwiseNot => ~number,
                _ => throw new InvalidOperationException($"Invalid constant unary operator '{OperatorText.Symbol(op)}'.")
            },
            uint number => op switch
            {
                UnaryOperator.Plus => number,
                UnaryOperator.Negate => Mask(type, unchecked(0u - number)),
                UnaryOperator.BitwiseNot => Mask(type, ~number),
                _ => throw new InvalidOperationException($"Invalid constant unary operator '{OperatorText.Symbol(op)}'.")
            },
            _ => throw new InvalidOperationException("Invalid constant unary operator.")
        };
        return new BoundLiteral(type, result, operand.IsUntyped);
    }

    public static BoundLiteral Binary(DataType type, BinaryOperator op, BoundLiteral left, BoundLiteral right)
    {
        object result;
        if (op is BinaryOperator.Equal or BinaryOperator.NotEqual)
        {
            result = Equals(left.Value, right.Value) == (op == BinaryOperator.Equal);
        }
        else if (left.Value is bool a && right.Value is bool b)
        {
            result = op switch
            {
                BinaryOperator.BitwiseAnd or BinaryOperator.LogicalAnd => a && b,
                BinaryOperator.BitwiseOr or BinaryOperator.LogicalOr => a || b,
                BinaryOperator.BitwiseXor => a != b,
                _ => throw new InvalidOperationException($"Invalid constant signal operator '{OperatorText.Symbol(op)}'.")
            };
        }
        else if (left.Value is int x && right.Value is int y)
        {
            result = op switch
            {
                BinaryOperator.Add => unchecked(x + y), BinaryOperator.Subtract => unchecked(x - y), BinaryOperator.Multiply => unchecked(x * y),
                BinaryOperator.Divide => unchecked((int)((long)x / y)), BinaryOperator.Remainder => (int)((long)x % y),
                BinaryOperator.BitwiseAnd => x & y, BinaryOperator.BitwiseOr => x | y, BinaryOperator.BitwiseXor => x ^ y,
                BinaryOperator.ShiftLeft => x << y, BinaryOperator.ShiftRight => x >> y,
                BinaryOperator.LessThan => x < y, BinaryOperator.LessThanOrEqual => x <= y, BinaryOperator.GreaterThan => x > y, BinaryOperator.GreaterThanOrEqual => x >= y,
                _ => throw new InvalidOperationException($"Invalid constant integer operator '{OperatorText.Symbol(op)}'.")
            };
        }
        else if (left.Value is uint u)
        {
            var v = right.Value is int count ? unchecked((uint)count) : (uint)right.Value;
            result = op switch
            {
                BinaryOperator.Add => Mask(type, unchecked(u + v)), BinaryOperator.Subtract => Mask(type, unchecked(u - v)),
                BinaryOperator.Multiply => Mask(type, unchecked(u * v)), BinaryOperator.Divide => u / v, BinaryOperator.Remainder => u % v,
                BinaryOperator.BitwiseAnd => u & v, BinaryOperator.BitwiseOr => u | v, BinaryOperator.BitwiseXor => u ^ v,
                BinaryOperator.ShiftLeft => Mask(type, u << (int)v), BinaryOperator.ShiftRight => u >> (int)v,
                BinaryOperator.LessThan => u < v, BinaryOperator.LessThanOrEqual => u <= v, BinaryOperator.GreaterThan => u > v, BinaryOperator.GreaterThanOrEqual => u >= v,
                _ => throw new InvalidOperationException($"Invalid constant vector operator '{OperatorText.Symbol(op)}'.")
            };
        }
        else
        {
            result = (string)left.Value + (string)right.Value;
        }
        return new BoundLiteral(type, result, left.IsUntyped && right.IsUntyped);
    }

    public static BoundLiteral Convert(DataType target, BoundLiteral value)
    {
        object result = target.Shape.Kind switch
        {
            TypeKind.Int when value.Value is uint number => unchecked((int)number),
            TypeKind.Bits when value.Value is int number => Mask(target, unchecked((uint)number)),
            TypeKind.Bits when value.Value is uint number => Mask(target, number),
            _ => value.Value
        };
        return new BoundLiteral(target, result);
    }

    public static uint Mask(DataType type, uint value) => type.Width == 32
        ? value
        : value & ((1u << type.Width) - 1);
}
