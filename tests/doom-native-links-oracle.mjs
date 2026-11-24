import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

const MF_NOSECTOR = 0x8;
const MF_NOBLOCKMAP = 0x10;

function compileSource(upstreamDir, fixture) {
    const read = file => readFileSync(path.join(upstreamDir, file), "utf8").replaceAll("\r\n", "\n");
    const source = read("movement-p_maputl.c");
    const unset = extractFunction(source, "void", "P_UnsetThingPosition");
    const set = extractFunction(source, "void", "P_SetThingPosition");
    const block = extractFunction(source, "boolean", "P_BlockThingsIterator");
    const [originX, originY] = fixture.origin;
    const handles = new Set(fixture.commands.filter(([op]) => op === "set").map(([, handle]) => handle));
    const maxHandle = Math.max(...handles);
    const commands = fixture.commands.map(command => {
        if (command[0] === "set" || command[0] === "move") {
            const [, handle, x, y, flags] = command;
            return `runSet(${handle}, ${x}, ${y}, ${flags}, ${Number(command[0] === "move")});`;
        }
        if (command[0] === "unset") return `runUnset(${command[1]});`;
        if (command[0] === "sector") return `runSector(${command[1]});`;
        if (command[0] === "block") return `runBlock(${command[1]}, ${command[2]}, ${command[3]});`;
        throw new Error(`Unknown links command '${command[0]}'`);
    }).join("\n    ");
    const width = fixture.width;
    const height = fixture.height;
    const splitX = fixture.splitX;
    return `
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int32_t fixed_t;
typedef enum { false, true } boolean;
typedef struct mobj_s mobj_t;
typedef struct sector_s { mobj_t *thinglist; } sector_t;
typedef struct { sector_t *sector; } subsector_t;
struct mobj_s {
    int flags;
    fixed_t x, y;
    subsector_t *subsector;
    mobj_t *sprev, *snext, *bprev, *bnext;
};

#define MF_NOSECTOR ${MF_NOSECTOR}
#define MF_NOBLOCKMAP ${MF_NOBLOCKMAP}
#define MAPBLOCKSHIFT 23

static int bmaporgx = ${originX};
static int bmaporgy = ${originY};
static int bmapwidth = ${width};
static int bmapheight = ${height};
static mobj_t *blocklinks[${Math.max(1, width * height)}];
static sector_t sectors[2];
static subsector_t leaves[2] = {{&sectors[0]}, {&sectors[1]}};
static mobj_t actors[${maxHandle}];
static int actorUsed[${maxHandle}];
static int splitX = ${splitX};

static subsector_t *R_PointInSubsector(fixed_t x, fixed_t y) {
    (void)y;
    return &leaves[x <= splitX ? 0 : 1];
}

${unset}
${set}
${block}

static int handle(const mobj_t *actor) {
    return (int)(actor - actors) + 1;
}

static void emit(const int *values, int count) {
    for (int index = 0; index < count; ++index) printf("%s%d", index ? "," : "", values[index]);
    putchar('\\n');
}

static void runSet(int handleValue, fixed_t x, fixed_t y, int flags, int relink) {
    if (handleValue < 1 || handleValue > ${maxHandle} || actorUsed[handleValue - 1] != relink) abort();
    mobj_t *actor = &actors[handleValue - 1];
    if (relink) P_UnsetThingPosition(actor);
    memset(actor, 0, sizeof(*actor));
    actor->x = x; actor->y = y; actor->flags = flags; actorUsed[handleValue - 1] = 1;
    P_SetThingPosition(actor);
    int row[] = {actor->subsector == &leaves[0] ? 0 : 1024};
    emit(row, 1);
}

static void runUnset(int handleValue) {
    if (handleValue < 1 || handleValue > ${maxHandle} || !actorUsed[handleValue - 1]) abort();
    P_UnsetThingPosition(&actors[handleValue - 1]);
    actorUsed[handleValue - 1] = 0;
    memset(&actors[handleValue - 1], 0, sizeof(actors[handleValue - 1]));
    emit(NULL, 0);
}

static void runSector(int index) {
    if (index != 0 && index != 1024) abort();
    int row[${handles.size}], count = 0;
    for (mobj_t *actor = sectors[index != 0].thinglist; actor; actor = actor->snext) row[count++] = handle(actor);
    emit(row, count);
}

static int stopHandle;
static int seen[${handles.size}];
static int seenCount;
static boolean collect(mobj_t *actor) {
    seen[seenCount++] = handle(actor);
    return handle(actor) != stopHandle;
}

static void runBlock(int x, int y, int stop) {
    stopHandle = stop; seenCount = 0;
    boolean complete = P_BlockThingsIterator(x, y, collect);
    int row[${handles.size + 1}]; row[0] = complete ? 1 : 0;
    memcpy(row + 1, seen, (size_t)seenCount * sizeof(int));
    emit(row, seenCount + 1);
}

int main(void) {
    ${commands}
    return 0;
}
`;
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 25_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

export function runNativeLinksOracle(upstreamDir, scratch, fixture) {
    assert.ok(fixture && Array.isArray(fixture.commands), "links fixture commands are required");
    assert.equal(fixture.origin.length, 2, "links fixture origin must be [x,y]");
    assert.ok(fixture.width > 0 && fixture.height > 0 && fixture.width * fixture.height <= 65536);
    const source = path.join(scratch, "native-links-oracle.c");
    const executable = path.join(scratch, "native-links-oracle.exe");
    writeFileSync(source, compileSource(upstreamDir, fixture));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", executable]);
    const stdout = run(executable, []);
    return stdout.replace(/\r?\n$/, "").split(/\r?\n/).map(line => line === "" ? [] : line.split(",").map(Number));
}
