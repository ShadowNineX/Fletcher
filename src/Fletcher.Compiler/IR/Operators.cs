namespace Fletcher.Compiler.IR;

internal enum UnaryOperator { Plus, Negate, LogicalNot, BitwiseNot }

internal enum BinaryOperator
{
    Add, Subtract, Multiply, Divide, Remainder, ShiftLeft, ShiftRight,
    BitwiseAnd, BitwiseOr, BitwiseXor, LogicalAnd, LogicalOr,
    Equal, NotEqual, LessThan, LessThanOrEqual, GreaterThan, GreaterThanOrEqual
}

internal enum EffectKind { Log, Pixel, ScreenPalette, PreserveScreen, RevealScreen, Discard }

internal static class OperatorText
{
    public static string Symbol(UnaryOperator op) => op switch
    {
        UnaryOperator.Plus => "+",
        UnaryOperator.Negate => "-",
        UnaryOperator.LogicalNot => "!",
        UnaryOperator.BitwiseNot => "~",
        _ => throw new ArgumentOutOfRangeException(nameof(op))
    };

    public static string Symbol(BinaryOperator op) => op switch
    {
        BinaryOperator.Add => "+",
        BinaryOperator.Subtract => "-",
        BinaryOperator.Multiply => "*",
        BinaryOperator.Divide => "/",
        BinaryOperator.Remainder => "%",
        BinaryOperator.ShiftLeft => "<<",
        BinaryOperator.ShiftRight => ">>",
        BinaryOperator.BitwiseAnd => "&",
        BinaryOperator.BitwiseOr => "|",
        BinaryOperator.BitwiseXor => "^",
        BinaryOperator.LogicalAnd => "&&",
        BinaryOperator.LogicalOr => "||",
        BinaryOperator.Equal => "==",
        BinaryOperator.NotEqual => "!=",
        BinaryOperator.LessThan => "<",
        BinaryOperator.LessThanOrEqual => "<=",
        BinaryOperator.GreaterThan => ">",
        BinaryOperator.GreaterThanOrEqual => ">=",
        _ => throw new ArgumentOutOfRangeException(nameof(op))
    };
}
