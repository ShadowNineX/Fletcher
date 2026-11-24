// Native Doom line attacks with synthetic map data and observable side effects.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

function nativeFixture({ sectors, vertices, lines, actors, blocks, shooter, slope, angle, range, amount, overrides,
    pathEnd, gun, randomIndex = 0, nativeAction, strength, bfgAngle, enemyNative }) {
    const out = ["reset();"];
    sectors.forEach((sector, i) => out.push("sectors[" + i + "] = (sector_t){" + sector.slice(0, 3) + "};"));
    vertices.forEach((vertex, i) => out.push("vertices[" + i + "] = (vertex_t){" + vertex + "};"));
    lines.forEach((line, i) => out.push("seedLine(" + [i, ...line.slice(0, 6)] + ");"));
    out.push("beginBlocks(" + [blocks.x, blocks.y, blocks.width, blocks.height] + ");");
    blocks.lines.forEach((cell, i) => out.push("seedBlock(" + i + ", (short[]){" + [...cell, -1] + "});"));
    actors.forEach((actor, i) => out.push("seedActor(" + [i, ...actor] + ");"));
    overrides.forEach(([line, sector, height]) => out.push("overrides[" + line + "] = (ceiling_override_t){" + [sector + 1,height] + "};"));
    const source = "(&actors[" + (shooter - 1) + "])";
    out.push("prndindex = " + randomIndex + ";");
    if (enemyNative) {
        out.push(source + "->angle = " + angle + "u;");
        out.push(source + "->target = &actors[1];");
        out.push("monsterSound = true; " + enemyNative + "(" + source + "); monsterSound = false;");
        out.push('printf("14,%u,%d,%d\\n", ' + source + "->angle, " + source + "->flags, prndindex);");
        out.push('puts("end");');
        return "{\n    " + out.join("\n    ") + "\n}";
    }
    if (bfgAngle !== undefined) {
        out.push(source + "->angle = " + angle + "u;");
        out.push("mobj_t missile = {.target = " + source + ", .angle = " + bfgAngle + "u};");
        out.push("A_BFGSpray(&missile);");
        out.push('printf("17,%d\\n", prndindex);');
        out.push('puts("end");');
        return "{\n    " + out.join("\n    ") + "\n}";
    }
    if (nativeAction) {
        out.push(source + "->angle = " + angle + "u;");
        out.push("player_t player = {.mo = " + source + ", .ammo = {40}, .powers = {" + Number(!!strength) + "}};");
        out.push(nativeAction + "(&player, NULL);");
        out.push('printf("14,%u,%d,%d\\n", player.mo->angle, player.mo->flags, prndindex);');
        out.push('puts("end");');
        return "{\n    " + out.join("\n    ") + "\n}";
    }
    if (gun !== undefined) {
        out.push(source + "->angle = " + angle + "u;");
        out.push("P_BulletSlope(" + source + "); fixed_t aim = bulletslope;");
    } else {
        out.push("fixed_t aim = P_AimLineAttack(" + [source, angle + "u", range] + ");");
    }
    out.push('printf("0,%d,%d\\n", handle(linetarget), aim);');
    out.push(pathEnd
        ? "P_PathTraverse(" + [source + "->x", source + "->y", ...pathEnd, "PT_ADDLINES | PT_ADDTHINGS", "traceHit"] + ");"
        : "emitPath(" + [source, angle + "u", range] + ");");
    out.push(gun === undefined
        ? "P_LineAttack(" + [source, angle + "u", range, slope ?? "aim", amount] + ");"
        : "P_GunShot(" + source + "," + Number(gun) + ");");
    out.push('puts("end");');
    return "{\n    " + out.join("\n    ") + "\n}";
}

function assemble(upstreamDir, fixtures) {
    // Only the dense fixtures use larger backing arrays. The upstream
    // traversal cannot collect more than 128 intercepts into its stock array.
    const intercepts = fixtures.some(fixture => fixture.expandedTrace) ? 256 : 128;
    const lineSlots = Math.max(128, ...fixtures.map(fixture => fixture.lines.length));
    const read = file => readFileSync(path.join(upstreamDir, file), "utf8").replaceAll("\r\n", "\n");
    const funcs = (source, list) => list.map(([type, name]) => extractFunction(source, type, name)).join("\n");
    const map = read("movement-p_map.c"), utils = read("movement-p_maputl.c");
    const mobj = read("p_mobj.c"), fixed = read("m_fixed.c"), info = read("info.c");
    const metadata = info.slice(info.indexOf("char *sprnames["));
    const infoHeader = read("info.h").replace(/^#include "d_think.h"$/m, "");
    assert.ok(metadata.startsWith("char *sprnames["));
    const actions = [...new Set(Array.from(metadata.matchAll(/void\s+(A_[A-Za-z0-9_]+)\s*\(/g), match => match[1]))];
    const weaponNames = [...new Set(fixtures.flatMap(fixture => fixture.nativeAction ? [fixture.nativeAction] : []))];
    const monsterNames = [...new Set(fixtures.flatMap(fixture => fixture.enemyNative ? [fixture.enemyNative] : []))];
    if (monsterNames.length) monsterNames.unshift("A_FaceTarget");
    const bfg = fixtures.some(fixture => fixture.bfgAngle !== undefined);
    const stubs = actions.filter(name => !weaponNames.includes(name) && !monsterNames.includes(name) && !(bfg && name === "A_BFGSpray"))
        .map(name => "void " + name + "(void) { abort(); }").join("\n");
    const flags = read("p_mobj.h").match(/typedef enum\s*\{[\s\S]*?\}\s*mobjflag_t;/)?.[0];
    assert.ok(flags?.includes("MF_NOBLOOD"));
    const tables = read("tables.c").replace(/^#include.*$/gm, "").replace(/\brcsid\b/g, "tablesRcsid");
    const gun = fixtures.some(fixture => fixture.gun !== undefined || fixture.nativeAction)
        ? "#define MISSILERANGE (32 * 64 * FRACUNIT)\nstatic fixed_t bulletslope;\n"
            + funcs(read("p_pspr.c"), [["void", "P_BulletSlope"], ["void", "P_GunShot"]]) : "";
    const weapon = weaponNames.length || bfg || monsterNames.length ? [
        WEAPONS,
        funcs(read("r_main.c"), [["angle_t", "R_PointToAngle"], ["angle_t", "R_PointToAngle2"]]),
        funcs(read("p_pspr.c"), weaponNames.map(name => ["void", name])),
        bfg ? extractFunction(read("p_pspr.c"), "void", "A_BFGSpray") : "",
        monsterNames.length ? funcs(read("p_enemy.c"), monsterNames.map(name => ["void", name])) : "",
    ].join("\n") : "";
    return [
        `#define MAXINTERCEPTS ${intercepts}\n#define FIXTURE_LINES ${lineSlots}`,
        HEADER, infoHeader, read("sounds.h"), flags, stubs, metadata, read("light-m_random.c"), tables, GEOMETRY,
        funcs(fixed, [["fixed_t", "FixedMul"], ["fixed_t", "FixedDiv2"], ["fixed_t", "FixedDiv"]]),
        funcs(utils, [["int", "P_PointOnLineSide"], ["int", "P_PointOnDivlineSide"], ["void", "P_MakeDivline"],
            ["fixed_t", "P_InterceptVector"], ["void", "P_LineOpening"], ["boolean", "P_BlockLinesIterator"],
            ["boolean", "P_BlockThingsIterator"], ["boolean", "PIT_AddLineIntercepts"], ["boolean", "PIT_AddThingIntercepts"],
            ["boolean", "P_TraverseIntercepts"], ["boolean", "P_PathTraverse"]]),
        funcs(mobj, [["mobj_t\\*", "P_SpawnMobj"], ["boolean", "P_SetMobjState"],
            ["void", "P_SpawnPuff"], ["void", "P_SpawnBlood"]]),
        EVENTS, "#define P_SpawnPuff tracePuff\n#define P_SpawnBlood traceBlood",
        funcs(map, [["boolean", "PTR_AimTraverse"], ["boolean", "PTR_ShootTraverse"],
            ["fixed_t", "P_AimLineAttack"], ["void", "P_LineAttack"]]),
        gun, weapon, FIXTURES, "int main(void) {", ...fixtures.map(nativeFixture), "return 0;\n}",
    ].join("\n");
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 25000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

export function runNativeHitscanOracle(upstreamDir, scratch, fixtures) {
    const source = path.join(scratch, "hitscan-oracle.c"), executable = path.join(scratch, "hitscan-oracle.exe");
    writeFileSync(source, assemble(upstreamDir, fixtures));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", "-fno-strict-aliasing", source, "-o", executable]);
    const traces = run(executable, []).trim().split(/\r?\nend(?:\r?\n|$)/).filter(Boolean);
    assert.equal(traces.length, fixtures.length, "one native trace per hitscan fixture");
    return traces.map(trace => trace.split(/\r?\n/).map(row => row.split(",").map(Number)));
}

const HEADER = `
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int32_t fixed_t;
typedef uint32_t angle_t;
typedef enum { false, true } boolean;
typedef void (*actionf_p1)(void *);
typedef union { void (*acv)(void); actionf_p1 acp1; } actionf_t;

#define FRACBITS 16
#define FRACUNIT (1 << FRACBITS)
#define FINEANGLES 8192
#define SLOPERANGE 2048
#define ANGLETOFINESHIFT 19
#define MAPBLOCKSHIFT 23
#define MAPBTOFRAC 7
#define MAPBLOCKSIZE (128 * FRACUNIT)
#define MAXINT INT32_MAX
#define MININT INT32_MIN
#define ML_TWOSIDED 4
#define PT_ADDLINES 1
#define PT_ADDTHINGS 2
#define PT_EARLYOUT 4
#define ONFLOORZ INT32_MIN
#define ONCEILINGZ INT32_MAX
#define PU_LEVEL 50
#define MELEERANGE (64 * FRACUNIT)
#define MAXPLAYERS 4
enum { sk_nightmare = 4 };
`;
const GEOMETRY = `
typedef struct { fixed_t x, y; } vertex_t;
typedef struct { fixed_t floorheight, ceilingheight; int ceilingpic; } sector_t;
typedef struct { fixed_t x, y, dx, dy; } divline_t;
typedef struct { sector_t *sector; } subsector_t;
typedef struct {
    vertex_t *v1, *v2;
    sector_t *frontsector, *backsector;
    fixed_t dx, dy;
    short sidenum[2];
    int special, flags, validcount;
} line_t;

typedef struct { actionf_t function; } thinker_t;
typedef struct mobj_s {
    thinker_t thinker;
    mobjtype_t type;
    angle_t angle;
    mobjinfo_t *info;
    state_t *state;
    spritenum_t sprite;
    long tics, frame;
    fixed_t x, y, z, height, radius, floorz, ceilingz, momz;
    int flags, reactiontime, health, lastlook;
    subsector_t *subsector;
    struct mobj_s *bnext, *target;
} mobj_t;
typedef struct { fixed_t frac; boolean isaline; union { line_t *line; mobj_t *thing; } d; } intercept_t;
typedef boolean (*traverser_t)(intercept_t *);
typedef struct { int sector; fixed_t ceiling; } ceiling_override_t;

static vertex_t vertices[256];
static line_t lines[FIXTURE_LINES];
static sector_t sectors[64];
static mobj_t actors[64], *blocklinks[64], *effect;
static ceiling_override_t overrides[128];
static short blockmaplump[4096], *blockmap = blockmaplump + 4;
static int blockOffset;
static fixed_t bmaporgx, bmaporgy;
static int bmapwidth, bmapheight, validcount, gameskill = 2, skyflatnum = 1;
static boolean earlyout;
static divline_t trace;
static intercept_t intercepts[MAXINTERCEPTS], *intercept_p;
static fixed_t opentop, openbottom, openrange, lowfloor;
static fixed_t shootz, attackrange, aimslope, topslope, bottomslope;
static int la_damage;
static mobj_t *linetarget, *shootthing;
static fixed_t *finecosine = finesine + FINEANGLES/4;
static subsector_t effectSubsector = { &sectors[0] };

static void I_Error(const char *message) { fputs(message, stderr); abort(); }
static void *Z_Malloc(size_t size, int tag, void *owner) {
    void *address = malloc(size);
    if (!address || tag != PU_LEVEL || owner) abort();
    return address;
}
static void P_SetThingPosition(mobj_t *actor) { actor->subsector = &effectSubsector; }
static void P_AddThinker(thinker_t *thinker) { effect = (mobj_t *) thinker; }
static void P_MobjThinker(mobj_t *actor) { (void) actor; abort(); }
static void P_RemoveMobj(mobj_t *actor) { (void) actor; abort(); }
`;

const EVENTS = String.raw`
static int handle(const mobj_t *actor) { return actor ? (int) (actor - actors) + 1 : 0; }
static boolean traceHit(intercept_t *hit) {
    int index = hit->isaline ? (int) (hit->d.line - lines) : handle(hit->d.thing);
    printf("9,%d,%d,%d\n", hit->isaline, index, hit->frac);
    return true;
}
static void emitPath(mobj_t *actor, angle_t angle, fixed_t distance) {
    int fine = angle >> ANGLETOFINESHIFT;
    fixed_t x = actor->x + (distance >> FRACBITS) * finecosine[fine];
    fixed_t y = actor->y + (distance >> FRACBITS) * finesine[fine];
    P_PathTraverse(actor->x, actor->y, x, y, PT_ADDLINES | PT_ADDTHINGS, traceHit);
}
static void P_ShootSpecialLine(mobj_t *actor, line_t *line) {
    if (actor != shootthing) abort();
    size_t index = line - lines;
    printf("1,%zu\n", index);
    ceiling_override_t change = overrides[index];
    if (change.sector) sectors[change.sector - 1].ceilingheight = change.ceiling;
}
static void emitEffect(void) {
    printf("6,%d,%d,%d,%d,%d,%td,%ld,%d\n", effect->type, effect->x, effect->y,
        effect->z, effect->momz, effect->state - states, effect->tics, effect->lastlook);
    free(effect);
    effect = NULL;
}
static void tracePuff(fixed_t x, fixed_t y, fixed_t z) {
    printf("2,%d,%d,%d\n", x, y, z);
    P_SpawnPuff(x, y, z);
    emitEffect();
}
static void traceBlood(fixed_t x, fixed_t y, fixed_t z, int damage) {
    printf("3,%d,%d,%d,%d\n", x, y, z, damage);
    P_SpawnBlood(x, y, z, damage);
    emitEffect();
}
static void P_DamageMobj(mobj_t *target, mobj_t *inflictor, mobj_t *source, int damage) {
    if (effect) emitEffect();
    printf("4,%d,%d,%d,%d\n", handle(target), handle(inflictor), handle(source), damage);
}
`;

const WEAPONS = String.raw`
#define ANG90 0x40000000
#define ANG180 0x80000000
#define ANG270 0xc0000000
enum { pw_strength, ps_flash };
typedef struct { int state; } pspdef_t;
typedef struct { mobj_t *mo; int readyweapon, ammo[4], powers[1]; } player_t;
static const struct { int ammo; statenum_t flashstate; } weaponinfo[] = {{0, S_NULL}};
static fixed_t viewx, viewy;
static boolean monsterSound;
static void P_SetPsprite(player_t *player, int slot, statenum_t state) {}
static void S_StartSound(mobj_t *actor, int sound) {
    // Shotgun preparation sounds are compared by the psprite suite.
    if (monsterSound || sound == sfx_punch || sound == sfx_sawful || sound == sfx_sawhit) printf("15,%d\n", sound);
}
`;

const FIXTURES = `
static void reset(void) {
    M_ClearRandom();
    memset(overrides, 0, sizeof(overrides));
    memset(blocklinks, 0, sizeof(blocklinks));
}
static void seedLine(int i, int a, int b, int flags, int special, int front, int back) {
    lines[i] = (line_t) { .v1 = &vertices[a], .v2 = &vertices[b],
        .frontsector = &sectors[front], .backsector = back < 0 ? NULL : &sectors[back],
        .dx = vertices[b].x - vertices[a].x, .dy = vertices[b].y - vertices[a].y,
        .sidenum = {0, back}, .special = special, .flags = flags };
}
static void beginBlocks(int originX, int originY, int width, int height) {
    bmaporgx = originX;
    bmaporgy = originY;
    bmapwidth = width;
    bmapheight = height;
    if (width * height > sizeof(blocklinks) / sizeof(blocklinks[0])) abort();
    blockOffset = 4 + width * height;
}
static void seedBlock(int index, const short *entries) {
    blockmap[index] = blockOffset;
    for (;;) {
        if (blockOffset >= sizeof(blockmaplump) / sizeof(blockmaplump[0])) abort();
        short entry = *entries++;
        blockmaplump[blockOffset++] = entry;
        if (entry == -1) return;
    }
}
static void seedActor(int i, int x, int y, int z, int height, int radius, int flags) {
    mobj_t *actor = &actors[i];
    *actor = (mobj_t){ .x=x, .y=y, .z=z, .height=height, .radius=radius, .flags=flags };
    int bx = (x - bmaporgx) >> MAPBLOCKSHIFT, by = (y - bmaporgy) >> MAPBLOCKSHIFT;
    if (!(flags & MF_NOBLOCKMAP) && bx >= 0 && by >= 0 && bx < bmapwidth && by < bmapheight) {
        int index = by * bmapwidth + bx;
        actor->bnext = blocklinks[index];
        blocklinks[index] = actor;
    }
}
`;
