namespace Fletcher.Compiler.Maps;

public readonly record struct Position(int X, int Y)
{
    internal const int MinimumCoordinate = -524_272;
    internal const int MaximumCoordinate = 524_287;
    internal bool FitsMap => CoordinateFitsMap(X) && CoordinateFitsMap(Y);
    internal static bool CoordinateFitsMap(long value) => value is >= MinimumCoordinate and <= MaximumCoordinate;
    public static Position operator +(Position left, Position right) => new(left.X + right.X, left.Y + right.Y);
}

public sealed record Tile(
    Position Position,
    byte Type,
    byte Rotation = 0,
    bool Flip = false,
    ushort Extra = 0,
    byte[]? Payload = null);
