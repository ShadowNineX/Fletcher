// A surviving telefrag victim wakes and moves across a step before the imp
// lands. Its position check changes the next stomp's source, range and heights.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-nested-walkover-"));
const unit = 65536;
const seed = 3;

function run(program, args) {
    const proc = spawnSync(program, args, { cwd: root, encoding: "utf8", timeout: 60000 });
    if (proc.error) throw proc.error;
    assert.equal(proc.status, 0, proc.stderr || proc.stdout);
    return proc.stdout;
}

function room() {
    function words(values) {
        const data = Buffer.alloc(values.length * 2);
        values.forEach((v, i) => data.writeUInt16LE(v & 65535, 2 * i));
        return data;
    }
    const sector = Buffer.alloc(26);
    sector.writeInt16LE(128, 2);
    sector.writeInt16LE(7, 24);
    const east = Buffer.alloc(26);
    east.writeInt16LE(16, 0);
    east.writeInt16LE(104, 2);
    const sides = Buffer.alloc(60);
    sides.writeInt16LE(1, 58);
    const edges = [[0, 1, 0, -1], [1, 2, 0, -1], [2, 3, 0, 1], [3, 0, 0, -1],
        [2, 4, 1, -1], [4, 5, 1, -1], [5, 3, 1, -1]];
    const segs = [[0, 1, 1, 0], [1, 2, 2, 0], [2, 3, 3, 0], [3, 0, 4, 0],
        [2, 4, 5, 0], [4, 5, 6, 0], [5, 3, 7, 0], [3, 2, 3, 1]];
    const angles = [0x4000, 0, 0xc000, 0x8000, 0, 0xc000, 0x8000, 0x4000];
    const block = words([-256, -128, 4, 2, ...Array(8).fill(12), 0, 0, 1, 2, 3, 4, 5, 6, 7, -1]);
    const lumps = [
        ["Vertices", 8, words([-224, -96, -224, 96, 100, 96, 100, -96, 192, 96, 192, -96, 0, 96, 0, -96])],
        ["Lines", 8, words([6, 7, 4, 126, 7, 0, 0,
            ...edges.flatMap(([a, b, front, back]) => [a, b, back < 0 ? 1 : 4, 0, 0, front, back])])],
        ["Sides", 2, sides], ["Sectors", 2, Buffer.concat([sector, east])],
        ["Nodes", 1, words([100, -96, 0, 192, 96, -96, 100, 192, 96, -96, -224, 100, 0x8001, 0x8000])],
        ["Segs", 8, words(segs.flatMap(([a, b, line, side], i) => [a, b, angles[i], line, side, 0]))],
        ["Subsectors", 2, words([4, 0, 4, 4])], ["Reject", 1, Buffer.alloc(1)], ["BlockMap", block.length, block],
    ];
    writeFileSync(path.join(scratch, "LEVEL.WAD"), Buffer.concat(lumps.map(([, , data]) => data)));
    let offset = 0;
    return lumps.map(([name, count, data]) => {
        const field = `${name}: wad.Lump{Valid: true, Offset: ${offset}, Count: ${count}}`;
        offset += data.length;
        return field;
    }).join(",\n");
}

function native(upstream) {
    const read = name => readFileSync(path.resolve(root, upstream, name), "utf8").replaceAll("\r\n", "\n");
    const info = read("info.c"), enemy = read("p_enemy.c"), mobj = read("p_mobj.c"), map = read("movement-p_map.c");
    const flags = read("p_mobj.h").match(/typedef enum\s*\{[\s\S]*?\}\s*mobjflag_t;/)?.[0];
    const dirs = enemy.match(/^fixed_t\s+[xy]speed\[8\].*$/gm);
    const directionType = enemy.match(/typedef enum\s*\{[^}]+\}\s*dirtype_t;/)?.[0];
    const directionTables = enemy.match(/dirtype_t (?:opposite|diags)\[\]\s*=\s*\{[^}]+\};/g);
    assert.ok(flags && dirs?.length === 2 && directionType && directionTables?.length === 2);
    const states = ["S_BOSS_RUN1", "S_TROO_RUN1", "S_POSS_PAIN", "S_TFOG"].map(name => {
        const line = info.split("\n").find(row => row.trimEnd().endsWith("// " + name));
        assert.ok(line);
        return `[${name}] = ${line.split("//")[0].trim()}`;
    });
    const kinds = ["MT_PLAYER", "MT_TROOP", "MT_BRUISER", "MT_TELEPORTMAN", "MT_TFOG", "MT_POSSESSED"].map(name => {
        const row = info.match(new RegExp("\\{\\s*// " + name + "\\s*\\n[\\s\\S]*?^\\s*\\},", "m"));
        assert.ok(row);
        return `[${name}] = ${row[0]}`;
    });
    const cross = extractFunction(read("animated-p_spec.c"), "void", "P_CrossSpecialLine");
    const otherSpecials = [...new Set(cross.match(/\b(?:EV_|G_)[A-Za-z]+\b/g))].filter(name => name !== "EV_Teleport");
    const renderer = read("r_main.c"), mapUtil = read("movement-p_maputl.c");
    const source = path.join(scratch, "nested.c"), exe = path.join(scratch, "nested.exe");
    writeFileSync(source, `#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef enum { false, true } boolean;
typedef int32_t fixed_t;
typedef uint32_t angle_t;
typedef struct mobj_s mobj_t;
typedef void (*actionf_p1)(mobj_t *);
typedef struct { actionf_p1 acp1; } actionf_t;
typedef struct thinker_s { actionf_t function; struct thinker_s *next; } thinker_t;
${read("info.h").replace(/^#include "d_think.h"$/m, "")}
${read("sounds.h")}
${flags}
#define ANG45 UINT32_C(0x20000000)
#define ANG90 UINT32_C(0x40000000)
#define ANG180 UINT32_C(0x80000000)
#define ANG270 UINT32_C(0xc0000000)
#define ONFLOORZ INT32_MIN
#define ONCEILINGZ INT32_MAX
enum { FRACBITS=16, FRACUNIT=65536, FINEANGLES=8192, ANGLETOFINESHIFT=19, SLOPERANGE=2048,
    MAPBLOCKSHIFT=23, MAXRADIUS=32*FRACUNIT, MELEERANGE=64*FRACUNIT, FLOATSPEED=4*FRACUNIT,
    BASETHRESHOLD=100, wp_chainsaw=7, CF_GODMODE=2, pw_invulnerability=0, sk_baby=0, sk_nightmare=4,
    PU_LEVEL=50, MAXPLAYERS=4 };
typedef struct { int special, tag; fixed_t floorheight, ceilingheight; } sector_t;
typedef struct { fixed_t x,y; } vertex_t;
typedef struct { int special,tag,flags,slopetype,sidenum[2],validcount;
    fixed_t bbox[4],dx,dy; vertex_t *v1; sector_t *frontsector,*backsector; } line_t;
typedef struct { sector_t *sector; } subsector_t;
typedef struct { int readyweapon, cheats, powers[6], armorpoints, armortype, health, damagecount;
    mobj_t *attacker; fixed_t viewz,viewheight; } player_t;
struct mobj_s { thinker_t thinker; mobjtype_t type; mobjinfo_t *info; state_t *state; subsector_t *subsector;
    fixed_t x,y,z,momx,momy,momz,floorz,ceilingz,radius,height; angle_t angle;
    int health,flags,sprite,frame,tics,reactiontime,threshold,movedir,movecount,lastlook;
    mobj_t *target,*bnext; player_t *player;
};
static void A_Chase(mobj_t *m);
state_t states[NUMSTATES] = { ${states.join("\n")} };
mobjinfo_t mobjinfo[NUMMOBJTYPES] = { ${kinds.join("\n")} };
${read("tables.c").replace(/^#include.*$/gm, "").replace(/\brcsid\b/g, "tablesRcsid")}
${read("light-m_random.c")}
static sector_t sectors[]={{.tag=7,.ceilingheight=128*FRACUNIT},{.floorheight=16*FRACUNIT,.ceilingheight=104*FRACUNIT}};
static subsector_t leaves[]={{sectors},{sectors+1}};
static line_t lines[]={{.special=126,.tag=7}}, *spechit[1], *ceilingline;
static thinker_t thinkercap, *tail=&thinkercap;
static int gameskill=2, gamemap=30, numsectors=2, fastparm, netgame, consoleplayer, numspechit, floatok, validcount, tmflags;
static const int bmapwidth=4, bmapheight=2, bmaporgx=-256*FRACUNIT, bmaporgy=-128*FRACUNIT;
enum { BOXTOP, BOXBOTTOM, BOXLEFT, BOXRIGHT };
enum { ST_HORIZONTAL, ST_VERTICAL, ST_POSITIVE, ST_NEGATIVE, ML_BLOCKING=1, ML_BLOCKMONSTERS=2 };
static fixed_t opentop,openbottom,openrange,lowfloor;
static vertex_t dividerStart={100*FRACUNIT,96*FRACUNIT};
static line_t divider={.flags=4,.slopetype=ST_VERTICAL,.sidenum={0,1},.dy=-192*FRACUNIT,.v1=&dividerStart,
    .bbox={96*FRACUNIT,-96*FRACUNIT,100*FRACUNIT,100*FRACUNIT},.frontsector=sectors,.backsector=sectors+1};
static fixed_t viewx, viewy, *finecosine=&finesine[FINEANGLES/4], tmx,tmy,tmbbox[4],tmfloorz,tmceilingz,tmdropoffz;
static player_t players[4];
static mobj_t actors[7], *tmthing, *blocklinks[8];
static int count, fogSounds;
static void P_MobjThinker(mobj_t *m) { abort(); }
static void P_AddThinker(thinker_t *t) { tail->next=t; tail=t; t->next=&thinkercap; }
static int cell(mobj_t *m) { return ((m->x-bmaporgx)>>23)+4*((m->y-bmaporgy)>>23); }
static subsector_t *R_PointInSubsector(fixed_t x,fixed_t y) { return &leaves[x>100*FRACUNIT]; }
static void P_UnsetThingPosition(mobj_t *m) {
    if (m->flags & MF_NOBLOCKMAP) return;
    mobj_t **p=&blocklinks[cell(m)];
    while (*p!=m) { assert(*p); p=&(*p)->bnext; }
    *p=m->bnext;
}
static void P_SetThingPosition(mobj_t *m) {
    m->subsector=R_PointInSubsector(m->x,m->y);
    if (!(m->flags & MF_NOBLOCKMAP)) { m->bnext=blocklinks[cell(m)]; blocklinks[cell(m)]=m; }
}
static void *Z_Malloc(size_t n, int tag, void *owner) { assert(n==sizeof(mobj_t) && count<7); return &actors[count++]; }
static void S_StartSound(mobj_t *m,int id) { assert(m && m->type==MT_TFOG && id==sfx_telept); ++fogSounds; }
static void P_CrossSpecialLine(int line,int side,mobj_t *m);
static boolean checkedMove(mobj_t *m,fixed_t x,fixed_t y);
// Drive the outer crossing as before. The inner Baron move must run the
// native position query and relink before PIT_StompThing visits the next cell.
static boolean P_TryMove(mobj_t *m,fixed_t x,fixed_t y) {
    fixed_t old=m->x;
    assert(y==0);
    if (m==&actors[3]) {
        assert(old==96*FRACUNIT && x==104*FRACUNIT && actors[1].x==4*FRACUNIT && count==5);
        return checkedMove(m,x,y);
    }
    assert(m==&actors[1] && old==-4*FRACUNIT && x==4*FRACUNIT);
    P_UnsetThingPosition(m); m->x=x; m->y=y; P_SetThingPosition(m);
    if (old<0 && x>=0) P_CrossSpecialLine(0,0,m);
    return true;
}
static boolean P_BlockLinesIterator(int x,int y,boolean (*visit)(line_t *)) {
    // The divider is the only line within the inner move's bounding box.
    if (x!=2 || y<0 || y>=2 || divider.validcount==validcount) return true;
    divider.validcount=validcount;
    return visit(&divider);
}
static void P_TouchSpecialThing(mobj_t *a,mobj_t *b) { abort(); }
static void P_DamageMobj(mobj_t *target,mobj_t *inflictor,mobj_t *source,int damage);
static boolean P_CheckSight(mobj_t *a,mobj_t *b) { return true; }
static boolean P_LookForPlayers(mobj_t *m,boolean allaround) { abort(); }
static boolean P_UseSpecialLine(mobj_t *m,line_t *l,int side) { abort(); }
static void P_RemoveMobj(mobj_t *m) { abort(); }
static void P_KillMobj(mobj_t *source,mobj_t *target) { abort(); }
static void I_Tactile(int a,int b,int c) { abort(); }
static void I_Error(const char *msg) { abort(); }
${extractFunction(renderer, "angle_t", "R_PointToAngle")}
${extractFunction(renderer, "angle_t", "R_PointToAngle2")}
${extractFunction(read("m_fixed.c"), "fixed_t", "FixedMul")}
${extractFunction(mapUtil, "fixed_t", "P_AproxDistance")}
${extractFunction(mapUtil, "boolean", "P_BlockThingsIterator")}
${extractFunction(mapUtil, "int", "P_PointOnLineSide")}
${extractFunction(mapUtil, "int", "P_BoxOnLineSide")}
${extractFunction(mapUtil, "void", "P_LineOpening")}
${extractFunction(mobj, "boolean", "P_SetMobjState")}
${extractFunction(map, "boolean", "PIT_CheckLine")}
${extractFunction(map, "boolean", "PIT_CheckThing")}
${extractFunction(map, "boolean", "P_CheckPosition")}
#define P_TryMove checkedMove
${extractFunction(map, "boolean", "P_TryMove")}
#undef P_TryMove
${extractFunction(mobj, "mobj_t\\*", "P_SpawnMobj")}
${directionType}
${directionTables.join("\n")}
${dirs.join("\n")}
${extractFunction(enemy, "boolean", "P_Move")}
${extractFunction(enemy, "boolean", "P_TryWalk")}
${extractFunction(enemy, "void", "P_NewChaseDir")}
${extractFunction(enemy, "boolean", "P_CheckMeleeRange")}
${extractFunction(enemy, "boolean", "P_CheckMissileRange")}
${extractFunction(enemy, "void", "A_Chase")}
${extractFunction(read("p_inter.c"), "void", "P_DamageMobj")}
${extractFunction(map, "boolean", "PIT_StompThing")}
${extractFunction(map, "boolean", "P_TeleportMove")}
${extractFunction(read("p_telept.c"), "int", "EV_Teleport")}
${otherSpecials.map(name => `#define ${name}(...) abort()`).join("\n")}
${cross}
int main(int argc, char **argv) {
    assert(argc==2);
    int search=atoi(argv[1]);
    mobj_t *player=P_SpawnMobj((search?180:-180)*FRACUNIT,0,ONFLOORZ,MT_PLAYER);
    mobj_t *imp=P_SpawnMobj(-4*FRACUNIT,0,ONFLOORZ,MT_TROOP);
    P_SpawnMobj(96*FRACUNIT,0,ONFLOORZ,MT_TELEPORTMAN);
    mobj_t *baron=P_SpawnMobj(96*FRACUNIT,0,ONFLOORZ,MT_BRUISER);
    mobj_t *witness=P_SpawnMobj(145*FRACUNIT,0,ONFLOORZ,MT_POSSESSED);
    witness->flags &= ~MF_SOLID; witness->health=11000;
    P_SetMobjState(witness,witness->info->painstate);
    imp->target=player; imp->movedir=search?DI_NORTH:DI_EAST; imp->movecount=search?0:3;
    baron->movedir=DI_EAST; baron->movecount=3; baron->health=11000;
    prndindex=${seed};
    P_SetMobjState(imp,imp->info->seestate);
    assert(fogSounds==2 && count==7);
    printf("[%d,%d,%d,%d,%d,%td,%d,%d,%d,%d,%d,%d,%d,%d,%d]\\n",imp->x,imp->movecount,imp->reactiontime,
        baron->health,baron->x,baron->target-actors+1,baron->threshold,baron->reactiontime,baron->movecount,
        baron->state==&states[baron->info->seestate],baron->tics,prndindex,count,lines[0].special,imp->movedir);
    for (int i=5;i<7;++i) {
        mobj_t *m=&actors[i]; printf("[%d,%d,%d,%d,%d,%d]\\n",m->type,m->x,m->y,m->z,m->lastlook,m->tics);
    }
    printf("[%d,%d,%d,%d,%d,%d,%d,%td]\\n",imp->y,imp->z,imp->floorz,imp->ceilingz,
        (int)(imp->subsector->sector-sectors),baron->z,witness->health,witness->target ? witness->target-actors+1 : 0);
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", "-fno-strict-aliasing", source, "-o", exe]);
    return ["0", "1"].map(search => run(exe, [search]).trim().split(/\r?\n/).map(row => JSON.parse(row)));
}

function preview() {
    const copy = path.join(scratch, "preview"), entry = path.join(copy, "main.flt");
    cpSync(path.join(port, "wad-bsp"), copy, { recursive: true });
    let source = readFileSync(entry, "utf8");
    const map = source.indexOf('map "Original WAD BSP View"');
    assert.ok(map > 0);
    source = source.slice(0, map);
    if (!source.includes('import "actorinfo"')) source = source.replace('import "play"', 'import "play"\nimport "actorinfo"');
    writeFileSync(entry, source + `
map "Nested MAP30 walkover" {
    screen at (0, 0) size (1, 1) with {style = "solid", hold = true, slice = true}
    tick {
        level := wad.BspLevel{Valid: true, File: Archive, MapName: wad.LumpName{Low: 0x3350414d, High: 48}, ${room()}}
        blocks := wad.LoadBlockMap(level)
        random := play.RandomState{GameplayIndex: ${seed}, MenuIndex: 21}
        rules := play.CombatRules{Skill: 2}
        search := currentTick() == 1
        playerX := -(180 << 16)
        if search { playerX = 180 << 16 }
        player := play.SpawnMobj(level, actorinfo.ActorPlayer, playerX, 0, play.ActorOnFloor, 2, random).Actor
        player.PlayerSlot, player.Physics.Body.Player = 0, true
        imp := play.SpawnMobj(level, actorinfo.ActorImp, -(4 << 16), 0, play.ActorOnFloor, 2, random).Actor
        imp.MoveDirection, imp.MoveCount, imp.Target = 0, 3, 1
        if search { imp.MoveDirection, imp.MoveCount = enemy.ChaseNorth, 0 }
        outer := play.SetMobjState(imp, actorinfo.KindAt(imp.Kind).SeeState)
        marker := play.SpawnMobj(level, actorinfo.ActorTeleportTarget, 96 << 16, 0, play.ActorOnFloor, 2, random).Actor
        baron := play.SpawnMobj(level, actorinfo.ActorBruiser, 96 << 16, 0, play.ActorOnFloor, 2, random).Actor
        baron.Health, baron.MoveDirection, baron.MoveCount = 11000, 0, 3
        // Shootable but non-solid so the Baron can enter range before the
        // teleport scan reaches this next blockmap column.
        witness := play.SpawnMobj(level, actorinfo.ActorPossessed, 145 << 16, 0, play.ActorOnFloor, 2, random).Actor
        witness.Physics.Body.Flags = witness.Physics.Body.Flags & ~bits<32>(play.ActorSolid)
        witness.Health = 11000
        witness = play.SetMobjState(witness, actorinfo.KindAt(witness.Kind).PainState).Actor
        actors := play.MapActors{}.AppendActor(player).AppendActor(outer.Actor).AppendActor(marker).AppendActor(baron).AppendActor(witness)
        actors.PlayerActors[0] = 1
        scene := PreviewCombat{Base: level, Level: level, MapActors: 5, Rules: rules, GameTic: 63}
        scene.World.Actors, scene.World.Links = actors, play.BuildActorLinks(actors, blocks)
        scene.World.Random, scene.Specials.Lighting.Random = random, random
        scene.World.Players[0] = play.NewPlayerInventory(87)
        scene.View.Refire = 7
        event := play.CombatStep{World: scene.World, ActorHandle: 2, State: outer}
        state := PreviewWalkoverTelefrag{Blocks: blocks}.OnTelefrag(previewWalkoverState(scene), event, rules)
        scene = resumePreviewWalkover(scene, state)
        imp, baron = scene.World.Actors.ActorAt(1), scene.World.Actors.ActorAt(3)
        log("nested", scene.Failed, imp.Physics.Body.X, imp.MoveCount, imp.ReactionTime,
            baron.Health, baron.Physics.Body.X, baron.Target, baron.Threshold, baron.ReactionTime, baron.MoveCount,
            baron.State == actorinfo.KindAt(baron.Kind).SeeState, baron.Tics, scene.World.Random.GameplayIndex,
            scene.World.Actors.Count, scene.Level.LineAt(0).Action, imp.MoveDirection)
        for i := range scene.World.Actors.Count - 5 {
            fog := scene.World.Actors.ActorAt(i + 5)
            log("fog", fog.Kind, fog.Physics.Body.X, fog.Physics.Body.Y, fog.Physics.Body.Z, fog.LastLook, fog.Tics)
        }
        witness = scene.World.Actors.ActorAt(4)
        log("landing", imp.Physics.Body.Y, imp.Physics.Body.Z, imp.Physics.Body.Floor, imp.Physics.Body.Ceiling,
            imp.Sector, baron.Physics.Body.Z, witness.Health, witness.Target)
        log("scene", outer.Action == actorinfo.ActionChase, scene.World.Random.MenuIndex, scene.World.Players[0].Health, scene.View.Refire)
    }
}`);
    const output = path.join(scratch, "nested.json");
    run("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    return [0, 1].map(() => {
        const start = sim.logs.length;
        for (let host = 0; host < 60; host++) {
            sim.step();
            const rows = sim.logs.slice(start);
            if (rows.at(-1)?.[0] === "scene") return rows.map(([tag, ...v]) => [tag, ...v.map(Number)]);
        }
        assert.fail("Nested walkover did not commit: " + JSON.stringify(sim.logs.slice(start)));
    });
}

try {
    const oracle = values.upstream ? native(values.upstream) : null;
    for (const [search, rows] of preview().entries()) {
        if (oracle) assert.deepEqual([rows[0].slice(2), ...rows.slice(1, 4).map(row => row.slice(1))], oracle[search],
            "native nested chase, teleport and RNG for " + (search ? "a new direction" : "a direct move"));
        assert.deepEqual(rows[0], ["nested", 0, 96 * unit, search ? 14 : 2, 7, 1000, 104 * unit, 2,
            99, 0, 2, 1, 3, search ? 11 : 9, 7, 126, 0],
            "the Baron chases before the imp finishes its eastward move");
        assert.deepEqual(rows.slice(1), [["fog", 39, 4 * unit, 0, 0, 3, 6],
            ["fog", 39, 96 * unit + 20 * 65535, 20 * 25, 16 * unit, search ? 0 : 3, 6],
            ["landing", 0, 16 * unit, 16 * unit, 104 * unit, 0, 16 * unit, 1000, 4], ["scene", 1, 21, 87, 7]],
            "fog spawns follow the nested chase and preserve the outer scene");
    }
    console.log("Preview nested MAP30 telefrags passed direct movement and P_NewChaseDir, the second stomp's source, landing heights, both fogs and shared RNG.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-nested-walkover-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
