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
const scratch = mkdtempSync(path.join(artifacts, "doom-ceilings-"));
const unit = 65536;
const lastTic = 32;
const registrySize = 30;
const sectorCount = registrySize + 1;
const modes = ["lowerToFloor", "raiseToHighest", "lowerAndCrush", "crushAndRaise", "fastCrushAndRaise", "silentCrushAndRaise"];

function registryRecords() {
    const lines = sectorCount * 26;
    const sides = lines + 3 * 14;
    const vertices = sides + 30;
    const bytes = Buffer.alloc(vertices + 8);
    for (let sector = 0; sector < sectorCount; sector++) {
        bytes.writeInt16LE(8, sector * 26 + 2);
        bytes.writeInt16LE(7, sector * 26 + 24);
    }
    for (const [index, special] of [44, 74, 73].entries()) {
        const offset = lines + index * 14;
        bytes.writeUInt16LE(1, offset + 2);
        bytes.writeUInt16LE(special, offset + 6);
        bytes.writeUInt16LE(7, offset + 8);
        bytes.writeUInt16LE(0xffff, offset + 12);
    }
    bytes.writeInt16LE(16, vertices + 4);
    writeFileSync(path.join(scratch, "registry.bin"), bytes);
    return `wad.BspLevel{Valid: true, File: Registry, Sectors: wad.Lump{Valid: true, Count: ${sectorCount}},
        Lines: wad.Lump{Valid: true, Count: 3, Offset: ${lines}}, Sides: wad.Lump{Valid: true, Count: 1, Offset: ${sides}},
        Vertices: wad.Lump{Valid: true, Count: 2, Offset: ${vertices}}}`;
}

function runFletcher() {
    const entry = path.join(scratch, "main.flt"), output = path.join(scratch, "ceilings.json");
    writeFileSync(entry, `package main
import "play"
import "wad"
const Unit = ${unit}
const Registry = readFile("registry.bin")
map "Doom ceilings" {
    screen at (-64, -48) size (128, 96) with { style = "solid" }
    register states [6]play.CeilingState = [6]play.CeilingState{}
    register registry play.LevelSpecials = play.LevelSpecials{}
    tick {
        tic := currentTick()
        if tic < 3 {
            base := ${registryRecords()}
            tagged := play.CrossLevelSpecial(registry.ApplyTo(base), registry, tic)
            if tic > 0 {
                frame := play.TickLevelMovers(base, wad.BlockMapInfo{}, tagged, play.MapActor{})
                tagged = frame.State
            }
            firstHandle := tagged.Ceilings.FindSector(0)
            lastHandle := tagged.Ceilings.FindSector(${registrySize})
            var first play.CeilingState
            var last play.CeilingState
            if firstHandle != 0 { first = tagged.Ceilings.EntryAt(firstHandle).Motion }
            if lastHandle != 0 { last = tagged.Ceilings.EntryAt(lastHandle).Motion }
            live := tagged.ApplyTo(base)
            log(-1, tic, tagged.Ceilings.Count, tagged.Ceilings.TrackedCount, first.Direction, last.Direction,
                first.Active, last.Active, tagged.MoverOccupied(0), tagged.MoverOccupied(${registrySize}),
                live.SectorHeightsAt(0).Ceiling, live.SectorHeightsAt(${registrySize}).Ceiling)
            next registry = tagged
        }
        frame := states
        for index := range 6 {
            motion := frame[index]
            if tic == 0 {
                motion = play.StartCeiling(index + 1, 10 * Unit, 0, 16 * Unit)
            } else {
                motion = play.TickCeiling(motion, tic == 1 || tic == 7 || tic == 10 || tic == 21)
            }
            log(tic, index + 1, motion.Height, motion.Top, motion.Bottom, motion.Speed, motion.Direction,
                motion.Crush, motion.Active)
            frame[index] = motion
        }
        next states = frame
    }
}
`);
    const build = spawnSync("dotnet", [cli, "build", entry, "--package-root", path.join(root, "examples", "doom-engine"),
        "--asset-root", scratch, "-o", output], { encoding: "utf8", cwd: root, timeout: 15_000 });
    assert.equal(build.status, 0, build.error?.message ?? build.stderr);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
    for (let tic = 0; tic <= lastTic; tic++) sim.step();
    return sim.logs.map(row => Array.from(row, Number));
}

function runNative(ceilingPath, floorPath) {
    const read = file => readFileSync(path.resolve(root, file), "utf8").replaceAll("\r\n", "\n");
    const ceilings = read(ceilingPath), floors = read(floorPath);
    const first = ceilings.search(/ceiling_t\s*\*\s*activeceilings\s*\[/);
    const planeStart = floors.search(/result_e\s+T_MovePlane\s*\n/);
    const planeEnd = floors.indexOf("\n}", planeStart);
    assert.ok(first >= 0 && planeStart >= 0 && planeEnd > planeStart, "locate exact ceiling and plane routines");
    const source = path.join(scratch, "native-ceilings.c");
    const executable = path.join(scratch, process.platform === "win32" ? "native-ceilings.exe" : "native-ceilings");
    writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FRACUNIT ${unit}
#define CEILSPEED FRACUNIT
#define MAXCEILINGS ${registrySize}
enum { PU_LEVSPEC = 51, false = 0, true = 1, sfx_stnmov = 0, sfx_pstop = 1 };
typedef int boolean;
typedef int fixed_t;
typedef enum { ok, crushed, pastdest } result_e;
typedef enum { lowerToFloor, raiseToHighest, lowerAndCrush, crushAndRaise, fastCrushAndRaise, silentCrushAndRaise } ceiling_e;
typedef struct { int unused; } mobj_t;
typedef struct { fixed_t floorheight, ceilingheight; int tag; void *specialdata; mobj_t soundorg; } sector_t;
typedef struct { int tag; } line_t;
typedef void (*actionf_p1)(void *);
typedef void (*actionf_v)(void);
typedef struct { union { actionf_p1 acp1; actionf_v acv; } function; boolean active; } thinker_t;
typedef struct { thinker_t thinker; ceiling_e type; sector_t *sector; fixed_t bottomheight, topheight, speed;
    boolean crush; int direction, tag, olddirection; } ceiling_t;
static thinker_t *thinkers[64];
static int count, numsectors, leveltime;
static sector_t sectors[64];
static boolean blocked;
void P_AddActiveCeiling(ceiling_t *ceiling);
void P_RemoveActiveCeiling(ceiling_t *ceiling);
void P_ActivateInStasisCeiling(line_t *line);

static boolean P_ChangeSector(sector_t *sector, boolean crush) { (void)sector; (void)crush; return blocked; }
static void S_StartSound(mobj_t *origin, int sound) { (void)origin; (void)sound; }
static void P_AddThinker(thinker_t *thinker) {
    if (count >= 64) exit(1);
    thinker->active = true;
    thinkers[count++] = thinker;
}
static void P_RemoveThinker(thinker_t *thinker) { thinker->active = false; }
static void *Z_Malloc(size_t size, int tag, void *owner) {
    (void)tag;
    (void)owner;
    void *result = calloc(1, size);
    if (!result) exit(2);
    return result;
}
static int P_FindSectorFromLineTag(line_t *line, int start) {
    for (int i = start + 1; i < numsectors; ++i)
        if (sectors[i].tag == line->tag) return i;
    return -1;
}
static fixed_t P_FindHighestCeilingSurrounding(sector_t *sector) { (void)sector; return 16 * FRACUNIT; }

${floors.slice(planeStart, planeEnd + 2)}
${ceilings.slice(first)}

static void load(int size, int height) {
    for (int i = 0; i < count; ++i) free(thinkers[i]);
    count = 0;
    numsectors = size;
    memset(sectors, 0, sizeof sectors);
    memset(activeceilings, 0, sizeof activeceilings);
    blocked = false;
    for (int i = 0; i < size; ++i) {
        sectors[i].tag = 7;
        sectors[i].ceilingheight = height * FRACUNIT;
    }
}
static void runThinkers(void) {
    for (int i = 0; i < count; ++i)
        if (thinkers[i]->active && thinkers[i]->function.acp1)
            T_MoveCeiling((ceiling_t *)thinkers[i]);
}
static void registryRow(int phase) {
    int live = 0;
    int tracked = 0;
    for (int i = 0; i < count; ++i)
        if (thinkers[i]->active) ++live;
    for (int i = 0; i < MAXCEILINGS; ++i)
        if (activeceilings[i]) ++tracked;
    ceiling_t *first = (ceiling_t *)thinkers[0], *last = (ceiling_t *)thinkers[MAXCEILINGS];
    printf("-1 %d %d %d %d %d %d %d %d %d %d %d\\n", phase, live, tracked,
        first->thinker.active ? first->direction : 0, last->thinker.active ? last->direction : 0,
        first->thinker.active, last->thinker.active, sectors[0].specialdata != NULL,
        sectors[MAXCEILINGS].specialdata != NULL, sectors[0].ceilingheight, sectors[MAXCEILINGS].ceilingheight);
}
int main(void) {
    const ceiling_e modes[] = {${modes.join(", ")}};
    line_t trigger = {.tag = 7};
    load(MAXCEILINGS + 1, 8);
    EV_DoCeiling(&trigger, lowerAndCrush);
    if (count != MAXCEILINGS + 1) return 3;
    registryRow(0);
    EV_CeilingCrushStop(&trigger);
    runThinkers();
    registryRow(1);
    if (EV_DoCeiling(&trigger, crushAndRaise)) return 4;
    runThinkers();
    registryRow(2);

    for (int index = 0; index < 6; ++index) {
        load(1, 10);
        EV_DoCeiling(&trigger, modes[index]);
        ceiling_t *motion = (ceiling_t *)thinkers[0];
        for (int tic = 0; tic <= ${lastTic}; ++tic) {
            leveltime = tic;
            blocked = tic == 1 || tic == 7 || tic == 10 || tic == 21;
            if (tic) runThinkers();
            printf("%d %d %d %d %d %d %d %d %d\\n", tic, index + 1, sectors[0].ceilingheight,
                motion->topheight, motion->bottomheight, motion->speed, motion->direction, motion->crush, motion->thinker.active);
        }
    }
    load(0, 0);
    return 0;
}
`);
    const compile = spawnSync("gcc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-Wno-implicit-fallthrough",
        source, "-o", executable], { encoding: "utf8", timeout: 15_000 });
    assert.equal(compile.status, 0, compile.error?.message ?? compile.stderr);
    const result = spawnSync(executable, [], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout.trim().split(/\r?\n/).map(line => line.split(" ").map(Number));
}

try {
    const sort = rows => rows.sort(([ticA, modeA], [ticB, modeB]) => ticA - ticB || modeA - modeB);
    const rows = sort(runFletcher());
    assert.equal(rows.length, 3 + modes.length * (lastTic + 1));
    assert.deepEqual(rows.slice(0, 3), [
        [-1, 0, 31, 30, -1, -1, 1, 1, 1, 1, 8 * unit, 8 * unit],
        [-1, 1, 31, 30, 0, -1, 1, 1, 1, 1, 8 * unit, 8 * unit],
        [-1, 2, 1, 0, 0, -1, 0, 1, 0, 1, 8 * unit, 8 * unit],
    ]);
    const hash = createHash("sha256").update(rows.map(row => row.join(" ")).join("\n")).digest("hex");
    assert.equal(hash, "d96d1fe51b57c87395fbdf602f7cab4a49d20f178cbb9682d205e2e0fb699266", "pinned native ceiling trace");
    if (process.argv[3] || process.argv[4]) {
        assert.ok(process.argv[3] && process.argv[4], "provide pinned p_ceilng.c and p_floor.c");
        assert.deepEqual(rows, sort(runNative(process.argv[3], process.argv[4])));
        console.log(`Doom ceilings matched ${rows.length} samples across all six modes, stasis, and registry overflow.`);
    } else {
        console.log("Doom ceiling traces matched the recorded native results.");
    }
} finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

