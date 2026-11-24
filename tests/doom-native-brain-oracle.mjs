// Headless trace of the original Icon of Sin states and spawn primitives.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

const actions = { awake: "A_BrainAwake", spit: "A_BrainSpit", fly: "A_SpawnFly", spawnSound: "A_SpawnSound",
    scream: "A_BrainScream", explode: "A_BrainExplode" };

function fixtureSource({ bodies, commands, skill = 2, rng = 0, map = 30, carryEasy = false }) {
    const seed = bodies.map((row, i) => `seed(${[i + 1, ...row]});`).join("\n        ");
    return `{
        reset(${skill}, ${rng}, ${map}, ${Number(carryEasy)});
        ${seed}
        ${commands.map(command => `clearEvents(); ${actions[command]}(&actors[1]); emit(); puts("step");`).join("\n        ")}
        puts("fixture");
    }`;
}

function compileSource(upstreamDir, fixtures) {
    const read = file => readFileSync(path.join(upstreamDir, file), "utf8").replaceAll("\r\n", "\n");
    const enemy = read("p_enemy.c"), info = read("info.c"), mobj = read("p_mobj.c"), random = read("light-m_random.c");
    const movement = read("movement-p_map.c");
    const metadata = info.slice(info.indexOf("char *sprnames["));
    const prototypes = [...new Set(Array.from(metadata.matchAll(/void\s+(A_[A-Za-z0-9_]+)\s*\(/g), match => match[1]))];
    const nativeActions = Object.values(actions);
    const stubs = prototypes.filter(name => !nativeActions.includes(name)).map(name => `void ${name}(void) { abort(); }`);
    const flags = read("p_mobj.h").match(/typedef enum\s*\{[\s\S]*?\}\s*mobjflag_t;/)?.[0];
    assert.ok(flags?.includes("MF_MISSILE") && metadata.startsWith("char *sprnames["));
    const spit = extractFunction(enemy, "void", "A_BrainSpit");
    assert.ok(spit.includes("static int\teasy = 0;"));
    return [
        HEADER, read("info.h").replace(/^#include "d_think.h"$/m, ""), read("sounds.h"), flags, ...stubs,
        metadata, random.slice(random.indexOf("unsigned char rndtable[")), read("tables.c").replace(/^#include.*$/gm, ""),
        WORLD, extractFunction(read("r_main.c"), "angle_t", "R_PointToAngle"),
        extractFunction(read("r_main.c"), "angle_t", "R_PointToAngle2"), extractFunction(read("m_fixed.c"), "fixed_t", "FixedMul"),
        extractFunction(read("movement-p_maputl.c"), "fixed_t", "P_AproxDistance"),
        ...[["boolean", "P_SetMobjState"], ["mobj_t\\*", "P_SpawnMobj"], ["void", "P_ExplodeMissile"],
            ["void", "P_CheckMissileSpawn"], ["mobj_t\\*", "P_SpawnMissile"]].map(([type, name]) => extractFunction(mobj, type, name)),
        extractFunction(movement, "boolean", "PIT_StompThing"), extractFunction(movement, "boolean", "P_TeleportMove"),
        "static boolean recordTeleport(mobj_t *mo, fixed_t x, fixed_t y) { warp = handle(mo); return P_TeleportMove(mo, x, y); }",
        ...nativeActions.filter(name => name !== "A_BrainSpit").map(name => extractFunction(enemy, "void", name)
            .replace("P_TeleportMove (", "recordTeleport (")),
        // Keep the native toggle between steps while isolating scenarios.
        spit.replace("static int\teasy = 0;", ""), FIXTURES,
        "int main(void) {", ...fixtures.map(fixtureSource), "return 0;\n}",
    ].join("\n");
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

export function runNativeBrainOracle(upstreamDir, scratch, fixtures) {
    const source = path.join(scratch, "brain-oracle.c"), executable = path.join(scratch, "brain-oracle.exe");
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
typedef struct thinker_s { actionf_t function; struct thinker_s *next; } thinker_t;
#define FRACBITS 16
#define FRACUNIT (1 << FRACBITS)
#define FINEANGLES 8192
#define ANG90 UINT32_C(0x40000000)
#define ANG180 UINT32_C(0x80000000)
#define ANG270 UINT32_C(0xc0000000)
#define ANGLETOFINESHIFT 19
#define SLOPERANGE 2048
#define MAXPLAYERS 4
#define MAPBLOCKSHIFT 23
#define MAXRADIUS (32 * FRACUNIT)
#define ONFLOORZ INT32_MIN
#define ONCEILINGZ INT32_MAX
#define PU_LEVEL 50
enum { sk_easy = 1, sk_nightmare = 4 };
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
    fixed_t x, y, z, momx, momy, momz, floorz, ceilingz, radius, height;
    angle_t angle;
    int health, flags, lastlook, reactiontime;
    subsector_t *subsector;
    struct mobj_s *target;
    void *player;
} mobj_t;
static fixed_t viewx, viewy, *finecosine = finesine + FINEANGLES / 4;
static int gameskill, count, soundCount, sounds[16][2], warp, easy;
static int gamemap, hitCount, hits[16][4];
static mobj_t actors[128], *braintargets[32];
static int removed[128], numbraintargets, braintargeton;
static thinker_t thinkercap, *tail;
static sector_t sector = {0, 192 * FRACUNIT};
static subsector_t leaf = {&sector};
enum { BOXTOP, BOXBOTTOM, BOXLEFT, BOXRIGHT };
static int tmflags, validcount, numspechit;
static mobj_t *tmthing;
static fixed_t tmx, tmy, tmbbox[4], tmfloorz, tmceilingz, tmdropoffz;
static const fixed_t bmaporgx = -512 * FRACUNIT, bmaporgy = -512 * FRACUNIT;
static void *ceilingline;

static int handle(mobj_t *mo) { return mo ? (int)(mo - actors) : 0; }
static void S_StartSound(mobj_t *origin, int sound) {
    if (soundCount >= 16) abort();
    sounds[soundCount][0] = handle(origin); sounds[soundCount++][1] = sound;
}
static void P_AddThinker(thinker_t *thinker) {
    tail->next = thinker;
    tail = thinker;
    tail->next = &thinkercap;
}
static void *Z_Malloc(size_t size, int tag, void *owner) {
    if (size != sizeof(mobj_t) || tag != PU_LEVEL || owner || count == 127) abort();
    return &actors[++count];
}
static void P_MobjThinker(mobj_t *mo) { abort(); }
static void P_SetThingPosition(mobj_t *mo) { mo->subsector = &leaf; }
static void P_UnsetThingPosition(mobj_t *mo) {}
static subsector_t *R_PointInSubsector(fixed_t x, fixed_t y) { return &leaf; }
static boolean P_TryMove(mobj_t *mo, fixed_t x, fixed_t y) { P_SetThingPosition(mo); return true; }
static boolean P_BlockThingsIterator(int x, int y, boolean (*check)(mobj_t *)) {
    if (x < 0 || x >= 8 || y < 0 || y >= 8) return true;
    for (int i = count; i > 0; i--) {
        mobj_t *mo = &actors[i];
        if (!removed[i] && !(mo->flags & MF_NOBLOCKMAP) && ((mo->x - bmaporgx) >> MAPBLOCKSHIFT) == x &&
            ((mo->y - bmaporgy) >> MAPBLOCKSHIFT) == y && !check(mo)) return false;
    }
    return true;
}
static void P_DamageMobj(mobj_t *target, mobj_t *inflictor, mobj_t *source, int damage) {
    if (hitCount >= 16) abort();
    hits[hitCount][0] = handle(target); hits[hitCount][1] = handle(inflictor);
    hits[hitCount][2] = handle(source); hits[hitCount++][3] = damage;
}
static boolean P_LookForPlayers(mobj_t *mo, boolean allAround) { return false; }
static void P_RemoveMobj(mobj_t *mo) {
    removed[handle(mo)] = 1;
    mo->thinker.function.acp1 = NULL;
}
`;

const FIXTURES = String.raw`
static void seed(int handle, int kind, fixed_t x, fixed_t y, fixed_t z, angle_t angle, int flags,
    int reactiontime, int tics, int target) {
    mobj_t *mo = &actors[handle];
    *mo = (mobj_t){.type = kind, .info = &mobjinfo[kind], .x = x, .y = y, .z = z, .angle = angle, .flags = flags,
        .reactiontime = reactiontime, .tics = tics, .target = target ? &actors[target] : NULL,
        .state = &states[mobjinfo[kind].spawnstate], .ceilingz = sector.ceilingheight,
        .radius = mobjinfo[kind].radius, .height = mobjinfo[kind].height};
    mo->thinker.function.acp1 = (actionf_p1)P_MobjThinker;
    P_AddThinker(&mo->thinker);
    P_SetThingPosition(mo);
    count = handle;
}
static void reset(int skill, int rng, int map, int carryEasy) {
    memset(actors, 0, sizeof(actors));
    memset(removed, 0, sizeof(removed));
    numbraintargets = braintargeton = count = 0;
    if (!carryEasy) easy = 0;
    prndindex = rng;
    gameskill = skill;
    gamemap = map;
    tail = thinkercap.next = &thinkercap;
}
static void clearEvents(void) { soundCount = warp = hitCount = 0; }
static void emit(void) {
    printf("{\"rng\":%d,\"cursor\":%d,\"targets\":[", prndindex, braintargeton);
    for (int i = 0; i < numbraintargets; i++) printf("%s%d", i ? "," : "", handle(braintargets[i]));
    printf("],\"sounds\":[");
    for (int i = 0; i < soundCount; i++) printf("%s[%d,%d]", i ? "," : "", sounds[i][0], sounds[i][1]);
    printf("],\"warp\":%d,\"hits\":[", warp);
    for (int i = 0; i < hitCount; i++) printf("%s[%d,%d,%d,%d]", i ? "," : "", hits[i][0], hits[i][1], hits[i][2], hits[i][3]);
    printf("],\"actors\":[");
    for (int i = 1; i <= count; i++) {
        mobj_t *mo = &actors[i];
        if (i > 1) putchar(',');
        printf("[%d,%d,%d,%d,%u,%d,%d,%d,%ld,%d,%d,%td,%d,%d]", mo->type, mo->x, mo->y, mo->z, mo->angle,
            mo->momx, mo->momy, mo->momz, mo->tics, mo->reactiontime, handle(mo->target), mo->state - states,
            mo->lastlook, !removed[i]);
    }
    puts("]}");
}
`;
