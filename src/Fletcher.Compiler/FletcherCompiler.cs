using System.Collections.ObjectModel;
using Fletcher.Compiler.CodeGeneration;
using Fletcher.Compiler.IR;
using Fletcher.Compiler.Maps;
using Fletcher.Compiler.Routing;
using Fletcher.Compiler.Semantics;
using Fletcher.Compiler.Syntax;

namespace Fletcher.Compiler;

public sealed record CompilationResult(
    string? Name,
    IReadOnlyList<Tile> Tiles,
    IReadOnlyList<Diagnostic> Diagnostics,
    string Explanation)
{
    public bool Success => Name is not null && Diagnostics.Count == 0;
    public IReadOnlyDictionary<string, string> SourceTexts { get; init; } = ReadOnlyDictionary<string, string>.Empty;
    public IReadOnlyList<string> ImportedFiles { get; init; } = [];
    public string? IntermediateRepresentationJson { get; init; }
}

public static partial class FletcherCompiler
{
    public static CompilationResult Compile(string path, string source) => Compile(path, source, emitIr: false);

    public static CompilationResult Compile(string path, string source, bool emitIr)
    {
        var parse = FletcherSyntaxParser.Parse(path, source);
        if (parse.Root is not { } root || !parse.Success)
            return new(null, [], parse.Diagnostics, "");
        if (root.Imports.Length > 0)
            return new(null, [], [new Diagnostic(path, root.Imports[0].Span, "Use CompileFileAsync to resolve local package imports.")], "");

        return CompileUnits(path, [new SourceUnit(path, path, root)], emitIr: emitIr);
    }

    public static Task<CompilationResult> CompileFileAsync(string path, CancellationToken cancellationToken = default,
        string? packageRoot = null) => CompileFileAsync(path, cancellationToken, packageRoot, assetRoot: null);

    public static Task<CompilationResult> CompileFileAsync(string path, CancellationToken cancellationToken,
        string? packageRoot, string? assetRoot) => CompileFileAsync(path, cancellationToken, packageRoot, assetRoot, emitIr: false);

    public static async Task<CompilationResult> CompileFileAsync(string path, CancellationToken cancellationToken,
        string? packageRoot, string? assetRoot, bool emitIr)
    {
        var fullPath = Path.GetFullPath(path);
        var root = packageRoot is null ? Path.GetDirectoryName(fullPath)! : Path.GetFullPath(packageRoot);
        var loader = new PackageLoader(fullPath, root, cancellationToken);
        var imports = new FileImports(assetRoot is null ? null : Path.GetFullPath(assetRoot), cancellationToken);
        await loader.LoadAsync();
        var result = loader.Diagnostics.Count > 0
            ? new CompilationResult(null, [], loader.Diagnostics, "")
            : CompileUnits(fullPath, loader.Units, imports, emitIr);
        return result with { SourceTexts = loader.Texts, ImportedFiles = [.. imports.Paths] };
    }

    private static CompilationResult CompileUnits(string path, IReadOnlyList<SourceUnit> units, FileImports? imports = null,
        bool emitIr = false)
    {
        (string Path, MapDeclarationSyntax Map)[] maps =
            [.. units.Where(unit => unit.Syntax.Map is not null).Select(unit => (unit.Path, unit.Syntax.Map!))];
        if (maps is not [var entry])
        {
            Diagnostic[] diagnostics = maps.Length == 0
                ? [new Diagnostic(path, default, "The entry package must define a map.")]
                : [.. maps.Skip(1).Select(item => new Diagnostic(item.Path, item.Map.Span, "The entry package can define only one map."))];
            return new(null, [], diagnostics, "");
        }

        var binder = new Binder(entry.Path, units, imports);
        var program = binder.Bind(entry.Map);
        if (binder.Diagnostics.Count > 0)
            return new(null, [], binder.Diagnostics, "");

        var ir = emitIr ? IrJson.Serialize(program) : null;
        try
        {
            var (tiles, report) = new MapCompiler(program).Compile();
            return new(program.Name, tiles, [], report) { IntermediateRepresentationJson = ir };
        }
        catch (Exception error) when (error is NativeException or RoutingException or MapLayoutException)
        {
            return new(null, [], [new Diagnostic(entry.Path, entry.Map.Span, error.Message)], "")
                { IntermediateRepresentationJson = ir };
        }
    }
}
