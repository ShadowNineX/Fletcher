using Fletcher.Compiler;
using Fletcher.Compiler.Maps;
using System.Text;
using System.Text.Json;
using Xunit;

namespace Fletcher.Compiler.Tests;

public sealed class FletcherCompilerTests
{
    [Fact]
    public void Compile_WithIr_SharesResolvedFunctionAcrossTargetsAndPreservesMap()
    {
        const string source = """
            func flip(value bit) bit { return !value }
            map "Shared program" {
                input a bit
                circuit { output inverted bit = flip(a) }
                tick { log(flip(a)) }
            }
            """;

        var normal = FletcherCompiler.Compile("main.flt", source);
        var withIr = FletcherCompiler.Compile("main.flt", source, emitIr: true);

        Assert.True(normal.Success, string.Join(Environment.NewLine, normal.Diagnostics));
        Assert.True(withIr.Success, string.Join(Environment.NewLine, withIr.Diagnostics));
        Assert.Null(normal.IntermediateRepresentationJson);
        Assert.Equal(MapCodec.Write(normal.Name!, normal.Tiles), MapCodec.Write(withIr.Name!, withIr.Tiles));
        using var json = JsonDocument.Parse(Assert.IsType<string>(withIr.IntermediateRepresentationJson));
        Assert.Equal(1, json.RootElement.GetProperty("version").GetInt32());
        Assert.Equal("Shared program", json.RootElement.GetProperty("name").GetString());
        var function = Assert.Single(json.RootElement.GetProperty("functions").EnumerateArray());
        Assert.Equal("flip", function.GetProperty("name").GetString());
        Assert.Contains("LogicalNot", function.GetRawText(), StringComparison.OrdinalIgnoreCase);
        var nativeCall = Assert.Single(json.RootElement.GetProperty("bindings").EnumerateArray()).GetProperty("value");
        var scriptLog = Assert.Single(json.RootElement.GetProperty("tick").GetProperty("statements").EnumerateArray());
        var scriptCall = Assert.Single(scriptLog.GetProperty("arguments").EnumerateArray());
        Assert.Equal("call", nativeCall.GetProperty("op").GetString());
        Assert.Equal("call", scriptCall.GetProperty("op").GetString());
        Assert.Equal(function.GetProperty("id").GetInt32(), nativeCall.GetProperty("function").GetInt32());
        Assert.Equal(function.GetProperty("id").GetInt32(), scriptCall.GetProperty("function").GetInt32());
    }

    [Fact]
    public void Compile_WithIr_KeepsBoundDumpForTargetFailureAndOmitsItForBindingFailure()
    {
        var targetFailure = FletcherCompiler.Compile("main.flt", """
            map "Circuit target failure" {
                circuit { output value bit = currentTick() == 0 }
            }
            """, emitIr: true);
        var bindingFailure = FletcherCompiler.Compile("main.flt", """
            map "Binding failure" { output value bit = undefinedName }
            """, emitIr: true);

        Assert.False(targetFailure.Success);
        Assert.Contains("currentTick() requires script", Assert.Single(targetFailure.Diagnostics).Message, StringComparison.Ordinal);
        using var json = JsonDocument.Parse(Assert.IsType<string>(targetFailure.IntermediateRepresentationJson));
        Assert.Contains("currentTick", json.RootElement.GetProperty("bindings").GetRawText(), StringComparison.Ordinal);
        Assert.False(bindingFailure.Success);
        Assert.Null(bindingFailure.IntermediateRepresentationJson);
    }

    [Fact]
    public void Compile_WithIr_NormalizesUnaryAliasesAndPreservesUnsignedConstants()
    {
        const string source = """
            func mask(value bits<32>) bits<32> { return ~value | 0x80000000 }
            map "Operator normalization" { tick { log(mask(bits<32>(currentTick()))) } }
            """;
        var tilde = FletcherCompiler.Compile("main.flt", source, emitIr: true);
        var caret = FletcherCompiler.Compile("main.flt", source.Replace('~', '^'), emitIr: true);

        Assert.True(tilde.Success, string.Join(Environment.NewLine, tilde.Diagnostics));
        Assert.True(caret.Success, string.Join(Environment.NewLine, caret.Diagnostics));
        var ir = Assert.IsType<string>(tilde.IntermediateRepresentationJson);
        Assert.Equal(ir, caret.IntermediateRepresentationJson);
        Assert.Contains("BitwiseNot", ir, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("2147483648", ir, StringComparison.Ordinal);
    }

    [Fact]
    public void Compile_ImportWithoutFileLoader_ReturnsActionableDiagnostic()
    {
        const string source = "package main\nimport \"wad\"\nmap \"test\" { tick {} }";

        var result = FletcherCompiler.Compile("main.flt", source);

        Assert.False(result.Success);
        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("main.flt", diagnostic.Path);
        Assert.Equal("Use CompileFileAsync to resolve local package imports.", diagnostic.Message);
    }

    [Fact]
    public void Compile_InvalidSyntax_ReturnsStableDiagnosticWithoutTiles()
    {
        var result = FletcherCompiler.Compile("broken.flt", "map \"test\" { tick { @ } }");

        Assert.False(result.Success);
        Assert.Empty(result.Tiles);
        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("broken.flt", diagnostic.Path);
        Assert.NotEmpty(diagnostic.Message);
    }

    [Fact]
    public void Compile_MoreThan1024IndependentGenericFunctionsSucceed()
    {
        var functions = Enumerable.Range(0, 1025).ToArray();
        var library = string.Join('\n', functions.Select(index => $"func value{index}<T>(value T) T {{ return value }}"));
        var calls = string.Join('\n', functions.Select(index => $"log(value{index}({index}))"));
        var result = FletcherCompiler.Compile("main.flt", $$"""
            {{library}}
            map "Large library" {
                tick { {{calls}} }
            }
            """);

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        Assert.Contains(result.Tiles, tile => tile.Type == 33);
    }

    [Fact]
    public void Compile_UnboundedGenericExpansionReportsDiagnostic()
    {
        const string source = """
            func expand<T>(value T) int { return expand([1]T{value}) }
            map "Generic expansion" {
                tick { log(expand(0)) }
            }
            """;

        var result = FletcherCompiler.Compile("main.flt", source);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Message == "Recursive specialization through 'expand' is unsupported.");
    }

    [Fact]
    public void Compile_RegistersAcceptNestedConstantLiterals()
    {
        const string source = """
            const Initial = [2]int{7, 11}
            type Position struct {
                Values [2]int
            }
            type Player struct {
                Location Position
                Name string
                Tint color
            }
            map "Register types" {
                register player Player = Player{Location: Position{Values: Initial}, Name: "player", Tint: color.Green}
                output ready bit = player.Location.Values[0] == 7
                tick { next player = player }
            }
            """;

        var result = FletcherCompiler.Compile("main.flt", source);

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        Assert.Contains(result.Tiles, tile => tile.Type == 33);
    }

    [Fact]
    public void Compile_RegisterInitializerRejectsRuntimeValuesInsideComposite()
    {
        const string source = """
            type Player struct {
                History [2]int
            }
            map "Register initializer" {
                register player Player = Player{History: [2]int{currentTick(), 2}}
            }
            """;

        var result = FletcherCompiler.Compile("main.flt", source);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Message == "A compile-time constant is required here.");
    }

    [Fact]
    public void Compile_RegisterTypeAcceptsNestedBytesAndInterfaceValues()
    {
        const string source = """
            type View interface { Read() int }
            type Sample struct { Value int }
            func (sample Sample) Read() int { return sample.Value }
            type Resource struct {
                File bytes
                View View
            }
            map "Register storage" {
                register resources [1]Resource = [1]Resource{Resource{View: Sample{Value: 7}}}
                output ready bit = len(resources[0].File) == 0 && resources[0].View.Read() == 7
            }
            """;

        var result = FletcherCompiler.Compile("main.flt", source);

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        Assert.Contains(result.Tiles, tile => tile.Type == 33);
    }

    [Fact]
    public void Compile_RegisterMembersRequireWholeValueUpdate()
    {
        const string source = """
            type Player struct {
                History [2]int
            }
            map "Register member update" {
                register player Player = Player{}
                tick { player.History[0] = 1 }
            }
            """;

        var result = FletcherCompiler.Compile("main.flt", source);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Message == "'player' is not a mutable local.");
    }

    [Fact]
    public void Compile_SolidScreenSliceRequiresBitOption()
    {
        const string source = """
            map "Invalid slice option" {
                screen at (0, 0) size (2, 1) with { style = "solid", slice = "yes" }
                tick {}
            }
            """;

        var result = FletcherCompiler.Compile("main.flt", source);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Message == "The screen slice option requires a bit.");
    }

    [Fact]
    public void Compile_IndexedSolidPixels_EmitTransientFramebufferIndices()
    {
        const string source = """
            map "Indexed framebuffer" {
                screen at (0, 0) size (2, 1) with { style = "solid" }
                tick {
                    pixel(0, 0, true, color.Red, 112)
                    pixel(1, 0, true, color.Blue, 999)
                    log(pixelIndexAt(0, 0), pixelIndexAt(1, 0), pixelIndexAt(-1, 0))
                }
            }
            """;

        var result = FletcherCompiler.Compile("main.flt", source);

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        var controller = Encoding.UTF8.GetString(Assert.Single(result.Tiles, tile => tile.Type == 33).Payload!);
        Assert.Contains("const __pixelIndices = new Uint16Array(2);", controller, StringComparison.Ordinal);
        Assert.Contains("__pixelIndices.fill(0);", controller, StringComparison.Ordinal);
        Assert.Contains("function __pixelIndexAt(x, y)", controller, StringComparison.Ordinal);
        Assert.Contains("__pixelIndices[cell] = on && index >= 0 && index <= 255 ? index + 1 : 0;", controller,
            StringComparison.Ordinal);
    }

    [Fact]
    public void Compile_PixelIndexReaderRequiresSolidScreen()
    {
        const string source = """
            map "Indexed framebuffer" {
                screen at (0, 0) size (1, 1)
                tick { log(pixelIndexAt(0, 0)) }
            }
            """;

        var result = FletcherCompiler.Compile("main.flt", source);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Message == "pixelIndexAt() requires a solid screen.");
    }

    [Fact]
    public void Compile_OrdinarySolidPixels_DoNotAllocateIndexedFramebuffer()
    {
        const string source = """
            map "Ordinary framebuffer" {
                screen at (0, 0) size (1, 1) with { style = "solid" }
                tick { pixel(0, 0, true, color.Green, 42) }
            }
            """;

        var result = FletcherCompiler.Compile("main.flt", source);

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        var controller = Encoding.UTF8.GetString(Assert.Single(result.Tiles, tile => tile.Type == 33).Payload!);
        Assert.DoesNotContain("Uint16Array", controller, StringComparison.Ordinal);
        Assert.DoesNotContain("__pixelIndexAt", controller, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CompileTestsAsync_SiblingSelectionAndFilter_ReturnExpectedTests()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        using var directory = new TemporaryDirectory();
        var entry = Path.Combine(directory.Path, "main.flt");
        var sibling = Path.Combine(directory.Path, "extra_test.flt");
        await File.WriteAllTextAsync(entry, "package main\ntest \"entry check\" {}\n", cancellationToken);
        await File.WriteAllTextAsync(sibling, "package main\ntest \"sibling check\" {}\n", cancellationToken);

        var entryOnly = await FletcherCompiler.CompileTestsAsync(entry, includeSiblingTests: false, filter: null, cancellationToken: cancellationToken);
        var filtered = await FletcherCompiler.CompileTestsAsync(entry, includeSiblingTests: true, filter: "sibling", cancellationToken: cancellationToken);

        Assert.Empty(entryOnly.Diagnostics);
        Assert.Equal(1, entryOnly.SelectedTests);
        Assert.NotNull(entryOnly.Script);
        Assert.Empty(filtered.Diagnostics);
        Assert.Equal(1, filtered.SelectedTests);
        Assert.NotNull(filtered.Script);
        Assert.Contains(sibling, filtered.SourceTexts.Keys);
    }

    [Fact]
    public async Task CompileFileAsync_SkipsSiblingTestFilesDuringProductionBuild()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        using var directory = new TemporaryDirectory();
        var entry = Path.Combine(directory.Path, "main.flt");
        var test = Path.Combine(directory.Path, "ignored_test.flt");
        await File.WriteAllTextAsync(entry, "package main\nmap \"main\" { tick {} }\n", cancellationToken);
        await File.WriteAllTextAsync(test, "package main\n@ invalid test-only text\n", cancellationToken);

        var result = await FletcherCompiler.CompileFileAsync(entry, cancellationToken);

        Assert.True(result.Success);
        Assert.Empty(result.Diagnostics);
        Assert.DoesNotContain(test, result.SourceTexts.Keys);
    }

    [Fact]
    public async Task CompileTestsAsync_InvalidSiblingTest_ReturnsDiagnosticsWhenIncluded()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        using var directory = new TemporaryDirectory();
        var entry = Path.Combine(directory.Path, "main.flt");
        await File.WriteAllTextAsync(entry, "package main\ntest \"valid\" {}\n", cancellationToken);
        await File.WriteAllTextAsync(Path.Combine(directory.Path, "bad_test.flt"), "package main\n@\n", cancellationToken);

        var result = await FletcherCompiler.CompileTestsAsync(entry, includeSiblingTests: true, filter: null, cancellationToken: cancellationToken);

        Assert.Null(result.Script);
        Assert.Equal(0, result.SelectedTests);
        Assert.NotEmpty(result.Diagnostics);
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public TemporaryDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fletcher-compiler-tests-" + Guid.NewGuid());
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
