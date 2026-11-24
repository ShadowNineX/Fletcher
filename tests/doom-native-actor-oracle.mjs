// Compile the pinned actor startup code without the renderer, sound, or AI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function extractFunction(source, result, name) {
    const match = source.match(new RegExp(`^${result}\\s+${name}\\s*\\([^;{}]+\\)\\s*\\{[\\s\\S]+?^}`, "m"));
    assert.ok(match, `Missing pinned C function ${name}`);
    return match[0];
}

function compileSource(upstreamDir, cases) {
    const read = file => readFileSync(path.join(upstreamDir, file), "utf8").replaceAll("\r\n", "\n");
    const info = read("info.c");
    const header = read("info.h").replace(/^#include "d_think.h"$/m, "");
    const flags = read("p_mobj.h").match(/typedef enum\s*\{[\s\S]*?\}\s*mobjflag_t;/)?.[0];
    const metadata = info.slice(info.indexOf("char *sprnames["));
    const random = read("light-m_random.c");
    assert.ok(flags?.includes("MF_TRANSSHIFT") && metadata.startsWith("char *sprnames["));
    assert.ok(random.includes("int P_Random (void)"));
    const actions = [...new Set(Array.from(metadata.matchAll(/void\s+(A_[A-Za-z0-9_]+)\s*\(/g), match => match[1]))];
    const actionStubs = actions.map((name, index) => `void ${name}(void) { unexpectedAction = ${index + 1}; abort(); }`).join("\n");
    const spawn = read("p_mobj.c");
    const mapSetup = read("p_setup.c");
    const fixtures = cases.map(({ things }, index) => `static mapthing_t things${index}[] = {
    ${things.map(values => `{${values.join(", ")}}`).join(",\n    ")}
};`).join("\n");
    const actorCapacity = Math.max(1, ...cases.map(({ things }) => things.length));
    const commands = cases.map((entry, index) => `    runCase(things${index}, sizeof(things${index}), ${entry.skill},
        ${Number(entry.commercial)}, ${Number(entry.noMonsters)}, ${entry.health[0]});`).join("\n");
    return `#include <inttypes.h>
#include <limits.h>
#include <setjmp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef unsigned char byte;
typedef enum { false, true } boolean;
typedef int32_t fixed_t;
typedef uint32_t angle_t;
typedef void (*actionf_p1)(void *);
typedef union { void (*acv)(void); actionf_p1 acp1; } actionf_t;

#define MAXPLAYERS 4
#define NUMCARDS 6
#define FRACBITS 16
#define FRACUNIT (1 << FRACBITS)
#define ANG45 UINT32_C(0x20000000)
#define VIEWHEIGHT (41 * FRACUNIT)
#define ONFLOORZ INT32_MIN
#define ONCEILINGZ INT32_MAX
#define MTF_AMBUSH 8
#define SHORT(value) (value)
#define PU_STATIC 1
#define PU_LEVEL 50

${header}
${read("sounds.h")}
${flags}
static volatile int unexpectedAction;
${actionStubs}
${metadata}
${random}

typedef struct { short x, y, angle, type, options; } mapthing_t;
typedef struct { actionf_t function; } thinker_t;
typedef struct { fixed_t floorheight, ceilingheight; } sector_t;
typedef struct { sector_t *sector; } subsector_t;
typedef struct player_s player_t;
typedef struct {
    thinker_t thinker;
    mobjtype_t type;
    mobjinfo_t *info;
    fixed_t x, y, z, floorz, ceilingz, radius, height;
    int flags, health, reactiontime, lastlook;
    state_t *state;
    long tics, frame;
    spritenum_t sprite;
    subsector_t *subsector;
    angle_t angle;
    player_t *player;
    mapthing_t spawnpoint;
} mobj_t;
enum { PST_LIVE, PST_DEAD, PST_REBORN };
struct player_s {
    mobj_t *mo;
    int health, playerstate, refire, damagecount, bonuscount, extralight, fixedcolormap;
    const char *message;
    fixed_t viewheight;
    boolean cards[NUMCARDS];
};
enum { sk_baby = 0, sk_nightmare = 4 };
enum { registered, commercial };

static sector_t sectors[] = { {8 * FRACUNIT, 128 * FRACUNIT}, {-16 * FRACUNIT, 192 * FRACUNIT} };
static subsector_t leaves[] = { {&sectors[0]}, {&sectors[1]} };
static mobj_t *actors[${actorCapacity}];
static size_t count;
static int gameskill, gamemode, deathmatch, consoleplayer, totalkills, totalitems;
static boolean netgame, nomonsters, playeringame[MAXPLAYERS] = {true, false, false, false};
static player_t players[MAXPLAYERS];
static mapthing_t playerstarts[MAXPLAYERS], deathmatchstarts[10], *deathmatch_p;
static mapthing_t *things;
static int thingBytes, thingIndex, rejectedThing;
static jmp_buf badThing;

// Provide the deterministic map partition and allocation services. The pinned
// routines own actor initialization, RNG, player state updates, and filtering.
static void P_SetThingPosition(mobj_t *mobj) { mobj->subsector = &leaves[mobj->x > 0]; }
static void P_AddThinker(thinker_t *thinker) {
    if (count == sizeof(actors) / sizeof(actors[0])) abort();
    actors[count++] = (mobj_t *) thinker;
}
static void *Z_Malloc(size_t size, int tag, void *owner) {
    void *item = malloc(size);
    if (!item || tag != PU_LEVEL || owner) abort();
    return item;
}
static void P_MobjThinker(mobj_t *mobj) { (void) mobj; abort(); }
static void G_PlayerReborn(int player) { (void) player; abort(); }
static void P_SetupPsprites(player_t *player) { (void) player; }
static void ST_Start(void) {}
static void HU_Start(void) {}
static void I_Error(const char *message, ...) {
    if (strncmp(message, "P_SpawnMapThing: Unknown type", 29) != 0) abort();
    rejectedThing = thingIndex;
    longjmp(badThing, 1);
}
static byte *W_CacheLumpNum(int lump, int tag) {
    if (lump != 0 || tag != PU_STATIC) abort();
    return (byte *) things;
}
static int W_LumpLength(int lump) {
    if (lump != 0) abort();
    return thingBytes;
}
static void Z_Free(void *data) { if (data != things) abort(); }

${extractFunction(spawn, "mobj_t\\*", "P_SpawnMobj")}
${extractFunction(spawn, "void", "P_SpawnPlayer")}
${extractFunction(spawn, "void", "P_SpawnMapThing")}

static void trackMapThing(mapthing_t *thing) {
    thingIndex = (int) (thing - things);
    P_SpawnMapThing(thing);
}
#define P_SpawnMapThing trackMapThing
${extractFunction(mapSetup, "void", "P_LoadThings")}
#undef P_SpawnMapThing

static void emitRow(const int64_t *values, size_t length) {
    for (size_t field = 0; field < length; ++field)
        printf("%s%" PRId64, field ? "," : "", values[field]);
    puts("");
}
#define ROW(...) emitRow((int64_t[]){__VA_ARGS__}, sizeof((int64_t[]){__VA_ARGS__}) / sizeof(int64_t))

static void emitMetadata(void) {
    for (int i = 0; i < NUMMOBJTYPES; ++i) {
        mobjinfo_t m = mobjinfo[i];
        int kind = -1;
        if (m.doomednum >= 0) {
            for (kind = 0; mobjinfo[kind].doomednum != m.doomednum; ++kind) {}
        }
        ROW(i, m.doomednum, kind, m.spawnstate, m.spawnhealth, m.seestate, m.seesound,
            m.reactiontime, m.attacksound, m.painstate, m.painchance, m.painsound, m.meleestate,
            m.missilestate, m.deathstate, m.xdeathstate, m.deathsound, m.speed, m.radius, m.height,
            m.mass, m.damage, m.activesound, m.raisestate, (uint32_t) m.flags);
    }
    void (*actionTable[])(void) = {NULL, ${actions.join(", ")}};
    for (int i = 0; i < NUMSTATES; ++i) {
        state_t s = states[i];
        size_t action = 0;
        while (action < sizeof(actionTable) / sizeof(actionTable[0]) && actionTable[action] != s.action.acv) ++action;
        if (action == sizeof(actionTable) / sizeof(actionTable[0])) abort();
        ROW(i, s.sprite, s.frame, s.tics, action, s.nextstate, s.misc1, s.misc2);
    }
    for (int i = 0; i < NUMSPRITES; ++i) {
        uint32_t name = 0;
        for (int c = 0; c < 4; ++c) name |= (uint32_t) ((byte) sprnames[i][c]) << (c * 8);
        ROW(i, name);
    }
    puts("end");
}

static int handle(const mobj_t *actor) {
    if (!actor) return 0;
    for (size_t i = 0; i < count; ++i) if (actors[i] == actor) return (int) i + 1;
    abort();
}

static void runCase(mapthing_t *data, size_t size, int skill, boolean doom2, boolean pacifist, int health) {
    count = 0;
    totalkills = totalitems = 0;
    gameskill = skill;
    gamemode = doom2 ? commercial : registered;
    netgame = false;
    deathmatch = 0;
    nomonsters = pacifist;
    things = data;
    thingBytes = (int) size;
    thingIndex = rejectedThing = -1;
    deathmatch_p = deathmatchstarts;
    memset(deathmatchstarts, 0, sizeof(deathmatchstarts));
    memset(playerstarts, 0, sizeof(playerstarts));
    memset(players, 0, sizeof(players));
    players[0].health = health;
    M_ClearRandom();
    if (setjmp(badThing) == 0) P_LoadThings(0);

    ROW(count, totalkills, totalitems, prndindex, rejectedThing >= 0, rejectedThing,
        handle(players[0].mo), handle(players[1].mo), handle(players[2].mo), handle(players[3].mo));
    for (size_t index = 0; index < count; ++index) {
        mobj_t *actor = actors[index];
        ROW(actor->type, actor->x, actor->y, actor->z, actor->floorz, actor->ceilingz,
            actor->subsector - leaves, actor->radius, actor->height, (uint32_t) actor->flags,
            actor->health, actor->reactiontime, actor->lastlook, actor->state - states, actor->tics,
            actor->sprite, actor->frame, actor->angle, actor->player ? actor->player - players : -1,
            actor->spawnpoint.x, actor->spawnpoint.y, actor->spawnpoint.angle, actor->spawnpoint.type,
            actor->spawnpoint.options);
        free(actor);
    }
    puts("end");
}

${fixtures}
int main(void) {
${commands}
    emitMetadata();
    return 0;
}
`;
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 25000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

export function runNativeActorOracle(upstreamDir, scratch, cases) {
    const source = path.join(scratch, "actor-oracle.c");
    const executable = path.join(scratch, "actor-oracle.exe");
    writeFileSync(source, compileSource(upstreamDir, cases));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", executable]);
    const stdout = run(executable, []);
    const traces = stdout.trim().split(/\r?\nend(?:\r?\n|$)/).filter(Boolean);
    assert.equal(traces.length, cases.length + 1, "one native trace per startup fixture, followed by metadata");
    const rows = traces.map(trace => trace.split(/\r?\n/).map(row => row.split(",").map(Number)));
    return { metadata: rows.pop(), spawns: rows };
}
