using Fletcher.Compiler.Maps;

namespace Fletcher.Compiler.Routing;

internal static partial class NativeRouter
{
    private static void ValidateTopology(
        IReadOnlyDictionary<Position, Tile> occupied,
        IReadOnlyDictionary<int, SignalSource> sources,
        IReadOnlyList<Consumer> consumers,
        IReadOnlyDictionary<Consumer, int> routeHops)
    {
        var producers = sources.Values.Select(source => source.Producer.Position).ToHashSet();
        foreach (IGrouping<int, Consumer> group in consumers.GroupBy(consumer => consumer.Signal))
        {
            SignalSource source = sources[group.Key];
            Dictionary<Position, List<int>> expected = group
                .GroupBy(consumer => consumer.Sink)
                .ToDictionary(
                    sinks => sinks.Key,
                    sinks => sinks.Select(consumer => routeHops[consumer]).Order().ToList());
            Dictionary<Position, List<int>> actual = WalkSignal(source, occupied, producers, expected.Keys);

            if (expected.Count != actual.Count || expected.Keys.Except(actual.Keys).Any())
            {
                throw new RoutingException($"Signal {source.Signal} reaches unexpected sinks or misses a required sink.");
            }

            foreach ((Position sink, List<int> expectedHops) in expected)
            {
                List<int> actualHops = actual[sink];
                actualHops.Sort();
                if (!expectedHops.SequenceEqual(actualHops))
                {
                    throw new RoutingException($"Signal {source.Signal} reaches {sink} with unexpected routing latency.");
                }
            }
        }
    }

    private static Dictionary<Position, List<int>> WalkSignal(
        SignalSource source,
        IReadOnlyDictionary<Position, Tile> occupied,
        IReadOnlySet<Position> producers,
        IEnumerable<Position> expectedSinks)
    {
        HashSet<Position> sinks = [.. expectedSinks];
        Dictionary<Position, List<int>> reached = [];
        HashSet<Position> visited = [];
        Queue<(Position Position, int Hops)> pending = [];
        foreach (var receiver in TileCatalog.Destinations(source.Producer).Where(occupied.ContainsKey))
            pending.Enqueue((receiver, 0));
        while (pending.TryDequeue(out var next))
        {
            var (position, hops) = next;
            if (sinks.Contains(position))
            {
                if (!reached.TryGetValue(position, out List<int>? arrivals))
                {
                    arrivals = [];
                    reached.Add(position, arrivals);
                }

                arrivals.Add(hops);
                continue;
            }

            if (!occupied.TryGetValue(position, out Tile? tile))
            {
                throw new RoutingException($"Signal {source.Signal} reaches empty cell {position}.");
            }

            if (producers.Contains(position) || tile.Type is not (Arrow or LSplitter or BlueArrow or DiagonalArrow or BlueLSplitter or Wall))
            {
                throw new RoutingException($"Signal {source.Signal} reaches unintended sink {position}.");
            }

            if (!visited.Add(position))
            {
                throw new RoutingException($"Signal {source.Signal} merges with itself or loops at {position}.");
            }

            foreach (Position destination in TileCatalog.Destinations(tile))
            {
                pending.Enqueue((destination, hops + 1));
            }
        }

        return reached;
    }
}
