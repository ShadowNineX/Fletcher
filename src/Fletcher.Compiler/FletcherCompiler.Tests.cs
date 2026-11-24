using Fletcher.Compiler.CodeGeneration;
using Fletcher.Compiler.Semantics;
using Fletcher.Compiler.Syntax;

namespace Fletcher.Compiler;

public sealed record TestCompilationResult(
    string? Script,
    IReadOnlyList<Diagnostic> Diagnostics,
    IReadOnlyDictionary<string, string> SourceTexts,
    int SelectedTests);

public static partial class FletcherCompiler
{
    public static async Task<TestCompilationResult> CompileTestsAsync(string path, bool includeSiblingTests,
        string? filter, CancellationToken cancellationToken = default, string? packageRoot = null, string? assetRoot = null)
    {
        var fullPath = Path.GetFullPath(path);
        var directory = Path.GetDirectoryName(fullPath)!;
        var root = packageRoot is null ? directory : Path.GetFullPath(packageRoot);
        var loader = new PackageLoader(fullPath, root, cancellationToken, includeTests: true);
        await loader.LoadAsync();
        if (loader.Diagnostics.Count != 0)
            return new(null, loader.Diagnostics, loader.Texts, 0);

        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        TestDeclarationSyntax[] tests =
        [
            .. loader.Units.Where(unit => string.Equals(unit.Path, fullPath, comparison) ||
                (includeSiblingTests && string.Equals(unit.Package, directory, comparison) && PackageLoader.IsTestFile(unit.Path)))
                .OrderBy(unit => unit.Path, StringComparer.Ordinal)
                .SelectMany(unit => unit.Syntax.Declarations.OfType<TestDeclarationSyntax>())
                .Where(test => string.IsNullOrEmpty(filter) || test.Name.Contains(filter, StringComparison.OrdinalIgnoreCase))
        ];
        if (tests.Length == 0)
            return new(null, [], loader.Texts, 0);

        cancellationToken.ThrowIfCancellationRequested();
        var imports = new FileImports(assetRoot is null ? null : Path.GetFullPath(assetRoot), cancellationToken);
        var binder = new Binder(fullPath, loader.Units, imports);
        var program = binder.Bind(new MapDeclarationSyntax("Tests", [], default), tests);
        if (binder.Diagnostics.Count != 0)
            return new(null, binder.Diagnostics, loader.Texts, tests.Length);

        return new(new ScriptEmitter(program).EmitTests(Location), [], loader.Texts, tests.Length);

        string Location(TextSpan span)
        {
            var sourcePath = span.SourcePath ?? fullPath;
            var source = loader.Texts.GetValueOrDefault(sourcePath, "");
            var line = 1;
            var lineStart = 0;
            for (var i = 0; i < Math.Clamp(span.Start, 0, source.Length); i++)
            {
                if (source[i] == '\n')
                {
                    line++;
                    lineStart = i + 1;
                }
            }
            return $"{sourcePath}:{line}:{span.Start - lineStart + 1}";
        }
    }
}
