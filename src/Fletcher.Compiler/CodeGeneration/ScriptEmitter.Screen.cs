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

        // One code unit per cell keeps the rewindable state compact and
        // avoids allocating a new map and entry objects on each frame.
        Line("let __drawn;");
        if (UsesPixelIndices)
            Line($"const __pixelIndices = new Uint16Array({screen.PixelCount});");
        if (screen.RgbDisplay)
            EmitRgbScreenColors();
        if (screen.RgbLamps)
            EmitRgbLampScreen();
        var indexParameter = screen.UsesRgbPalette || UsesPixelIndices ? ", index" : "";
        var fallback = screen.RgbLamps ? "__rgbFallback[color]" : "color * 585";
        var pixelColor = screen.UsesRgbPalette
            ? $"(__hasRgbPalette && index >= 0 && index < 256 ? __rgbPatterns[index] : {fallback})"
            : "color";
        var packedBackground = screen.RgbLamps ? 0 : screen.Background.Extra * (screen.RgbDisplay ? 585 : 1);
        Line($$"""
            const __zero = {{(screen.UsesRgbPalette ? "0x1000" : "\"0\".charCodeAt(0)")}};
            const __background = __zero + {{packedBackground}};
            const __pixels = new {{(screen.UsesRgbPalette ? "Uint16Array" : "Uint8Array")}}({{screen.PixelCount}});
            const __blank = String.fromCharCode(__background).repeat(__pixels.length);
            function __frame() {
                let frame = "";
                for (let start = 0; start < __pixels.length; start += 1024)
                    frame += String.fromCharCode(...__pixels.subarray(start, start + 1024));
                return frame;
            }
            function __captureScreen(previous) { return previous ? state.pixels ?? __blank : __frame(); }
            function __preserveScreen(row = 0, rows = {{screen.Height}}) {
                const previous = state.pixels ?? __blank;
                const first = __min({{screen.Height}}, __max(0, row)) * {{screen.Width}};
                const end = __max(first, __min({{screen.Height}}, row + rows) * {{screen.Width}});
                for (let cell = first; cell < end; cell++)
                    __pixels[cell] = previous.charCodeAt(cell);
                {{(UsesPixelIndices ? "__pixelIndices.fill(0, first, end);" : "")}}
            }
            function __revealScreen(start, end, rows, columnsPerOffset) {
                if (columnsPerOffset <= 0) throw new Error("Fletcher revealScreen columns per offset must be positive");
                if (start.length !== __pixels.length || end.length !== __pixels.length)
                    throw new Error("Fletcher revealScreen frame has the wrong size");
            if ({{(screen.UsesRgbPalette
                    ? @"/[^\u1000-\u1fff]/.test(start) || /[^\u1000-\u1fff]/.test(end)"
                    : "/[^0-7]/.test(start) || /[^0-7]/.test(end)")}})
                    throw new Error("Fletcher revealScreen frame contains invalid palette data");
                if (rows.length < Math.ceil({{screen.Width}} / columnsPerOffset))
                    throw new Error("Fletcher revealScreen row offsets do not cover the screen width");
                for (let first = 0, band = 0; first < {{screen.Width}}; first += columnsPerOffset, band++) {
                    const last = __min(first + columnsPerOffset, {{screen.Width}});
                    const split = __min({{screen.Height}}, __max(0, rows[band]));
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
            function __pixel(x, y, on, color = {{screen.Foreground}}{{indexParameter}}) {
                if (x < 0 || x >= {{screen.Width}} || y < 0 || y >= {{screen.Height}}) return;
                {{(screen.Hold ? "__drawn = true;" : "")}}
                const cell = y * {{screen.Width}} + x;
                __pixels[cell] = on ? {{pixelColor}} + __zero : __background;
                {{(UsesPixelIndices ? "__pixelIndices[cell] = on && index >= 0 && index <= 255 ? index + 1 : 0;" : "")}}
            }
            {{(UsesPixelIndices ? $$"""
            function __pixelIndexAt(x, y) {
                if (x < 0 || x >= {{screen.Width}} || y < 0 || y >= {{screen.Height}}) return -1;
                const index = __pixelIndices[y * {{screen.Width}} + x];
                return index === 0 ? -1 : index - 1;
            }
            """ : "")}}
            {{(screen.RgbLamps ? $$"""
            function __paint(cell, pattern, previous) {
                const x = {{x}} + 3 * (cell % {{screen.Width}});
                const y = {{y}} + 3 * __floor(cell / {{screen.Width}});
                const changed = pattern ^ previous;
                for (let lane = 0; lane < __lampPairs.length; lane++) {
                    const shift = 2 * lane;
                    if ((changed & (3 << shift)) === 0) continue;
                    const [x1, y1, facing, x2, y2, signal] = __lampPairs[lane];
                    const level = (pattern >> shift) & 3;
                    const oldLevel = (previous >> shift) & 3;
                    const wasBright = oldLevel === 2;
                    const bright = level === 2;
                    if (wasBright !== bright)
                        world.setArrow(x + x1, y + y1, {{Screen.ForwardingLampType}}, facing, false, signal | (bright ? {{Screen.BrightLampFlag}} : 0));
                    // Changing brightness preserves the signal in Logic Arrows. Seed both
                    // directions on an on/off transition so the pair never alternates.
                    if (Boolean(level) === Boolean(oldLevel)) continue;
                    const active = level ? signal : 0;
                    world.setSignal(x + x1, y + y1, active);
                    world.setSignal(x + x2, y + y2, active);
                }
            }
            """ : screen.RgbDisplay ? "" : screen.ArrowDisplay ? $$"""
            // Palette color to a mask of red, blue, green, and yellow lamps.
            const __lampChannels = [15, 1, 2, 8, 4, 9, 3, 0];
            function __paint(cell, color, oldColor) {
                const left = {{x}} + (cell % {{screen.Width}}) * {{screen.Scale}};
                const top = {{y}} + __floor(cell / {{screen.Width}}) * {{screen.Scale}};
                const changed = __lampChannels[color] ^ __lampChannels[oldColor];
                if (changed & 1) world.setSignal(left, top, 1);
                if (changed & 2) world.setSignal(left + 1, top, 1);
                if (changed & 4) world.setSignal(left + 2, top, 1);
                if (changed & 8) world.setSignal(left + 3, top, 1);
            }
            """ : screen.Scale == 1 ? $$"""
            function __paint(cell, color) {
                const x = {{x}} + cell % {{screen.Width}};
                const y = {{y}} + __floor(cell / {{screen.Width}});
                world.setArrow(x, y, {{screen.Background.Type}}, 0, false, color);
            }
            """ : $$"""
            function __paint(cell, color) {
                const left = {{x}} + (cell % {{screen.Width}}) * {{screen.Scale}};
                const top = {{y}} + __floor(cell / {{screen.Width}}) * {{screen.Scale}};
                for (let y = top; y < top + {{screen.Scale}}; y++)
                    for (let x = left; x < left + {{screen.Scale}}; x++)
                        world.setArrow(x, y, {{screen.Background.Type}}, 0, false, color);
            }
            """)}}
            """);
        if (screen.RgbDisplay)
        {
            // Both frames use the same offset above the 12 packed color bits.
            // Walk wall coordinates together with the pixel index.
            Line($$"""
                function __present() {
                    {{(screen.Hold ? "if (!__drawn) return;" : "")}}
                    const previous = state.pixels ?? __blank;
                    let changed = false, cell = 0;
                    for (let top = {{y}}; top < {{y + 2 * screen.Height}}; top += 2) {
                        for (let left = {{x}}; left < {{x + 2 * screen.Width}}; left += 2, cell++) {
                            const digit = __pixels[cell];
                            const mask = digit ^ previous.charCodeAt(cell);
                            if (!mask) continue;
                            if (mask & 7) world.setArrow(left, top, {{screen.Background.Type}}, 0, false, digit & 7);
                            if (mask & 56) world.setArrow(left + 1, top, {{screen.Background.Type}}, 0, false, (digit >> 3) & 7);
                            if (mask & 448) world.setArrow(left, top + 1, {{screen.Background.Type}}, 0, false, (digit >> 6) & 7);
                            if (mask & 3584) world.setArrow(left + 1, top + 1, {{screen.Background.Type}}, 0, false, (digit >> 9) & 7);
                            changed = true;
                        }
                    }
                    if (changed) state.pixels = __frame();
                }
                """);
            return;
        }
        Line($$"""
            function __present() {
                {{(screen.Hold ? "if (!__drawn) return;" : "")}}
                const previous = state.pixels ?? __blank;
                let changed = false;
                for (let cell = 0; cell < __pixels.length; cell++) {
                    const digit = __pixels[cell];
                    const oldDigit = previous.charCodeAt(cell);
                    if (digit === oldDigit) continue;
                    __paint(cell, digit - __zero{{(screen.ArrowDisplay || screen.UsesRgbPalette ? ", oldDigit - __zero" : "")}});
                    changed = true;
                }
                if (!changed) return;
                state.pixels = __frame();
            }
            """);
    }

    private void EmitRgbLampScreen()
    {
        var pairs = string.Join(", ", Screen.LampPairs.Select(pair =>
            $"[{pair.First.X}, {pair.First.Y}, {pair.Facing}, {pair.Second.X}, {pair.Second.Y}, {pair.Signal}]"));
        Line($"const __lampPairs = [{pairs}];");
        Line("""
            // Mean sRGB of the 54 steady patterns rendered at two screen pixels
            // per tile with a dark theme and arrow bloom off. The swatches include
            // tile spacing and cross-channel bloom. Order is R, G, B, second G.
            const __lampSwatches = [
                [20,10,26], [24,51,30], [35,37,77], [41,81,79], [39,46,156], [46,87,156],
                [23,57,31], [25,98,33], [41,81,78], [41,117,80], [45,82,157], [46,125,157],
                [34,145,44], [35,168,46], [50,173,93], [51,193,92], [54,175,170], [56,194,170],
                [69,15,28], [70,53,35], [84,40,80], [86,84,80], [89,51,159], [90,92,158],
                [70,62,34], [70,102,36], [86,85,82], [88,118,80], [96,83,160], [94,126,159],
                [86,145,45], [86,168,48], [101,174,95], [101,194,93], [106,175,172], [106,194,172],
                [155,29,45], [158,69,53], [172,57,96], [173,102,98], [176,68,165], [176,109,167],
                [159,79,51], [160,119,53], [170,103,99], [170,135,97], [175,100,166], [176,143,166],
                [166,157,60], [166,180,62], [179,185,109], [180,205,109], [182,186,177], [180,206,178],
            ];
            const __lampMixes = [];
            for (let red = 0; red < 3; red++) for (let green = 0; green < 3; green++)
                for (let blue = 0; blue < 3; blue++) for (let green2 = 0; green2 < 2; green2++) {
                    const glow = Number(red === 2) + Number(green === 2) + Number(blue === 2);
                    const pattern = red | (green << 2) | (blue << 4) | (green2 << 6);
                    __lampMixes.push([__lampSwatches[__lampMixes.length], pattern, glow]);
                }
            const __rgbCache = new Map();
            const __rgbValues = new Uint32Array(256);
            const __rgbPatterns = new Uint16Array(256);
            let __hasRgbPalette = false;
            function __nearestLampMix(rgb) {
                const cached = __rgbCache.get(rgb);
                if (cached !== undefined) return cached;
                if (rgb === 0) return 0;
                const red = 8 + 0.68 * (rgb >> 16);
                const green = 8 + 0.68 * ((rgb >> 8) & 255);
                const blue = 8 + 0.68 * (rgb & 255);
                const neutral = Math.max(red, green, blue) - Math.min(red, green, blue) <= 8;
                const warm = red - green >= 4 && green - blue >= 4;
                const cool = blue - Math.max(red, green) >= 10;
                let best = Infinity, pattern = 0;
                for (const [[r, g, b], mix, glow] of __lampMixes) {
                    if (mix !== 0) {
                        if (neutral && Math.max(r, g, b) - Math.min(r, g, b) > 24) continue;
                        if (warm && !(r > g && g > b)) continue;
                        if (cool && b <= Math.max(r, g)) continue;
                    }
                    const dr = red - r, dg = green - g, db = blue - b;
                    const rg = dr - dg, bg = db - dg;
                    const distance = 3 * dr * dr + 5 * dg * dg + 3 * db * db + rg * rg + bg * bg + 70 * glow;
                    if (distance < best) { best = distance; pattern = mix; }
                }
                if (__rgbCache.size >= 16384) __rgbCache.clear();
                __rgbCache.set(rgb, pattern);
                return pattern;
            }
            const __rgbFallback = [0xffffff, 0xff0000, 0x0000ff, 0xffff00,
                0x00ff00, 0xffb033, 0x9933ff, 0].map(__nearestLampMix);
            function __screenPalette(colors) {
                for (let index = 0; index < 256; index++) {
                    const rgb = colors[index];
                    if (rgb === __rgbValues[index]) continue;
                    __rgbValues[index] = rgb;
                    __rgbPatterns[index] = __nearestLampMix(rgb);
                }
                __hasRgbPalette = true;
            }
            """);
    }

    private void EmitRgbScreenColors()
    {
        Line("""
            // The wall shader's relative RGB tints, in native wall color ID order.
            const __wallRgb = [0xffffff, 0xff0000, 0x80b3ff, 0xffff00, 0x00e600, 0xffb31a, 0xcc99e6, 0];
            const __mixes = [];
            for (let a = 0; a < 8; a++) for (let b = a; b < 8; b++)
                for (let c = b; c < 8; c++) for (let d = c; d < 8; d++) {
                    const colors = [__wallRgb[a], __wallRgb[b], __wallRgb[c], __wallRgb[d]];
                    // Store sums to preserve quarter-step precision. Identical pairs go on diagonals.
                    const r = colors.reduce((sum, color) => sum + (color >> 16), 0);
                    const g = colors.reduce((sum, color) => sum + ((color >> 8) & 255), 0);
                    const bSum = colors.reduce((sum, color) => sum + (color & 255), 0);
                    const neutral = (a === 0 || a === 7) && (b === 0 || b === 7) &&
                        (c === 0 || c === 7) && (d === 0 || d === 7);
                    // Opposing hues read as colored dots at the game's minimum zoom.
                    // Penalize variation in the red–green and blue–green channels.
                    let spread = 0;
                    for (const color of colors) {
                        const red = color >> 16, green = (color >> 8) & 255, blue = color & 255;
                        const rg = 4 * (red - green) - (r - g);
                        const bg = 4 * (blue - green) - (bSum - g);
                        spread += rg * rg + bg * bg;
                    }
                    __mixes.push([r, g, bSum, a | (c << 3) | (d << 6) | (b << 9), spread / 3, neutral]);
                }
            const __rgbCache = new Map();
            const __rgbValues = new Uint32Array(256);
            const __rgbPatterns = new Uint16Array(256).fill(4095);
            let __hasRgbPalette = false;
            function __nearestRgbMix(rgb) {
                const cached = __rgbCache.get(rgb);
                if (cached !== undefined) return cached;
                const red = rgb >> 16, green = (rgb >> 8) & 255, blue = rgb & 255;
                const neutral = Math.max(red, green, blue) - Math.min(red, green, blue) <= 8;
                const warm = green >= 40 && red - green >= 5 && green - blue >= 5;
                const deepBlue = blue >= 42 && blue - Math.max(red, green) >= 12;
                const r = 4 * red, g = 4 * green, b = 4 * blue;
                let best = Infinity, pattern = 4095;
                for (const mix of __mixes) {
                    if (neutral && !mix[5]) continue;
                    // Preserve the hue of muted browns and deep blues before comparing shades.
                    if (warm && (mix[0] <= mix[1] || mix[1] <= mix[2])) continue;
                    if (deepBlue && mix[2] <= Math.max(mix[0], mix[1])) continue;
                    const dr = r - mix[0], dg = g - mix[1], db = b - mix[2];
                    const distance = 3 * dr * dr + 6 * dg * dg + 2 * db * db + mix[4];
                    if (distance < best) {
                        best = distance;
                        pattern = mix[3];
                    }
                }
                if (__rgbCache.size >= 16384) __rgbCache.clear();
                __rgbCache.set(rgb, pattern);
                return pattern;
            }
            function __screenPalette(colors) {
                for (let index = 0; index < 256; index++) {
                    const rgb = colors[index];
                    if (rgb === __rgbValues[index]) continue;
                    __rgbValues[index] = rgb;
                    __rgbPatterns[index] = __nearestRgbMix(rgb);
                }
                __hasRgbPalette = true;
            }
            """);
    }
}
