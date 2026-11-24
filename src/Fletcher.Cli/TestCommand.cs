using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using Fletcher.Compiler;
using Fletcher.Compiler.Syntax;

namespace Fletcher.Cli;

internal static class TestCommand
{
    public static async Task<int> RunAsync(string? requestedPath, string? filter, DirectoryInfo? packageRoot,
        DirectoryInfo? assetRoot, CancellationToken cancellationToken)
    {
        var path = Path.GetFullPath(string.IsNullOrWhiteSpace(requestedPath) ? Directory.GetCurrentDirectory() : requestedPath);
        if (File.Exists(path))
        {
            if (!path.EndsWith(".flt", StringComparison.OrdinalIgnoreCase))
                return await ErrorAsync("Fletcher source files use the .flt extension.", 2);

            var (fileExitCode, fileTestCount, _) = await RunPackageAsync(path, includeSiblingTests: false, filter, packageRoot, assetRoot,
                cancellationToken);
            if (fileExitCode == 0 && fileTestCount == 0)
                return await ErrorAsync(filter is null ? "no tests were selected." : $"no tests matched filter '{filter}'.");
            return fileExitCode;
        }

        if (!Directory.Exists(path))
            return await ErrorAsync($"Path does not exist: {path}", 2);

        List<string> tests;
        try
        {
            tests = DiscoverTests(path);
        }
        catch (IOException exception)
        {
            return await ErrorAsync(exception.Message);
        }
        catch (UnauthorizedAccessException exception)
        {
            return await ErrorAsync(exception.Message);
        }

        if (tests.Count == 0)
            return await ErrorAsync("no *_test.flt files found.");

        HashSet<string> remaining = [with(tests, OperatingSystem.IsWindows()
            ? StringComparer.OrdinalIgnoreCase
            : StringComparer.Ordinal)];
        var packageCount = 0;
        var selectedTests = 0;
        var exitCode = 0;
        while (remaining.Count > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var representative = remaining.OrderBy(file => file, StringComparer.OrdinalIgnoreCase).First();
            var (packageExitCode, packageTestCount, sourceTexts) = await RunPackageAsync(representative, includeSiblingTests: true, filter, packageRoot,
                assetRoot, cancellationToken);
            if (packageTestCount > 0)
            {
                packageCount++;
                selectedTests += packageTestCount;
            }
            if (packageExitCode != 0)
                exitCode = packageExitCode;
            foreach (var source in sourceTexts.Keys)
                remaining.Remove(Path.GetFullPath(source));
            // A failed load can have no source map. Always make progress while
            // retaining the diagnostic for the representative file.
            remaining.Remove(representative);
        }

        if (selectedTests == 0)
            return await ErrorAsync(filter is null ? "no tests were selected." : $"no tests matched filter '{filter}'.");

        await Console.Out.WriteLineAsync($"fletcher: {selectedTests} test(s) across {packageCount} package(s).".AsMemory(), cancellationToken);
        return exitCode;
    }

    private static async Task<(int ExitCode, int SelectedTests, IReadOnlyDictionary<string, string> SourceTexts)> RunPackageAsync(
        string representative, bool includeSiblingTests, string? filter, DirectoryInfo? packageRoot,
        DirectoryInfo? assetRoot, CancellationToken cancellationToken)
    {
        TestCompilationResult result;
        try
        {
            result = await FletcherCompiler.CompileTestsAsync(representative, includeSiblingTests, filter,
                cancellationToken, packageRoot?.FullName, assetRoot?.FullName);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
        {
            await ErrorAsync(exception.Message);
            return (1, 0, ReadOnlyDictionary<string, string>.Empty);
        }

        foreach (var diagnostic in result.Diagnostics)
            await WriteDiagnosticAsync(diagnostic, result.SourceTexts.GetValueOrDefault(diagnostic.Path, ""));

        if (result.Diagnostics.Count > 0 || result.Script is null || result.SelectedTests == 0)
            return (result.Diagnostics.Count > 0 ? 1 : 0, result.SelectedTests, result.SourceTexts);

        try
        {
            var node = FindNodeExecutable();
            var code = node is null
                ? await ErrorAsync("could not find Node.js. Install it and add its directory to PATH.")
                : await RunNodeAsync(node, result.Script, cancellationToken);
            return (code, result.SelectedTests, result.SourceTexts);
        }
        catch (Win32Exception exception)
        {
            return (await ErrorAsync($"Could not start Node.js. {exception.Message}"), result.SelectedTests, result.SourceTexts);
        }
        catch (IOException exception)
        {
            return (await ErrorAsync($"Could not communicate with Node.js. {exception.Message}"), result.SelectedTests, result.SourceTexts);
        }
    }

    private static string? FindNodeExecutable()
    {
        var name = OperatingSystem.IsWindows() ? "node.exe" : "node";
        var searchPath = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var entry in searchPath.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var directory = entry.Trim('"');
            if (!Path.IsPathFullyQualified(directory))
                continue;
            var candidate = Path.Combine(directory, name);
            if (File.Exists(candidate))
                return candidate;
        }
        return null;
    }

    private static async Task<int> RunNodeAsync(string executable, string script, CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo(executable, ["--input-type=commonjs", "-"])
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        using var process = Process.Start(startInfo)!;

        var stdout = PumpAsync(process.StandardOutput, Console.Out, cancellationToken);
        var stderr = PumpAsync(process.StandardError, Console.Error, cancellationToken);
        try
        {
            await process.StandardInput.WriteAsync(script.AsMemory(), cancellationToken);
            process.StandardInput.Close();
            await process.WaitForExitAsync(cancellationToken);
            await Task.WhenAll(stdout, stderr);
            return process.ExitCode;
        }
        catch (OperationCanceledException)
        {
            TryKill(process);
            throw;
        }
    }

    private static async Task PumpAsync(StreamReader reader, TextWriter writer, CancellationToken cancellationToken)
    {
        var buffer = new char[4096];
        int count;
        while ((count = await reader.ReadAsync(buffer.AsMemory(), cancellationToken)) > 0)
            await writer.WriteAsync(buffer.AsMemory(0, count), cancellationToken);
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
        }
        catch (Exception exception) when (exception is InvalidOperationException or Win32Exception)
        {
            // The child may have exited while cancellation was being delivered.
        }
    }

    private static List<string> DiscoverTests(string root)
    {
        List<string> tests = [];
        Stack<string> pending = [with([root])];
        while (pending.TryPop(out var directory))
        {
            foreach (var file in Directory.EnumerateFiles(directory, "*_test.flt"))
                tests.Add(Path.GetFullPath(file));
            foreach (var child in Directory.EnumerateDirectories(directory))
            {
                var info = new DirectoryInfo(child);
                if ((info.Attributes & FileAttributes.ReparsePoint) != 0 || IsIgnoredDirectory(info.Name))
                    continue;
                pending.Push(child);
            }
        }

        tests.Sort(StringComparer.OrdinalIgnoreCase);
        return tests;
    }

    private static bool IsIgnoredDirectory(string name) => name.Equals(".git", StringComparison.OrdinalIgnoreCase)
        || name.Equals("bin", StringComparison.OrdinalIgnoreCase)
        || name.Equals("obj", StringComparison.OrdinalIgnoreCase)
        || name.Equals("artifacts", StringComparison.OrdinalIgnoreCase)
        || name.Equals("node_modules", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith('.');

    private static Task WriteDiagnosticAsync(Diagnostic diagnostic, string source)
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
                column++;
        }
        return Console.Error.WriteLineAsync($"{diagnostic.Path}({line},{column}): error: {diagnostic.Message}");
    }

    private static async Task<int> ErrorAsync(string message, int exitCode = 1)
    {
        await Console.Error.WriteLineAsync($"fletcher: {message}");
        return exitCode;
    }
}
