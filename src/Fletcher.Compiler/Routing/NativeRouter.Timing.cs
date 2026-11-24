using System.Collections.Frozen;
using Fletcher.Compiler.Maps;

namespace Fletcher.Compiler.Routing;

internal static partial class NativeRouter
{
    private static TimingPlan PlanTiming(
        IReadOnlyList<Gate> gates,
        IReadOnlyList<Bus> buses,
        IEnumerable<int> drivenSignals)
    {
        Dictionary<int, int> latencies = drivenSignals.ToDictionary(signal => signal, _ => 0);
        Dictionary<Consumer, int> padding = [];
        Dictionary<Consumer, IReadOnlySet<int>> shortenings = [];
        Dictionary<int, Bus> busBySignal = buses.ToDictionary(bus => bus.Signal);

        foreach (int gateId in gates.Select(gate => gate.Id))
        {
            List<Consumer> inputs = [.. buses.SelectMany(bus => bus.Consumers)
                .Where(consumer => consumer.GateId == gateId)];
            List<(Consumer Consumer, int Arrival, IReadOnlySet<int> ShorteningRows)> arrivals = [];
            foreach (Consumer input in inputs)
            {
                Bus bus = busBySignal[input.Signal];
                IReadOnlySet<int> rows = FindShorteningRows(bus, input, buses, input.FinalRotation == Right ? 1 : 0);
                if (input.FinalRotation == Right && rows.Count == 0)
                {
                    throw new RoutingException($"Gate {gateId} does not have room to synchronize its west input.");
                }

                int baseHops = CountBaseHops(bus, input, buses, rows.Count);
                arrivals.Add((input, latencies[input.Signal] + baseHops, rows));
            }

            if (arrivals.Count == 0)
            {
                latencies[gateId] = 1;
                continue;
            }

            if (arrivals.Count == 2 && (arrivals[0].Arrival - arrivals[1].Arrival) % 2 != 0)
            {
                int longerIndex = arrivals[0].Arrival > arrivals[1].Arrival ? 0 : 1;
                (Consumer consumer, int arrival, IReadOnlySet<int> rows) = arrivals[longerIndex];
                Bus bus = busBySignal[consumer.Signal];
                IReadOnlySet<int> shortenedRows = FindShorteningRows(bus, consumer, buses, rows.Count + 1);
                if (shortenedRows.Count <= rows.Count)
                {
                    throw new RoutingException($"Gate {gateId} has no physical hop available to balance its input phase.");
                }

                arrivals[longerIndex] = (consumer, arrival - 1, shortenedRows);
            }

            int targetArrival = arrivals.Max(arrival => arrival.Arrival);
            foreach ((Consumer consumer, int arrival, IReadOnlySet<int> rows) in arrivals)
            {
                int neededPadding = targetArrival - arrival;
                if (neededPadding % 2 != 0)
                {
                    throw new RoutingException($"Gate {gateId} cannot balance its input phase.");
                }

                padding[consumer] = neededPadding;
                shortenings[consumer] = rows;
            }

            latencies[gateId] = targetArrival + 1;
        }

        foreach (IGrouping<int?, Consumer> group in buses.SelectMany(bus => bus.Consumers)
            .Where(consumer => consumer.GateId is null)
            .GroupBy(consumer => consumer.TimingGroup))
        {
            List<Consumer> outputs = [.. group];
            if (group.Key is null)
            {
                foreach (Consumer output in outputs)
                {
                    padding[output] = 0;
                    shortenings[output] = FrozenSet<int>.Empty;
                }

                continue;
            }

            (int TargetArrival, Dictionary<Consumer, IReadOnlySet<int>> Rows)? best = null;
            tryParity: for (var parity = 0; parity < 2; parity++)
            {
                Dictionary<Consumer, IReadOnlySet<int>> rows = [];
                foreach (Consumer output in outputs)
                {
                    Bus bus = busBySignal[output.Signal];
                    int rawArrival = latencies[output.Signal] + CountBaseHops(bus, output, buses, 0);
                    int requiredShortening = rawArrival % 2 == parity ? 0 : 1;
                    IReadOnlySet<int> outputRows = FindShorteningRows(bus, output, buses, requiredShortening);
                    if (outputRows.Count != requiredShortening)
                    {
                        continue tryParity;
                    }

                    rows.Add(output, outputRows);
                }

                int target = outputs.Max(output =>
                {
                    Bus bus = busBySignal[output.Signal];
                    return latencies[output.Signal] + CountBaseHops(bus, output, buses, rows[output].Count);
                });
                if (best is null || target < best.Value.TargetArrival)
                {
                    best = (target, rows);
                }
            }

            if (best is null)
            {
                throw new RoutingException($"Timing group {group.Key} cannot be phase-aligned.");
            }

            foreach (Consumer output in outputs)
            {
                Bus bus = busBySignal[output.Signal];
                int arrival = latencies[output.Signal] + CountBaseHops(bus, output, buses, best.Value.Rows[output].Count);
                padding[output] = best.Value.TargetArrival - arrival;
                shortenings[output] = best.Value.Rows[output];
            }
        }

        return new TimingPlan(latencies, padding, shortenings);
    }

    private static int CountBaseHops(Bus bus, Consumer consumer, IReadOnlyList<Bus> buses, int shorteningCount)
    {
        int crossings = buses.Count(other =>
            other.Signal != bus.Signal &&
            other.Start.Y > bus.Start.Y &&
            other.Start.Y <= consumer.Target.Y &&
            consumer.Target.X >= other.Start.X &&
            consumer.Target.X <= other.Consumers.Max(otherConsumer => otherConsumer.Target.X) + 1);
        return consumer.Target.X - bus.Start.X + 1 + (consumer.Target.Y - bus.Start.Y) - crossings - shorteningCount;
    }

    private static IReadOnlySet<int> FindShorteningRows(Bus bus, Consumer consumer, IReadOnlyList<Bus> buses, int required)
    {
        HashSet<int> rows = [];
        var y = consumer.Target.Y - 2;
        while (y > bus.Start.Y + 1 && rows.Count < required)
        {
            var nextY = y - 1;
            if (!HasBarrierAt(consumer.Target.X, y, buses) && !HasBarrierAt(consumer.Target.X, y + 1, buses))
            {
                rows.Add(y);
                nextY--;
            }
            y = nextY;
        }

        return rows;
    }

    private static bool HasBarrierAt(int x, int y, IEnumerable<Bus> buses) => buses.Any(bus =>
        bus.Start.Y == y &&
        x >= bus.Start.X &&
        x <= bus.Consumers.Max(consumer => consumer.Target.X) + 1);
}
