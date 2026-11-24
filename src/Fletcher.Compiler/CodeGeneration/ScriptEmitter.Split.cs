using System.Text.Encodings.Web;
using System.Text.Json;

namespace Fletcher.Compiler.CodeGeneration;

internal sealed partial class ScriptEmitter
{
    private const string CodeKeyPrefix = "__fletcherCode";

    public static IReadOnlyList<string> SplitController(string source, bool usesMouse)
    {
        List<string> parts = [];
        for (var offset = 0; offset < source.Length;)
        {
            var prefix = $"onStart(() => {{ globalState[\"{CodeKeyPrefix}{parts.Count}\"] = ";
            const string suffix = "; });";
            // The wrapper is ASCII. Measure the escaped UTF-8 bytes of the
            // fragment separately and leave room for its surrounding quotes.
            var capacity = ushort.MaxValue - prefix.Length - suffix.Length - 2;
            var length = Math.Min(capacity, source.Length - offset);
            while (true)
            {
                if (char.IsHighSurrogate(source[offset + length - 1]))
                    length--;
                var encoded = JsonEncodedText.Encode(source.AsSpan(offset, length), JavaScriptEncoder.UnsafeRelaxedJsonEscaping);
                var excess = encoded.EncodedUtf8Bytes.Length - capacity;
                if (excess <= 0)
                {
                    parts.Add(prefix + "\"" + encoded + "\"" + suffix);
                    offset += length;
                    break;
                }
                length -= Math.Max(1, excess / 6);
            }
        }

        // The fragments carry compiler-emitted source. Run it in the controller
        // so calls, register commits and slice checkpoints share one tick.
        var loader = $$"""
            let __fletcherRun, __fletcherMouse;
            function __fletcherLink() {
                if (__fletcherRun) return;
                const parts = [];
                for (let i = 0; i < {{parts.Count}}; i++) {
                    const part = globalState["{{CodeKeyPrefix}}" + i];
                    if (typeof part !== "string") throw new Error("Missing Fletcher code tile " + i);
                    parts.push(part);
                }
                const install = (always, onPlayerMouseMove) => eval(parts.join(""));
                install(run => { __fletcherRun = run; }, mouse => { __fletcherMouse = mouse; });
            }
            always(() => {
                __fletcherLink();
                __fletcherRun();
            });
            """;
        if (usesMouse)
        {
            loader += """

                onPlayerMouseMove((x, y) => {
                    __fletcherLink();
                    __fletcherMouse(x, y);
                });
                """;
        }
        return [loader, .. parts];
    }
}
