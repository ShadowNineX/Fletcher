using System.Collections.Immutable;
using Fletcher.Compiler.IR;
using Fletcher.Compiler.Maps;
using Fletcher.Compiler.Syntax;

namespace Fletcher.Compiler.Semantics;

internal sealed partial class Binder
{
    private static ImmutableArray<TypeParameterSyntax> Parameters(DeclarationSyntax type) => type switch
    {
        TypeDeclarationSyntax alias => alias.TypeParameters,
        StructDeclarationSyntax structure => structure.TypeParameters,
        InterfaceDeclarationSyntax contract => contract.TypeParameters,
        _ => []
    };

    private void CheckParameters(ImmutableArray<TypeParameterSyntax> parameters)
    {
        HashSet<string> names = [with(StringComparer.Ordinal)];
        foreach (var parameter in parameters)
        {
            if (parameter.Name == "_" || !names.Add(parameter.Name))
                Error(parameter, $"Invalid or duplicate type parameter '{parameter.Name}'.");
        }
    }

    private DataType ResolveType(TypeSyntax syntax, Dictionary<string, DataType> typeArguments) => syntax switch
    {
        NamedTypeSyntax named when named.TypeArguments.IsEmpty && typeArguments.TryGetValue(named.Name, out var parameter) => parameter,
        NamedTypeSyntax named => ResolveNamedType(named.Name, [.. named.TypeArguments.Select(arg => ResolveType(arg, typeArguments))], named),
        BitsTypeSyntax bits => BitVector(ConstantSize(bits.Width, 1, 32, "Bit width")),
        ArrayTypeSyntax array => ArrayType(ConstantSize(array.Length, 0, Array.MaxLength, "Array length"), ResolveType(array.ElementType, typeArguments)),
        MultipleResultTypeSyntax results => ResultList([.. results.Types.Select(type => ResolveType(type, typeArguments))]),
        _ => BadType(syntax, "Unsupported type.")
    };

    private readonly List<DataType> resultLists = [];

    private DataType ResultList(DataType[] items)
    {
        var existing = resultLists.Find(list => list.Fields.Values.SequenceEqual(items));
        if (existing is not null)
            return existing;
        var type = new DataType(TypeKind.Struct, $"({string.Join(", ", items.Select(item => item.Name))})") { IsResultList = true };
        for (var i = 0; i < items.Length; i++)
            type.Fields.Add($"item{i}", items[i]);
        resultLists.Add(type);
        return type;
    }

    private int ConstantSize(ExpressionSyntax syntax, int min, int max, string what)
    {
        var expression = BindAs(syntax, new Scope(), noTypeArguments, DataType.Int);
        if (RequireConstant(expression, syntax)?.Value is int size && size >= min && size <= max)
            return size;
        Error(syntax, $"{what} must be an integer between {min} and {max}.");
        return min;
    }

    private DataType BitVector(int size)
    {
        if (!bitVectors.TryGetValue(size, out var type))
        {
            type = new DataType(TypeKind.Bits, $"bits<{size}>", size);
            bitVectors.Add(size, type);
        }
        return type;
    }

    private DataType ArrayType(int length, DataType element)
    {
        if (!arrays.TryGetValue((length, element), out var type))
        {
            type = new DataType(TypeKind.Array, $"[{length}]{element}", length) { Element = element };
            arrays.Add((length, element), type);
        }
        return type;
    }

    private DataType ResolveNamedType(string name, DataType[] args, SyntaxNode use)
    {
        if (BuiltinTypes.TryGetValue(name, out var builtin))
            return args.Length == 0 ? builtin : BadType(use, $"'{name}' does not accept type arguments.");
        var key = LookupKey(name, use);
        if (key is null)
            return DataType.Error;
        if (!typeDeclarations.TryGetValue(key, out var declaration))
            return BadType(use, $"Unknown type '{name}'.");

        var parameters = Parameters(declaration);
        if (args.Length != parameters.Length)
            return BadType(use, $"'{name}' expects {parameters.Length} type arguments.");
        if (args.Contains(DataType.Error))
            return DataType.Error;
        if (resolvingTypes.Contains(declaration))
            return BadType(use, $"Type '{name}' recursively contains itself.");

        if (!instances.TryGetValue(declaration, out var cache))
        {
            cache = [];
            instances.Add(declaration, cache);
        }
        if (cache.Find(item => item.Arguments.SequenceEqual(args)) is { } found)
            return found.Type;

        resolvingTypes.Add(declaration);
        try
        {
            var substitutions = Substitutions(parameters, args);
            CheckConstraints(parameters, args, substitutions, use);
            var declaredName = FileOf(declaration).Syntax.PackageName is { } package
                ? $"{package}.{KeyName(key)}"
                : KeyName(key);
            var fullName = args.Length == 0 ? declaredName : $"{declaredName}<{string.Join(", ", args.Select(arg => arg.Name))}>";
            DataType result;
            switch (declaration)
            {
                case TypeDeclarationSyntax type when type.IsAlias:
                    result = ResolveType(type.Type, substitutions);
                    break;
                case TypeDeclarationSyntax type:
                    result = new DataType(TypeKind.Defined, fullName) { Arguments = args, Element = ResolveType(type.Type, substitutions) };
                    break;
                case StructDeclarationSyntax structure:
                    result = new DataType(TypeKind.Struct, fullName) { Arguments = args };
                    foreach (var field in structure.Fields)
                    {
                        if (field.Name == "_" || !result.Fields.TryAdd(field.Name, ResolveType(field.Type, substitutions)))
                            Error(field, $"Invalid or duplicate field '{field.Name}'.");
                    }
                    break;
                case InterfaceDeclarationSyntax contract:
                    result = new DataType(TypeKind.Interface, fullName) { Arguments = args };
                    foreach (var method in contract.Methods)
                    {
                        if (!method.TypeParameters.IsEmpty)
                            Error(method, "Interface methods cannot declare type parameters.");
                        var signature = new MethodSignature(
                            [.. method.Parameters.Select(p => ResolveType(p.Type, substitutions))],
                            method.ReturnType is { } returnType ? ResolveType(returnType, substitutions) : DataType.Void);
                        if (method.Name == "_" || !result.Methods.TryAdd(method.Name, signature))
                            Error(method, $"Invalid or duplicate method '{method.Name}'.");
                    }
                    break;
                default:
                    throw new InvalidOperationException("Unexpected type declaration.");
            }
            cache.Add(new Instance(args, result));
            if (declaration is not TypeDeclarationSyntax { IsAlias: true })
                nominal.Add(result, declaration);
            return result;
        }
        finally
        {
            resolvingTypes.Remove(declaration);
        }
    }

    private static Dictionary<string, DataType> Substitutions(ImmutableArray<TypeParameterSyntax> parameters, DataType[] args)
    {
        Dictionary<string, DataType> substitutions = [with(StringComparer.Ordinal)];
        for (var i = 0; i < args.Length; i++)
            substitutions.TryAdd(parameters[i].Name, args[i]);
        return substitutions;
    }

    private void CheckConstraints(
        ImmutableArray<TypeParameterSyntax> parameters, DataType[] args,
        Dictionary<string, DataType> substitutions, SyntaxNode use)
    {
        for (var i = 0; i < parameters.Length; i++)
        {
            if (parameters[i].Constraint is not { } constraint)
                continue;
            var interfaceType = ResolveType(constraint, substitutions);
            if (interfaceType == DataType.Error)
                continue;
            if (interfaceType.Shape.Kind != TypeKind.Interface)
                Error(constraint, "A type parameter constraint must be an interface.");
            else if (!Satisfies(args[i], interfaceType))
                Error(use, $"'{args[i]}' does not satisfy '{interfaceType}' for '{parameters[i].Name}'.");
        }
    }

    private bool Satisfies(DataType type, DataType contract)
    {
        EnsureMethods(type);
        var available = type.Kind == TypeKind.Defined && type.Shape.Kind == TypeKind.Interface
            ? type.Shape.Methods
            : type.Methods;
        foreach (var (name, expected) in contract.Shape.Methods)
        {
            if (!available.TryGetValue(name, out var actual) ||
                actual.Result != expected.Result || !actual.Parameters.SequenceEqual(expected.Parameters))
                return false;
            if (!IsExported(name) && nominal.TryGetValue(contract.Shape, out var contractDeclaration))
            {
                var implementationType = type.Shape.Kind == TypeKind.Interface ? type.Shape : type;
                if (!nominal.TryGetValue(implementationType, out var implementation) || !InSamePackage(implementation, contractDeclaration))
                    return false;
            }
        }
        return true;
    }

    private void AddMethod(FunctionDeclarationSyntax function)
    {
        if (function.Receiver?.Type is not NamedTypeSyntax receiver || receiver.Name.Contains('.'))
        {
            Error(function, "A method requires a named receiver type.");
            return;
        }
        if (!function.TypeParameters.IsEmpty)
        {
            Error(function, "Methods use their receiver's type parameters.");
            return;
        }

        var key = LocalKey(receiver.Name, receiver);
        if (!methodDeclarations.TryGetValue(key, out var declarations))
        {
            declarations = [with(StringComparer.Ordinal)];
            methodDeclarations.Add(key, declarations);
        }
        if (function.Name == "_" || !declarations.TryAdd(function.Name, function))
            Error(function, $"Invalid or duplicate method '{function.Name}' for '{receiver.Name}'.");
    }

    private string NominalKey(DeclarationSyntax type) => LocalKey(type switch
    {
        TypeDeclarationSyntax named => named.Name,
        StructDeclarationSyntax structure => structure.Name,
        InterfaceDeclarationSyntax contract => contract.Name,
        _ => throw new InvalidOperationException("Unexpected named type.")
    }, type);

    private void EnsureMethods(DataType type)
    {
        if (methods.ContainsKey(type) || !nominal.TryGetValue(type, out var declaration) ||
            !methodDeclarations.TryGetValue(NominalKey(declaration), out var templates))
            return;

        Dictionary<string, Function> implementations = [with(StringComparer.Ordinal)];
        methods.Add(type, implementations);
        foreach (var template in templates.Values)
        {
            var function = Specialize(template, [], type);
            if (function is null)
                continue;
            implementations.Add(function.Name, function);
            if (type.Shape.Fields.ContainsKey(function.Name))
                Error(template, $"Method '{function.Name}' conflicts with a field of '{type}'.");
            type.Methods.TryAdd(function.Name, new MethodSignature([.. function.Parameters.Select(p => p.Type)], function.Result));
        }
    }

    private Function? Specialize(FunctionDeclarationSyntax template, DataType[] args, DataType? receiverType)
    {
        if (args.Contains(DataType.Error))
            return null;
        if (specializations.Find(item => item.Declaration == template &&
            item.ReceiverType == receiverType && item.Arguments.SequenceEqual(args)) is { } existing)
            return existing.Function;
        // A recursive call with new type arguments would create more function
        // bodies before the call-graph check could see the cycle.
        for (var caller = bindingSpecialization; caller is not null; caller = caller.Parent)
        {
            if (caller.Declaration == template)
            {
                Error(template, $"Recursive specialization through '{template.Name}' is unsupported.");
                return null;
            }
        }

        var substitutions = Substitutions(template.TypeParameters, args);
        if (receiverType is not null && template.Receiver is { Type: NamedTypeSyntax receiverSyntax })
        {
            if (receiverSyntax.TypeArguments.Length != receiverType.Arguments.Length)
            {
                Error(receiverSyntax, "A generic receiver must list one type parameter for each type argument.");
                return null;
            }
            for (var i = 0; i < receiverType.Arguments.Length; i++)
            {
                if (receiverSyntax.TypeArguments[i] is not NamedTypeSyntax { TypeArguments.Length: 0 } parameter ||
                    !substitutions.TryAdd(parameter.Name, receiverType.Arguments[i]))
                {
                    Error(receiverSyntax, "A generic receiver must use distinct parameter names as its type arguments.");
                    return null;
                }
            }
        }
        CheckConstraints(template.TypeParameters, args, substitutions, template);
        var parameters = template.Parameters.Select(p => NewVariable(p.Name, ResolveType(p.Type, substitutions))).ToArray();
        var result = template.ReturnType is { } resultSyntax ? ResolveType(resultSyntax, substitutions) : DataType.Void;
        var receiver = template.Receiver is { } syntax && receiverType is not null ? NewVariable(syntax.Name, receiverType) : null;
        var function = new Function(specializations.Count, template.Name, parameters, result, receiver,
            FileOf(template).Syntax.DefaultBackend == BackendKind.Circuit);
        specializations.Add(new Specialization(template, args, receiverType, substitutions, function, bindingSpecialization));
        return function;
    }

    private BoundExpression Coerce(BoundExpression source, DataType target, SyntaxNode location)
    {
        if (target == source.Type || source.Type == DataType.Error || target == DataType.Error)
            return source;
        if (source.Type == DataType.Void)
            return BadExpression(location, $"A void expression cannot supply a '{target}' value.");
        if (target.Shape.Kind == TypeKind.Interface && Satisfies(source.Type, target))
        {
            int? tag = null;
            if (source.Type.Shape.Kind != TypeKind.Interface)
            {
                if (!tags.TryGetValue(source.Type, out var id))
                {
                    id = tags.Count;
                    tags.Add(source.Type, id);
                }
                tag = id;
            }
            return new BoundConversion(target, source, tag);
        }
        if (source is BoundLiteral literal && CanCoerceConstant(literal, target))
            return Constants.Convert(target, literal);

        return BadExpression(location, $"Cannot use '{source.Type}' as '{target}'.");
    }

    private static bool CanCoerceConstant(BoundLiteral literal, DataType target) => literal.IsUntyped &&
        (target.Kind == TypeKind.Defined && literal.Type == target.Shape ||
         target.Shape.Kind == TypeKind.Bits && literal.Value is int number && number >= 0 && (ulong)number < (1UL << target.Width));

    private BoundExpression Zero(DataType type) => type.Shape.Kind switch
    {
        TypeKind.Bit => new BoundLiteral(type, false),
        TypeKind.Bits => new BoundLiteral(type, 0u),
        TypeKind.String => new BoundLiteral(type, ""),
        TypeKind.Bytes => new BoundLiteral(type, ImportedFile.Empty),
        TypeKind.Color => new BoundLiteral(type, (int)TileColor.Black),
        TypeKind.Interface => new BoundLiteral(type, InterfaceLiteral.Null),
        TypeKind.Array => new BoundArray(type, [.. Enumerable.Range(0, type.Shape.Size).Select(_ => Zero(type.Shape.Element!))]),
        TypeKind.Struct => new BoundStruct(type, type.Shape.Fields.ToDictionary(field => field.Key, field => Zero(field.Value), StringComparer.Ordinal)),
        _ => new BoundLiteral(type, 0)
    };

}
