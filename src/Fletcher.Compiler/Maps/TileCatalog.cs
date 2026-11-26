using System.Collections.Frozen;
using System.Text;

namespace Fletcher.Compiler.Maps;

internal enum TileColor { White, Red, Blue, Yellow, Green, Orange, Purple, Black }

/// <summary>Named constructors and static routing geometry for the playable Level palette.</summary>
public static class TileCatalog
{
    // The Level key IDs are one-based, with digits following the letters.
    internal const string KeyboardKeys = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    private static readonly string[] ExtendedKeyboardKeys =
    [
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
        "Space", "Enter", "Tab", "Shift", "Ctrl", "Alt", "Backspace",
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"
    ];

    internal static int KeyboardKeyId(string name)
    {
        if (name.Length == 1)
            return KeyboardKeys.IndexOf(char.ToUpperInvariant(name[0]));
        var index = Array.FindIndex(ExtendedKeyboardKeys, key => key.Equals(name, StringComparison.OrdinalIgnoreCase));
        return index < 0 ? -1 : KeyboardKeys.Length + index;
    }

    internal static string KeyboardKeyName(ushort id) => id < KeyboardKeys.Length
        ? KeyboardKeys[id].ToString() : ExtendedKeyboardKeys[id - KeyboardKeys.Length];

    private static readonly string[] Colors = Enum.GetNames<TileColor>();

    private static readonly FrozenDictionary<string, byte> Types =
    [
        with(StringComparer.OrdinalIgnoreCase),
        new("arrow", 1), new("source", 2), new("blocker", 3), new("delay", 4), new("detector", 5),
        new("i-splitter", 6), new("iSplitter", 6), new("l-splitter", 7), new("lSplitter", 7),
        new("t-splitter", 8), new("tSplitter", 8), new("pulse", 9), new("pulseGenerator", 9),
        new("blue-arrow", 10), new("blueArrow", 10), new("diagonal", 11), new("diagonalArrow", 11),
        new("blue-i-splitter", 12), new("blueISplitter", 12), new("blue-l-splitter", 13), new("blueLSplitter", 13),
        new("diagonal-splitter", 14), new("diagonalSplitter", 14), new("not", 15), new("and", 16), new("xor", 17),
        new("latch", 18), new("toggle", 19), new("tFlipFlop", 19), new("randomizer", 20), new("key", 21),
        new("script-source", 22), new("scriptSource", 22), new("target", 23), new("button", 24),
        new("directionalButton", 24), new("wall", 25), new("light", 27), new("lamp", 27), new("lightBulb", 27),
        new("forwarding-light", 28), new("forwardingLight", 28), new("forwardingLamp", 28), new("music", 29),
        new("musicArrow", 29), new("transmitter", 30), new("script", 33), new("scriptBlock", 33),
        new("message", 34), new("logger", 42), new("interval", 43)
    ];

    public static Tile Create(string kind, Position position, byte rotation, bool flip, IReadOnlyDictionary<string, object> options)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(kind);
        ArgumentNullException.ThrowIfNull(options);
        if (!Types.TryGetValue(kind, out byte type)) throw new ArgumentException($"Unknown Logic Arrows component '{kind}'.", nameof(kind));
        if (rotation > 3) throw new ArgumentException("Rotation must be between 0 and 3.", nameof(rotation));
        if (!SupportsFlip(type) && flip) throw new ArgumentException($"{kind} cannot be flipped.", nameof(flip));

        ushort extra = 0;
        byte[]? payload = null;
        switch (type)
        {
            case 21: extra = checked((ushort)OptionInt(options, "key", 0, 0, 59)); break;
            case 25: extra = checked((ushort)(Color(options, 7) | (Glyph(options) << 4))); break;
            case 27 or 28: extra = checked((ushort)(Color(options, 6) | (OptionBool(options, "bright", false) ? 16 : 0))); break;
            case 29: extra = checked((ushort)(OptionInt(options, "note", 0, 0, 11) | (OptionInt(options, "octave", 4, 0, 15) << 4) | (OptionInt(options, "instrument", 0, 0, 255) << 8))); break;
            case 22 or 23 or 33: payload = Encoding.UTF8.GetBytes(OptionString(options, "code", string.Empty)); break;
            case 34: payload = [0x4c, 0x47, 0x53, 0x31, 0x01, .. Encoding.UTF8.GetBytes(OptionString(options, "text", string.Empty))]; break;
        }
        RejectUnknownOptions(type, options);
        if (payload is { Length: > ushort.MaxValue })
            throw new ArgumentException("Tile payload exceeds 65,535 UTF-8 bytes.", nameof(options));
        return new Tile(position, type, rotation, flip, extra, payload);
    }

    public static IEnumerable<Position> Destinations(Tile tile)
    {
        Position forward = Direction(tile.Rotation);
        Position right = RightOf(forward, tile.Flip);
        return tile.Type switch
        {
            1 or 4 or 5 or 15 or 16 or 17 or 18 or 19 or 20 or 21 or 22 or 24 or 28 or 30 => [tile.Position + forward],
            2 or 9 => [tile.Position + new Position(0, -1), tile.Position + new Position(1, 0), tile.Position + new Position(0, 1), tile.Position + new Position(-1, 0)],
            6 => [tile.Position + forward, tile.Position + new Position(-forward.X, -forward.Y)],
            7 => [tile.Position + forward, tile.Position + right],
            8 => [tile.Position + forward, tile.Position + right, tile.Position + new Position(-right.X, -right.Y)],
            10 => [tile.Position + Scale(forward, 2)],
            11 => [tile.Position + forward + right],
            12 => [tile.Position + forward, tile.Position + Scale(forward, 2)],
            13 => [tile.Position + Scale(forward, 2), tile.Position + right],
            14 => [tile.Position + forward, tile.Position + forward + right],
            _ => []
        };
    }

    private static Position Direction(byte rotation) => rotation switch { 0 => new(0, -1), 1 => new(1, 0), 2 => new(0, 1), 3 => new(-1, 0), _ => throw new ArgumentException("Rotation must be between 0 and 3.") };
    private static Position RightOf(Position forward, bool flip)
    {
        var horizontal = forward.Y;
        var vertical = -forward.X;
        return flip ? new(horizontal, vertical) : new(-horizontal, -vertical);
    }
    private static Position Scale(Position vector, int factor) => new(vector.X * factor, vector.Y * factor);
    private static bool SupportsFlip(byte type) => type is 7 or 11 or 13 or 14;

    private static int Color(IReadOnlyDictionary<string, object> options, int maximum)
    {
        if (!options.TryGetValue("color", out var value) || value is not string name)
            return OptionInt(options, "color", 0, 0, maximum);
        var index = Array.FindIndex(Colors, color => color.Equals(name, StringComparison.OrdinalIgnoreCase));
        if (index < 0 || index > maximum)
            throw new ArgumentException($"Unsupported color '{name}' for this tile.", nameof(options));
        return index;
    }

    private static int Glyph(IReadOnlyDictionary<string, object> options)
    {
        if (!options.TryGetValue("glyph", out var value) || value is not string glyph)
            return OptionInt(options, "glyph", 0, 0, 36);
        return glyph.ToUpperInvariant() switch
        {
            "" or " " => 0,
            [>= 'A' and <= 'Z' and var letter] => letter - 'A' + 1,
            [>= '0' and <= '9' and var digit] => digit - '0' + 27,
            _ => throw new ArgumentException("A wall glyph must be blank, one letter A–Z, or one digit.", nameof(options))
        };
    }

    private static int OptionInt(IReadOnlyDictionary<string, object> options, string name, int defaultValue, int minimum, int maximum)
    {
        if (!options.TryGetValue(name, out object? value)) return defaultValue;
        long number = value switch { int integer => integer, long longInteger => longInteger, _ => throw new ArgumentException($"Option '{name}' must be an integer.", nameof(options)) };
        if (number < minimum || number > maximum) throw new ArgumentException($"Option '{name}' must be between {minimum} and {maximum}.", nameof(options));
        return (int)number;
    }
    private static bool OptionBool(IReadOnlyDictionary<string, object> options, string name, bool defaultValue)
    {
        if (!options.TryGetValue(name, out object? value)) return defaultValue;
        return value is bool boolean ? boolean : throw new ArgumentException($"Option '{name}' must be Boolean.", nameof(options));
    }
    private static string OptionString(IReadOnlyDictionary<string, object> options, string name, string defaultValue)
    {
        if (!options.TryGetValue(name, out object? value)) return defaultValue;
        return value is string text ? text : throw new ArgumentException($"Option '{name}' must be a string.", nameof(options));
    }
    private static void RejectUnknownOptions(byte type, IReadOnlyDictionary<string, object> options)
    {
        HashSet<string> allowed = type switch
        {
            21 => ["key"], 25 => ["color", "glyph"], 27 or 28 => ["color", "bright"], 29 => ["note", "octave", "instrument"],
            22 or 23 or 33 => ["code"], 34 => ["text"], _ => []
        };
        var name = options.Keys.FirstOrDefault(key => !allowed.Contains(key));
        if (name is not null)
            throw new ArgumentException($"Option '{name}' is not supported for this component.", nameof(options));
    }
}
