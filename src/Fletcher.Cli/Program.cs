using System.CommandLine;
using System.Text.Json;
using System.Text.Json.Serialization;
using Fletcher.Cli;
using Fletcher.Compiler;
using Fletcher.Compiler.Maps;
using Fletcher.Compiler.Syntax;
using Fletcher.Compiler.Translation;

var checkSource = SourceArgument();
var checkExplain = ExplainOption();
var checkPackages = PackageRootOption();
var checkAssets = AssetRootOption();
var checkIr = EmitIrOption();
Command check =
[
    with("check", "Check Fletcher source, including its map layout."),
    checkSource,
    checkExplain,
    checkPackages,
    checkAssets,
    checkIr
];
check.SetAction((result, cancellationToken) =>
    Compile(result.GetRequiredValue(checkSource), null, null, result.GetValue(checkPackages), result.GetValue(checkAssets),
        result.GetValue(checkExplain), IrOutputPath(result, checkIr, checkSource), cancellationToken));

var buildSource = SourceArgument();
var buildExplain = ExplainOption();
var buildPackages = PackageRootOption();
var buildAssets = AssetRootOption();
var buildIr = EmitIrOption();
var output = new Option<FileInfo>("--output", "-o")
{
    Description = "Path to the generated Logic Arrows map.",
    Required = true
};
var template = new Option<FileInfo?>("--template")
{
    Description = "Level JSON file whose wrapper metadata should be preserved."
};
Command build =
[
    with("build", "Compile a .flt file to a playable Logic Arrows Level map."),
    buildSource,
    output,
    template,
    buildExplain,
    buildPackages,
    buildAssets,
    buildIr
];
build.SetAction((result, cancellationToken) =>
    Compile(result.GetRequiredValue(buildSource), result.GetRequiredValue(output), result.GetValue(template),
        result.GetValue(buildPackages), result.GetValue(buildAssets), result.GetValue(buildExplain),
        IrOutputPath(result, buildIr, buildSource), cancellationToken));

var map = new Argument<FileInfo>("map.json") { Description = "Logic Arrows map to decode." };
var preview = new Option<bool>("--preview") { Description = "Decode the map-card preview." };
Command inspect = [with("inspect", "Print the tiles in a Logic Arrows v5 map as JSON."), map, preview];
inspect.SetAction((result, cancellationToken) =>
    Inspect(result.GetRequiredValue(map), result.GetValue(preview), cancellationToken));

var cSource = new Argument<FileInfo>("file.c") { Description = "C translation unit containing portable integer routines." };
var fletcherOutput = new Option<FileInfo>("--output", "-o")
{
    Description = "Path to the generated Fletcher package source.",
    Required = true
};
Command transpile = [with("transpile-c", "Translate a subset of C to a Fletcher library package."), cSource, fletcherOutput];
transpile.SetAction((result, cancellationToken) =>
    Transpile(result.GetRequiredValue(cSource), result.GetRequiredValue(fletcherOutput), cancellationToken));

var testSource = new Argument<string?>("path")
{
    Description = "Test file or directory (defaults to the current directory).",
    Arity = ArgumentArity.ZeroOrOne
};
var testFilter = new Option<string?>("--filter") { Description = "Case-insensitive substring filter for test names." };
var testPackages = PackageRootOption();
var testAssets = AssetRootOption();
Command test =
[
    with("test", "Compile and run Fletcher *_test.flt files with Node.js."),
    testSource,
    testFilter,
    testPackages,
    testAssets
];
test.SetAction((result, cancellationToken) =>
    TestCommand.RunAsync(result.GetValue(testSource), result.GetValue(testFilter), result.GetValue(testPackages),
        result.GetValue(testAssets), cancellationToken));

RootCommand root = [with("Fletcher compiles Go-style programs into Logic Arrows maps."), check, build, inspect, transpile, test];
return await root.Parse(args).InvokeAsync();

static Argument<FileInfo> SourceArgument() => new("file.flt") { Description = "Fletcher source file." };
static Option<bool> ExplainOption() => new("--explain") { Description = "Print backend choices, coordinates, and route timing." };
static Option<DirectoryInfo?> PackageRootOption() => new("--package-root") { Description = "Base directory for local package imports." };
static Option<DirectoryInfo?> AssetRootOption() => new("--asset-root") { Description = "Base directory for paths used by readFile()." };
static Option<FileInfo?> EmitIrOption() => new("--emit-ir")
{
    Description = "Write the typed IR as JSON, optionally specifying a path. Defaults to <source>.ir.json.",
    Arity = ArgumentArity.ZeroOrOne
};

static string? IrOutputPath(System.CommandLine.ParseResult result, Option<FileInfo?> option, Argument<FileInfo> source) =>
    result.GetResult(option) is null ? null :
    result.GetValue(option)?.FullName ?? Path.ChangeExtension(result.GetRequiredValue(source).FullName, ".ir.json");

static async Task<int> Transpile(FileInfo input, FileInfo output, CancellationToken cancellationToken)
{
    if (!output.Extension.Equals(".flt", StringComparison.OrdinalIgnoreCase) || SamePath(input.FullName, output.FullName))
        return Error("Choose a .flt output path distinct from the C source.", 2);

    try
    {
        var source = await File.ReadAllTextAsync(input.FullName, cancellationToken);
        var result = CTranspiler.Translate(input.FullName, source);
        if (result.Error is { } diagnostic)
        {
            WriteDiagnostic(diagnostic, source);
            return 1;
        }
        await WriteOutput(output.FullName, result.Source!, cancellationToken);
        return 0;
    }
    catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
    {
        return Error(exception.Message);
    }
}

static async Task<int> Compile(FileInfo input, FileInfo? output, FileInfo? template, DirectoryInfo? packageRoot,
    DirectoryInfo? assetRoot, bool explain, string? irPath, CancellationToken cancellationToken)
{
    if (!input.Extension.Equals(".flt", StringComparison.OrdinalIgnoreCase))
        return Error("Fletcher source files use the .flt extension.", 2);
    if (output is not null && (SamePath(output.FullName, input.FullName) || SamePath(output.FullName, template?.FullName)))
        return Error("Choose an output path distinct from the source and template.", 2);
    if (irPath is not null && (SamePath(irPath, input.FullName) || SamePath(irPath, template?.FullName) || SamePath(irPath, output?.FullName)))
        return Error("Choose an IR output path distinct from the source, template, and map output.", 2);

    try
    {
        var result = await FletcherCompiler.CompileFileAsync(input.FullName, cancellationToken, packageRoot?.FullName,
            assetRoot?.FullName, emitIr: irPath is not null);
        if (output is not null && result.Success)
        {
            if (result.SourceTexts.Keys.Any(path => SamePath(output.FullName, path)))
                return Error("Choose an output path distinct from every source file in the package graph.", 2);
            if (result.ImportedFiles.Any(path => SamePath(output.FullName, path)))
                return Error("Choose an output path distinct from every file imported by readFile().", 2);
        }
        if (irPath is not null && result.IntermediateRepresentationJson is { } ir)
        {
            if (result.SourceTexts.Keys.Any(path => SamePath(irPath, path)))
                return Error("Choose an IR path distinct from every source file in the package graph.", 2);
            if (result.ImportedFiles.Any(path => SamePath(irPath, path)))
                return Error("Choose an IR path distinct from every file imported by readFile().", 2);
            await WriteOutput(irPath, ir, cancellationToken);
        }
        if (!result.Success)
        {
            foreach (var diagnostic in result.Diagnostics)
                WriteDiagnostic(diagnostic, result.SourceTexts.GetValueOrDefault(diagnostic.Path, ""));
            return 1;
        }

        if (output is not null && result.Name is { } name)
        {
            var nativeTemplate = template is null ? null : await File.ReadAllTextAsync(template.FullName, cancellationToken);
            await WriteOutput(output.FullName, MapCodec.Write(name, result.Tiles, nativeTemplate), cancellationToken);
        }
        if (explain)
            Console.Write(result.Explanation);
        return 0;
    }
    catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or FormatException or ArgumentException or JsonException)
    {
        return Error(exception.Message);
    }
}

static async Task<int> Inspect(FileInfo input, bool preview, CancellationToken cancellationToken)
{
    try
    {
        var tiles = MapCodec.Read(await File.ReadAllTextAsync(input.FullName, cancellationToken), preview);
        var rows = tiles.OrderBy(tile => tile.Position.Y).ThenBy(tile => tile.Position.X).Select(tile => new
        {
            x = tile.Position.X,
            y = tile.Position.Y,
            type = tile.Type,
            rotation = tile.Rotation,
            flip = tile.Flip,
            extra = tile.Extra,
            payload_hex = tile.Payload is { } payload ? Convert.ToHexStringLower(payload) : null
        });
        Console.WriteLine(JsonSerializer.Serialize(rows, new JsonSerializerOptions
        {
            WriteIndented = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        }));
        return 0;
    }
    catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or FormatException or ArgumentException or JsonException)
    {
        return Error(exception.Message);
    }
}

static async Task WriteOutput(string path, string contents, CancellationToken cancellationToken)
{
    var folder = Path.GetDirectoryName(path)!;
    Directory.CreateDirectory(folder);
    var pending = Path.Combine(folder, $".fletcher-{Guid.NewGuid():N}.tmp");
    try
    {
        await File.WriteAllTextAsync(pending, contents, cancellationToken);
        File.Move(pending, path, overwrite: true);
    }
    finally
    {
        File.Delete(pending);
    }
}

static bool SamePath(string path, string? other) => string.Equals(path, other,
    OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

static void WriteDiagnostic(Diagnostic diagnostic, string source)
{
    var line = 1;
    var column = 1;
    for (var i = 0; i < Math.Clamp(diagnostic.Span.Start, 0, source.Length); i++)
    {
        if (source[i] == '\n')
        {
            line++;
            column = 1;
        }
        else
        {
            column++;
        }
    }
    Console.Error.WriteLine($"{diagnostic.Path}({line},{column}): error: {diagnostic.Message}");
}

static int Error(string message, int exitCode = 1)
{
    Console.Error.WriteLine($"fletcher: {message}");
    return exitCode;
}
