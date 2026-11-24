// Compile the pinned arch-vile actions and mobj primitives in a synthetic world.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

const actions = {
    start: "A_VileStart(&actors[1])", target: "A_VileTarget(&actors[1])", fire: "A_Fire(actors[1].tracer)",
    startFire: "A_StartFire(actors[1].tracer)", crackle: "A_FireCrackle(actors[1].tracer)", attack: "A_VileAttack(&actors[1])",
    chase: "A_VileChase(&actors[1])",
};

function fixtureSource({ bodies, commands, blocked, low, target, rng }) {
    const seed = bodies.map((body, index) => `seed(${[index + 1, ...body]});`).join("\n        ");
    return `{
        reset(${[Number(blocked), Number(low), rng]});
        ${seed}
        actors[1].target = ${target ? "&actors[2]" : "NULL"};
        ${commands.map(command => `clearEvents(); ${actions[command]}; emit(); puts("step");`).join("\n        ")}
        puts("fixture");
    }`;
}

function compileSource(upstreamDir, fixtures) {
    const read = file => readFileSync(path.join(upstreamDir, file), "utf8").replaceAll("\r\n", "\n");
    const enemy = read("p_enemy.c"), info = read("info.c"), mobj = read("p_mobj.c"), random = read("light-m_random.c");
    const metadata = info.slice(info.indexOf("char *sprnames["));
    const enemyFunctions = ["A_FaceTarget", "A_VileStart", "A_VileTarget", "A_Fire", "A_StartFire", "A_FireCrackle", "A_VileAttack", "A_VileChase"];
    const prototypes = [...new Set(Array.from(metadata.matchAll(/void\s+(A_[A-Za-z0-9_]+)\s*\(/g), match => match[1]))];
    const stubs = prototypes.filter(name => name !== "A_Chase" && !enemyFunctions.includes(name)).map(name => `void ${name}(void) { abort(); }`);
    const flags = read("p_mobj.h").match(/typedef enum\s*\{[\s\S]*?\}\s*mobjflag_t;/)?.[0];
    assert.ok(flags?.includes("MF_CORPSE") && metadata.startsWith("char *sprnames["));
    return [
        HEADER, read("info.h").replace(/^#include "d_think.h"$/m, ""), read("sounds.h"), flags, ...stubs,
        metadata, random.slice(random.indexOf("unsigned char rndtable[")), read("tables.c").replace(/^#include.*$/gm, ""),
        WORLD, extractFunction(read("r_main.c"), "angle_t", "R_PointToAngle"),
        extractFunction(read("r_main.c"), "angle_t", "R_PointToAngle2"), extractFunction(read("m_fixed.c"), "fixed_t", "FixedMul"),
        extractFunction(mobj, "boolean", "P_SetMobjState"), extractFunction(mobj, "mobj_t\\*", "P_SpawnMobj"),
        extractFunction(enemy, "boolean", "PIT_VileCheck"), ...enemyFunctions.map(name => extractFunction(enemy, "void", name)),
        FIXTURES, "int main(void) {", ...fixtures.map(fixtureSource), "return 0;\n}",
    ].join("\n");
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

export function runNativeVileOracle(upstreamDir, scratch, fixtures) {
    const source = path.join(scratch, "vile-oracle.c"), executable = path.join(scratch, "vile-oracle.exe");
    writeFileSync(source, compileSource(upstreamDir, fixtures));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", "-fno-strict-aliasing", source, "-o", executable]);
    const groups = run(executable, []).trim().split(/\r?\nfixture(?:\r?\n|$)/).filter(Boolean);
    assert.equal(groups.length, fixtures.length);
    return groups.map(group => group.trim().split(/\r?\nstep(?:\r?\n|$)/).filter(Boolean).map(row => JSON.parse(row)));
}

const HEADER = String.raw`
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef int32_t fixed_t;
typedef uint32_t angle_t;
typedef enum { false, true } boolean;
typedef void (*actionf_p1)(void *);
typedef union { void (*acv)(void); actionf_p1 acp1; } actionf_t;
typedef struct { actionf_t function; } thinker_t;
#define FRACBITS 16
#define FRACUNIT (1 << FRACBITS)
#define FINEANGLES 8192
#define ANG90 UINT32_C(0x40000000)
#define ANG180 UINT32_C(0x80000000)
#define ANG270 UINT32_C(0xc0000000)
#define ANGLETOFINESHIFT 19
#define SLOPERANGE 2048
#define MAXPLAYERS 4
#define MAXRADIUS (32 * FRACUNIT)
#define MAPBLOCKSHIFT 23
#define DI_NODIR 8
#define ONFLOORZ INT32_MIN
#define ONCEILINGZ INT32_MAX
#define PU_LEVEL 50
enum { sk_nightmare = 4 };
`;

const WORLD = String.raw`
typedef struct { fixed_t floorheight, ceilingheight; } sector_t;
typedef struct { sector_t *sector; } subsector_t;
typedef struct mobj_s {
    thinker_t thinker;
    mobjtype_t type;
    mobjinfo_t *info;
    state_t *state;
    spritenum_t sprite;
    long tics, frame;
    fixed_t x, y, z, momx, momy, momz, radius, height, floorz, ceilingz;
    angle_t angle;
    int health, flags, lastlook, reactiontime, movedir;
    subsector_t *subsector;
    struct mobj_s *target, *tracer;
    int blockx, blocky;
} mobj_t;
static int gameskill = 2, count, blocked, chased, sounds[2], direct[4], blast[3];
static fixed_t viewx, viewy, *finecosine = finesine + FINEANGLES / 4;
static const fixed_t bmaporgx = -512 * FRACUNIT, bmaporgy = -512 * FRACUNIT;
static const fixed_t xspeed[8] = {FRACUNIT,47000,0,-47000,-FRACUNIT,-47000,0,47000};
static const fixed_t yspeed[8] = {0,47000,FRACUNIT,47000,0,-47000,-FRACUNIT,-47000};
static sector_t sectors[] = {{0, 192 * FRACUNIT}, {8 * FRACUNIT, 160 * FRACUNIT}};
static subsector_t leaves[] = {{&sectors[0]}, {&sectors[1]}};
static mobj_t actors[32];
static mobj_t *corpsehit, *vileobj;
static fixed_t viletryx, viletryy;

static int handle(mobj_t *mo) { return mo ? (int)(mo - actors) : 0; }
static void S_StartSound(mobj_t *origin, int sound) { sounds[0] = handle(origin); sounds[1] = sound; }
static boolean P_CheckSight(mobj_t *viewer, mobj_t *target) { return !blocked; }
static void P_DamageMobj(mobj_t *target, mobj_t *inflictor, mobj_t *source, int amount) {
    direct[0] = handle(target); direct[1] = handle(inflictor); direct[2] = handle(source); direct[3] = amount;
}
static void P_RadiusAttack(mobj_t *spot, mobj_t *source, int damage) {
    blast[0] = handle(spot); blast[1] = handle(source); blast[2] = damage;
}
void A_Chase(mobj_t *actor) { chased = 1; }
static void P_MobjThinker(mobj_t *mo) { abort(); }
static void P_RemoveMobj(mobj_t *mo) { abort(); }
static void P_AddThinker(thinker_t *thinker) {}
static void *Z_Malloc(size_t size, int tag, void *owner) {
    if (size != sizeof(mobj_t) || tag != PU_LEVEL || owner || count >= 31) abort();
    return &actors[++count];
}
static void P_UnsetThingPosition(mobj_t *mo) {}
static void P_SetThingPosition(mobj_t *mo) {
    mo->subsector = &leaves[mo->y >= 8 * FRACUNIT];
    mo->blockx = (mo->x - bmaporgx) >> MAPBLOCKSHIFT;
    mo->blocky = (mo->y - bmaporgy) >> MAPBLOCKSHIFT;
}
static boolean P_BlockThingsIterator(int x, int y, boolean (*check)(mobj_t *)) {
    if (x < 0 || x >= 8 || y < 0 || y >= 8) return true;
    for (int i = count; i > 0; i--) {
        mobj_t *mo = &actors[i];
        if (!(mo->flags & MF_NOBLOCKMAP) && mo->blockx == x && mo->blocky == y && !check(mo)) return false;
    }
    return true;
}
// These fixtures have no blocking lines. Model PIT_CheckThing for ordinary corpses.
static boolean P_CheckPosition(mobj_t *mo, fixed_t x, fixed_t y) {
    if (mo->flags & MF_NOCLIP) return true;
    for (int i = count; i > 0; i--) {
        mobj_t *other = &actors[i];
        if (mo == other || !(other->flags & MF_SOLID) || other->flags & MF_NOBLOCKMAP) continue;
        fixed_t reach = mo->radius + other->radius;
        if (abs(other->x - x) < reach && abs(other->y - y) < reach) return false;
    }
    return true;
}
`;

const FIXTURES = String.raw`
static void seed(int handle, int kind, fixed_t x, fixed_t y, fixed_t z, angle_t angle,
    fixed_t mx, fixed_t my, fixed_t mz, int hp, int flags, int dir, int tics, fixed_t radius, fixed_t height) {
    mobj_t *mo = &actors[handle];
    *mo = (mobj_t){.type = kind, .info = &mobjinfo[kind], .x = x, .y = y, .z = z, .angle = angle,
        .momx = mx, .momy = my, .momz = mz, .health = hp, .flags = flags, .movedir = dir, .tics = tics,
        .radius = radius < 0 ? mobjinfo[kind].radius : radius, .height = height < 0 ? mobjinfo[kind].height : height,
        .state = &states[mobjinfo[kind].spawnstate]};
    P_SetThingPosition(mo);
    mo->floorz = mo->subsector->sector->floorheight;
    mo->ceilingz = mo->subsector->sector->ceilingheight;
    count = handle;
}
static void reset(int rejected, int low, int rng) {
    memset(actors, 0, sizeof(actors));
    count = 0;
    prndindex = rng;
    blocked = rejected;
    sectors[1].ceilingheight = (low ? 32 : 160) * FRACUNIT;
}
static void clearEvents(void) {
    memset(sounds, 0, sizeof(sounds));
    memset(direct, 0, sizeof(direct));
    memset(blast, 0, sizeof(blast));
    chased = 0;
}
static void emit(void) {
    printf("{\"actors\":[");
    for (int i = 1; i <= count; i++) {
        mobj_t *mo = &actors[i];
        if (i > 1) putchar(',');
        printf("[%d,%d,%d,%d,%u,%d,%d,%d,%d,%d,%d,%d,%td,%d,%ld,%td,%d,%d,%d,%d]", mo->type,
            mo->x, mo->y, mo->z, mo->angle, mo->momx, mo->momy, mo->momz, mo->health, mo->flags,
            mo->floorz, mo->ceilingz, mo->subsector - leaves, mo->lastlook, mo->tics, mo->state - states,
            handle(mo->target), handle(mo->tracer), mo->radius, mo->height);
    }
    printf("],\"rng\":%d,\"sound\":[%d,%d],\"direct\":[%d,%d,%d,%d],\"blast\":[%d,%d,%d],\"chase\":%d}\n",
        prndindex, sounds[0], sounds[1], direct[0], direct[1], direct[2], direct[3], blast[0], blast[1], blast[2], chased);
}
`;
