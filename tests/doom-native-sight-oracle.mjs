// Compile pinned C sight routines with synthetic WAD topology.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

function setupFixture(fixture) {
    const { sectors, vertices, lines, segs, leaves, nodes, reject, target, viewer, movingCeiling, blast, enemyDecision } = fixture;
    const out = [];
    out.push("reset();");
    sectors.forEach(([floor, ceiling], index) => {
        out.push("sectors[" + index + "] = (sector_t){" + floor + "," +
            (movingCeiling?.sector === index ? movingCeiling.height : ceiling) + "};");
    });
    vertices.forEach(([x, y], index) => out.push("vertices[" + index + "] = (vertex_t){" + x + "," + y + "};"));
    lines.forEach(([first, last, flags], index) => {
        out.push("lines[" + index + "] = (line_t){&vertices[" + first + "],&vertices[" + last + "]," + flags + ",0};");
    });
    segs.forEach(([line, front, back], index) => {
        const other = back < 0 ? "NULL" : "&sectors[" + back + "]";
        out.push("segs[" + index + "] = (seg_t){&lines[" + line + "],&sectors[" + front + "]," + other + "};");
    });
    leaves.forEach(([count, first], index) => {
        out.push("subsectors[" + index + "] = (subsector_t){" + count + "," + first + ",NULL};");
    });
    nodes.forEach(([x, y, dx, dy, front, back], index) => {
        out.push("nodes[" + index + "] = (node_t){" + [x,y,dx,dy].join(",") + ",{" + front + "," + back + "}};");
    });
    reject.forEach((byte, index) => out.push("rejectmatrix[" + index + "] = " + byte + ";"));
    out.push("numnodes = " + nodes.length + "; numsectors = " + sectors.length + ";");
    if (blast) {
        blast.actors.forEach((a, index) => {
            out.push("seedBlastActor(" + [index, a.x, a.y, a.z, a.height, a.sector, a.radius, a.kind, a.flags,
                a.owner ?? 0].join(",") + ");");
        });
        const spot = "&actors[" + (blast.spot - 1) + "]";
        const source = blast.source ? "&actors[" + (blast.source - 1) + "]" : "NULL";
        out.push("putchar('0');");
        out.push(blast.explode ? "A_Explode(" + spot + ");" : "P_RadiusAttack(" + [spot, source, blast.damage].join(",") + ");");
        out.push("putchar(10);");
    } else if (enemyDecision) {
        const e = enemyDecision;
        out.push("emitEnemy(makeActor(" + viewer.join(",") + ",0), makeActor(" + target.join(",") + ",1),"
            + [e.kind, e.meleeState, e.targetRadius, e.flags, e.reactionTime, e.randomIndex] + ");");
    } else {
        out.push("emit(makeActor(" + viewer.join(",") + ",0), makeActor(" + target.join(",") + ",1));");
    }
    return out.map(line => "    " + line).join("\n");
}

function instrument(source, statement, extra) {
    assert.equal(source.split(statement).length, 2, "one site for native observation counter");
    return source.replace(statement, statement + "\n    " + extra);
}

export function runNativeSightOracle(upstreamDir, scratch, fixtures) {
    const read = name => readFileSync(path.join(upstreamDir, name), "utf8").replaceAll("\r\n", "\n");
    const sight = read("p_sight.c").replace(/^#include.*$/gm, "");
    const record = instrument(instrument(sight, "sub = &subsectors[num];", "leavesChecked++;"),
        "line->validcount = validcount;", "linesChecked++;");
    const fixed = read("m_fixed.c");
    const math = ["FixedMul", "FixedDiv2", "FixedDiv"].map(name => extractFunction(fixed, "fixed_t", name)).join("\n");
    let blast = "";
    if (fixtures.some(fixture => fixture.blast)) {
        const map = read("movement-p_map.c");
        const mapUtil = read("movement-p_maputl.c");
        blast = BLAST + "\n" + extractFunction(mapUtil, "boolean", "P_BlockThingsIterator") + "\n"
            + extractFunction(map, "boolean", "PIT_RadiusAttack") + "\n"
            + extractFunction(map, "void", "P_RadiusAttack") + "\n"
            + extractFunction(read("p_enemy.c"), "void", "A_Explode");
    }
    let enemy = "";
    if (fixtures.some(fixture => fixture.enemyDecision)) {
        const actions = read("p_enemy.c");
        enemy = read("light-m_random.c").replace(/\brcsid\b/g, "rangeRandomRcsid") + "\n" + ENEMY_HEADER + "\n"
            + extractFunction(read("movement-p_maputl.c"), "fixed_t", "P_AproxDistance") + "\n"
            + extractFunction(actions, "boolean", "P_CheckMeleeRange") + "\n"
            + extractFunction(actions, "boolean", "P_CheckMissileRange") + "\n" + ENEMY_FIXTURE;
    }
    const source = path.join(scratch, "sight-oracle.c"), executable = path.join(scratch, "sight-oracle.exe");
    const capacities = `#define NODE_CAPACITY ${Math.max(1, ...fixtures.map(fixture => fixture.nodes.length))}
#define LEAF_CAPACITY ${Math.max(1, ...fixtures.map(fixture => fixture.leaves.length))}\n`;
    writeFileSync(source, capacities + HEADER + "\n" + math + "\n" + record + "\n" + HARNESS + "\n" + blast + "\n" + enemy + "\nint main(void) {\n"
        + fixtures.map(setupFixture).join("\n") + "\n    return 0;\n}\n");
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", "-fno-strict-aliasing", source, "-o", executable]);
    const rows = run(executable, []).trim().split(/\r?\n/).map(line => line.split(",").map(Number));
    assert.equal(rows.length, fixtures.length);
    return rows;
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 25000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

const HEADER = `
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int32_t fixed_t;
typedef enum { false, true } boolean;
typedef struct { fixed_t x, y; } vertex_t;
typedef struct { fixed_t x, y, dx, dy; } divline_t;
typedef struct { fixed_t floorheight, ceilingheight; } sector_t;
typedef struct { vertex_t *v1, *v2; int flags, validcount; } line_t;
typedef struct { line_t *linedef; sector_t *frontsector, *backsector; } seg_t;
typedef struct { int numlines, firstline; sector_t *sector; } subsector_t;
typedef struct { fixed_t x, y, dx, dy; int children[2]; } node_t;
typedef struct { fixed_t radius; int meleestate; } range_info_t;
typedef struct mobj_s {
    fixed_t x, y, z, height;
    subsector_t *subsector;
    fixed_t radius;
    int type, flags;
    int reactiontime;
    range_info_t *info;
    struct mobj_s *target, *bnext;
} mobj_t;

#define FRACBITS 16
#define FRACUNIT (1 << FRACBITS)
#define MININT INT32_MIN
#define MAXINT INT32_MAX
#define ML_TWOSIDED 4
#define NF_SUBSECTOR 0x8000
#define MT_SPIDER 19
#define MT_CYBORG 21

static int numnodes, numsectors, validcount, leavesChecked, linesChecked;
static vertex_t vertices[256];
static sector_t sectors[64];
static line_t lines[128];
static seg_t segs[256];
static node_t nodes[NODE_CAPACITY];
static subsector_t subsectors[LEAF_CAPACITY], actorLeaves[64];
static unsigned char rejectmatrix[512];
static mobj_t *blocklinks[16];

static void I_Error(const char *message) { fputs(message, stderr); abort(); }
`;

const HARNESS = String.raw`
static void reset(void) {
    memset(lines, 0, sizeof(lines));
    memset(rejectmatrix, 0, sizeof(rejectmatrix));
    memset(blocklinks, 0, sizeof(blocklinks));
    memset(sightcounts, 0, sizeof(sightcounts));
    leavesChecked = linesChecked = 0;
    sightzstart = bottomslope = topslope = 0;
}

static mobj_t makeActor(int x, int y, int z, int height, int sector, int slot) {
    actorLeaves[slot].sector = &sectors[sector];
    return (mobj_t){ x, y, z, height, &actorLeaves[slot] };
}

static void emit(mobj_t viewer, mobj_t target) {
    boolean visible = P_CheckSight(&viewer, &target);
    printf("%d,%d,%d,%d,%d,%d,%d\n", visible, sightcounts[0], leavesChecked, linesChecked,
        sightzstart, bottomslope, topslope);
}
`;

const BLAST = String.raw`
#define MF_SHOOTABLE 4
#define MF_NOBLOCKMAP 16
#define MAXRADIUS (32 * FRACUNIT)
#define MAPBLOCKSHIFT 23

static mobj_t actors[64], *bombspot, *bombsource;
static int bombdamage;
static const fixed_t bmaporgx = -256 * FRACUNIT, bmaporgy = -256 * FRACUNIT;
static const int bmapwidth = 4, bmapheight = 4;

static int handle(const mobj_t *actor) { return actor ? (int) (actor - actors) + 1 : 0; }
static void P_DamageMobj(mobj_t *target, mobj_t *inflictor, mobj_t *source, int amount) {
    printf(",%d,%d,%d,%d", handle(target), handle(inflictor), handle(source), amount);
}

static void seedBlastActor(int i, int x, int y, int z, int height, int sector, int radius, int type, int flags, int target) {
    actors[i] = makeActor(x, y, z, height, sector, i);
    actors[i].radius = radius;
    actors[i].type = type;
    actors[i].flags = flags;
    actors[i].target = target ? &actors[target - 1] : NULL;
    int bx = (x - bmaporgx) >> MAPBLOCKSHIFT, by = (y - bmaporgy) >> MAPBLOCKSHIFT;
    if (!(flags & MF_NOBLOCKMAP) && bx >= 0 && by >= 0 && bx < bmapwidth && by < bmapheight) {
        mobj_t **head = &blocklinks[by * bmapwidth + bx];
        actors[i].bnext = *head;
        *head = &actors[i];
    }
}
`;

const ENEMY_HEADER = `
#define MELEERANGE (64 * FRACUNIT)
#define MF_JUSTHIT 0x40
#define MT_VILE 3
#define MT_UNDEAD 5
#define MT_SKULL 18
`;

const ENEMY_FIXTURE = String.raw`
static void emitEnemy(mobj_t actor, mobj_t target, int kind, int meleeState, int targetRadius,
        int flags, int reactionTime, int randomIndex) {
    range_info_t actorInfo = { .meleestate = meleeState }, targetInfo = { .radius = targetRadius };
    actor.type = kind;
    actor.info = &actorInfo;
    actor.target = &target;
    actor.reactiontime = reactionTime;
    actor.flags = flags;
    target.info = &targetInfo;
    prndindex = randomIndex;
    boolean melee = P_CheckMeleeRange(&actor);
    boolean missile = P_CheckMissileRange(&actor);
    printf("%d,%d,%d,%d\n", melee, missile, actor.flags, prndindex);
}
`;
