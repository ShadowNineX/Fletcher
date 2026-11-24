using System.Collections.Immutable;
using System.Text.Json;
using Antlr4.Runtime;
using Antlr4.Runtime.Tree;
using Fletcher.Compiler.Syntax.Generated;
using static Fletcher.Compiler.Syntax.Generated.FletcherParser;

namespace Fletcher.Compiler.Syntax;

public static class FletcherSyntaxParser
{
    public static ParseResult Parse(string path, string text)
    {
        ArgumentNullException.ThrowIfNull(path);
        ArgumentNullException.ThrowIfNull(text);

        List<Diagnostic> diagnostics = [];
        var lexer = new FletcherLexer(new AntlrInputStream(text) { name = path });
        lexer.RemoveErrorListeners();
        lexer.AddErrorListener(new LexerErrorListener(path, text, diagnostics));
        var parser = new FletcherParser(new CommonTokenStream(lexer));
        parser.RemoveErrorListeners();
        parser.AddErrorListener(new ParserErrorListener(path, diagnostics));
        var tree = parser.compilationUnit();
        if (diagnostics.Count > 0)
            return new ParseResult(null, diagnostics);

        try
        {
            return new ParseResult(new AstBuilder().VisitCompilationUnit(tree), []);
        }
        catch (LiteralException error)
        {
            return new ParseResult(null, [new Diagnostic(path, error.Location, error.Message)]);
        }
    }

    private sealed class ParserErrorListener(string path, List<Diagnostic> diagnostics) : BaseErrorListener
    {
        public override void SyntaxError(TextWriter output, IRecognizer recognizer, IToken offendingSymbol, int line, int charPositionInLine,
            string msg, RecognitionException? e)
        {
            diagnostics.Add(new Diagnostic(path, TokenSpan(offendingSymbol), msg));
        }
    }

    private sealed class LexerErrorListener(string path, string text, List<Diagnostic> diagnostics) : IAntlrErrorListener<int>
    {
        public void SyntaxError(TextWriter output, IRecognizer recognizer, int symbol, int line, int charPositionInLine,
            string msg, RecognitionException? e)
        {
            var offset = 0;
            for (var currentLine = 1; currentLine < line; currentLine++)
            {
                var newline = text.IndexOf('\n', offset);
                if (newline < 0)
                    break;
                offset = newline + 1;
            }
            diagnostics.Add(new Diagnostic(path, new TextSpan(Math.Min(offset + charPositionInLine, text.Length), 1), msg));
        }
    }

    private static TextSpan TokenSpan(IToken token) => new(Math.Max(0, token.StartIndex), Math.Max(0, token.StopIndex + 1 - token.StartIndex))
    { SourcePath = token.InputStream?.SourceName };
    private sealed class AstBuilder : FletcherBaseVisitor<CompilationUnitSyntax>
    {
        private static TextSpan Span(ParserRuleContext context) => TokenSpan(context.Start).Through(TokenSpan(context.Stop));

        public override CompilationUnitSyntax VisitCompilationUnit(CompilationUnitContext context)
        {
            var map = context.mapDeclaration();
            var backend = context.backendClause();
            return new CompilationUnitSyntax(context.packageClause()?.IDENTIFIER().GetText(),
                [.. context.importDeclaration().SelectMany(import => import.importSpec()).Select(spec =>
                    new ImportSyntax(spec.IDENTIFIER()?.GetText(), String(spec.stringLiteral()), Span(spec)))],
                [.. context.declaration().Select(Declaration)], map is null ? null :
                    new MapDeclarationSyntax(String(map.stringLiteral()), [.. map.mapMember().Select(Member)], Span(map)), Span(context))
            {
                DefaultBackend = backend is null ? null : backend.CIRCUIT() is not null ? BackendKind.Circuit : BackendKind.Script
            };
        }

        private static DeclarationSyntax Declaration(DeclarationContext context) => context.GetChild(0) switch
        {
            ConstDeclarationContext constant => Constant(constant),
            TypeDeclarationContext type => new TypeDeclarationSyntax(type.IDENTIFIER().GetText(), TypeParameters(type.typeParameters()),
                type.ASSIGN() is not null, Type(type.typeSyntax()), Span(type)),
            StructDeclarationContext structure => new StructDeclarationSyntax(structure.IDENTIFIER().GetText(),
                TypeParameters(structure.typeParameters()), [.. structure.structField().Select(field =>
                    new FieldSyntax(field.IDENTIFIER().GetText(), Type(field.typeSyntax()), Span(field)))], Span(structure)),
            InterfaceDeclarationContext contract => new InterfaceDeclarationSyntax(contract.IDENTIFIER().GetText(),
                TypeParameters(contract.typeParameters()), [.. contract.methodSignature().Select(Method)], Span(contract)),
            FunctionDeclarationContext function => new FunctionDeclarationSyntax(
                function.receiver() is { } receiver ? new ReceiverSyntax(receiver.IDENTIFIER().GetText(), Type(receiver.typeSyntax()), Span(receiver)) : null,
                function.IDENTIFIER().GetText(), TypeParameters(function.typeParameters()), Parameters(function.parameters()),
                ResultType(function.resultType()), Block(function.block()), Span(function)),
            TestDeclarationContext test => new TestDeclarationSyntax(String(test.stringLiteral()), Block(test.block()), Span(test)),
            MacroDeclarationContext macro => new MacroDeclarationSyntax(macro.IDENTIFIER().GetText(), Parameters(macro.parameters()),
                [.. macro.placementMember().Select(Placement)], Span(macro)),
            _ => throw Unexpected(context)
        };

        private static MethodSignatureSyntax Method(MethodSignatureContext context) =>
            new(context.IDENTIFIER().GetText(), [], Parameters(context.parameters()), ResultType(context.resultType()), Span(context));

        private static TypeSyntax? ResultType(ResultTypeContext? context) => context switch
        {
            null => null,
            _ when context.LEFT_PAREN() is null => Type(context.typeSyntax(0)),
            _ => new MultipleResultTypeSyntax([.. context.typeSyntax().Select(Type)], Span(context))
        };

        private static ConstDeclarationSyntax Constant(ConstDeclarationContext context) =>
            new(context.IDENTIFIER().GetText(), OptionalType(context.typeSyntax()), Expression(context.expression()), Span(context));

        private static MapMemberSyntax Member(MapMemberContext context) => context.GetChild(0) switch
        {
            InputDeclarationContext input => new InputDeclarationSyntax(input.IDENTIFIER().GetText(), Type(input.typeSyntax()),
                Position(input.position()), Options(input.optionAssignment()), Span(input)),
            OutputDeclarationContext output => Output(output),
            WireDeclarationContext wire => Wire(wire),
            RegisterDeclarationContext register => new RegisterDeclarationSyntax(register.IDENTIFIER().GetText(),
                Type(register.typeSyntax()), Expression(register.expression()), Span(register)),
            TickBlockContext tick => new TickBlockSyntax(Block(tick.block()), Span(tick)) { OnHost = tick.HOST() is not null },
            BackendBlockContext backend => new BackendBlockSyntax(backend.CIRCUIT() is not null ? BackendKind.Circuit : BackendKind.Script,
                [.. backend.binding().Select(Binding)], Span(backend)),
            PlacementMemberContext placement => Placement(placement),
            ScreenDeclarationContext screen => new ScreenDeclarationSyntax(Position(screen.position(0))!, Position(screen.position(1))!,
                Options(screen.optionAssignment()), Span(screen)),
            _ => throw Unexpected(context)
        };

        private static MapMemberSyntax Placement(PlacementMemberContext context) => context.GetChild(0) switch
        {
            PlaceDeclarationContext place => new PlaceDeclarationSyntax(place.IDENTIFIER(0).GetText(), Position(place.position())!,
                place.IDENTIFIER(1)?.GetText(), place.FLIPPED() is not null,
                Options(place.optionAssignment()), Span(place)),
            MacroExpansionContext macro => new MacroExpansionSyntax(macro.qualifiedName().GetText(), Arguments(macro.call()), Span(macro)),
            _ => throw Unexpected(context)
        };

        private static ImmutableArray<OptionSyntax> Options(OptionAssignmentContext[] options) =>
            [.. options.Select(option => new OptionSyntax(option.IDENTIFIER().GetText(), Expression(option.expression()), Span(option)))];

        private static MapMemberSyntax Binding(BindingContext context) => context.GetChild(0) switch
        {
            OutputDeclarationContext output => Output(output),
            WireDeclarationContext wire => Wire(wire),
            _ => throw Unexpected(context)
        };

        private static OutputDeclarationSyntax Output(OutputDeclarationContext context) =>
            new(context.IDENTIFIER().GetText(), Type(context.typeSyntax()), Position(context.position()), Expression(context.expression()), Span(context))
            {
                Options = Options(context.optionAssignment())
            };

        private static WireDeclarationSyntax Wire(WireDeclarationContext context) =>
            new(context.IDENTIFIER().GetText(), Type(context.typeSyntax()), Expression(context.expression()), Span(context))
            {
                Published = context.PUBLISH() is not null,
                HostPublished = context.HOST() is not null
            };

        private static PositionSyntax? Position(PositionContext? context) => context is null
            ? null : new PositionSyntax(Expression(context.expression(0)), Expression(context.expression(1)), Span(context));

        private static ImmutableArray<TypeParameterSyntax> TypeParameters(TypeParametersContext? context) => context is null
            ? [] : [.. context.typeParameter().Select(parameter => new TypeParameterSyntax(parameter.IDENTIFIER().GetText(),
                OptionalType(parameter.typeSyntax()), Span(parameter)))];

        private static ImmutableArray<ParameterSyntax> Parameters(ParametersContext? context) => context is null
            ? [] : [.. context.parameter().Select(parameter => new ParameterSyntax(parameter.IDENTIFIER().GetText(),
                Type(parameter.typeSyntax()), Span(parameter)))];

        private static TypeSyntax? OptionalType(TypeSyntaxContext? context) => context is null ? null : Type(context);

        private static TypeSyntax Type(TypeSyntaxContext context) => context.GetChild(0) switch
        {
            BitsTypeContext bits => BitsType(bits),
            ArrayTypeContext array => ArrayType(array),
            NamedTypeContext named => NamedType(named),
            _ => throw Unexpected(context)
        };

        private static BitsTypeSyntax BitsType(BitsTypeContext context) => new(Size(context.constantSize()), Span(context));
        private static ArrayTypeSyntax ArrayType(ArrayTypeContext context) => new(Size(context.constantSize()), Type(context.typeSyntax()), Span(context));
        private static NamedTypeSyntax NamedType(NamedTypeContext context) => new(context.qualifiedName().GetText(), TypeArguments(context.typeArguments()), Span(context));
        private static ImmutableArray<TypeSyntax> TypeArguments(TypeArgumentsContext? context) => context is null ? [] : [.. context.typeSyntax().Select(Type)];
        private static ExpressionSyntax Size(ConstantSizeContext context) => context.integerLiteral() is { } integer
            ? Integer(integer) : new NameExpressionSyntax(context.qualifiedName().GetText(), [], Span(context));

        private static BlockStatementSyntax Block(BlockContext context) => new([.. context.statement().Select(Statement)], Span(context));

        private static StatementSyntax Statement(StatementContext context) => context.GetChild(0) switch
        {
            BlockContext block => Block(block),
            ShortVariableDeclarationContext local => new ShortVariableStatementSyntax([.. local.identifierList().IDENTIFIER().Select(name => name.GetText())],
                Expressions(local.expressionList()), Span(local)),
            VariableDeclarationContext local => new VariableStatementSyntax(local.IDENTIFIER().GetText(),
                OptionalType(local.typeSyntax()), local.expression() is { } value ? Expression(value) : null, Span(local)),
            ConstDeclarationContext constant => new ConstStatementSyntax(Constant(constant), Span(constant)),
            AssignmentContext assignment => new AssignmentStatementSyntax([.. assignment.lvalue().Select(LValue)], Expressions(assignment.expressionList()), Span(assignment)),
            IfStatementContext conditional => If(conditional),
            SwitchStatementContext selection => new SwitchStatementSyntax(Expression(selection.expression()),
                [.. selection.switchClause().Select(clause => new SwitchClauseSyntax(Expressions(clause.expressionList()),
                    new BlockStatementSyntax([.. clause.statement().Select(Statement)], Span(clause)), Span(clause)))], Span(selection)),
            ForRangeStatementContext loop => new ForRangeStatementSyntax(loop.IDENTIFIER(0)?.GetText(), loop.IDENTIFIER(1)?.GetText(),
                Expression(loop.expression()), Block(loop.block()), Span(loop)),
            ReturnStatementContext returned => new ReturnStatementSyntax(Expressions(returned.expressionList()), Span(returned)),
            NextStatementContext next => new NextStatementSyntax(next.IDENTIFIER().GetText(), Expression(next.expression()), Span(next)),
            ExpressionStatementContext expression => new ExpressionStatementSyntax(Expression(expression.expression()), Span(expression)),
            _ => throw Unexpected(context)
        };

        private static IfStatementSyntax If(IfStatementContext context) =>
            new(Expression(context.expression()), Block(context.block(0)),
                context.ifStatement() is { } alternate ? If(alternate) : OptionalBlock(context),
                Span(context));

        private static BlockStatementSyntax? OptionalBlock(IfStatementContext context) =>
            context.block(1) is { } block ? Block(block) : null;

        private static LValueSyntax LValue(LvalueContext context)
        {
            var name = context.IDENTIFIER();
            LValueSyntax value = new NameLValueSyntax(name.GetText(), TokenSpan(name.Symbol));
            foreach (var part in context.lvaluePart())
            {
                var span = value.Span.Through(Span(part));
                value = part.IDENTIFIER() is { } member
                    ? new MemberLValueSyntax(value, member.GetText(), span)
                    : new IndexLValueSyntax(value, Expression(part.expression()), span);
            }
            return value;
        }

        private static ImmutableArray<ExpressionSyntax> Expressions(ExpressionListContext? context) =>
            context is null ? [] : [.. context.expression().Select(Expression)];

        private static ExpressionSyntax Expression(ExpressionContext context) => Fold(context.logicalOr());

        private static ExpressionSyntax Fold(ParserRuleContext context)
        {
            if (context is UnaryContext unary)
            {
                return unary.postfix() is { } postfix
                    ? Postfix(postfix) : new UnaryExpressionSyntax(unary.Start.Text, Fold(unary.unary()), Span(unary));
            }

            ExpressionSyntax? left = null;
            string operation = "";
            foreach (var child in context.children)
            {
                if (child is ITerminalNode { Symbol.Type: not NEWLINE } terminal)
                    operation = string.Concat(operation, terminal.GetText());
                if (child is ParserRuleContext argument)
                {
                    var right = Fold(argument);
                    left = left is null ? right : new BinaryExpressionSyntax(left, operation, right, left.Span.Through(right.Span));
                    operation = "";
                }
            }
            return left ?? throw Unexpected(context);
        }

        private static ExpressionSyntax Postfix(PostfixContext context)
        {
            var value = Primary(context.primary());
            foreach (var part in context.postfixPart())
            {
                var span = value.Span.Through(Span(part));
                if (part.call() is { } call)
                    value = new CallExpressionSyntax(value, Arguments(call), span);
                else if (part.IDENTIFIER() is { } member)
                    value = new MemberExpressionSyntax(value, member.GetText(), span);
                else
                    value = new IndexExpressionSyntax(value, Expression(part.expression()), span);
            }
            return value;
        }

        private static ImmutableArray<ExpressionSyntax> Arguments(CallContext context) => Expressions(context.arguments()?.expressionList());

        private static ExpressionSyntax Primary(PrimaryContext context)
        {
            var span = Span(context);
            if (context.literal() is { } literal)
                return Literal(literal);
            if (context.bitsType() is { } bits)
                return new ConversionExpressionSyntax(BitsType(bits), Arguments(context.call()), span);
            if (context.arrayType() is { } array)
                return new ArrayLiteralExpressionSyntax(ArrayType(array), Expressions(context.arguments()?.expressionList()), span);
            if (context.namedType() is { } structure)
            {
                var fields = context.fieldInitializers()?.fieldInitializer() ?? [];
                return new StructLiteralExpressionSyntax(NamedType(structure),
                    [.. fields.Select(field => new FieldInitializerSyntax(field.IDENTIFIER().GetText(), Expression(field.expression()), Span(field)))], span);
            }
            if (context.qualifiedName() is { } genericName)
            {
                var name = new NameExpressionSyntax(genericName.GetText(), TypeArguments(context.typeArguments()), Span(genericName).Through(Span(context.typeArguments())));
                return new CallExpressionSyntax(name, Arguments(context.call()), span);
            }
            if (context.IDENTIFIER() is { } identifier)
                return new NameExpressionSyntax(identifier.GetText(), [], span);
            return Expression(context.expression());
        }

        private static ExpressionSyntax Literal(LiteralContext context) => context.GetChild(0) switch
        {
            IntegerLiteralContext integer => Integer(integer),
            StringLiteralContext text => new StringLiteralExpressionSyntax(String(text), Span(text)),
            ITerminalNode truth => new BooleanLiteralExpressionSyntax(truth.Symbol.Type == TRUE, Span(context)),
            _ => throw Unexpected(context)
        };

        private static IntegerLiteralExpressionSyntax Integer(IntegerLiteralContext context) => new(context.GetText(), Span(context));

        private static string String(StringLiteralContext context)
        {
            try
            {
                return JsonSerializer.Deserialize<string>(context.GetText()) ?? "";
            }
            catch (JsonException)
            {
                throw new LiteralException(Span(context), "Invalid escape in a string literal.");
            }
        }

        private static InvalidOperationException Unexpected(ParserRuleContext context) =>
            new($"Unexpected {context.GetType().Name} in the generated parse tree.");
    }

    public sealed class LiteralException(TextSpan span, string message) : Exception(message)
    {
        public TextSpan Location { get; } = span;
    }
}
