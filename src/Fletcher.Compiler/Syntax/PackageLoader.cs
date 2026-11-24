namespace Fletcher.Compiler.Syntax;

internal sealed record SourceUnit(string Path, string Package, CompilationUnitSyntax Syntax)
{
    public Dictionary<string, string> Imports { get; } = [with(StringComparer.Ordinal)];
}

internal sealed class PackageLoader(string entryPath, string root, CancellationToken cancellationToken, bool includeTests = false)
{
    private static readonly StringComparer PathComparer = OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
    private readonly Dictionary<string, string> packages = [with(PathComparer)];
    private readonly HashSet<string> loading = [with(PathComparer)];

    public List<Diagnostic> Diagnostics { get; } = [];
    public List<SourceUnit> Units { get; } = [];
    public Dictionary<string, string> Texts { get; } = [with(PathComparer)];

    public static bool IsTestFile(string path) => path.EndsWith("_test.flt", StringComparison.OrdinalIgnoreCase);

    public async Task LoadAsync()
    {
        var directory = Path.GetDirectoryName(entryPath)!;
        var entry = await ReadAsync(entryPath, directory);
        if (entry is null)
            return;
        loading.Add(directory);
        if (entry.Syntax.PackageName is null)
        {
            Units.Add(entry);
            await LoadImportsAsync(entry);
        }
        else
        {
            await LoadDirectoryAsync(directory, entry);
        }
        loading.Remove(directory);
    }

    private async Task<string?> LoadDirectoryAsync(string directory, SourceUnit? entry = null)
    {
        List<SourceUnit> files = entry is null ? [] : [entry];
        var paths = Directory.EnumerateFiles(directory).Where(path => Path.GetExtension(path).Equals(".flt", StringComparison.OrdinalIgnoreCase));
        foreach (var path in paths.Order(StringComparer.Ordinal))
        {
            if (entry is not null && PathComparer.Equals(path, entry.Path))
                continue;
            if (IsTestFile(path) && (!includeTests || entry is null))
                continue;
            if (await ReadAsync(path, directory) is { } unit)
                files.Add(unit);
        }
        if (files.Count == 0)
            return null;

        var packageName = files[0].Syntax.PackageName;
        foreach (var file in files)
        {
            if (file.Syntax.PackageName is null)
                Error(file.Path, file.Syntax.Span, "Every file in a package directory needs a package declaration.");
            else if (file.Syntax.PackageName != packageName)
                Error(file.Path, file.Syntax.Span, $"Expected package '{packageName}', found '{file.Syntax.PackageName}'.");
            if (entry is null && file.Syntax.Map is { } map)
                Error(file.Path, map.Span, "Imported packages cannot define a map.");
        }
        if (packageName is null)
            return null;

        Units.AddRange(files);
        foreach (var file in files)
            await LoadImportsAsync(file);

        packages.Add(directory, packageName);
        return packageName;
    }

    private async Task LoadImportsAsync(SourceUnit source)
    {
        foreach (var directive in source.Syntax.Imports)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (ResolveImport(source, directive.ImportPath) is not { } directory)
            {
                Error(source.Path, directive.Span, $"Invalid local package path '{directive.ImportPath}'.");
                continue;
            }
            if (loading.Contains(directory))
            {
                Error(source.Path, directive.Span, $"Import cycle through '{directive.ImportPath}'.");
                continue;
            }
            if (!packages.TryGetValue(directory, out var name))
            {
                if (!Directory.Exists(directory))
                {
                    Error(source.Path, directive.Span, $"Package '{directive.ImportPath}' was not found.");
                    continue;
                }
                loading.Add(directory);
                try
                {
                    name = await LoadDirectoryAsync(directory);
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                {
                    Error(source.Path, directive.Span, $"Cannot read package '{directive.ImportPath}': {error.Message}");
                    continue;
                }
                finally
                {
                    loading.Remove(directory);
                }
                if (name is null)
                {
                    Error(source.Path, directive.Span, $"Package '{directive.ImportPath}' has no readable .flt package files.");
                    continue;
                }
            }
            var alias = directive.Alias ?? name;
            if (alias == "_" || !source.Imports.TryAdd(alias, directory))
                Error(source.Path, directive.Span, $"Invalid or duplicate import name '{alias}'.");
        }
    }

    private string? ResolveImport(SourceUnit source, string import)
    {
        var relative = import.StartsWith("./", StringComparison.Ordinal);
        var path = import.AsSpan(relative ? 2 : 0);
        // Treat paths as local package names on every host, with the same separators.
        foreach (var part in path.Split('/'))
        {
            var segment = path[part];
            if (segment.IsEmpty || segment is "." or ".." || segment[^1] == '.' ||
                segment.ContainsAnyExcept("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-."))
                return null;
        }
        return Path.GetFullPath(Path.Combine(relative ? Path.GetDirectoryName(source.Path)! : root, path.ToString()));
    }

    private async Task<SourceUnit?> ReadAsync(string path, string directory)
    {
        var text = await File.ReadAllTextAsync(path, cancellationToken);
        Texts[path] = text;
        var parse = FletcherSyntaxParser.Parse(path, text);
        Diagnostics.AddRange(parse.Diagnostics);
        return parse.Root is { } syntax ? new SourceUnit(path, directory, syntax) : null;
    }

    private void Error(string path, TextSpan span, string message) => Diagnostics.Add(new Diagnostic(path, span, message));
}
