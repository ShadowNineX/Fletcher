// Walk one-shot and repeatable light linedefs through the production level overlay.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const scratch = mkdtempSync(path.join(os.tmpdir(), "fletcher-consumed-lines-"));
const lineCount = 65536;
const oneShots = [...Array.from({ length: 49 }, (_, index) => index), 63, 64, 255, 256, 4095, 4096, 32767, 32768, 65534, 65535];
const actions = new Map(oneShots.map((index, i) => [index, i % 2 === 0 ? 13 : 35]));
const dimmer = 32001, brightener = 32002;
actions.set(dimmer, 79);
actions.set(brightener, 81);
const crossings = [...oneShots, dimmer, ...oneShots, brightener, dimmer];

function run(exe, args) {
    const result = spawnSync(exe, args, { cwd: root, encoding: "utf8", timeout: 45000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function fletcherTrace() {
    const vertices = Buffer.alloc(8), side = Buffer.alloc(30), sector = Buffer.alloc(26);
    vertices.writeInt16LE(64, 4);
    sector.writeInt16LE(128, 2);
    sector.writeInt16LE(160, 20);
    sector.writeInt16LE(7, 24);
    const lines = Buffer.alloc(lineCount * 14);
    for (const [index, action] of actions) {
        const offset = index * 14;
        lines.writeUInt16LE(1, offset + 2);
        lines.writeUInt16LE(action, offset + 6);
        lines.writeUInt16LE(7, offset + 8);
        lines.writeUInt16LE(65535, offset + 12);
    }
    writeFileSync(path.join(scratch, "LINES.BIN"), Buffer.concat([vertices, side, sector, lines]));
    const entry = path.join(scratch, "main.flt"), output = path.join(scratch, "lines.json");
    writeFileSync(entry, `package main
import "play"
import "wad"
const Records = readFile("LINES.BIN")
const Crossings = [${crossings.length}]int{${crossings.join(", ")}}
map "One-shot linedefs" {
    register state play.LevelSpecials = play.LevelSpecials{}
    register step int = 0
    tick {
        base := wad.BspLevel{File: Records, Valid: true,
            Vertices: wad.Lump{Valid: true, Offset: 0, Count: 2},
            Sides: wad.Lump{Valid: true, Offset: 8, Count: 1},
            Sectors: wad.Lump{Valid: true, Offset: 38, Count: 1},
            Lines: wad.Lump{Valid: true, Offset: 64, Count: ${lineCount}}}
        index := Crossings[step]
        level := state.ApplyTo(base)
        before := level.LineAt(index).Action
        changed := play.CrossLevelSpecial(level, state, index)
        level = changed.ApplyTo(base)
        log(index, before, level.LineAt(index).Action, changed.Doors.UsedCount, changed.Lighting.Lights.LightAt(0, level.SectorLight(0)))
        next state = changed
        next step = step + 1
    }
}`);
    run("dotnet", [cli, "build", entry, "--package-root", path.join(root, "examples", "doom-engine"), "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
    for (const index of crossings) {
        sim.step();
        if (index === 32768 && sim.logs.length <= oneShots.length) sim.roundTripScriptState();
    }
    return sim.logs.map(row => Array.from(row, Number));
}

function nativeTrace(directory) {
    const read = name => readFileSync(path.join(directory, name), "utf8").replaceAll("\r\n", "\n");
    const specials = read("animated-p_spec.c");
    const cross = extractFunction(specials, "void", "P_CrossSpecialLine");
    const unsupported = [...new Set(cross.match(/\b(?:EV_|G_)[A-Za-z]+\b/g))].filter(name => name !== "EV_LightTurnOn");
    const source = path.join(scratch, "cross.c");
    const exe = path.join(scratch, process.platform === "win32" ? "cross.exe" : "cross");
    writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
typedef struct sector_s sector_t;
typedef struct { int special, tag, flags; sector_t *frontsector,*backsector; } line_t;
struct sector_s { int tag, lightlevel, linecount; line_t **lines; };
typedef struct { int player, type; } mobj_t;
static line_t lines[${lineCount}];
static sector_t sectors[] = {{7, 160, 0, NULL}};
static int numsectors = 1;
enum { ML_TWOSIDED=4, MT_ROCKET, MT_PLASMA, MT_BFG, MT_TROOPSHOT, MT_HEADSHOT, MT_BRUISERSHOT };
${unsupported.map(name => `#define ${name}(...) abort()`).join("\n")}
${extractFunction(specials, "sector_t\\*", "getNextSector")}
${extractFunction(read("light-p_lights.c"), "void", "EV_LightTurnOn")}
${cross}
int main(void) {
    const int crossings[] = {${crossings.join(",")}};
    mobj_t player = {.player=1};
    int used = 0;
    ${[...actions].map(([index, special]) => `lines[${index}] = (line_t){.special=${special}, .tag=7};`).join("\n    ")}
    for (unsigned i=0; i<sizeof(crossings)/sizeof(crossings[0]); ++i) {
        int index=crossings[i], old=lines[index].special;
        P_CrossSpecialLine(index, 0, &player);
        if (old && !lines[index].special) ++used;
        printf("%d,%d,%d,%d,%d\\n", index, old, lines[index].special, used, sectors[0].lightlevel);
    }
    return 0;
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(row => row.split(",").map(Number));
}

try {
    const observed = fletcherTrace();
    const expected = values.upstream ? nativeTrace(path.resolve(root, values.upstream)) : null;
    assert.equal(observed.length, crossings.length);
    for (const [i, index] of oneShots.entries()) {
        const action = actions.get(index), light = action === 13 ? 255 : 35;
        assert.deepEqual(observed[i], [index, action, 0, i + 1, light], `consume linedef ${index} (one-shot ${i + 1})`);
    }
    for (const [i, index] of oneShots.entries()) {
        assert.deepEqual(observed[oneShots.length + 1 + i], [index, 0, 0, oneShots.length, 35], `revisit linedef ${index}`);
    }
    const dim = [dimmer, 79, 79, oneShots.length, 35], bright = [brightener, 81, 81, oneShots.length, 255];
    assert.deepEqual(observed[oneShots.length], dim);
    assert.deepEqual(observed.slice(-2), [bright, dim]);
    if (expected) assert.deepEqual(observed, expected, "native P_CrossSpecialLine and EV_LightTurnOn");
    console.log(`Consumed ${oneShots.length} distinct linedefs through index 65535 across a script-state JSON round trip; checked ${observed.length} crossings${expected ? " against pinned C" : ""}.`);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
