using Fletcher.Compiler.Maps;
using Fletcher.Compiler.IR;
using Fletcher.Compiler.Syntax;

namespace Fletcher.Compiler.Semantics;

internal sealed partial class Binder
{
    private BoundExpression BindAs(ExpressionSyntax syntax, Scope scope, Dictionary<string, DataType> args, DataType expected) =>
        Coerce(BindExpression(syntax, scope, args), expected, syntax);

    private BoundExpression BindExpression(ExpressionSyntax syntax, Scope scope, Dictionary<string, DataType> args, bool allowMultiple = false)
    {
        try
        {
            var bound = syntax switch
            {
                NameExpressionSyntax name => BindName(name, scope),
                IntegerLiteralExpressionSyntax integer => BindInteger(integer),
                StringLiteralExpressionSyntax literal => new BoundLiteral(DataType.String, literal.Text, IsUntyped: true),
                BooleanLiteralExpressionSyntax literal => new BoundLiteral(DataType.Bit, literal.Value, IsUntyped: true),
                UnaryExpressionSyntax unary => BindUnary(unary, scope, args),
                BinaryExpressionSyntax binary => BindBinary(binary, scope, args),
                CallExpressionSyntax call => BindCall(call, scope, args),
                ConversionExpressionSyntax conversion => BindConversion(ResolveType(conversion.Type, args),
                    [.. conversion.Arguments.Select(argument => BindExpression(argument, scope, args))], conversion),
                MemberExpressionSyntax member => BindSelector(member, scope, args),
                IndexExpressionSyntax index => BindIndex(BindExpression(index.Target, scope, args),
                    BindAs(index.Index, scope, args, DataType.Int), index),
                StructLiteralExpressionSyntax structure => BindStruct(structure, scope, args),
                ArrayLiteralExpressionSyntax array => BindArray(array, scope, args),
                _ => BadExpression(syntax, "Unsupported expression.")
            };
            if (bound.Type.IsResultList && !allowMultiple)
                return BadExpression(syntax, $"Call returns {bound.Type.Fields.Count} values in a single-value context.");
            return bound.Type == DataType.Error ? bound : Constants.Evaluate(bound) ?? bound;
        }
        catch (ArithmeticException)
        {
            return BadExpression(syntax, "Invalid arithmetic in constant expression.");
        }
    }

    private BoundExpression BindSelector(MemberExpressionSyntax selector, Scope scope, Dictionary<string, DataType> args)
    {
        if (PackageMember(selector, scope) is { } qualified)
            return BindName(qualified, scope);
        if (selector.Target is NameExpressionSyntax { Name: "color" } && scope.Find("color") is null)
        {
            if (Enum.TryParse<TileColor>(selector.Member, out var color) && Enum.IsDefined(color))
                return new BoundLiteral(DataType.Color, (int)color);
            return BadExpression(selector, $"Unknown color '{selector.Member}'.");
        }
        return BindMember(BindExpression(selector.Target, scope, args), selector.Member, selector);
    }

    private BoundExpression BindName(NameExpressionSyntax syntax, Scope scope)
    {
        if (!syntax.TypeArguments.IsEmpty)
            return BadExpression(syntax, "Type arguments on a value require a call.");
        if (scope.Find(syntax.Name) is { } variable)
        {
            if (variable.Kind == SymbolKind.Output)
                return BadExpression(syntax, $"Output '{syntax.Name}' cannot be read. Share its value through a wire.");
            return localConstants.TryGetValue(variable, out var literal) ? literal : new BoundVariable(variable);
        }
        var key = LookupKey(syntax.Name, syntax);
        if (key is null)
            return ErrorValue;
        return constantDeclarations.ContainsKey(key)
            ? ResolveConstant(key, syntax)
            : BadExpression(syntax, $"Unknown value '{syntax.Name}'.");
    }

    private BoundExpression BindInteger(IntegerLiteralExpressionSyntax syntax)
    {
        var text = syntax.Text.Replace("_", "", StringComparison.Ordinal);
        var radix = 10;
        if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            radix = 16;
        else if (text.StartsWith("0b", StringComparison.OrdinalIgnoreCase))
            radix = 2;
        if (radix != 10)
            text = text[2..];
        try
        {
            var value = Convert.ToUInt32(text, radix);
            if (value <= int.MaxValue)
                return new BoundLiteral(DataType.Int, (int)value, IsUntyped: true);
            return new BoundLiteral(BitVector(32), value, IsUntyped: true);
        }
        catch (Exception exception) when (exception is FormatException or OverflowException)
        {
            return BadExpression(syntax, "Integer literal is outside the supported 32-bit range.");
        }
    }

    private BoundExpression BindUnary(UnaryExpressionSyntax syntax, Scope scope, Dictionary<string, DataType> args)
    {
        var operand = BindExpression(syntax.Operand, scope, args);
        if (operand.Type == DataType.Error)
            return ErrorValue;
        if (syntax.Operator == "-" && syntax.Operand is IntegerLiteralExpressionSyntax &&
            operand is BoundLiteral { Value: uint magnitude } && magnitude == 0x80000000)
            return new BoundLiteral(DataType.Int, int.MinValue, IsUntyped: true);
        if (ParseUnaryOperator(syntax.Operator) is not { } op)
            return BadExpression(syntax, $"Operator '{syntax.Operator}' is invalid for '{operand.Type}'.");
        if ((op == UnaryOperator.LogicalNot && operand.Type.Shape.Kind == TypeKind.Bit) ||
            (op is UnaryOperator.Plus or UnaryOperator.Negate or UnaryOperator.BitwiseNot && operand.Type.IsNumber))
            return new BoundUnary(operand.Type, op, operand);
        return BadExpression(syntax, $"Operator '{syntax.Operator}' is invalid for '{operand.Type}'.");
    }

    private BoundExpression BindBinary(BinaryExpressionSyntax syntax, Scope scope, Dictionary<string, DataType> args)
    {
        var left = BindExpression(syntax.Left, scope, args);
        var right = BindExpression(syntax.Right, scope, args);
        if (left.Type == DataType.Error || right.Type == DataType.Error)
            return ErrorValue;
        if (ParseBinaryOperator(syntax.Operator) is not { } op)
            return BadExpression(syntax, $"Operator '{syntax.Operator}' is invalid for '{left.Type}'.");
        if (op is BinaryOperator.ShiftLeft or BinaryOperator.ShiftRight)
        {
            if (left.Type.IsNumber && right.Type == DataType.Int)
                return new BoundBinary(left.Type, op, left, right);
            return BadExpression(syntax, "Shifts require a numeric value and an int shift count.");
        }
        if (left.Type != right.Type)
        {
            if (right is BoundLiteral rightLiteral && CanCoerceConstant(rightLiteral, left.Type))
                right = Coerce(right, left.Type, syntax.Right);
            else if (left is BoundLiteral leftLiteral && CanCoerceConstant(leftLiteral, right.Type))
                left = Coerce(left, right.Type, syntax.Left);
            else
                return BadExpression(syntax, $"Operator '{syntax.Operator}' requires matching types, got '{left.Type}' and '{right.Type}'.");
        }
        if (left.Type == DataType.Error || right.Type == DataType.Error)
            return ErrorValue;

        var shape = left.Type.Shape.Kind;
        if (op is BinaryOperator.Equal or BinaryOperator.NotEqual && shape is TypeKind.Int or TypeKind.Bits or TypeKind.Bit or TypeKind.String or TypeKind.Color)
            return new BoundBinary(DataType.Bit, op, left, right);
        if (op is BinaryOperator.LessThan or BinaryOperator.LessThanOrEqual or BinaryOperator.GreaterThan or BinaryOperator.GreaterThanOrEqual && left.Type.IsNumber)
            return new BoundBinary(DataType.Bit, op, left, right);
        if ((left.Type.IsNumber && op is BinaryOperator.Add or BinaryOperator.Subtract or BinaryOperator.Multiply or BinaryOperator.Divide or BinaryOperator.Remainder or BinaryOperator.BitwiseAnd or BinaryOperator.BitwiseOr or BinaryOperator.BitwiseXor) ||
            (shape == TypeKind.Bit && op is BinaryOperator.BitwiseAnd or BinaryOperator.BitwiseOr or BinaryOperator.BitwiseXor or BinaryOperator.LogicalAnd or BinaryOperator.LogicalOr) ||
            (shape == TypeKind.String && op == BinaryOperator.Add))
            return new BoundBinary(left.Type, op, left, right);
        return BadExpression(syntax, $"Operator '{syntax.Operator}' is invalid for '{left.Type}'.");
    }

    private static UnaryOperator? ParseUnaryOperator(string symbol) => symbol switch
    {
        "+" => UnaryOperator.Plus,
        "-" => UnaryOperator.Negate,
        "!" => UnaryOperator.LogicalNot,
        "~" or "^" => UnaryOperator.BitwiseNot,
        _ => null
    };

    private static BinaryOperator? ParseBinaryOperator(string symbol) => symbol switch
    {
        "+" => BinaryOperator.Add,
        "-" => BinaryOperator.Subtract,
        "*" => BinaryOperator.Multiply,
        "/" => BinaryOperator.Divide,
        "%" => BinaryOperator.Remainder,
        "<<" => BinaryOperator.ShiftLeft,
        ">>" => BinaryOperator.ShiftRight,
        "&" => BinaryOperator.BitwiseAnd,
        "|" => BinaryOperator.BitwiseOr,
        "^" => BinaryOperator.BitwiseXor,
        "&&" => BinaryOperator.LogicalAnd,
        "||" => BinaryOperator.LogicalOr,
        "==" => BinaryOperator.Equal,
        "!=" => BinaryOperator.NotEqual,
        "<" => BinaryOperator.LessThan,
        "<=" => BinaryOperator.LessThanOrEqual,
        ">" => BinaryOperator.GreaterThan,
        ">=" => BinaryOperator.GreaterThanOrEqual,
        _ => null
    };

    private BoundExpression BindCall(CallExpressionSyntax syntax, Scope scope, Dictionary<string, DataType> args)
    {
        var arguments = syntax.Arguments.Select(arg => BindExpression(arg, scope, args)).ToArray();
        var name = syntax.Target is MemberExpressionSyntax selector ? PackageMember(selector, scope) : syntax.Target as NameExpressionSyntax;
        if (name is not null)
        {
            if (scope.Find(name.Name) is not null)
                return BadExpression(syntax, $"'{name.Name}' is a value and cannot be called.");
            var explicitTypes = name.TypeArguments.Select(type => ResolveType(type, args)).ToArray();
            if (name.Name == "currentTick")
                return explicitTypes.Length == 0 && arguments.Length == 0 ? new BoundCurrentTick() :
                    BadExpression(syntax, "currentTick() takes no arguments.");
            if (name.Name == "hostTimeMillis")
                return explicitTypes.Length == 0 && arguments.Length == 0 ? new BoundHostTimeMillis() :
                    BadExpression(syntax, "hostTimeMillis() takes no arguments.");
            if (name.Name is "mouseX" or "mouseY")
                return explicitTypes.Length == 0 && arguments.Length == 0 ? new BoundMousePosition(name.Name == "mouseX") :
                    BadExpression(syntax, $"{name.Name}() takes no arguments.");
            if (name.Name == "pixelIndexAt")
            {
                if (explicitTypes.Length != 0 || arguments.Length != 2)
                    return BadExpression(syntax, "pixelIndexAt() takes two integer coordinates.");
                if (screen is null && !testing)
                    Error(syntax, "pixelIndexAt() requires a screen declaration in the map.");
                else if (screen is { IsSolid: false })
                    Error(syntax, "pixelIndexAt() requires a solid screen.");
                var coordinates = CoerceArguments(arguments, [DataType.Int, DataType.Int], syntax);
                return new BoundPixelIndexAt(coordinates[0], coordinates[1]);
            }
            if (name.Name == "captureScreen")
            {
                if (explicitTypes.Length != 0 || arguments.Length != 1)
                    return BadExpression(syntax, "captureScreen() takes one bit argument.");
                if (screen is null && !testing)
                    Error(syntax, "captureScreen() requires a solid screen declaration in the map.");
                else if (screen is { IsSolid: false })
                    Error(syntax, "captureScreen() requires a solid screen declaration in the map.");
                return new BoundCaptureScreen(CoerceArguments(arguments, [DataType.Bit], syntax)[0]);
            }
            if (name.Name == "sameFile")
            {
                if (explicitTypes.Length != 0 || arguments.Length != 2 || arguments.Any(argument => argument.Type.Shape.Kind != TypeKind.Bytes))
                    return BadExpression(syntax, "sameFile() requires two bytes values.");
                return new BoundSameFile(arguments[0], arguments[1]);
            }
            var key = LookupKey(name.Name, name);
            if (key is null)
                return ErrorValue;
            if (BuiltinTypes.ContainsKey(name.Name) || typeDeclarations.ContainsKey(key) ||
                name.TypeArguments.IsEmpty && args.ContainsKey(name.Name))
            {
                var target = name.TypeArguments.IsEmpty && args.TryGetValue(name.Name, out var parameter)
                    ? parameter
                    : ResolveNamedType(name.Name, explicitTypes, name);
                return BindConversion(target, arguments, syntax);
            }
            if (!functionDeclarations.TryGetValue(key, out var declaration))
                return name.Name switch
                {
                    "readFile" when explicitTypes.Length == 0 => BindFileImport(syntax, arguments),
                    "readFileIfPresent" when explicitTypes.Length == 0 => BindFileImport(syntax, arguments, optional: true),
                    "sharedBytes" when explicitTypes.Length == 0 => BindSharedBytes(syntax, arguments),
                    "len" when explicitTypes.Length == 0 => BindByteLength(syntax, arguments),
                    _ => BadExpression(syntax, $"Unknown function '{name.Name}'.")
                };
            var typeArguments = InferArguments(declaration, explicitTypes, arguments, syntax);
            if (typeArguments is null || Specialize(declaration, typeArguments, null) is not { } function)
                return ErrorValue;
            return BindInvocation(function, null, arguments, syntax);
        }
        if (syntax.Target is MemberExpressionSyntax member)
        {
            var receiver = BindExpression(member.Target, scope, args);
            if (receiver.Type == DataType.Error)
                return ErrorValue;
            if (receiver.Type.Shape.Kind == TypeKind.Interface)
            {
                if (!receiver.Type.Shape.Methods.TryGetValue(member.Member, out var signature))
                    return BadExpression(member, $"'{receiver.Type}' has no method '{member.Member}'.");
                if (!CanAccessMember(receiver.Type.Shape, member.Member, member))
                    return BadExpression(member, $"Method '{member.Member}' of '{receiver.Type}' is not exported.");
                return new BoundDispatch(signature.Result, member.Member, receiver, CoerceArguments(arguments, signature.Parameters, syntax));
            }
            EnsureMethods(receiver.Type);
            if (methods.GetValueOrDefault(receiver.Type)?.GetValueOrDefault(member.Member) is not { } method)
                return BadExpression(member, $"'{receiver.Type}' has no method '{member.Member}'.");
            if (!CanAccessMember(receiver.Type, member.Member, member))
                return BadExpression(member, $"Method '{member.Member}' of '{receiver.Type}' is not exported.");
            return BindInvocation(method, receiver, arguments, syntax);
        }
        return BadExpression(syntax, "A call requires a function or method name.");
    }

    private BoundExpression BindFileImport(CallExpressionSyntax syntax, BoundExpression[] arguments, bool optional = false)
    {
        var function = optional ? "readFileIfPresent" : "readFile";
        if (arguments is not [BoundLiteral { Value: string file } pathLiteral] || pathLiteral.Type.Shape.Kind != TypeKind.String)
            return BadExpression(syntax, $"{function}() requires one compile-time string path.");
        if (imports is null)
            return BadExpression(syntax, $"{function}() requires a file-based compilation.");

        try
        {
            var imported = optional ? imports.ReadIfPresent(FileOf(syntax).Path, file) : imports.Read(FileOf(syntax).Path, file);
            return new BoundLiteral(DataType.Bytes, imported);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return BadExpression(syntax, $"Cannot import '{file}': {error.Message}");
        }
    }

    private BoundExpression BindSharedBytes(CallExpressionSyntax syntax, BoundExpression[] arguments) =>
        arguments is [BoundLiteral { Value: string key } literal] && literal.Type.Shape.Kind == TypeKind.String
            ? new BoundSharedBytes(key)
            : BadExpression(syntax, "sharedBytes() requires one compile-time string key.");

    private BoundExpression BindByteLength(CallExpressionSyntax syntax, BoundExpression[] arguments)
    {
        if (arguments is not [var bytes] || bytes.Type.Shape.Kind != TypeKind.Bytes)
            return BadExpression(syntax, "len() requires one bytes value.");
        return bytes is BoundLiteral { Value: ImportedFile file } ? new BoundLiteral(DataType.Int, file.Data.Length) : new BoundByteLength(bytes);
    }

    private BoundCall BindInvocation(Function function, BoundExpression? receiver, BoundExpression[] arguments, CallExpressionSyntax syntax) =>
        new(function, receiver, CoerceArguments(arguments, [.. function.Parameters.Select(parameter => parameter.Type)], syntax));

    private BoundExpression[] CoerceArguments(BoundExpression[] arguments, DataType[] parameters, CallExpressionSyntax syntax)
    {
        if (arguments.Length != parameters.Length)
        {
            Error(syntax, $"Expected {parameters.Length} arguments, got {arguments.Length}.");
            return arguments;
        }
        return [.. arguments.Select((argument, index) => Coerce(argument, parameters[index], syntax.Arguments[index]))];
    }

    private BoundExpression BindConversion(DataType type, BoundExpression[] arguments, SyntaxNode location)
    {
        if (type == DataType.Error)
            return ErrorValue;
        if (arguments.Length != 1)
            return BadExpression(location, $"Conversion to '{type}' expects one argument.");
        var value = arguments[0];
        if (value.Type == type && value is BoundLiteral literal)
            return literal with { IsUntyped = false };
        if (value.Type == type || value.Type == DataType.Error)
            return value;
        if (type.IsNumber && value.Type.IsNumber ||
            type.Shape.Kind is TypeKind.Bit or TypeKind.String or TypeKind.Bytes or TypeKind.Color && value.Type.Shape == type.Shape)
            return new BoundConversion(type, value);
        if (type.Shape.Kind == TypeKind.Interface)
            return Coerce(value, type, location);
        return BadExpression(location, $"Cannot convert '{value.Type}' to '{type}'.");
    }

    private DataType[]? InferArguments(FunctionDeclarationSyntax function, DataType[] explicitTypes, BoundExpression[] arguments, SyntaxNode use)
    {
        var typeParameters = function.TypeParameters;
        if (explicitTypes.Length > 0)
        {
            if (explicitTypes.Length == typeParameters.Length)
                return explicitTypes;
            Error(use, $"'{function.Name}' expects {typeParameters.Length} type arguments.");
            return null;
        }
        if (typeParameters.IsEmpty)
            return [];
        if (arguments.Length != function.Parameters.Length)
        {
            Error(use, $"'{function.Name}' expects {function.Parameters.Length} arguments.");
            return null;
        }

        Dictionary<string, DataType> substitutions = [with(StringComparer.Ordinal)];
        var names = typeParameters.Select(parameter => parameter.Name).ToHashSet(StringComparer.Ordinal);
        for (var i = 0; i < arguments.Length; i++)
            Infer(function.Parameters[i].Type, arguments[i].Type);
        if (!typeParameters.All(parameter => substitutions.ContainsKey(parameter.Name)))
        {
            Error(use, $"Cannot infer all type arguments for '{function.Name}'. Supply them explicitly.");
            return null;
        }
        return [.. typeParameters.Select(parameter => substitutions[parameter.Name])];

        void Infer(TypeSyntax pattern, DataType actual)
        {
            switch (pattern)
            {
                case NamedTypeSyntax { TypeArguments.Length: 0 } name when names.Contains(name.Name):
                    if (substitutions.TryGetValue(name.Name, out var previous) && previous != actual)
                        Error(use, $"Conflicting types for '{name.Name}': '{previous}' and '{actual}'.");
                    else
                        substitutions[name.Name] = actual;
                    break;
                case NamedTypeSyntax name when name.TypeArguments.Length > 0 &&
                    nominal.TryGetValue(actual, out var actualDeclaration) && NominalKey(actualDeclaration) == LookupKey(name.Name, name, report: false):
                    for (var i = 0; i < Math.Min(name.TypeArguments.Length, actual.Arguments.Length); i++)
                        Infer(name.TypeArguments[i], actual.Arguments[i]);
                    break;
                case ArrayTypeSyntax array when actual.Shape.Kind == TypeKind.Array:
                    Infer(array.ElementType, actual.Shape.Element!);
                    break;
            }
        }
    }

    private BoundExpression BindMember(BoundExpression target, string name, SyntaxNode location)
    {
        if (target.Type == DataType.Error)
            return ErrorValue;
        if (!target.Type.Shape.Fields.TryGetValue(name, out var type))
            return BadExpression(location, $"'{target.Type}' has no field '{name}'.");
        return CanAccessMember(target.Type.Shape, name, location) ? new BoundMember(type, target, name)
            : BadExpression(location, $"Field '{name}' of '{target.Type}' is not exported.");
    }

    private BoundExpression BindIndex(BoundExpression target, BoundExpression index, SyntaxNode location)
    {
        var type = target.Type.Shape;
        if (type.Kind == TypeKind.Error || index.Type == DataType.Error)
            return ErrorValue;
        if (type.Kind == TypeKind.Bytes)
        {
            var element = BitVector(8);
            if (index is BoundLiteral { Value: int offset })
            {
                if (offset < 0)
                    return BadExpression(location, $"Byte index {offset} is out of bounds.");
                if (target is BoundLiteral { Value: ImportedFile file })
                    return offset < file.Data.Length ? new BoundLiteral(element, (uint)file.Data.Span[offset]) :
                        BadExpression(location, $"Byte index {offset} is out of bounds for a {file.Data.Length}-byte file.");
            }
            return new BoundIndex(element, target, index);
        }
        if (type.Kind is not (TypeKind.Bits or TypeKind.Array))
            return BadExpression(location, $"'{target.Type}' is not indexable.");
        if (index is BoundLiteral { Value: int constant } && (constant < 0 || constant >= type.Size))
            return BadExpression(location, $"Index {constant} is out of bounds for '{target.Type}'.");
        if (target is BoundLiteral { Value: ConstantArray array } && index is BoundLiteral { Value: int offsetInArray })
            return array.Items[offsetInArray];
        return new BoundIndex(type.Kind == TypeKind.Bits ? DataType.Bit : type.Element!, target, index);
    }

    private BoundExpression BindStruct(StructLiteralExpressionSyntax syntax, Scope scope, Dictionary<string, DataType> args)
    {
        var type = ResolveType(syntax.Type, args);
        if (type.Shape.Kind != TypeKind.Struct)
            return type == DataType.Error ? ErrorValue : BadExpression(syntax, $"'{type}' is not a struct.");
        Dictionary<string, BoundExpression> fields = [with(StringComparer.Ordinal)];
        foreach (var field in syntax.Fields)
        {
            if (!type.Shape.Fields.TryGetValue(field.Name, out var fieldType))
                Error(field, $"'{type}' has no field '{field.Name}'.");
            else if (!CanAccessMember(type.Shape, field.Name, field))
                Error(field, $"Field '{field.Name}' of '{type}' is not exported.");
            else if (!fields.TryAdd(field.Name, BindAs(field.Value, scope, args, fieldType)))
                Error(field, $"Field '{field.Name}' is already initialized.");
        }
        foreach (var (name, fieldType) in type.Shape.Fields)
        {
            if (!fields.ContainsKey(name))
                fields.Add(name, Zero(fieldType));
        }
        return new BoundStruct(type, fields);
    }

    private BoundExpression BindArray(ArrayLiteralExpressionSyntax syntax, Scope scope, Dictionary<string, DataType> args)
    {
        var type = ResolveType(syntax.Type, args);
        if (type.Shape is not { Kind: TypeKind.Array, Element: { } element })
            return ErrorValue;
        if (syntax.Values.Length > type.Size)
            return BadExpression(syntax, $"Array literal has more than {type.Size} elements.");
        var expressions = new BoundExpression[type.Size];
        for (var i = 0; i < expressions.Length; i++)
            expressions[i] = i < syntax.Values.Length ? BindAs(syntax.Values[i], scope, args, element) : Zero(element);
        return new BoundArray(type, expressions);
    }
}
