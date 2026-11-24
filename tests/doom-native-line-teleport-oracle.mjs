// Run pinned EV_Teleport and P_CrossSpecialLine with synthetic thinkers and sectors.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

function fixtureSource({ bodies, special, side = 0, tag = 7, map = 7, rng = 0, direct = false }) {
    const seed = bodies.map((row, index) => `seed(${[index + 1, ...row]});`).join("\n        ");
    const dispatch = direct ? `EV_Teleport(&lines[0], ${side}, &actors[1]);` : `P_CrossSpecialLine(0, ${side}, &actors[1]);`;
    return `{
        reset(${[special, tag, map, rng]});
        ${seed}
        ${dispatch} emit();
    }`;
}

function compileSource(upstream, cases) {
    const read = file => readFileSync(path.join(upstream, file), "utf8").replaceAll("\r\n", "\n");
    const info = read("info.c"), mobj = read("p_mobj.c"), movement = read("movement-p_map.c"), random = read("light-m_random.c");
    const metadata = info.slice(info.indexOf("char *sprnames["));
    const actorFlags = read("p_mobj.h").match(/typedef enum\s*\{[\s\S]*?\}\s*mobjflag_t;/)?.[0];
    assert.ok(actorFlags?.includes("MF_NOBLOCKMAP") && metadata.startsWith("char *sprnames["));
    const actionStubs = [...new Set(Array.from(metadata.matchAll(/void\s+(A_[A-Za-z0-9_]+)\s*\(/g), match => match[1]))]
        .map(name => `void ${name}(void) { abort(); }`);
    const crossing = extractFunction(read("animated-p_spec.c"), "void", "P_CrossSpecialLine");
    // The corpus never invokes unrelated line actions. Fail if that changes.
    const lineStubs = [...new Set(crossing.match(/\b(?:EV_|G_)[A-Za-z]+\b/g))].filter(name => name !== "EV_Teleport")
        .map(name => `#define ${name}(...) abort()`);
    return [
        HEADER, read("info.h").replace(/^#include "d_think.h"$/m, ""), read("sounds.h"), actorFlags, ...actionStubs,
        metadata, random.slice(random.indexOf("unsigned char rndtable[")), read("tables.c").replace(/^#include.*$/gm, ""),
        WORLD, extractFunction(mobj, "mobj_t\\*", "P_SpawnMobj"), extractFunction(movement, "boolean", "PIT_StompThing"),
        extractFunction(movement, "boolean", "P_TeleportMove"),
        "static boolean recordTeleport(mobj_t *mo, fixed_t x, fixed_t y) { warped = P_TeleportMove(mo, x, y); return warped; }",
        extractFunction(read("p_telept.c"), "int", "EV_Teleport").replace("P_TeleportMove (", "recordTeleport ("),
        ...lineStubs, crossing, FIXTURES, "int main(void) {", ...cases.map(fixtureSource), "return 0;\n}",
    ].join("\n");
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

export function runNativeLineTeleportOracle(upstream, scratch, cases) {
    const source = path.join(scratch, "line-teleport.c"), executable = path.join(scratch, "line-teleport.exe");
    writeFileSync(source, compileSource(upstream, cases));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", "-fno-strict-aliasing", source, "-o", executable]);
    const frames = run(executable, []).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(frames.length, cases.length);
    return frames;
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
#define SLOPERANGE 2048
#define ANG90 UINT32_C(0x40000000)
#define ANGLETOFINESHIFT 19
#define MAPBLOCKSHIFT 23
#define MAXRADIUS (32 * FRACUNIT)
#define MAXPLAYERS 4
#define ONFLOORZ INT32_MIN
#define ONCEILINGZ INT32_MAX
#define PU_LEVEL 50
enum { sk_nightmare = 4 };
`;

const WORLD = String.raw`
typedef struct { fixed_t floorheight, ceilingheight; int tag; } sector_t;
typedef struct { sector_t *sector; } subsector_t;
typedef struct { fixed_t viewheight, viewz; } player_t;
typedef struct { int tag, special; } line_t;
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
    player_t *player;
} mobj_t;
static int gameskill = 2, gamemap, count, soundCount, hitCount, warped;
static int sounds[2][2], hits[16][4];
static mobj_t actors[32], *tmthing;
static thinker_t thinkercap, *tail;
static player_t player;
static line_t lines[1];
static sector_t sectors[] = {{0, 160 * FRACUNIT, 0}, {24 * FRACUNIT, 140 * FRACUNIT, 7}, {48 * FRACUNIT, 208 * FRACUNIT, 7}};
static subsector_t leaves[] = {{&sectors[0]}, {&sectors[1]}, {&sectors[2]}};
static const int numsectors = 3;
enum { BOXTOP, BOXBOTTOM, BOXLEFT, BOXRIGHT };
static int tmflags, validcount, numspechit;
static fixed_t tmx, tmy, tmbbox[4], tmfloorz, tmceilingz, tmdropoffz, *finecosine = finesine + FINEANGLES / 4;
static const fixed_t bmaporgx = -512 * FRACUNIT, bmaporgy = -512 * FRACUNIT;
static void *ceilingline;

static int handle(mobj_t *mo) { return mo ? (int)(mo - actors) : 0; }
static void S_StartSound(mobj_t *origin, int sound) {
    if (soundCount >= 2) abort();
    sounds[soundCount][0] = handle(origin); sounds[soundCount++][1] = sound;
}
static void P_AddThinker(thinker_t *thinker) {
    tail->next = thinker;
    tail = thinker;
    tail->next = &thinkercap;
}
static void *Z_Malloc(size_t size, int tag, void *owner) {
    if (size != sizeof(mobj_t) || tag != PU_LEVEL || owner || count == 31) abort();
    return &actors[++count];
}
static void P_MobjThinker(mobj_t *mo) { abort(); }
static subsector_t *R_PointInSubsector(fixed_t x, fixed_t y) { return &leaves[x < 0 ? 0 : (x < 128 * FRACUNIT ? 1 : 2)]; }
static void P_SetThingPosition(mobj_t *mo) { mo->subsector = R_PointInSubsector(mo->x, mo->y); }
static void P_UnsetThingPosition(mobj_t *mo) {}
static boolean P_BlockThingsIterator(int x, int y, boolean (*check)(mobj_t *)) {
    if (x < 0 || x >= 8 || y < 0 || y >= 8) return true;
    for (int i = count; i > 0; i--) {
        mobj_t *mo = &actors[i];
        if (!(mo->flags & MF_NOBLOCKMAP) && ((mo->x - bmaporgx) >> MAPBLOCKSHIFT) == x &&
            ((mo->y - bmaporgy) >> MAPBLOCKSHIFT) == y && !check(mo)) return false;
    }
    return true;
}
static void P_DamageMobj(mobj_t *target, mobj_t *inflictor, mobj_t *source, int damage) {
    if (hitCount >= 16) abort();
    hits[hitCount][0] = handle(target); hits[hitCount][1] = handle(inflictor);
    hits[hitCount][2] = handle(source); hits[hitCount++][3] = damage;
    // The corpus uses ordinary lethal player-mobj hits. Account for the
    // P_KillMobj death-tic draw before either fog consumes its spawn RNG.
    P_Random();
}
`;

const FIXTURES = String.raw`
static void seed(int handle, int kind, fixed_t x, fixed_t y, fixed_t z, angle_t angle, int flags, int reaction,
    fixed_t mx, fixed_t my, fixed_t mz, fixed_t viewheight) {
    mobj_t *mo = &actors[handle];
    mobjinfo_t *info = &mobjinfo[kind];
    *mo = (mobj_t){.type = kind, .info = info, .x = x, .y = y, .z = z, .angle = angle, .flags = flags,
        .reactiontime = reaction, .momx = mx, .momy = my, .momz = mz, .state = &states[info->spawnstate],
        .tics = states[info->spawnstate].tics, .radius = info->radius, .height = info->height};
    if (viewheight) { mo->player = &player; player.viewheight = viewheight; }
    mo->thinker.function.acp1 = (actionf_p1)P_MobjThinker;
    P_AddThinker(&mo->thinker);
    P_SetThingPosition(mo);
    mo->floorz = mo->subsector->sector->floorheight;
    mo->ceilingz = mo->subsector->sector->ceilingheight;
    count = handle;
}
static void reset(int special, int tag, int map, int rng) {
    memset(actors, 0, sizeof(actors));
    player = (player_t){0};
    lines[0] = (line_t){tag, special};
    gamemap = map;
    prndindex = rng;
    count = soundCount = hitCount = warped = 0;
    numspechit = 3;
    tail = thinkercap.next = &thinkercap;
}
static void emit(void) {
    printf("{\"special\":%d,\"tried\":%d,\"warped\":%d,\"eye\":%d,\"rng\":%d,\"sounds\":[",
        lines[0].special, numspechit == 0, warped, player.viewz, prndindex);
    for (int i = 0; i < soundCount; i++) printf("%s[%d,%d]", i ? "," : "", sounds[i][0], sounds[i][1]);
    printf("],\"hits\":[");
    for (int i = 0; i < hitCount; i++) printf("%s[%d,%d,%d,%d]", i ? "," : "", hits[i][0], hits[i][1], hits[i][2], hits[i][3]);
    printf("],\"actors\":[");
    for (int i = 1; i <= count; i++) {
        mobj_t *mo = &actors[i];
        if (i > 1) putchar(',');
        printf("[%d,%d,%d,%d,%d,%d,%td,%u,%d,%d,%d,%d,%td,%ld,%d]", mo->type, mo->x, mo->y, mo->z, mo->floorz,
            mo->ceilingz, mo->subsector - leaves, mo->angle, mo->momx, mo->momy, mo->momz, mo->reactiontime,
            mo->state - states, mo->tics, mo->lastlook);
    }
    puts("]}");
}
`;
