using System.Buffers.Text;
using Fletcher.Compiler.IR;

namespace Fletcher.Compiler.CodeGeneration;

internal sealed partial class ScriptEmitter
{
    // Require savings large enough to pay for the decoder even if only one
    // table uses it. The map envelope still compresses the entire script.
    private const int TableDecoderAllowance = 1024;
    private const string TableKeyPrefix = "__fletcherTable";
    private readonly Dictionary<ConstantArray, int> tables = [];
    private readonly List<string> tableScripts = [];
    private bool hasPackedTables;

    private void EmitSupportCode()
    {
        foreach (var declaration in copierDeclarations)
            Line(declaration);
        // Rendering a table literal can register imported files held by it.
        var declarations = tables.OrderBy(entry => entry.Value)
            .Select(entry => (Name: $"__table{entry.Value}", Value: TableLiteral(entry.Key))).ToArray();
        if (needsFileHelpers || hasPackedTables)
            EmitBase64Reader();
        if (hasPackedTables)
            EmitTableDecoder();
        if (tableScripts.Count > 0)
            EmitDeferredTables(declarations);
        else
        {
            foreach (var (name, value) in declarations)
                Line($"const {name} = {value};");
            if (splitTables)
                Line("function __prepareTables() { return true; }");
        }
        EmitFileHelpers();
    }

    private string TableReference(ConstantArray array)
    {
        if (!tables.TryGetValue(array, out var id))
        {
            id = tables.Count;
            tables.Add(array, id);
        }
        return $"__table{id}";
    }

    private string TableLiteral(ConstantArray array)
    {
        var values = array.Items.Select(item => item.Value is ConstantArray nested ? TableLiteral(nested) : Expr(item));
        var literal = $"Object.freeze([{string.Join(", ", values)}])";
        if (literal.Length <= TableDecoderAllowance || array.Items.IsEmpty)
            return literal;

        var unsigned = array.Items[0].Value is uint;
        if (!array.Items.All(item => unsigned ? item.Value is uint : item.Value is int))
            return literal;

        List<byte> data = [with(array.Items.Length)];
        var previous = 0;
        foreach (var rawValue in array.Items.Select(item => item.Value))
        {
            var value = unsigned ? unchecked((int)(uint)rawValue) : (int)rawValue;
            var delta = unchecked(value - previous);
            var encoded = unchecked((uint)((delta << 1) ^ (delta >> 31)));
            while (encoded >= 128)
            {
                data.Add((byte)((encoded & 127) | 128));
                encoded >>= 7;
            }
            data.Add((byte)encoded);
            previous = value;
        }
        var encodedData = Base64.EncodeToString([.. data]);
        var packed = DecodeTable($"\"{encodedData}\"");
        if (packed.Length + TableDecoderAllowance >= literal.Length)
            return literal;
        hasPackedTables = true;
        if (!splitTables)
            return packed;

        var id = tableScripts.Count;
        var script = $"onStart(() => {{ globalState[\"{TableKeyPrefix}{id}\"] = \"{encodedData}\"; }});";
        // A larger table can stay in the controller source and be split with it.
        if (script.Length > ushort.MaxValue)
            return packed;
        tableScripts.Add(script);
        return DecodeTable($"__tableData{id}");

        string DecodeTable(string source) => $"__unpackTable({array.Items.Length}, {source}, {(unsigned ? "true" : "false")})";
    }

    private void EmitDeferredTables((string Name, string Value)[] declarations)
    {
        foreach (var (name, _) in declarations)
            Line($"let {name};");
        Line("let __tablesReady = false;");
        Line("function __prepareTables() {");
        indent++;
        Line("if (__tablesReady) return true;");
        for (var id = 0; id < tableScripts.Count; id++)
        {
            Line($"const __tableData{id} = globalState[\"{TableKeyPrefix}{id}\"];");
            Line($"if (typeof __tableData{id} !== \"string\") return false;");
        }
        foreach (var (name, value) in declarations)
            Line($"{name} = {value};");
        Line("__tablesReady = true;");
        Line("return true;");
        indent--;
        Line("}");
    }

    public IEnumerable<string> EmitDataTiles() => EmitFileTiles().Concat(tableScripts);

    private void EmitTableDecoder() => Line("""
        function __unpackTable(length, encoded, unsigned) {
            const result = new Array(length);
            let offset = 0, previous = 0;
            for (let i = 0; i < length; i++) {
                let value = 0, shift = 0, byte;
                do {
                    byte = __base64Byte(encoded, offset++);
                    value |= (byte & 127) << shift;
                    shift += 7;
                } while (byte & 128);
                const delta = (value >>> 1) ^ -(value & 1);
                previous = (previous + delta) | 0;
                result[i] = unsigned ? previous >>> 0 : previous;
            }
            return Object.freeze(result);
        }
        """);
}
