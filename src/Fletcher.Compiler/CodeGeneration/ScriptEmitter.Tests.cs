using Fletcher.Compiler.IR;
using Fletcher.Compiler.Syntax;

namespace Fletcher.Compiler.CodeGeneration;

internal sealed partial class ScriptEmitter
{
    public string EmitTests(Func<TextSpan, string> location)
    {
        testLocation = location;
        Line("\"use strict\";");
        EmitRuntimeCore();
        Line("""
            const globalState = Object.create(null);
            const onStart = start => start();
            const log = (...values) => console.log(...values);
            const world = { getTick: () => __noGame("currentTick()") };
            function __pixel() { __noGame("pixel()"); }
            function __pixelIndexAt() { return __noGame("pixelIndexAt()"); }
            function __screenPalette() { __noGame("screenPalette()"); }
            function __noGame(name) { throw new Error(name + " requires a running map"); }
            let __passed = 0, __failed = 0;
            function __runTest(name, location, run) {
                try {
                    run();
                    __passed++;
                    console.log("PASS " + name + " (" + location + ")");
                } catch (error) {
                    __failed++;
                    console.error("FAIL " + name + " (" + location + ")");
                    console.error("  " + error.message);
                }
            }
            function __assert(condition, location, message) {
                if (!condition) throw new Error(location + ": " + (message ?? "assertion failed"));
            }
            function __equal(a, b) {
                if (a === b) return true;
                if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
                const keys = Object.keys(a);
                return keys.length === Object.keys(b).length &&
                    keys.every(key => Object.hasOwn(b, key) && __equal(a[key], b[key]));
            }
            function __assertEqual(actual, expected, location, message) {
                if (__equal(actual, expected)) return;
                const display = value => {
                    const text = JSON.stringify(value);
                    return text.length > 200 ? text.slice(0, 197) + "..." : text;
                };
                __assert(false, location, (message === undefined ? "" : message + ": ") +
                    "expected " + display(expected) + ", got " + display(actual));
            }
            function __assertFiles(actual, expected, location, message) {
                const prefix = message === undefined ? "" : message + ": ";
                const actualSize = __fileSize(actual), expectedSize = __fileSize(expected);
                if (actualSize !== expectedSize) {
                    __assert(false, location, prefix + "expected " + expectedSize + " bytes, got " + actualSize);
                }
                if (actual === expected) return;
                for (let index = 0; index < actualSize; index++) {
                    const a = __fileByte(actual, index), b = __fileByte(expected, index);
                    if (a !== b) __assert(false, location, prefix + "byte " + index + ": expected " + b + ", got " + a);
                }
            }
            """);
        Function[] reachable = [.. ReachableFunctions([])];
        AnalyzeIndexBounds(reachable.Select(function => function.Body).Concat(program.Tests.Select(test => test.Body)));
        TrackStructFieldOrder(reachable.SelectMany(function => BoundTree.StructLiterals(function.Body))
            .Concat(program.Tests.SelectMany(test => BoundTree.StructLiterals(test.Body))));
        AnalyzeOwnedResults(reachable);
        foreach (var function in reachable)
            EmitFunction(function);
        EmitMethodDispatch(reachable.SelectMany(function => BoundTree.Dispatches(function.Body))
            .Concat(program.Tests.SelectMany(test => BoundTree.Dispatches(test.Body))));

        for (var i = 0; i < program.Tests.Length; i++)
        {
            Line($"function __test{i}() {{");
            indent++;
            EmitStatements(program.Tests[i].Body);
            indent--;
            Line("}");
        }

        EmitSupportCode();
        foreach (var script in EmitDataTiles())
            Line(script);

        for (var i = 0; i < program.Tests.Length; i++)
        {
            var test = program.Tests[i];
            Line($"__runTest({Quote(test.Name)}, {Quote(location(test.Span))}, __test{i});");
        }
        Line("console.log(__passed + \" passed, \" + __failed + \" failed\");");
        Line("if (__failed !== 0) process.exitCode = 1;");
        return text.ToString();
    }

    private void EmitAssertion(BoundAssertion assertion)
    {
        var operands = assertion.Equality ? 2 : 1;
        var function = assertion.Equality ? "__assertEqual" : "__assert";
        if (assertion.Equality && assertion.Arguments[0].Type.Shape.Kind == TypeKind.Bytes)
        {
            function = "__assertFiles";
            needsFileHelpers = true;
        }
        var arguments = assertion.Arguments.Take(operands).Select(Expr).Append(Quote(testLocation!(assertion.Span)))
            .Concat(assertion.Arguments.Skip(operands).Select(Expr));
        Line($"{function}({string.Join(", ", arguments)});");
    }

    private string MousePosition(bool horizontal)
    {
        if (testLocation is not null)
            return $"__noGame({Quote(horizontal ? "mouseX()" : "mouseY()")})";
        if (sliced)
            return horizontal ? "__tickMouseX" : "__tickMouseY";
        return horizontal ? "__mouseX" : "__mouseY";
    }
}
