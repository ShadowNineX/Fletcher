// Compare the port with pinned C using a synthetic, single-sector world.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

function compileSource(upstreamDir, cases, mode) {
    const projectiles = mode === "projectiles", nightmare = mode === "nightmare";
    const read = file => readFileSync(path.join(upstreamDir, file), "utf8").replaceAll("\r\n", "\n");
    const info = read("info.c");
    const metadata = info.slice(info.indexOf("char *sprnames["));
    const flags = read("p_mobj.h").match(/typedef enum\s*\{[\s\S]*?\}\s*mobjflag_t;/)?.[0];
    const header = read("info.h").replace(/^#include "d_think.h"$/m, "");
    const angles = read("r_main.c"), tables = read("tables.c");
    const spawn = read("p_mobj.c"), inter = read("p_inter.c");
    const map = read("movement-p_map.c"), mapUtil = read("movement-p_maputl.c");
    const fixed = read("m_fixed.c");
    const functions = (source, list) => list.map(([type, name]) => extractFunction(source, type, name)).join("\n");
    const motionConstants = spawn.match(/^#define (?:STOPSPEED|FRICTION)\b.*$/gm);
    assert.equal(motionConstants?.length, 2);
    assert.ok(flags?.includes("MF_JUSTHIT") && metadata.startsWith("char *sprnames["));
    const actions = [...new Set(Array.from(metadata.matchAll(/void\s+(A_[A-Za-z0-9_]+)\s*\(/g), match => match[1]))];
    const actionStubs = actions.map((name, index) =>
        "void " + name + "(void) { actionId = " + (index + 1) + "; }").join("\n");
    const setState = extractFunction(spawn, "boolean", "P_SetMobjState");
    const actionCall = "st->action.acp1(mobj);";
    assert.ok(setState.includes(actionCall));
    let setFastProjectileSpeeds = "";
    if (projectiles) {
        const assignments = read("g_game.c").match(/^\s*mobjinfo\[MT_(?:BRUISERSHOT|HEADSHOT|TROOPSHOT)\]\.speed\s*=.*;/gm);
        assert.equal(assignments?.length, 6, "G_InitNew fast and normal projectile speed assignments");
        setFastProjectileSpeeds = `static void setFastProjectileSpeeds(int fast) {
    if (fast) {${assignments.slice(0, 3).join("\n")}
    } else {${assignments.slice(3).join("\n")}
    }
}`;
    }
    const fixtures = cases.map(entry => {
        if (nightmare) {
            return `    runNightmareScenario(${entry.skill}, ${Number(entry.fast)}, ${Number(entry.respawn)}, ${Number(entry.blocked)});`;
        }
        const actors = entry.actors.map(a => "{ " +
            [a.kind, a.flags, a.health, a.x, a.y, a.z, a.height, a.mx, a.my, a.mz, a.slot, a.threshold,
                a.reaction, a.target, a.tics ?? 0, a.moveCount ?? 0, a.angle ?? 0].join(", ") +
            " }").join(", ");
        const players = entry.players.map(p => "{ " +
            [p.health, p.armor, p.armorType, p.invulnerable, p.ready, p.cheats, p.damageCount, p.attacker, p.killCount].join(", ") +
            ", {" + p.frags.join(", ") + "} }").join(", ");
        return "    reset(" + [entry.skill, entry.consolePlayer, Number(entry.automap),
            entry.sectorSpecial, entry.randomIndex, Number(entry.rollOnAction), entry.levelTime ?? 0,
            Number(entry.respawnMonsters ?? false)].join(", ") + ");\n"
            + "    seed((ActorInput[]){" + actors + "}, " + entry.actors.length + ", (PlayerInput[]){" + players + "});\n"
            + (projectiles
                ? "    setFastProjectileSpeeds(" + Number(entry.fast ?? false) + ");\n"
                    + "    setupProjectileMap(" + entry.barrier + ");\n"
                    + (entry.dest
                        ? "    P_SpawnMissile(byHandle(" + entry.source + "), byHandle(" + entry.dest + "), " + entry.kind + ");\n"
                        : "    P_SpawnPlayerMissile(byHandle(" + entry.source + "), " + entry.kind + ");\n")
                : entry.move
                ? "    P_MobjThinker(byHandle(" + entry.move + "));\n"
                : entry.explosion
                ? "    P_ExplodeMissile(byHandle(" + entry.explosion + "));\n"
                : "    P_DamageMobj(byHandle(" + entry.hit[0] + "), byHandle(" + entry.hit[1]
                    + "), byHandle(" + entry.hit[2] + "), " + entry.hit[3] + ");\n")
            + "    emit();";
    }).join("\n");
    const projectileGeometry = projectiles ? functions(fixed, [["fixed_t", "FixedDiv2"], ["fixed_t", "FixedDiv"]]) + "\n"
        + functions(mapUtil, [["int", "P_PointOnLineSide"], ["int", "P_BoxOnLineSide"], ["int", "P_PointOnDivlineSide"],
            ["void", "P_MakeDivline"], ["fixed_t", "P_InterceptVector"], ["void", "P_LineOpening"],
            ["boolean", "P_BlockLinesIterator"]]) + "\n" + extractFunction(map, "boolean", "PIT_CheckLine") : "";
    const projectileSpawn = projectiles ? functions(mapUtil, [["boolean", "PIT_AddLineIntercepts"],
        ["boolean", "PIT_AddThingIntercepts"], ["boolean", "P_TraverseIntercepts"], ["boolean", "P_PathTraverse"]]) + "\n"
        + functions(map, [["boolean", "PTR_AimTraverse"], ["fixed_t", "P_AimLineAttack"]]) + "\n"
        + functions(spawn, [["void", "P_CheckMissileSpawn"], ["mobj_t\\*", "P_SpawnMissile"], ["void", "P_SpawnPlayerMissile"]]) : "";
    const nightmareSpawn = nightmare ? extractFunction(spawn, "void", "P_NightmareRespawn") : "";
    const fastTics = nightmare ? read("g_game.c").match(/for \(i=S_SARG_RUN1[^\n]*\n\s*states\[i\]\.tics >>= 1;/)?.[0] : "";
    if (nightmare) assert.ok(fastTics, "G_InitNew fast demon tic adjustment");
    const testMacro = projectiles ? "#define TEST_PROJECTILES 1\n" :
        nightmare ? "#define TEST_NIGHTMARE 1\n" : "";
    return testMacro + HEADER + "\n" + header + "\n" + read("sounds.h") + "\n" + flags + "\n"
        + "static int actionId;\n" + actionStubs + "\n" + metadata + "\n" + setFastProjectileSpeeds + "\n"
        + read("light-m_random.c") + "\n" + tables.replace(/^#include.*$/gm, "").replace(/\brcsid\b/g, "tablesRcsid") + "\n"
        + "static fixed_t viewx, viewy;\nstatic fixed_t *finecosine = &finesine[FINEANGLES/4];\n"
        + extractFunction(angles, "angle_t", "R_PointToAngle") + "\n"
        + extractFunction(angles, "angle_t", "R_PointToAngle2") + "\n"
        + extractFunction(fixed, "fixed_t", "FixedMul") + "\n" + HARNESS + "\n" + projectileGeometry + "\n"
        + extractFunction(mapUtil, "void", "P_SetThingPosition") + "\n"
        + extractFunction(mapUtil, "void", "P_UnsetThingPosition") + "\n"
        + extractFunction(spawn, "mobj_t\\*", "P_SpawnMobj") + "\n"
        + setState.replace(actionCall, "{ st->action.acv(); traceAction(mobj, state); }") + "\n"
        + extractFunction(spawn, "void", "P_ExplodeMissile") + "\n"
        + extractFunction(inter, "void", "P_KillMobj") + "\n"
        + extractFunction(inter, "void", "P_DamageMobj") + "\n"
        + extractFunction(mapUtil, "fixed_t", "P_AproxDistance") + "\n"
        + extractFunction(mapUtil, "boolean", "P_BlockThingsIterator") + "\n"
        + extractFunction(map, "boolean", "PIT_CheckThing") + "\n"
        + extractFunction(map, "boolean", "P_CheckPosition") + "\n"
        + extractFunction(map, "boolean", "P_TryMove") + "\n"
        + motionConstants.join("\n") + "\n" + extractFunction(spawn, "void", "P_XYMovement") + "\n"
        + extractFunction(spawn, "void", "P_ZMovement") + "\n"
        + nightmareSpawn + "\n" + extractFunction(spawn, "void", "P_MobjThinker") + "\n" + projectileSpawn + "\n" + FIXTURE
        + (nightmare ? NIGHTMARE_FIXTURE.replace("FAST_TICS", fastTics) : "")
        + "\nint main(void) {\n" + fixtures + "\n    return 0;\n}\n";
}

const HEADER = `#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef enum { false, true } boolean;
typedef int32_t fixed_t;
typedef uint32_t angle_t;
typedef void (*actionf_v)(void);
typedef void (*actionf_p1)(void *);
typedef union { void (*acv)(void); actionf_p1 acp1; } actionf_t;

#define MAXPLAYERS 4
#define FRACBITS 16
#define FRACUNIT (1 << FRACBITS)
#define FINEANGLES 8192
#define SLOPERANGE 2048
#define ANG90 UINT32_C(0x40000000)
#define ANG45 UINT32_C(0x20000000)
#define ANG180 UINT32_C(0x80000000)
#define ANG270 UINT32_C(0xc0000000)
#define ANGLETOFINESHIFT 19
#define ONFLOORZ INT32_MIN
#define ONCEILINGZ INT32_MAX
#define PU_LEVEL 50
#define BASETHRESHOLD 100
#define MTF_AMBUSH 8
#define MAXMOVE (30 * FRACUNIT)
#define MAXRADIUS (32 * FRACUNIT)
#define GRAVITY FRACUNIT
#define FLOATSPEED (4 * FRACUNIT)
#define VIEWHEIGHT (41 * FRACUNIT)
#define MAPBLOCKSHIFT 23
#define MAPBTOFRAC 7
#define MAPBLOCKSIZE (128 * FRACUNIT)
#define MAXINT INT32_MAX
#define MININT INT32_MIN
#define ML_TWOSIDED 4
#define ML_BLOCKING 1
#define ML_BLOCKMONSTERS 2
#define MAXINTERCEPTS 128
#define PT_ADDLINES 1
#define PT_ADDTHINGS 2
#define PT_EARLYOUT 4

enum { sk_baby = 0, sk_nightmare = 4 };
enum { CF_NOMOMENTUM = 4, CF_GODMODE = 2, wp_chainsaw = 7, pw_invulnerability = 0, PST_DEAD = 1 };
enum { BOXTOP, BOXBOTTOM, BOXLEFT, BOXRIGHT };`;

const HARNESS = String.raw`
typedef struct { actionf_t function; } thinker_t;
typedef struct mobj_s mobj_t;
typedef struct { fixed_t floorheight, ceilingheight; int special, ceilingpic; mobj_t *thinglist; } sector_t;
typedef struct { sector_t *sector; } subsector_t;
typedef struct { fixed_t x, y; } vertex_t;
typedef struct { fixed_t x, y, dx, dy; } divline_t;
enum { ST_HORIZONTAL, ST_VERTICAL, ST_POSITIVE, ST_NEGATIVE };
typedef struct {
    sector_t *frontsector, *backsector;
    vertex_t *v1, *v2;
    fixed_t dx, dy, bbox[4];
    int special, flags, validcount, slopetype;
    short sidenum[2];
} line_t;
typedef struct player_s player_t;
typedef struct { short x, y, angle, type, options; } mapthing_t;
struct mobj_s {
    thinker_t thinker;
    mobjinfo_t *info;
    mobjtype_t type;
    fixed_t x, y, z, radius, height, floorz, ceilingz, momx, momy, momz;
    int flags, health, reactiontime, threshold, lastlook, movecount;
    state_t *state;
    long tics, frame;
    spritenum_t sprite;
    subsector_t *subsector;
    mobj_t *target, *snext, *sprev, *bnext, *bprev;
    player_t *player;
    angle_t angle;
    mapthing_t spawnpoint;
};

struct player_s {
    int health, armorpoints, armortype, readyweapon, cheats, damagecount, killcount, playerstate;
    int powers[6], frags[MAXPLAYERS];
    mobj_t *attacker, *mo;
    struct { int forwardmove, sidemove; } cmd;
    fixed_t viewheight, deltaviewheight;
};

static player_t players[MAXPLAYERS];
static mobj_t actors[8], *drop, *missile;
#ifdef TEST_NIGHTMARE
static mobj_t *spawned[3];
static int spawnCount;
#endif
static sector_t sector;
static subsector_t subsector = { &sector };
enum { netgame = 0 };
static int actorCount, gameskill, consoleplayer, automapactive, rollOnAction;
static int leveltime, respawnmonsters, respawnRequest;
static fixed_t bmaporgx = -(128 * FRACUNIT), bmaporgy = -(128 * FRACUNIT);
static int bmapwidth = 4, bmapheight = 4;
static mobj_t *blocklinks[16];
static mobj_t *tmthing;
static fixed_t tmx, tmy, tmbbox[4], tmfloorz, tmceilingz, tmdropoffz;
static int tmflags, validcount, numspechit, skyflatnum;
static boolean floatok;
static line_t *ceilingline, *spechit[8], lines[1];
#ifdef TEST_PROJECTILES
typedef struct { fixed_t frac; boolean isaline; union { line_t *line; mobj_t *thing; } d; } intercept_t;
typedef boolean (*traverser_t)(intercept_t *);
static intercept_t intercepts[MAXINTERCEPTS], *intercept_p;
static divline_t trace;
static boolean earlyout;
static mobj_t *linetarget, *shootthing;
static fixed_t shootz, attackrange, aimslope, topslope, bottomslope;
static fixed_t opentop, openbottom, openrange, lowfloor;
static short blockmaplump[64], *blockmap = blockmaplump + 4;
static sector_t portal;
static vertex_t wallEnds[2];
static void I_Error(const char *message) { fputs(message, stderr); abort(); }
#endif
static mobj_t *byHandle(int handle) {
    return handle ? &actors[handle - 1] : NULL;
}
static int handle(mobj_t *actor) {
    if (!actor) return 0;
#ifdef TEST_NIGHTMARE
    for (int i = 0; i < spawnCount; i++) if (actor == spawned[i]) return actorCount + 1 + i;
#endif
    if (actor == missile) return actorCount + 1;
    if (actor == drop) return actorCount + 1 + (missile != NULL);
    return (int) (actor - actors) + 1;
}

static subsector_t *R_PointInSubsector(fixed_t x, fixed_t y) { (void) x; (void) y; return &subsector; }
static void P_UnsetThingPosition(mobj_t *actor);
static void P_MobjThinker(mobj_t *actor);
static void P_AddThinker(thinker_t *thinker) {
#ifdef TEST_NIGHTMARE
    if (spawnCount == 3) abort();
    spawned[spawnCount++] = (mobj_t *) thinker;
#else
#ifdef TEST_PROJECTILES
    if (!missile) { missile = (mobj_t *) thinker; return; }
#endif
    drop = (mobj_t *) thinker;
#endif
}
static void P_RemoveMobj(mobj_t *actor) {
    P_UnsetThingPosition(actor);
    actor->thinker.function.acv = (actionf_v) -1;
}
#ifndef TEST_PROJECTILES
static boolean PIT_CheckLine(line_t *line) { (void) line; abort(); }
static boolean P_BlockLinesIterator(int x, int y, boolean (*fn)(line_t *)) {
    (void) x; (void) y; (void) fn; return true;
}
static int P_PointOnLineSide(fixed_t x, fixed_t y, line_t *line) { (void) x; (void) y; (void) line; abort(); }
#endif
static void P_TouchSpecialThing(mobj_t *item, mobj_t *actor) { (void) item; (void) actor; abort(); }
static void P_CrossSpecialLine(int line, int side, mobj_t *actor) { (void) line; (void) side; (void) actor; abort(); }
static void P_SlideMove(mobj_t *actor) { (void) actor; abort(); }
#ifndef TEST_NIGHTMARE
static void P_NightmareRespawn(mobj_t *actor) { respawnRequest = handle(actor); }
#endif
static void *Z_Malloc(size_t size, int tag, void *owner) {
    void *item = malloc(size);
    if (!item || tag != PU_LEVEL || owner) abort();
    return item;
}
static void I_Tactile(int on, int off, int value) {
    if (on != 40 || off != 10) abort();
    printf("2,%d\n", value);
}
static void P_DropWeapon(player_t *player) { printf("3,%td\n", player - players); }
static void AM_Stop(void) { puts("4"); }
static void S_StartSound(mobj_t *actor, int sound) { printf("9,%d,%d\n", sound, handle(actor)); }
static void traceAction(mobj_t *actor, int state) {
    printf("1,%d,%d,%d\n", handle(actor), state, actionId);
    if (rollOnAction) P_Random();
}`;

const FIXTURE = String.raw`
typedef struct {
    int kind, flags, health, x, y, z, height, mx, my, mz, slot, threshold, reaction, target, tics, moveCount;
    angle_t angle;
} ActorInput;
typedef struct {
    int health, armor, armorType, invulnerability, ready, cheats, damageCount, attacker, killCount;
    int frags[MAXPLAYERS];
} PlayerInput;

static void reset(int skill, int console, int automap, int special, int random, int actionRoll,
        int time, int respawn) {
    gameskill = skill;
    consoleplayer = console;
    automapactive = automap;
    prndindex = random;
    rollOnAction = actionRoll;
    leveltime = time;
    respawnmonsters = respawn;
    respawnRequest = 0;
    memset(blocklinks, 0, sizeof(blocklinks));
    sector = (sector_t){ 0, 128 * FRACUNIT, special };
}
#ifdef TEST_PROJECTILES
static void setupProjectileMap(int barrier) {
    int first = 4 + bmapwidth * bmapheight;
    for (int cell = 0; cell < bmapwidth * bmapheight; cell++) blockmap[cell] = first;
    blockmaplump[first] = barrier ? 0 : -1;
    blockmaplump[first + 1] = -1;
    linetarget = NULL;
    skyflatnum = 1;
    portal = (sector_t){ 0, 24 * FRACUNIT, 0, barrier == 3, NULL };
    wallEnds[0] = (vertex_t){ 8 * FRACUNIT, -64 * FRACUNIT };
    wallEnds[1] = (vertex_t){ 8 * FRACUNIT, 64 * FRACUNIT };
    lines[0] = (line_t){ .frontsector = &sector, .backsector = barrier >= 2 ? &portal : NULL,
        .v1 = &wallEnds[0], .v2 = &wallEnds[1], .dx = 0, .dy = 128 * FRACUNIT,
        .bbox = {64 * FRACUNIT, -64 * FRACUNIT, 8 * FRACUNIT, 8 * FRACUNIT},
        .slopetype = ST_VERTICAL, .flags = barrier >= 2 ? ML_TWOSIDED : 0,
        .sidenum = {0, barrier >= 2 ? 1 : -1} };
}
#endif
static void seed(const ActorInput *inputs, int count, const PlayerInput *inventory) {
    actorCount = count;
    if (count > sizeof(actors) / sizeof(actors[0])) abort();
    for (int i = 0; i < count; i++) {
        ActorInput a = inputs[i];
        mobjinfo_t *info = &mobjinfo[a.kind];
        state_t *state = &states[info->spawnstate];
        actors[i] = (mobj_t) {
            .info = info, .type = a.kind, .x = a.x, .y = a.y, .z = a.z, .height = a.height,
            .radius = info->radius, .floorz = sector.floorheight, .ceilingz = sector.ceilingheight,
            .momx = a.mx, .momy = a.my, .momz = a.mz, .flags = a.flags, .health = a.health,
            .reactiontime = a.reaction, .threshold = a.threshold, .state = state,
            .sprite = state->sprite, .frame = state->frame, .tics = a.tics ? a.tics : state->tics,
            .movecount = a.moveCount,
            .angle = a.angle,
            .subsector = &subsector, .target = byHandle(a.target),
            .player = a.slot < 0 ? NULL : &players[a.slot],
        };
        P_SetThingPosition(&actors[i]);
    }
    for (int i = 0; i < MAXPLAYERS; i++) {
        PlayerInput p = inventory[i];
        players[i] = (player_t) {
            .health = p.health, .armorpoints = p.armor, .armortype = p.armorType,
            .powers = { [pw_invulnerability] = p.invulnerability }, .readyweapon = p.ready,
            .cheats = p.cheats, .damagecount = p.damageCount, .attacker = byHandle(p.attacker),
            .killcount = p.killCount,
        };
        memcpy(players[i].frags, p.frags, sizeof(p.frags));
    }
}
static void emit(void) {
    for (int i = 0; i < actorCount; i++) {
        mobj_t a = actors[i];
        ptrdiff_t stateId = a.state ? a.state - states : S_NULL;
        printf("5,%d,%u,%d,%d,%d,%d,%td,%ld,%d,%d,%d,%d,%ld,%d,%d,%d,%d,%d\n",
            a.health, (uint32_t) a.flags, a.height, a.momx, a.momy, a.momz, stateId,
            a.tics, handle(a.target), a.threshold, a.reactiontime, a.sprite, a.frame,
            a.x, a.y, a.z, a.movecount, a.thinker.function.acv != (actionf_v) -1);
    }
    for (int i = 0; i < MAXPLAYERS; i++) {
        player_t p = players[i];
        printf("6,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\n", p.health, p.armorpoints,
            p.armortype, p.damagecount, handle(p.attacker), p.killcount, p.playerstate == PST_DEAD,
            p.frags[0], p.frags[1], p.frags[2], p.frags[3]);
    }
    if (drop) {
        printf("7,%d,%u,%d,%d,%d,%td,%ld,%d\n", drop->type, (uint32_t) drop->flags,
            drop->x, drop->y, drop->z, drop->state - states, drop->tics, drop->lastlook);
    }
#ifdef TEST_PROJECTILES
    if (!missile) abort();
    printf("12,%d,%u,%u,%d,%d,%d,%d,%d,%d,%d,%d,%td,%ld,%d,%d,%d\n",
        missile->type, (uint32_t) missile->flags, missile->angle, missile->x, missile->y, missile->z,
        missile->momx, missile->momy, missile->momz, missile->floorz, missile->ceilingz,
        missile->state - states, missile->tics, missile->lastlook, handle(missile->target), handle(linetarget));
#endif
    for (mobj_t *actor = sector.thinglist; actor; actor = actor->snext)
        printf("10,%d\n", handle(actor));
    for (int y = 0; y < bmapheight; y++)
        for (int x = 0; x < bmapwidth; x++)
            for (mobj_t *actor = blocklinks[y * bmapwidth + x]; actor; actor = actor->bnext)
                printf("11,%d,%d,%d\n", x, y, handle(actor));
    if (drop) {
        free(drop);
        drop = NULL;
    }
    if (missile) {
        free(missile);
        missile = NULL;
    }
    printf("8,%d,%d\nend\n", prndindex, respawnRequest);
}`;

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 25000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

const NIGHTMARE_FIXTURE = String.raw`
static void runNightmareScenario(int skill, int fast, int respawn, int blocked) {
    reset(skill, 0, 0, 0, 65, 0, 0, respawn || skill == sk_nightmare);
    seed((ActorInput[]){
        {.kind = MT_SERGEANT, .flags = MF_SOLID | MF_SHOOTABLE, .health = 150, .x = 64*FRACUNIT, .y = 64*FRACUNIT, .slot = -1},
        {.kind = MT_SERGEANT, .flags = MF_CORPSE | MF_COUNTKILL, .x = 64*FRACUNIT, .slot = -1, .tics = -1, .moveCount = 419},
        {.kind = MT_BARREL, .flags = MF_SOLID | MF_SHOOTABLE, .health = 20, .x = 160*FRACUNIT, .slot = -1}
    }, blocked ? 3 : 2, (PlayerInput[MAXPLAYERS]){0});
    actors[1].spawnpoint = (mapthing_t){160, 0, 95, 3002, 15};
    int originalTics[13], i;
    for (i = S_SARG_RUN1; i <= S_SARG_PAIN2; i++) originalTics[i - S_SARG_RUN1] = states[i].tics;
    if (fast || skill == sk_nightmare) {
        FAST_TICS
    }
    actors[0].state = &states[S_SARG_PAIN];
    actors[0].tics = 1;
    P_MobjThinker(&actors[0]);
    P_MobjThinker(&actors[1]);
    int corpseAlive = actors[1].thinker.function.acv != (actionf_v)-1;
    printf("20,%ld,%d,%d,%d\n", actors[0].tics, corpseAlive, corpseAlive ? actors[1].movecount : 0, prndindex);
    for (i = 0; i < spawnCount; i++) {
        mobj_t *mobj = spawned[i];
        printf("21,%d,%d,%d,%u,%d,%d\n", mobj->type, mobj->x, mobj->health, mobj->angle,
            mobj->reactiontime, (mobj->flags & MF_AMBUSH) != 0);
        free(mobj);
    }
    spawnCount = 0;
    for (i = S_SARG_RUN1; i <= S_SARG_PAIN2; i++) states[i].tics = originalTics[i - S_SARG_RUN1];
    puts("end");
}
`;

function runOracle(upstreamDir, scratch, cases, mode) {
    const source = path.join(scratch, "damage-oracle.c");
    const executable = path.join(scratch, "damage-oracle.exe");
    writeFileSync(source, compileSource(upstreamDir, cases, mode));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", executable]);
    const traces = run(executable, []).trim().split(/\r?\nend(?:\r?\n|$)/).filter(Boolean);
    assert.equal(traces.length, cases.length, "one native trace per damage fixture");
    return traces.map(trace => trace.split(/\r?\n/).map(row => row.split(",").map(Number)));
}

export function runNativeDamageOracle(upstreamDir, scratch, cases) {
    return runOracle(upstreamDir, scratch, cases, "damage");
}

export function runNativeProjectileOracle(upstreamDir, scratch, cases) {
    return runOracle(upstreamDir, scratch, cases, "projectiles");
}

export function runNativeNightmareOracle(upstreamDir, scratch, cases) {
    return runOracle(upstreamDir, scratch, cases, "nightmare");
}

