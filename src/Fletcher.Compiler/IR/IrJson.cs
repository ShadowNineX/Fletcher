using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Fletcher.Compiler.Maps;

namespace Fletcher.Compiler.IR;

internal static class IrJson
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter() }
    };

    public static string Serialize(IrProgram program) =>
        JsonSerializer.Serialize(new Projection().DescribeProgram(program), Options) + "\n";

    private sealed class Projection
    {
        private readonly List<DataType> types = [];
        private readonly Dictionary<DataType, int> typeIds = [];
        private readonly Dictionary<int, Variable> symbols = [];
        private readonly Dictionary<ImportedFile, int> fileIds = [];
        private readonly List<object> files = [];
        private readonly Dictionary<ConstantArray, int> tableIds = [with(ReferenceEqualityComparer.Instance)];
        private readonly List<ConstantArray> tables = [];

        public object DescribeProgram(IrProgram program)
        {
            var functions = program.Functions.OrderBy(function => function.Id).Select(DescribeFunction).ToArray();
            var ports = program.Ports.Select(port => new
            {
                symbol = SymbolId(port.Symbol), port.Anchor, port.Key, port.Buffer, port.Forward, port.LampStyle
            }).ToArray();
            var bindings = program.Bindings.Select(binding => new
            {
                symbol = SymbolId(binding.Symbol), binding.Backend, binding.Published, binding.HostPublished, value = Expression(binding.Value)
            }).ToArray();
            var registers = program.Registers.Select(register => new
            {
                symbol = SymbolId(register.Symbol), initial = Expression(register.Initial)
            }).ToArray();
            var tick = Statement(program.Tick);
            var hostTick = Statement(program.HostTick);
            var methods = program.TypeTags.OrderBy(pair => pair.Value).Select(pair => new
            {
                tag = pair.Value,
                type = TypeId(pair.Key),
                methods = program.Methods.TryGetValue(pair.Key, out var implementations)
                    ? implementations.OrderBy(method => method.Key, StringComparer.Ordinal).Select(method => new
                    {
                        name = method.Key, function = method.Value.Id
                    }).ToArray()
                    : []
            }).ToArray();
            var tests = program.Tests.Select(test => new { test.Name, body = Statement(test.Body) }).ToArray();
            var constantTables = DescribeTables();
            var typeTable = DescribeTypes();

            return new
            {
                format = "fletcher.ir",
                version = 1,
                program.Name,
                types = typeTable,
                symbols = symbols.Values.OrderBy(symbol => symbol.Id).Select(symbol => new
                {
                    symbol.Id, symbol.Name, symbol.Kind, type = typeIds[symbol.Type]
                }).ToArray(),
                files,
                constantTables,
                functions,
                ports,
                bindings,
                registers,
                manualTiles = program.ManualTiles.Select(DescribeTile).ToArray(),
                screen = program.Screen is { } screen ? new
                {
                    background = DescribeTile(screen.Background), screen.Width, screen.Height,
                    screen.Foreground, screen.Hold, screen.Slice
                } : null,
                tick,
                hostTick,
                methods,
                tests
            };
        }

        private object DescribeFunction(Function function) => new
        {
            function.Id, function.Name,
            function.RequiresCircuit,
            parameters = function.Parameters.Select(SymbolId).ToArray(),
            receiver = SymbolIdOrNull(function.Receiver),
            result = TypeId(function.Result),
            body = Statement(function.Body)
        };

        private static object DescribeTile(Tile tile) => new
        {
            tile.Position, tile.Type, tile.Rotation, tile.Flip, tile.Extra,
            payload = tile.Payload is { } bytes ? Fingerprint(bytes) : null
        };

        private object[] DescribeTypes()
        {
            List<object> result = [];
            // Describing a type can discover additional referenced types. Recording
            // IDs first lets recursive types share the same table entry.
            for (var id = 0; id < types.Count; id++)
            {
                var type = types[id];
                result.Add(new
                {
                    id, type.Kind, type.Name, type.Size,
                    element = type.Element is { } element ? TypeId(element) : (int?)null,
                    arguments = type.Arguments.Select(TypeId).ToArray(),
                    fields = type.Fields.Select(field => new { name = field.Key, type = TypeId(field.Value) }).ToArray(),
                    methods = type.Methods.OrderBy(method => method.Key, StringComparer.Ordinal).Select(method => new
                    {
                        name = method.Key,
                        parameters = method.Value.Parameters.Select(TypeId).ToArray(),
                        result = TypeId(method.Value.Result)
                    }).ToArray()
                });
            }
            return [.. result];
        }

        private object[] DescribeTables()
        {
            List<object> result = [];
            for (var id = 0; id < tables.Count; id++)
                result.Add(new { id, items = tables[id].Items.Select(Expression).ToArray() });
            return [.. result];
        }

        private object? ResultSource(BoundResultSource? source) => source is null ? null :
            new { temporary = SymbolId(source.Temporary), call = Expression(source.Call) };

        private object? Statement(BoundStatement? statement) => statement switch
        {
            null => null,
            BoundBlock block => new { op = "block", statements = block.Statements.Select(Statement).ToArray() },
            BoundLocals locals => new
            {
                op = "locals", symbols = locals.Symbols.Select(SymbolIdOrNull).ToArray(), locals.IsNew,
                resultSource = ResultSource(locals.ResultSource), values = locals.Values.Select(Expression).ToArray()
            },
            BoundAssignment assignment => new
            {
                op = "assignment", targets = assignment.Targets.Select(ExpressionOrNull).ToArray(),
                resultSource = ResultSource(assignment.ResultSource), values = assignment.Values.Select(Expression).ToArray()
            },
            BoundIf conditional => new
            {
                op = "if", condition = Expression(conditional.Condition),
                then = Statement(conditional.Then), otherwise = Statement(conditional.Else)
            },
            BoundSwitch selection => new
            {
                op = "switch", selector = Expression(selection.Selector),
                cases = selection.Cases.Select(clause => new
                {
                    values = clause.Values.Select(Expression).ToArray(), body = Statement(clause.Body)
                }).ToArray(),
                fallback = Statement(selection.Default)
            },
            BoundRange range => new
            {
                op = "range", index = SymbolIdOrNull(range.Index), value = SymbolIdOrNull(range.Value),
                collection = Expression(range.Collection), body = Statement(range.Body)
            },
            BoundReturn returned => new { op = "return", value = ExpressionOrNull(returned.Value) },
            BoundNext next => new { op = "next", register = SymbolId(next.Register), value = Expression(next.Value) },
            BoundEffect effect => new { op = "effect", effect.Kind, arguments = effect.Arguments.Select(Expression).ToArray() },
            BoundAssertion assertion => new
            {
                op = "assert", assertion.Equality, arguments = assertion.Arguments.Select(Expression).ToArray(),
                span = new { assertion.Span.Start, assertion.Span.Length }
            }
        };

        private object? ExpressionOrNull(BoundExpression? expression) => expression is null ? null : Expression(expression);

        private object Expression(BoundExpression expression)
        {
            var type = TypeId(expression.Type);
            return expression switch
            {
                BoundLiteral literal => new { op = "literal", type, literal.IsUntyped, value = Literal(literal.Value) },
                BoundVariable variable => new { op = "variable", type, symbol = SymbolId(variable.Symbol) },
                BoundUnary unary => new { op = "unary", type, unary.Operator, operand = Expression(unary.Operand) },
                BoundBinary binary => new
                {
                    op = "binary", type, binary.Operator, left = Expression(binary.Left), right = Expression(binary.Right)
                },
                BoundConversion conversion => new
                {
                    op = "conversion", type, conversion.InterfaceTag, operand = Expression(conversion.Operand)
                },
                BoundCall call => new
                {
                    op = "call", type, function = call.Function.Id, receiver = ExpressionOrNull(call.Receiver),
                    arguments = call.Arguments.Select(Expression).ToArray()
                },
                BoundDispatch dispatch => new
                {
                    op = "dispatch", type, dispatch.Method, receiver = Expression(dispatch.Receiver),
                    arguments = dispatch.Arguments.Select(Expression).ToArray()
                },
                BoundMember member => new { op = "member", type, member.Name, receiver = Expression(member.Receiver) },
                BoundIndex index => new
                {
                    op = "index", type, receiver = Expression(index.Receiver), index = Expression(index.Index)
                },
                BoundByteLength length => new { op = "byteLength", type, receiver = Expression(length.Receiver) },
                BoundSharedBytes shared => new { op = "sharedBytes", type, shared.Key },
                BoundStruct structure => new
                {
                    op = "struct", type,
                    fields = structure.Fields.Select(field => new { name = field.Key, value = Expression(field.Value) }).ToArray()
                },
                BoundArray array => new { op = "array", type, elements = array.Elements.Select(Expression).ToArray() },
                BoundCurrentTick => new { op = "currentTick", type },
                BoundHostTimeMillis => new { op = "hostTimeMillis", type },
                BoundMousePosition mouse => new { op = "mousePosition", type, mouse.Horizontal },
                BoundPixelIndexAt pixel => new { op = "pixelIndexAt", type, x = Expression(pixel.X), y = Expression(pixel.Y) },
                BoundCaptureScreen capture => new { op = "captureScreen", type, previous = Expression(capture.Previous) },
                BoundSameFile same => new { op = "sameFile", type, left = Expression(same.Left), right = Expression(same.Right) }
            };
        }

        private object? Literal(object value) => value switch
        {
            bool or int or uint or string => value,
            InterfaceLiteral.Null => null,
            ImportedFile file => new { file = FileId(file) },
            ConstantArray table => new { table = TableId(table) },
            _ => throw new InvalidOperationException($"Unexpected IR literal '{value.GetType().Name}'.")
        };

        private int? SymbolIdOrNull(Variable? symbol) => symbol is null ? null : SymbolId(symbol);

        private int SymbolId(Variable symbol)
        {
            if (symbols.TryAdd(symbol.Id, symbol))
                TypeId(symbol.Type);
            return symbol.Id;
        }

        private int TypeId(DataType type)
        {
            if (typeIds.TryGetValue(type, out var id))
                return id;
            id = types.Count;
            typeIds.Add(type, id);
            types.Add(type);
            return id;
        }

        private int TableId(ConstantArray table)
        {
            if (tableIds.TryGetValue(table, out var id))
                return id;
            id = tables.Count;
            tableIds.Add(table, id);
            tables.Add(table);
            return id;
        }

        private int FileId(ImportedFile file)
        {
            if (fileIds.TryGetValue(file, out var id))
                return id;
            id = files.Count;
            fileIds.Add(file, id);
            files.Add(new { id, data = Fingerprint(file.Data.Span) });
            return id;
        }

        private static object Fingerprint(ReadOnlySpan<byte> bytes) => new
        {
            byteLength = bytes.Length,
            sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes))
        };
    }
}
