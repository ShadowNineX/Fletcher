import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(path.join(artifacts, "doom-floors-"));
const unit = 65536;
const lastTic = 72;
const modes = ["lowerFloor", "lowerFloorToLowest", "turboLower", "raiseFloor", "raiseFloorCrush",
    "raiseFloorTurbo", "raiseFloorToNearest", "raiseFloor24", "raiseFloor512", "raiseFloor24AndChange",
    "raiseToTexture", "lowerAndChange"];

const vectors = [];
for (const ceiling of [false, true]) {
    for (const direction of [-1, 1]) {
        for (const remaining of [5, 2, 1]) {
            for (const crush of [false, true]) {
                for (const blocked of [false, true]) {
                    vectors.push({ ceiling, direction, destination: (64 + remaining * direction) * unit, crush, blocked });
                }
            }
        }
    }
}

function runFletcher() {
    const entry = path.join(scratch, "main.flt");
    const output = path.join(scratch, "floors.json");
    const planeChecks = vectors.map(({ ceiling, direction, destination, crush, blocked }, index) =>
        `if tic == ${index} {
            step := play.MoveSectorPlane(64 * Unit, 2 * Unit, ${destination}, ${direction}, ${ceiling}, ${crush}, ${blocked})
            log(-1, ${index}, step.Height, step.Result)
        }`).join("\n        ");
    writeFileSync(entry, `package main
import "play"
const Unit = ${unit}
map "Doom floors" {
    screen at (-64, -48) size (128, 96) with { style = "solid" }
    register states [12]play.FloorState = [12]play.FloorState{}
    tick {
        tic := currentTick()
        ${planeChecks}
        frame := states
        for mode := range 12 {
            mover := frame[mode]
            if tic == 0 {
                initial := 0
                if mode < 3 || mode == 11 { initial = 40 * Unit }
                mover = play.StartFloor(mode + 1, play.FloorSetup{Height: initial, Ceiling: 80 * Unit,
                    HighestFloor: 20 * Unit, LowestFloor: 7 * Unit, NextFloor: 8 * Unit,
                    LowestCeiling: 46 * Unit, ShortestTexture: 16 * Unit})
            } else {
                mover = play.TickFloor(mover, tic == 7 || tic == 8 || tic == 31 || tic == 32)
            }
            log(tic, mode + 1, mover.Height, mover.Destination, mover.Speed, mover.Direction, mover.Crush, mover.Active)
            frame[mode] = mover
        }
        next states = frame
    }
}
`);
    const build = spawnSync("dotnet", [cli, "build", entry, "--package-root", path.join(root, "examples", "doom-engine"), "-o", output],
        { encoding: "utf8", cwd: root, timeout: 15_000 });
    assert.equal(build.status, 0, build.error?.message ?? build.stderr);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
    for (let tic = 0; tic <= lastTic; tic++) sim.step();
    return sim.logs.map(row => Array.from(row, Number));
}

function runNative(floorPath) {
    const floors = readFileSync(path.resolve(root, floorPath), "utf8").replaceAll("\r\n", "\n");
    const first = floors.search(/result_e\s+T_MovePlane\s*\n/);
    const last = floors.indexOf("// BUILD A STAIRCASE!", first);
    assert.ok(first >= 0 && last > first, "locate pinned T_MovePlane, T_MoveFloor, and EV_DoFloor");
    const source = path.join(scratch, "native-floors.c");
    const executable = path.join(scratch, process.platform === "win32" ? "native-floors.exe" : "native-floors");
    writeFileSync(source, `#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FRACUNIT ${unit}
#define FLOORSPEED FRACUNIT
#define MAXINT INT_MAX
enum { PU_LEVSPEC = 51, false = 0, true = 1, sfx_stnmov = 0, sfx_pstop = 1 };
typedef int boolean;
typedef int fixed_t;
typedef enum { ok, crushed, pastdest } result_e;
typedef enum { lowerFloor, lowerFloorToLowest, turboLower, raiseFloor, raiseFloorToNearest,
    raiseToTexture, lowerAndChange, raiseFloor24, raiseFloor24AndChange, raiseFloorCrush,
    raiseFloorTurbo, donutRaise, raiseFloor512 } floor_e;
typedef struct { int unused; } mobj_t;
typedef struct { fixed_t floorheight, ceilingheight; int floorpic, special, linecount; void *specialdata; mobj_t soundorg; } sector_t;
typedef struct { sector_t *frontsector; } line_t;
typedef struct { sector_t *sector; int bottomtexture; } side_t;
typedef void (* actionf_p1)(void *);
typedef struct { union { actionf_p1 acp1; } function; } thinker_t;
typedef struct {
    thinker_t thinker;
    floor_e type;
    boolean crush;
    sector_t *sector;
    int direction, newspecial, texture;
    fixed_t floordestheight, speed;
} floormove_t;
static sector_t sectors[2];
static side_t sides[2] = {{&sectors[0], 0}, {&sectors[1], 0}};
static fixed_t textureheight[] = {16 * FRACUNIT};
static boolean blocked;
static int leveltime;

static boolean P_ChangeSector(sector_t *sector, boolean damage) {
    (void)sector;
    (void)damage;
    return blocked;
}
static void S_StartSound(mobj_t *origin, int sound) { (void)origin; (void)sound; }
static void P_AddThinker(thinker_t *thinker) { (void)thinker; }
static void P_RemoveThinker(thinker_t *thinker) { (void)thinker; }
static void *Z_Malloc(size_t size, int tag, void *user) {
    (void)tag;
    (void)user;
    void *object = calloc(1, size);
    if (!object) exit(1);
    return object;
}
static int P_FindSectorFromLineTag(line_t *line, int start) { (void)line; return start < 0 ? 0 : -1; }
static fixed_t P_FindHighestFloorSurrounding(sector_t *sec) { (void)sec; return 20 * FRACUNIT; }
static fixed_t P_FindLowestFloorSurrounding(sector_t *sec) { (void)sec; return 7 * FRACUNIT; }
static fixed_t P_FindNextHighestFloor(sector_t *sec, fixed_t height) { (void)sec; (void)height; return 8 * FRACUNIT; }
static fixed_t P_FindLowestCeilingSurrounding(sector_t *sec) { (void)sec; return 46 * FRACUNIT; }
static boolean twoSided(int sector, int line) { (void)sector; (void)line; return true; }
static side_t *getSide(int sector, int line, int side) { (void)sector; (void)line; return &sides[side]; }
static sector_t *getSector(int sector, int line, int side) { return getSide(sector,line,side)->sector; }

${floors.slice(first, last)}

static void emit(int tic, int mode, const floormove_t *mover, boolean active) {
    printf("%d %d %d %d %d %d %d %d\\n", tic, mode, mover->sector->floorheight,
        mover->floordestheight, mover->speed, mover->direction, mover->crush, active);
}

int main(void) {
    const floor_e modes[12] = {${modes.join(", ")}};
    const int planes[][6] = {${vectors.map(({ ceiling, direction, destination, crush, blocked }, index) =>
        `{${index},${destination},${direction},${+ceiling},${+crush},${+blocked}}`).join(",")}};
    for (size_t i = 0; i < sizeof planes / sizeof planes[0]; ++i) {
        sector_t sector = {.floorheight = 64 * FRACUNIT, .ceilingheight = 64 * FRACUNIT};
        const int *row = planes[i];
        blocked = row[5];
        result_e moved = T_MovePlane(&sector, 2 * FRACUNIT, row[1], row[4], row[3], row[2]);
        printf("-1 %d %d %d\\n", row[0], row[3] ? sector.ceilingheight : sector.floorheight, moved);
    }

    line_t line = {&sectors[1]};
    for (int mode = 0; mode < 12; ++mode) {
        memset(sectors, 0, sizeof sectors);
        sectors[0].floorheight = mode < 3 || mode == 11 ? 40 * FRACUNIT : 0;
        sectors[0].ceilingheight = 80 * FRACUNIT;
        sectors[0].linecount = 1;
        sectors[1].floorheight = 7 * FRACUNIT;
        EV_DoFloor(&line, modes[mode]);
        floormove_t *mover = sectors[0].specialdata;
        if (!mover) return 2;
        emit(0, mode + 1, mover, true);
        for (int tic = 1; tic <= ${lastTic}; ++tic) {
            leveltime = tic;
            blocked = tic == 7 || tic == 8 || tic == 31 || tic == 32;
            if (sectors[0].specialdata) T_MoveFloor(mover);
            emit(tic, mode + 1, mover, sectors[0].specialdata != NULL);
        }
        free(mover);
    }
    return 0;
}
`);
    const build = spawnSync("gcc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-Wno-implicit-fallthrough",
        source, "-o", executable], { encoding: "utf8", timeout: 15_000 });
    assert.equal(build.status, 0, build.error?.message ?? build.stderr);
    const run = spawnSync(executable, [], { encoding: "utf8", timeout: 5000 });
    assert.equal(run.status, 0, run.error?.message ?? run.stderr);
    return run.stdout.trim().split(/\r?\n/).map(row => row.split(" ").map(Number));
}

try {
    const ordered = rows => rows.sort(([ticA, modeA], [ticB, modeB]) => ticA - ticB || modeA - modeB);
    const trace = ordered(runFletcher());
    assert.equal(trace.length, vectors.length + modes.length * (lastTic + 1));
    const initial = trace.filter(([tic]) => tic === 0);
    assert.deepEqual(initial.map(row => row.slice(3)), [
        [20, 1, -1, 0, 1], [7, 1, -1, 0, 1], [28, 4, -1, 0, 1],
        [46, 1, 1, 0, 1], [38, 1, 1, 1, 1], [8, 4, 1, 0, 1],
        [8, 1, 1, 0, 1], [24, 1, 1, 0, 1], [512, 1, 1, 0, 1],
        [24, 1, 1, 0, 1], [16, 1, 1, 0, 1], [7, 1, -1, 0, 1],
    ].map(([target, speed, ...rest]) => [target * unit, speed * unit, ...rest]));
    const digest = createHash("sha256").update(trace.map(row => row.join(" ")).join("\n")).digest("hex");
    assert.equal(digest, "f9b4ecf3084de76cf3d863df21a9bcfffebb6b5277b87dd406f488a6f7fe9a8f", "pinned native floor trace");
    if (process.argv[3]) {
        assert.deepEqual(trace, ordered(runNative(process.argv[3])));
        console.log(`Doom floors matched pinned C for ${modes.length} floor modes and ${vectors.length} plane-step vectors.`);
    } else {
        console.log("Doom floor modes and generated traces matched the recorded native results.");
    }
} finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

