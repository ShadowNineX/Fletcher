using Fletcher.Compiler.Maps;

namespace Fletcher.Compiler.Routing;

internal static partial class NativeRouter
{
    private readonly record struct Shortcut(Tile Replacement, Position Skipped);
    private sealed record WireSegment(int From, int To, int Hops, List<Shortcut> Shortcuts);
    private readonly record struct TimingBound(int Node, int Offset);

    private static RouteResult CompactRoutes(
        Dictionary<Position, Tile> baseline,
        HashSet<Position> fixedPositions,
        Dictionary<int, SignalSource> sources,
        IEnumerable<int> drivers,
        List<Bus> buses,
        List<Consumer> consumers,
        IReadOnlyList<OutputPin> outputs,
        Dictionary<Position, int> originalLatencies)
    {
        if (originalLatencies.Count == 0)
            return Result(baseline, originalLatencies);

        Dictionary<Position, Tile> occupied = [with(baseline)];
        var incoming = CountIncoming(occupied);
        foreach (var bus in buses)
        {
            var last = new Position(bus.Consumers.Max(consumer => consumer.Target.X), bus.Start.Y);
            var wall = last + new Position(1, 0);
            if (incoming.GetValueOrDefault(wall) == 1 && occupied[last] is { Type: LSplitter, Rotation: Right, Flip: false })
            {
                // The final branch has no continuing bus. Point a plain arrow
                // down and remove the wall that formerly absorbed its east output.
                occupied[last] = new Tile(last, Arrow, Down);
                occupied.Remove(wall);
            }
        }

        var pins = outputs.Where(pin => pin.Signal != -1).ToDictionary(pin => pin.Position);
        var nodes = sources.Values.Select(source => source.Producer.Position)
            .Concat(pins.Keys)
            .Concat(occupied.Values.Where(tile => tile.Type == LSplitter && !fixedPositions.Contains(tile.Position)).Select(tile => tile.Position))
            .Distinct().OrderBy(position => position.Y).ThenBy(position => position.X).ToArray();
        Dictionary<Position, int> nodeIds = [];
        Dictionary<int, int> groupIds = [];
        var nextId = 1; // Time zero is a distinct node for input clocks and fixed tap times.
        foreach (var position in nodes)
        {
            if (pins.TryGetValue(position, out var pin) && pin.TimingGroup is int group)
            {
                if (!groupIds.TryGetValue(group, out var id))
                {
                    id = nextId;
                    nextId++;
                    groupIds.Add(group, id);
                }
                nodeIds.Add(position, id);
            }
            else
            {
                nodeIds.Add(position, nextId++);
            }
        }

        if (CollectSegments(occupied, fixedPositions, incoming, nodeIds) is not { } segments)
            return Result(baseline, originalLatencies);

        var tapAnchors = pins.Values.Where(pin => pin.PreserveLatency)
            .Select(pin => (Node: nodeIds[pin.Position], Time: pin.RequiredLatency ?? originalLatencies[pin.Position])).ToArray();
        var anchors = drivers.Select(signal => (nodeIds[sources[signal].Producer.Position], 0)).Concat(tapAnchors);
        var maxTime = Math.Max(originalLatencies.Values.Max(), tapAnchors.Select(anchor => anchor.Time).DefaultIfEmpty().Max());
        if (ScheduleSegments(segments, nextId, anchors, maxTime) is not { } times)
            return Result(baseline, originalLatencies);

        foreach (var segment in segments)
        {
            var saved = segment.Hops - (times[segment.To] - times[segment.From]);
            foreach (var (replacement, skipped) in segment.Shortcuts.Take(saved))
            {
                occupied[replacement.Position] = replacement;
                occupied.Remove(skipped);
            }
        }

        int Time(Position position) => times[nodeIds[position]];
        var routeHops = consumers.ToDictionary(consumer => consumer,
            consumer => Time(consumer.Sink) - Time(sources[consumer.Signal].Producer.Position) - 1);
        try
        {
            ValidateTopology(occupied, sources, consumers, routeHops);
            return Result(occupied, pins.Keys.ToDictionary(position => position, Time));
        }
        catch (RoutingException)
        {
            return Result(baseline, originalLatencies);
        }

        RouteResult Result(Dictionary<Position, Tile> tiles, Dictionary<Position, int> latencies)
        {
            foreach (var pin in outputs)
            {
                if (pin.RequiredLatency is int required && latencies.GetValueOrDefault(pin.Position) != required)
                    throw new RoutingException($"Route to tap at {pin.Position} cannot preserve its {required}-tick delay.");
            }
            return new RouteResult([.. tiles.Values.Where(tile => !fixedPositions.Contains(tile.Position))], latencies);
        }
    }

    private static Dictionary<Position, int> CountIncoming(IReadOnlyDictionary<Position, Tile> occupied)
    {
        Dictionary<Position, int> incoming = [];
        foreach (var destination in occupied.Values.SelectMany(TileCatalog.Destinations).Where(occupied.ContainsKey))
        {
            incoming[destination] = incoming.GetValueOrDefault(destination) + 1;
        }
        return incoming;
    }

    private static List<WireSegment>? CollectSegments(
        IReadOnlyDictionary<Position, Tile> occupied,
        HashSet<Position> fixedPositions,
        Dictionary<Position, int> incoming,
        Dictionary<Position, int> nodes)
    {
        List<WireSegment> segments = [];
        HashSet<Position> visited = [];

        foreach (var (origin, from) in nodes)
        foreach (var first in TileCatalog.Destinations(occupied[origin]))
        {
            if (!occupied.TryGetValue(first, out var tile) || tile.Type == Wall)
                continue;

            List<Tile> path = [];
            var position = first;
            while (!nodes.ContainsKey(position))
            {
                if (!occupied.TryGetValue(position, out var wire) || wire.Type is not (Arrow or BlueArrow) ||
                    fixedPositions.Contains(position) || incoming.GetValueOrDefault(position) != 1 || !visited.Add(position))
                    return null;

                path.Add(wire);
                position = TileCatalog.Destinations(wire).Single();
            }

            List<Shortcut> shortcuts = [];
            var start = 0;
            var originTile = occupied[origin];
            if (!fixedPositions.Contains(origin) && originTile.Type == LSplitter &&
                path is [{ Type: Arrow } head, ..] && head.Rotation == originTile.Rotation &&
                TileCatalog.Destinations(originTile).First() == head.Position)
            {
                shortcuts.Add(new Shortcut(originTile with { Type = BlueLSplitter }, head.Position));
                start = 1;
            }

            var i = start;
            while (i + 1 < path.Count)
            {
                var firstArrow = path[i];
                var secondArrow = path[i + 1];
                if (firstArrow.Type != Arrow || secondArrow.Type != Arrow)
                {
                    i++;
                    continue;
                }

                var turn = (secondArrow.Rotation - firstArrow.Rotation + 4) % 4;
                if (turn == 2)
                {
                    i++;
                    continue;
                }

                var replacement = turn == 0
                    ? firstArrow with { Type = BlueArrow }
                    : firstArrow with { Type = DiagonalArrow, Flip = turn == 3 };
                shortcuts.Add(new Shortcut(replacement, secondArrow.Position));
                i += 2;
            }
            segments.Add(new WireSegment(from, nodes[position], path.Count + 1, shortcuts));
        }

        return segments;
    }

    private static int[]? ScheduleSegments(List<WireSegment> segments, int nodeCount, IEnumerable<(int Node, int Time)> anchors, int maxTime)
    {
        List<TimingBound>[] bounds = [.. Enumerable.Range(0, nodeCount).Select(static List<TimingBound> (_) => [])];
        var cost = new int[nodeCount];
        foreach (var segment in segments)
        {
            // Keep every segment in its realizable delay interval. A shorter
            // delay removes one relay tile per hop saved.
            bounds[segment.From].Add(new TimingBound(segment.To, segment.Hops - segment.Shortcuts.Count));
            bounds[segment.To].Add(new TimingBound(segment.From, -segment.Hops));
            cost[segment.From]--;
            cost[segment.To]++;
        }
        foreach (var (node, time) in anchors)
        {
            bounds[0].Add(new TimingBound(node, time));
            bounds[node].Add(new TimingBound(0, -time));
        }

        var times = new int[nodeCount];
        Queue<int> work = [with(Enumerable.Range(0, nodeCount))];
        var queued = Enumerable.Repeat(true, nodeCount).ToArray();
        var budget = Math.Max(1024, 32L * bounds.Sum(list => list.Count));
        while (work.TryDequeue(out var from))
        {
            queued[from] = false;
            foreach (var bound in bounds[from])
            {
                if (--budget < 0)
                    return null;
                var time = times[from] + bound.Offset;
                if (time <= times[bound.Node])
                    continue;
                if (bound.Node == 0 || time > maxTime)
                    return null;

                times[bound.Node] = time;
                if (!queued[bound.Node])
                {
                    work.Enqueue(bound.Node);
                    queued[bound.Node] = true;
                }
            }
        }

        // At a fanout, delaying the shared prefix can save a relay on each
        // branch. Move it only within the established timing bounds.
        var fanouts = Enumerable.Range(1, nodeCount - 1).Where(node => cost[node] < 0).OrderBy(node => cost[node]).ToArray();
        for (var pass = 0; pass < 4; pass++)
        {
            var changed = false;
            foreach (var node in fanouts)
            {
                var latest = bounds[node].Min(bound => times[bound.Node] - bound.Offset);
                if (latest > times[node])
                {
                    times[node] = latest;
                    changed = true;
                }
            }
            if (!changed)
                break;
        }

        return times;
    }
}
