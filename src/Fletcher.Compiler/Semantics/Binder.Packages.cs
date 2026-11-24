using Fletcher.Compiler.IR;
using Fletcher.Compiler.Syntax;

namespace Fletcher.Compiler.Semantics;

internal sealed partial class Binder
{
    private SourceUnit FileOf(SyntaxNode node) => files.GetValueOrDefault(node.Span.SourcePath ?? path) ?? files[path];

    private static string PackageKey(string package, string name) => string.Concat(
        OperatingSystem.IsWindows() ? package.ToUpperInvariant() : package, "\0", name);
    private static string KeyName(string key) => key[(key.IndexOf('\0') + 1)..];
    private static bool IsExported(string name) => name.Length > 0 && name[0] is >= 'A' and <= 'Z';
    private string LocalKey(string name, SyntaxNode node) => PackageKey(FileOf(node).Package, name);
    private bool InSamePackage(SyntaxNode first, SyntaxNode second) => string.Equals(FileOf(first).Package, FileOf(second).Package,
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    private string? LookupKey(string name, SyntaxNode location, bool report = true)
    {
        var dot = name.IndexOf('.');
        if (dot < 0)
            return LocalKey(name, location);
        var alias = name[..dot];
        if (!FileOf(location).Imports.TryGetValue(alias, out var package))
        {
            if (report)
                Error(location, $"Unknown package alias '{alias}'.");
            return null;
        }
        var member = name[(dot + 1)..];
        if (!IsExported(member))
        {
            if (report)
                Error(location, $"'{member}' is not exported by package '{alias}'.");
            return null;
        }
        return PackageKey(package, member);
    }

    private NameExpressionSyntax? PackageMember(MemberExpressionSyntax member, Scope scope) =>
        member.Target is NameExpressionSyntax { TypeArguments.Length: 0 } name && scope.Find(name.Name) is null &&
        FileOf(name).Imports.ContainsKey(name.Name)
            ? new NameExpressionSyntax($"{name.Name}.{member.Member}", [], member.Span)
            : null;

    private bool CanAccessMember(DataType type, string name, SyntaxNode use) => IsExported(name) ||
        !nominal.TryGetValue(type, out var declaration) || InSamePackage(declaration, use);
}
