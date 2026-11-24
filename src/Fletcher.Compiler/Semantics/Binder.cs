using System.Collections.Frozen;
using System.Collections.Immutable;
using Fletcher.Compiler.IR;
using Fletcher.Compiler.Maps;
using Fletcher.Compiler.Syntax;

namespace Fletcher.Compiler.Semantics;

internal sealed partial class Binder(string path, IReadOnlyList<SourceUnit> units, FileImports? imports)
{
    private sealed class Scope(Scope? parent = null)
    {
        public Dictionary<string, Variable> Variables { get; } = [with(StringComparer.Ordinal)];
        public Variable? Find(string name) => Variables.GetValueOrDefault(name) ?? parent?.Find(name);
    }

    private sealed record Member(MapMemberSyntax Syntax, Backend Backend);
    private sealed record Instance(DataType[] Arguments, DataType Type);
    private sealed record Specialization(
        FunctionDeclarationSyntax Declaration, DataType[] Arguments, DataType? ReceiverType,
        Dictionary<string, DataType> TypeParameters, Function Function, Specialization? Parent);

    private static readonly FrozenDictionary<string, DataType> BuiltinTypes =
    [
        with(StringComparer.Ordinal),
        new("bit", DataType.Bit),
        new("int", DataType.Int),
        new("string", DataType.String),
        new("bytes", DataType.Bytes),
        new("color", DataType.Color)
    ];

    private readonly List<Diagnostic> diagnostics = [];
    private readonly Dictionary<string, DeclarationSyntax> typeDeclarations = [with(StringComparer.Ordinal)];
    private readonly Dictionary<string, ConstDeclarationSyntax> constantDeclarations = [with(StringComparer.Ordinal)];
    private readonly Dictionary<string, FunctionDeclarationSyntax> functionDeclarations = [with(StringComparer.Ordinal)];
    private readonly Dictionary<string, MacroDeclarationSyntax> macroDeclarations = [with(StringComparer.Ordinal)];
    private readonly Dictionary<string, Dictionary<string, FunctionDeclarationSyntax>> methodDeclarations = [with(StringComparer.Ordinal)];
    private readonly Dictionary<DeclarationSyntax, List<Instance>> instances = [];
    private readonly Dictionary<DataType, DeclarationSyntax> nominal = [];
    private readonly HashSet<DeclarationSyntax> resolvingTypes = [];
    private readonly HashSet<string> resolvingConstants = [with(StringComparer.Ordinal)];
    private readonly Dictionary<Variable, BoundLiteral> localConstants = [];
    private readonly Dictionary<string, BoundLiteral> globalConstants = [with(StringComparer.Ordinal)];
    private readonly Dictionary<int, DataType> bitVectors = [];
    private readonly Dictionary<(int Length, DataType Element), DataType> arrays = [];
    private readonly List<Specialization> specializations = [];
    private readonly Dictionary<DataType, Dictionary<string, Function>> methods = [];
    private readonly Dictionary<DataType, int> tags = [];
    private readonly Dictionary<string, DataType> noTypeArguments = [with(StringComparer.Ordinal)];
    private readonly Dictionary<string, SourceUnit> files = units.ToDictionary(unit => unit.Path, StringComparer.Ordinal);
    private Specialization? bindingSpecialization;
    private int nextVariable;
    private Screen? screen;
    private bool bindingTest;
    private bool testing;

    public IReadOnlyList<Diagnostic> Diagnostics => diagnostics;

    public IrProgram Bind(MapDeclarationSyntax map, TestDeclarationSyntax[]? tests = null)
    {
        testing = tests is not null;
        if (string.IsNullOrWhiteSpace(map.Name))
            Error(map, "A map requires a name.");
        var screens = map.Members.OfType<ScreenDeclarationSyntax>().ToArray();
        foreach (var duplicate in screens.Skip(1))
            Error(duplicate, "A map can declare one screen.");

        HashSet<string> topLevelNames = [with(StringComparer.Ordinal)];
        foreach (var declaration in units.SelectMany(unit => unit.Syntax.Declarations))
        {
            switch (declaration)
            {
                case ConstDeclarationSyntax constant when DeclareTopLevel(constant.Name, constant):
                    constantDeclarations.Add(LocalKey(constant.Name, constant), constant);
                    break;
                case FunctionDeclarationSyntax { Receiver: null } function when DeclareTopLevel(function.Name, function):
                    functionDeclarations.Add(LocalKey(function.Name, function), function);
                    CheckParameters(function.TypeParameters);
                    break;
                case FunctionDeclarationSyntax { Receiver: not null } function:
                    AddMethod(function);
                    break;
                case MacroDeclarationSyntax macro when DeclareTopLevel(macro.Name, macro):
                    macroDeclarations.Add(LocalKey(macro.Name, macro), macro);
                    ValidateMacroParameters(macro);
                    break;
                case DeclarationSyntax type when type is TypeDeclarationSyntax or StructDeclarationSyntax or InterfaceDeclarationSyntax:
                    DeclareNamedType(type);
                    break;
            }
        }

        void DeclareNamedType(DeclarationSyntax type)
        {
            var (name, parameters) = type switch
            {
                TypeDeclarationSyntax alias => (alias.Name, alias.TypeParameters),
                StructDeclarationSyntax structure => (structure.Name, structure.TypeParameters),
                InterfaceDeclarationSyntax contract => (contract.Name, contract.TypeParameters),
                _ => throw new InvalidOperationException("Unexpected named type declaration.")
            };
            if (!DeclareTopLevel(name, type))
                return;
            typeDeclarations.Add(LocalKey(name, type), type);
            CheckParameters(parameters);
        }

        foreach (var (key, declarations) in methodDeclarations)
        {
            if (!typeDeclarations.TryGetValue(key, out var type) || type is InterfaceDeclarationSyntax or TypeDeclarationSyntax { IsAlias: true })
                Error(declarations.Values.First(), $"Methods require a locally defined receiver type, but '{KeyName(key)}' is not one.");
        }

        foreach (var (name, declaration) in constantDeclarations)
            ResolveConstant(name, declaration);
        if (screens.FirstOrDefault() is { } screenSyntax)
            screen = BindScreen(screenSyntax);
        foreach (var (key, declaration) in typeDeclarations)
        {
            if (Parameters(declaration).IsEmpty)
                ResolveNamedType(KeyName(key), [], declaration);
        }
        foreach (var type in nominal.Keys.ToArray())
            EnsureMethods(type);
        foreach (var function in functionDeclarations.Values)
        {
            if (function.TypeParameters.IsEmpty)
                Specialize(function, [], null);
        }

        var scope = new Scope();
        var placementScope = new Scope();
        var defaultBackend = FileOf(map).Syntax.DefaultBackend switch
        {
            BackendKind.Circuit => Backend.Circuit,
            BackendKind.Script => Backend.Script,
            _ => Backend.Auto
        };
        var members = map.Members.SelectMany(member => member is BackendBlockSyntax block
            ? block.Members.Select(nested => new Member(nested, block.Kind == BackendKind.Circuit ? Backend.Circuit : Backend.Script))
            : [new Member(member, defaultBackend)]).ToArray();
        Dictionary<MapMemberSyntax, Variable> symbols = [];
        List<Port> ports = [];

        foreach (var (member, _) in members)
        {
            var (name, type, kind, position) = member switch
            {
                InputDeclarationSyntax input => (input.Name, input.Type, SymbolKind.Input, input.Position),
                OutputDeclarationSyntax output => (output.Name, output.Type, SymbolKind.Output, output.Position),
                WireDeclarationSyntax wire => (wire.Name, wire.Type, SymbolKind.Wire, null),
                RegisterDeclarationSyntax register => (register.Name, register.Type, SymbolKind.Register, null),
                _ => default
            };
            if (name is null || type is null)
                continue;

            var symbol = NewVariable(name, ResolveType(type, noTypeArguments), kind);
            if (!Declare(scope, symbol, member))
                continue;
            symbols.Add(member, symbol);
            if (kind is SymbolKind.Input or SymbolKind.Output)
            {
                if (!symbol.Type.IsSignal && symbol.Type != DataType.Error)
                    Error(type, "Ports require a bit or fixed-width signal type.");
                var keyboard = member is InputDeclarationSyntax input ? BindInputKey(input, symbol.Type) : (Key: (ushort?)null, Buffer: false);
                var (forward, lampStyle) = member is OutputDeclarationSyntax output ? BindOutputOptions(output) : (null, null);
                ports.Add(new Port(symbol, position is null ? null : BindPosition(position), keyboard.Key, keyboard.Buffer, forward, lampStyle));
            }
            else if (kind == SymbolKind.Register && !IsRegisterType(symbol.Type))
            {
                Error(type, "Registers require bit, bits<N>, int, string, bytes, color, interfaces, or arrays and structs of those types.");
            }
        }

        List<Binding> bindings = [];
        List<Register> registers = [];
        List<Tile> tiles = [];
        BoundBlock? tick = null;
        BoundBlock? hostTick = null;
        foreach (var (member, backend) in members)
        {
            if (symbols.TryGetValue(member, out var symbol))
            {
                switch (member)
                {
                    case OutputDeclarationSyntax output:
                        bindings.Add(new Binding(symbol, BindAs(output.Value, scope, noTypeArguments, symbol.Type), backend));
                        break;
                    case WireDeclarationSyntax wire:
                        if (wire.Published)
                        {
                            if (backend == Backend.Circuit)
                                Error(wire, "A published binding requires the script backend.");
                            if (!symbol.Type.IsSignal && symbol.Type != DataType.Error &&
                                symbol.Type.Shape is not { Kind: TypeKind.Array, Element.IsSignal: true })
                                Error(wire.Type, "A published binding requires a bit, bits<N>, or a fixed array of signals.");
                        }
                        bindings.Add(new Binding(symbol, BindAs(wire.Value, scope, noTypeArguments, symbol.Type),
                            wire.Published ? Backend.Script : backend, wire.Published, wire.HostPublished));
                        break;
                    case RegisterDeclarationSyntax register:
                        var initial = BindAs(register.Initializer, scope, noTypeArguments, symbol.Type);
                        if (RequireCompileTimeValue(initial, register.Initializer, Constants.EvaluateRegisterInitializer) is { } value)
                            registers.Add(new Register(symbol, value));
                        break;
                }
            }
            switch (member)
            {
                case TickBlockSyntax { OnHost: true } step when hostTick is null:
                    hostTick = BindBlock(step.Body, scope, noTypeArguments, null, inTick: true);
                    break;
                case TickBlockSyntax { OnHost: true } step:
                    Error(step, "A map can declare one host tick block.");
                    break;
                case TickBlockSyntax step when tick is null:
                    tick = BindBlock(step.Body, scope, noTypeArguments, null, inTick: true);
                    break;
                case TickBlockSyntax step:
                    Error(step, "A map can declare one tick block.");
                    break;
                case PlaceDeclarationSyntax or MacroExpansionSyntax:
                    BindPlacement(member, placementScope, tiles);
                    break;
            }
        }

        BoundTest[] boundTests = [];
        if (tests is not null)
        {
            bindingTest = true;
            boundTests = [.. tests.Select(test =>
            {
                if (string.IsNullOrWhiteSpace(test.Name))
                    Error(test, "A test requires a name.");
                return new BoundTest(test.Name, test.Span, BindBlock(test.Body, new Scope(), noTypeArguments, DataType.Void, inTick: false));
            })];
            bindingTest = false;
        }

        for (var i = 0; i < specializations.Count; i++)
        {
            bindingSpecialization = specializations[i];
            BindFunction(bindingSpecialization);
        }
        bindingSpecialization = null;

        ValidateFunctionCycles();
        ValidateHostTick(map, tick, hostTick, bindings);
        if (specializations.Exists(item => item.Function.RequiresCircuit))
        {
            PropagateCircuitRequirement();
            ValidateCircuitUse(tick, bindings, boundTests);
            RequireNoCircuitCall(hostTick, "host tick block");
        }
        return new IrProgram(map.Name, ports, OrderBindings(map, bindings), registers, tiles, screen, tick, methods, tags)
        {
            Functions = [.. specializations.Select(specialization => specialization.Function)],
            Tests = boundTests,
            HostTick = hostTick
        };

        bool DeclareTopLevel(string name, SyntaxNode location)
        {
            if (!BuiltinTypes.ContainsKey(name) && name is not ("_" or "bits" or "log" or "currentTick" or "hostTimeMillis" or "pixel" or "pixelIndexAt" or "preserveScreen" or "captureScreen" or "revealScreen" or "sameFile" or "mouseX" or "mouseY") &&
                topLevelNames.Add(LocalKey(name, location)))
                return true;
            Error(location, $"Cannot declare '{name}' in the top-level scope.");
            return false;
        }
    }

    private void ValidateHostTick(MapDeclarationSyntax map, BoundBlock? tick, BoundBlock? hostTick, List<Binding> bindings)
    {
        var hostBindings = bindings.Where(binding => binding.HostPublished).ToArray();
        if (hostTick is null && hostBindings.Length == 0)
            return;
        if (screen is not { IsSliced: true })
            Error(map, "Host ticks and publications require a sliced solid screen.");
        foreach (var register in BoundTree.RegisterWrites(tick).Intersect(BoundTree.RegisterWrites(hostTick)))
            Error(map, $"Register '{register.Name}' cannot be written by both tick and host tick.");

        var hostValues = hostBindings.Select(binding => binding.Value).ToArray();
        if (BoundTree.References(hostTick).Concat(hostValues.SelectMany(BoundTree.References))
            .Any(variable => variable.IsMapValue && variable.Kind != SymbolKind.Register))
            Error(map, "Host ticks and publications read map values through registers.");
        var published = hostBindings.Select(binding => binding.Symbol).ToHashSet();
        if (BoundTree.References(tick).Concat(bindings.SelectMany(binding => BoundTree.References(binding.Value))).Any(published.Contains))
            Error(map, "A host publication is only visible to map scripts.");

        if (BoundTree.UsesScreenOrMouse(hostTick) || hostValues.Any(BoundTree.UsesScreenOrMouse) || UsesHostRestrictedFunction())
            Error(map, "Host ticks and publications cannot use the screen or pointer.");

        bool UsesHostRestrictedFunction()
        {
            var roots = BoundTree.Calls(hostTick).Concat(hostValues.SelectMany(BoundTree.Calls))
                .Concat(Implementations(BoundTree.Dispatches(hostTick).Concat(hostValues.SelectMany(BoundTree.Dispatches))));
            Stack<Function> pending = [with(roots)];
            HashSet<Function> seen = [];
            while (pending.TryPop(out var function))
            {
                if (!seen.Add(function))
                    continue;
                if (BoundTree.UsesScreenOrMouse(function.Body))
                    return true;
                foreach (var called in BoundTree.Calls(function.Body).Concat(Implementations(BoundTree.Dispatches(function.Body))))
                    pending.Push(called);
            }
            return false;
        }

        IEnumerable<Function> Implementations(IEnumerable<BoundDispatch> calls)
        {
            foreach (var call in calls)
            foreach (var table in methods.Values)
                if (table.TryGetValue(call.Method, out var method) &&
                    call.Receiver.Type.Shape.Methods.TryGetValue(call.Method, out var signature) &&
                    method.Result == signature.Result && method.Parameters.Select(parameter => parameter.Type).SequenceEqual(signature.Parameters))
                    yield return method;
        }
    }

    private void PropagateCircuitRequirement()
    {
        // A normal helper becomes native-only too when it calls a function
        // declared in a circuit-default source file.  Iterate instead of
        // recursing so diagnostics for ordinary recursion remain independent.
        var changed = true;
        while (changed)
        {
            changed = false;
            foreach (var function in specializations.Select(item => item.Function))
            {
                if (!function.RequiresCircuit && (BoundTree.Calls(function.Body).Any(called => called.RequiresCircuit) ||
                    BoundTree.Dispatches(function.Body).Any(RequiresCircuitDispatch)))
                {
                    function.RequiresCircuit = true;
                    changed = true;
                }
            }
        }
    }

    private void ValidateCircuitUse(BoundBlock? tick, IReadOnlyList<Binding> bindings, IReadOnlyList<BoundTest> tests)
    {
        // Script bindings, ticks, and standalone test scripts cannot invoke a
        // native-only function.  An Auto binding is deliberately left for the
        // map compiler: it can still lower the call natively and must not fall
        // back to JavaScript if lowering or routing fails.
        foreach (var binding in bindings.Where(binding => binding.Backend == Backend.Script))
            RequireNoCircuitCall(binding.Value, binding.Symbol.Name);
        RequireNoCircuitCall(tick, "tick block");
        foreach (var test in tests)
            RequireNoCircuitCall(test.Body, $"test '{test.Name}'");
    }

    private void RequireNoCircuitCall(BoundStatement? body, string context)
    {
        var function = BoundTree.Calls(body).FirstOrDefault(function => function.RequiresCircuit);
        if (function is not null)
        {
            Error(specializations[function.Id].Declaration,
                $"'{context}' cannot invoke '{function.Name}': it requires native circuit lowering because it is circuit-only.");
            return;
        }

        // Dispatch has no statically selected Function.  A circuit-default
        // implementation is necessarily incompatible because dispatch itself
        // has no native lowering; reject that conservative case rather than
        // silently emitting it into the script backend.
        var dispatch = BoundTree.Dispatches(body).FirstOrDefault(RequiresCircuitDispatch);
        if (dispatch is not null)
            Error(specializations.First(item => IsCircuitDispatchTarget(item.Function, dispatch)).Declaration,
                $"'{context}' cannot dispatch '{dispatch.Method}': it requires native circuit lowering because it is circuit-only.");
    }

    private void RequireNoCircuitCall(BoundExpression expression, string context)
    {
        var function = BoundTree.Calls(expression).FirstOrDefault(function => function.RequiresCircuit);
        if (function is not null)
        {
            Error(specializations[function.Id].Declaration,
                $"'{context}' cannot invoke '{function.Name}': it requires native circuit lowering because it is circuit-only.");
            return;
        }
        var dispatch = BoundTree.Dispatches(expression).FirstOrDefault(RequiresCircuitDispatch);
        if (dispatch is not null)
            Error(specializations.First(item => IsCircuitDispatchTarget(item.Function, dispatch)).Declaration,
                $"'{context}' cannot dispatch '{dispatch.Method}': it requires native circuit lowering because it is circuit-only.");
    }

    private bool RequiresCircuitDispatch(BoundDispatch dispatch) => methods.Values
        .SelectMany(implementations => implementations.Values)
        .Any(function => IsCircuitDispatchTarget(function, dispatch));

    private static bool IsCircuitDispatchTarget(Function function, BoundDispatch dispatch) =>
        function.RequiresCircuit && dispatch.Receiver.Type.Shape.Methods.TryGetValue(dispatch.Method, out var signature) &&
        function.Name == dispatch.Method && function.Result == signature.Result &&
        function.Parameters.Select(parameter => parameter.Type).SequenceEqual(signature.Parameters);

    private BoundLiteral ResolveConstant(string name, SyntaxNode use)
    {
        if (globalConstants.TryGetValue(name, out var existing))
            return existing;
        if (!resolvingConstants.Add(name))
            return BadExpression(use, $"Constant '{KeyName(name)}' has a circular initializer.");

        try
        {
            var declaration = constantDeclarations[name];
            var scope = new Scope();
            var expression = declaration.Type is null
                ? BindExpression(declaration.Value, scope, noTypeArguments)
                : BindAs(declaration.Value, scope, noTypeArguments, ResolveType(declaration.Type, noTypeArguments));
            var value = RequireConstant(expression, declaration.Value, allowArray: true) ?? ErrorValue;
            if (declaration.Type is not null)
                value = value with { IsUntyped = false };
            globalConstants.Add(name, value);
            return value;
        }
        finally
        {
            resolvingConstants.Remove(name);
        }
    }

    private Position BindPosition(PositionSyntax position, Scope? scope = null)
    {
        scope ??= new Scope();
        return new Position(
            (int)(RequireConstant(BindAs(position.X, scope, noTypeArguments, DataType.Int), position.X)?.Value ?? 0),
            (int)(RequireConstant(BindAs(position.Y, scope, noTypeArguments, DataType.Int), position.Y)?.Value ?? 0));
    }

    private Tile? BindTile(PlaceDeclarationSyntax placement, Scope scope)
    {
        var position = BindPosition(placement.Position, scope);
        var options = BindOptions(placement.Options, scope);
        byte rotation = placement.Facing switch { null or "up" => 0, "right" => 1, "down" => 2, "left" => 3, _ => 255 };
        try
        {
            return TileCatalog.Create(placement.Kind, position, rotation, placement.Flipped, options);
        }
        catch (ArgumentException error)
        {
            Error(placement, error.Message);
            return null;
        }
    }

    private Dictionary<string, object> BindOptions(ImmutableArray<OptionSyntax> options, Scope? scope = null)
    {
        scope ??= new Scope();
        Dictionary<string, object> values = [with(StringComparer.Ordinal)];
        foreach (var option in options)
        {
            var value = RequireConstant(BindExpression(option.Value, scope, noTypeArguments), option.Value);
            if (value is not null && !values.TryAdd(option.Name, value.Value))
                Error(option, $"Tile option '{option.Name}' is already set.");
        }
        return values;
    }

    private (ushort? Key, bool Buffer) BindInputKey(InputDeclarationSyntax input, DataType type)
    {
        var options = BindOptions(input.Options);
        foreach (var option in input.Options.Where(option => option.Name is not ("key" or "buffer")))
            Error(option, $"Unknown input option '{option.Name}'.");
        var buffer = false;
        if (options.TryGetValue("buffer", out var buffered))
        {
            if (buffered is bool enabled)
                buffer = enabled;
            else
                Error(input, "Input buffer must be true or false.");
        }
        if (!options.TryGetValue("key", out var value))
        {
            if (buffer)
                Error(input, "Input buffering requires a keyboard key.");
            return (null, false);
        }
        if (type.Shape.Kind != TypeKind.Bit)
        {
            Error(input.Type, "A keyboard input requires a bit port.");
            return (null, false);
        }
        if (value is string { Length: 1 } name)
        {
            var key = TileCatalog.KeyboardKeys.IndexOf(char.ToUpperInvariant(name[0]));
            if (key > 0)
                return ((ushort)key, buffer);
        }
        Error(input, "Input key must be a letter from A to Z or a digit from 0 to 9.");
        return (null, false);
    }

    private (byte? Forward, ushort? LampStyle) BindOutputOptions(OutputDeclarationSyntax output)
    {
        var options = BindOptions(output.Options);
        byte? forward = null;
        if (options.Remove("forward", out var value))
        {
            if (output.Position is null)
                Error(output, "A forwarding output requires a fixed position.");
            forward = value switch { "up" => 0, "right" => 1, "down" => 2, "left" => 3, _ => null };
            if (forward is null)
                Error(output, "Output forward must be 'up', 'right', 'down', or 'left'.");
        }

        if (options.Count == 0)
            return (forward, null);
        options.TryAdd("color", "green");
        options.TryAdd("bright", true);
        try
        {
            return (forward, TileCatalog.Create("lamp", default, 0, false, options).Extra);
        }
        catch (ArgumentException error)
        {
            Error(output, error.Message);
            return (forward, null);
        }
    }

    private Screen? BindScreen(ScreenDeclarationSyntax syntax)
    {
        var origin = BindPosition(syntax.Origin);
        var size = BindPosition(syntax.Size);
        var options = BindOptions(syntax.Options);
        var style = options.Remove("style", out var value) ? value : "lamp";
        if (style is not ("lamp" or "solid"))
        {
            Error(syntax, "Screen style must be 'lamp' or 'solid'.");
            return null;
        }
        if (size.X <= 0 || size.Y <= 0)
        {
            Error(syntax.Size, "A screen requires positive dimensions.");
            return null;
        }
        var endX = (long)origin.X + size.X - 1;
        var endY = (long)origin.Y + size.Y - 1;
        if (!origin.FitsMap || !Position.CoordinateFitsMap(endX) || !Position.CoordinateFitsMap(endY))
        {
            Error(syntax, "The screen extends outside the v5 map coordinate range.");
            return null;
        }
        var chunkColumns = (endX >> 4) - (origin.X >> 4) + 1;
        var chunkRows = (endY >> 4) - (origin.Y >> 4) + 1;
        if (chunkColumns * chunkRows > MapCodec.MaximumChunks)
        {
            Error(syntax, $"The screen alone exceeds the v5 limit of {MapCodec.MaximumChunks:N0} chunks.");
            return null;
        }

        options.TryAdd("color", "green");
        try
        {
            if (style is "solid")
            {
                var hold = false;
                var slice = false;
                if (options.Remove("hold", out var holdOption))
                {
                    if (holdOption is not bool enabled)
                    {
                        Error(syntax, "The screen hold option requires a bit.");
                        return null;
                    }
                    hold = enabled;
                }
                if (options.Remove("slice", out var sliceOption))
                {
                    if (sliceOption is not bool enabled)
                    {
                        Error(syntax, "The screen slice option requires a bit.");
                        return null;
                    }
                    slice = enabled;
                }
                if (options.Keys.Any(name => name != "color"))
                {
                    Error(syntax, "Solid screens accept color, hold, and slice options.");
                    return null;
                }
                var pixel = TileCatalog.Create("wall", origin, 0, false, options);
                const ushort Black = (ushort)TileColor.Black;
                if (pixel.Extra == Black)
                {
                    Error(syntax, "A solid screen requires a visible foreground color against its black background.");
                    return null;
                }
                return FitScreen(new Screen(pixel with { Extra = Black }, size.X, size.Y, pixel.Extra, hold, slice));
            }
            options.TryAdd("bright", true);
            var lamp = TileCatalog.Create("lamp", origin, 0, false, options);
            var signal = (ushort)(lamp.Extra & 15);
            if (signal == 0)
            {
                Error(syntax, "Screen color must be red, blue, yellow, green, orange, or purple.");
                return null;
            }
            return FitScreen(new Screen(lamp, size.X, size.Y, signal));
        }
        catch (ArgumentException error)
        {
            Error(syntax, error.Message);
            return null;
        }

        Screen? FitScreen(Screen screen)
        {
            // Each screen chunk has one tile-type group. Check its exact body
            // size before allocating the pixel grid in the target layout.
            var bytes = 2 + 7 * chunkColumns * chunkRows + screen.PixelCount * MapCodec.TileBodyBytes(screen.Background);
            if (bytes <= MapCodec.MaximumLevelBytes)
                return screen;
            Error(syntax, $"The screen alone uses {bytes:N0} expanded Level bytes. The game allows at most 16 MiB.");
            return null;
        }
    }

    private List<Binding> OrderBindings(MapDeclarationSyntax map, List<Binding> bindings)
    {
        var bySymbol = bindings.ToDictionary(binding => binding.Symbol);
        HashSet<Variable> visiting = [];
        HashSet<Variable> done = [];
        List<Binding> ordered = [];
        foreach (var binding in bindings)
            Visit(binding);
        return ordered;

        void Visit(Binding binding)
        {
            if (done.Contains(binding.Symbol))
                return;
            if (!visiting.Add(binding.Symbol))
            {
                Error(map, $"Combinational cycle through '{binding.Symbol.Name}'. Use a register for feedback.");
                return;
            }
            foreach (var reference in BoundTree.References(binding.Value).Distinct())
            {
                if (bySymbol.TryGetValue(reference, out var dependency))
                    Visit(dependency);
            }
            visiting.Remove(binding.Symbol);
            done.Add(binding.Symbol);
            ordered.Add(binding);
        }
    }

    private static bool IsRegisterType(DataType type)
    {
        var shape = type.Shape;
        return shape.Kind switch
        {
            TypeKind.Bit or TypeKind.Bits or TypeKind.Int or TypeKind.String or TypeKind.Bytes or TypeKind.Color
                or TypeKind.Interface or TypeKind.Error => true,
            TypeKind.Array => IsRegisterType(shape.Element!),
            TypeKind.Struct => shape.Fields.Values.All(IsRegisterType),
            _ => false,
        };
    }

    private BoundLiteral? RequireConstant(BoundExpression expression, SyntaxNode location, bool allowArray = false) =>
        RequireCompileTimeValue<BoundLiteral>(expression, location, allowArray ? Constants.EvaluateDeclaration : Constants.Evaluate);

    private T? RequireCompileTimeValue<T>(BoundExpression expression, SyntaxNode location, Func<BoundExpression, T?> evaluate)
        where T : BoundExpression
    {
        if (expression.Type == DataType.Error)
            return null;
        try
        {
            if (evaluate(expression) is { } value)
                return value;
            Error(location, "A compile-time constant is required here.");
        }
        catch (ArithmeticException)
        {
            Error(location, "Invalid arithmetic in constant expression.");
        }
        return null;
    }

    private Variable NewVariable(string name, DataType type, SymbolKind kind = SymbolKind.Local) => new(nextVariable++, name, type, kind);

    private bool Declare(Scope scope, Variable variable, SyntaxNode location)
    {
        if (variable.Name != "_" && scope.Variables.TryAdd(variable.Name, variable))
            return true;
        Error(location, $"Cannot declare '{variable.Name}' in this scope.");
        return false;
    }

    private void Error(SyntaxNode node, string message) => diagnostics.Add(new Diagnostic(node.Span.SourcePath ?? path, node.Span, message));
    private static BoundLiteral ErrorValue => new(DataType.Error, 0);

    private BoundLiteral BadExpression(SyntaxNode node, string message)
    {
        Error(node, message);
        return ErrorValue;
    }

    private DataType BadType(SyntaxNode node, string message)
    {
        Error(node, message);
        return DataType.Error;
    }
}
