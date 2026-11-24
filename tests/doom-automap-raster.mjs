import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const scratch = mkdtempSync(path.join(realpathSync(os.tmpdir()), "fletcher-doom-automap-raster-"));
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const unit = 65536;
const width = 13, height = 10;
const window = [-4 * unit, -3 * unit, 13 * unit, 10 * unit, unit, width, height];
const cases = [
    [-8 * unit, 2 * unit, 12 * unit, 2 * unit],
    [2 * unit, -8 * unit, 2 * unit, 12 * unit],
    [-8 * unit, -8 * unit, 12 * unit, 12 * unit],
    [-8 * unit, 12 * unit, 12 * unit, -8 * unit],
    [-8 * unit, 1 * unit, -5 * unit, 6 * unit],
    [-4 * unit, -3 * unit, 9 * unit, 7 * unit],
    [-4 * unit - 1, -3 * unit, 9 * unit, 7 * unit],
    [9 * unit, 7 * unit, -4 * unit, -3 * unit],
    [-3 * unit - 1, 7 * unit + 1, 9 * unit + 1, -3 * unit - 1],
    [0, -3 * unit, 0, 7 * unit],
];

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: root, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function sourcePart(source, start, end) {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `missing ${start} in pinned am_map.c`);
    return source.slice(first, last);
}

function native(upstream) {
    const source = readFileSync(path.join(root, upstream, "am_map.c"), "utf8").replaceAll("\r\n", "\n");
    const clip = sourcePart(source, "boolean\nAM_clipMline", "//\n// Classic Bresenham")
        .replace(/register\s+outcode1/g, "register int outcode1")
        .replace(/register\s+outcode2/g, "register int outcode2")
        .replace(/register\s+outside/g, "register int outside");
    const draw = sourcePart(source, "void\nAM_drawFline", "//\n// Clip lines, draw visible")
        .replace(/static\s+fuck/g, "static int fuck");
    const input = path.join(scratch, "raster.c"), exe = path.join(scratch, "raster.exe");
    writeFileSync(input, `#include <stdio.h>
#include <string.h>
typedef int boolean;
enum { false, true };
typedef int fixed_t;
typedef struct { int x, y; } fpoint_t;
typedef struct { fpoint_t a, b; } fline_t;
typedef struct { fixed_t x, y; } mpoint_t;
typedef struct { mpoint_t a, b; } mline_t;
static int f_x, f_y, f_w = ${width}, f_h = ${height};
static fixed_t m_x = ${window[0]}, m_y = ${window[1]}, m_x2 = ${window[0] + window[2]}, m_y2 = ${window[1] + window[3]};
static fixed_t scale_mtof = ${unit};
static unsigned char framebuffer[${width * height}], *fb = framebuffer;
static fixed_t FixedMul(fixed_t a, fixed_t b) { return (fixed_t)(((long long)a * b) >> 16); }
#define MTOF(x) (FixedMul((x),scale_mtof)>>16)
#define CXMTOF(x) (f_x + MTOF((x)-m_x))
#define CYMTOF(y) (f_y + (f_h - MTOF((y)-m_y)))
${clip}
${draw}
static const int cases[][4] = { ${cases.map(c => `{${c.join(",")}}`).join(",")} };
int main(void) {
    for (int i = 0; i < ${cases.length}; ++i) {
        mline_t map = {{cases[i][0], cases[i][1]}, {cases[i][2], cases[i][3]}};
        fline_t line; boolean valid = AM_clipMline(&map, &line);
        printf("%d,%d,%d,%d,%d\\n", valid, valid ? line.a.x : 0, valid ? line.a.y : 0, valid ? line.b.x : 0, valid ? line.b.y : 0);
        if (valid) AM_drawFline(&line, 1);
    }
    for (int i = 0; i < ${width * height}; ++i) putchar(framebuffer[i] ? '1' : '0');
    putchar('\\n');
}
`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", input, "-o", exe]);
    const rows = run(exe, []).trim().split(/\r?\n/);
    return { lines: rows.slice(0, cases.length).map(row => row.split(",").map(Number)), pixels: rows.at(-1) };
}

function fletcher() {
    const input = path.join(scratch, "main.flt"), output = path.join(scratch, "raster.json");
    const calls = cases.map((values, index) => `        line${index} := automap.ClipLine(view, ${values.join(", ")})
        log(line${index}.Valid, line${index}.X1, line${index}.Y1, line${index}.X2, line${index}.Y2)
        automap.DrawLine(view, ${values.join(", ")}, color.Red)`).join("\n");
    writeFileSync(input, `package main
import "automap"

map "Doom automap raster parity" {
    screen at (0, 0) size (${width}, ${height}) with { style = "solid", slice = true }
    tick {
        view := automap.Window{X: ${window[0]}, Y: ${window[1]}, MapWidth: ${window[2]}, MapHeight: ${window[3]}, Scale: ${window[4]}, Width: ${width}, Height: ${height}}
${calls}
    }
}
`);
    run("dotnet", [cli, "build", input, "--package-root", path.join(root, "examples/doom-engine"), "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    sim.step();
    const pixels = Array.from({ length: width * height }, (_, index) =>
        sim.tileAt({ x: index % width, y: Math.floor(index / width) }).extra === 1 ? "1" : "0").join("");
    return { lines: sim.logs.map(([valid, x1, y1, x2, y2]) => [Number(valid), x1 ?? 0, y1 ?? 0, x2 ?? 0, y2 ?? 0]), pixels };
}

try {
    const actual = fletcher();
    if (values.upstream) {
        const expected = native(values.upstream);
        assert.deepEqual(actual.lines, expected.lines, "AM_clipMline output");
        assert.equal(actual.pixels, expected.pixels, "AM_drawFline pixels");
        console.log(`Matched ${cases.length} automap clipping cases and ${width * height} raster pixels with pinned C.`);
    } else {
        assert.deepEqual(actual.lines, [
            [1, 0, 5, 12, 5], [1, 6, 9, 6, 0], [1, 1, 9, 10, 0], [1, 1, 0, 11, 9], [0, 0, 0, 0, 0],
            [1, 0, 9, 12, 1], [1, 0, 9, 12, 1], [1, 12, 0, 0, 9], [1, 0, 0, 11, 9], [1, 4, 9, 4, 0],
        ]);
        assert.equal(actual.pixels, "1100101000101011010100101100111010111100000101111000000011111000011111111111110000111110000000110101100001101010001001100101000010");
        console.log(`Verified ${cases.length} automap clipping cases and ${width * height} raster pixels against the pinned snapshot.`);
    }
} finally {
    assert.match(path.relative(realpathSync(os.tmpdir()), realpathSync(scratch)), /^fletcher-doom-automap-raster-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
