// Exact Linux Doom 1.10 sound-flood oracle for sector noise activation.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

function nativeFixture(fixture) {
    const lines = fixture.lines ?? [];
    const changes = fixture.pulses.flatMap(pulse => pulse.changes ?? []);
    assert.ok(fixture.sectors.length <= 64, "noise oracle sector limit");
    assert.ok(lines.length <= 256, "noise oracle line limit");
    assert.ok(changes.every(([sector]) => sector >= 0 && sector < fixture.sectors.length), "noise change sector");
    assert.ok(fixture.pulses.every(({ emitter, target }) => emitter >= 0 && emitter < fixture.sectors.length && target > 0 && target <= 256),
        "noise pulse handle/sector");
    const source = ["reset();"];
    fixture.sectors.forEach(([floor, ceiling], index) => source.push(`seedSector(${index}, ${floor}, ${ceiling});`));
    lines.forEach(([front, back, flags], index) => {
        assert.ok(front >= 0 && front < fixture.sectors.length && (back < 0 || back < fixture.sectors.length), "noise line sector");
        source.push(`seedLine(${index}, ${front}, ${back}, ${flags});`);
    });
    fixture.pulses.forEach(({ emitter, target, changes: pulseChanges = [] }) => {
        pulseChanges.forEach(([sector, floor, ceiling]) => source.push(`changeSector(${sector}, ${floor}, ${ceiling});`));
        source.push(`pulse(${emitter}, ${target});`);
        source.push(`emit(${fixture.sectors.length});`);
    });
    source.push('puts("fixture");');
    return `{
    ${source.join("\n    ")}
}`;
}

function compileSource(upstreamDir, fixtures) {
    const read = file => readFileSync(path.join(upstreamDir, file), "utf8").replaceAll("\r\n", "\n");
    const enemy = read("p_enemy.c");
    const mapUtils = read("movement-p_maputl.c");
    const opening = extractFunction(mapUtils, "void", "P_LineOpening");
    const recursive = extractFunction(enemy, "void", "P_RecursiveSound");
    const alert = extractFunction(enemy, "void", "P_NoiseAlert");
    assert.ok(recursive.includes("P_LineOpening") && alert.includes("validcount++"), "pinned noise routines");
    return [PREAMBLE, opening, recursive, alert, FIXTURES, "int main(void) {", ...fixtures.map(nativeFixture), "return 0;\n}"].join("\n");
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

// Returns one group per fixture. Each group contains one flat row array per
// pulse, ordered by sector: [soundtarget handle, soundtraversed]. The pinned
// code intentionally leaves sectors untouched when a later pulse cannot reach
// them, so previous rows persist naturally in the oracle state.
export function runNativeNoiseOracle(upstreamDir, scratch, fixtures) {
    const source = path.join(scratch, "noise-oracle.c");
    const executable = path.join(scratch, "noise-oracle.exe");
    writeFileSync(source, compileSource(upstreamDir, fixtures));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", "-fno-strict-aliasing", source, "-o", executable]);
    const groups = run(executable, []).trim().split(/\r?\nfixture(?:\r?\n|$)/).filter(Boolean);
    assert.equal(groups.length, fixtures.length, "one native result per noise fixture");
    return groups.map(group => group.trim().split(/\r?\n/).filter(Boolean).map(row => row.split(",").map(Number)));
}

const PREAMBLE = `
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int32_t fixed_t;
typedef enum { false, true } boolean;
typedef struct mobj_s mobj_t;
typedef struct sector_s sector_t;
typedef struct line_s line_t;
typedef struct { sector_t *sector; } side_t;
typedef struct { sector_t *sector; } subsector_t;

struct line_s {
    int flags;
    short sidenum[2];
    sector_t *frontsector;
    sector_t *backsector;
};
struct sector_s {
    fixed_t floorheight;
    fixed_t ceilingheight;
    int validcount;
    int soundtraversed;
    mobj_t *soundtarget;
    int linecount;
    line_t **lines;
};
struct mobj_s { subsector_t *subsector; };

#define ML_TWOSIDED 4
#define ML_SOUNDBLOCK 64
#define MAX_SECTORS 64
#define MAX_LINES 256
#define MAX_TARGETS 256

static sector_t sectors[MAX_SECTORS];
static line_t lines[MAX_LINES];
static side_t sides[MAX_LINES * 2];
static line_t *sectorLines[MAX_SECTORS][MAX_LINES];
static subsector_t leaves[MAX_SECTORS];
static mobj_t emitters[MAX_SECTORS];
static mobj_t targets[MAX_TARGETS];
static int validcount;
fixed_t opentop;
fixed_t openbottom;
fixed_t openrange;
fixed_t lowfloor;
mobj_t *soundtarget;

void P_LineOpening(line_t *linedef);
void P_NoiseAlert(mobj_t *target, mobj_t *emmiter);

static void reset(void) {
    memset(sectors, 0, sizeof(sectors));
    memset(lines, 0, sizeof(lines));
    memset(sides, 0, sizeof(sides));
    memset(sectorLines, 0, sizeof(sectorLines));
    memset(leaves, 0, sizeof(leaves));
    memset(emitters, 0, sizeof(emitters));
    memset(targets, 0, sizeof(targets));
    validcount = 0;
}

static void seedSector(int index, fixed_t floor, fixed_t ceiling) {
    sectors[index].floorheight = floor;
    sectors[index].ceilingheight = ceiling;
    sectors[index].lines = sectorLines[index];
    leaves[index].sector = &sectors[index];
    emitters[index].subsector = &leaves[index];
}

static void addSectorLine(int sector, line_t *line) {
    int count = sectors[sector].linecount;
    if (count >= MAX_LINES) abort();
    sectorLines[sector][count] = line;
    sectors[sector].linecount = count + 1;
}

static void seedLine(int index, int front, int back, int flags) {
    line_t *line = &lines[index];
    line->flags = flags;
    line->frontsector = &sectors[front];
    line->backsector = back < 0 ? NULL : &sectors[back];
    line->sidenum[0] = (short) (index * 2);
    line->sidenum[1] = back < 0 ? -1 : (short) (index * 2 + 1);
    sides[index * 2].sector = &sectors[front];
    if (back >= 0) sides[index * 2 + 1].sector = &sectors[back];
    addSectorLine(front, line);
    if (back >= 0 && back != front) addSectorLine(back, line);
}

static void changeSector(int index, fixed_t floor, fixed_t ceiling) {
    sectors[index].floorheight = floor;
    sectors[index].ceilingheight = ceiling;
}

static void pulse(int emitter, int target) { P_NoiseAlert(&targets[target - 1], &emitters[emitter]); }

static void emit(int count) {
    for (int index = 0; index < count; index++) {
        int target = sectors[index].soundtarget ? (int) (sectors[index].soundtarget - targets) + 1 : 0;
        printf("%d,%d\\n", target, sectors[index].soundtraversed);
    }
}
`;

const FIXTURES = "";
