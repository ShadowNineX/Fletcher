// Trace original actor thinkers followed by a rising floor in a clear sector.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

export function runNativePlaneActorOracle(upstream, scratch) {
    const read = name => readFileSync(path.join(upstream, name), "utf8").replaceAll("\r\n", "\n");
    const info = read("info.c"), mobj = read("p_mobj.c"), tick = read("p_tick.c");
    const map = read("movement-p_map.c"), util = read("movement-p_maputl.c"), floor = read("door-p_floor.c");
    const flags = read("p_mobj.h").match(/typedef enum\s*\{[\s\S]*?\}\s*mobjflag_t;/)?.[0];
    assert.ok(flags);
    const states = ["S_BLOODYTWITCH", "S_BLOODYTWITCH2", "S_BLOODYTWITCH3", "S_BLOODYTWITCH4", "S_MEAT4"].map(name => {
        const row = info.split("\n").find(line => line.trimEnd().endsWith("// " + name));
        assert.ok(row, "Missing native state " + name);
        return `[${name}] = ${row.split("//")[0].trim()}`;
    });
    const kinds = ["MT_MISC51", "MT_MISC54"].map(name => {
        const row = info.match(new RegExp("\\{\\s*// " + name + "\\s*\\n[\\s\\S]*?^\\s*\\},", "m"));
        assert.ok(row, "Missing native hanging decoration " + name);
        return `[${name}] = ${row[0]}`;
    });
    const source = path.join(scratch, "plane-actor.c"), exe = path.join(scratch, "plane-actor.exe");
    writeFileSync(source, `#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef enum { false, true } boolean;
typedef int32_t fixed_t;
typedef void (*actionf_v)(void);
typedef void (*actionf_p1)(void*);
typedef union { actionf_v acv; actionf_p1 acp1; } actionf_t;
${read("info.h").replace(/^#include "d_think.h"$/m, "")}
${read("sounds.h")}
${flags}
enum { FRACUNIT=65536, GRAVITY=FRACUNIT, FLOATSPEED=4*FRACUNIT, MAXRADIUS=32*FRACUNIT,
    MAPBLOCKSHIFT=23, VIEWHEIGHT=41*FRACUNIT, MAXPLAYERS=4, sk_nightmare=4, PU_LEVEL=50,
    BOXTOP=0, BOXBOTTOM, BOXLEFT, BOXRIGHT };
#define ONFLOORZ INT32_MIN
#define ONCEILINGZ INT32_MAX
typedef struct thinker_s { struct thinker_s *prev,*next; actionf_t function; } thinker_t;
typedef struct mobj_s mobj_t;
typedef struct { int special,floorpic,blockbox[4],soundorg; fixed_t floorheight,ceilingheight;
    void *specialdata; mobj_t *thinglist; } sector_t;
typedef struct { sector_t *sector; } subsector_t;
typedef struct { int viewheight,deltaviewheight; } player_t;
typedef struct { int unused; } line_t;
struct mobj_s {
    thinker_t thinker;
    mobjtype_t type; mobjinfo_t *info; state_t *state; subsector_t *subsector; player_t *player;
    mobj_t *target,*bprev,*bnext,*sprev,*snext;
    fixed_t x,y,z,floorz,ceilingz,radius,height,momx,momy,momz;
    int flags,health,sprite,frame,tics,reactiontime,movecount,lastlook;
};
typedef enum { ok, crushed, pastdest } result_e;
typedef enum { raiseFloorTurbo, donutRaise, lowerAndChange } fixture_floor_e;
typedef struct { thinker_t thinker; sector_t *sector; fixed_t speed,floordestheight;
    boolean crush; int direction,newspecial,texture; fixture_floor_e type; } floormove_t;
state_t states[NUMSTATES]={
${states.join("\n")}
};
mobjinfo_t mobjinfo[NUMMOBJTYPES]={
${kinds.join("\n")}
};
${read("light-m_random.c")}
static sector_t sector={.floorheight=27*FRACUNIT,.ceilingheight=96*FRACUNIT,
    .blockbox={[BOXLEFT]=0,[BOXRIGHT]=1,[BOXBOTTOM]=0,[BOXTOP]=1}};
static subsector_t leaf={&sector};
static int gameskill=2,leveltime,validcount,numspechit,tmflags;
static boolean respawnmonsters,crushchange,nofit;
static fixed_t tmx,tmy,tmbbox[4],tmfloorz,tmceilingz,tmdropoffz;
static line_t *ceilingline;
static thinker_t thinkercap;
static floormove_t mover;
static mobj_t actors[2],*tmthing,*blocklinks[4];
static int count,bmapwidth=2,bmapheight=2,bmaporgx=-128*FRACUNIT,bmaporgy=-128*FRACUNIT;

// Both 16-unit-radius actors stand clear of every wall and one another.
static subsector_t *R_PointInSubsector(fixed_t x,fixed_t y) { return &leaf; }
static boolean P_BlockLinesIterator(int x,int y,boolean (*visit)(line_t*)) { return true; }
static boolean PIT_CheckLine(line_t *l) { abort(); }
static void *Z_Malloc(size_t size,int tag,void *owner) {
    assert(size==sizeof(mobj_t) && tag==PU_LEVEL && !owner && count<2);
    return &actors[count++];
}
static void Z_Free(void *item) { assert(item==&mover); }
static void P_XYMovement(mobj_t *m) { abort(); }
static void P_ExplodeMissile(mobj_t *m) { abort(); }
static void P_NightmareRespawn(mobj_t *m) { abort(); }
static void P_TouchSpecialThing(mobj_t *a,mobj_t *b) { abort(); }
static void P_DamageMobj(mobj_t *target,mobj_t *inflictor,mobj_t *source,int damage) { abort(); }
static void P_RemoveMobj(mobj_t *m) { abort(); }
static void S_StartSound(mobj_t *m,int sound) {
    assert(m==(mobj_t*)&sector.soundorg && (sound==sfx_stnmov || sound==sfx_pstop));
}
${extractFunction(tick,"void","P_InitThinkers")}
${extractFunction(tick,"void","P_AddThinker")}
${extractFunction(tick,"void","P_RemoveThinker")}
${extractFunction(tick,"void","P_RunThinkers")}
${extractFunction(util,"void","P_SetThingPosition")}
${extractFunction(util,"boolean","P_BlockThingsIterator")}
${extractFunction(util,"fixed_t","P_AproxDistance")}
${extractFunction(mobj,"boolean","P_SetMobjState")}
${extractFunction(mobj,"void","P_ZMovement")}
${extractFunction(mobj,"void","P_MobjThinker")}
${extractFunction(mobj,"mobj_t\\*","P_SpawnMobj")}
${extractFunction(map,"boolean","PIT_CheckThing")}
${extractFunction(map,"boolean","P_CheckPosition")}
${extractFunction(map,"boolean","P_ThingHeightClip")}
${extractFunction(map,"boolean","PIT_ChangeSector")}
${extractFunction(map,"boolean","P_ChangeSector")}
${extractFunction(floor,"result_e","T_MovePlane")}
${extractFunction(floor,"void","T_MoveFloor")}

static void floorTick(void *thinker) { T_MoveFloor(thinker); }
int main(void) {
    P_InitThinkers();
    mobj_t *anim=P_SpawnMobj(-48*FRACUNIT,0,ONCEILINGZ,MT_MISC51);
    mobj_t *still=P_SpawnMobj(48*FRACUNIT,0,ONCEILINGZ,MT_MISC54);
    assert(anim->info->doomednum==49 && still->info->doomednum==52 && still->tics==-1);
    anim->tics=2;
    sector.ceilingheight=128*FRACUNIT;
    assert(!P_ChangeSector(&sector,false));
    assert(anim->z==28*FRACUNIT && still->z==28*FRACUNIT);
    mover=(floormove_t){.sector=&sector,.type=raiseFloorTurbo,.direction=1,
        .speed=4*FRACUNIT,.floordestheight=33*FRACUNIT};
    mover.thinker.function.acp1=floorTick;
    sector.specialdata=&mover;
    P_AddThinker(&mover.thinker);
    prndindex=0;
    for (leveltime=0;leveltime<3;leveltime++) {
        P_RunThinkers();
        printf("[%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d]\\n",leveltime,sector.floorheight,
            anim->z,anim->floorz,(int)(anim->state-states),anim->tics,
            still->z,still->floorz,(int)(still->state-states),still->tics,prndindex);
    }
    assert(!sector.specialdata && still->thinker.next==&thinkercap);
    return 0;
}
`);
    function run(command, args) {
        const result = spawnSync(command, args, { cwd: scratch, encoding: "utf8", timeout: 30_000 });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, result.stderr || result.stdout || command);
        return result.stdout;
    }
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", "-fno-strict-aliasing", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(row => JSON.parse(row));
}
