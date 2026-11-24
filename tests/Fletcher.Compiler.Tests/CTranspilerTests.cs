using Fletcher.Compiler.Translation;
using Xunit;

namespace Fletcher.Compiler.Tests;

public sealed class CTranspilerTests
{
    [Fact]
    public void Translate_SimpleFunction_EmitsPortableFletcherFunction()
    {
        const string source = "int add(int left, int right) { return left + right; }";

        var (translated, error) = CTranspiler.Translate("sample.c", source);

        Assert.Null(error);
        Assert.NotNull(translated);
        Assert.Contains("package cport", translated, StringComparison.Ordinal);
        Assert.Contains("func C_add(c_var_left int, c_var_right int) int", translated, StringComparison.Ordinal);
        Assert.Contains("return (c_var_left + c_var_right)", translated, StringComparison.Ordinal);
    }

    [Fact]
    public void Translate_NoFunctionDefinitions_ReturnsPathAndDiagnostic()
    {
        var (translated, error) = CTranspiler.Translate("broken.c", "");

        Assert.Null(translated);
        Assert.NotNull(error);
        Assert.Equal("broken.c", error.Path);
        Assert.Equal("Expected at least one C function definition.", error.Message);
        Assert.Equal(0, error.Span.Start);
    }

    [Fact]
    public void Translate_DuplicateFunctionDefinition_ReturnsDiagnostic()
    {
        const string source = "int f() { return 1; } int f() { return 2; }";

        var (translated, error) = CTranspiler.Translate("duplicate.c", source);

        Assert.Null(translated);
        Assert.NotNull(error);
        Assert.Equal("duplicate.c", error.Path);
        Assert.Contains("Duplicate definition of 'f'.", error.Message, StringComparison.Ordinal);
        Assert.True(error.Span.Start > 20);
    }

    [Fact]
    public void Translate_InvalidSyntax_ReturnsStableDiagnostic()
    {
        var (translated, error) = CTranspiler.Translate("invalid.c", "int f( { return 1; }");

        Assert.Null(translated);
        Assert.NotNull(error);
        Assert.Equal("invalid.c", error.Path);
        Assert.Contains("Unsupported C syntax", error.Message, StringComparison.Ordinal);
    }
}
