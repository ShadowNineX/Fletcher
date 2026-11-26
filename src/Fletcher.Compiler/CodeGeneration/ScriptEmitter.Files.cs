using System.Buffers.Text;
using System.Globalization;
using Fletcher.Compiler.IR;

namespace Fletcher.Compiler.CodeGeneration;

internal sealed partial class ScriptEmitter
{
    // A multiple of three keeps full Base64 chunks free of padding. At 60,000
    // ASCII characters there is room for the script wrapper in a v5 tile.
    private const int FileChunkBytes = FileBlockCompression.ChunkBytes;
    private const string FileKeyPrefix = "__fletcherFile";
    private readonly Dictionary<ImportedFile, int> fileIds = [];
    private readonly Dictionary<string, int> sharedFileSlots = [with(StringComparer.Ordinal)];
    private bool needsFileHelpers;
    private bool usesFileReadCache;
    private bool usesPackedFileBlocks;

    private static BoundExpression? CachedFileReadValue(Function function)
    {
        if (function.Receiver is not null || !function.Result.IsNumber ||
            function.Parameters is not [var file, var offset] || file.Type.Shape.Kind != TypeKind.Bytes ||
            offset.Type.Shape.Kind != TypeKind.Int ||
            function.Body?.Statements is not [BoundReturn { Value: { } value }] ||
            FileByteReads(value, file, offset) is not >= 2)
            return null;
        return value;
    }

    private bool TryEmitCachedFileRead(Function function)
    {
        if (CachedFileReadValue(function) is not { } value)
            return false;

        usesFileReadCache = true;
        var id = Name(function.Parameters[0]);
        var index = Name(function.Parameters[1]);
        Line($"const slot = ({function.Id} ^ {id} ^ {index}) & 255;");
        Line("const entry = __fileReads[slot];");
        Line($"if (entry && entry[0] === {function.Id} && entry[1] === {id} && entry[2] === {index}) {{");
        indent++;
        Line("return entry[3];");
        indent--;
        Line("}");
        EmitWorkStep();
        Line($"const result = {Expr(value)};");
        Line($"__fileReads[slot] = [{function.Id}, {id}, {index}, result];");
        Line("return result;");
        return true;
    }

    // A numeric expression over one immutable file, an offset and literals has
    // no other inputs. Null propagates for calls, clock reads and other effects.
    private static int? FileByteReads(BoundExpression expression, Variable file, Variable offset) => expression switch
    {
        BoundLiteral { Value: int or uint } => 0,
        BoundVariable variable when variable.Symbol == offset => 0,
        BoundIndex { Receiver: BoundVariable receiver } index when receiver.Symbol == file =>
            1 + FileByteReads(index.Index, file, offset),
        BoundConversion { InterfaceTag: null } conversion => FileByteReads(conversion.Operand, file, offset),
        BoundUnary unary => FileByteReads(unary.Operand, file, offset),
        BoundBinary binary => FileByteReads(binary.Left, file, offset) + FileByteReads(binary.Right, file, offset),
        _ => null
    };

    private string FileReference(ImportedFile file)
    {
        if (file.Data.IsEmpty)
            return "-1";
        if (!fileIds.TryGetValue(file, out var id))
        {
            id = fileIds.Count;
            fileIds.Add(file, id);
        }
        return id.ToString(CultureInfo.InvariantCulture);
    }

    private string FileSize(string file)
    {
        needsFileHelpers = true;
        return $"__fileSize({file})";
    }

    private string SharedFileReference(string key)
    {
        needsFileHelpers = true;
        if (!sharedFileSlots.TryGetValue(key, out var slot))
        {
            slot = sharedFileSlots.Count;
            sharedFileSlots.Add(key, slot);
        }
        return $"__sharedFile({slot})";
    }

    private void EmitSharedFiles()
    {
        // Keep compiled file IDs nonnegative and -1 reserved for empty bytes.
        var keys = string.Join(", ", sharedFileSlots.OrderBy(entry => entry.Value).Select(entry => Quote(entry.Key)));
        Line($$"""
            const __sharedFileKeys = [{{keys}}];
            const __sharedFiles = [];
            function __sharedFile(slot) {
                const id = -slot - 2;
                if (__sharedFiles[slot] !== undefined) return id;
                const key = __sharedFileKeys[slot];
                const source = globalState[key];
                if (source === undefined || source === null) return -1;
                if (!Array.isArray(source)) throw new Error("Invalid Fletcher shared bytes for " + key);
                const snapshot = new Uint8Array(source.length);
                for (let i = 0; i < snapshot.length; i++) {
                    const byte = source[i];
                    if (!Number.isInteger(byte) || byte < 0 || byte > 255)
                        throw new Error("Invalid Fletcher shared byte for " + key + " at " + i);
                    snapshot[i] = byte;
                }
                __sharedFiles[slot] = snapshot;
                return id;
            }
            """);
    }

    private string FileByte(string file, string index)
    {
        needsFileHelpers = true;
        return $"__fileByte({file}, {index})";
    }

    private void EmitFileHelpers()
    {
        if (!needsFileHelpers)
            return;
        // Small files and incompressible imports need no decoder. The tag and
        // Base64 padding for each independently stored block are already costed.
        usesPackedFileBlocks = fileIds.Keys.Sum(file => FileBlockCompression.For(file).CharactersSaved) >
            FileBlockDecoder.Length + 128;
        if (usesPackedFileBlocks)
            Line(FileBlockDecoder);
        if (sharedFileSlots.Count > 0)
            EmitSharedFiles();
        Line($"const __fileSizes = [{string.Join(", ", fileIds.OrderBy(entry => entry.Value).Select(entry => entry.Key.Data.Length))}];");
        if (usesPackedFileBlocks)
        {
            // Renderers often alternate texture bytes with a separate lookup table.
            // Actual decoded lengths keep the last partial block bounds-checked.
            Line("let __recentFile = -1, __recentStart = 0, __recentEnd = 0, __recentBlock;");
            Line("let __priorFile = -1, __priorStart = 0, __priorEnd = 0, __priorBlock;");
        }
        Line($$"""
            const __fileChunks = __fileSizes.map(() => []);
            function __fileSize(id) { {{(sharedFileSlots.Count > 0 ? "if (id < -1) return __sharedFiles[-id - 2]?.length ?? 0; " : "")}}return id < 0 ? 0 : __fileSizes[id]; }
            function __fileByte(id, index) {
                {{(usesPackedFileBlocks ? """
                if (id === __recentFile && index >= __recentStart && index < __recentEnd) return __recentBlock[index - __recentStart];
                if (id === __priorFile && index >= __priorStart && index < __priorEnd) return __priorBlock[index - __priorStart];
                """ : "")}}
                {{(sharedFileSlots.Count > 0 ? """
                if (id < -1) {
                    const snapshot = __sharedFiles[-id - 2];
                    return snapshot[__index(index, snapshot.length)];
                }
                """ : "")}}
                __index(index, __fileSize(id));
                const chunk = __floor(index / {{FileChunkBytes}});
                const chunks = __fileChunks[id];
                let block = chunks[chunk];
                if (block === undefined) {
                    const encoded = globalState["{{FileKeyPrefix}}" + id + "_" + chunk];
                    if (typeof encoded !== "string") throw new Error("Missing Fletcher file data tile " + id + ":" + chunk);
                    block = {{(usesPackedFileBlocks ? $"__decodeFileBlock(encoded, __min({FileChunkBytes}, __fileSizes[id] - chunk * {FileChunkBytes}))" : "encoded")}};
                    chunks[chunk] = block;
                }
                {{(usesPackedFileBlocks ? $$"""
                const start = chunk * {{FileChunkBytes}};
                __priorFile = __recentFile;
                __priorStart = __recentStart;
                __priorEnd = __recentEnd;
                __priorBlock = __recentBlock;
                __recentFile = id;
                __recentStart = start;
                __recentEnd = start + block.length;
                __recentBlock = block;
                return block[index - start];
                """ : $"return __base64Byte(block, index % {FileChunkBytes});")}}
            }
            """);
    }

    private void EmitBase64Reader() => Line("""
        const __base64Digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        function __base64Byte(encoded, index) {
            const group = __floor(index / 3) * 4;
            const offset = index % 3;
            const high = __base64Digits.indexOf(encoded.charAt(group + offset));
            const low = __base64Digits.indexOf(encoded.charAt(group + offset + 1));
            const shift = 2 + offset * 2;
            return ((high << shift) | (low >> (6 - shift))) & 255;
        }
        """);

    private IEnumerable<string> EmitFileTiles()
    {
        foreach (var (file, id) in fileIds.OrderBy(entry => entry.Value))
        {
            var data = file.Data;
            var packed = usesPackedFileBlocks ? FileBlockCompression.For(file).Blocks : null;
            for (var start = 0; start < data.Length; start += FileChunkBytes)
            {
                var part = start / FileChunkBytes;
                var encoded = packed?[part] ?? Base64.EncodeToString(data.Span.Slice(start, Math.Min(FileChunkBytes, data.Length - start)));
                yield return $"onStart(() => {{ globalState[\"{FileKeyPrefix}{id}_{part}\"] = \"{encoded}\"; }});";
            }
        }
    }

    private const string FileBlockDecoder = """
        const __fileDigits = new Uint8Array(128);
        for (let i = 0; i < 64; i++) __fileDigits[__base64Digits.charCodeAt(i)] = i;
        function __decodeFileBlock(encoded, size) {
            function invalid() { throw new Error("Invalid Fletcher file data block"); }
            const packed = encoded[0] === "!";
            const start = packed ? 1 : 0;
            const chars = encoded.length - start;
            if (chars === 0 || chars % 4 !== 0 || chars > 4 * Math.ceil(size / 3)) invalid();
            const length = chars / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
            if (!packed && length !== size) invalid();
            const bytes = new Uint8Array(length);
            for (let i = start, at = 0; i < encoded.length; i += 4) {
                const a = __fileDigits[encoded.charCodeAt(i)], b = __fileDigits[encoded.charCodeAt(i + 1)];
                const c = __fileDigits[encoded.charCodeAt(i + 2)], d = __fileDigits[encoded.charCodeAt(i + 3)];
                bytes[at++] = (a << 2) | (b >> 4);
                if (at < length) bytes[at++] = (b << 4) | (c >> 2);
                if (at < length) bytes[at++] = (c << 6) | d;
            }
            if (!packed) return bytes;
            const result = new Uint8Array(size);
            let src = 0, dst = 0;
            function runLength(nibble) {
                if (nibble < 15) return nibble;
                let next;
                do {
                    if (src >= length) invalid();
                    next = bytes[src++];
                    nibble += next;
                } while (next === 255);
                return nibble;
            }
            while (src < length) {
                const token = bytes[src++];
                const literals = runLength(token >> 4);
                if (literals > length - src || literals > size - dst) invalid();
                for (let end = dst + literals; dst < end;) result[dst++] = bytes[src++];
                if (src === length && dst === size) return result;
                if (src + 2 > length) invalid();
                const distance = bytes[src] | (bytes[src + 1] << 8);
                src += 2;
                const match = 4 + runLength(token & 15);
                if (distance === 0 || distance > dst || match > size - dst) invalid();
                for (let end = dst + match; dst < end; dst++) result[dst] = result[dst - distance];
            }
            invalid();
        }
        """;
}
