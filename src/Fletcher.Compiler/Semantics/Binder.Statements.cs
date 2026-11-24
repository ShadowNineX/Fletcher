using System.Collections.Immutable;
using Fletcher.Compiler.Syntax;
using Fletcher.Compiler.IR;

namespace Fletcher.Compiler.Semantics;

internal sealed partial class Binder
{
    private void BindFunction(Specialization item)
    {
        var (declaration, _, _, arguments, function, _) = item;
        var scope = new Scope();
        if (function.Receiver is { } receiver && declaration.Receiver is { } location)
            Declare(scope, receiver, location);
        for (var i = 0; i < function.Parameters.Length; i++)
            Declare(scope, function.Parameters[i], declaration.Parameters[i]);
        function.Body = BindBlock(declaration.Body, scope, arguments, function.Result, inTick: false, newScope: false);
        if (function.Result != DataType.Void && function.Result != DataType.Error && !Returns(function.Body))
            Error(declaration, $"Function '{function.Name}' must return '{function.Result}' on every path.");
    }

    private void ValidateFunctionCycles()
    {
        HashSet<Function> visiting = [];
        HashSet<Function> done = [];
        foreach (var function in specializations.Select(item => item.Function))
            Visit(function);

        void Visit(Function function)
        {
            if (done.Contains(function))
                return;
            if (!visiting.Add(function))
            {
                Error(specializations[function.Id].Declaration, $"Recursive call through '{function.Name}' is unsupported.");
                return;
            }
            foreach (var called in BoundTree.Calls(function.Body).Distinct())
                Visit(called);
            visiting.Remove(function);
            done.Add(function);
        }
    }

    private static bool Returns(BoundStatement? statement) => statement switch
    {
        BoundReturn => true,
        BoundBlock block => Array.Exists(block.Statements, Returns),
        BoundIf conditional => Returns(conditional.Then) && Returns(conditional.Else),
        BoundSwitch selection => Returns(selection.Default) && Array.TrueForAll(selection.Cases, clause => Returns(clause.Body)),
        _ => false
    };

    private BoundBlock BindBlock(BlockStatementSyntax block, Scope parent, Dictionary<string, DataType> args,
        DataType? result, bool inTick, bool newScope = true)
    {
        var scope = newScope ? new Scope(parent) : parent;
        return new BoundBlock([.. block.Statements.Select(statement => BindStatement(statement, scope, args, result, inTick))]);
    }

    private BoundStatement BindStatement(StatementSyntax syntax, Scope scope, Dictionary<string, DataType> args,
        DataType? result, bool inTick)
    {
        switch (syntax)
        {
            case BlockStatementSyntax block:
                return BindBlock(block, scope, args, result, inTick);
            case ShortVariableStatementSyntax shortVariable:
                return BindShortVariables(shortVariable, scope, args);
            case VariableStatementSyntax variable:
            {
                var type = variable.Type is null ? null : ResolveType(variable.Type, args);
                var value = variable.Value is null ? null : BindExpression(variable.Value, scope, args);
                if (type is null && value is null)
                    Error(variable, "A variable requires a type or initializer.");
                type ??= value?.Type ?? DataType.Error;
                if (type == DataType.Void)
                    Error(variable, "A variable cannot contain a void result.");
                var symbol = NewVariable(variable.Name, type);
                Declare(scope, symbol, variable);
                return new BoundLocals([symbol], [true], [value is null ? Zero(type) : Coerce(value, type, variable)]);
            }
            case ConstStatementSyntax constant:
            {
                var clause = constant.Declaration;
                var value = clause.Type is null ? BindExpression(clause.Value, scope, args) :
                    BindAs(clause.Value, scope, args, ResolveType(clause.Type, args));
                var symbol = NewVariable(clause.Name, value.Type, SymbolKind.Constant);
                if (Declare(scope, symbol, clause))
                {
                    var literal = RequireConstant(value, clause.Value, allowArray: true) ?? ErrorValue;
                    localConstants.Add(symbol, clause.Type is null ? literal : literal with { IsUntyped = false });
                }
                return new BoundBlock([]);
            }
            case AssignmentStatementSyntax assignment:
                return BindAssignment(assignment, scope, args);
            case IfStatementSyntax conditional:
                var condition = BindExpression(conditional.Condition, scope, args);
                if (condition.Type.Shape.Kind is not (TypeKind.Bit or TypeKind.Error))
                    Error(conditional.Condition, "An if condition requires a bit.");
                return new BoundIf(condition,
                    BindBlock(conditional.Then, scope, args, result, inTick),
                    conditional.Else is { } alternate ? BindStatement(alternate, scope, args, result, inTick) : null);
            case SwitchStatementSyntax selection:
                return BindSwitch(selection, scope, args, result, inTick);
            case ForRangeStatementSyntax range:
                return BindRange(range, scope, args, result, inTick);
            case ReturnStatementSyntax @return:
            {
                if (result is null)
                    Error(@return, "return is only available inside a function.");
                else if (result.IsResultList)
                    return BindMultipleReturn(@return, scope, args, result);
                else if (result == DataType.Void && @return.Values.IsEmpty)
                    return new BoundReturn(null);
                else if (result != DataType.Void && @return.Values.Length == 1)
                    return new BoundReturn(BindAs(@return.Values[0], scope, args, result));
                else
                    Error(@return, result == DataType.Void ? "This function returns no value." : $"Expected one '{result}' return value.");
                return new BoundReturn(null);
            }
            case NextStatementSyntax next:
                if (inTick && scope.Find(next.Name) is { Kind: SymbolKind.Register } register)
                    return new BoundNext(register, BindAs(next.Value, scope, args, register.Type));
                Error(next, "next requires a map register and can only be used in the tick block.");
                return new BoundBlock([]);
            case ExpressionStatementSyntax expression:
                if (bindingTest && expression.Expression is CallExpressionSyntax
                    { Target: NameExpressionSyntax { Name: "assert" or "assertEqual", TypeArguments.IsEmpty: true } assertionName } assertion &&
                    scope.Find(assertionName.Name) is null)
                    return BindAssertion(assertion, assertionName.Name == "assertEqual", scope, args);
                if (expression.Expression is CallExpressionSyntax { Target: NameExpressionSyntax { Name: "pixel", TypeArguments.Length: 0 } } pixel &&
                    scope.Find("pixel") is null)
                {
                    if (screen is null && !testing)
                        Error(expression, "pixel requires a screen declaration in the map.");
                    var arguments = pixel.Arguments.Select(argument => BindExpression(argument, scope, args)).ToArray();
                    if (arguments.Length is 4 or 5 && screen is { IsSolid: false })
                        Error(pixel, "A per-pixel color requires a solid screen.");
                    if (arguments.Length is not (3 or 4 or 5))
                    {
                        Error(pixel, "pixel requires x, y, on, an optional color, and an optional palette index.");
                        return new BoundBlock([]);
                    }
                    DataType[] parameters = arguments.Length switch
                    {
                        3 => [DataType.Int, DataType.Int, DataType.Bit],
                        4 => [DataType.Int, DataType.Int, DataType.Bit, DataType.Color],
                        _ => [DataType.Int, DataType.Int, DataType.Bit, DataType.Color, DataType.Int]
                    };
                    return new BoundEffect(EffectKind.Pixel, CoerceArguments(arguments, parameters, pixel));
                }
                if (expression.Expression is CallExpressionSyntax { Target: NameExpressionSyntax { Name: "preserveScreen", TypeArguments.Length: 0 } } preserve &&
                    scope.Find("preserveScreen") is null)
                {
                    if (screen is null && !testing)
                        Error(expression, "preserveScreen requires a solid screen declaration in the map.");
                    else if (screen is { IsSolid: false })
                        Error(expression, "preserveScreen requires a solid screen declaration in the map.");
                    if (!preserve.Arguments.IsEmpty)
                        Error(preserve, "preserveScreen takes no arguments.");
                    return new BoundEffect(EffectKind.PreserveScreen, []);
                }
                if (expression.Expression is CallExpressionSyntax { Target: NameExpressionSyntax { Name: "revealScreen", TypeArguments.Length: 0 } } reveal &&
                    scope.Find("revealScreen") is null)
                {
                    if (screen is null && !testing)
                        Error(expression, "revealScreen requires a solid screen declaration in the map.");
                    else if (screen is { IsSolid: false })
                        Error(expression, "revealScreen requires a solid screen declaration in the map.");
                    var arguments = reveal.Arguments.Select(argument => BindExpression(argument, scope, args)).ToArray();
                    if (arguments.Length != 4)
                    {
                        Error(reveal, "revealScreen requires start, end, row offsets, and columns per offset.");
                        return new BoundBlock([]);
                    }
                    if (arguments[2].Type.Shape.Kind != TypeKind.Array || arguments[2].Type.Shape.Element?.Shape.Kind != TypeKind.Int)
                        Error(reveal.Arguments[2], "revealScreen row offsets require an array of integers.");
                    if (arguments[3] is BoundLiteral { Value: int columns } && columns <= 0)
                        Error(reveal.Arguments[3], "revealScreen columns per offset must be positive.");
                    if (screen is { } solid && arguments[2].Type.Shape.Kind == TypeKind.Array &&
                        arguments[3] is BoundLiteral { Value: int width } && width > 0 &&
                        arguments[2].Type.Shape.Size < (solid.Width + width - 1) / width)
                        Error(reveal.Arguments[2], "revealScreen row offsets do not cover the screen width.");
                    return new BoundEffect(EffectKind.RevealScreen, CoerceArguments(arguments,
                        [DataType.String, DataType.String, arguments[2].Type, DataType.Int], reveal));
                }
                if (expression.Expression is CallExpressionSyntax { Target: NameExpressionSyntax { Name: "log", TypeArguments.Length: 0 } } call &&
                    scope.Find("log") is null)
                {
                    if (!inTick && !testing)
                        Error(expression, "log is available in the tick block.");
                    return new BoundEffect(EffectKind.Log, [.. call.Arguments.Select(argument =>
                    {
                        var value = BindExpression(argument, scope, args);
                        return value.Type == DataType.Void ? BadExpression(argument, "log requires a value.") : value;
                    })]);
                }
                if (expression.Expression is not CallExpressionSyntax)
                    Error(expression, "Only function and method calls can be used as expression statements.");
                return new BoundEffect(EffectKind.Discard, [BindExpression(expression.Expression, scope, args, allowMultiple: true)]);
            default:
                Error(syntax, "Unsupported statement.");
                return new BoundBlock([]);
        }
    }

    private BoundReturn BindMultipleReturn(ReturnStatementSyntax syntax, Scope scope, Dictionary<string, DataType> args, DataType result)
    {
        var count = result.Fields.Count;
        if (syntax.Values.Length == 1)
        {
            var call = BindExpression(syntax.Values[0], scope, args, allowMultiple: true);
            if (call.Type == result || call.Type == DataType.Error)
                return new BoundReturn(call);
            if (call.Type.IsResultList)
                Error(syntax, $"Cannot forward '{call.Type}' as '{result}'.");
            else
                Error(syntax, $"Expected {count} return values for '{result}', got 1.");
        }
        else if (syntax.Values.Length == count)
        {
            Dictionary<string, BoundExpression> fields = [with(StringComparer.Ordinal)];
            foreach (var (name, type) in result.Fields)
                fields.Add(name, BindAs(syntax.Values[fields.Count], scope, args, type));
            return new BoundReturn(new BoundStruct(result, fields));
        }
        else
            Error(syntax, $"Expected {count} return values for '{result}', got {syntax.Values.Length}.");
        return new BoundReturn(null);
    }

    private BoundExpression[] BindAssignmentValues(ImmutableArray<ExpressionSyntax> expressions,
        Scope scope, Dictionary<string, DataType> args, out BoundResultSource? source)
    {
        source = null;
        var values = expressions.Select(expression => BindExpression(expression, scope, args, allowMultiple: expressions.Length == 1)).ToArray();
        if (values is not [var call] || !call.Type.IsResultList)
            return values;

        var temporary = NewVariable("$results", call.Type);
        source = new BoundResultSource(temporary, call);
        var receiver = new BoundVariable(temporary);
        return [.. call.Type.Fields.Select(field => (BoundExpression)new BoundMember(field.Value, receiver, field.Key))];
    }

    private BoundStatement BindAssertion(CallExpressionSyntax call, bool equality, Scope scope, Dictionary<string, DataType> args)
    {
        var required = equality ? 2 : 1;
        if (call.Arguments.Length != required && call.Arguments.Length != required + 1)
        {
            Error(call, equality ? "assertEqual requires actual, expected, and an optional message." :
                "assert requires a bit condition and an optional message.");
            return new BoundBlock([]);
        }

        var arguments = call.Arguments.Select(argument => BindExpression(argument, scope, args)).ToArray();
        if (equality)
        {
            if (arguments[0].Type != arguments[1].Type && Array.TrueForAll(arguments, argument => argument.Type != DataType.Error))
            {
                if (arguments[1] is BoundLiteral right && CanCoerceConstant(right, arguments[0].Type))
                    arguments[1] = Coerce(right, arguments[0].Type, call.Arguments[1]);
                else if (arguments[0] is BoundLiteral left && CanCoerceConstant(left, arguments[1].Type))
                    arguments[0] = Coerce(left, arguments[1].Type, call.Arguments[0]);
                else
                    Error(call, $"assertEqual requires matching types, got '{arguments[0].Type}' and '{arguments[1].Type}'.");
            }
            if (arguments[0].Type.Shape.Kind != TypeKind.Bytes && !HasTestEquality(arguments[0].Type))
                Error(call, $"assertEqual cannot compare '{arguments[0].Type}'. Use assert on the fields or values you want to compare.");
        }
        else
        {
            arguments[0] = Coerce(arguments[0], DataType.Bit, call.Arguments[0]);
        }

        if (arguments.Length > required)
            arguments[required] = Coerce(arguments[required], DataType.String, call.Arguments[required]);
        return new BoundAssertion(equality, arguments, call.Span);
    }

    private static bool HasTestEquality(DataType type) => type.Shape.Kind switch
    {
        TypeKind.Array => HasTestEquality(type.Shape.Element!),
        TypeKind.Struct => type.Shape.Fields.Values.All(HasTestEquality),
        TypeKind.Void or TypeKind.Interface or TypeKind.Bytes => false,
        _ => true
    };

    private BoundSwitch BindSwitch(SwitchStatementSyntax syntax, Scope scope, Dictionary<string, DataType> args, DataType? result, bool inTick)
    {
        var selector = BindExpression(syntax.Selector, scope, args);
        if (selector.Type.Shape.Kind is not (TypeKind.Int or TypeKind.Bits or TypeKind.Bit or TypeKind.String or TypeKind.Color or TypeKind.Error))
            Error(syntax.Selector, "A switch selector requires an int, bits, bit, string, or color value.");

        List<BoundCase> cases = [];
        HashSet<object> seen = [];
        BoundBlock? otherwise = null;
        foreach (var clause in syntax.Clauses)
        {
            var body = BindBlock(clause.Body, scope, args, result, inTick);
            if (clause.Values.IsEmpty)
            {
                if (otherwise is not null)
                    Error(clause, "A switch can declare only one default clause.");
                otherwise = body;
                continue;
            }

            List<BoundLiteral> values = [];
            foreach (var label in clause.Values)
            {
                if (RequireConstant(BindAs(label, scope, args, selector.Type), label) is not { } value)
                    continue;
                if (!seen.Add(value.Value))
                    Error(label, "Duplicate case value in switch.");
                values.Add(value);
            }
            cases.Add(new BoundCase([.. values], body));
        }
        return new BoundSwitch(selector, [.. cases], otherwise);
    }

    private BoundLocals BindShortVariables(ShortVariableStatementSyntax syntax, Scope scope, Dictionary<string, DataType> args)
    {
        var values = BindAssignmentValues(syntax.Values, scope, args, out var source);
        var symbols = new Variable?[syntax.Names.Length];
        var created = new bool[symbols.Length];
        if (values.Length != symbols.Length)
        {
            Error(syntax, $"Short declarations require one value per name, got {values.Length} values for {symbols.Length} names.");
            return new BoundLocals(symbols, created, values, source);
        }
        HashSet<string> names = [with(StringComparer.Ordinal)];
        for (var i = 0; i < symbols.Length; i++)
        {
            var name = syntax.Names[i];
            var location = source is null ? syntax.Values[i] : syntax.Values[0];
            if (values[i].Type == DataType.Void)
                Error(location, "A declaration requires a value.");
            if (name == "_")
                continue;
            if (!names.Add(name))
            {
                Error(syntax, $"'{name}' occurs more than once in this declaration.");
                continue;
            }
            if (scope.Variables.TryGetValue(name, out var prior))
            {
                if (prior.Kind != SymbolKind.Local)
                    Error(syntax, $"'{name}' is not mutable.");
                symbols[i] = prior;
                values[i] = Coerce(values[i], prior.Type, location);
            }
            else
            {
                var symbol = NewVariable(name, values[i].Type);
                Declare(scope, symbol, syntax);
                symbols[i] = symbol;
                created[i] = true;
            }
        }
        if (!created.Contains(true))
            Error(syntax, "A short declaration requires at least one new name.");
        return new BoundLocals(symbols, created, values, source);
    }

    private BoundAssignment BindAssignment(AssignmentStatementSyntax syntax, Scope scope, Dictionary<string, DataType> args)
    {
        var values = BindAssignmentValues(syntax.Values, scope, args, out var source);
        var targets = syntax.Targets.Select(target => target is NameLValueSyntax { Name: "_" } ? null : BindTarget(target, scope, args)).ToArray();
        if (targets.Length != values.Length)
            Error(syntax, $"Assignments require one value per target, got {values.Length} values for {targets.Length} targets.");
        else
        {
            for (var i = 0; i < targets.Length; i++)
            {
                var location = source is null ? syntax.Values[i] : syntax.Values[0];
                if (values[i].Type == DataType.Void)
                    Error(location, "An assignment requires a value.");
                if (targets[i] is { } target)
                    values[i] = Coerce(values[i], target.Type, location);
            }
        }
        return new BoundAssignment(targets, values, source);
    }

    private BoundExpression BindTarget(LValueSyntax syntax, Scope scope, Dictionary<string, DataType> args) => syntax switch
    {
        NameLValueSyntax name when scope.Find(name.Name) is { Kind: SymbolKind.Local } variable => new BoundVariable(variable),
        NameLValueSyntax name => BadExpression(name, $"'{name.Name}' is not a mutable local."),
        MemberLValueSyntax field => BindMember(BindTarget(field.Target, scope, args), field.Member, field),
        IndexLValueSyntax index => BindIndexTarget(index, scope, args),
        _ => BadExpression(syntax, "Unsupported assignment target.")
    };

    private BoundExpression BindIndexTarget(IndexLValueSyntax syntax, Scope scope, Dictionary<string, DataType> args)
    {
        var target = BindTarget(syntax.Target, scope, args);
        var index = BindAs(syntax.Index, scope, args, DataType.Int);
        return target.Type.Shape.Kind == TypeKind.Bytes ? BadExpression(syntax, "Imported bytes are read-only.") : BindIndex(target, index, syntax);
    }

    private BoundRange BindRange(ForRangeStatementSyntax syntax, Scope parent, Dictionary<string, DataType> args, DataType? result, bool inTick)
    {
        var collection = BindExpression(syntax.Source, parent, args);
        var shape = collection.Type.Shape;
        if (shape.Kind is not (TypeKind.Int or TypeKind.Array or TypeKind.String or TypeKind.Bytes or TypeKind.Error))
            Error(syntax.Source, "range requires an int, fixed array, string, or bytes.");
        if (shape.Kind == TypeKind.Int && syntax.ValueName is not null)
            Error(syntax, "Integer range supports at most one iteration name.");
        var scope = new Scope(parent);
        var index = RangeVariable(syntax.IndexName, DataType.Int);
        var element = shape.Kind switch
        {
            TypeKind.String => DataType.String,
            TypeKind.Bytes => BitVector(8),
            _ => shape.Element ?? DataType.Error
        };
        var value = RangeVariable(syntax.ValueName, element);
        return new BoundRange(index, value, collection, BindBlock(syntax.Body, scope, args, result, inTick, newScope: false));

        Variable? RangeVariable(string? name, DataType type)
        {
            if (name is null or "_")
                return null;
            var variable = NewVariable(name, type);
            Declare(scope, variable, syntax);
            return variable;
        }
    }
}
