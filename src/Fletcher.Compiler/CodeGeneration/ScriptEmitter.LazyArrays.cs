using Fletcher.Compiler.IR;

namespace Fletcher.Compiler.CodeGeneration;

internal sealed partial class ScriptEmitter
{
    private readonly Dictionary<Variable, BoundArray> deferredArrays = [];

    private void AnalyzeDeferredArrays(BoundBlock? body)
    {
        var statements = BoundTree.Statements(body).ToArray();
        var overwritten = statements.OfType<BoundAssignment>()
            .SelectMany(assignment => assignment.Targets.OfType<BoundVariable>())
            .Select(target => target.Symbol).ToHashSet();
        foreach (var declaration in statements.OfType<BoundLocals>())
        {
            // A local with a full replacement can avoid allocating its
            // default storage. Restrict this to large, uniform scalar arrays.
            if (declaration is { ResultSource: null, Symbols: [{ } local], IsNew: [true],
                    Values: [BoundArray { Elements.Length: >= 128 } array] } &&
                overwritten.Contains(local) && array.Elements[0] is BoundLiteral first &&
                !NeedsCopy(first.Type) && array.Elements.All(item => item is BoundLiteral literal && Equals(literal.Value, first.Value)))
                deferredArrays.Add(local, array);
        }
    }

    private string ReadVariable(Variable variable)
    {
        var local = Name(variable);
        return deferredArrays.TryGetValue(variable, out var array)
            ? $"({local} ??= {ArrayLiteral(array, snapshot: false)})" : local;
    }
}
