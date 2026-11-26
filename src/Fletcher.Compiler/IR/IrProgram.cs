using System.Collections.Immutable;
using Fletcher.Compiler.Maps;
using Fletcher.Compiler.Syntax;

namespace Fletcher.Compiler.IR;

internal enum TypeKind { Error, Void, Bit, Bits, Int, String, Bytes, Color, Array, Struct, Interface, Defined }

internal sealed class DataType(TypeKind kind, string name, int size = 0)
{
    public TypeKind Kind { get; } = kind;
    public string Name { get; } = name;
    public int Size { get; } = size;
    public DataType? Element { get; set; }
    public DataType[] Arguments { get; init; } = [];
    public bool IsResultList { get; init; }
    public Dictionary<string, DataType> Fields { get; } = [with(StringComparer.Ordinal)];
    public Dictionary<string, MethodSignature> Methods { get; } = [with(StringComparer.Ordinal)];
    public DataType Shape => Kind == TypeKind.Defined && Element is { } element ? element.Shape : this;
    public bool IsSignal => Shape.Kind is TypeKind.Bit or TypeKind.Bits;
    public bool IsNumber => Shape.Kind is TypeKind.Int or TypeKind.Bits;
    public int Width => Shape.Kind == TypeKind.Bits ? Shape.Size : 1;

    public override string ToString() => Name;

    public static DataType Error { get; } = new(TypeKind.Error, "<error>");
    public static DataType Void { get; } = new(TypeKind.Void, "void");
    public static DataType Bit { get; } = new(TypeKind.Bit, "bit");
    public static DataType Int { get; } = new(TypeKind.Int, "int");
    public static DataType String { get; } = new(TypeKind.String, "string");
    public static DataType Bytes { get; } = new(TypeKind.Bytes, "bytes");
    public static DataType Color { get; } = new(TypeKind.Color, "color");
}

internal sealed record MethodSignature(DataType[] Parameters, DataType Result);

internal enum SymbolKind { Local, Constant, Input, Output, Wire, Register }

internal sealed record Variable(int Id, string Name, DataType Type, SymbolKind Kind)
{
    public bool IsMapValue => Kind is SymbolKind.Input or SymbolKind.Output or SymbolKind.Wire or SymbolKind.Register;
}

internal sealed class Function(int id, string name, Variable[] parameters, DataType result, Variable? receiver,
    bool requiresCircuit = false)
{
    public int Id { get; } = id;
    public string Name { get; } = name;
    public Variable[] Parameters { get; } = parameters;
    public DataType Result { get; } = result;
    public Variable? Receiver { get; } = receiver;
    // A function declared in a `backend circuit` compilation unit (or one
    // that reaches one) cannot be emitted into the JavaScript backend.
    public bool RequiresCircuit { get; set; } = requiresCircuit;
    public BoundBlock? Body { get; set; }
}

internal enum Backend { Auto, Circuit, Script }

internal sealed record Binding(Variable Symbol, BoundExpression Value, Backend Backend, bool Published = false, bool HostPublished = false);
internal sealed record KeyboardGroup(ImmutableArray<ushort> KeyIds, bool Exclusive, bool GateReads);
internal sealed record Port(Variable Symbol, Position? Anchor, ushort? Key = null, bool Buffer = false,
    byte? Forward = null, ushort? LampStyle = null, bool Tap = false, KeyboardGroup? Keys = null, int? TapPitch = null,
    int? OutputPitch = null);
internal sealed record Register(Variable Symbol, BoundExpression Initial);
internal readonly record struct RgbLampPair(Position First, byte Facing, Position Second, byte Opposite, ushort Signal);
internal sealed record Screen(Tile Background, int Width, int Height, ushort Foreground, bool Hold = false, bool Slice = false,
    int Scale = 1, bool ArrowDisplay = false, int SliceWork = 0, bool RgbDisplay = false, bool RgbLamps = false)
{
    public const int ArrowDisplayScale = 4;
    public const int RgbDisplayScale = 2;
    public const int RgbLampScale = 3;
    public const byte ForwardingLampType = 28;
    public const ushort BrightLampFlag = 16;
    public static IReadOnlyList<RgbLampPair> LampPairs { get; } =
    [
        new(new Position(0, 0), 1, new Position(1, 0), 3, (ushort)TileColor.Red),
        new(new Position(2, 0), 2, new Position(2, 1), 0, (ushort)TileColor.Green),
        new(new Position(0, 1), 2, new Position(0, 2), 0, (ushort)TileColor.Blue),
        new(new Position(1, 2), 1, new Position(2, 2), 3, (ushort)TileColor.Green),
    ];
    public bool UsesRgbPalette => RgbDisplay || RgbLamps;
    public bool IsSolid => Background.Type == 25;
    public bool IsSliced => IsSolid && Slice;
    public int PixelCount => Width * Height;
    public int TileWidth => Width * Scale;
    public int TileHeight => Height * Scale;
}

internal sealed record IrProgram(
    string Name,
    IReadOnlyList<Port> Ports,
    IReadOnlyList<Binding> Bindings,
    IReadOnlyList<Register> Registers,
    IReadOnlyList<Tile> ManualTiles,
    Screen? Screen,
    BoundBlock? Tick,
    IReadOnlyDictionary<DataType, Dictionary<string, Function>> Methods,
    IReadOnlyDictionary<DataType, int> TypeTags)
{
    public IReadOnlyList<Function> Functions { get; init; } = [];
    public BoundTest[] Tests { get; init; } = [];
    public BoundBlock? HostTick { get; init; }
}

internal sealed record BoundTest(string Name, TextSpan Span, BoundBlock Body);

internal closed record BoundExpression(DataType Type);
internal sealed record BoundLiteral(DataType LiteralType, object Value, bool IsUntyped = false) : BoundExpression(LiteralType);
internal sealed record ConstantArray(ImmutableArray<BoundLiteral> Items);
internal enum InterfaceLiteral { Null }
internal sealed record BoundVariable(Variable Symbol) : BoundExpression(Symbol.Type);
internal sealed record BoundUnary(DataType ResultType, UnaryOperator Operator, BoundExpression Operand) : BoundExpression(ResultType);
internal sealed record BoundBinary(DataType ResultType, BinaryOperator Operator, BoundExpression Left, BoundExpression Right) : BoundExpression(ResultType);
internal sealed record BoundConversion(DataType Target, BoundExpression Operand, int? InterfaceTag = null) : BoundExpression(Target);
internal sealed record BoundCall(Function Function, BoundExpression? Receiver, BoundExpression[] Arguments) : BoundExpression(Function.Result);
internal sealed record BoundDispatch(DataType ResultType, string Method, BoundExpression Receiver, BoundExpression[] Arguments) : BoundExpression(ResultType);
internal sealed record BoundMember(DataType MemberType, BoundExpression Receiver, string Name) : BoundExpression(MemberType);
internal sealed record BoundIndex(DataType ElementType, BoundExpression Receiver, BoundExpression Index) : BoundExpression(ElementType);
internal sealed record BoundByteLength(BoundExpression Receiver) : BoundExpression(DataType.Int);
internal sealed record BoundSharedBytes(string Key) : BoundExpression(DataType.Bytes);
internal sealed record BoundStruct(DataType StructType, IReadOnlyDictionary<string, BoundExpression> Fields) : BoundExpression(StructType);
internal sealed record BoundArray(DataType ArrayType, BoundExpression[] Elements) : BoundExpression(ArrayType);
internal sealed record BoundCurrentTick() : BoundExpression(DataType.Int);
internal sealed record BoundHostTimeMillis() : BoundExpression(DataType.Int);
internal sealed record BoundMousePosition(bool Horizontal) : BoundExpression(DataType.Int);
internal sealed record BoundPixelIndexAt(BoundExpression X, BoundExpression Y) : BoundExpression(DataType.Int);
internal sealed record BoundCaptureScreen(BoundExpression Previous) : BoundExpression(DataType.String);
internal sealed record BoundSameFile(BoundExpression Left, BoundExpression Right) : BoundExpression(DataType.Bit);

internal closed record BoundStatement;
internal sealed record BoundBlock(BoundStatement[] Statements) : BoundStatement;
internal sealed record BoundResultSource(Variable Temporary, BoundExpression Call);
internal sealed record BoundLocals(Variable?[] Symbols, bool[] IsNew, BoundExpression[] Values, BoundResultSource? ResultSource = null) : BoundStatement;
internal sealed record BoundAssignment(BoundExpression?[] Targets, BoundExpression[] Values, BoundResultSource? ResultSource = null) : BoundStatement;
internal sealed record BoundIf(BoundExpression Condition, BoundBlock Then, BoundStatement? Else) : BoundStatement;
internal sealed record BoundSwitch(BoundExpression Selector, BoundCase[] Cases, BoundBlock? Default) : BoundStatement;
internal sealed record BoundCase(BoundLiteral[] Values, BoundBlock Body);
internal sealed record BoundRange(Variable? Index, Variable? Value, BoundExpression Collection, BoundBlock Body) : BoundStatement;
internal sealed record BoundReturn(BoundExpression? Value) : BoundStatement;
internal sealed record BoundNext(Variable Register, BoundExpression Value) : BoundStatement;
internal sealed record BoundEffect(EffectKind Kind, BoundExpression[] Arguments) : BoundStatement;
internal sealed record BoundAssertion(bool Equality, BoundExpression[] Arguments, TextSpan Span) : BoundStatement;

internal static class BoundTree
{
    public static IEnumerable<Variable> References(BoundExpression expression)
    {
        if (expression is BoundVariable variable)
            yield return variable.Symbol;

        foreach (var child in Children(expression))
        {
            foreach (var reference in References(child))
            {
                yield return reference;
            }
        }
    }

    public static IEnumerable<Variable> References(BoundStatement? statement)
        => RootExpressions(statement).SelectMany(References);

    public static IEnumerable<Function> Calls(BoundStatement? statement)
        => RootExpressions(statement).SelectMany(Calls);

    public static IEnumerable<Function> Calls(BoundExpression expression)
        => Descendants(expression).OfType<BoundCall>().Select(call => call.Function);

    public static IEnumerable<BoundDispatch> Dispatches(BoundStatement? statement)
        => RootExpressions(statement).SelectMany(Dispatches);

    public static IEnumerable<BoundDispatch> Dispatches(BoundExpression expression)
        => Descendants(expression).OfType<BoundDispatch>();

    public static bool HasLoopOrCall(BoundStatement? statement) =>
        Statements(statement).Any(item => item is BoundRange) ||
        RootExpressions(statement).Any(root => Descendants(root).Any(item => item is BoundCall or BoundDispatch));

    public static bool UsesMouse(BoundStatement? statement) => RootExpressions(statement).Any(UsesMouse);
    public static bool UsesMouse(BoundExpression expression) => Descendants(expression).Any(item => item is BoundMousePosition);
    public static IEnumerable<BoundStruct> StructLiterals(BoundStatement? statement) =>
        RootExpressions(statement).SelectMany(StructLiterals);
    public static IEnumerable<BoundStruct> StructLiterals(BoundExpression expression) =>
        Descendants(expression).OfType<BoundStruct>();
    public static bool UsesPixelIndices(BoundStatement? statement) => RootExpressions(statement).Any(UsesPixelIndices);
    public static bool UsesPixelIndices(BoundExpression expression) => Descendants(expression).Any(item => item is BoundPixelIndexAt);

    public static IEnumerable<Variable> RegisterWrites(BoundStatement? statement) =>
        Statements(statement).OfType<BoundNext>().Select(next => next.Register);

    public static bool UsesScreenOrMouse(BoundStatement? statement) =>
        Statements(statement).OfType<BoundEffect>().Any(effect =>
            effect.Kind is EffectKind.Pixel or EffectKind.ScreenPalette or EffectKind.PreserveScreen or EffectKind.RevealScreen) ||
        RootExpressions(statement).Any(UsesScreenOrMouse);

    public static bool UsesScreenOrMouse(BoundExpression expression) =>
        Descendants(expression).Any(item => item is BoundMousePosition or BoundPixelIndexAt or BoundCaptureScreen);

    public static IEnumerable<BoundStatement> Statements(BoundStatement? statement)
    {
        if (statement is null)
            yield break;
        yield return statement;
        IEnumerable<BoundStatement> children = statement switch
        {
            BoundBlock block => block.Statements,
            BoundIf conditional => conditional.Else is { } alternative ? [conditional.Then, alternative] : [conditional.Then],
            BoundSwitch selection => selection.Default is { } otherwise
                ? [.. selection.Cases.Select(clause => clause.Body), otherwise]
                : selection.Cases.Select(clause => clause.Body),
            BoundRange loop => [loop.Body],
            _ => []
        };
        foreach (var child in children)
            foreach (var nested in Statements(child))
                yield return nested;
    }

    // Function parameters and receivers need a defensive composite copy only
    // when their own value is used as an lvalue container. Calls receive their
    // own value parameters, so a call/dispatch alone cannot mutate this local.
    public static bool WritesThrough(BoundStatement? statement, Variable local) => statement switch
    {
        BoundBlock block => Array.Exists(block.Statements, item => WritesThrough(item, local)),
        BoundAssignment assignment => Array.Exists(assignment.Targets, target => target is not null &&
            target is not BoundVariable && StorageRoot(target) == local),
        BoundIf conditional => WritesThrough(conditional.Then, local) || WritesThrough(conditional.Else, local),
        BoundSwitch selection => Array.Exists(selection.Cases, clause => WritesThrough(clause.Body, local)) ||
            WritesThrough(selection.Default, local),
        BoundRange loop => WritesThrough(loop.Body, local),
        _ => false
    };

    public static Variable? StorageRoot(BoundExpression target) => target switch
    {
        BoundVariable variable => variable.Symbol,
        BoundMember member => StorageRoot(member.Receiver),
        BoundIndex index => StorageRoot(index.Receiver),
        _ => null
    };

    private static IEnumerable<BoundExpression> Descendants(BoundExpression expression)
    {
        yield return expression;
        foreach (var child in Children(expression))
        {
            foreach (var nested in Descendants(child))
            {
                yield return nested;
            }
        }
    }

    private static IEnumerable<BoundExpression> RootExpressions(BoundStatement? statement)
    {
        return statement switch
        {
            BoundBlock block => block.Statements.SelectMany(RootExpressions),
            BoundLocals locals => AssignmentValues(locals.Values, locals.ResultSource),
            BoundAssignment assignment => assignment.Targets.OfType<BoundExpression>().Concat(AssignmentValues(assignment.Values, assignment.ResultSource)),
            BoundIf conditional => RootExpressions(conditional.Then).Prepend(conditional.Condition).Concat(RootExpressions(conditional.Else)),
            BoundSwitch selection => selection.Cases.SelectMany(clause => RootExpressions(clause.Body))
                .Prepend(selection.Selector).Concat(RootExpressions(selection.Default)),
            BoundRange loop => RootExpressions(loop.Body).Prepend(loop.Collection),
            BoundReturn { Value: { } value } => [value],
            BoundNext next => [next.Value],
            BoundEffect effect => effect.Arguments,
            BoundAssertion assertion => assertion.Arguments,
            BoundReturn or null => []
        };
    }

    private static IEnumerable<BoundExpression> AssignmentValues(BoundExpression[] values, BoundResultSource? source) =>
        source is null ? values : values.Prepend(source.Call);

    private static IEnumerable<BoundExpression> Children(BoundExpression expression) => expression switch
    {
        BoundUnary unary => [unary.Operand],
        BoundBinary binary => [binary.Left, binary.Right],
        BoundConversion conversion => [conversion.Operand],
        BoundCall { Receiver: { } receiver } call => [receiver, .. call.Arguments],
        BoundCall call => call.Arguments,
        BoundDispatch call => [call.Receiver, .. call.Arguments],
        BoundMember member => [member.Receiver],
        BoundIndex index => [index.Receiver, index.Index],
        BoundByteLength length => [length.Receiver],
        BoundPixelIndexAt sample => [sample.X, sample.Y],
        BoundCaptureScreen capture => [capture.Previous],
        BoundSameFile same => [same.Left, same.Right],
        BoundStruct structure => structure.Fields.Values,
        BoundArray array => array.Elements,
        BoundLiteral or BoundVariable or BoundCurrentTick or BoundHostTimeMillis or BoundMousePosition or BoundSharedBytes => []
    };
}
