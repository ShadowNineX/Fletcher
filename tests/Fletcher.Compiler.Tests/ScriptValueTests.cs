using Fletcher.Compiler;
using System.Text.RegularExpressions;
using Xunit;

namespace Fletcher.Compiler.Tests;

public sealed class ScriptValueTests
{
    [Fact]
    public async Task EmitTests_ConcreteMutationAfterBoxing_SnapshotsInterfacePayload()
    {
        var script = await EmitAsync("""
            type Reader interface { Read() int }
            type Pair struct { Values [2]int }
            func (pair Pair) Read() int { return pair.Values[0] }
            test "interface snapshot" {
                var value Pair = Pair{Values: [2]int{1, 2}}
                var reader Reader = value
                value.Values[0] = 9
                assert(reader.Read() == 1)
            }
            """);

        Assert.Matches(@"Object\.freeze\(\{ t: \d+, v: __copy\d+\(v\d+\) \}", script);
        Assert.Contains("return v.slice();", script, StringComparison.Ordinal);
    }

    [Fact]
    public async Task EmitTests_CompositeParameterCopies_OnlyWhenBodyWritesThroughItsRoot()
    {
        var script = await EmitAsync("""
            type Pair struct { Values [2]int }
            func Read(pair Pair) int { return pair.Values[0] }
            func Write(pair Pair) int { pair.Values[0] = 7; return pair.Values[0] }
            func NestedWrite(pair Pair) int {
                if true { pair.Values[1] = 8 }
                return pair.Values[1]
            }
            test "parameter copies" {
                var pair Pair = Pair{Values: [2]int{1, 2}}
                assert(Read(pair) == 1)
                assert(Write(pair) == 7)
                assert(NestedWrite(pair) == 8)
                assert(pair.Values[0] == 1)
                assert(pair.Values[1] == 2)
            }
            """);

        Assert.Equal(2, Regex.Matches(script, @"v\d+ = __copy\d+\(v\d+\);").Count);
    }

    [Fact]
    public async Task EmitTests_BoxedReceiverMutation_CopiesPayloadBeforeMethodWrite()
    {
        var script = await EmitAsync("""
            type Writer interface { Write() int }
            type Pair struct { Values [2]int }
            func (pair Pair) Write() int { pair.Values[0] = 7; return pair.Values[0] }
            test "boxed receiver write" {
                var value Pair = Pair{Values: [2]int{1, 2}}
                var writer Writer = value
                assert(writer.Write() == 7)
                assert(value.Values[0] == 1)
                assert(writer.Write() == 7)
            }
            """);

        Assert.Contains("return __methods[receiver.t][method](receiver.v, ...args);", script, StringComparison.Ordinal);
        Assert.Contains("Object.freeze({ t:", script, StringComparison.Ordinal);
        Assert.Single(Regex.Matches(script, @"v\d+ = __copy\d+\(v\d+\);"));
    }

    private static async Task<string> EmitAsync(string source)
    {
        using var directory = new TemporaryDirectory();
        var path = Path.Combine(directory.Path, "main.flt");
        await File.WriteAllTextAsync(path, source, TestContext.Current.CancellationToken);
        var result = await FletcherCompiler.CompileTestsAsync(path, includeSiblingTests: false, filter: null,
            cancellationToken: TestContext.Current.CancellationToken);
        Assert.Empty(result.Diagnostics);
        return Assert.IsType<string>(result.Script);
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public TemporaryDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fletcher-script-values-" + Guid.NewGuid());
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose()
        {
            if (Directory.Exists(Path))
                Directory.Delete(Path, recursive: true);
        }
    }
}
