import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

function nativeSource(upstream) {
    const read = file => readFileSync(path.join(upstream, file), "utf8").replaceAll("\r\n", "\n");
    const map = read("movement-p_map.c"), mapUtil = read("movement-p_maputl.c"), random = read("light-m_random.c");
    const table = random.match(/unsigned char rndtable\[256\]\s*=\s*\{[\s\S]*?\};/)?.[0];
    assert.ok(table, "Missing Linux Doom random table");
    return `#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
typedef enum { false, true } boolean;
enum { BOXTOP, BOXBOTTOM, BOXLEFT, BOXRIGHT };
enum { MF_SOLID=2, MF_SHOOTABLE=4, MF_NOBLOCKMAP=16, MF_DROPPED=0x20000, S_GIBS=895, MT_BLOOD=38 };
enum { U=65536, MAX_ACTORS=32 };
typedef struct { int blockbox[4]; } sector_t;
typedef struct mobj_s mobj_t;
struct mobj_s {
    int x,y,z,floorz,ceilingz,radius,height,flags,health,player;
    int live,state,type,momx,momy,momz,tics;
    mobj_t *bnext;
};
static int bmapwidth=4, bmapheight=4, tmfloorz, tmceilingz, leveltime, prndindex;
static boolean crushchange, nofit;
static mobj_t actors[MAX_ACTORS], *blocklinks[16];
static int count;
${table}
${extractFunction(random, "int", "P_Random")}
${extractFunction(mapUtil, "boolean", "P_BlockThingsIterator")}

static int cell(mobj_t *thing) {
    int bx=(thing->x + 128*U)>>23, by=(thing->y + 128*U)>>23;
    assert(bx>=0 && bx<bmapwidth && by>=0 && by<bmapheight);
    return by*bmapwidth + bx;
}

// This fixture has one origin subsector and a single two-sided line at
// x=0, spanning -32..32. Supply its openings, or stop first on a solid.
static boolean P_CheckPosition(mobj_t *thing, int x, int y) {
    tmfloorz=8*U;
    tmceilingz=40*U;
    for (int i=0; i<count; ++i) {
        mobj_t *other=&actors[i];
        if (other==thing || !other->live || !(other->flags & MF_SOLID)) continue;
        int reach=thing->radius + other->radius;
        if (abs(other->x-x)<reach && abs(other->y-y)<reach) return false;
    }
    if (x-thing->radius<0 && x+thing->radius>0 && y-thing->radius<32*U && y+thing->radius>-32*U) {
        tmfloorz=16*U;
        tmceilingz=32*U;
    }
    return true;
}

static void P_SetMobjState(mobj_t *thing, int state) { thing->state=state; }
static void P_RemoveMobj(mobj_t *thing) {
    mobj_t **link=&blocklinks[cell(thing)];
    while (*link && *link!=thing) link=&(*link)->bnext;
    assert(*link==thing);
    *link=thing->bnext;
    thing->live=0;
    // Native unlink retains bnext on the removed thing until the iterator resumes.
}

// The separate combat oracle checks P_DamageMobj. Here the fixtures use
// unarmored targets whose pain roll or death tics consume one RNG draw.
static void P_DamageMobj(mobj_t *thing, mobj_t *inflictor, mobj_t *source, int damage) {
    assert(inflictor==NULL && source==NULL);
    thing->health-=damage;
    if (thing->health<=0) {
        thing->height>>=2;
        if (thing->player) thing->flags &= ~MF_SOLID;
    }
    P_Random();
}

static mobj_t *P_SpawnMobj(int x, int y, int z, int kind) {
    assert(kind==MT_BLOOD && count<MAX_ACTORS);
    mobj_t *blood=&actors[count++];
    *blood=(mobj_t){.x=x,.y=y,.z=z,.type=kind,.flags=MF_NOBLOCKMAP,.live=1,.tics=8};
    P_Random(); // P_SpawnMobj lastlook
    return blood;
}
${extractFunction(map, "boolean", "P_ThingHeightClip")}
${extractFunction(map, "boolean", "PIT_ChangeSector")}
${extractFunction(map, "boolean", "P_ChangeSector")}

int main(void) {
    int crush, original;
    assert(scanf("%d%d%d",&leveltime,&crush,&original)==3 && original>=0 && original<=MAX_ACTORS);
    count=original;
    for (int i=0; i<count; ++i) {
        mobj_t *a=&actors[i];
        assert(scanf("%d%d%d%d%d%d%d%d%d%d", &a->x,&a->y,&a->z,&a->floorz,&a->ceilingz,
            &a->radius,&a->height,&a->flags,&a->health,&a->player)==10);
        a->live=1;
        if (!(a->flags & MF_NOBLOCKMAP)) {
            mobj_t **head=&blocklinks[cell(a)];
            a->bnext=*head;
            *head=a;
        }
    }
    sector_t sector={.blockbox={[BOXLEFT]=0,[BOXRIGHT]=1,[BOXBOTTOM]=0,[BOXTOP]=1}};
    int blocked=P_ChangeSector(&sector,crush);
    printf("[%d,%d]\\n",blocked,prndindex);
    for (int i=0; i<count; ++i) {
        mobj_t *a=&actors[i];
        if (i<original) {
            printf("[%d,%d,%d,%d,%d,%d,%d,%d,%d]\\n",a->live,a->floorz,a->ceilingz,a->z,a->height,a->radius,
                a->health,a->state==S_GIBS,!!(a->flags & MF_SOLID));
        } else {
            printf("[%d,%d,%d,%d,%d,%d,%d,%d]\\n",a->type==MT_BLOOD,a->x,a->y,a->z,
                a->momx,a->momy,a->momz,a->tics);
        }
    }
    return 0;
}`;
}

function run(command, args, input) {
    const child = spawnSync(command, args, { encoding: "utf8", timeout: 25_000, input });
    if (child.error) throw child.error;
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return child.stdout;
}

export function compareNativeSectorChange(upstream, scratch, cases) {
    const source = path.join(scratch, "sector-change.c");
    const executable = path.join(scratch, "sector-change.exe");
    writeFileSync(source, nativeSource(upstream));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", executable]);
    for (const { description, levelTime, crush, actors, result } of cases) {
        const input = [[levelTime, crush, actors.length], ...actors].map(row => row.join(" ")).join("\n");
        const trace = run(executable, [], input).trim().split(/\r?\n/).map(row => JSON.parse(row));
        assert.deepEqual(result, trace, description);
    }
}
