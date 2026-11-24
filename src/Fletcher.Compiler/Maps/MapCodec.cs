using System.Buffers;
using System.Buffers.Binary;
using System.Buffers.Text;
using System.IO.Compression;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace Fletcher.Compiler.Maps;

/// <summary>Reads and writes the Logic Arrows v5 Base64 map envelope.</summary>
public static class MapCodec
{
    private const byte FormatVersion = 5;
    private const int HeaderLength = 3;
    internal const int MaximumChunks = ushort.MaxValue;
    internal const int MaximumLevelBytes = 16 * 1024 * 1024;
    private const int MaximumPreviewBytes = 1024 * 1024;

    internal static (int X, int Y) Chunk(Position position) => (position.X >> 4, position.Y >> 4);

    internal static long TileBodyBytes(Tile tile) => 2 + (tile.Payload is { } data ? 2 + data.LongLength : tile.Extra > 15 ? 2 : 0);

    internal static string? LevelLimitError(IEnumerable<Tile> tiles)
    {
        var (chunks, bytes) = MeasureBody(tiles);
        if (chunks > MaximumChunks)
            return $"A Logic Arrows v5 map can contain at most {MaximumChunks:N0} chunks.";
        return bytes > MaximumLevelBytes ? $"The expanded Logic Arrows Level payload is {bytes:N0} bytes. The game allows at most 16 MiB." : null;
    }

    private static (int Chunks, long Bytes) MeasureBody(IEnumerable<Tile> tiles)
    {
        HashSet<(int X, int Y)> chunks = [];
        HashSet<((int X, int Y) Chunk, byte Type)> groups = [];
        long bytes = 2;
        foreach (var tile in tiles)
        {
            var chunk = Chunk(tile.Position);
            if (chunks.Add(chunk))
                bytes += 5;
            if (groups.Add((chunk, tile.Type)))
                bytes += 2;
            bytes += TileBodyBytes(tile);
        }
        return (chunks.Count, bytes);
    }

    public static string Encode(IEnumerable<Tile> tiles, bool compress = true)
    {
        ArgumentNullException.ThrowIfNull(tiles);
        List<Tile> orderedTiles = [.. tiles];
        ValidateTiles(orderedTiles);
        if (LevelLimitError(orderedTiles) is { } limitError)
            throw new ArgumentException(limitError, nameof(tiles));

        SortedDictionary<(int X, int Y), SortedDictionary<byte, List<Tile>>> chunks = [];
        foreach (Tile tile in orderedTiles)
        {
            var chunk = Chunk(tile.Position);
            if (!chunks.TryGetValue(chunk, out SortedDictionary<byte, List<Tile>>? groups))
            {
                groups = [];
                chunks.Add(chunk, groups);
            }

            if (!groups.TryGetValue(tile.Type, out List<Tile>? group))
            {
                group = [];
                groups.Add(tile.Type, group);
            }

            group.Add(tile);
        }

        using var envelope = new MemoryStream();
        envelope.Write([FormatVersion, 0, compress ? (byte)1 : (byte)0]);
        using var uncompressed = compress ? new MemoryStream() : null;
        var body = uncompressed ?? envelope;
        WriteUInt16(body, checked((ushort)chunks.Count));
        foreach (var ((chunkX, chunkY), groups) in chunks)
        {
            WriteUInt16(body, PackChunkCoordinate(chunkX));
            WriteUInt16(body, PackChunkCoordinate(chunkY));
            body.WriteByte(checked((byte)(groups.Count - 1)));

            foreach ((byte type, List<Tile> group) in groups)
            {
                if (group.Count > byte.MaxValue + 1)
                {
                    throw new ArgumentException($"Tile type {type} has more than 256 cells in a chunk.", nameof(tiles));
                }

                body.WriteByte(type);
                body.WriteByte(checked((byte)(group.Count - 1)));
                foreach (Tile tile in group.OrderBy(tile => LocalCoordinate(tile.Position)))
                {
                    WriteTile(body, tile);
                }
            }
        }

        if (uncompressed is not null)
        {
            using var zlib = new ZLibStream(envelope, CompressionLevel.SmallestSize, leaveOpen: true);
            uncompressed.WriteTo(zlib);
        }
        if (uncompressed is not null && envelope.Length - HeaderLength > MaximumLevelBytes)
        {
            // A near-limit body can grow slightly when compressed. The game
            // also reads raw v5 bodies, so keep the already-validated body.
            envelope.SetLength(0);
            envelope.Write([FormatVersion, 0, 0]);
            uncompressed.WriteTo(envelope);
        }

        return Base64.EncodeToString(envelope.GetBuffer().AsSpan(0, (int)envelope.Length));
    }

    public static IReadOnlyList<Tile> Decode(string encoded)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(encoded);
        byte[] envelope;
        try { envelope = Convert.FromBase64String(encoded); }
        catch (FormatException exception) { throw new FormatException("Map data is not valid Base64.", exception); }

        if (envelope.Length < HeaderLength || envelope[0] != FormatVersion || envelope[1] != 0 || envelope[2] is not 0 and not 1)
        {
            throw new FormatException("Expected a Logic Arrows v5 raw or zlib map payload.");
        }

        ReadOnlyMemory<byte> payloadBytes = envelope.AsMemory(HeaderLength);
        if (payloadBytes.Length > MaximumLevelBytes)
            throw new FormatException("The Logic Arrows Level payload exceeds the game's 16 MiB limit.");
        ReadOnlySpan<byte> body = envelope[2] == 1 ? Decompress(payloadBytes) : payloadBytes.Span;
        Reader reader = new(body);
        ushort chunkCount = reader.UInt16();
        List<Tile> tiles = [];
        HashSet<Position> occupied = [];

        for (int chunk = 0; chunk < chunkCount; chunk++)
        {
            int chunkX = UnpackChunkCoordinate(reader.UInt16());
            int chunkY = UnpackChunkCoordinate(reader.UInt16());
            int groupCount = reader.Byte() + 1;
            for (int group = 0; group < groupCount; group++)
            {
                byte type = reader.Byte();
                int tileCount = reader.Byte() + 1;
                for (int row = 0; row < tileCount; row++)
                {
                    byte local = reader.Byte();
                    byte flags = reader.Byte();
                    Position position = new(chunkX * 16 + (local & 15), chunkY * 16 + (local >> 4));
                    if (!occupied.Add(position)) throw new FormatException($"Map has multiple tiles at ({position.X}, {position.Y}).");

                    ushort extra = checked((ushort)(flags >> 4));
                    byte[]? payload = null;
                    if ((flags & 8) != 0)
                    {
                        if ((flags & 16) != 0)
                        {
                            extra = 0;
                            payload = reader.Bytes(reader.UInt16());
                        }
                        else
                        {
                            extra = reader.UInt16();
                        }
                    }

                    tiles.Add(new Tile(position, type, checked((byte)(flags & 3)), (flags & 4) != 0, extra, payload));
                }
            }
        }

        if (!reader.AtEnd) throw new FormatException($"Map payload has {reader.Remaining} trailing bytes.");
        return tiles;
    }

    public static IReadOnlyList<Tile> Read(string json, bool preview = false)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(json);
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Object) throw new FormatException("Map wrapper must be a JSON object.");
            string field = preview ? "preview_data" : "data";
            if (!document.RootElement.TryGetProperty(field, out JsonElement data) || data.ValueKind != JsonValueKind.String)
            {
                throw new FormatException($"Map wrapper has no string '{field}' field.");
            }
            return Decode(data.GetString()!);
        }
        catch (JsonException exception) { throw new FormatException("Map wrapper is not valid JSON.", exception); }
    }

    public static string Write(string name, IReadOnlyList<Tile> tiles, string? templateJson = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentNullException.ThrowIfNull(tiles);
        string data = Encode(tiles);
        string previewData = EncodePreview(tiles);
        var buffer = new ArrayBufferWriter<byte>();
        // The game reads this as a JSON file, with literal Base64 strings in
        // the preview index. No generated map JSON is embedded in HTML.
        using (Utf8JsonWriter writer = new(buffer, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
        {
            writer.WriteStartObject();
            if (templateJson is null)
            {
                writer.WriteString("name", name);
                writer.WriteNumber("version", 3);
                writer.WriteString("map_type", "Level");
                writer.WriteString("preview_data", previewData);
                writer.WritePropertyName("tags"); writer.WriteStartArray(); writer.WriteStringValue("level"); writer.WriteEndArray();
                writer.WritePropertyName("_preview_header_end"); writer.WriteStartObject(); writer.WriteNumber("version", 1); writer.WriteNumber("fields", 395); writer.WriteEndObject();
                writer.WriteString("data", data);
                writer.WritePropertyName("level_settings"); writer.WriteStartObject(); writer.WriteBoolean("show_progress", false); writer.WriteBoolean("all_arrows", true); writer.WriteBoolean("predict_signals", false); writer.WriteEndObject();
            }
            else
            {
                using JsonDocument template = JsonDocument.Parse(templateJson);
                if (template.RootElement.ValueKind != JsonValueKind.Object) throw new FormatException("Map template must be a JSON object.");
                if (!template.RootElement.TryGetProperty("map_type", out var mapType) ||
                    mapType.ValueKind != JsonValueKind.String || mapType.GetString() != "Level" ||
                    !Array.TrueForAll(["name", "preview_data", "data"], field =>
                        template.RootElement.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String))
                {
                    throw new FormatException("Use an editor-created Level template with name, preview_data, and data fields.");
                }
                foreach (JsonProperty property in template.RootElement.EnumerateObject())
                {
                    if (property.NameEquals("name")) writer.WriteString("name", name);
                    else if (property.NameEquals("data")) writer.WriteString("data", data);
                    else if (property.NameEquals("preview_data")) writer.WriteString("preview_data", previewData);
                    else { property.WriteTo(writer); }
                }
            }
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static string EncodePreview(IReadOnlyList<Tile> tiles)
    {
        Tile[] preview = [.. PreviewTiles(tiles).Select(WithoutScriptPayload)];
        if (MeasureBody(preview).Bytes <= MaximumPreviewBytes)
        {
            var encoded = Encode(preview);
            const int EncodedLimit = ((MaximumPreviewBytes + 2) / 3) * 4;
            if (encoded.Length < EncodedLimit || Convert.FromBase64String(encoded).Length <= MaximumPreviewBytes)
                return encoded;
        }
        // Message payloads are useful in a preview when they fit. Preserve the
        // full messages in the Level and use their tile icons in larger previews.
        return Encode(preview.Select(tile => tile.Payload is null ? tile : tile with { Payload = null }));
    }

    private static Tile WithoutScriptPayload(Tile tile) => tile.Type is 22 or 23 or 33 && tile.Payload is not null
        ? tile with { Payload = null } : tile;

    private static IEnumerable<Tile> PreviewTiles(IReadOnlyList<Tile> tiles)
    {
        const int width = 64;
        const int height = 36;
        if (tiles.Count == 0)
            return tiles;

        var minX = tiles.Min(tile => tile.Position.X);
        var minY = tiles.Min(tile => tile.Position.Y);
        var maxX = tiles.Max(tile => tile.Position.X);
        var maxY = tiles.Max(tile => tile.Position.Y);
        if (maxX - minX < width && maxY - minY < height)
            return tiles;

        // Keep the map-card preview near the playable origin. The main payload
        // retains the full, independently positioned map.
        var anchor = tiles.MinBy(tile => Math.Abs(tile.Position.X) + Math.Abs(tile.Position.Y))!.Position;
        var left = Math.Clamp(anchor.X - width / 2, minX, Math.Max(minX, maxX - width + 1));
        var top = Math.Clamp(anchor.Y - height / 2, minY, Math.Max(minY, maxY - height + 1));
        return tiles.Where(tile => tile.Position.X >= left && tile.Position.X < left + width &&
            tile.Position.Y >= top && tile.Position.Y < top + height);
    }

    private static void ValidateTiles(IReadOnlyList<Tile> tiles)
    {
        HashSet<Position> positions = [];
        foreach (Tile tile in tiles)
        {
            if (tile.Type == 0) throw new ArgumentException("Tile type 0 is empty and cannot be encoded.", nameof(tiles));
            if (tile.Rotation > 3) throw new ArgumentException($"Tile at {tile.Position} has invalid rotation {tile.Rotation}.", nameof(tiles));
            if (tile.Payload is { Length: > ushort.MaxValue }) throw new ArgumentException($"Tile at {tile.Position} has a payload longer than 65,535 bytes.", nameof(tiles));
            if (tile.Payload is not null && tile.Extra != 0) throw new ArgumentException($"Payload tile at {tile.Position} must have extra value zero.", nameof(tiles));
            if (!positions.Add(tile.Position)) throw new ArgumentException($"Map has multiple tiles at {tile.Position}.", nameof(tiles));
            int chunkX = FloorDiv(tile.Position.X, 16), chunkY = FloorDiv(tile.Position.Y, 16);
            if (Math.Abs((long)chunkX) > 0x7fff || Math.Abs((long)chunkY) > 0x7fff) throw new ArgumentException($"Tile at {tile.Position} is outside the supported map range.", nameof(tiles));
        }
    }

    private static void WriteTile(Stream stream, Tile tile)
    {
        stream.WriteByte(LocalCoordinate(tile.Position));
        byte flags = (byte)(tile.Rotation | (tile.Flip ? 4 : 0));
        if (tile.Payload is not null)
        {
            stream.WriteByte((byte)(flags | 24));
            WriteUInt16(stream, checked((ushort)tile.Payload.Length));
            stream.Write(tile.Payload);
        }
        else if (tile.Extra > 15)
        {
            stream.WriteByte((byte)(flags | 8));
            WriteUInt16(stream, tile.Extra);
        }
        else stream.WriteByte((byte)(flags | (tile.Extra << 4)));
    }

    private static byte LocalCoordinate(Position position) => checked((byte)((Mod(position.Y, 16) << 4) | Mod(position.X, 16)));
    private static int FloorDiv(int value, int divisor) => value >= 0 ? value / divisor : ((value + 1) / divisor) - 1;
    private static int Mod(int value, int divisor) => value - FloorDiv(value, divisor) * divisor;
    private static ushort PackChunkCoordinate(int coordinate) => checked((ushort)(Math.Abs(coordinate) | (coordinate < 0 ? 0x8000 : 0)));
    private static int UnpackChunkCoordinate(ushort value) => (value & 0x8000) == 0 ? value : -(value & 0x7fff);
    private static void WriteUInt16(Stream stream, ushort value) { Span<byte> bytes = stackalloc byte[2]; BinaryPrimitives.WriteUInt16LittleEndian(bytes, value); stream.Write(bytes); }
    private static byte[] Decompress(ReadOnlyMemory<byte> body)
    {
        try
        {
            using var source = new ReadOnlyMemoryStream(body);
            using var zlib = new ZLibStream(source, CompressionMode.Decompress);
            using var result = new MemoryStream();
            Span<byte> buffer = stackalloc byte[8192];
            int bytesRead;
            while ((bytesRead = zlib.Read(buffer)) != 0)
            {
                if (result.Length + bytesRead > MaximumLevelBytes)
                    throw new FormatException("The expanded Logic Arrows Level payload exceeds the game's 16 MiB limit.");
                result.Write(buffer[..bytesRead]);
            }
            return result.ToArray();
        }
        catch (InvalidDataException exception)
        {
            throw new FormatException("Map payload has invalid zlib data.", exception);
        }
    }

    private ref struct Reader(ReadOnlySpan<byte> bytes)
    {
        private readonly ReadOnlySpan<byte> data = bytes;
        private int offset;

        public readonly int Remaining => data.Length - offset;
        public readonly bool AtEnd => offset == data.Length;
        public byte Byte() => Take(1)[0];
        public ushort UInt16() => BinaryPrimitives.ReadUInt16LittleEndian(Take(2));
        public byte[] Bytes(ushort count) => Take(count).ToArray();
        private ReadOnlySpan<byte> Take(int count)
        {
            if (count > Remaining) throw new FormatException($"Map payload is truncated at byte {offset}.");
            ReadOnlySpan<byte> result = data.Slice(offset, count); offset += count; return result;
        }
    }
}
