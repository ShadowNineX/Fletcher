using System.Collections.Immutable;

namespace Fletcher.Compiler.Syntax;

public readonly record struct TextSpan(int Start, int Length)
{
    internal string? SourcePath { get; init; }
    public int End => Start + Length;
    public static TextSpan From(int start, int end) => new(start, end - start);
    internal TextSpan Through(TextSpan last) => From(Start, last.End) with { SourcePath = SourcePath };
}

public sealed record Diagnostic(string Path, TextSpan Span, string Message);
public sealed record ParseResult(CompilationUnitSyntax? Root, IReadOnlyList<Diagnostic> Diagnostics)
{ public bool Success => Root is not null && Diagnostics.Count == 0; }
public abstract record SyntaxNode(TextSpan Span);
public sealed record CompilationUnitSyntax(string? PackageName, ImmutableArray<ImportSyntax> Imports,
    ImmutableArray<DeclarationSyntax> Declarations, MapDeclarationSyntax? Map, TextSpan Span) : SyntaxNode(Span)
{
    public BackendKind? DefaultBackend { get; init; }
}
public sealed record ImportSyntax(string? Alias, string ImportPath, TextSpan Span) : SyntaxNode(Span);
public abstract record DeclarationSyntax(TextSpan Span) : SyntaxNode(Span);
public sealed record ConstDeclarationSyntax(string Name, TypeSyntax? Type, ExpressionSyntax Value, TextSpan Span) : DeclarationSyntax(Span);
public sealed record TypeDeclarationSyntax(string Name, ImmutableArray<TypeParameterSyntax> TypeParameters, bool IsAlias, TypeSyntax Type, TextSpan Span) : DeclarationSyntax(Span);
public sealed record StructDeclarationSyntax(string Name, ImmutableArray<TypeParameterSyntax> TypeParameters, ImmutableArray<FieldSyntax> Fields, TextSpan Span) : DeclarationSyntax(Span);
public sealed record InterfaceDeclarationSyntax(string Name, ImmutableArray<TypeParameterSyntax> TypeParameters, ImmutableArray<MethodSignatureSyntax> Methods, TextSpan Span) : DeclarationSyntax(Span);
public sealed record FunctionDeclarationSyntax(ReceiverSyntax? Receiver, string Name, ImmutableArray<TypeParameterSyntax> TypeParameters, ImmutableArray<ParameterSyntax> Parameters, TypeSyntax? ReturnType, BlockStatementSyntax Body, TextSpan Span) : DeclarationSyntax(Span);
public sealed record TestDeclarationSyntax(string Name, BlockStatementSyntax Body, TextSpan Span) : DeclarationSyntax(Span);
public sealed record MacroDeclarationSyntax(string Name, ImmutableArray<ParameterSyntax> Parameters,
    ImmutableArray<MapMemberSyntax> Members, TextSpan Span) : DeclarationSyntax(Span);
public sealed record ReceiverSyntax(string Name, TypeSyntax Type, TextSpan Span) : SyntaxNode(Span);
public sealed record TypeParameterSyntax(string Name, TypeSyntax? Constraint, TextSpan Span) : SyntaxNode(Span);
public sealed record ParameterSyntax(string Name, TypeSyntax Type, TextSpan Span) : SyntaxNode(Span);
public sealed record FieldSyntax(string Name, TypeSyntax Type, TextSpan Span) : SyntaxNode(Span);
public sealed record MethodSignatureSyntax(string Name, ImmutableArray<TypeParameterSyntax> TypeParameters, ImmutableArray<ParameterSyntax> Parameters, TypeSyntax? ReturnType, TextSpan Span) : SyntaxNode(Span);
public abstract record TypeSyntax(TextSpan Span) : SyntaxNode(Span);
public sealed record MultipleResultTypeSyntax(ImmutableArray<TypeSyntax> Types, TextSpan Span) : TypeSyntax(Span);
public sealed record NamedTypeSyntax(string Name, ImmutableArray<TypeSyntax> TypeArguments, TextSpan Span) : TypeSyntax(Span);
public sealed record BitsTypeSyntax(ExpressionSyntax Width, TextSpan Span) : TypeSyntax(Span);
public sealed record ArrayTypeSyntax(ExpressionSyntax Length, TypeSyntax ElementType, TextSpan Span) : TypeSyntax(Span);
public sealed record MapDeclarationSyntax(string Name, ImmutableArray<MapMemberSyntax> Members, TextSpan Span) : SyntaxNode(Span);
public abstract record MapMemberSyntax(TextSpan Span) : SyntaxNode(Span);
public sealed record InputDeclarationSyntax(string Name, TypeSyntax Type, PositionSyntax? Position, ImmutableArray<OptionSyntax> Options,
    TextSpan Span) : MapMemberSyntax(Span);
public sealed record OutputDeclarationSyntax(string Name, TypeSyntax Type, PositionSyntax? Position, ExpressionSyntax Value, TextSpan Span) : MapMemberSyntax(Span)
{
    public ImmutableArray<OptionSyntax> Options { get; init; } = [];
}
public sealed record WireDeclarationSyntax(string Name, TypeSyntax Type, ExpressionSyntax Value, TextSpan Span) : MapMemberSyntax(Span)
{
    public bool Published { get; init; }
    public bool HostPublished { get; init; }
}
public sealed record RegisterDeclarationSyntax(string Name, TypeSyntax Type, ExpressionSyntax Initializer, TextSpan Span) : MapMemberSyntax(Span);
public sealed record TickBlockSyntax(BlockStatementSyntax Body, TextSpan Span) : MapMemberSyntax(Span)
{
    public bool OnHost { get; init; }
}
public sealed record BackendBlockSyntax(BackendKind Kind, ImmutableArray<MapMemberSyntax> Members, TextSpan Span) : MapMemberSyntax(Span);
public enum BackendKind { Circuit, Script }
public sealed record PlaceDeclarationSyntax(string Kind, PositionSyntax Position, string? Facing, bool Flipped, ImmutableArray<OptionSyntax> Options, TextSpan Span) : MapMemberSyntax(Span);
public sealed record MacroExpansionSyntax(string Name, ImmutableArray<ExpressionSyntax> Arguments, TextSpan Span) : MapMemberSyntax(Span);
public sealed record ScreenDeclarationSyntax(PositionSyntax Origin, PositionSyntax Size, ImmutableArray<OptionSyntax> Options, TextSpan Span) : MapMemberSyntax(Span);
public sealed record PositionSyntax(ExpressionSyntax X, ExpressionSyntax Y, TextSpan Span) : SyntaxNode(Span);
public sealed record OptionSyntax(string Name, ExpressionSyntax Value, TextSpan Span) : SyntaxNode(Span);
public abstract record StatementSyntax(TextSpan Span) : SyntaxNode(Span);
public sealed record BlockStatementSyntax(ImmutableArray<StatementSyntax> Statements, TextSpan Span) : StatementSyntax(Span);
public sealed record ShortVariableStatementSyntax(ImmutableArray<string> Names, ImmutableArray<ExpressionSyntax> Values, TextSpan Span) : StatementSyntax(Span);
public sealed record VariableStatementSyntax(string Name, TypeSyntax? Type, ExpressionSyntax? Value, TextSpan Span) : StatementSyntax(Span);
public sealed record ConstStatementSyntax(ConstDeclarationSyntax Declaration, TextSpan Span) : StatementSyntax(Span);
public sealed record AssignmentStatementSyntax(ImmutableArray<LValueSyntax> Targets, ImmutableArray<ExpressionSyntax> Values, TextSpan Span) : StatementSyntax(Span);
public sealed record IfStatementSyntax(ExpressionSyntax Condition, BlockStatementSyntax Then, StatementSyntax? Else, TextSpan Span) : StatementSyntax(Span);
public sealed record SwitchStatementSyntax(ExpressionSyntax Selector, ImmutableArray<SwitchClauseSyntax> Clauses, TextSpan Span) : StatementSyntax(Span);
public sealed record SwitchClauseSyntax(ImmutableArray<ExpressionSyntax> Values, BlockStatementSyntax Body, TextSpan Span) : SyntaxNode(Span);
public sealed record ForRangeStatementSyntax(string? IndexName, string? ValueName, ExpressionSyntax Source, BlockStatementSyntax Body, TextSpan Span) : StatementSyntax(Span);
public sealed record ReturnStatementSyntax(ImmutableArray<ExpressionSyntax> Values, TextSpan Span) : StatementSyntax(Span);
public sealed record NextStatementSyntax(string Name, ExpressionSyntax Value, TextSpan Span) : StatementSyntax(Span);
public sealed record ExpressionStatementSyntax(ExpressionSyntax Expression, TextSpan Span) : StatementSyntax(Span);
public abstract record LValueSyntax(TextSpan Span) : SyntaxNode(Span);
public sealed record NameLValueSyntax(string Name, TextSpan Span) : LValueSyntax(Span);
public sealed record MemberLValueSyntax(LValueSyntax Target, string Member, TextSpan Span) : LValueSyntax(Span);
public sealed record IndexLValueSyntax(LValueSyntax Target, ExpressionSyntax Index, TextSpan Span) : LValueSyntax(Span);
public abstract record ExpressionSyntax(TextSpan Span) : SyntaxNode(Span);
public sealed record NameExpressionSyntax(string Name, ImmutableArray<TypeSyntax> TypeArguments, TextSpan Span) : ExpressionSyntax(Span);
public sealed record IntegerLiteralExpressionSyntax(string Text, TextSpan Span) : ExpressionSyntax(Span);
public sealed record StringLiteralExpressionSyntax(string Text, TextSpan Span) : ExpressionSyntax(Span);
public sealed record BooleanLiteralExpressionSyntax(bool Value, TextSpan Span) : ExpressionSyntax(Span);
public sealed record UnaryExpressionSyntax(string Operator, ExpressionSyntax Operand, TextSpan Span) : ExpressionSyntax(Span);
public sealed record BinaryExpressionSyntax(ExpressionSyntax Left, string Operator, ExpressionSyntax Right, TextSpan Span) : ExpressionSyntax(Span);
public sealed record CallExpressionSyntax(ExpressionSyntax Target, ImmutableArray<ExpressionSyntax> Arguments, TextSpan Span) : ExpressionSyntax(Span);
public sealed record MemberExpressionSyntax(ExpressionSyntax Target, string Member, TextSpan Span) : ExpressionSyntax(Span);
public sealed record IndexExpressionSyntax(ExpressionSyntax Target, ExpressionSyntax Index, TextSpan Span) : ExpressionSyntax(Span);
public sealed record StructLiteralExpressionSyntax(NamedTypeSyntax Type, ImmutableArray<FieldInitializerSyntax> Fields, TextSpan Span) : ExpressionSyntax(Span);
public sealed record ArrayLiteralExpressionSyntax(ArrayTypeSyntax Type, ImmutableArray<ExpressionSyntax> Values, TextSpan Span) : ExpressionSyntax(Span);
public sealed record ConversionExpressionSyntax(TypeSyntax Type, ImmutableArray<ExpressionSyntax> Arguments, TextSpan Span) : ExpressionSyntax(Span);
public sealed record FieldInitializerSyntax(string Name, ExpressionSyntax Value, TextSpan Span) : SyntaxNode(Span);
