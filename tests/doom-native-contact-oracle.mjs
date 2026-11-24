import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

const MF_SPECIAL = 1, MF_SOLID = 2, MF_SHOOTABLE = 4, MF_PICKUP = 0x800;
const MF_NOCLIP = 0x1000, MF_MISSILE = 0x10000, MF_SKULLFLY = 0x1000000, MF_NOBLOCKMAP = 0x10;
const MT_PLAYER = 0, MT_BRUISER = 15, MT_KNIGHT = 17, MAXRADIUS = 32 * 65536;

function compileSource(upstreamDir, entry) {
    const read = file => readFileSync(path.join(upstreamDir, file), "utf8").replaceAll("\r\n", "\n");
    const map = read("movement-p_map.c"), maputil = read("movement-p_maputl.c"), random = read("light-m_random.c");
    const pit = extractFunction(map, "boolean", "PIT_CheckThing");
    const check = extractFunction(map, "boolean", "P_CheckPosition");
    const iterator = extractFunction(maputil, "boolean", "P_BlockThingsIterator");
    const prandom = extractFunction(random, "int", "P_Random");
    const table = random.match(/unsigned char rndtable\[256\]\s*=\s*\{[\s\S]*?\};/)?.[0];
    assert.ok(table, "Missing pinned random table");
    const actorRows = entry.actors.map(actor => `    install(${actor.handle}, ${actor.kind}, ${actor.flags}, ${actor.x}, ${actor.y}, ${actor.z}, ${actor.radius}, ${actor.height}, ${actor.target}, ${actor.damage}, ${actor.spawnState}, ${actor.momX}, ${actor.momY}, ${actor.momZ});`).join("\n");
    const mover = entry.mover;
    return `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef int32_t fixed_t; typedef enum { false, true } boolean;
typedef struct mobj_s mobj_t; typedef struct line_s line_t; typedef struct sector_s { fixed_t floorheight, ceilingheight; mobj_t *thinglist; } sector_t;
typedef struct { sector_t *sector; } subsector_t; typedef struct { int damage, spawnstate; } mobjinfo_t; typedef struct { int dummy; } state_t;
struct mobj_s { int flags,type; fixed_t x,y,z,radius,height,momx,momy,momz; mobjinfo_t *info; mobj_t *target,*sprev,*snext,*bprev,*bnext; subsector_t *subsector; void *player; };
#define MF_SPECIAL ${MF_SPECIAL}
#define MF_SOLID ${MF_SOLID}
#define MF_SHOOTABLE ${MF_SHOOTABLE}
#define MF_PICKUP ${MF_PICKUP}
#define MF_NOCLIP ${MF_NOCLIP}
#define MF_MISSILE ${MF_MISSILE}
#define MF_SKULLFLY ${MF_SKULLFLY}
#define MF_NOBLOCKMAP ${MF_NOBLOCKMAP}
#define MT_PLAYER ${MT_PLAYER}
#define MT_BRUISER ${MT_BRUISER}
#define MT_KNIGHT ${MT_KNIGHT}
#define MAXRADIUS ${MAXRADIUS}
#define BOXTOP 0
#define BOXBOTTOM 1
#define BOXLEFT 2
#define BOXRIGHT 3
#define FRACBITS 16
#define MAPBLOCKSHIFT 23
static fixed_t bmaporgx=${entry.origin[0]}, bmaporgy=${entry.origin[1]}; static int bmapwidth=${entry.width}, bmapheight=${entry.height};
static mobj_t *blocklinks[${Math.max(1, entry.width * entry.height)}]; static sector_t sectors[2]; static subsector_t leaves[2]={{&sectors[0]},{&sectors[1]}};
static mobj_t actors[16]; static mobjinfo_t infos[16]; static int handles[16]; static int splitX=${entry.splitX ?? 0};
static mobj_t *tmthing; static int tmflags; static fixed_t tmx,tmy,tmbbox[4],tmfloorz,tmceilingz,tmdropoffz; static int validcount,numspechit; static line_t *ceilingline,*spechit[8];
static int lineBlocked=${entry.lineBlocked ? 1 : 0}; static int removePickups=${entry.removePickups ? 1 : 0};
static int damageEvents[64],damageCount;
static int handle(const mobj_t *actor);
static subsector_t *R_PointInSubsector(fixed_t x,fixed_t y){(void)y;return &leaves[x<=splitX?0:1];}
static void P_DamageMobj(mobj_t *target,mobj_t *inflictor,mobj_t *source,int damage){ damageEvents[damageCount++]=2; damageEvents[damageCount++]=handle(target); damageEvents[damageCount++]=handle(inflictor); damageEvents[damageCount++]=source?handle(source):0; damageEvents[damageCount++]=damage; }
static void P_TouchSpecialThing(mobj_t *special, mobj_t *toucher) {
    damageEvents[damageCount++] = 1;
    damageEvents[damageCount++] = handle(special);
    damageEvents[damageCount++] = handle(toucher);
    if (!removePickups) return;
    if (special->bnext) special->bnext->bprev = special->bprev;
    if (special->bprev) special->bprev->bnext = special->bnext;
    else {
        int x = (special->x - bmaporgx) >> MAPBLOCKSHIFT;
        int y = (special->y - bmaporgy) >> MAPBLOCKSHIFT;
        blocklinks[y * bmapwidth + x] = special->bnext;
    }
    // Preserve the removed object's bnext until P_BlockThingsIterator resumes.
}
static boolean P_SetMobjState(mobj_t *actor,int state){ damageEvents[damageCount++]=3; damageEvents[damageCount++]=handle(actor); damageEvents[damageCount++]=state; return true; }
static boolean P_BlockLinesIterator(int x, int y, boolean (*func)(line_t *)) {
    (void) func;
    if (x < 0 || y < 0 || x >= bmapwidth || y >= bmapheight) return true;
    return !lineBlocked;
}
static boolean PIT_CheckLine(line_t *line){(void)line;return true;}
${table}
int prndindex=${entry.randomIndex ?? 0};
${prandom}
static int handle(const mobj_t *actor){for(int i=0;i<16;i++)if(&actors[i]==actor)return handles[i];return 0;}
${pit}
${iterator}
${check}
static void install(int h, int kind, int flags, int x, int y, int z, int radius, int height,
        int target, int damage, int spawn, int mx, int my, int mz) {
    mobj_t *actor = &actors[h - 1];
    handles[h - 1] = h;
    infos[h - 1] = (mobjinfo_t){damage, spawn};
    *actor = (mobj_t){ .type = kind, .flags = flags, .x = x, .y = y, .z = z, .radius = radius,
        .height = height, .momx = mx, .momy = my, .momz = mz, .info = &infos[h - 1],
        .target = target ? &actors[target - 1] : NULL };
    int bx = (x - bmaporgx) >> MAPBLOCKSHIFT, by = (y - bmaporgy) >> MAPBLOCKSHIFT;
    if (!(flags & MF_NOBLOCKMAP) && bx >= 0 && by >= 0 && bx < bmapwidth && by < bmapheight) {
        mobj_t **head = &blocklinks[by * bmapwidth + bx];
        actor->bnext = *head;
        if (*head) (*head)->bprev = actor;
        *head = actor;
    }
}
static void emitTail(boolean ok, mobj_t *m) {
    printf("[0,%d,%d,%d,%d,%d,%d]\\n", ok, prndindex, m->flags, m->momx, m->momy, m->momz);
}
int main(void){sectors[0].floorheight=0;sectors[0].ceilingheight=128*65536;sectors[1]=sectors[0];${actorRows}
tmthing=&actors[${mover-1}];damageCount=0;boolean ok=P_CheckPosition(tmthing,${entry.x},${entry.y});printf("events");for(int i=0;i<damageCount;i++)printf(",%d",damageEvents[i]);putchar('\\n');emitTail(ok,tmthing);return 0;}
`;
}
function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 25000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

export function runNativeContactOracle(upstreamDir, scratch, cases) {
    return cases.map((entry, index) => {
        const source = path.join(scratch, `contact-${index}.c`);
        const exe = path.join(scratch, `contact-${index}.exe`);
        writeFileSync(source, compileSource(upstreamDir, entry));
        run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", exe]);
        const lines = run(exe, []).trim().split(/\r?\n/);
        assert.equal(lines.length, 2);
        const events = lines[0].split(",").slice(1).map(Number);
        const rows = [];
        for (let i = 0; i < events.length;) {
            const width = events[i] === 2 ? 5 : 3;
            rows.push(events.slice(i, i + width));
            i += width;
        }
        rows.push(JSON.parse(lines[1]));
        return rows;
    });
}
