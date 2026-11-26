using Fletcher.Compiler.IR;

namespace Fletcher.Compiler.CodeGeneration;

internal sealed partial class ScriptEmitter
{
    private readonly Dictionary<BoundCall, int> ownedCallArguments = [with(ReferenceEqualityComparer.Instance)];
    private readonly Dictionary<Function, int> movableParameters = [];

    private void AnalyzeOwnedArguments(Function[] functions)
    {
        AnalyzeBlock(program.Tick, null);
        AnalyzeBlock(program.HostTick, null);
        foreach (var function in functions)
            AnalyzeBlock(function.Body, function);
    }

    private void AnalyzeBlock(BoundBlock? body, Function? function)
    {
        var statements = BoundTree.Statements(body).ToArray();
        var owned = OwnedStorage(function, statements);
        foreach (var assignment in statements.OfType<BoundAssignment>())
        {
            var call = assignment.ResultSource?.Call as BoundCall;
            if (call is null && assignment.Targets.Length == 1 && assignment.Values is [BoundCall single])
                call = single;
            if (call is not null)
                AnalyzeReplacingCall(assignment.Targets, call, owned);
        }
        foreach (var result in statements.OfType<BoundReturn>())
        {
            if (result.Value is BoundCall call)
                AnalyzeCall(call, owned, static _ => true);
            else if (function?.Result.IsResultList == true && result.Value is BoundStruct tuple)
                foreach (var (field, value) in tuple.Fields)
                    if (value is BoundCall item)
                        AnalyzeCall(item, owned, location =>
                            !tuple.Fields.Any(sibling => sibling.Key != field && MayOverlap(sibling.Value, location)));
        }
    }

    private void AnalyzeReplacingCall(BoundExpression?[] targets, BoundCall call, HashSet<Variable> owned)
    {
        var locations = targets.Select(StaticLocation).ToArray();
        AnalyzeCall(call, owned, location =>
        {
            var target = Array.FindIndex(locations, candidate => candidate is not null &&
                candidate.Root == location.Root && candidate.Members.SequenceEqual(location.Members));
            // Parallel assignment captures every destination before the call.
            return target >= 0 && !targets.Where((_, index) => index != target).Any(other => MayOverlap(other, location));
        });
    }

    private void AnalyzeCall(BoundCall call, HashSet<Variable> owned, Func<StorageLocation, bool> canMove)
    {
        var copied = CopiedParameters(call.Function).ToHashSet();
        if (copied.Count == 0)
            return;
        Variable[] parameters = call.Function.Receiver is { } receiver
            ? [receiver, .. call.Function.Parameters] : call.Function.Parameters;
        var arguments = WithReceiver(call.Receiver, call.Arguments);
        var mask = 0;
        for (var index = 0; index < Math.Min(arguments.Length, 31); index++)
        {
            if (!copied.Contains(parameters[index]) ||
                StaticLocation(arguments[index]) is not { } location || !owned.Contains(location.Root))
                continue;

            // The call may update its argument while another parameter still
            // needs the old value, including after a suspension.
            if (!canMove(location) ||
                arguments.Where((_, position) => position != index).Any(argument => MayAlias(argument, location)))
                continue;

            mask |= 1 << index;
        }
        if (mask == 0)
            return;
        ownedCallArguments.Add(call, mask);
        movableParameters[call.Function] = movableParameters.GetValueOrDefault(call.Function) | mask;
    }

    private static bool MayAlias(BoundExpression argument, StorageLocation location) =>
        NeedsCopy(argument.Type) && MayOverlap(argument, location);

    private static bool MayOverlap(BoundExpression? expression, StorageLocation location)
    {
        if (expression is null)
            return false;
        if (StaticLocation(expression) is not { } other)
            return BoundTree.References(expression).Contains(location.Root);

        var common = Math.Min(location.Members.Length, other.Members.Length);
        return location.Root == other.Root &&
            location.Members.AsSpan(0, common).SequenceEqual(other.Members.AsSpan(0, common));
    }

    private static StorageLocation? StaticLocation(BoundExpression? expression) => expression switch
    {
        BoundVariable variable => new StorageLocation(variable.Symbol, []),
        BoundMember member when StaticLocation(member.Receiver) is { } parent =>
            new StorageLocation(parent.Root, [.. parent.Members, member.Name]),
        _ => null
    };

    private sealed record StorageLocation(Variable Root, string[] Members);
}
