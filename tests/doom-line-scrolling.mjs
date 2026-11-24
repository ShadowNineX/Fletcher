// Compare the pinned line scans in P_SpawnSpecials and P_UpdateSpecials.
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
const upstream = path.resolve(root, values.upstream ?? "artifacts/doom-upstream");
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const unit = 65536, tics = 12;
const stockOffsets = [3, -1, 32767];
const stockLines = [[48, 0, 1], [47, 1, 0], [48, 2, 1], [48, 2, 0],
    ...Array.from({ length: 61 }, () => [48, 0, 1]), [0, 1, 2]];
const denseSides = [1, 2, 31, 32, 33, 1023, 1024, 1099, 1100];
const denseOffsets = Array.from({ length: 1101 }, (_, i) => i === 1099 ? 32767 : i - 500);
const denseLines = [
    ...Array.from({ length: 64 }, () => [48, 31, 32]),
    [48, 1024, 31], [48, 32, 1099], [48, 1023, 1],
    ...Array.from({ length: 80 }, (_, i) => [48, i % 3 === 0 ? 1099 : 1024, 1100]),
    [47, 33, 31], [0, 2, 1099], [48, 1, 2],
];
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-line-scroll-"));

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function fletcherRows(offsets, lines, tracked, base) {
    const sides = Buffer.alloc(30 * offsets.length), lineRecords = Buffer.alloc(14 * lines.length);
    offsets.forEach((offset, side) => sides.writeInt16LE(offset, 30 * side));
    for (const [index, [special, front, back]] of lines.entries()) {
        lineRecords.writeInt16LE(special, 14 * index + 6);
        lineRecords.writeInt16LE(front, 14 * index + 10);
        lineRecords.writeInt16LE(back, 14 * index + 12);
    }
    writeFileSync(path.join(scratch, "lines.bin"), Buffer.concat([Buffer.alloc(base), sides, lineRecords]));
    const entry = path.join(scratch, "main.flt"), output = path.join(scratch, "scroll.json");
    writeFileSync(entry, `package main
import "play"
import "wad"
const Lines = readFile("lines.bin")
map "Native scroll line scan" {
    register saved play.LineScrolls = play.LineScrolls{}
    tick {
        level := wad.BspLevel{File: Lines, Valid: true,
            Sides: wad.Lump{Valid: true, Count: ${offsets.length}, Offset: ${base}},
            Lines: wad.Lump{Valid: true, Count: ${lines.length}, Offset: ${base + sides.length}}}
        scrolls := saved
        if currentTick() == 0 { scrolls = play.LoadLineScrolls(level) }
        log(currentTick(), scrolls.Count, ${tracked.map(i => {
            const offset = base + 30 * i;
            return `level.SideMaterialAt(${offset}).OffsetU + scrolls.OffsetForSide(${offset})`;
        }).join(", ")})
        next saved = scrolls.Advance()
    }
}
`);
    run("dotnet", [cli, "build", entry, "--package-root", path.join(root, "examples/doom-engine"), "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let tic = 0; tic < tics; tic++) {
        if (tic === 4) sim.roundTripScriptState();
        sim.step();
    }
    return Array.from(sim.logs, row => Array.from(row, Number));
}

function nativeRows(offsets, lines, tracked, capacity) {
    const source = path.join(scratch, "scroll.c"), exe = path.join(scratch, process.platform === "win32" ? "scroll.exe" : "scroll");
    const spec = readFileSync(path.join(upstream, "p_spec.c"), "utf8").replaceAll("\r\n", "\n");
    function region(from, to) {
        const start = spec.indexOf(from), end = spec.indexOf(to, start + from.length);
        assert.ok(start >= 0 && end > start, `locate native ${from} scan`);
        const scan = spec.slice(start, end).trim();
        assert.ok(scan.includes("case 48:"));
        return scan;
    }
    writeFileSync(source, `#include <stdio.h>
enum { FRACUNIT=${unit}, MAXLINEANIMS=${capacity} };
typedef struct { int textureoffset; } side_t;
typedef struct { int special, sidenum[2]; } line_t;
static side_t sides[]={${offsets.map(offset => `{${offset}*FRACUNIT}`).join(",")}};
static line_t lines[]={${lines.map(([special, front, back]) => `{${special},{${front},${back}}}`).join(",")}};
static int numlines=sizeof lines/sizeof lines[0], numlinespecials;
static line_t *linespeciallist[MAXLINEANIMS];
static void load(void) {
    int i;
    ${region("numlinespecials = 0;", "//\tInit other misc stuff")}
}
static void advance(void) {
    int i;
    line_t *line;
    ${region("//\tANIMATE LINE SPECIALS", "//\tDO BUTTONS")}
}
int main(void) {
    load();
    for (int tic=0;tic<${tics};++tic) {
        printf("%d,%d${",%d".repeat(tracked.length)}\\n",tic,numlinespecials,${tracked.map(i => `sides[${i}].textureoffset`).join(",")});
        advance();
    }
}
`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(row => row.split(",").map(Number));
}

try {
    const tracked = [0, 1, 2];
    const native = nativeRows(stockOffsets, stockLines, tracked, 64);
    assert.deepEqual(native[0], [0, 64, 3 * unit, -unit, 32767 * unit]);
    assert.deepEqual(native[1], [1, 64, 65 * unit, -unit, -32767 * unit], "shared sides advance per line and preserve signed wraparound");
    assert.deepEqual(fletcherRows(stockOffsets, stockLines, tracked, 0), native, "compiled offsets match the exact native scans");
    const dense = nativeRows(denseOffsets, denseLines, denseSides, denseLines.length);
    const count = denseLines.filter(([special]) => special === 48).length;
    assert.deepEqual(dense[1], [1, count, ...denseSides.map(i => {
        const weight = denseLines.filter(([special, front]) => special === 48 && front === i).length;
        return ((denseOffsets[i] + weight) * unit) | 0;
    })]);
    assert.deepEqual(fletcherRows(denseOffsets, denseLines, denseSides, 17), dense,
        "all dense scrolls keep contributing across page boundaries and a state round trip");
    console.log(`Matched special 48 startup and ${tics} tics at 64 stock and ${count} dense scrolls with shared sidedefs.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-line-scroll-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
