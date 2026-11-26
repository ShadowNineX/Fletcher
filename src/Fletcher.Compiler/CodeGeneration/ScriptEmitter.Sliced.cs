using Fletcher.Compiler.Maps;
using Fletcher.Compiler.IR;

namespace Fletcher.Compiler.CodeGeneration;

internal sealed partial class ScriptEmitter
{
    internal sealed record BufferedKeyGroup(Position Hub, Variable[] Keys, Variable? CombinedKey = null);

    private void EmitSlicedController(IReadOnlyList<Binding> bindings, IReadOnlyDictionary<Variable, Position[]> samples,
        IReadOnlyList<Variable> exports, IReadOnlyList<BufferedKeyGroup> keyGroups)
    {
        var screen = program.Screen!;
        var sliceBudget = screen.SliceWork > 0 ? screen.SliceWork : Math.Max(4096, 2 * screen.PixelCount);
        var hostBindings = bindings.Where(binding => binding.HostPublished).ToArray();
        var logicalBindings = bindings.Where(binding => !binding.HostPublished).ToArray();
        var hostWrites = BoundTree.RegisterWrites(program.HostTick).ToHashSet();
        int[] hostRegisters = [.. Enumerable.Range(0, program.Registers.Count).Where(index => hostWrites.Contains(program.Registers[index].Symbol))];
        var sharesRegisters = hostRegisters.Length > 0;
        var initial = string.Join(", ", program.Registers.Select(register => Copy(register.Initial)));
        var registerSnapshot = HasHostWork ? "state.reg ?? __initialRegisters()" : $"state.reg ?? [{initial}]";
        var callbackRegisters = sharesRegisters ? "__hostRegisters" : registerSnapshot;
        var buffered = program.Ports.Where(port => port.Buffer && samples.ContainsKey(port.Symbol))
            .Select(port => (port.Symbol, Positions: samples[port.Symbol])).OrderBy(port => port.Symbol.Id).ToArray();
        Line("let __flight = null, __lastHostTick = -1, __logicalTick = 0;");
        if (usesFileReadCache)
            Line("const __fileReads = new Array(256);");
        if (buffered.Length > 0)
            Line("const __pending = [];");
        if (UsesMouse)
            Line("let __tickMouseX = -1, __tickMouseY = -1;");
        if (sharesRegisters)
            Line("let __hostRegisters, __registersChanged;");
        if (HasHostWork)
        {
            Line($"function __initialRegisters() {{ return [{initial}]; }}");
            if (sharesRegisters)
            {
                // Keep the host transfer flat. Large registers have separate
                // strings so unchanged data does not cross the boundary again.
                Line("""
                    let __savedRegisters, __savedValues, __encodedValues;
                    let __registerEpoch, __registerSerial = 0;
                    const __largeRegisterLength = 32768;
                    function __registerKey(index, bank) {
                        return "fletcherRegister" + index + bank;
                    }
                    function __readRegisters() {
                        const saved = state.reg;
                        if (__savedValues && saved === __savedRegisters) return __savedValues;
                        const encoded = typeof saved === "string" ? saved.split("\n") : [];
                        const values = typeof saved === "string"
                            ? encoded.map((entry, i) => JSON.parse(entry[0] === "~"
                                ? state[__registerKey(i, entry[1])] : entry))
                            : saved ?? __initialRegisters();
                        __savedRegisters = saved;
                        __savedValues = values;
                        __encodedValues = encoded;
                        return values;
                    }
                    function __storeRegisters(values) {
                        const encoded = values.map((value, i) => {
                            // Registers are immutable snapshots. Reuse the JSON,
                            // including a large value read from an older inline snapshot.
                            const previous = __encodedValues[i];
                            const unchanged = value === __savedValues[i] && previous !== undefined;
                            const serialized = unchanged ? previous : JSON.stringify(value);
                            if (serialized.length < __largeRegisterLength) return serialized;

                            // Keep the old bank intact until the root snapshot commits.
                            const bank = previous?.startsWith("~0") ? "1" : "0";
                            state[__registerKey(i, bank)] = serialized;
                            // A later overwrite of the same bank needs a new key in
                            // the snapshot, even if the inline registers repeat.
                            __registerEpoch ??= Math.random().toString(36).slice(2);
                            return "~" + bank + ":" + __registerEpoch + ":" + ++__registerSerial;
                        });
                        const saved = encoded.join("\n");
                        state.reg = saved;
                        __savedRegisters = saved;
                        __savedValues = values;
                        __encodedValues = encoded;
                    }
                    """);
            }
            EmitHostStep(hostBindings, callbackRegisters, sharesRegisters);
        }
        Line("function* __tick() {");
        indent++;
        EmitDirectDispatchLocals(BoundTree.Dispatches(program.Tick)
            .Concat(logicalBindings.SelectMany(binding => BoundTree.Dispatches(binding.Value))));
        Line("__logicalTick = state.fletcherLogicalTick ?? 0;");
        if (usesFileReadCache)
            Line("__fileReads.fill(undefined);");
        Line("const __logs = [];");
        if (HasHostWork)
            Line("const __p = [];");
        if (UsesMouse)
            Line("__tickMouseX = __mouseX; __tickMouseY = __mouseY;");
        if (screen.IsSolid)
        {
            Line("__pixels.fill(__background);");
            if (screen.UsesRgbPalette)
                Line("__hasRgbPalette = false;");
            if (UsesPixelIndices)
                Line("__pixelIndices.fill(0);");
            if (screen.Hold)
                Line("__drawn = false;");
        }
        Line($"const __registers = {callbackRegisters};");
        Line("const __next = __registers.slice();");
        for (var i = 0; i < program.Registers.Count; i++)
            Line($"{Name(program.Registers[i].Symbol)} = __registers[{i}];");
        foreach (var (symbol, positions) in samples.OrderBy(pair => pair.Key.Id))
        {
            if (buffered.Any(item => item.Symbol == symbol))
            {
                Line($"{Name(symbol)} = __pending[{symbol.Id}] === true;");
                Line($"__pending[{symbol.Id}] = false;");
            }
            else
                Line($"{Name(symbol)} = {Read(symbol.Type, positions)};");
        }
        foreach (var binding in logicalBindings)
            Line($"{Name(binding.Symbol)} = {Expr(binding.Value)};");
        if (program.Tick is { } tick)
            EmitStatements(tick);
        if (screen.IsSolid)
            Line("__present();");
        if (sharesRegisters)
        {
            // A suspended logical tick must merge the latest host writes.
            foreach (var index in hostRegisters)
                Line($"__next[{index}] = __hostRegisters[{index}];");
            Line("__hostRegisters = __next; __registersChanged = true;");
        }
        else
            Line("state.reg = __next;");
        Line("state.fletcherLogicalTick = __logicalTick + 1;");
        if (exports.Count > 0)
            Line($"state.fletcherOutputs = [{string.Join(", ", exports.Select(Name))}];");
        var published = PublishedFrame(logicalBindings.Where(binding => binding.Published));
        if (published is not null)
            Line($"state.fletcherPublished = {published};");
        Line("for (const args of __logs) log(...args);");
        indent--;
        Line("}");
        Line("always(() => {");
        indent++;
        if (splitTables)
            Line("if (!__prepareTables()) return;");
        Line("const __hostTick = world.getTick();");
        Line("if (__hostTick !== __lastHostTick + 1) {");
        indent++;
        Line("__flight = null;");
        foreach (var (symbol, _) in buffered)
            Line($"__pending[{symbol.Id}] = false;");
        indent--;
        Line("}");
        Line("__lastHostTick = __hostTick;");
        var grouped = keyGroups.SelectMany(group => group.Keys).ToHashSet();
        foreach (var group in keyGroups)
        {
            Line($"if (__read({group.Hub.X}, {group.Hub.Y})) {{");
            indent++;
            if (group.CombinedKey is { } combined)
            {
                grouped.Add(combined);
                Line($"__pending[{combined.Id}] = true;");
            }
            foreach (var symbol in group.Keys)
                SampleKey(symbol, samples[symbol]);
            indent--;
            Line("}");
        }
        foreach (var (symbol, positions) in buffered)
            if (!grouped.Contains(symbol))
                SampleKey(symbol, positions);
        if (hostBindings.Length > 0)
            Line("let __hostPublished;");
        if (sharesRegisters)
        {
            // Both steps use one snapshot of the host's register array.
            Line("__hostRegisters = __readRegisters();");
            Line("__registersChanged = false;");
            Line("try {");
            indent++;
        }
        Line($"__budget = {sliceBudget};");
        Line("if (__flight === null) __flight = __tick();");
        Line("try { if (__flight.next().done) __flight = null; } catch (error) { __flight = null; throw error; }");
        if (HasHostWork)
        {
            Line("const __savedTick = __logicalTick;");
            Line("__logicalTick = __hostTick;");
            Line("__budget = Infinity;");
            Line("try {");
            indent++;
            if (hostBindings.Length > 0)
                Line("__hostPublished = __hostStep().next().value;");
            else
                Line("__hostStep().next();");
            indent--;
            Line("} finally { __logicalTick = __savedTick; }");
        }
        if (sharesRegisters)
        {
            indent--;
            Line("} finally {");
            indent++;
            // Keep any completed logical commit if the host step throws.
            Line("if (__registersChanged) __storeRegisters(__hostRegisters);");
            indent--;
            Line("}");
        }
        if (exports.Count > 0 || published is not null || hostBindings.Length > 0)
        {
            var values = exports.Count == 0 ? "[]" : $"state.fletcherOutputs ?? [{string.Join(", ", exports.Select(_ => "0"))}]";
            var shared = published is null ? null : "state.fletcherPublished";
            if (hostBindings.Length > 0)
                shared = shared is null ? "__hostPublished" : "{ ...state.fletcherPublished, ...__hostPublished }";
            PublishFrame("__hostTick", values, shared);
        }
        indent--;
        Line("});");

        void SampleKey(Variable symbol, Position[] positions) =>
            Line($"__pending[{symbol.Id}] = __pending[{symbol.Id}] === true || {Read(symbol.Type, positions)};");
    }

    private void EmitHostStep(Binding[] bindings, string registerSnapshot, bool writesRegisters)
    {
        var reads = BoundTree.References(program.HostTick).Concat(bindings.SelectMany(binding => BoundTree.References(binding.Value))).ToHashSet();
        Line("function* __hostStep() {");
        indent++;
        EmitDirectDispatchLocals(BoundTree.Dispatches(program.HostTick)
            .Concat(bindings.SelectMany(binding => BoundTree.Dispatches(binding.Value))));
        Line("const __p = [];");
        Line("const __logs = [];");
        Line($"const __registers = {registerSnapshot};");
        if (writesRegisters)
            Line("const __next = __registers.slice();");
        for (var i = 0; i < program.Registers.Count; i++)
        {
            var symbol = program.Registers[i].Symbol;
            if (reads.Contains(symbol))
                Line($"{Name(symbol)} = __registers[{i}];");
        }
        foreach (var binding in bindings)
            Line($"{Name(binding.Symbol)} = {Expr(binding.Value)};");
        if (program.HostTick is { } tick)
            EmitStatements(tick);
        if (writesRegisters)
            Line("__hostRegisters = __next; __registersChanged = true;");
        Line("for (const args of __logs) log(...args);");
        if (PublishedFrame(bindings) is { } published)
            Line($"return {published};");
        indent--;
        Line("}");
    }
}
