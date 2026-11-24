// Compile the original actions and mobj helpers against a small synthetic world.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

const actions = {
    skel: "A_SkelMissile", tracer: "A_Tracer", whoosh: "A_SkelWhoosh", fist: "A_SkelFist", demonBite: "A_SargAttack",
    fatRaise: "A_FatRaise", fat1: "A_FatAttack1", fat2: "A_FatAttack2", fat3: "A_FatAttack3",
    painAttack: "A_PainAttack", painDie: "A_PainDie",
};

function fixtureSource({ actor, target, actions: commands, rng, gameTic, tryMove, attackRange, skulls, split }) {
    const args = body => [body.kind, body.x, body.y, body.z, body.angle, body.mx, body.my, body.mz, body.health, body.flags];
    return `{
        reset(${[rng, gameTic, Number(tryMove), attackRange, skulls, split]});
        seed(&actor, ${args(actor)});
        seed(&target, ${args(target)});
        actor.target = ${target.present ? "&target" : "NULL"};
        actor.tracer = ${target.tracked ? "&target" : "NULL"};
        ${commands.map(command => `clearEvents(); ${actions[command]}(&actor); emit(); puts("step");`).join("\n    ")}
        puts("fixture");
    }`;
}

function compileSource(upstreamDir, fixtures) {
    const read = file => readFileSync(path.join(upstreamDir, file), "utf8").replaceAll("\r\n", "\n");
    const enemy = read("p_enemy.c"), mobj = read("p_mobj.c"), info = read("info.c");
    const metadata = info.slice(info.indexOf("char *sprnames["));
    const random = read("light-m_random.c");
    const prototypes = [...new Set(Array.from(metadata.matchAll(/void\s+(A_[A-Za-z0-9_]+)\s*\(/g), match => match[1]))];
    const enemyFunctions = ["A_FaceTarget", "A_Fall", "A_SkullAttack", "A_PainShootSkull", ...Object.values(actions)];
    const stubs = prototypes.filter(name => !enemyFunctions.includes(name)).map(name => `void ${name}(void) { abort(); }`);
    const flags = read("p_mobj.h").match(/typedef enum\s*\{[\s\S]*?\}\s*mobjflag_t;/)?.[0];
    assert.ok(flags?.includes("MF_SKULLFLY") && metadata.startsWith("char *sprnames["));
    const functions = (source, names) => names.map(([type, name]) => extractFunction(source, type, name));
    return [
        HEADER, read("info.h").replace(/^#include "d_think.h"$/m, ""), read("sounds.h"), flags,
        ...stubs, metadata, random.slice(random.indexOf("unsigned char rndtable[")),
        read("tables.c").replace(/^#include.*$/gm, ""),
        WORLD, ...functions(read("r_main.c"), [["angle_t", "R_PointToAngle"], ["angle_t", "R_PointToAngle2"]]),
        extractFunction(read("m_fixed.c"), "fixed_t", "FixedMul"),
        extractFunction(read("movement-p_maputl.c"), "fixed_t", "P_AproxDistance"),
        ...functions(mobj, [["boolean", "P_SetMobjState"], ["mobj_t\\*", "P_SpawnMobj"], ["void", "P_ExplodeMissile"],
            ["void", "P_SpawnPuff"], ["void", "P_CheckMissileSpawn"], ["mobj_t\\*", "P_SpawnMissile"]]),
        extractFunction(enemy, "boolean", "P_CheckMeleeRange"),
        ...enemyFunctions.map(name => extractFunction(enemy, "void", name)),
        FIXTURES, "int main(void) {", ...fixtures.map(fixtureSource), "return 0;\n}",
    ].join("\n");
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

export function runNativeHeavyOracle(upstreamDir, scratch, fixtures) {
    const source = path.join(scratch, "heavy-oracle.c"), executable = path.join(scratch, "heavy-oracle.exe");
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
#define MELEERANGE (64 * FRACUNIT)
#define SKULLSPEED (20 * FRACUNIT)
#define FATSPREAD (ANG90 / 8)
#define MAXPLAYERS 4
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
    int health, flags, lastlook, reactiontime;
    subsector_t *subsector;
    struct mobj_s *target, *tracer;
} mobj_t;

static int gameskill = 2, gametic, TRACEANGLE = 0x0c000000;
static fixed_t attackrange, viewx, viewy, *finecosine = finesine + FINEANGLES / 4;
static boolean tryMove;
static fixed_t split;
static sector_t sectors[] = {{0, 192 * FRACUNIT}, {0, 192 * FRACUNIT}};
static subsector_t leaves[] = {{&sectors[0]}, {&sectors[1]}};
static mobj_t actor, target, spawns[64], storedSkulls[21];
static thinker_t thinkercap, *tail;
static int spawnCount, initialSkulls;
static int sounds[16], soundCount, damage[4];

static int handle(mobj_t *mo) {
    if (!mo) return 0;
    if (mo == &actor) return 1;
    if (mo == &target) return 2;
    for (int i = 0; i < spawnCount; i++) if (mo == &spawns[i]) return initialSkulls + i + 3;
    abort();
}
static void S_StartSound(mobj_t *origin, int sound) {
    if (soundCount == 16) abort();
    sounds[soundCount++] = sound;
}
static void P_DamageMobj(mobj_t *target, mobj_t *inflictor, mobj_t *source, int amount) {
    damage[0] = handle(target);
    damage[1] = handle(inflictor);
    damage[2] = handle(source);
    damage[3] = amount;
}
static void P_MobjThinker(mobj_t *mo) { abort(); }
static void P_RemoveMobj(mobj_t *mo) { abort(); }
static boolean P_CheckSight(mobj_t *viewer, mobj_t *victim) { return true; }
static void P_AddThinker(thinker_t *thinker) {
    tail->next = thinker;
    tail = thinker;
    tail->next = &thinkercap;
}
static void *Z_Malloc(size_t size, int tag, void *owner) {
    if (size != sizeof(mobj_t) || tag != PU_LEVEL || owner || spawnCount == 64) abort();
    return &spawns[spawnCount++];
}
static void P_SetThingPosition(mobj_t *mo) { mo->subsector = &leaves[mo->x >= split]; }
static boolean P_TryMove(mobj_t *mo, fixed_t x, fixed_t y) {
    if (tryMove) P_SetThingPosition(mo);
    return tryMove;
}
`;

const FIXTURES = String.raw`
static void seed(mobj_t *mo, mobjtype_t kind, fixed_t x, fixed_t y, fixed_t z, angle_t angle,
    fixed_t mx, fixed_t my, fixed_t mz, int health, int flags) {
    *mo = (mobj_t){.type = kind, .info = &mobjinfo[kind], .x = x, .y = y, .z = z,
        .angle = angle, .momx = mx, .momy = my, .momz = mz, .health = health, .flags = flags,
        .radius = mobjinfo[kind].radius, .height = mobjinfo[kind].height};
    P_SetThingPosition(mo);
}
static void reset(int seed, int tic, int move, int range, int skulls, fixed_t partition) {
    if (skulls < 0 || skulls > 21) abort();
    prndindex = seed;
    gametic = tic;
    tryMove = move;
    attackrange = range;
    split = partition;
    initialSkulls = skulls;
    spawnCount = 0;
    tail = thinkercap.next = &thinkercap;
    for (int i = 0; i < skulls; i++) {
        storedSkulls[i] = (mobj_t){.type = MT_SKULL, .health = -1};
        storedSkulls[i].thinker.function.acp1 = (actionf_p1)P_MobjThinker;
        P_AddThinker(&storedSkulls[i].thinker);
    }
}
static void clearEvents(void) { soundCount = 0; memset(damage, 0, sizeof(damage)); }
static void emit(void) {
    printf("{\"actor\":[%d,%d,%d,%u,%d,%d,%d,%d,%d,%d],\"spawns\":[", actor.x, actor.y, actor.z,
        actor.angle, actor.momx, actor.momy, actor.momz, actor.flags, handle(actor.target), handle(actor.tracer));
    for (int i = 0; i < spawnCount; i++) {
        mobj_t *mo = &spawns[i];
        if (i) putchar(',');
        printf("[%d,%d,%d,%d,%u,%d,%d,%d,%ld,%d,%d,%td,%d,%td,%d,%d]", mo->type, mo->x, mo->y, mo->z,
            mo->angle, mo->momx, mo->momy, mo->momz, mo->tics, handle(mo->target), handle(mo->tracer),
            mo->state - states, mo->lastlook, mo->subsector - leaves, mo->health, mo->flags);
    }
    printf("],\"rng\":%d,\"sounds\":[", prndindex);
    for (int i = 0; i < soundCount; i++) printf("%s%d", i ? "," : "", sounds[i]);
    printf("],\"damage\":[%d,%d,%d,%d]}\n", damage[0], damage[1], damage[2], damage[3]);
}
`;
