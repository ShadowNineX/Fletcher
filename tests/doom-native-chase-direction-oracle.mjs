// Exact Linux Doom 1.10 chase-direction oracle with a bounded P_Move shim.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

function fixtureSource(fixture) {
    const oldDirection = fixture.oldDirection ?? 8;
    const allowed = fixture.allowed ?? 0;
    assert.ok(Number.isInteger(oldDirection) && oldDirection >= 0 && oldDirection <= 8, "chase old direction");
    assert.ok(Number.isInteger(allowed) && allowed >= 0 && allowed <= 255, "chase allowed mask");
    return `{
    reset(${fixture.dx ?? 0}, ${fixture.dy ?? 0}, ${oldDirection}, ${fixture.rng ?? 0}, ${allowed}, ${fixture.moveCount ?? 0});
    P_NewChaseDir(&actor);
    emit();
    puts("fixture");
}`;
}

function compileSource(upstreamDir, fixtures) {
    const read = file => readFileSync(path.join(upstreamDir, file), "utf8").replaceAll("\r\n", "\n");
    const enemy = read("p_enemy.c");
    const random = read("light-m_random.c");
    const randomTable = random.match(/unsigned char rndtable\[256\] = \{[\s\S]*?\n\};/);
    const randomFunction = extractFunction(random, "int", "P_Random");
    const tryWalk = extractFunction(enemy, "boolean", "P_TryWalk");
    const newChaseDirection = extractFunction(enemy, "void", "P_NewChaseDir");
    assert.ok(randomTable && tryWalk.includes("P_Move") && newChaseDirection.includes("P_TryWalk"), "pinned chase routines");
    return [PREAMBLE, randomTable[0], "int prndindex;", randomFunction, tryWalk, newChaseDirection, "int main(void) {", ...fixtures.map(fixtureSource), "return 0;\n}"].join("\n");
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

// Fixture dx/dy are target-minus-actor raw 16.16 coordinates. `allowed` has one
// bit per native direction 0..7. Result rows are
// [attemptedDirections[], finalDirection, finalMoveCount, finalRngIndex].
export function runNativeChaseDirections(upstreamDir, scratch, fixtures) {
    const source = path.join(scratch, "chase-direction-oracle.c");
    const executable = path.join(scratch, "chase-direction-oracle.exe");
    writeFileSync(source, compileSource(upstreamDir, fixtures));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", "-fno-strict-aliasing", source, "-o", executable]);
    const groups = run(executable, []).trim().split(/\r?\nfixture(?:\r?\n|$)/).filter(Boolean);
    assert.equal(groups.length, fixtures.length, "one native result per chase fixture");
    return groups.map(group => {
        const [attempts, direction, moveCount, rng] = group.trim().split(",");
        return [attempts ? attempts.split(":").map(Number) : [], Number(direction), Number(moveCount), Number(rng)];
    });
}

const PREAMBLE = `
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int32_t fixed_t;
typedef enum { false, true } boolean;
typedef enum {
    DI_EAST, DI_NORTHEAST, DI_NORTH, DI_NORTHWEST,
    DI_WEST, DI_SOUTHWEST, DI_SOUTH, DI_SOUTHEAST, DI_NODIR, NUMDIRS
} dirtype_t;
typedef struct mobj_s mobj_t;
typedef struct { int speed; } mobjinfo_t;
struct mobj_s {
    fixed_t x, y;
    mobj_t *target;
    mobjinfo_t *info;
    int movedir;
    int movecount;
};

#define FRACUNIT 65536
dirtype_t opposite[] = {
    DI_WEST, DI_SOUTHWEST, DI_SOUTH, DI_SOUTHEAST,
    DI_EAST, DI_NORTHEAST, DI_NORTH, DI_NORTHWEST, DI_NODIR
};
dirtype_t diags[] = { DI_NORTHWEST, DI_NORTHEAST, DI_SOUTHWEST, DI_SOUTHEAST };

static mobjinfo_t info;
static mobj_t actor;
static mobj_t target;
static int allowedDirections;
static int attempts[16];
static int attemptCount;
extern int prndindex;

boolean P_Move(mobj_t *thing) {
    int direction = thing->movedir;
    if (attemptCount >= 16) abort();
    attempts[attemptCount++] = direction;
    return direction >= 0 && direction < 8 && (allowedDirections & (1 << direction));
}
void I_Error(const char *message) { (void)message; abort(); }

static void reset(fixed_t dx, fixed_t dy, int oldDirection, int rng, int allowed, int moveCount) {
    memset(&actor, 0, sizeof(actor));
    memset(&target, 0, sizeof(target));
    memset(attempts, 0, sizeof(attempts));
    actor.info = &info;
    actor.target = &target;
    actor.movedir = oldDirection;
    actor.movecount = moveCount;
    target.x = dx;
    target.y = dy;
    allowedDirections = allowed;
    attemptCount = 0;
    prndindex = rng & 255;
}
static void emit(void) {
    for (int index = 0; index < attemptCount; index++) {
        if (index) putchar(':');
        printf("%d", attempts[index]);
    }
    printf(",%d,%d,%d\\n", actor.movedir, actor.movecount, prndindex);
}
`;
