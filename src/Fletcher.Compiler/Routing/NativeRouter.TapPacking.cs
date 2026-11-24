using Fletcher.Compiler.Maps;

namespace Fletcher.Compiler.Routing;

internal static partial class NativeRouter
{
    private const int MinimumFold = 12;
    private static readonly Position[] Cardinal = [new(0, -1), new(1, 0), new(0, 1), new(-1, 0)];
    private static readonly int[] FoldWidths = [6, 9, 12, 16, 24, 32, 4];
    private static readonly int[] FoldStarts = [0, 4, 8, 12, 16, 24, 32, 48, 64];

    internal static Dictionary<Position, Position> PackTapWires(Dictionary<Position, Tile> occupied,
        IReadOnlyList<Tile> routed, IEnumerable<Position> scalarTaps, IReadOnlySet<Position> manualPositions)
    {
        Dictionary<Position, Position> relocations = [];
        Position[] taps = [.. scalarTaps];
        if (taps.Length == 0)
            return relocations;

        var relays = routed.Select(tile => tile.Position).ToHashSet();
        var incoming = IndexEmissions(occupied.Values);
        foreach (var tap in taps)
        {
            var tail = CollectTapTail(tap, occupied, relays, incoming);
            if (tail.Count < MinimumFold || FoldTapTail(tail, occupied, incoming, manualPositions) is not { } fold)
                continue;

            var lamp = occupied[tap];
            foreach (var old in tail.Skip(fold.Start))
            {
                occupied.Remove(old);
                relays.Remove(old);
            }
            for (var i = 0; i + 1 < fold.Path.Length; i++)
            {
                var cell = fold.Path[i];
                var next = fold.Path[i + 1];
                var rotation = (byte)Array.IndexOf(Cardinal, new Position(next.X - cell.X, next.Y - cell.Y));
                occupied.Add(cell, new Tile(Position: cell, Type: Arrow, Rotation: rotation));
                relays.Add(cell);
            }
            var end = fold.Path[^1];
            occupied.Add(end, lamp with { Position = end });
            relocations.Add(tap, end);
            incoming = IndexEmissions(occupied.Values);
        }
        return relocations;
    }

    private static Dictionary<Position, List<Position>> IndexEmissions(IEnumerable<Tile> tiles)
    {
        Dictionary<Position, List<Position>> incoming = [];
        foreach (var tile in tiles)
        {
            foreach (var target in TileCatalog.Destinations(tile))
            {
                if (!incoming.TryGetValue(target, out var sources))
                {
                    sources = [];
                    incoming.Add(target, sources);
                }
                sources.Add(tile.Position);
            }
        }
        return incoming;
    }

    private static List<Position> CollectTapTail(Position tap, IReadOnlyDictionary<Position, Tile> occupied,
        IReadOnlySet<Position> relays, IReadOnlyDictionary<Position, List<Position>> incoming)
    {
        // The replacement starts at the same receiving cell and keeps one
        // relay per tick. Leave branches, joins, and fixed tiles in place.
        List<Position> tail = [tap];
        while (incoming.GetValueOrDefault(tail[^1]) is [var source] && relays.Contains(source) &&
            occupied[source].Type is Arrow or BlueArrow or DiagonalArrow && incoming.GetValueOrDefault(source) is [_])
        {
            tail.Add(source);
        }
        tail.Reverse();
        return tail;
    }

    private sealed record TapFold(int Start, Position[] Path);

    private static TapFold? FoldTapTail(List<Position> tail, IReadOnlyDictionary<Position, Tile> occupied,
        IReadOnlyDictionary<Position, List<Position>> incoming, IReadOnlySet<Position> manualPositions)
    {
        var active = occupied.Keys.Where(position => !manualPositions.Contains(position)).ToArray();
        var bestArea = TileBounds.Measure(active).Area;
        var indices = tail.Index().ToDictionary(pair => pair.Item, pair => pair.Index);
        var core = TileBounds.Measure(active.Where(position => !indices.ContainsKey(position)));
        var scratch = new Position[tail.Count];
        TapFold? best = null;
        var kept = 0;
        ReadOnlySpan<bool> flips = [false, true];

        foreach (var start in FoldStarts)
        {
            var length = tail.Count - start;
            if (length < MinimumFold)
                break;
            while (kept < start)
                core = core.Include(tail[kept++]);
            if (core.Area >= bestArea)
                break;

            var origin = tail[start];
            foreach (var width in FoldWidths)
            {
                foreach (var direction in Cardinal)
                {
                    orientation: foreach (var flip in flips)
                    {
                        var across = direction.Y;
                        var down = -direction.X;
                        var rowStep = flip ? new Position(across, down) : new Position(-across, -down);
                        var bounds = core.Include(origin);
                        scratch[0] = origin;
                        for (var i = 1; i < length; i++)
                        {
                            var row = i / width;
                            var column = row % 2 == 0 ? i % width : width - 1 - i % width;
                            var cell = origin + new Position(column * direction.X + row * rowStep.X, column * direction.Y + row * rowStep.Y);
                            if (!cell.FitsMap || occupied.ContainsKey(cell) && !InRemovedSuffix(cell) ||
                                incoming.TryGetValue(cell, out var sources) && sources.Exists(source => !InRemovedSuffix(source)))
                                continue orientation;

                            bounds = bounds.Include(cell);
                            if (bounds.Area >= bestArea)
                                continue orientation;
                            scratch[i] = cell;
                        }
                        best = new TapFold(start, scratch[..length]);
                        bestArea = bounds.Area;
                        if (bestArea == core.Area)
                            return best;
                    }
                }
            }

            bool InRemovedSuffix(Position position) => indices.TryGetValue(position, out var index) && index >= start;
        }
        return best;
    }
}
