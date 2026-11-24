using Fletcher.Compiler.IR;

namespace Fletcher.Compiler.Syntax;

internal sealed class FileImports(string? assetRoot, CancellationToken cancellationToken)
{
    private readonly Dictionary<string, ImportedFile> loaded = [with(OperatingSystem.IsWindows()
        ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal)];

    public IEnumerable<string> Paths => loaded.Keys;

    public ImportedFile Read(string sourcePath, string name)
    {
        if (string.IsNullOrWhiteSpace(name) || Path.IsPathRooted(name) || (OperatingSystem.IsWindows() && name.Contains(':')))
            throw new IOException("readFile() requires a relative file path.");

        var root = assetRoot ?? Path.GetDirectoryName(sourcePath)!;
        var path = Path.GetFullPath(name, root);
        var relative = Path.GetRelativePath(root, path);
        if (relative is "." or ".." || Path.IsPathRooted(relative) || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            throw new IOException("readFile() path must stay inside the source directory or --asset-root.");
        if (loaded.TryGetValue(path, out var existing))
            return existing;

        var next = root;
        foreach (var segment in relative.Split(Path.DirectorySeparatorChar))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (OperatingSystem.IsWindows() && (segment.EndsWith('.') || segment.EndsWith(' ')))
                throw new IOException("readFile() path components cannot end in a dot or space on Windows.");
            next = Path.Combine(next, segment);
            if ((File.GetAttributes(next) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("readFile() paths cannot traverse links inside the import directory.");
        }

        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length > Array.MaxLength)
            throw new IOException("readFile() file cannot be represented as a single byte array.");
        var data = new byte[(int)stream.Length];
        stream.ReadExactly(data);
        cancellationToken.ThrowIfCancellationRequested();
        var file = data.Length == 0 ? ImportedFile.Empty : new ImportedFile(data);
        loaded.Add(path, file);
        return file;
    }

    public ImportedFile ReadIfPresent(string sourcePath, string name)
    {
        try
        {
            return Read(sourcePath, name);
        }
        catch (FileNotFoundException)
        {
            return ImportedFile.Empty;
        }
        catch (DirectoryNotFoundException)
        {
            return ImportedFile.Empty;
        }
    }
}
