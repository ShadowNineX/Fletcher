using Fletcher.Compiler.IR;
using Fletcher.Compiler.Maps;
using Fletcher.Compiler.Syntax;

namespace Fletcher.Compiler.Semantics;

internal sealed partial class Binder
{
    private readonly HashSet<MacroDeclarationSyntax> activeMacros = [];

    private void ValidateMacroParameters(MacroDeclarationSyntax macro)
    {
        HashSet<string> names = [with(StringComparer.Ordinal)];
        foreach (var parameter in macro.Parameters)
        {
            if (parameter.Name == "_" || !names.Add(parameter.Name))
                Error(parameter, $"Invalid or duplicate macro parameter '{parameter.Name}'.");
        }
    }

    private void BindPlacement(MapMemberSyntax member, Scope scope, List<Tile> tiles)
    {
        if (member is PlaceDeclarationSyntax placement)
        {
            if (BindTile(placement, scope) is { } tile)
                tiles.Add(tile);
            return;
        }

        var expansion = (MacroExpansionSyntax)member;
        if (LookupKey(expansion.Name, expansion) is not { } key)
            return;
        if (!macroDeclarations.TryGetValue(key, out var macro))
        {
            Error(expansion, $"Unknown macro '{expansion.Name}'.");
            return;
        }
        if (macro.Parameters.Length != expansion.Arguments.Length)
        {
            Error(expansion, $"Macro '{expansion.Name}' expects {macro.Parameters.Length} arguments, got {expansion.Arguments.Length}.");
            return;
        }
        if (!activeMacros.Add(macro))
        {
            Error(expansion, $"Macro '{expansion.Name}' is recursive.");
            return;
        }

        // Arguments are resolved at the use site. The body sees its own file
        // and parameters, with no access to the caller's local names.
        var parameters = new Scope();
        try
        {
            for (var i = 0; i < macro.Parameters.Length; i++)
            {
                var parameter = macro.Parameters[i];
                var argument = expansion.Arguments[i];
                var type = ResolveType(parameter.Type, noTypeArguments);
                var value = RequireConstant(BindAs(argument, scope, noTypeArguments, type), argument, allowArray: true);
                if (value is null)
                    return;
                var symbol = NewVariable(parameter.Name, type, SymbolKind.Constant);
                if (!parameters.Variables.TryAdd(symbol.Name, symbol))
                    return;
                localConstants.Add(symbol, value with { IsUntyped = false });
            }
            foreach (var nested in macro.Members)
                BindPlacement(nested, parameters, tiles);
        }
        finally
        {
            foreach (var symbol in parameters.Variables.Values)
                localConstants.Remove(symbol);
            activeMacros.Remove(macro);
        }
    }
}
