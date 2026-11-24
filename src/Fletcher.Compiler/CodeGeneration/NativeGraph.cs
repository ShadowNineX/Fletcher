using System.Diagnostics.CodeAnalysis;
using Fletcher.Compiler.Routing;
using Fletcher.Compiler.IR;

namespace Fletcher.Compiler.CodeGeneration;

internal sealed class NativeGraph(bool factor)
{
    public const int Low = -1;
    public const int High = 0;
    private readonly List<Gate> gates = [];
    private readonly Dictionary<int, Gate> definitions = [];
    private readonly Dictionary<(GateKind Kind, int A, int B), int> shared = [];
    private readonly Dictionary<(Variable Symbol, int Lane), int> inputs = [];
    private int nextSignal = 1;

    public IReadOnlyDictionary<(Variable Symbol, int Lane), int> Inputs => inputs;
    public bool AppliedFactoring { get; private set; }

    public int[] Input(Variable variable)
    {
        if (!variable.Type.IsSignal)
            throw new NativeException($"'{variable.Name}' cannot cross a circuit boundary because its type is '{variable.Type}'.");
        var bits = new int[variable.Type.Width];
        for (var i = 0; i < bits.Length; i++)
        {
            var key = (variable, i);
            if (!inputs.TryGetValue(key, out var signal))
            {
                signal = nextSignal++;
                inputs.Add(key, signal);
            }
            bits[i] = signal;
        }
        return bits;
    }

    public Gate[] Keep(IEnumerable<int> outputs, out HashSet<int> sources)
    {
        sources = [with(outputs.Where(id => id != Low))];
        List<Gate> kept = [];
        for (var i = gates.Count - 1; i >= 0; i--)
        {
            var gate = gates[i];
            if (!sources.Remove(gate.Id))
                continue;
            kept.Add(gate);
            sources.UnionWith(gate.Inputs.Where(id => id != Low));
        }
        kept.Reverse();
        return [.. kept];
    }

    public int Not(int a)
    {
        if (a is Low or High)
            return a == Low ? High : Low;
        if (TryGetNotInput(a, out var input))
            return input;
        return Gate(GateKind.Not, a, Low);
    }

    public int And(int a, int b)
    {
        if (a == Low || b == Low)
            return Low;
        if (a == High || a == b)
            return b;
        if (b == High)
            return a;
        if (AreComplements(a, b))
            return Low;
        if (ContainsOperand(b, GateKind.Or, a))
            return a;
        if (ContainsOperand(a, GateKind.Or, b))
            return b;
        if (factor && TryFactor(a, b, GateKind.Or, out var common, out var left, out var right))
        {
            AppliedFactoring = true;
            return Or(common, And(left, right));
        }
        return Gate(GateKind.And, a, b);
    }

    public int Or(int a, int b)
    {
        if (a == High || b == High)
            return High;
        if (a == Low || a == b)
            return b;
        if (b == Low)
            return a;
        if (AreComplements(a, b))
            return High;
        if (ContainsOperand(b, GateKind.And, a))
            return a;
        if (ContainsOperand(a, GateKind.And, b))
            return b;
        if (factor && TryFactor(a, b, GateKind.And, out var common, out var left, out var right))
        {
            AppliedFactoring = true;
            return And(common, Or(left, right));
        }
        return Gate(GateKind.Or, a, b);
    }

    public int Xor(int a, int b)
    {
        if (a == b)
            return Low;
        if (a == Low)
            return b;
        if (b == Low)
            return a;
        if (a == High)
            return Not(b);
        if (b == High)
            return Not(a);
        if (AreComplements(a, b))
            return High;
        if (TryCancelXorOperand(a, b, out var remaining) || TryCancelXorOperand(b, a, out remaining))
            return remaining;
        return Gate(GateKind.Xor, a, b);
    }

    public int Select(int test, int yes, int no) => test switch
    {
        High => yes,
        Low => no,
        _ when yes == no => yes,
        _ => Or(And(test, yes), And(Not(test), no))
    };

    private int Gate(GateKind kind, int a, int b)
    {
        if (kind != GateKind.Not && a > b)
            (a, b) = (b, a);
        var key = (kind, a, b);
        if (shared.TryGetValue(key, out var existing))
            return existing;
        var id = nextSignal++;
        var gate = new Gate(id, kind, kind == GateKind.Not ? [a] : [a, b]);
        gates.Add(gate);
        definitions.Add(id, gate);
        shared.Add(key, id);
        return id;
    }

    private bool AreComplements(int a, int b)
    {
        return TryGetNotInput(a, out var left) && left == b
            || TryGetNotInput(b, out var right) && right == a;
    }

    private bool TryGetNotInput(int signal, out int input)
    {
        if (definitions.TryGetValue(signal, out var gate) && gate.Kind == GateKind.Not)
        {
            input = gate.Inputs[0];
            return true;
        }

        input = default;
        return false;
    }

    private bool ContainsOperand(int signal, GateKind kind, int operand) =>
        definitions.TryGetValue(signal, out var gate)
        && gate.Kind == kind
        && (gate.Inputs[0] == operand || gate.Inputs[1] == operand);

    private bool TryCancelXorOperand(int xor, int operand, out int remaining)
    {
        if (definitions.TryGetValue(xor, out var gate) && gate.Kind == GateKind.Xor)
        {
            if (gate.Inputs[0] == operand)
            {
                remaining = gate.Inputs[1];
                return true;
            }

            if (gate.Inputs[1] == operand)
            {
                remaining = gate.Inputs[0];
                return true;
            }
        }

        remaining = default;
        return false;
    }

    private bool TryFactor(int first, int second, GateKind termKind, out int common, out int left, out int right)
    {
        if (!definitions.TryGetValue(first, out var firstGate)
            || !definitions.TryGetValue(second, out var secondGate)
            || firstGate.Kind != termKind
            || secondGate.Kind != termKind)
        {
            common = left = right = default;
            return false;
        }

        var firstInputs = firstGate.Inputs;
        var secondInputs = secondGate.Inputs;
        if (firstInputs[0] == secondInputs[0])
        {
            common = firstInputs[0];
            left = firstInputs[1];
            right = secondInputs[1];
            return true;
        }

        if (firstInputs[0] == secondInputs[1])
        {
            common = firstInputs[0];
            left = firstInputs[1];
            right = secondInputs[0];
            return true;
        }

        if (firstInputs[1] == secondInputs[0])
        {
            common = firstInputs[1];
            left = firstInputs[0];
            right = secondInputs[1];
            return true;
        }

        if (firstInputs[1] == secondInputs[1])
        {
            common = firstInputs[1];
            left = firstInputs[0];
            right = secondInputs[0];
            return true;
        }

        common = left = right = default;
        return false;
    }
}

[SuppressMessage("Design", "S3871", Justification = "The public compiler entry points convert this exception to a diagnostic.")]
internal sealed class NativeException(string message) : Exception(message);
