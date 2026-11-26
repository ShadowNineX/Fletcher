using Fletcher.Compiler.IR;

namespace Fletcher.Compiler.CodeGeneration;

internal sealed partial class ScriptEmitter
{
    private readonly Dictionary<BoundDispatch, string[]> directDispatchLocals = [with(ReferenceEqualityComparer.Instance)];

    private void AnalyzeDirectDispatch(BoundDispatch[] calls)
    {
        var byName = DispatchedMethods().ToLookup(function => function.Name);
        foreach (var call in calls)
        {
            var signature = call.Receiver.Type.Shape.Methods[call.Method];
            var targets = byName[call.Method].Where(method => method.Result == signature.Result &&
                method.Parameters.Select(parameter => parameter.Type).SequenceEqual(signature.Parameters)).ToArray();
            if (targets.Length == 0 || !Array.TrueForAll(targets, directSlicedFunctions.Contains))
                continue;
            var site = directDispatchLocals.Count;
            directDispatchLocals.TryAdd(call, [.. Enumerable.Range(0, call.Arguments.Length + 1)
                .Select(index => $"__dispatchValue{site}_{index}")]);
        }
    }

    private void EmitDirectDispatchLocals(IEnumerable<BoundDispatch> calls)
    {
        if (directDispatchLocals.Count == 0)
            return;
        var locals = calls.Where(directDispatchLocals.ContainsKey).SelectMany(call => directDispatchLocals[call]).Distinct().ToArray();
        if (locals.Length > 0)
            Line($"let {string.Join(", ", locals)};");
    }

    private string CallDispatch(BoundDispatch call)
    {
        if (!directDispatchLocals.TryGetValue(call, out var locals))
            return Call($"__dispatch{call.Arguments.Length}",
                call.Arguments.Select(Expr).Prepend(Quote(call.Method)).Prepend(Expr(call.Receiver)));

        // Preserve evaluated values across a yield. Each call site has separate
        // locals so a nested call or a host callback cannot replace them.
        var assignments = locals.Zip(WithReceiver(call.Receiver, call.Arguments),
            (name, value) => $"{name} = {Expr(value)}");
        var receiver = locals[0];
        var arguments = string.Join(", ", locals.Skip(1).Prepend($"{receiver}.v"));
        return $"({string.Join(", ", assignments)}, {receiver} === null ? __uninitializedInterface() : " +
            $"((__budget === 0 ? (yield) : 0), __methods[{receiver}.t][{Quote(call.Method)}]({arguments})))";
    }
}
