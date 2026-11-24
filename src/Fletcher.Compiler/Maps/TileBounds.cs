namespace Fletcher.Compiler.Maps;

internal readonly record struct TileBounds(int Left, int Top, int Right, int Bottom)
{
    public static TileBounds Empty => new(int.MaxValue, int.MaxValue, int.MinValue, int.MinValue);

    public long Area => Left > Right ? 0 : ((long)Right - Left + 1) * ((long)Bottom - Top + 1);

    public TileBounds Include(Position position) => new(
        Math.Min(Left, position.X), Math.Min(Top, position.Y), Math.Max(Right, position.X), Math.Max(Bottom, position.Y));

    public static TileBounds Measure(IEnumerable<Position> positions) => positions.Aggregate(Empty, (bounds, position) => bounds.Include(position));
}
