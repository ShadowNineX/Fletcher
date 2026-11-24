using Fletcher.Compiler.IR;

namespace Fletcher.Compiler.CodeGeneration;

internal sealed partial class ScriptEmitter
{
    private void EmitScreen(Screen screen)
    {
        var (x, y) = screen.Background.Position;
        if (!screen.IsSolid)
        {
            Line($$"""
                function __pixel(x, y, on) {
                    if (x >= 0 && x < {{screen.Width}} && y >= 0 && y < {{screen.Height}})
                        world.setSignal({{x}} + x, {{y}} + y, on ? {{screen.Foreground}} : 0);
                }
                """);
            return;
        }

        // A palette digit per cell keeps the rewindable state compact and
        // avoids allocating a new map and entry objects on each frame.
        Line("let __drawn;");
        if (UsesPixelIndices)
            Line($"const __pixelIndices = new Uint16Array({screen.PixelCount});");
        Line($$"""
            const __zero = "0".charCodeAt(0);
            const __background = __zero + {{screen.Background.Extra}};
            const __pixels = new Uint8Array({{screen.PixelCount}});
            const __blank = String.fromCharCode(__background).repeat(__pixels.length);
            function __frame() {
                let frame = "";
                for (let start = 0; start < __pixels.length; start += 1024)
                    frame += String.fromCharCode(...__pixels.subarray(start, start + 1024));
                return frame;
            }
            function __captureScreen(previous) { return previous ? state.pixels ?? __blank : __frame(); }
            function __preserveScreen() {
                const previous = state.pixels ?? __blank;
                for (let cell = 0; cell < __pixels.length; cell++)
                    __pixels[cell] = previous.charCodeAt(cell);
                {{(UsesPixelIndices ? "__pixelIndices.fill(0);" : "")}}
            }
            function __revealScreen(start, end, rows, columnsPerOffset) {
                if (columnsPerOffset <= 0) throw new Error("Fletcher revealScreen columns per offset must be positive");
                if (start.length !== __pixels.length || end.length !== __pixels.length)
                    throw new Error("Fletcher revealScreen frame has the wrong size");
                if (/[^0-7]/.test(start) || /[^0-7]/.test(end))
                    throw new Error("Fletcher revealScreen frame contains invalid palette data");
                if (rows.length < Math.ceil({{screen.Width}} / columnsPerOffset))
                    throw new Error("Fletcher revealScreen row offsets do not cover the screen width");
                for (let first = 0, band = 0; first < {{screen.Width}}; first += columnsPerOffset, band++) {
                    const last = Math.min(first + columnsPerOffset, {{screen.Width}});
                    const split = Math.min({{screen.Height}}, Math.max(0, rows[band]));
                    for (let row = 0; row < {{screen.Height}}; row++) {
                        const destination = row * {{screen.Width}};
                        const frame = row < split ? end : start;
                        const source = row < split ? destination : (row - split) * {{screen.Width}};
                        for (let column = first; column < last; column++)
                            __pixels[destination + column] = frame.charCodeAt(source + column);
                    }
                }
                {{(UsesPixelIndices ? "__pixelIndices.fill(0);" : "")}}
                __drawn = true;
            }
            function __pixel(x, y, on, color = {{screen.Foreground}}{{(UsesPixelIndices ? ", index" : "")}}) {
                if (x < 0 || x >= {{screen.Width}} || y < 0 || y >= {{screen.Height}}) return;
                {{(screen.Hold ? "__drawn = true;" : "")}}
                const cell = y * {{screen.Width}} + x;
                __pixels[cell] = on ? color + __zero : __background;
                {{(UsesPixelIndices ? "__pixelIndices[cell] = on && index >= 0 && index <= 255 ? index + 1 : 0;" : "")}}
            }
            {{(UsesPixelIndices ? $$"""
            function __pixelIndexAt(x, y) {
                if (x < 0 || x >= {{screen.Width}} || y < 0 || y >= {{screen.Height}}) return -1;
                const index = __pixelIndices[y * {{screen.Width}} + x];
                return index === 0 ? -1 : index - 1;
            }
            """ : "")}}
            function __paint(cell, color) {
                const x = {{x}} + cell % {{screen.Width}};
                const y = {{y}} + Math.floor(cell / {{screen.Width}});
                world.setArrow(x, y, {{screen.Background.Type}}, 0, false, color);
            }
            function __present() {
                {{(screen.Hold ? "if (!__drawn) return;" : "")}}
                const previous = state.pixels ?? __blank;
                let changed = false;
                for (let cell = 0; cell < __pixels.length; cell++) {
                    const digit = __pixels[cell];
                    if (digit === previous.charCodeAt(cell)) continue;
                    __paint(cell, digit - __zero);
                    changed = true;
                }
                if (!changed) return;
                state.pixels = __frame();
            }
            """);
    }
}
