using System.Globalization;
using System.Text;
using System.Text.Json;
using Fletcher.Compiler.IR;
using Fletcher.Compiler.Maps;
using Fletcher.Compiler.Syntax;

namespace Fletcher.Compiler.CodeGeneration;

internal sealed partial class ScriptEmitter(IrProgram program, bool splitTables = false)
{
    private const string EvenFrame = "__fletcherEven";
    private const string OddFrame = "__fletcherOdd";
    private readonly StringBuilder text = new();
    private readonly Dictionary<DataType, string> copiers = [];
    private readonly List<string> copierDeclarations = [];
    private readonly HashSet<Function> directSlicedFunctions = [];
    private readonly HashSet<Function> ownedResults = [];
    private int indent;
    private int nextTemporary;
    private bool sliced;
    private Func<TextSpan, string>? testLocation;
    public bool UsesMouse { get; private set; }
    public bool UsesPixelIndices { get; private set; }

    private void EmitRuntimeCore()
    {
        if (sliced)
            Line("let __budget;");
        Line("""
            function __index(i, size) {
                if (i < 0 || i >= size) throw new Error("Fletcher index out of bounds: " + i);
                return i;
            }
            function __div(a, b) {
                if (b === 0) throw new Error("Fletcher division by zero");
                return Math.trunc(a / b);
            }
            function __rem(a, b) {
                if (b === 0) throw new Error("Fletcher division by zero");
                return a % b;
            }
            """);
    }

    // A checkpoint suspended at the slice boundary uses a slot after resumption.
    private void EmitWorkStep()
    {
        if (sliced)
            Line("if (__budget === 0) yield; --__budget;");
    }

    public string EmitController(
        IReadOnlyList<Binding> bindings,
        IReadOnlyDictionary<Variable, Position[]> samples,
        IReadOnlyList<Variable> exports,
        IReadOnlyList<BufferedKeyGroup> keyGroups)
    {
        sliced = program.Screen?.IsSliced == true;
        if (!HasHostWork)
            Line("const __p = [];");
        EmitRuntimeCore();
        Line("function __read(x, y) { return world.getSignal(x, y) > 0; }");
        Function[] reachable = [.. ReachableFunctions(bindings)];
        AnalyzeOwnedResults(reachable);
        if (sliced)
        {
            var dispatched = DispatchedMethods().ToHashSet();
            foreach (var function in reachable)
                if (!dispatched.Contains(function) && !BoundTree.HasLoopOrCall(function.Body) && CachedFileReadValue(function) is null)
                    directSlicedFunctions.Add(function);
        }
        UsesMouse = BoundTree.UsesMouse(program.Tick) || bindings.Any(binding => BoundTree.UsesMouse(binding.Value)) ||
            Array.Exists(reachable, function => BoundTree.UsesMouse(function.Body));
        UsesPixelIndices = BoundTree.UsesPixelIndices(program.Tick) || bindings.Any(binding => BoundTree.UsesPixelIndices(binding.Value)) ||
            Array.Exists(reachable, function => BoundTree.UsesPixelIndices(function.Body));
        if (UsesMouse)
        {
            Line("""
                let __mouseX = -1, __mouseY = -1;
                onPlayerMouseMove((x, y) => {
                    __mouseX = Math.min(1024, Math.max(0, (x * 1024) | 0));
                    __mouseY = Math.min(1024, Math.max(0, (y * 1024) | 0));
                });
                """);
        }
        if (program.Screen is { } screen)
            EmitScreen(screen);
        foreach (var function in reachable)
            EmitFunction(function);

        EmitMethodDispatch();
        if (sliced)
        {
            EmitSlicedController(bindings, samples, exports, keyGroups);
            EmitSupportCode();
            return text.ToString();
        }
        Line("always(() => {");
        indent++;
        if (splitTables)
            Line("if (!__prepareTables()) return;");
        if (program.Screen is { IsSolid: true })
        {
            Line("__pixels.fill(__background);");
            if (UsesPixelIndices)
                Line("__pixelIndices.fill(0);");
        }
        if (program.Screen is { Hold: true })
            Line("__drawn = false;");
        var initial = string.Join(", ", program.Registers.Select(register => Copy(register.Initial)));
        Line($"const __registers = state.reg ?? [{initial}];");
        Line("const __next = __registers.slice();");
        for (var i = 0; i < program.Registers.Count; i++)
            Line($"{Name(program.Registers[i].Symbol)} = __registers[{i}];");
        foreach (var (symbol, positions) in samples.OrderBy(pair => pair.Key.Id))
            Line($"{Name(symbol)} = {Read(symbol.Type, positions)};");
        foreach (var binding in bindings)
            Line($"{Name(binding.Symbol)} = {Expr(binding.Value)};");
        if (program.Tick is { } tick)
            EmitStatements(tick);
        if (program.Screen is { IsSolid: true })
            Line("__present();");
        Line("state.reg = __next;");
        var published = PublishedFrame(bindings.Where(binding => binding.Published));
        if (exports.Count > 0 || published is not null)
        {
            Line("const __t = world.getTick();");
            PublishFrame("__t", $"[{string.Join(", ", exports.Select(Name))}]", published);
        }
        indent--;
        Line("});");
        EmitSupportCode();
        return text.ToString();
    }

    private bool HasHostWork => program.HostTick is not null || program.Bindings.Any(binding => binding.HostPublished);

    private string? PublishedFrame(IEnumerable<Binding> bindings)
    {
        string[] fields = [.. bindings.Select(binding =>
            $"[{Quote(binding.Symbol.Name)}]: {Copy(new BoundVariable(binding.Symbol))}")];
        return fields.Length == 0 ? null : $"{{ {string.Join(", ", fields)} }}";
    }

    private void PublishFrame(string tick, string values, string? published)
    {
        var names = published is null ? "" : $", p: {published}";
        Line($"const __frame = {{ t: {tick}, v: {values}{names} }};");
        Line($"if ({tick} % 2 === 0) globalState.{EvenFrame} = __frame;");
        Line($"else globalState.{OddFrame} = __frame;");
    }

    private void EmitMethodDispatch()
    {
        Line("const __methods = {");
        indent++;
        foreach (var (type, tag) in program.TypeTags.OrderBy(pair => pair.Value))
        {
            var implementations = program.Methods.TryGetValue(type, out var methods)
                ? string.Join(", ", methods.Select(pair => $"[{Quote(pair.Key)}]: __f{pair.Value.Id}"))
                : "";
            Line($"{tag}: {{ {implementations} }},");
        }
        indent--;
        Line("};");
        Line($$"""
            {{(sliced ? "function*" : "function")}} __dispatch(receiver, method, ...args) {
                if (receiver === null) throw new Error("Fletcher call on an uninitialized interface");
                {{(sliced ? "return yield*" : "return")}} __methods[receiver.t][method](receiver.v, ...args);
            }
            """);
    }

    private IEnumerable<Function> DispatchedMethods() =>
        program.TypeTags.Keys.Where(program.Methods.ContainsKey).SelectMany(type => program.Methods[type].Values);

    private IEnumerable<Function> ReachableFunctions(IReadOnlyList<Binding> bindings)
    {
        Stack<Function> work = [with(BoundTree.Calls(program.Tick).Concat(BoundTree.Calls(program.HostTick))
            .Concat(bindings.SelectMany(binding => BoundTree.Calls(binding.Value)))
            .Concat(DispatchedMethods())
            .Concat(program.Tests.SelectMany(test => BoundTree.Calls(test.Body))))];
        HashSet<Function> reachable = [];
        while (work.TryPop(out var function))
        {
            if (!reachable.Add(function))
                continue;
            foreach (var callee in BoundTree.Calls(function.Body))
                work.Push(callee);
        }
        return reachable.OrderBy(function => function.Id);
    }

    public static string EmitDriver(int exportIndex, int lane, bool vector) =>
        $$"""
        const {x, y} = getPosition();
        always(() => {
            const t = world.getTick() - 1;
            const f = t < 0 ? null : t % 2 === 0 ? globalState.{{EvenFrame}} : globalState.{{OddFrame}};
            const v = f?.t === t ? f.v[{{exportIndex}}] : 0;
            world.setSignal(x, y, {{(vector ? $"(v >>> {lane}) & 1" : "v ? 1 : 0")}});
        });
        """;

    internal readonly record struct OutputLane(Position Position, int ExportIndex, int Lane, bool IsVector);

    public static string EmitDriverBatch(OutputLane[] lanes)
    {
        var script = new StringBuilder().AppendLine($$"""
            always(() => {
                const t = world.getTick() - 1;
                const f = t < 0 ? null : t % 2 === 0 ? globalState.{{EvenFrame}} : globalState.{{OddFrame}};
                const values = f?.t === t ? f.v : null;
            """);
        foreach (var output in lanes.GroupBy(lane => lane.ExportIndex))
        {
            var value = $"v{output.Key}";
            script.AppendLine($"    const {value} = values?.[{output.Key}] ?? 0;");
            foreach (var lane in output)
            {
                var signal = lane.IsVector ? $"({value} >>> {lane.Lane}) & 1" : $"{value} ? 1 : 0";
                script.AppendLine($"    world.setSignal({lane.Position.X}, {lane.Position.Y}, {signal});");
            }
        }
        return script.Append("});").ToString();
    }

    private static string Read(DataType type, Position[] positions)
    {
        if (type.Shape.Kind == TypeKind.Bit)
            return $"__read({positions[0].X}, {positions[0].Y})";
        var bits = positions.Select((position, index) => $"(__read({position.X}, {position.Y}) << {index})");
        return $"(({string.Join(" | ", bits)}) >>> 0)";
    }

    private void EmitFunction(Function function)
    {
        Variable[] parameters = function.Receiver is { } receiver ? [receiver, .. function.Parameters] : function.Parameters;
        var direct = directSlicedFunctions.Contains(function);
        Line($"function{(sliced && !direct ? "*" : "")} __f{function.Id}({string.Join(", ", parameters.Select(Name))}) {{");
        indent++;
        if (!sliced || !TryEmitCachedFileRead(function))
        {
            if (direct)
                Line("--__budget;");
            else
                EmitWorkStep();
            foreach (var parameter in CopiedParameters(function))
                Line($"{Name(parameter)} = {Copy(parameter.Type, Name(parameter))};");
            if (function.Body is { } body)
                EmitStatements(body);
        }
        indent--;
        Line("}");
    }

    private void EmitStatements(BoundBlock block)
    {
        foreach (var statement in block.Statements)
            EmitStatement(statement);
    }

    private void EmitStatement(BoundStatement statement)
    {
        switch (statement)
        {
            case BoundBlock block:
                Line("{");
                indent++;
                EmitStatements(block);
                indent--;
                Line("}");
                break;
            case BoundLocals locals:
            {
                EmitResultSource(locals.ResultSource);
                var names = locals.Values.Select(value => Temporary(Copy(value))).ToArray();
                for (var i = 0; i < names.Length; i++)
                {
                    if (locals.Symbols[i] is { } local)
                        Line($"{(locals.IsNew[i] ? "let " : "")}{Name(local)} = {names[i]};");
                }
                break;
            }
            case BoundAssignment assignment:
            {
                var targets = assignment.Targets.Select(target => target is null ? null : Capture(target)).ToArray();
                EmitResultSource(assignment.ResultSource);
                var values = assignment.Values.Select(value => Temporary(Copy(value))).ToArray();
                for (var i = 0; i < values.Length; i++)
                    targets[i]?.Assign(values[i]);
                break;
            }
            case BoundIf conditional:
                Line($"if ({Expr(conditional.Condition)}) {{");
                indent++;
                EmitStatements(conditional.Then);
                indent--;
                if (conditional.Else is { } otherwise)
                {
                    Line("} else {");
                    indent++;
                    EmitStatement(otherwise);
                    indent--;
                }
                Line("}");
                break;
            case BoundSwitch selection:
                Line($"switch ({Expr(selection.Selector)}) {{");
                indent++;
                foreach (var clause in selection.Cases)
                {
                    foreach (var value in clause.Values)
                        Line($"case {Expr(value)}:");
                    EmitCaseBody(clause.Body);
                }
                if (selection.Default is { } otherwiseClause)
                {
                    Line("default:");
                    EmitCaseBody(otherwiseClause);
                }
                indent--;
                Line("}");
                break;
            case BoundRange loop:
            {
                var kind = loop.Collection.Type.Shape.Kind;
                var collection = Temporary(kind == TypeKind.String ? $"Array.from({Expr(loop.Collection)})" : Copy(loop.Collection));
                var length = kind switch
                {
                    TypeKind.Int => collection,
                    TypeKind.Bytes => FileSize(collection),
                    _ => $"{collection}.length"
                };
                var index = $"__t{nextTemporary++}";
                Line($"for (let {index} = 0; {index} < {length}; {index}++) {{");
                indent++;
                EmitWorkStep();
                if (loop.Index is { } indexVariable)
                    Line($"let {Name(indexVariable)} = {index};");
                if (loop.Value is { } value)
                {
                    var element = kind == TypeKind.Bytes ? FileByte(collection, index) : Copy(value.Type, $"{collection}[{index}]");
                    Line($"let {Name(value)} = {element};");
                }
                EmitStatements(loop.Body);
                indent--;
                Line("}");
                break;
            }
            case BoundReturn { Value: { } value }:
                Line($"return {Expr(value)};");
                break;
            case BoundReturn:
                Line("return;");
                break;
            case BoundNext next:
                var registerIndex = program.Registers.Select(register => register.Symbol).ToList().IndexOf(next.Register);
                Line($"__next[{registerIndex}] = {Copy(next.Value)};");
                break;
            case BoundAssertion assertion:
                EmitAssertion(assertion);
                break;
            case BoundEffect { Kind: EffectKind.Log } effect:
            {
                var logged = effect.Arguments.Select(argument =>
                {
                    if (argument.Type.Shape.Kind == TypeKind.Bytes)
                        return $"(\"bytes(\" + {FileSize(Expr(argument))} + \")\")";
                    return sliced ? Copy(argument) : Expr(argument);
                });
                var values = string.Join(", ", logged);
                Line(sliced ? $"__logs.push([{values}]);" : $"log({values});");
                break;
            }
            case BoundEffect { Kind: EffectKind.Pixel } effect:
                Line($"__pixel({string.Join(", ", effect.Arguments.Select(Expr))});");
                break;
            case BoundEffect { Kind: EffectKind.PreserveScreen }:
                Line("__preserveScreen();");
                break;
            case BoundEffect { Kind: EffectKind.RevealScreen } effect:
                Line($"__revealScreen({string.Join(", ", effect.Arguments.Select(Expr))});");
                break;
            case BoundEffect { Kind: EffectKind.Discard } effect:
                Line($"{Expr(effect.Arguments[0])};");
                break;
            case BoundEffect effect:
                throw new InvalidOperationException($"Unexpected Fletcher effect '{effect.Kind}'.");
        }
    }

    private void EmitResultSource(BoundResultSource? source)
    {
        if (source is not null)
            Line($"const {Name(source.Temporary)} = {Expr(source.Call)};");
    }

    private void EmitCaseBody(BoundBlock body)
    {
        Line("{");
        indent++;
        EmitStatements(body);
        Line("break;");
        indent--;
        Line("}");
    }

    private sealed record AssignmentTarget(string Expression, Action<string> Assign);

    private AssignmentTarget Capture(BoundExpression target)
    {
        switch (target)
        {
            case BoundVariable variable:
                return At(Name(variable.Symbol));
            case BoundMember member:
                return At($"{Temporary(Expr(member.Receiver))}[{Quote(member.Name)}]");
            case BoundIndex index:
                if (index.Receiver.Type.Shape.Kind == TypeKind.Bits)
                {
                    var container = Capture(index.Receiver);
                    var bit = Temporary(IndexOffset(index.Index, index.Receiver.Type.Width));
                    return new AssignmentTarget($"(({container.Expression} >>> {bit}) & 1) !== 0",
                        value => container.Assign($"(({container.Expression} & ~(1 << {bit})) | (({value} ? 1 : 0) << {bit})) >>> 0"));
                }
                var array = Temporary(Expr(index.Receiver));
                var offset = Temporary(IndexOffset(index.Index, index.Receiver.Type.Shape.Size));
                return At($"{array}[{offset}]");
            default:
                throw new InvalidOperationException("Unexpected assignment target.");
        }

        AssignmentTarget At(string expression) => new(expression, value => Line($"{expression} = {value};"));
    }

    private string Expr(BoundExpression expression) => expression switch
    {
        BoundLiteral { Value: ImportedFile file } => FileReference(file),
        BoundSharedBytes shared => SharedFileReference(shared.Key),
        BoundLiteral { Value: ConstantArray array } => TableReference(array),
        BoundLiteral literal => Literal(literal.Value),
        BoundVariable variable => Name(variable.Symbol),
        BoundCurrentTick => sliced ? "(__logicalTick | 0)" : "(world.getTick() | 0)",
        BoundHostTimeMillis => "(Date.now() | 0)",
        BoundMousePosition mouse => MousePosition(mouse.Horizontal),
        BoundPixelIndexAt sample => $"__pixelIndexAt({Expr(sample.X)}, {Expr(sample.Y)})",
        BoundCaptureScreen capture => $"__captureScreen({Expr(capture.Previous)})",
        BoundSameFile same => $"({Expr(same.Left)} === {Expr(same.Right)})",
        BoundUnary unary => Unary(unary),
        BoundBinary binary => Binary(binary),
        BoundConversion { InterfaceTag: int tag } conversion =>
            $"Object.freeze({{ t: {tag}, v: {Copy(conversion.Operand)} }})",
        BoundConversion conversion => Normalize(conversion.Type, Expr(conversion.Operand)),
        BoundCall call => CallFunction(call),
        BoundDispatch call => Call("__dispatch", call.Arguments.Select(Expr).Prepend(Quote(call.Method)).Prepend(Expr(call.Receiver))),
        BoundMember member => $"({Expr(member.Receiver)})[{Quote(member.Name)}]",
        BoundIndex index when index.Receiver.Type.Shape.Kind == TypeKind.Bits =>
            $"((({Expr(index.Receiver)} >>> {IndexOffset(index.Index, index.Receiver.Type.Width)}) & 1) !== 0)",
        BoundIndex index when index.Receiver.Type.Shape.Kind == TypeKind.Bytes => FileByte(Expr(index.Receiver), Expr(index.Index)),
        BoundIndex index => $"({Expr(index.Receiver)})[{IndexOffset(index.Index, index.Receiver.Type.Shape.Size)}]",
        BoundByteLength length => FileSize(Expr(length.Receiver)),
        BoundStruct structure => StructLiteral(structure, snapshot: false),
        BoundArray array => $"[{string.Join(", ", array.Elements.Select(Expr))}]"
    };

    // The binder has checked literal offsets into fixed-size arrays and bits.
    private string IndexOffset(BoundExpression offset, int size) =>
        offset is BoundLiteral { Value: int } ? Expr(offset) : $"__index({Expr(offset)}, {size})";

    private string CallFunction(BoundCall call)
    {
        var callee = $"__f{call.Function.Id}";
        var arguments = WithReceiver(call.Receiver, call.Arguments).Select(Expr);
        if (!directSlicedFunctions.Contains(call.Function))
            return Call(callee, arguments);

        // The unused final argument puts the entry checkpoint after the real
        // arguments, even if a nested call consumes the last slot in the slice.
        return $"{callee}({string.Join(", ", arguments.Append("(__budget === 0 ? (yield) : 0)"))})";
    }

    private string Call(string callee, IEnumerable<string> arguments)
    {
        var invocation = $"{callee}({string.Join(", ", arguments)})";
        return sliced ? $"(yield* {invocation})" : invocation;
    }

    private string Unary(BoundUnary unary)
    {
        var result = $"({OperatorText.Symbol(unary.Operator)}({Expr(unary.Operand)}))";
        return unary.Operator == UnaryOperator.BitwiseNot && unary.Type.Shape.Kind == TypeKind.Int
            ? result : Normalize(unary.Type, result);
    }

    private string Binary(BoundBinary binary)
    {
        var left = Expr(binary.Left);
        var right = Expr(binary.Right);
        if (binary.Left.Type.Shape.Kind == TypeKind.Bit)
            return binary.Operator switch
            {
                BinaryOperator.BitwiseAnd => $"Boolean(({left}) & ({right}))",
                BinaryOperator.BitwiseOr => $"Boolean(({left}) | ({right}))",
                BinaryOperator.LogicalAnd => $"(({left}) && ({right}))",
                BinaryOperator.LogicalOr => $"(({left}) || ({right}))",
                BinaryOperator.BitwiseXor => $"(({left}) !== ({right}))",
                BinaryOperator.Equal => $"(({left}) === ({right}))",
                BinaryOperator.NotEqual => $"(({left}) !== ({right}))",
                _ => throw new InvalidOperationException($"Unexpected bit operator '{binary.Operator}'.")
            };

        var result = binary.Operator switch
        {
            BinaryOperator.Equal => $"(({left}) === ({right}))",
            BinaryOperator.NotEqual => $"(({left}) !== ({right}))",
            BinaryOperator.Multiply => $"Math.imul({left}, {right})",
            BinaryOperator.Divide => $"__div({left}, {right})",
            BinaryOperator.Remainder => $"__rem({left}, {right})",
            BinaryOperator.ShiftRight when binary.Left.Type.Shape.Kind == TypeKind.Bits => $"(({left}) >>> ({right}))",
            BinaryOperator.Add or BinaryOperator.Subtract or BinaryOperator.ShiftLeft or BinaryOperator.ShiftRight or
                BinaryOperator.BitwiseAnd or BinaryOperator.BitwiseOr or BinaryOperator.BitwiseXor or
                BinaryOperator.LessThan or BinaryOperator.LessThanOrEqual or BinaryOperator.GreaterThan or BinaryOperator.GreaterThanOrEqual
                => $"(({left}) {OperatorText.Symbol(binary.Operator)} ({right}))",
            _ => throw new InvalidOperationException($"Unexpected script operator '{binary.Operator}'.")
        };
        // JavaScript bitwise operators and imul already return signed
        // 32-bit results. Unsigned right shifts and narrow bitwise
        // operations already stay within their Fletcher operand width.
        return (binary.Type.Shape.Kind, binary.Operator) switch
        {
            (TypeKind.Int, BinaryOperator.Multiply or BinaryOperator.ShiftLeft or BinaryOperator.ShiftRight or
                BinaryOperator.BitwiseAnd or BinaryOperator.BitwiseOr or BinaryOperator.BitwiseXor) => result,
            (TypeKind.Bits, BinaryOperator.ShiftRight) => result,
            (TypeKind.Bits, BinaryOperator.BitwiseAnd or BinaryOperator.BitwiseOr or BinaryOperator.BitwiseXor)
                when binary.Type.Width < 32 => result,
            _ => Normalize(binary.Type, result)
        };
    }

    private static string Normalize(DataType type, string expression) => type.Shape.Kind switch
    {
        TypeKind.Int => $"(({expression}) | 0)",
        TypeKind.Bits when type.Width == 32 => $"(({expression}) >>> 0)",
        TypeKind.Bits => $"(({expression}) & {(1u << type.Width) - 1})",
        _ => expression
    };

    private static BoundExpression[] WithReceiver(BoundExpression? receiver, BoundExpression[] arguments) =>
        receiver is null ? arguments : [receiver, .. arguments];

    private static string Name(Variable variable) => variable.IsMapValue ? $"__p[{variable.Id}]" : $"v{variable.Id}";

    private static IEnumerable<Variable> CopiedParameters(Function function) =>
        (function.Receiver is { } receiver ? function.Parameters.Prepend(receiver) : function.Parameters)
        .Where(parameter => NeedsCopy(parameter.Type) && BoundTree.WritesThrough(function.Body, parameter));

    private void AnalyzeOwnedResults(IEnumerable<Function> functions)
    {
        foreach (var function in functions.Where(function => NeedsCopy(function.Result)))
        {
            var statements = BoundTree.Statements(function.Body).ToArray();
            // Declarations and range elements take snapshots. A parameter
            // has independent storage only if the callee copies it on entry.
            var owned = CopiedParameters(function).ToHashSet();
            foreach (var declaration in statements.OfType<BoundLocals>())
                for (var i = 0; i < declaration.Symbols.Length; i++)
                    if (declaration.IsNew[i] && declaration.Symbols[i] is { } local)
                        owned.Add(local);
            foreach (var loop in statements.OfType<BoundRange>())
                if (loop.Value is { } element)
                    owned.Add(element);

            var returns = statements.OfType<BoundReturn>().ToArray();
            if (returns.Length > 0 && Array.TrueForAll(returns, result => result.Value is { } value &&
                (OwnsLiteral(value) || BoundTree.StorageRoot(value) is { } root && owned.Contains(root))))
                ownedResults.Add(function);
        }
    }

    // A returned literal can embed the same array or struct more than once.
    // Only independently constructed components make the whole literal owned.
    private static bool OwnsLiteral(BoundExpression value) => !NeedsCopy(value.Type) || value switch
    {
        BoundStruct structure => structure.Fields.Values.All(OwnsLiteral),
        BoundArray array => Array.TrueForAll(array.Elements, OwnsLiteral),
        _ => false
    };

    // The literal creates its own container. Snapshot each field or element
    // independently: a variable or function result can still refer to mutable storage.
    private string Copy(BoundExpression expression) => expression switch
    {
        BoundStruct structure => StructLiteral(structure, snapshot: true),
        BoundArray array => $"[{string.Join(", ", array.Elements.Select(Copy))}]",
        BoundCall call when ownedResults.Contains(call.Function) => Expr(call),
        _ => Copy(expression.Type, Expr(expression))
    };

    private string StructLiteral(BoundStruct structure, bool snapshot)
    {
        var fields = structure.Fields.Select(field => $"[{Quote(field.Key)}]: {(snapshot ? Copy(field.Value) : Expr(field.Value))}");
        return $"({{ {(snapshot ? "__proto__: null, " : "")}{string.Join(", ", fields)} }})";
    }
    // Boxed interfaces already hold a snapshot and can be shared. Only arrays
    // and structs contain mutable storage that belongs to the new value.
    private static bool NeedsCopy(DataType type) => type.Shape.Kind is TypeKind.Array or TypeKind.Struct;
    private string Copy(DataType type, string expression) => NeedsCopy(type) ? $"{Copier(type.Shape)}({expression})" : expression;

    private string Copier(DataType shape)
    {
        if (copiers.TryGetValue(shape, out var existing))
            return existing;

        var name = $"__copy{copiers.Count}";
        copiers.Add(shape, name);
        string result;
        if (shape.Kind == TypeKind.Array)
        {
            var element = shape.Element!;
            result = NeedsCopy(element) ? $"v.map({Copier(element.Shape)})" : "v.slice()";
        }
        else
        {
            // Spread retains field order, including for a keyed literal. Both
            // the spread and the computed keys preserve fields such as __proto__.
            var fields = shape.Fields.Where(field => NeedsCopy(field.Value)).Select(field =>
            {
                var key = Quote(field.Key);
                return $", [{key}]: {Copy(field.Value, $"v[{key}]")}";
            });
            result = $"{{ __proto__: null, ...v{string.Concat(fields)} }}";
        }
        copierDeclarations.Add($"function {name}(v) {{ return {result}; }}");
        return name;
    }

    private static string Quote(string value) => JsonSerializer.Serialize(value);
    private static string Literal(object value) => value switch
    {
        bool bit => bit ? "true" : "false",
        int integer => integer.ToString(CultureInfo.InvariantCulture),
        uint number => number.ToString(CultureInfo.InvariantCulture),
        string str => Quote(str),
        InterfaceLiteral.Null => "null",
        _ => throw new InvalidOperationException("Unexpected Fletcher literal.")
    };

    private string Temporary(string expression)
    {
        var name = $"__t{nextTemporary++}";
        Line($"const {name} = {expression};");
        return name;
    }

    private void Line(string line)
    {
        if (indent > 0)
            text.Append(' ', indent * 2);
        text.Append(line).Append('\n');
    }
}
