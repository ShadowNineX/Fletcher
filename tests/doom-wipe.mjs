import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "src", "Fletcher.Cli", "bin", "Debug", "net11.0", "fletcher.dll");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-wipe-"));
const width = 8, height = 20, frames = 18;
const { values } = parseArgs({ options: { upstream: { type: "string" } } });

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function sourcePixel(x, y) { return (y * width + x) % 120 + 1; }
function targetPixel(x, y) { return sourcePixel(x, y) + 120; }

function nativeTrace(upstream) {
    const original = filename => readFileSync(path.join(upstream, filename), "utf8").replace(/^\s*#include [^\r\n]+/gm, "");
    const random = existsSync(path.join(upstream, "m_random.c")) ? "m_random.c" : "light-m_random.c";
    const source = path.join(scratch, "wipe-native.c");
    const binary = path.join(scratch, process.platform === "win32" ? "wipe-native.exe" : "wipe-native");
    writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef unsigned char byte;
typedef int boolean;
#define true 1
#define false 0
#define PU_STATIC 1
#define rcsid random_rcsid
${original(random)}
#undef rcsid
static void *Z_Malloc(size_t bytes, int tag, void *owner) { return malloc(bytes); }
static void Z_Free(void *memory) { free(memory); }
static byte *screens[4];
static void I_ReadScreen(byte *memory) { }
static void V_DrawBlock(int x, int y, int screen, int width, int height, byte *memory) { }
void V_MarkRect(int x, int y, int width, int height) { }
${original("f_wipe.c")}
int main(void) {
    const int width = ${width}, height = ${height};
    wipe_scr_start = malloc(width * height);
    wipe_scr_end = malloc(width * height);
    wipe_scr = malloc(width * height);
    for (int i = 0; i < width * height; ++i) {
        wipe_scr_start[i] = i % 120 + 1;
        wipe_scr_end[i] = i % 120 + 121;
    }
    wipe_initMelt(width, height, 0);
    boolean active = true;
    for (int frame = 0; frame < ${frames}; ++frame) {
        printf("%d %d", rndindex, active);
        for (int i = 0; i < width; ++i) printf(" %d", y[i]);
        for (int i = 0; i < width * height; ++i) printf(" %d", wipe_scr[i]);
        puts("");
        if (frame > 0 && active) active = !wipe_doMelt(width, height, frame == 11 ? 40 : 1);
    }
    wipe_exitMelt(width, height, 0);
    free(wipe_scr_start);
    free(wipe_scr_end);
    free(wipe_scr);
    return 0;
}
`);
    run(process.env.CC ?? "gcc", ["-std=c99", "-O2", "-fno-strict-aliasing", source, "-o", binary]);
    return run(binary, []).trim().split(/\r?\n/).map(row => row.split(/\s+/).map(Number));
}

function opening() {
    const source = readFileSync(path.join(root, "examples", "doom-engine", "play", "random.flt"), "utf8");
    const values = Array.from(source.match(/const RandomTable[\s\S]*?\{([\s\S]*?)\n\}/)[1].matchAll(/\d+/g), match => Number(match[0]));
    let menu = 0;
    const roll = () => values[menu = (menu + 1) & 255];
    const rows = Array(width).fill(0);
    rows[0] = -(roll() & 15);
    for (let column = 1; column < width; column++) {
        rows[column] = rows[column - 1] + roll() % 3 - 1;
        if (rows[column] > 0) rows[column] = 0;
        if (rows[column] === -16) rows[column] = -15;
    }
    return { menu, rows, active: true };
}

function tick(state, ticks) {
    if (!state.active || ticks <= 0) return state;
    let moved = false;
    for (let elapsed = 0; elapsed < ticks; elapsed++) {
        for (let pair = 0; pair < width / 2; pair++) {
            const row = state.rows[pair];
            if (row < 0) { state.rows[pair]++; moved = true; }
            else if (row < height) {
                state.rows[pair] += Math.min(row < 16 ? row + 1 : 8, height - row);
                moved = true;
            }
        }
    }
    state.active = moved;
    return state;
}

function composite(state) {
    return Array.from({ length: height }, (_, row) => Array.from({ length: width }, (_, column) => {
        const split = Math.max(0, Math.min(height, state.rows[Math.floor(column / 2)]));
        return row < split ? targetPixel(column, row) : sourcePixel(column, row - split);
    }));
}

function expected() {
    const state = opening(), output = [];
    output.push({ tick: 0, menu: state.menu, active: state.active, rows: [...state.rows], pixels: composite(state) });
    for (let tic = 1; tic < frames; tic++) {
        output.push({ tick: tic, menu: -1, active: state.active, rows: [...state.rows], pixels: composite(state) });
        tick(state, tic === 11 ? 40 : 1);
    }
    return output;
}

function observe() {
    const input = path.join(scratch, "wipe.flt"), output = path.join(scratch, "wipe.json");
    writeFileSync(input, `package main
import "play"

map "Doom melt wipe" {
    screen at (0, 0) size (1, 1) with { style = "solid" }
    register wipe play.MeltState = play.MeltState{}
    register menu int = -1
    register started bit = false
    tick {
        state := wipe
        seenMenu := menu
        if !started {
            opening := play.StartMelt(${width}, ${height}, play.RandomState{})
            state = opening.State
            seenMenu = opening.Random.MenuIndex
            next wipe = opening.State
            next menu = opening.Random.MenuIndex
            next started = true
        } else if currentTick() == 11 {
            next wipe = play.TickMelt(wipe, 40)
        } else {
            next wipe = play.TickMelt(wipe, 1)
        }
        for row := range ${height} {
            log(currentTick(), seenMenu, state.Active, state.Rows[0], state.Rows[1], state.Rows[2], state.Rows[3], state.Rows[4], state.Rows[5], state.Rows[6], state.Rows[7],
                play.MeltUsesEnd(state, 0, row), play.MeltUsesEnd(state, 1, row), play.MeltUsesEnd(state, 2, row), play.MeltUsesEnd(state, 3, row),
                play.MeltUsesEnd(state, 4, row), play.MeltUsesEnd(state, 5, row), play.MeltUsesEnd(state, 6, row), play.MeltUsesEnd(state, 7, row))
        }
    }
}
`);
    run("dotnet", [cli, "build", input, "--package-root", path.join(root, "examples", "doom-engine"), "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let tic = 0; tic < frames; tic++) sim.step();
    const grouped = new Map();
    for (const raw of sim.logs) {
        const values = raw.map(value => typeof value === "bigint" ? Number(value) : value);
        const [tic, menu, active, ...rest] = values;
        if (!grouped.has(Number(tic))) grouped.set(Number(tic), { tick: Number(tic), menu: Number(menu), active: Boolean(active), rows: rest.slice(0, width).map(Number), pixels: [] });
        grouped.get(Number(tic)).pixels.push(rest.slice(width).map(Boolean));
    }
    return Array.from(grouped.values());
}

try {
    const actual = observe(), want = expected();
    const native = values.upstream ? nativeTrace(path.resolve(root, values.upstream)) : null;
    assert.equal(actual.length, want.length);
    actual.forEach((frame, index) => {
        const target = want[index];
        assert.equal(frame.tick, target.tick);
        if (index === 0) assert.equal(frame.menu, width, "init consumes one M_Random value per physical column");
        assert.equal(frame.active, target.active, `active state at frame ${index}`);
        assert.deepEqual(frame.rows, target.rows, `all initialized rows at frame ${index}`);
        const observed = frame.pixels.map((row, y) => row.map((usesEnd, x) => {
            const split = Math.max(0, Math.min(height, frame.rows[Math.floor(x / 2)]));
            assert.equal(usesEnd, y < split, `source for pixel ${x},${y} of frame ${index}`);
            return usesEnd ? targetPixel(x, y) : sourcePixel(x, y - split);
        }));
        assert.deepEqual(observed, target.pixels, `synthetic two-frame composition at frame ${index}`);
        if (native) assert.deepEqual([frame.menu, Number(frame.active), ...frame.rows, ...observed.flat()], native[index],
            `native Doom C frame ${index}`);
    });
    assert.ok(actual[12].rows.slice(0, width / 2).every(row => row === height));
    assert.equal(actual[12].active, true, "a multi-tic call remains active when movement completed within it");
    assert.equal(actual[13].active, false, "the following call reports completion");
    console.log("Matched Doom's paired-word melt columns, full RNG initialization, frame composition, and sticky completion.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-wipe-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
