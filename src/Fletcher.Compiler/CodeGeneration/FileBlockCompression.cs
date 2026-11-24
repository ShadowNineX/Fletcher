using System.Buffers.Binary;
using System.Buffers.Text;
using System.Runtime.CompilerServices;
using Fletcher.Compiler.IR;

namespace Fletcher.Compiler.CodeGeneration;

// Independent LZ4 blocks. Raw chunks retain the original Base64 representation.
internal sealed record FileBlockCompression(string?[] Blocks, int CharactersSaved)
{
    public const int ChunkBytes = 45_000;
    private const int HashBits = 14;
    private static readonly ConditionalWeakTable<ImportedFile, FileBlockCompression> Cache = [];

    public static FileBlockCompression For(ImportedFile file) => Cache.GetValue(file, EncodeFile);

    private static FileBlockCompression EncodeFile(ImportedFile file)
    {
        var data = file.Data.Span;
        var blocks = new string?[(data.Length + ChunkBytes - 1) / ChunkBytes];
        var saved = 0;
        if (data.Length >= 13)
        {
            var heads = new ushort[1 << HashBits];
            var previous = new ushort[Math.Min(ChunkBytes, data.Length)];
            for (var start = 0; start < data.Length; start += ChunkBytes)
            {
                var chunk = data.Slice(start, Math.Min(ChunkBytes, data.Length - start));
                if (chunk.Length < 13)
                    continue;
                Array.Clear(heads);
                var packed = EncodeBlock(chunk, heads, previous);
                var saving = 4 * ((chunk.Length + 2) / 3) - (1 + 4 * ((packed.Length + 2) / 3));
                if (saving <= 0)
                    continue;
                blocks[start / ChunkBytes] = "!" + Base64.EncodeToString(packed);
                saved += saving;
            }
        }
        return new(blocks, saved);
    }

    private static byte[] EncodeBlock(ReadOnlySpan<byte> input, ushort[] heads, ushort[] previous)
    {
        using var output = new MemoryStream(input.Length);
        var anchor = 0;
        var position = 0;
        // LZ4 requires a final literal run of at least five bytes and a last
        // match starting at least twelve bytes before the end of the block.
        while (position <= input.Length - 12)
        {
            var word = BinaryPrimitives.ReadUInt32LittleEndian(input[position..]);
            var candidate = Insert(word, position, heads, previous);
            var limit = input.Length - 5 - position;
            var best = 3;
            var distance = 0;
            for (var tries = 0; candidate >= 0 && tries < 16; tries++, candidate = previous[candidate] - 1)
            {
                if (input[candidate + best] != input[position + best] ||
                    BinaryPrimitives.ReadUInt32LittleEndian(input[candidate..]) != word)
                    continue;
                var length = 4;
                while (length < limit && input[candidate + length] == input[position + length])
                    length++;
                if (length <= best)
                    continue;
                best = length;
                distance = position - candidate;
                if (best == limit)
                    break;
            }
            if (distance == 0)
            {
                position++;
                continue;
            }

            WriteLiterals(output, input[anchor..position], Math.Min(best - 4, 15));
            output.WriteByte((byte)distance);
            output.WriteByte((byte)(distance >> 8));
            WriteLength(output, best - 4);
            var end = position + best;
            for (var next = position + 1; next < end && next <= input.Length - 12; next++)
                Insert(BinaryPrimitives.ReadUInt32LittleEndian(input[next..]), next, heads, previous);
            anchor = position = end;
        }
        WriteLiterals(output, input[anchor..], 0);
        return output.ToArray();
    }

    private static int Insert(uint word, int position, ushort[] heads, ushort[] previous)
    {
        var hash = unchecked(word * 2654435761u) >> (32 - HashBits);
        previous[position] = heads[hash];
        heads[hash] = (ushort)(position + 1);
        return previous[position] - 1;
    }

    private static void WriteLiterals(MemoryStream output, ReadOnlySpan<byte> literals, int matchNibble)
    {
        output.WriteByte((byte)((Math.Min(literals.Length, 15) << 4) | matchNibble));
        WriteLength(output, literals.Length);
        output.Write(literals);
    }

    private static void WriteLength(MemoryStream output, int length)
    {
        if (length < 15)
            return;
        length -= 15;
        while (length >= 255)
        {
            output.WriteByte(255);
            length -= 255;
        }
        output.WriteByte((byte)length);
    }
}
