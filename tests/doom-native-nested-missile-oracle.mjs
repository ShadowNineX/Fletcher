// Native missile impact can inherit a sky ceilingline from its victim's A_Chase.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

export function runNativeNestedMissileOracle(upstream, scratch) {
    const read = name => readFileSync(path.join(upstream, name), "utf8").replaceAll("\r\n", "\n");
    const map = read("movement-p_map.c"), util = read("movement-p_maputl.c");
    const mobj = read("p_mobj.c"), enemy = read("p_enemy.c"), tick = read("p_tick.c");
    const info = read("info.c"), renderer = read("r_main.c");
    const header = read("info.h").replace(/^#include "d_think.h"$/m, "");
    const sounds = read("sounds.h").match(/typedef enum\s*\{\s*sfx_None,[\s\S]*?\}\s*sfxenum_t\s*;/)?.[0];
    const flags = read("p_mobj.h").match(/typedef enum\s*\{[\s\S]*?\}\s*mobjflag_t;/)?.[0];
    const speeds = enemy.match(/^fixed_t\s+[xy]speed\[8\].*$/gm);
    assert.ok(sounds && flags && speeds?.length === 2);
    const states = ["S_POSS_STND", "S_POSS_RUN1", "S_POSS_PAIN", "S_TBALL1", "S_TBALL2",
        "S_TBALLX1", "S_TBALLX2", "S_TBALLX3"].map(name => {
        const row = info.split("\n").find(line => line.trimEnd().endsWith("// " + name));
        assert.ok(row, "Missing native state " + name);
        return `[${name}] = ${row.split("//")[0].trim()}`;
    });
    const kinds = ["MT_PLAYER", "MT_POSSESSED", "MT_TROOPSHOT"].map(name => {
        const row = info.match(new RegExp("\\{\\s*// " + name + "\\s*\\n[\\s\\S]*?^\\s*\\},", "m"));
        assert.ok(row, "Missing native kind " + name);
        return `[${name}] = ${row[0]}`;
    });
    const source = path.join(scratch, "nested-missile.c"), exe = path.join(scratch, "nested-missile.exe");
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
typedef struct { fixed_t x,y; } vertex_t;
typedef struct { int special,flags,slopetype,sidenum[2],validcount;
    fixed_t bbox[4],dx,dy; vertex_t *v1; sector_t *frontsector,*backsector; } line_t;
enum { ST_HORIZONTAL, ST_VERTICAL, ST_POSITIVE, ST_NEGATIVE, ML_BLOCKING=1, ML_BLOCKMONSTERS=2 };
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
    int flags,health,sprite,frame,tics,reactiontime,threshold,movedir,movecount,lastlook,spawnpoint;
};
static void A_Look(mobj_t *m), A_Chase(mobj_t *m);
state_t states[NUMSTATES] = {
${states.join("\n")}
};
mobjinfo_t mobjinfo[NUMMOBJTYPES] = {
${kinds.join("\n")}
};
static thinker_t thinkercap;
static sector_t sectors[2];
static subsector_t leaves[]={{sectors},{sectors+1}};
static mobj_t missile,victim,playerBody,*tmthing,*blocklinks[4];
static player_t players[4];
static boolean playeringame[4]={true}, floatok, fastparm,netgame,respawnmonsters;
static int bmapwidth=2,bmapheight=2,bmaporgx=-128*FRACUNIT,bmaporgy=-128*FRACUNIT;
static int tmflags,validcount,numspechit,gameskill=2,consoleplayer,skyflatnum=7,leveltime;
static fixed_t tmbbox[4],tmx,tmy,tmfloorz,tmdropoffz,tmceilingz;
static fixed_t opentop,openbottom,openrange,lowfloor;
static vertex_t start={60*FRACUNIT,64*FRACUNIT};
static line_t *ceilingline,*spechit[8],lines[]={{.flags=4,.slopetype=ST_VERTICAL,.sidenum={0,1},
    .v1=&start,.dy=-128*FRACUNIT,.bbox={64*FRACUNIT,-64*FRACUNIT,60*FRACUNIT,60*FRACUNIT},
    .frontsector=sectors,.backsector=sectors+1}};
// The two eastern cells contain the divider; the western cells have empty lists.
static short blockmap[]={0,1,0,1}, blockmaplump[]={-1,0,-1};
enum { ITEMQUESIZE=128 };
static int itemrespawnque[ITEMQUESIZE],itemrespawntime[ITEMQUESIZE],iquehead,iquetail;
static int stops,explosions;
${read("tables.c").replace(/^#include.*$/gm, "").replace(/\brcsid\b/g, "tablesRcsid")}
${read("light-m_random.c")}
static fixed_t viewx,viewy,*finecosine=&finesine[FINEANGLES/4];
${extractFunction(renderer,"angle_t","R_PointToAngle")}
${extractFunction(renderer,"angle_t","R_PointToAngle2")}
${extractFunction(read("m_fixed.c"),"fixed_t","FixedMul")}
${extractFunction(util,"fixed_t","P_AproxDistance")}

// Geometry services for two mutually visible sectors joined at x=60.
static subsector_t *R_PointInSubsector(fixed_t x,fixed_t y) { return &leaves[x>60*FRACUNIT]; }
static boolean P_CheckSight(mobj_t *a,mobj_t *b) { return true; }
static void P_CrossSpecialLine(int l,int side,mobj_t *m) { abort(); }
static boolean P_UseSpecialLine(mobj_t *m,line_t *l,int side) { abort(); }
static void P_TouchSpecialThing(mobj_t *item,mobj_t *m) { abort(); }
static void P_SlideMove(mobj_t *m) { abort(); }
static void P_NightmareRespawn(mobj_t *m) { abort(); }
static void P_KillMobj(mobj_t *a,mobj_t *b) { abort(); }
static void P_NewChaseDir(mobj_t *m) { abort(); }
static boolean P_CheckMissileRange(mobj_t *m) { abort(); }
static void I_Error(const char *text) { abort(); }
static void I_Tactile(int a,int b,int c) { abort(); }
static void S_StartSound(mobj_t *m,int sound) { assert(m==&missile && sound==sfx_firxpl); ++explosions; }
static void S_StopSound(mobj_t *m) { assert(m==&missile); ++stops; }
static void Z_Free(void *p) { abort(); }
static void P_DamageMobj(mobj_t *target,mobj_t *inflictor,mobj_t *source,int damage);
${extractFunction(tick,"void","P_InitThinkers")}
${extractFunction(tick,"void","P_AddThinker")}
${extractFunction(tick,"void","P_RemoveThinker")}
${extractFunction(tick,"void","P_RunThinkers")}
${extractFunction(util,"void","P_SetThingPosition")}
${extractFunction(util,"void","P_UnsetThingPosition")}
${extractFunction(util,"boolean","P_BlockThingsIterator")}
${extractFunction(util,"boolean","P_BlockLinesIterator")}
${extractFunction(util,"int","P_PointOnLineSide")}
${extractFunction(util,"int","P_BoxOnLineSide")}
${extractFunction(util,"void","P_LineOpening")}
${extractFunction(map,"boolean","PIT_CheckLine")}
${extractFunction(mobj,"void","P_RemoveMobj")}
${extractFunction(mobj,"boolean","P_SetMobjState")}
${extractFunction(mobj,"void","P_ExplodeMissile")}
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
        .x=x*FRACUNIT,.radius=info->radius,.height=info->height,.ceilingz=sectors[0].ceilingheight,
        .state=&states[info->spawnstate],.tics=10,.reactiontime=info->reactiontime};
    P_SetThingPosition(m);
}
static void runProfile(int profile) {
    memset(blocklinks,0,sizeof(blocklinks));
    sectors[0]=(sector_t){.ceilingheight=128*FRACUNIT};
    sectors[1]=(sector_t){.ceilingheight=96*FRACUNIT,.ceilingpic=profile==1 ? 0 : skyflatnum};
    stops=explosions=0;
    P_InitThinkers();
    place(&playerBody,MT_PLAYER,-110);
    players[0]=(player_t){.health=100,.mo=&playerBody};
    playerBody.player=&players[0];
    place(&missile,MT_TROOPSHOT,0);
    // Combined radii are 26: x=15 puts the shot one unit inside the victim.
    missile.z=8*FRACUNIT; missile.momx=15*FRACUNIT; missile.target=&playerBody;
    place(&victim,MT_POSSESSED,40);
    victim.movecount=2;
    missile.thinker.function.acp1=victim.thinker.function.acp1=think;
    P_AddThinker(&victim.thinker);
    P_AddThinker(&missile.thinker);
    prndindex=profile==2 ? 0 : 1;
    P_RunThinkers();
    int alive=missile.thinker.function.acv!=(actionf_v)(-1);
    assert(stops==!alive && explosions==alive && victim.health<victim.info->spawnhealth);
    printf("[%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d]\\n", profile,alive,alive?(int)(missile.state-states):0,
        alive?missile.tics:0,alive && (missile.flags & MF_MISSILE),victim.x,victim.z,victim.momx,
        (int)(victim.state-states),victim.health,prndindex);
}
int main(void) { runProfile(0); runProfile(1); runProfile(2); return 0; }
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
