namespace Fletcher.Compiler.IR;

internal sealed class ImportedFile(byte[] data)
{
    public static ImportedFile Empty { get; } = new([]);
    public ReadOnlyMemory<byte> Data { get; } = data;
}
