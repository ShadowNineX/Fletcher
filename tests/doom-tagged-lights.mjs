import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(path.join(artifacts, "doom-tagged-lights-"));
const source = path.join(scratch, "main.flt");
const output = path.join(scratch, "output.json");
const lastTic = 80;

const carry = {
    sectors: [{ light: 160, tag: 7, special: 4 }, { light: 100, tag: 7 },
        { light: 200, tag: 0 }, { light: 240, tag: 0 }],
    links: [[0, 2], [1, 3]],
};
const minimum = {
    sectors: [{ light: 160, tag: 8 }, { light: 96, tag: 8 }, { light: 32, tag: 0 }],
    links: [[0, 2], [0, 1]],
};
const strobe = {
    sectors: [{ light: 128, tag: 9 }, { light: 160, tag: 9 }, { light: 64, tag: 0 }],
    links: [[0, 2], [1, 2]],
};

// A validated little-endian map record set. Every line is two-sided and has
// its own pair of sidedefs, so the Fletcher code follows Doom's neighbor
// traversal rather than a test-only adjacency representation.
function level(sectors, links) {
    const sectorData = Buffer.alloc(sectors.length * 26);
    for (const [index, { light, tag, special = 0 }] of sectors.entries()) {
        const offset = index * 26;
        sectorData.writeInt16LE(light, offset + 20);
        sectorData.writeInt16LE(special, offset + 22);
        sectorData.writeInt16LE(tag, offset + 24);
    }
    const lineData = Buffer.alloc(links.length * 14);
    const sideData = Buffer.alloc(links.length * 2 * 30);
    for (const [index, [front, back]] of links.entries()) {
        const offset = index * 14;
        lineData.writeUInt16LE(0, offset);
        lineData.writeUInt16LE(1, offset + 2);
        lineData.writeUInt16LE(4, offset + 4);
        lineData.writeUInt16LE(index * 2, offset + 10);
        lineData.writeUInt16LE(index * 2 + 1, offset + 12);
        sideData.writeUInt16LE(front, index * 2 * 30 + 28);
        sideData.writeUInt16LE(back, (index * 2 + 1) * 30 + 28);
    }
    const vertices = Buffer.alloc(8);
    vertices.writeInt16LE(64, 4);
    return Buffer.concat([sectorData, lineData, sideData, vertices]);
}

function run() {
    const build = spawnSync("dotnet", [cli, "build", source, "--package-root", port,
        "--asset-root", scratch, "-o", output], { encoding: "utf8", cwd: root, timeout: 15_000 });
    assert.equal(build.status, 0, build.error?.message ?? build.stderr);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
    for (let tic = 0; tic <= lastTic; tic++) sim.step();
    return JSON.parse(JSON.stringify(sim.logs));
}

function records(file, { sectors, links }) {
    writeFileSync(path.join(scratch, file.toLowerCase() + ".bin"), level(sectors, links));
    const sides = sectors.length * 26 + links.length * 14;
    return `wad.BspLevel{Valid: true, File: ${file}, Sectors: wad.Lump{Valid: true, Count: ${sectors.length}},
        Lines: wad.Lump{Valid: true, Count: ${links.length}, Offset: ${sectors.length * 26}},
        Sides: wad.Lump{Valid: true, Count: ${links.length * 2}, Offset: ${sides}},
        Vertices: wad.Lump{Valid: true, Count: 2, Offset: ${sides + links.length * 60}}}`;
}

function nativeTrace(lightPath, specPath, randomPath) {
    const read = file => readFileSync(path.resolve(root, file), "utf8").replaceAll("\r\n", "\n");
    const lights = read(lightPath), specials = read(specPath), random = read(randomPath);
    function routine(pattern) {
        const start = specials.search(pattern);
        const last = specials.indexOf("\n}", start);
        assert.ok(start >= 0 && last > start, `locate ${pattern}`);
        return specials.slice(start, last + 2);
    }
    const strobeStart = lights.indexOf("void T_StrobeFlash");
    const strobeEnd = lights.indexOf("// Spawn glowing light", strobeStart);
    const randomStart = random.indexOf("unsigned char rndtable");
    assert.ok(strobeStart >= 0 && strobeEnd > strobeStart && randomStart >= 0);
    function load({ sectors, links }) {
        const initial = sectors.map(({ light, tag, special = 0 }) => `{${light},${tag},${special}}`).join(",");
        const edges = links.map(([front, back]) => `{${front},${back}}`).join(",");
        return `load(${sectors.length}, (const int[][3]){${initial}}, ${links.length}, (const int[][2]){${edges}});`;
    }
    const program = path.join(scratch, "tagged-lights.c");
    const executable = path.join(scratch, process.platform === "win32" ? "tagged-lights.exe" : "tagged-lights");
    writeFileSync(program, `#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { ML_TWOSIDED = 4, STROBEBRIGHT = 5, SLOWDARK = 35, PU_LEVSPEC = 51 };
typedef struct sector sector_t;
typedef struct { int flags, tag; sector_t *frontsector, *backsector; } line_t;
struct sector { short lightlevel, tag, special; int linecount; line_t **lines; void *specialdata; };
typedef void (*actionf_p1)(void *);
typedef struct { union { actionf_p1 acp1; } function; } thinker_t;
typedef struct { thinker_t thinker; sector_t *sector; int count, minlight, maxlight, darktime, brighttime; } strobe_t;
static sector_t sectors[4];
static line_t lines[4];
static line_t *memberships[4][4];
static int numsectors;
static thinker_t *thinkers[8];
static int active;

static void *Z_Malloc(size_t size, int tag, void *user) {
    (void)tag;
    (void)user;
    void *result = calloc(1, size);
    if (!result) exit(1);
    return result;
}

static void P_AddThinker(thinker_t *thinker) {
    if (active >= 8) exit(2);
    thinkers[active++] = thinker;
}

${routine(/\nsector_t\*\s+getNextSector\s*\n/)}
${routine(/\nint\s+P_FindSectorFromLineTag\s*\n/)}
${routine(/\nint\s+P_FindMinSurroundingLight\s*\n/)}
${random.slice(randomStart)}
${lights.slice(strobeStart, strobeEnd)}

static void load(int count, const int values[][3], int edgeCount, const int edges[][2]) {
    numsectors = count;
    memset(sectors, 0, sizeof sectors);
    for (int i = 0; i < count; ++i) {
        sectors[i].lightlevel = values[i][0];
        sectors[i].tag = values[i][1];
        sectors[i].special = values[i][2];
        sectors[i].lines = memberships[i];
    }
    for (int i = 0; i < edgeCount; ++i) {
        sector_t *front = &sectors[edges[i][0]];
        sector_t *back = &sectors[edges[i][1]];
        lines[i] = (line_t){ML_TWOSIDED, 0, front, back};
        front->lines[front->linecount++] = &lines[i];
        back->lines[back->linecount++] = &lines[i];
    }
}

int main(void) {
    line_t trigger = {.tag = 7};
    ${load(carry)}
    EV_LightTurnOn(&trigger, 0);
    printf("%d %d %d\\n", sectors[0].lightlevel, sectors[1].lightlevel, sectors[0].special);
    EV_LightTurnOn(&trigger, 255);
    printf("%d %d ", sectors[0].lightlevel, sectors[1].lightlevel);
    EV_LightTurnOn(&trigger, 35);
    printf("%d %d\\n", sectors[0].lightlevel, sectors[1].lightlevel);

    ${load(minimum)}
    trigger.tag = 8;
    EV_TurnTagLightsOff(&trigger);
    printf("%d %d\\n", sectors[0].lightlevel, sectors[1].lightlevel);

    ${load(strobe)}
    trigger.tag = 9;
    M_ClearRandom();
    sectors[0].specialdata = &lines[0];
    EV_StartLightStrobing(&trigger);
    printf("%d %d ", active, prndindex);
    EV_StartLightStrobing(&trigger);
    printf("%d %d %d %d\\n", active, prndindex, ((strobe_t*)thinkers[0])->count, ((strobe_t*)thinkers[1])->count);
    for (int tic = 1; tic <= ${lastTic}; ++tic) {
        if (tic == 10) EV_LightTurnOn(&trigger, 35);
        if (tic == 40) {
            sectors[0].specialdata = NULL;
            EV_StartLightStrobing(&trigger);
        }
        for (int i = 0; i < active; ++i) T_StrobeFlash((strobe_t*)thinkers[i]);
        printf("%d %d %d %d %d %d %d\\n", tic, sectors[0].lightlevel, sectors[1].lightlevel,
            active, prndindex, ((strobe_t*)thinkers[0])->count, ((strobe_t*)thinkers[1])->count);
    }
    for (int i = 0; i < active; ++i) free(thinkers[i]);
    return 0;
}
`);
    const compile = spawnSync("gcc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", program, "-o", executable],
        { encoding: "utf8", timeout: 15_000 });
    assert.equal(compile.status, 0, compile.error?.message ?? compile.stderr);
    const result = spawnSync(executable, [], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout.trim().split(/\r?\n/).map(row => row.split(" ").map(Number));
}

try {
    writeFileSync(source, `package main
import "play"
import "wad"
const Carry = readFile("carry.bin")
const Minimum = readFile("minimum.bin")
const Strobe = readFile("strobe.bin")

map "Doom tagged light events" {
    screen at (-64, -48) size (128, 96) with { style = "solid" }
    register lighting play.LevelLightStep = play.LevelLightStep{}
    tick {
        strobe := ${records("Strobe", strobe)}
        tic := currentTick()
        state := lighting
        if tic == 0 {
            carry := ${records("Carry", carry)}
            minimum := ${records("Minimum", minimum)}
            turnedOn := play.ActivateTaggedLights(carry, play.LevelDoors{}, play.LevelLightStep{}, 7, 0)
            log(turnedOn.Lights.LightAt(0, 160), turnedOn.Lights.LightAt(1, 100), turnedOn.Lights.SectorSpecialAt(0, 0))
            direct := play.ActivateTaggedLights(carry, play.LevelDoors{}, turnedOn, 7, 255)
            dim := play.ActivateTaggedLights(carry, play.LevelDoors{}, direct, 7, 35)
            log(direct.Lights.LightAt(0, 0), direct.Lights.LightAt(1, 0), dim.Lights.LightAt(0, 0), dim.Lights.LightAt(1, 0))
            darkened := play.ActivateTaggedLights(minimum, play.LevelDoors{}, play.LevelLightStep{}, 8, play.LightNeighborsDarkest)
            log(darkened.Lights.LightAt(0, 160), darkened.Lights.LightAt(1, 96))

            var doors play.LevelDoors
            doors = doors.Append(play.SectorDoor{Sector: 0, State: play.DoorState{Active: true}})
            once := play.ActivateTaggedLights(strobe, doors, lighting, 9, play.LightStartStrobe)
            state = play.ActivateTaggedLights(strobe, doors, once, 9, play.LightStartStrobe)
            log(once.Lights.ThinkerCount, once.Random.GameplayIndex, state.Lights.ThinkerCount, state.Random.GameplayIndex,
                state.Lights.EntryAt(0).Count, state.Lights.EntryAt(1).Count)
        } else {
            if tic == 10 { state = play.ActivateTaggedLights(strobe, play.LevelDoors{}, state, 9, 35) }
            if tic == 40 { state = play.ActivateTaggedLights(strobe, play.LevelDoors{}, state, 9, play.LightStartStrobe) }
            state = play.TickLevelLights(state.Lights, state.Random)
            log(tic, state.Lights.LightAt(0, 128), state.Lights.LightAt(1, 160), state.Lights.ThinkerCount,
                state.Random.GameplayIndex, state.Lights.EntryAt(0).Count, state.Lights.EntryAt(1).Count)
        }
        next lighting = state
    }
}
`);

    const trace = run();
    assert.equal(trace.length, 4 + lastTic);
    assert.deepEqual(trace.slice(0, 5), [
        [200, 200, 4],
        [255, 255, 35, 35],
        [32, 32],
        [1, 1, 2, 2, 1, 6],
        [1, 128, 64, 2, 2, 35, 5],
    ]);
    const digest = createHash("sha256").update(trace.map(row => row.join(" ")).join("\n")).digest("hex");
    assert.equal(digest, "ef695c599b7c77eb36cfe4c702f6063294bc324a48bceef39f203d27c4837f6c", "pinned native light trace");
    console.log("Doom tagged lights passed sector-order brightness, occupancy, and shared strobe checks.");
    const [, , , lightSource, specSource, randomSource] = process.argv;
    if (lightSource || specSource || randomSource) {
        assert.ok(lightSource && specSource && randomSource, "provide pinned p_lights.c, p_spec.c, and m_random.c");
        assert.deepEqual(trace, nativeTrace(lightSource, specSource, randomSource));
        console.log(`Doom tagged lights matched the pinned C routines across ${lastTic} tics and four activation samples.`);
    }
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
