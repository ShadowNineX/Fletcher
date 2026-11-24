// A skull slam can enter P_CheckPosition again while the struck monster wakes.
// Both invocations must share native tmthing so the impact reset observes the inner move.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

export function runNativeSkullImpactOracle(upstream, scratch) {
    const read = name => readFileSync(path.join(upstream, name), "utf8").replaceAll("\r\n", "\n");
    const map = read("movement-p_map.c"), util = read("movement-p_maputl.c");
    const mobj = read("p_mobj.c"), enemy = read("p_enemy.c"), tick = read("p_tick.c");
    const info = read("info.c"), renderer = read("r_main.c");
    const header = read("info.h").replace(/^#include "d_think.h"$/m, "");
    const sounds = read("sounds.h").match(/typedef enum\s*\{\s*sfx_None,[\s\S]*?\}\s*sfxenum_t\s*;/)?.[0];
    const flags = read("p_mobj.h").match(/typedef enum\s*\{[\s\S]*?\}\s*mobjflag_t;/)?.[0];
    const speeds = enemy.match(/^fixed_t\s+[xy]speed\[8\].*$/gm);
    assert.ok(sounds && flags && speeds?.length === 2);
    const states = ["S_POSS_STND", "S_POSS_RUN1", "S_POSS_PAIN", "S_SKULL_ATK2", "S_SKULL_STND"].map(name => {
        const row = info.split("\n").find(line => line.trimEnd().endsWith("// " + name));
        assert.ok(row, "Missing native state " + name);
        return `[${name}] = ${row.split("//")[0].trim()}`;
    });
    const kinds = ["MT_PLAYER", "MT_POSSESSED", "MT_SKULL"].map(name => {
        const row = info.match(new RegExp("\\{\\s*// " + name + "\\s*\\n[\\s\\S]*?^\\s*\\},", "m"));
        assert.ok(row, "Missing native kind " + name);
        return `[${name}] = ${row[0]}`;
    });
    const source = path.join(scratch, "skull-impact.c"), exe = path.join(scratch, "skull-impact.exe");
    writeFileSync(source, `#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef enum { false, true } boolean;
typedef int32_t fixed_t;
typedef uint32_t angle_t;
typedef struct mobj_s mobj_t;
typedef void (*actionf_v)(void);
typedef struct { void (*acp1)(mobj_t*); } actionf_t;
${header}
${sounds}
${flags}
#define ANG45 UINT32_C(0x20000000)
#define ANG90 UINT32_C(0x40000000)
#define ANG180 UINT32_C(0x80000000)
#define ANG270 UINT32_C(0xc0000000)
enum { FRACBITS=16, FRACUNIT=1<<16, FINEANGLES=8192, ANGLETOFINESHIFT=19, SLOPERANGE=2048,
    MAPBLOCKSHIFT=23, MAXRADIUS=32*FRACUNIT, MELEERANGE=64*FRACUNIT, FLOATSPEED=4*FRACUNIT,
    GRAVITY=FRACUNIT, MAXMOVE=30*FRACUNIT, STOPSPEED=0x1000, FRICTION=0xe800, VIEWHEIGHT=41*FRACUNIT,
    DI_NODIR=8, BASETHRESHOLD=100, wp_chainsaw=7, CF_GODMODE=2, CF_NOMOMENTUM=4, pw_invulnerability=0,
    sk_baby=0, sk_nightmare=4, BOXTOP=0, BOXBOTTOM, BOXLEFT, BOXRIGHT };
typedef struct thinker_s {
    struct thinker_s *prev,*next;
    union { actionf_v acv; void (*acp1)(void*); } function;
} thinker_t;
typedef struct { int special,ceilingpic; fixed_t floorheight,ceilingheight; mobj_t *thinglist,*soundtarget; } sector_t;
typedef struct { sector_t *sector; } subsector_t;
typedef struct { int special; sector_t *backsector; } line_t;
typedef struct {
    int readyweapon,cheats,powers[6],armortype,armorpoints,health,damagecount;
    fixed_t viewheight,deltaviewheight;
    struct { int forwardmove,sidemove; } cmd;
    mobj_t *mo,*attacker;
} player_t;
struct mobj_s {
    thinker_t thinker;
    mobjtype_t type; mobjinfo_t *info; state_t *state; subsector_t *subsector; player_t *player;
    mobj_t *target,*bprev,*bnext,*sprev,*snext;
    fixed_t x,y,z,floorz,ceilingz,radius,height,momx,momy,momz;
    angle_t angle;
    int flags,health,sprite,frame,tics,reactiontime,threshold,movedir,movecount,lastlook;
};
static void A_Look(mobj_t *m), A_Chase(mobj_t *m);
static void A_SkullAttack(mobj_t *m) { abort(); } // Initial state is seeded without an action.
state_t states[NUMSTATES] = {
${states.join("\n")}
};
mobjinfo_t mobjinfo[NUMMOBJTYPES] = {
${kinds.join("\n")}
};
static thinker_t thinkercap;
static sector_t sector;
static subsector_t leaf = { &sector };
static mobj_t skull,victim,playerBody,*tmthing,*blocklinks[8];
static player_t players[4];
static boolean playeringame[4]={true}, floatok, fastparm,netgame,respawnmonsters;
static int bmapwidth=4,bmapheight=2,bmaporgx=-256*FRACUNIT,bmaporgy=-128*FRACUNIT;
static int tmflags,validcount,numspechit,gameskill=2,consoleplayer,skyflatnum,leveltime;
static fixed_t tmbbox[4],tmx,tmy,tmfloorz,tmdropoffz,tmceilingz;
static line_t *ceilingline,*spechit[8],lines[1];
${read("tables.c").replace(/^#include.*$/gm, "").replace(/\brcsid\b/g, "tablesRcsid")}
${read("light-m_random.c")}
static fixed_t viewx,viewy,*finecosine=&finesine[FINEANGLES/4];
${extractFunction(renderer,"angle_t","R_PointToAngle")}
${extractFunction(renderer,"angle_t","R_PointToAngle2")}
${extractFunction(read("m_fixed.c"),"fixed_t","FixedMul")}
${extractFunction(util,"fixed_t","P_AproxDistance")}

// All movement is inside a single clear subsector. Native logic still decides
// sight angle, attack range, actor contact, thinker order and blockmap relinking.
static subsector_t *R_PointInSubsector(fixed_t x,fixed_t y) { return &leaf; }
static boolean P_CheckSight(mobj_t *a,mobj_t *b) { return true; }
static boolean P_BlockLinesIterator(int x,int y,boolean (*visit)(line_t*)) { return true; }
static boolean PIT_CheckLine(line_t *l) { abort(); }
static int P_PointOnLineSide(fixed_t x,fixed_t y,line_t *l) { abort(); }
static void P_CrossSpecialLine(int l,int side,mobj_t *m) { abort(); }
static boolean P_UseSpecialLine(mobj_t *m,line_t *l,int side) { abort(); }
static void P_TouchSpecialThing(mobj_t *item,mobj_t *m) { abort(); }
static void P_SlideMove(mobj_t *m) { abort(); }
static void P_ExplodeMissile(mobj_t *m) { abort(); }
static void P_NightmareRespawn(mobj_t *m) { abort(); }
static void P_RemoveMobj(mobj_t *m) { abort(); }
static void P_KillMobj(mobj_t *a,mobj_t *b) { abort(); }
static void P_NewChaseDir(mobj_t *m) { abort(); }
static boolean P_CheckMissileRange(mobj_t *m) { abort(); }
static void I_Error(const char *text) { abort(); }
static void I_Tactile(int a,int b,int c) { abort(); }
static void S_StartSound(mobj_t *m,int sound) { abort(); }
static void Z_Free(void *p) { abort(); }
static void P_DamageMobj(mobj_t *target,mobj_t *inflictor,mobj_t *source,int damage);
${extractFunction(tick,"void","P_InitThinkers")}
${extractFunction(tick,"void","P_AddThinker")}
${extractFunction(tick,"void","P_RunThinkers")}
${extractFunction(util,"void","P_SetThingPosition")}
${extractFunction(util,"void","P_UnsetThingPosition")}
${extractFunction(util,"boolean","P_BlockThingsIterator")}
${extractFunction(mobj,"boolean","P_SetMobjState")}
${extractFunction(map,"boolean","PIT_CheckThing")}
${extractFunction(map,"boolean","P_CheckPosition")}
${extractFunction(map,"boolean","P_TryMove")}
${speeds.join("\n")}
${extractFunction(enemy,"boolean","P_Move")}
${extractFunction(enemy,"boolean","P_CheckMeleeRange")}
${extractFunction(enemy,"boolean","P_LookForPlayers")}
${extractFunction(enemy,"void","A_Look")}
${extractFunction(enemy,"void","A_Chase")}
${extractFunction(read("p_inter.c"),"void","P_DamageMobj")}
${extractFunction(mobj,"void","P_XYMovement")}
${extractFunction(mobj,"void","P_ZMovement")}
${extractFunction(mobj,"void","P_MobjThinker")}

static void think(void *m) { P_MobjThinker(m); }
static void place(mobj_t *m,mobjtype_t type,int x) {
    mobjinfo_t *info=&mobjinfo[type];
    *m=(mobj_t){.type=type,.info=info,.health=info->spawnhealth,.flags=info->flags,
        .x=x*FRACUNIT,.radius=info->radius,.height=info->height,.ceilingz=sector.ceilingheight,
        .state=&states[info->spawnstate],.tics=10,.reactiontime=info->reactiontime};
    P_SetThingPosition(m);
}
static void runProfile(int profile) {
    memset(blocklinks,0,sizeof(blocklinks));
    sector=(sector_t){.ceilingheight=128*FRACUNIT};
    P_InitThinkers();
    place(&playerBody,MT_PLAYER,-110);
    players[0]=(player_t){.health=100,.mo=&playerBody};
    playerBody.player=&players[0];
    place(&skull,MT_SKULL,0);
    skull.z=8*FRACUNIT; skull.momx=8*FRACUNIT; skull.momz=2*FRACUNIT; skull.flags |= MF_SKULLFLY;
    skull.state=&states[skull.info->missilestate+1];
    place(&victim,MT_POSSESSED,40);
    victim.movecount=2;
    skull.thinker.function.acp1=victim.thinker.function.acp1=think;
    P_AddThinker(&skull.thinker);
    P_AddThinker(&victim.thinker);
    prndindex=profile==0 ? 1 : 0;
    for (leveltime=0;leveltime<2;leveltime++) {
        P_RunThinkers();
        printf("[%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d]\\n", profile,leveltime,skull.x,skull.z,skull.momz,
            !!(skull.flags & MF_SKULLFLY),victim.x,victim.momx,(int)(victim.state-states),victim.health,prndindex);
    }
}
int main(void) { runProfile(0); runProfile(1); return 0; }
`);
    function run(command, args) {
        const result = spawnSync(command, args, { cwd: scratch, encoding: "utf8", timeout: 30_000 });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, result.stderr || result.stdout || command);
        return result.stdout;
    }
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(row => JSON.parse(row));
}
