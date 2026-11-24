using Fletcher.Compiler.Maps;

namespace Fletcher.Compiler.Routing;

internal enum GateKind
{
    And,
    Or,
    Xor,
    Not
}

internal sealed record Gate(int Id, GateKind Kind, int[] Inputs);

internal sealed record OutputPin(
    int Signal, Position Position, int? TimingGroup = null, bool PreserveLatency = false, int? RequiredLatency = null);

internal sealed record RouteResult(
    IReadOnlyList<Tile> Tiles,
    IReadOnlyDictionary<Position, int> OutputLatency);

internal sealed record RoutingGeometry(
    int InputPitch, int InputMarginX, int InputMarginY, int GateStepX, int GateStepY,
    int OutputMarginX, int OutputMarginY, int OutputGap)
{
    public static RoutingGeometry Tight { get; } = new(4, 4, 6, 5, 6, 4, 3, 4);
    public static RoutingGeometry Dense { get; } = new(4, 6, 8, 6, 8, 4, 3, 4);
    public static RoutingGeometry Compact { get; } = new(6, 8, 14, 8, 12, 8, 6, 6);
    public static RoutingGeometry Standard { get; } = new(8, 24, 16, 12, 16, 24, 8, 16);
}

/// <summary>
/// A deterministic rectilinear router for the arrow-only part of a Fletcher map.
/// Each produced signal gets a horizontal eastbound bus. Consumers branch downward
/// from that bus, which keeps simultaneous inputs separate until they reach a gate.
/// </summary>
internal static partial class NativeRouter
{
    private const byte Arrow = 1;
    private const byte Source = 2;
    private const byte LSplitter = 7;
    private const byte BlueArrow = 10;
    private const byte DiagonalArrow = 11;
    private const byte BlueLSplitter = 13;
    private const byte And = 16;
    private const byte Xor = 17;
    private const byte Not = 15;
    private const byte Wall = 25;

    private const byte Right = 1;
    private const byte Down = 2;
    private static readonly HashSet<int> NoShortcuts = [];

    internal static Position RecommendedOutputOrigin(IReadOnlyList<Gate> gates, IEnumerable<Tile> drivenTiles, RoutingGeometry geometry)
    {
        ArgumentNullException.ThrowIfNull(gates);
        ArgumentNullException.ThrowIfNull(drivenTiles);
        Tile[] drivers = [.. drivenTiles];
        Position origin = GateOrigin(drivers, geometry);
        return new Position(origin.X + gates.Count * geometry.GateStepX + geometry.OutputMarginX,
            origin.Y + gates.Count * geometry.GateStepY + geometry.OutputMarginY);
    }

    internal static Dictionary<int, Position> AdjacentOutputs(
        IReadOnlyList<Gate> gates, IReadOnlyDictionary<int, Tile> drivers, RoutingGeometry geometry)
    {
        var gatePositions = AllocateGatePositions(gates, drivers.Values, geometry);
        return CreateSources(gates, drivers, gatePositions).ToDictionary(pair => pair.Key, pair => pair.Value.Start);
    }

    public static RouteResult Route(
        IReadOnlyList<Gate> gates,
        IReadOnlyDictionary<int, Tile> drivenSignals,
        IReadOnlyList<OutputPin> outputs,
        IReadOnlyList<Tile> fixedTiles,
        RoutingGeometry geometry)
    {
        ArgumentNullException.ThrowIfNull(gates);
        ArgumentNullException.ThrowIfNull(drivenSignals);
        ArgumentNullException.ThrowIfNull(outputs);
        ArgumentNullException.ThrowIfNull(fixedTiles);

        HashSet<Position> fixedPositions = [.. fixedTiles.Select(tile => tile.Position)];
        Dictionary<Position, Tile> occupied = BuildOccupied(fixedTiles);
        ValidateGates(gates, drivenSignals);

        Dictionary<int, Position> gatePositions = AllocateGatePositions(gates, drivenSignals.Values, geometry);
        if (gatePositions.Values.Any(position => !position.FitsMap))
            throw new RoutingException("Native gate positions extend outside the v5 map coordinate range.");
        Dictionary<int, SignalSource> sources = CreateSources(gates, drivenSignals, gatePositions);
        List<Consumer> consumers = CreateConsumers(gates, outputs, gatePositions, sources);
        ValidateConsumerSources(consumers, sources);

        List<Bus> buses = BuildBuses(sources, consumers.Where(consumer => !consumer.Direct));
        ValidateBusSpacing(buses);
        TimingPlan timing = PlanTiming(gates, buses, drivenSignals.Keys);
        ReserveBuses(buses, occupied);

        Dictionary<Position, int> outputLatencies = [];
        Dictionary<Consumer, int> routeHops = [];

        foreach (Consumer consumer in consumers.Where(consumer => consumer.Direct))
        {
            routeHops.Add(consumer, 0);
            outputLatencies.Add(consumer.Sink, timing.SignalLatencies[consumer.Signal] + 1);
        }

        foreach (Gate gate in gates)
        {
            Position position = gatePositions[gate.Id];
            Place(position, new Tile(position, GateType(gate.Kind), Right), occupied);
        }

        foreach (Bus bus in buses)
        {
            int sourceLatency = timing.SignalLatencies[bus.Signal];
            foreach (Consumer consumer in bus.Consumers)
            {
                PathResult path = RouteConsumer(
                    bus,
                    consumer,
                    timing.Padding.GetValueOrDefault(consumer),
                    timing.ShorteningRows.GetValueOrDefault(consumer, NoShortcuts),
                    occupied);
                int arrivalLatency = sourceLatency + path.Hops;
                routeHops[consumer] = path.Hops;

                if (consumer.GateId is int targetGate)
                {
                    if (arrivalLatency + 1 != timing.SignalLatencies[targetGate])
                        throw new RoutingException($"Physical arrivals at gate {targetGate} differ from the timing plan.");
                }
                else
                {
                    outputLatencies[consumer.Sink] = arrivalLatency + 1;
                }
            }
        }

        var misalignedGroup = outputs.Where(pin => pin.Signal != -1 && pin.TimingGroup.HasValue)
            .GroupBy(pin => pin.TimingGroup)
            .FirstOrDefault(group => group.Select(pin => outputLatencies[pin.Position]).Distinct().Skip(1).Any());
        if (misalignedGroup is not null)
        {
            throw new RoutingException($"Physical arrivals in timing group {misalignedGroup.Key} do not align.");
        }
        ValidateTopology(occupied, sources, consumers, routeHops);

        return CompactRoutes(occupied, fixedPositions, sources, drivenSignals.Keys, buses, consumers, outputs, outputLatencies);
    }

    private static Dictionary<Position, Tile> BuildOccupied(IReadOnlyList<Tile> fixedTiles)
    {
        Dictionary<Position, Tile> occupied = [];
        foreach (Tile tile in fixedTiles)
        {
            if (occupied.TryAdd(tile.Position, tile))
            {
                continue;
            }
            throw new RoutingException($"Fixed tiles overlap at {tile.Position}.");
        }

        return occupied;
    }

    private static void ValidateGates(IReadOnlyList<Gate> gates, IReadOnlyDictionary<int, Tile> drivenSignals)
    {
        HashSet<int> known = [.. drivenSignals.Keys];
        foreach (Gate gate in gates)
        {
            if (!known.Add(gate.Id))
            {
                throw new RoutingException($"Signal {gate.Id} is produced more than once.");
            }

            int expectedInputs = gate.Kind is GateKind.Not ? 1 : 2;
            if (gate.Inputs.Length != expectedInputs)
            {
                throw new RoutingException($"{gate.Kind} gate {gate.Id} requires {expectedInputs} inputs.");
            }

            int missingInput = gate.Inputs.FirstOrDefault(input => input != -1 && !known.Contains(input), -1);
            if (missingInput != -1)
            {
                throw new RoutingException($"Gate {gate.Id} uses signal {missingInput} before it is produced.");
            }
        }
    }

    private static Dictionary<int, Position> AllocateGatePositions(
        IReadOnlyList<Gate> gates,
        IEnumerable<Tile> drivenTiles,
        RoutingGeometry geometry)
    {
        Tile[] drivers = [.. drivenTiles];
        Position origin = GateOrigin(drivers, geometry);
        Dictionary<int, Position> positions = [];
        for (int index = 0; index < gates.Count; index++)
        {
            positions.Add(gates[index].Id, new Position(origin.X + index * geometry.GateStepX, origin.Y + index * geometry.GateStepY));
        }

        return positions;
    }

    private static Position GateOrigin(IReadOnlyList<Tile> drivers, RoutingGeometry geometry)
    {
        int maximumX = drivers.Select(tile => tile.Position.X).DefaultIfEmpty(0).Max();
        int maximumY = drivers.Select(tile => tile.Position.Y).DefaultIfEmpty(0).Max();
        return new Position(Math.Max(geometry.InputMarginX, maximumX + geometry.InputMarginX), maximumY + geometry.InputMarginY);
    }

    private static Dictionary<int, SignalSource> CreateSources(
        IReadOnlyList<Gate> gates,
        IReadOnlyDictionary<int, Tile> drivenSignals,
        IReadOnlyDictionary<int, Position> gatePositions)
    {
        Dictionary<int, SignalSource> sources = [];
        foreach ((int signal, Tile tile) in drivenSignals)
        {
            Position firstReceiver = FirstReceiver(tile);
            sources.Add(signal, new SignalSource(signal, firstReceiver, tile));
        }

        foreach (Gate gate in gates)
        {
            Position position = gatePositions[gate.Id];
            var tile = new Tile(position, GateType(gate.Kind), Right);
            sources.Add(gate.Id, new SignalSource(gate.Id, FirstReceiver(tile), tile));
        }

        return sources;
    }

    private static Position FirstReceiver(Tile tile)
    {
        if (tile.Type != Source && tile.Rotation != Right)
        {
            throw new RoutingException($"Signal source at {tile.Position} must face right for native routing.");
        }

        return new Position(tile.Position.X + 1, tile.Position.Y);
    }

    private static List<Consumer> CreateConsumers(
        IReadOnlyList<Gate> gates,
        IReadOnlyList<OutputPin> outputs,
        IReadOnlyDictionary<int, Position> gatePositions,
        IReadOnlyDictionary<int, SignalSource> sources)
    {
        List<Consumer> consumers = [];
        foreach (Gate gate in gates)
        {
            Position gatePosition = gatePositions[gate.Id];
            for (int inputIndex = 0; inputIndex < gate.Inputs.Length; inputIndex++)
            {
                int signal = gate.Inputs[inputIndex];
                if (signal == -1)
                {
                    continue;
                }

                // Gate inputs arrive from north and west, avoiding a false double-arrival.
                Position branch = inputIndex == 0
                    ? new Position(gatePosition.X, gatePosition.Y - 1)
                    : new Position(gatePosition.X - 1, gatePosition.Y);
                consumers.Add(new Consumer(signal, branch, gatePosition, inputIndex == 0 ? Down : Right, gate.Id, null));
            }
        }

        consumers.AddRange(outputs.Where(output => output.Signal != -1).Select(output => new Consumer(
            output.Signal,
            new Position(output.Position.X, output.Position.Y - 1),
            output.Position,
            Down,
            null,
            output.TimingGroup,
            output is { TimingGroup: null, PreserveLatency: false } &&
                sources.TryGetValue(output.Signal, out var source) && output.Position == source.Start)));
        return consumers;
    }

    private static void ValidateConsumerSources(IEnumerable<Consumer> consumers, IReadOnlyDictionary<int, SignalSource> sources)
    {
        var missing = consumers.FirstOrDefault(consumer => !sources.ContainsKey(consumer.Signal));
        if (missing is not null)
        {
            throw new RoutingException($"No source exists for signal {missing.Signal}.");
        }
    }

    private static List<Bus> BuildBuses(IReadOnlyDictionary<int, SignalSource> sources, IEnumerable<Consumer> consumers)
    {
        List<Bus> buses = [];
        foreach (IGrouping<int, Consumer> group in consumers.GroupBy(consumer => consumer.Signal))
        {
            SignalSource source = sources[group.Key];
            List<Consumer> leaves = [.. group.OrderBy(consumer => consumer.Target.X)];
            if (leaves.Exists(consumer => consumer.Target.X < source.Start.X || consumer.Target.Y <= source.Start.Y))
            {
                throw new RoutingException($"Signal {source.Signal} cannot reach one of its consumers with the downward bus layout.");
            }

            if (leaves.Select(consumer => consumer.Target).Distinct().Count() != leaves.Count)
            {
                throw new RoutingException($"Signal {source.Signal} has overlapping consumer routes.");
            }

            buses.Add(new Bus(source.Signal, source.Start, leaves));
        }

        return [.. buses.OrderBy(bus => bus.Start.Y).ThenBy(bus => bus.Signal)];
    }

    private static void ValidateBusSpacing(IReadOnlyList<Bus> buses)
    {
        for (int index = 1; index < buses.Count; index++)
        {
            if (buses[index].Start.Y - buses[index - 1].Start.Y < 2)
            {
                throw new RoutingException("Native input buses must have one clear row between them.");
            }
        }
    }

    private static void ReserveBuses(IEnumerable<Bus> buses, IDictionary<Position, Tile> occupied)
    {
        foreach (Bus bus in buses)
        {
            int endX = bus.Consumers.Max(consumer => consumer.Target.X);
            Position terminator = new(endX + 1, bus.Start.Y);
            if (!bus.Start.FitsMap || !terminator.FitsMap)
                throw new RoutingException($"Signal bus {bus.Signal} extends outside the v5 map coordinate range.");
            for (int x = bus.Start.X; x <= endX; x++)
            {
                Position position = new(x, bus.Start.Y);
                if (occupied.ContainsKey(position))
                {
                    throw new RoutingException($"Signal bus {bus.Signal} collides at {position}.");
                }

                occupied.Add(position, new Tile(position, Arrow, Right));
            }

            if (occupied.ContainsKey(terminator))
            {
                throw new RoutingException($"Signal bus {bus.Signal} cannot terminate at {terminator}.");
            }

            occupied.Add(terminator, new Tile(terminator, Wall));
        }
    }

    private static PathResult RouteConsumer(
        Bus bus,
        Consumer consumer,
        int padding,
        IReadOnlySet<int> shorteningRows,
        IDictionary<Position, Tile> occupied)
    {
        Position splitterPosition = new(consumer.Target.X, bus.Start.Y);
        ReplaceReserved(splitterPosition, new Tile(splitterPosition, LSplitter, Right), occupied);

        int hops = consumer.Target.X - bus.Start.X + 1;
        int y = bus.Start.Y + 1;
        while (y <= consumer.Target.Y)
        {
            Position position = new(consumer.Target.X, y);
            if (shorteningRows.Contains(y))
            {
                ReplaceReservedOrEmpty(position, new Tile(position, BlueArrow, Down), occupied);
                y += 2;
                hops++;
                continue;
            }

            int meanderDirection = padding >= 2
                ? FindMeanderDirection(consumer.Target.X, y, consumer.Target.Y, occupied)
                : 0;
            if (meanderDirection != 0)
            {
                Position side = new(consumer.Target.X + meanderDirection, y);
                Position lowerSide = new(consumer.Target.X + meanderDirection, y + 1);
                byte outward = meanderDirection > 0 ? Right : (byte)3;
                byte inward = meanderDirection > 0 ? (byte)3 : Right;
                Place(position, new Tile(position, Arrow, outward), occupied);
                Place(side, new Tile(side, Arrow, Down), occupied);
                Place(lowerSide, new Tile(lowerSide, Arrow, inward), occupied);
                padding -= 2;
                y++;
                hops += 3;
                continue;
            }

            if (IsCrossingBarrier(position, occupied))
            {
                Position bluePosition = new(consumer.Target.X, y - 1);
                ReplacePriorArrowWithBlue(bluePosition, occupied);
                y++;
                continue;
            }

            byte rotation = y == consumer.Target.Y ? consumer.FinalRotation : Down;
            Place(position, new Tile(position, Arrow, rotation), occupied);
            y++;
            hops++;
        }

        if (padding != 0)
        {
            throw new RoutingException($"Route to {consumer.Target} lacks clear cells for phase padding.");
        }

        return new PathResult(hops);
    }

    private static int FindMeanderDirection(int x, int y, int targetY, IDictionary<Position, Tile> occupied)
    {
        if (CanMeander(x, y, targetY, 1, occupied)) return 1;
        if (CanMeander(x, y, targetY, -1, occupied)) return -1;
        return 0;
    }

    private static bool CanMeander(int x, int y, int targetY, int direction, IDictionary<Position, Tile> occupied) =>
        y < targetY &&
        !occupied.ContainsKey(new Position(x, y)) &&
        !occupied.ContainsKey(new Position(x + direction, y)) &&
        !occupied.ContainsKey(new Position(x + direction, y + 1));

    private static bool IsReservedBus(Position position, IDictionary<Position, Tile> occupied) =>
        occupied.TryGetValue(position, out Tile? tile) &&
        tile.Rotation == Right &&
        tile.Type is Arrow or LSplitter;

    private static bool IsCrossingBarrier(Position position, IDictionary<Position, Tile> occupied) =>
        IsReservedBus(position, occupied) ||
        occupied.TryGetValue(position, out Tile? tile) && tile.Type == Wall;

    private static void ReplaceReserved(Position position, Tile tile, IDictionary<Position, Tile> occupied)
    {
        if (!IsReservedBus(position, occupied))
        {
            throw new RoutingException($"Expected a reserved signal bus at {position}.");
        }

        occupied[position] = tile;
    }

    private static void ReplaceReservedOrEmpty(Position position, Tile tile, IDictionary<Position, Tile> occupied)
    {
        if (occupied.TryGetValue(position, out Tile? existing) && !IsReservedBus(position, occupied))
        {
            throw new RoutingException($"Route crosses a component at {position} (type {existing.Type}).");
        }

        occupied[position] = tile;
    }

    private static void ReplacePriorArrowWithBlue(Position position, IDictionary<Position, Tile> occupied)
    {
        if (!occupied.TryGetValue(position, out Tile? prior) || prior.Type != Arrow || prior.Rotation != Down)
        {
            throw new RoutingException($"Route cannot cross a bus at {position}.");
        }

        Tile blue = new(position, BlueArrow, Down);
        occupied[position] = blue;
    }

    private static void Place(Position position, Tile tile, IDictionary<Position, Tile> occupied)
    {
        if (!position.FitsMap)
            throw new RoutingException($"Route tile at {position} is outside the v5 map coordinate range.");
        if (occupied.ContainsKey(position))
        {
            throw new RoutingException($"Route collides at {position}.");
        }

        occupied.Add(position, tile);
    }

    private static byte GateType(GateKind kind) => kind switch
    {
        GateKind.And => And,
        GateKind.Or => Arrow,
        GateKind.Xor => Xor,
        GateKind.Not => Not,
        _ => throw new ArgumentOutOfRangeException(nameof(kind))
    };

    private sealed record SignalSource(int Signal, Position Start, Tile Producer);

    private sealed record Consumer(int Signal, Position Target, Position Sink, byte FinalRotation, int? GateId, int? TimingGroup, bool Direct = false);

    private sealed record Bus(int Signal, Position Start, IReadOnlyList<Consumer> Consumers);

    private sealed record TimingPlan(
        IReadOnlyDictionary<int, int> SignalLatencies,
        IReadOnlyDictionary<Consumer, int> Padding,
        IReadOnlyDictionary<Consumer, IReadOnlySet<int>> ShorteningRows);

    private readonly record struct PathResult(int Hops);
}

public sealed class RoutingException(string message) : Exception(message);
