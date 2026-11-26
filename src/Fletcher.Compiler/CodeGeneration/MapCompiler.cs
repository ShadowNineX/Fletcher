using System.Diagnostics.CodeAnalysis;
using System.Text;
using Fletcher.Compiler.IR;
using Fletcher.Compiler.Maps;
using Fletcher.Compiler.Routing;

namespace Fletcher.Compiler.CodeGeneration;

internal sealed class MapCompiler(IrProgram program)
{
    private const byte Button = 24, Toggle = 19, Lamp = 27, ScriptSource = 22, ScriptBlock = 33, Power = 2;
    private const byte Key = 21, Arrow = 1, BlueArrow = 10, Xor = 17, ForwardingLamp = 28;
    private const byte Up = 0, Right = 1, Down = 2, Left = 3;
    private const int RailSpacing = 8;
    // Keep each batch well within the map format's per-tile JavaScript limit.
    private const int DriverBatchSize = 256;
    private static readonly (Position Offset, byte Facing)[] KeyNeighbors =
        [(new(-1, 0), Right), (new(0, -1), Down), (new(1, 0), Left), (new(0, 1), Up)];

    private readonly Dictionary<Variable, string> fallback = [];
    private readonly HashSet<Variable> scriptOnly = [];
    private readonly HashSet<Position> manualPositions = [.. program.ManualTiles.Select(tile => tile.Position)];

    public (IReadOnlyList<Tile> Tiles, string Explanation) Compile()
    {
        var tickReads = BoundTree.References(program.Tick).Where(variable => variable.IsMapValue).ToHashSet();
        var reachable = FindLiveBindings(tickReads);
        Binding[] live = [.. program.Bindings.Where(binding => reachable.Contains(binding.Symbol))];
        while (true)
        {
            var selection = SelectBackends(live, factor: true);
            try
            {
                var placement = PlaceBestGraph(selection, live, tickReads);
                return (placement.Tiles, placement.Explanation);
            }
            catch (Exception error) when (error is RoutingException or MapLayoutException { RetryBackend: true })
            {
                bool CanRetry(Binding binding) => binding.Backend == Backend.Auto &&
                    selection.Native.ContainsKey(binding.Symbol) && !RequiresCircuit(binding.Value);
                var retry = error is MapLayoutException { NativeBinding: { } failed }
                    ? live.FirstOrDefault(binding => binding.Symbol == failed && CanRetry(binding)) : null;
                retry ??= live.LastOrDefault(CanRetry);
                if (retry is null)
                {
                    if (error is RoutingException)
                        throw new RoutingException($"Cannot route native circuit. {error.Message}");
                    throw;
                }
                scriptOnly.Add(retry.Symbol);
                fallback[retry.Symbol] = $"placement: {error.Message}";
            }
        }
    }

    private HashSet<Variable> FindLiveBindings(HashSet<Variable> tickReads)
    {
        HashSet<Variable> live = [with(tickReads)];
        foreach (var port in program.Ports.Where(port => port.Symbol.Kind == SymbolKind.Output))
            live.Add(port.Symbol);
        for (var i = program.Bindings.Count - 1; i >= 0; i--)
        {
            var binding = program.Bindings[i];
            if (live.Contains(binding.Symbol) || binding.Published || binding.Backend == Backend.Circuit)
            {
                live.Add(binding.Symbol);
                live.UnionWith(BoundTree.References(binding.Value));
            }
        }
        return live;
    }

    private sealed record Selection(NativeGraph Graph, Dictionary<Variable, int[]> Native, List<Binding> Script);
    private sealed record Placement(IReadOnlyList<Tile> Tiles, string Explanation, Dictionary<Variable, int> TapLatencies, long Area)
    {
        public bool IsSmallerThan(Placement other) => (Area, Tiles.Count).CompareTo((other.Area, other.Tiles.Count)) < 0;
    }
    private readonly record struct TapTiming(int Latency, int ExtraRows);

    private Selection SelectBackends(Binding[] live, bool factor)
    {
        var graph = new NativeGraph(factor);
        Dictionary<Variable, int[]> native = [];
        List<Binding> script = [];
        foreach (var binding in live)
        {
            var requiresCircuit = RequiresCircuit(binding.Value);
            if (binding.Backend == Backend.Script || scriptOnly.Contains(binding.Symbol))
            {
                if (requiresCircuit)
                    throw new NativeException($"'{binding.Symbol.Name}' requires a native circuit because it invokes a circuit-only function.");
                script.Add(binding);
                continue;
            }
            try
            {
                var evaluator = new NativeEvaluator(graph, reference => native.TryGetValue(reference, out var bits) ? bits : graph.Input(reference));
                native.Add(binding.Symbol, evaluator.Lower(binding.Value));
            }
            catch (NativeException error) when (binding.Backend == Backend.Auto && !requiresCircuit)
            {
                fallback[binding.Symbol] = error.Message;
                script.Add(binding);
            }
            catch (NativeException error)
            {
                throw new NativeException($"'{binding.Symbol.Name}' requires a native circuit. {error.Message}");
            }
        }
        return new Selection(graph, native, script);
    }

    private bool RequiresCircuit(BoundExpression expression) =>
        BoundTree.Calls(expression).Any(function => function.RequiresCircuit) ||
        BoundTree.Dispatches(expression).Any(call => program.Methods.Values
            .SelectMany(implementations => implementations.Values)
            .Any(function => IsCircuitDispatchTarget(function, call)));

    private static bool IsCircuitDispatchTarget(Function function, BoundDispatch dispatch) =>
        function.RequiresCircuit && dispatch.Receiver.Type.Shape.Methods.TryGetValue(dispatch.Method, out var signature) &&
        function.Name == dispatch.Method && function.Result == signature.Result &&
        function.Parameters.Select(parameter => parameter.Type).SequenceEqual(signature.Parameters);

    private Placement PlaceBestGraph(Selection selection, Binding[] live, HashSet<Variable> tickReads)
    {
        if (!selection.Graph.AppliedFactoring)
            return PlaceSmallest(selection, live, tickReads);

        // A factored expression can add a gate if its original terms are
        // still used elsewhere. Compare the full physical layouts.
        Placement? factored = null;
        Exception? failure = null;
        try
        {
            factored = PlaceSmallest(selection, live, tickReads);
        }
        catch (Exception error) when (error is RoutingException or MapLayoutException)
        {
            failure = error;
        }

        try
        {
            var unfactored = SelectBackends(live, factor: false);
            if (selection.Script.SequenceEqual(unfactored.Script))
            {
                var candidate = PlaceSmallest(unfactored, live, tickReads);
                if (factored is null || (candidate.Tiles.Count, candidate.Area).CompareTo((factored.Tiles.Count, factored.Area)) < 0 &&
                    factored.TapLatencies.All(tap => candidate.TapLatencies.GetValueOrDefault(tap.Key) == tap.Value))
                    return candidate;
            }
        }
        catch (Exception error) when (error is NativeException or RoutingException or MapLayoutException)
        {
            // The factored graph may fit the Level where the larger graph cannot.
        }

        return factored ?? throw failure ?? new RoutingException("No valid native layout was found.");
    }

    private Placement PlaceSmallest(Selection selection, Binding[] live, HashSet<Variable> tickReads)
    {
        try
        {
            return PlaceSmallest(selection, live, tickReads, orderGatesByDepth: false, separateComponents: false);
        }
        catch (Exception error) when (selection.Native.Count > 0 && error is RoutingException or MapLayoutException)
        {
            try
            {
                return PlaceSmallest(selection, live, tickReads, orderGatesByDepth: false, separateComponents: true);
            }
            catch (Exception retry) when (retry is RoutingException or MapLayoutException)
            {
                // The initial error retains the sink for automatic backend recovery.
            }
            throw;
        }
    }

    private Placement PlaceSmallest(Selection selection, Binding[] live, HashSet<Variable> tickReads,
        bool orderGatesByDepth, bool separateComponents)
    {
        HashSet<Variable> reads = [with(tickReads)];
        foreach (var binding in selection.Script)
            reads.UnionWith(BoundTree.References(binding.Value));

        if (selection.Native.Count == 0)
            return Place(selection, live, reads, RoutingGeometry.Standard, null, allowAdjacentOutputs: false, out _);

        // Treat the standard layout's script sample times as constraints for
        // every candidate. Shorter geometry can put the delay on a shared tap leg.
        var reference = reads.Any(selection.Native.ContainsKey)
            ? Place(selection, live, reads, RoutingGeometry.Standard with { SeparateComponents = separateComponents },
                null, allowAdjacentOutputs: false, out _)
            : null;
        var best = reference;
        Exception? failure = null;
        RoutingGeometry[] geometries = [RoutingGeometry.Tight, RoutingGeometry.Dense, RoutingGeometry.Compact, RoutingGeometry.Standard];
        foreach (var preset in geometries)
        {
            var geometry = preset with { OrderGatesByDepth = orderGatesByDepth, SeparateComponents = separateComponents };
            try
            {
                Placement? candidate = PlaceWithAdjacentOutputs(selection, live, reads, geometry, null);
                if (reference is not null && reference.TapLatencies.Any(tap => candidate.TapLatencies[tap.Key] != tap.Value))
                    candidate = PlaceWithTapTiming(selection, live, reads, geometry, reference, candidate);
                if (candidate is not null && (best is null || candidate.IsSmallerThan(best)))
                    best = candidate;
            }
            catch (Exception error) when (error is RoutingException or MapLayoutException)
            {
                failure = error;
            }
        }
        if (best is not null)
            return best;
        // A different topological order can leave room to delay both inputs
        // at a join. Preserve the original scheduling for script-sampled wires.
        if (reference is null && !orderGatesByDepth)
            return PlaceSmallest(selection, live, tickReads, orderGatesByDepth: true, separateComponents);
        throw failure ?? new RoutingException("No valid native layout was found.");
    }

    private Placement? PlaceWithTapTiming(Selection selection, Binding[] live, HashSet<Variable> reads,
        RoutingGeometry geometry, Placement reference, Placement candidate)
    {
        Placement? best = null;
        // Try extra space on the shared leg so the scheduler can shorten both
        // arms of a join while keeping its downstream script sample time fixed.
        ReadOnlySpan<int> paddingRows = [0, 16, 32];
        foreach (var extraRows in paddingRows)
        {
            var timing = reference.TapLatencies.ToDictionary(pair => pair.Key, pair => new TapTiming(pair.Value,
                Math.Max(0, pair.Value - candidate.TapLatencies[pair.Key]) + Math.Min(extraRows, pair.Value / 4)));
            try
            {
                var placement = PlaceWithAdjacentOutputs(selection, live, reads, geometry, timing);
                if (best is null || placement.IsSmallerThan(best))
                    best = placement;
            }
            catch (Exception error) when (error is RoutingException or MapLayoutException)
            {
                // This candidate cannot route every tap at the required time.
            }
        }
        return best;
    }

    private Placement PlaceWithAdjacentOutputs(Selection selection, Binding[] live,
        HashSet<Variable> reads, RoutingGeometry geometry, Dictionary<Variable, TapTiming>? timing)
    {
        var placedAdjacentOutput = false;
        try
        {
            return Place(selection, live, reads, geometry, timing, allowAdjacentOutputs: true, out placedAdjacentOutput);
        }
        catch (Exception error) when (placedAdjacentOutput && error is RoutingException or MapLayoutException)
        {
            return Place(selection, live, reads, geometry, timing, allowAdjacentOutputs: false, out _);
        }
    }

    private Placement Place(Selection selection, Binding[] live, HashSet<Variable> reads, RoutingGeometry geometry,
        Dictionary<Variable, TapTiming>? timing, bool allowAdjacentOutputs, out bool placedAdjacentOutput, bool groupKeys = true)
    {
        placedAdjacentOutput = false;
        var (graph, native, script) = selection;
        var nativeOutputs = program.Ports.Where(port => port.Symbol.Kind == SymbolKind.Output && native.ContainsKey(port.Symbol))
            .Select(port => port.Symbol).ToHashSet();
        Variable[] taps = [.. reads.Where(native.ContainsKey).OrderBy(variable => variable.Id)];
        int[] roots = [.. nativeOutputs.Concat(taps).SelectMany(variable => native[variable])];
        var gates = graph.Keep(roots, out var sourceIds);
        if (geometry.OrderGatesByDepth)
            gates = NativeRouter.OrderByDepth(gates);

        var layout = new Layout();
        foreach (var tile in program.ManualTiles)
            layout.Add(tile);
        var pixels = CreateScreenTiles(program.Screen);
        foreach (var pixel in pixels)
            layout.Add(pixel);

        Port[] inputs = [.. program.Ports.Where(port => port.Symbol.Kind == SymbolKind.Input)];
        Port[] outputs = [.. program.Ports.Where(port => port.Symbol.Kind == SymbolKind.Output)];
        var positions = PlaceFixedPorts(layout, inputs, outputs);
        HashSet<int> rails = [with(inputs.Where(port => port.Anchor.HasValue).SelectMany(port => positions[port.Symbol]).Select(position => position.Y))];
        foreach (var port in inputs.Where(port => port.Anchor is null))
        {
            var anchor = Layout.Find(0, 0, position => CanPlaceInput(layout, rails, position, port.Symbol.Type.Width), geometry.InputPitch);
            PlaceInput(layout, positions, port, anchor);
            rails.UnionWith(positions[port.Symbol].Select(position => position.Y));
        }

        var exports = script.Where(binding => binding.Symbol.Kind == SymbolKind.Output).Select(binding => binding.Symbol)
            .Concat(graph.Inputs.Where(pair => sourceIds.Contains(pair.Value) && pair.Key.Symbol.Kind != SymbolKind.Input).Select(pair => pair.Key.Symbol))
            .Distinct().OrderBy(variable => variable.Id).ToArray();
        var exportIndices = exports.Select((symbol, index) => (symbol, index)).ToDictionary(entry => entry.symbol, entry => entry.index);
        List<ScriptEmitter.OutputLane> directDrivers = [];

        Dictionary<int, Tile> driven = [];
        foreach (var ((symbol, lane), id) in graph.Inputs)
        {
            if (!sourceIds.Contains(id))
                continue;
            if (symbol.Kind == SymbolKind.Input)
            {
                driven.Add(id, layout[positions[symbol][lane]]);
            }
            else
            {
                var position = Layout.Find(0, 0, point => !rails.Contains(point.Y) && layout.IsFree(point) &&
                    layout.IsFree(point + new Position(1, 0)));
                rails.Add(position.Y);
                var tile = Driver(symbol, exportIndices[symbol], lane, position, Right);
                layout.Add(tile);
                driven.Add(id, tile);
            }
        }
        if (sourceIds.Contains(NativeGraph.High))
        {
            Position[] powerFootprint = [new(0, 0), new(1, 0), new(-1, 0), new(0, 1), new(0, -1)];
            var position = Layout.Find(0, 0, point => !rails.Contains(point.Y) &&
                Array.TrueForAll(powerFootprint, offset => layout.IsFree(point + offset)));
            var tile = new Tile(position, Power);
            layout.Add(tile);
            driven.Add(NativeGraph.High, tile);
        }

        var outputOrigin = NativeRouter.RecommendedOutputOrigin(gates, driven.Values, geometry);
        var nativeBottom = outputOrigin.Y;
        var railColumn = outputOrigin.X;
        List<OutputPin> nativePins = [];
        var samples = inputs.Select(port => port.Symbol).Where(reads.Contains)
            .ToDictionary(symbol => symbol, symbol => positions[symbol]);
        var adjacentOutputs = allowAdjacentOutputs ? NativeRouter.AdjacentOutputs(gates, driven, geometry) : [];
        var uses = allowAdjacentOutputs
            ? roots.Concat(gates.SelectMany(gate => gate.Inputs)).CountBy(signal => signal).ToDictionary()
            : [];
        var fixedReceivers = Array.Exists(outputs, port => !native.ContainsKey(port.Symbol) && port.Anchor is null)
            ? layout.Tiles.SelectMany(TileCatalog.Destinations).ToHashSet()
            : [];
        foreach (var port in outputs)
        {
            var symbol = port.Symbol;
            var circuit = native.TryGetValue(symbol, out var signals);
            var pitch = port.OutputPitch ?? RailSpacing;
            if (!positions.TryGetValue(symbol, out var lamps))
            {
                var column = circuit ? railColumn : -16;
                var row = circuit ? nativeBottom : 0;
                Position anchor;
                if (signals is [int signal] && uses.GetValueOrDefault(signal) == 1 &&
                    adjacentOutputs.TryGetValue(signal, out var adjacent) && layout.IsFree(adjacent))
                {
                    anchor = adjacent;
                    placedAdjacentOutput = true;
                }
                else
                {
                    anchor = Layout.Find(column, row, point =>
                    {
                        var bus = Bus(point, symbol.Type.Width, pitch);
                        return Array.TrueForAll(bus, layout.IsFree) &&
                            (circuit || Array.TrueForAll(bus, lamp => !fixedReceivers.Contains(lamp) &&
                                layout.IsFree(lamp + new Position(-1, 0)) && !fixedReceivers.Contains(lamp + new Position(-1, 0))));
                    },
                        pitch: circuit ? RailSpacing : 1);
                }
                lamps = PlaceOutput(layout, positions, symbol, anchor, style: port.LampStyle, pitch: pitch);
                if (circuit)
                    railColumn += (lamps.Length - 1) * pitch + geometry.OutputGap;
            }
            for (var lane = 0; lane < lamps.Length; lane++)
            {
                if (signals is not null)
                {
                    if (signals[lane] != NativeGraph.Low)
                        nativePins.Add(new OutputPin(signals[lane], lamps[lane], lamps.Length > 1 ? symbol.Id : null));
                }
                else
                {
                    var (position, rotation) = FindLampDriver(layout, lamps[lane]);
                    var index = exportIndices[symbol];
                    layout.Add(Driver(symbol, index, lane, position, rotation));
                    if (program.Screen is { IsSliced: true })
                        directDrivers.Add(new(position, index, lane, symbol.Type.Shape.Kind == TypeKind.Bits));
                }
            }
        }
        foreach (var tap in taps)
        {
            var tapTiming = timing?.GetValueOrDefault(tap);
            var row = nativeBottom + (tapTiming?.ExtraRows ?? 0);
            var anchor = Layout.Find(railColumn, row, point => Array.TrueForAll(Bus(point, tap.Type.Width), layout.IsFree));
            var endpoints = PlaceOutput(layout, positions, tap, anchor);
            samples.Add(tap, endpoints);
            railColumn += (endpoints.Length - 1) * RailSpacing + geometry.OutputGap;
            for (var lane = 0; lane < endpoints.Length; lane++)
            {
                if (native[tap][lane] != NativeGraph.Low)
                    nativePins.Add(new OutputPin(native[tap][lane], endpoints[lane], endpoints.Length > 1 ? tap.Id : null,
                        PreserveLatency: true, RequiredLatency: tapTiming?.Latency));
            }
        }

        RouteResult route;
        try
        {
            route = geometry.SeparateComponents
                ? NativeRouter.RouteComponents(gates, driven, nativePins, layout.Tiles, geometry)
                : NativeRouter.Route(gates, driven, nativePins, layout.Tiles, geometry);
        }
        catch (RoutingException error) when (error.OutputSink is { } sink)
        {
            var binding = nativeOutputs.Concat(taps).FirstOrDefault(symbol => positions[symbol].Contains(sink));
            if (binding is null)
                throw;
            throw new MapLayoutException($"Cannot route native circuit. {error.Message}", retryBackend: true, nativeBinding: binding);
        }
        foreach (var tile in route.Tiles)
            layout.Add(tile);
        var scalarTaps = nativePins.Where(pin => pin is { PreserveLatency: true, TimingGroup: null }).Select(pin => pin.Position);
        var packedTaps = layout.PackTaps(route.Tiles, scalarTaps, manualPositions);
        if (packedTaps.Count > 0)
        {
            foreach (var tap in taps.Where(tap => tap.Type.Width == 1))
            {
                var endpoint = positions[tap];
                endpoint[0] = packedTaps.GetValueOrDefault(endpoint[0], endpoint[0]);
            }
            route = route with
            {
                OutputLatency = route.OutputLatency.ToDictionary(port => packedTaps.GetValueOrDefault(port.Key, port.Key), port => port.Value)
            };
        }
        var screenCells = pixels.Select(pixel => pixel.Position).ToHashSet();
        layout.CheckManualInteractions(program.ManualTiles, screenCells, [.. driven.Values.Select(tile => tile.Position)]);
        CheckKeyboardGroupRouting(layout, inputs, positions, driven.Values);
        if (screenCells.Count > 0 && layout.Tiles.Any(tile => !screenCells.Contains(tile.Position) &&
            TileCatalog.Destinations(tile).Any(screenCells.Contains)))
            throw new RoutingException("Physical wiring intersects the screen.");

        IReadOnlyList<ScriptEmitter.BufferedKeyGroup> groups = [];
        Tile[] tiles;
        try
        {
            if (script.Count > 0 || program.Tick is not null || program.HostTick is not null || exports.Length > 0)
            {
                if (groupKeys && program.Screen is { IsSliced: true })
                    groups = PlaceBufferedKeyGroups(layout, samples);
                PlaceController(layout, script, samples, exports, groups);
            }
            var replacements = BatchOutputDrivers(layout, directDrivers);
            tiles = [.. layout.Tiles.Select(tile => replacements.GetValueOrDefault(tile.Position, tile))
                .OrderBy(tile => tile.Position.Y).ThenBy(tile => tile.Position.X)];
            if (MapCodec.LevelLimitError(tiles) is { } limitError)
                throw new MapLayoutException(limitError, retryBackend: true);
        }
        catch (MapLayoutException) when (groups.Count > 0)
        {
            // Leave the payload capacity to the level and assets before adding optional gates.
            return Place(selection, live, reads, geometry, timing, allowAdjacentOutputs, out placedAdjacentOutput, groupKeys: false);
        }

        var report = Explain(live, selection, positions, route, taps, exports, gates.Length, layout.Tiles.Count);
        var tapLatencies = taps.ToDictionary(tap => tap, tap => positions[tap].Max(route.OutputLatency.GetValueOrDefault));
        return new Placement(tiles, report, tapLatencies, layout.Bounds(manualPositions).Area);
    }

    private void PlaceController(Layout layout, IReadOnlyList<Binding> script, IReadOnlyDictionary<Variable, Position[]> samples,
        Variable[] exports, IReadOnlyList<ScriptEmitter.BufferedKeyGroup> groups)
    {
        var position = layout.FindController(manualPositions);
        var emitter = new ScriptEmitter(program);
        var source = emitter.EmitController(script, samples, exports, groups);
        if (Encoding.UTF8.GetByteCount(source) > ushort.MaxValue)
        {
            emitter = new ScriptEmitter(program, splitTables: true);
            source = emitter.EmitController(script, samples, exports, groups);
        }
        var scripts = Encoding.UTF8.GetByteCount(source) <= ushort.MaxValue
            ? [source]
            : ScriptEmitter.SplitController(source, emitter.UsesMouse);
        using var available = layout.DataTilePositions(position).GetEnumerator();
        layout.Add(new Tile(position, ScriptBlock, Payload: Payload(scripts[0])));
        foreach (var scriptTile in scripts.Skip(1).Concat(emitter.EmitDataTiles()))
        {
            if (!available.MoveNext())
                throw new MapLayoutException("The generated script tiles do not fit in the map layout.");
            layout.Add(new Tile(available.Current, ScriptBlock, Payload: Payload(scriptTile)));
        }
    }

    private List<ScriptEmitter.BufferedKeyGroup> PlaceBufferedKeyGroups(Layout layout, IReadOnlyDictionary<Variable, Position[]> samples)
    {
        var keys = program.Ports.Where(port => port.Buffer && port.Key.HasValue && samples.ContainsKey(port.Symbol))
            .OrderBy(port => port.Symbol.Id).ToArray();
        var derivedKeys = program.Ports.Where(port => port.Buffer && port.Keys is { GateReads: false } &&
            samples.ContainsKey(port.Symbol)).ToArray();
        List<ScriptEmitter.BufferedKeyGroup> groups = [];

        // A source other than the physical key can drive the original sampler.
        // Leave that port on the direct path even when all four keys are idle.
        var receivers = layout.Tiles.SelectMany(TileCatalog.Destinations).CountBy(position => position).ToDictionary();
        keys = [.. keys.Where(port => receivers.GetValueOrDefault(samples[port.Symbol][0]) == 1 &&
            !receivers.ContainsKey(samples[port.Symbol][0] + new Position(-1, 0)))];
        HashSet<Variable> assigned = [];
        foreach (var port in program.Ports.Where(port => port.Keys is { GateReads: true } &&
            samples.ContainsKey(port.Symbol)))
        {
            var keyIds = port.Keys!.KeyIds;
            // Both kinds of fixed key group receive the same host key pulses.
            // An OR over all of a group's keys is high whenever its OR or XOR
            // can fire. Keep the guard groups themselves on the direct path.
            Variable[] members = [.. keys.Where(key => keyIds.Contains(key.Key!.Value) && !assigned.Contains(key.Symbol))
                .Select(key => key.Symbol),
                .. derivedKeys.Where(key => !assigned.Contains(key.Symbol) && key.Keys!.KeyIds.All(keyIds.Contains))
                    .Select(key => key.Symbol)];
            if (members.Length == 0)
                continue;
            assigned.UnionWith(members);
            groups.Add(new(samples[port.Symbol][0], members, port.Symbol));
        }

        keys = [.. keys.Where(key => !assigned.Contains(key.Symbol))];
        if (keys.Length < 4)
            return groups;

        var left = keys.Min(port => samples[port.Symbol][0].X);
        var bottom = keys.Max(port => samples[port.Symbol][0].Y);
        var nextKey = 0;
        // Five-cell pitch leaves each cross and the blue arrow's exit isolated.
        for (var candidate = 0; candidate < 1024 && nextKey + 4 <= keys.Length; candidate++)
        {
            var hub = new Position(left + candidate % 8 * 5, bottom + 3 + candidate / 8 * 5);
            var exit = hub + new Position(2, 0);
            if (!Clear(hub) || !Clear(exit) || KeyNeighbors.Any(neighbor => !Clear(hub + neighbor.Offset)))
                continue;
            layout.Add(new Tile(hub, BlueArrow, Right));
            foreach (var (offset, facing) in KeyNeighbors)
                layout.Add(new Tile(hub + offset, Key, facing, Extra: keys[nextKey++].Key!.Value));
            groups.Add(new(hub, [.. keys[(nextKey - 4)..nextKey].Select(port => port.Symbol)]));
        }
        return groups;

        bool Clear(Position position) => layout.IsFree(position) && !receivers.ContainsKey(position);
    }

    private static Dictionary<Position, Tile> BatchOutputDrivers(Layout layout, List<ScriptEmitter.OutputLane> drivers)
    {
        Dictionary<Position, Tile> replacements = [];
        if (drivers.Count < 2)
            return replacements;

        // A native arrow also responds to incoming signals. Only replace drivers
        // with no physical inputs, and keep every lamp's original one-hop route.
        var receivingCells = layout.Tiles.SelectMany(TileCatalog.Destinations).ToHashSet();
        foreach (var batch in drivers.Where(driver => !receivingCells.Contains(driver.Position)).Chunk(DriverBatchSize))
        {
            if (batch.Length < 2)
                continue;
            var first = batch[0].Position;
            replacements.Add(first, layout[first] with { Payload = Payload(ScriptEmitter.EmitDriverBatch(batch)) });
            foreach (var driver in batch.AsSpan(1))
            {
                var tile = layout[driver.Position];
                replacements.Add(tile.Position, new Tile(tile.Position, Arrow, tile.Rotation));
            }
        }
        return replacements;
    }

    private static Tile[] CreateScreenTiles(Screen? screen)
    {
        if (screen is null)
            return [];
        if (screen.ArrowDisplay)
            return CreateArrowDisplay(screen);
        if (screen.RgbLamps)
            return CreateRgbLampDisplay(screen);
        var pixels = new Tile[screen.TileWidth * screen.TileHeight];
        for (var y = 0; y < screen.TileHeight; y++)
        {
            for (var x = 0; x < screen.TileWidth; x++)
            {
                var position = screen.Background.Position + new Position(x, y);
                pixels[y * screen.TileWidth + x] = screen.Background with { Position = position };
            }
        }
        return pixels;
    }

    private static Tile[] CreateRgbLampDisplay(Screen screen)
    {
        var pixels = new Tile[screen.TileWidth * screen.TileHeight];
        var origin = screen.Background.Position;
        for (var row = 0; row < screen.Height; row++)
        {
            for (var column = 0; column < screen.Width; column++)
            {
                var left = column * screen.Scale;
                var top = row * screen.Scale;
                var cell = origin + new Position(left, top);
                var center = new Position(1, 1);
                pixels[(top + 1) * screen.TileWidth + left + 1] = screen.Background with { Position = cell + center };
                foreach (var pair in Screen.LampPairs)
                {
                    PlaceLamp(pair.First, pair.Facing, pair.Signal);
                    PlaceLamp(pair.Second, pair.Opposite, pair.Signal);
                }

                void PlaceLamp(Position offset, byte facing, ushort signal)
                {
                    var index = (top + offset.Y) * screen.TileWidth + left + offset.X;
                    pixels[index] = new Tile(cell + offset, Screen.ForwardingLampType, facing, Extra: signal);
                }
            }
        }
        return pixels;
    }

    private static Tile[] CreateArrowDisplay(Screen screen)
    {
        var origin = screen.Background.Position;
        TileColor[] colors = [TileColor.Red, TileColor.Blue, TileColor.Green, TileColor.Yellow];
        var pixels = new Tile[screen.TileWidth * screen.TileHeight];
        for (var y = 0; y < screen.TileHeight; y++)
        {
            for (var x = 0; x < screen.TileWidth; x++)
            {
                var position = origin + new Position(x, y);
                var color = (ushort)colors[x % screen.Scale];
                pixels[y * screen.TileWidth + x] = (y % screen.Scale) switch
                {
                    0 => new Tile(position, Arrow, Down),
                    1 => new Tile(position, Toggle, Down),
                    2 => new Tile(position, ForwardingLamp, Down, Extra: color),
                    _ => new Tile(position, Lamp, Extra: color)
                };
            }
        }
        return pixels;
    }

    private Dictionary<Variable, Position[]> PlaceFixedPorts(Layout layout, Port[] inputs, Port[] outputs)
    {
        Dictionary<Variable, Position[]> positions = [];
        foreach (var port in inputs.Where(port => port.Anchor.HasValue))
        {
            var anchor = port.Anchor!.Value;
            if (port.Tap)
            {
                var lanes = new Position[port.Symbol.Type.Width];
                for (var lane = 0; lane < lanes.Length; lane++)
                {
                    var position = anchor + new Position(0, lane * (port.TapPitch ?? RailSpacing));
                    if (!manualPositions.Contains(position))
                        throw new MapLayoutException($"Input tap '{port.Symbol.Name}' requires a placed tile at ({position.X}, {position.Y}).");
                    lanes[lane] = position;
                }
                positions.Add(port.Symbol, lanes);
            }
            else if (port.Keys is { } keys)
            {
                // Same key-to-gate depth as an ordinary key sampler.
                for (var i = 0; i < keys.KeyIds.Length; i++)
                {
                    var (offset, facing) = KeyNeighbors[i];
                    layout.Add(new Tile(anchor + offset, Key, facing, Extra: keys.KeyIds[i]));
                }
                layout.Add(new Tile(anchor, keys.Exclusive ? Xor : BlueArrow, Right));
                positions.Add(port.Symbol, [anchor]);
            }
            else
                PlaceInput(layout, positions, port, anchor);
        }
        foreach (var port in outputs.Where(port => port.Anchor.HasValue))
            PlaceOutput(layout, positions, port.Symbol, port.Anchor!.Value, port.Forward, port.LampStyle,
                port.OutputPitch ?? RailSpacing);
        return positions;
    }

    private static void CheckKeyboardGroupRouting(Layout layout, Port[] inputs, Dictionary<Variable, Position[]> positions,
        IEnumerable<Tile> routedSources)
    {
        var groups = inputs.Where(port => port.Keys is not null).ToArray();
        if (groups.Length == 0)
            return;

        var arrivals = layout.Tiles.SelectMany(TileCatalog.Destinations).CountBy(position => position).ToDictionary();
        var routed = routedSources.Select(tile => tile.Position).ToHashSet();
        foreach (var port in groups)
        {
            var hub = positions[port.Symbol][0];
            if (arrivals.GetValueOrDefault(hub) != port.Keys!.KeyIds.Length)
                throw new RoutingException($"Keyboard group '{port.Symbol.Name}' has an unintended input at ({hub.X}, {hub.Y}).");
            var exit = TileCatalog.Destinations(layout[hub]).Single();
            if (!routed.Contains(hub) && exit.FitsMap && !layout.IsFree(exit))
                throw new RoutingException($"Keyboard group '{port.Symbol.Name}' has an unintended output at ({exit.X}, {exit.Y}).");
        }
    }

    private static bool CanPlaceInput(Layout layout, HashSet<int> rails, Position anchor, int width) =>
        Enumerable.Range(0, width).Select(index => anchor + new Position(0, index * RailSpacing))
            .All(position => !rails.Contains(position.Y) && layout.IsFree(position) &&
                layout.IsFree(position + new Position(1, 0)) && layout.IsFree(position + new Position(2, 0)));

    private static void PlaceInput(Layout layout, Dictionary<Variable, Position[]> positions, Port port, Position anchor)
    {
        var symbol = port.Symbol;
        var lanes = new Position[symbol.Type.Width];
        for (var lane = 0; lane < lanes.Length; lane++)
        {
            var button = anchor + new Position(0, lane * RailSpacing);
            lanes[lane] = button + new Position(1, 0);
            layout.Add(port.Key is ushort key ? new Tile(button, Key, Right, Extra: key) : new Tile(button, Button, Right));
            layout.Add(new Tile(lanes[lane], port.Key.HasValue ? Arrow : Toggle, Right));
        }
        positions.Add(symbol, lanes);
    }

    private static Position[] Bus(Position anchor, int width, int pitch = RailSpacing) =>
        [.. Enumerable.Range(0, width).Select(lane => anchor + new Position(lane * pitch, 0))];

    private static Position[] PlaceOutput(Layout layout, Dictionary<Variable, Position[]> positions, Variable symbol, Position anchor,
        byte? forward = null, ushort? style = null, int pitch = RailSpacing)
    {
        var lanes = Bus(anchor, symbol.Type.Width, pitch);
        foreach (var position in lanes)
            layout.Add(new Tile(position, forward.HasValue ? ForwardingLamp : Lamp, forward.GetValueOrDefault(), Extra: style ?? 0x14));
        positions.Add(symbol, lanes);
        return lanes;
    }

    private static (Position, byte) FindLampDriver(Layout layout, Position lamp)
    {
        (Position Offset, byte Rotation)[] candidates = [(new(-1, 0), 1), (new(0, 1), 0), (new(1, 0), 3), (new(0, -1), 2)];
        var destinations = TileCatalog.Destinations(layout[lamp]);
        foreach (var (offset, rotation) in candidates)
        {
            var position = lamp + offset;
            if (layout.IsFree(position) && !destinations.Contains(position))
                return (position, rotation);
        }
        throw new MapLayoutException($"No free cell beside output lamp ({lamp.X}, {lamp.Y}) for its scripted Source.");
    }

    private static Tile Driver(Variable symbol, int index, int lane, Position position, byte rotation) =>
        new(position, ScriptSource, rotation, Payload: Payload(ScriptEmitter.EmitDriver(index, lane, symbol.Type.Shape.Kind == TypeKind.Bits)));

    private static byte[] Payload(string script)
    {
        var bytes = Encoding.UTF8.GetBytes(script);
        if (bytes.Length > ushort.MaxValue)
            throw new MapLayoutException("Generated JavaScript exceeds the 65,535-byte per-tile script limit.");
        return bytes;
    }

    private string Explain(Binding[] bindings, Selection selection, Dictionary<Variable, Position[]> positions, RouteResult route,
        Variable[] taps, Variable[] exports, int gates, int tiles)
    {
        var inputGates = program.Ports.Count(port => port.Keys is not null);
        var report = new StringBuilder().AppendLine($"{program.Name} ({gates + inputGates} native gates, {tiles} tiles)");
        foreach (var binding in bindings)
        {
            var symbol = binding.Symbol;
            var circuit = selection.Native.ContainsKey(symbol);
            report.Append(symbol.Name).Append("  ").Append(circuit ? "circuit" : "script");
            if (!circuit && fallback.TryGetValue(symbol, out var why) && binding.Backend == Backend.Auto)
                report.Append("  (").Append(why).Append(')');
            if (positions.TryGetValue(symbol, out var lamps))
            {
                var latency = lamps.Select(position => route.OutputLatency.GetValueOrDefault(position)).Max();
                report.Append($"  at ({lamps[0].X}, {lamps[0].Y})");
                report.Append(circuit ? $"  {latency} route ticks" : "  previous-tick script frame + one lamp hop");
            }
            report.AppendLine();
        }
        foreach (var port in program.Ports.Where(port => port.Symbol.Kind == SymbolKind.Input))
        {
            var pin = positions[port.Symbol][0];
            if (port.Keys is { } keys)
            {
                var gate = keys.Exclusive ? "XOR" : "OR";
                var names = string.Join(", ", keys.KeyIds.Select(TileCatalog.KeyboardKeyName));
                report.AppendLine($"input {port.Symbol.Name}  native {gate} of keys {names} at ({pin.X}, {pin.Y})");
                continue;
            }
            if (port.Tap)
            {
                report.AppendLine($"input {port.Symbol.Name}  physical tap at ({pin.X}, {pin.Y})");
                continue;
            }
            var input = port.Key is ushort key ? $"key {TileCatalog.KeyboardKeyName(key)}" : "button";
            report.AppendLine($"input {port.Symbol.Name}  {input} at ({pin.X - 1}, {pin.Y})");
        }
        if (taps.Length > 0)
            report.AppendLine($"Circuit to script samples: {string.Join(", ", taps.Select(tap => tap.Name))}.");
        if (exports.Length > 0)
            report.AppendLine($"Script to Source frames (one tick): {string.Join(", ", exports.Select(symbol => symbol.Name))}.");
        return report.ToString();
    }

    private sealed class Layout
    {
        private readonly Dictionary<Position, Tile> occupied = [];
        private readonly List<Tile> tiles = [];
        public IReadOnlyList<Tile> Tiles => tiles;
        public Tile this[Position position] => occupied[position];

        public bool IsFree(Position position) => position.FitsMap && !occupied.ContainsKey(position);

        public void Add(Tile tile)
        {
            if (!tile.Position.FitsMap)
                throw new MapLayoutException($"Tile coordinate ({tile.Position.X}, {tile.Position.Y}) is outside the v5 map range.");
            if (!occupied.TryAdd(tile.Position, tile))
                throw new MapLayoutException($"Tiles overlap at ({tile.Position.X}, {tile.Position.Y}).");
            tiles.Add(tile);
        }

        public static Position Find(int x, int y, Func<Position, bool> available, int pitch = RailSpacing)
        {
            if (Position.CoordinateFitsMap(x))
            {
                var skipped = Math.Max(0, (Position.MinimumCoordinate - (long)y + pitch - 1) / pitch);
                for (var row = y + skipped * pitch; row <= Position.MaximumCoordinate; row += pitch)
                {
                    var position = new Position(x, (int)row);
                    if (available(position))
                        return position;
                }
            }
            throw new MapLayoutException($"Could not find a free placement at column {x} from row {y} within the v5 coordinate range.");
        }

        public Dictionary<Position, Position> PackTaps(IReadOnlyList<Tile> routed, IEnumerable<Position> scalarTaps,
            IReadOnlySet<Position> manualPositions)
        {
            var packed = NativeRouter.PackTapWires(occupied, routed, scalarTaps, manualPositions);
            if (packed.Count > 0)
            {
                tiles.Clear();
                tiles.AddRange(occupied.Values);
            }
            return packed;
        }

        public TileBounds Bounds(IReadOnlySet<Position> manualPositions) =>
            TileBounds.Measure(occupied.Keys.Where(position => !manualPositions.Contains(position)));

        public Position FindController(IReadOnlySet<Position> manualPositions)
        {
            var bounds = Bounds(manualPositions);
            var receivingCells = tiles.SelectMany(TileCatalog.Destinations).ToHashSet();
            bool IsQuiet(Position position) => IsFree(position) && !receivingCells.Contains(position);

            for (var y = bounds.Top; y <= Math.Min(bounds.Bottom, bounds.Top + 8); y++)
            {
                for (var x = bounds.Left; x <= Math.Min(bounds.Right, bounds.Left + 8); x++)
                {
                    var position = new Position(x, y);
                    if (IsQuiet(position))
                        return position;
                }
            }

            if (bounds.Area > 0)
            {
                Position[] edges = [new(bounds.Left - 1, bounds.Top), new(bounds.Right + 1, bounds.Top),
                    new(bounds.Left, bounds.Top - 1), new(bounds.Left, bounds.Bottom + 1)];
                var edge = edges.Where(IsQuiet).OrderBy(position => bounds.Include(position).Area)
                    .Select(position => (Position?)position).FirstOrDefault();
                if (edge is { } available)
                    return available;
            }

            var left = occupied.Keys.Select(position => position.X).DefaultIfEmpty(0).Min();
            var start = left >= Position.MinimumCoordinate + 8 ? left - 8 : 0;
            return Find(start, -8, IsQuiet);
        }

        public IEnumerable<Position> DataTilePositions(Position controller)
        {
            var receivingCells = tiles.SelectMany(TileCatalog.Destinations).ToHashSet();
            var maximumRadius = Math.Max(Math.Max(controller.X, controller.Y) - Position.MinimumCoordinate,
                Position.MaximumCoordinate - Math.Min(controller.X, controller.Y));
            for (var radius = 1; radius <= maximumRadius; radius++)
            {
                for (var x = -radius; x <= radius; x++)
                {
                    var top = controller + new Position(x, -radius);
                    if (IsFree(top) && !receivingCells.Contains(top)) yield return top;
                    var bottom = controller + new Position(x, radius);
                    if (IsFree(bottom) && !receivingCells.Contains(bottom)) yield return bottom;
                }
                for (var y = -radius + 1; y < radius; y++)
                {
                    var left = controller + new Position(-radius, y);
                    if (IsFree(left) && !receivingCells.Contains(left)) yield return left;
                    var right = controller + new Position(radius, y);
                    if (IsFree(right) && !receivingCells.Contains(right)) yield return right;
                }
            }
        }

        public void CheckManualInteractions(IReadOnlyList<Tile> manual, HashSet<Position> screenCells, HashSet<Position> routedInputs)
        {
            var fixedPositions = manual.Select(tile => tile.Position).ToHashSet();
            foreach (var tile in tiles)
            {
                var isManual = fixedPositions.Contains(tile.Position);
                // A forwarding port is the explicit outbound connection to a manual circuit.
                var isForwardingOutput = tile.Type == ForwardingLamp && !isManual && !screenCells.Contains(tile.Position);
                // The native router already checked every path from a declared tap.
                var isRoutedTap = isManual && routedInputs.Contains(tile.Position);
                var crossing = TileCatalog.Destinations(tile)
                    .Where(destination => occupied.ContainsKey(destination) && (isManual || isForwardingOutput) != fixedPositions.Contains(destination) &&
                        !(isRoutedTap && !screenCells.Contains(destination)))
                    .Select(destination => (Position?)destination).FirstOrDefault();
                if (crossing is { } target)
                {
                    if (isForwardingOutput)
                        throw new RoutingException($"Forwarding output ({tile.Position.X}, {tile.Position.Y}) points into generated circuitry at ({target.X}, {target.Y}).");
                    throw new RoutingException($"Manual tile intersects generated circuitry between ({tile.Position.X}, {tile.Position.Y}) and ({target.X}, {target.Y}).");
                }
            }
        }

    }
}

[SuppressMessage("Design", "S3871", Justification = "The public compiler entry points convert this exception to a diagnostic.")]
internal sealed class MapLayoutException(string message, bool retryBackend = false, Variable? nativeBinding = null) : Exception(message)
{
    public bool RetryBackend { get; } = retryBackend;
    public Variable? NativeBinding { get; } = nativeBinding;
}
