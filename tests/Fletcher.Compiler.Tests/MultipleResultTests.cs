using System.Text;
using System.Text.Json;
using Fletcher.Compiler.Maps;
using Xunit;

namespace Fletcher.Compiler.Tests;

public sealed class MultipleResultTests
{
    [Fact]
    public void NativeDestructuringAndForwardingProduceTheEquivalentCircuit()
    {
        const string declarations = """
            func swap(a bit, b bit) (bit, bit) { return b, a }
            func forward(a bit, b bit) (bit, bit) { return swap(a, b) }
            func gate(a bit, b bit) bit {
                first, second := forward(a, b)
                first, second = swap(first, second)
                return !first & second
            }
            """;
        const string map = """
            map "Native results" {
                input a bit
                input b bit
                circuit { output chosen bit = gate(a, b) }
            }
            """;
        var actual = FletcherCompiler.Compile("main.flt", declarations + "\n" + map);
        var expected = FletcherCompiler.Compile("main.flt", "func gate(a bit, b bit) bit { return !a & b }\n" + map);
        Assert.Empty(actual.Diagnostics);
        Assert.Empty(expected.Diagnostics);
        Assert.DoesNotContain(actual.Tiles, tile => tile.Type == 33);
        Assert.Equal(MapCodec.Write(expected.Name!, expected.Tiles), MapCodec.Write(actual.Name!, actual.Tiles));
    }

    [Fact]
    public void ScriptAndIrEvaluateEachResultSourceOnce()
    {
        const string source = """
            type Reader interface { Read() (int, [2]int) }
            type Number struct { Value int }
            func pair<T>(x T) (T, [2]T) { return x, [2]T{x, x} }
            func (n Number) Read() (int, [2]int) { return pair(n.Value) }
            map "Script results" {
                tick {
                    var reader Reader = Number{Value: currentTick()}
                    first, second := reader.Read()
                    first, second = pair(second[1])
                    _, third := pair(first)
                    log(first, second, third)
                }
            }
            """;
        var result = FletcherCompiler.Compile("main.flt", source, emitIr: true);
        Assert.Empty(result.Diagnostics);
        using var ir = JsonDocument.Parse(result.IntermediateRepresentationJson!);
        var statements = ir.RootElement.GetProperty("tick").GetProperty("statements");
        var script = Encoding.UTF8.GetString(Assert.Single(result.Tiles, tile => tile.Type == 33).Payload!);
        for (var index = 1; index <= 3; index++)
        {
            var binding = statements[index];
            var resultSource = binding.GetProperty("resultSource");
            var temporary = resultSource.GetProperty("temporary").GetInt32();
            var call = resultSource.GetProperty("call");
            Assert.Equal(index == 1 ? "dispatch" : "call", call.GetProperty("op").GetString());
            Assert.Contains($"const v{temporary} = ", script, StringComparison.Ordinal);
            var fields = binding.GetProperty("values");
            Assert.Equal(2, fields.GetArrayLength());
            for (var field = 0; field < 2; field++)
            {
                Assert.Equal($"item{field}", fields[field].GetProperty("name").GetString());
                Assert.Equal(temporary, fields[field].GetProperty("receiver").GetProperty("symbol").GetInt32());
            }
        }
    }

    [Theory]
    [InlineData("func bad() (int, int) { return 1 }", "Expected 2 return values")]
    [InlineData("func bad() (int, int) { return 1, 2, 3 }", "Expected 2 return values")]
    [InlineData("func bad() (int, bit) { return 1, 2 }", "Cannot use 'int' as 'bit'")]
    [InlineData("func bad() (bit, int) { return pair() }", "Cannot forward '(int, int)' as '(bit, int)'")]
    [InlineData("func bad() int { return pair() }", "single-value context")]
    [InlineData("func bad() { x := pair() }", "2 values for 1 names")]
    [InlineData("func bad() { var x int; x, x, _ = pair() }", "2 values for 3 targets")]
    [InlineData("func bad() { x, y := pair(), 1 }", "single-value context")]
    [InlineData("func bad() { var b bit; _, b = pair() }", "Cannot use 'int' as 'bit'")]
    [InlineData("func bad() { var b bit; b, y := pair() }", "Cannot use 'int' as 'bit'")]
    public void InvalidUsesReportSourceDiagnostics(string invalid, string diagnostic)
    {
        var source = "func pair() (int, int) { return 1, 2 }\n" + invalid + "\nmap \"Errors\" { tick {} }";
        var result = FletcherCompiler.Compile("main.flt", source, emitIr: true);
        Assert.False(result.Success);
        Assert.Null(result.IntermediateRepresentationJson);
        Assert.Contains(result.Diagnostics, item => item.Path == "main.flt" && item.Message.Contains(diagnostic, StringComparison.Ordinal));
    }
}
