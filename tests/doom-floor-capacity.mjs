// Simultaneous tagged floors and uniquely seeded stairs compete for the same thinker storage.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const scratch = mkdtempSync(path.join(os.tmpdir(), "fletcher-floor-capacity-"));
const count = 70, platform = count + 1, stairsTic = 25, finalTic = stairsTic + 4, unit = 65536;
const chambers = Array.from({ length: count }, (_, i) => i + 1);
const initialHeight = s => s === 1 || s === platform ? 0 : s === 0 ? 8 : s * 16 - 4 * (1 + s % 3);
// The common sector borders the first step and the separate platform.
const lines = [[0, 1, 92, 7], [0, platform, 95, 8], [0, 1, 100, 9],
    ...chambers.slice(1).map(s => [s - 1, s, 0, 0])];

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 60000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}
function words(...fields) {
    const b = Buffer.alloc(fields.length * 2);
    fields.forEach((v, i) => b.writeUInt16LE(v & 65535, 2 * i));
    return b;
}
function room() {
    const sectors = Buffer.alloc(26 * (platform + 1)), sides = Buffer.alloc(30 * (platform + 1));
    for (let s = 0; s <= platform; ++s) {
        sides.writeInt16LE(s, s * 30 + 28);
        sectors.writeInt16LE(initialHeight(s), 26 * s);
        sectors.writeInt16LE(1800, 26 * s + 2);
        sectors.write(s > 0 && s < platform ? "STEPFLAT" : "BASEFLAT", 26 * s + 4);
        sectors.writeInt16LE(s === platform ? 8 : s > 0 ? 7 : 0, 26 * s + 24);
    }
    const stairs = Buffer.from(sectors);
    for (const s of chambers) stairs.writeInt16LE(s === 1 ? 9 : 0, 26 * s + 24);
    const records = [
        ["Vertices", 2, words(0, -32, 0, 32)], ["Sides", platform + 1, sides], ["Sectors", platform + 1, sectors],
        ["Lines", lines.length, Buffer.concat(lines.map(([a,b,special,tag]) => words(0,1,4,special,tag,a,b)))],
        ["Nodes", 0, Buffer.alloc(0)], ["Segs", 1, words(0,1,0,0,0,0)], ["Subsectors", 1, words(1,0)],
    ];
    let offset = 0;
    const fields = records.map(([field,n,b]) => {
        const decl = `${field}: wad.Lump{Valid: true, Offset: ${offset}, Count: ${n}}`;
        offset += b.length;
        return decl;
    }).join(",\n");
    writeFileSync(path.join(scratch, "ROOM.BIN"), Buffer.concat([...records.map(r => r[2]), stairs]));
    return { fields, stairs: `wad.Lump{Valid: true, Offset: ${offset}, Count: ${platform + 1}}` };
}
function fletcherRows() {
    const geo = room(), source = path.join(scratch, "main.flt"), output = path.join(scratch, "map.json");
    writeFileSync(source, `package main
import "play"
import "wad"
const Room = readFile("ROOM.BIN")
map "Tagged floor and stair capacity" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register saved play.LevelSpecials = play.LevelSpecials{}
    register tic int = 0
    tick {
        base := wad.BspLevel{Valid: true, File: Room, ${geo.fields}}
        state := saved
        if tic >= ${stairsTic} { base.Sectors = ${geo.stairs} }
        if tic == 0 {
            state = play.CrossLevelSpecial(base, state, 0)
            state = play.CrossLevelSpecial(state.ApplyTo(base), state, 1)
        }
        if tic == ${stairsTic} { state = play.CrossLevelSpecial(base, play.LevelSpecials{}, 2) }
        log("start", tic, state.Floors.Count, state.Floors.ActivePlatforms)
        moved := play.TickLevelMoversAt(base, wad.BlockMapInfo{}, state, play.MapActor{Height: 16 << 16}, tic)
        state = moved.State
        live := state.ApplyTo(base)
        for i := range moved.Sounds.Count {
            cue := moved.Sounds.At(i)
            log("sound", tic, cue.Sector, cue.Id)
        }
        for i := range ${platform} {
            s := i + 1
            log("sector", tic, s, live.SectorHeightsAt(s).Floor, state.MoverOccupied(s))
        }
        log("end", tic, state.Floors.Count, state.Floors.ActivePlatforms, state.Floors.PlatformOverflow, moved.Valid)
        next saved = state
        next tic = tic + 1
    }
}`);
    run("dotnet", [cli, "build", source, "--package-root", path.join(root, "examples", "doom-engine"), "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true), rows = [];
    for (let host = 0; host < 30000; ++host) {
        const pos = sim.logs.length;
        sim.step();
        for (const [tag, ...fields] of sim.logs.slice(pos)) {
            const row = [tag, ...fields.map(Number)];
            rows.push(row);
            if (tag === "end" && row[1] === 0) sim.roundTripScriptState();
            if (tag === "end" && row[1] === finalTic) return rows;
        }
    }
    assert.fail("simulation exceeded its host budget");
}

function nativeRows(directory) {
    const read = name => readFileSync(path.join(directory, name), "utf8").replaceAll("\r\n", "\n");
    const floors = read("door-p_floor.c"), plats = read("platform-p_plats.c");
    const spec = read("animated-p_spec.c"), scheduler = read("p_tick.c");
    const activePlats = plats.search(/plat_t\s*\*\s*activeplats\s*\[/);
    assert.ok(activePlats >= 0);
    const source = path.join(scratch, "floors.c"), exe = path.join(scratch, process.platform === "win32" ? "floors.exe" : "floors");
    writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
#include <limits.h>
#define MAXINT INT_MAX
#define FRACUNIT 65536
#define FLOORSPEED FRACUNIT
#define PLATSPEED FRACUNIT
#define PLATWAIT 3
#define MAXPLATS 30
#define MAX_ADJOINING_SECTORS 20
enum {false,true,ML_TWOSIDED=4,PU_LEVSPEC=51,sfx_pstart=18,sfx_pstop=19,sfx_stnmov=22};
typedef int boolean,fixed_t,mobj_t;
typedef enum {ok,crushed,pastdest} result_e;
typedef enum {lowerFloor,lowerFloorToLowest,turboLower,raiseFloor,raiseFloorToNearest,raiseToTexture,lowerAndChange,
        raiseFloor24,raiseFloor24AndChange,raiseFloorCrush,raiseFloorTurbo,donutRaise,raiseFloor512} floor_e;
typedef enum {build8,turbo16} stair_e;
typedef enum {up,down,waiting,in_stasis} plat_e;
typedef enum {perpetualRaise,downWaitUpStay,raiseAndChange,raiseToNearestAndChange,blazeDWUS} plattype_e;
typedef void (*actionf_p1)(void *);typedef void (*actionf_v)(void);
typedef struct thinker_s {struct thinker_s *prev,*next;union {actionf_p1 acp1;actionf_v acv;} function;} thinker_t;
typedef struct sector_s sector_t;
typedef struct {sector_t *frontsector,*backsector;int tag,flags,sidenum[2],special;} line_t;
struct sector_s {fixed_t floorheight,ceilingheight;int floorpic,special,soundorg,tag,linecount;void *specialdata;line_t *lines[3];};
typedef struct {sector_t *sector;int bottomtexture;} side_t;
typedef struct {thinker_t thinker;floor_e type;boolean crush;sector_t *sector;int direction,newspecial,texture;fixed_t floordestheight,speed;} floormove_t;
typedef struct {thinker_t thinker;sector_t *sector;fixed_t speed,low,high;int wait,count;plat_e status,oldstatus;boolean crush;int tag;plattype_e type;} plat_t;
static thinker_t thinkercap;
static sector_t sectors[${platform + 1}];static side_t sides[${platform + 1}];static line_t lines[${lines.length}];
static int numsectors=${platform+1},leveltime,inThinkers,textureheight[1];
static void I_Error(const char *text){fputs(text,stderr);abort();}
static void *Z_Malloc(size_t n,int tag,void *user){return calloc(1,n);}
// The native thinker loop still reads next after unlinking a removed node.
static void Z_Free(void *p){}
static void S_StartSound(mobj_t *p,int id){if(inThinkers)printf("sound,%d,%d,%d\\n",leveltime,*p,id);}
static boolean P_ChangeSector(sector_t *s,boolean crush){return false;}
static int P_Random(void){abort();}
static boolean twoSided(int s,int i){return sectors[s].lines[i]->flags & ML_TWOSIDED;}
static side_t *getSide(int s,int i,int side){return &sides[sectors[s].lines[i]->sidenum[side]];}
static sector_t *getSector(int s,int i,int side){return getSide(s,i,side)->sector;}
void P_ActivateInStasis(int tag);void P_AddActivePlat(plat_t *p);void P_RemoveActivePlat(plat_t *p);
${["P_InitThinkers","P_AddThinker","P_RemoveThinker","P_RunThinkers"].map(n=>extractFunction(scheduler,"void",n)).join("\n")}
${extractFunction(spec,"sector_t\\*","getNextSector")}
${extractFunction(spec,"int","P_FindSectorFromLineTag")}
${["P_FindLowestFloorSurrounding","P_FindHighestFloorSurrounding","P_FindNextHighestFloor","P_FindLowestCeilingSurrounding"].map(n=>extractFunction(spec,"fixed_t",n)).join("\n")}
${extractFunction(floors,"result_e","T_MovePlane")}
${extractFunction(floors,"void","T_MoveFloor")}
${extractFunction(floors,"int","EV_DoFloor")}
${extractFunction(floors,"int","EV_BuildStairs")}
${plats.slice(activePlats)}
static int movers(void){int n=0;for(int i=0;i<numsectors;i++)n+=sectors[i].specialdata!=NULL;return n;}
static int platforms(void){int n=0;for(int i=0;i<MAXPLATS;i++)n+=activeplats[i]!=NULL;return n;}
int main(void){
    const int geometry[][4]={${lines.map(line=>"{"+line.join(",")+"}").join(",")}};
    P_InitThinkers();
    for(int s=0;s<numsectors;++s){
        sides[s].sector=&sectors[s];sectors[s].soundorg=s;
        sectors[s].floorpic=s>0 && s<${platform};sectors[s].ceilingheight=1800*FRACUNIT;
        sectors[s].tag=s==${platform}?8:(s?7:0);
    }
    for(int i=0;i<${lines.length};++i){
        const int *g=geometry[i];line_t *l=&lines[i];
        *l=(line_t){&sectors[g[0]],&sectors[g[1]],g[3],ML_TWOSIDED,{g[0],g[1]},g[2]};
        l->frontsector->lines[l->frontsector->linecount++]=l;
        l->backsector->lines[l->backsector->linecount++]=l;
    }
    for(leveltime=0;leveltime<=${finalTic};++leveltime){
        if(leveltime==0 || leveltime==${stairsTic}){
            if(movers() || platforms())abort();
            for(int s=0;s<numsectors;++s){
                sectors[s].floorheight=(s==1||s==${platform}?0:s==0?8:16*s-4*(1+s%3))*FRACUNIT;
                if(leveltime && s>0 && s<${platform})sectors[s].tag=s==1?9:0;
            }
            if(leveltime){EV_BuildStairs(&lines[2],turbo16);}else{
                EV_DoFloor(&lines[0],raiseFloor24);EV_DoPlat(&lines[1],raiseToNearestAndChange,0);
            }
        }
        printf("start,%d,%d,%d\\n",leveltime,movers(),platforms());
        inThinkers=1;P_RunThinkers();inThinkers=0;
        for(int s=1;s<numsectors;++s)printf("sector,%d,%d,%d,%d\\n",leveltime,s,sectors[s].floorheight,sectors[s].specialdata!=NULL);
        printf("end,%d,%d,%d,0,1\\n",leveltime,movers(),platforms());
    }
    return 0;
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fno-strict-aliasing", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(line => {
        const [tag,...values] = line.split(",");
        return [tag,...values.map(Number)];
    });
}
function verify(rows) {
    const start = tic => rows.find(r => r[0] === "start" && r[1] === tic).slice(2);
    assert.deepEqual(start(0), [count + 1, 1], "one trigger registers 70 ordinary floors while the separate platform can still start");
    assert.deepEqual(start(stairsTic), [count, 0], "one tagged seed follows the same-flat staircase through all 70 sectors");
    for (const tic of [0, 16, stairsTic-1, stairsTic, finalTic]) {
        for (const row of rows.filter(r => r[0] === "sector" && r[1] === tic)) {
            const s = row[2], age = tic - stairsTic + 1;
            const ordinary = s === platform ? Math.min(8, (tic+1)/2) : initialHeight(s) + Math.min(24,tic+1);
            const stair = s === platform ? 0 : Math.min(16*s, initialHeight(s) + 4*age);
            const owned = tic < stairsTic ? tic < (s === platform ? 16 : 24)
                : s !== platform && initialHeight(s) + 4*age <= 16*s;
            assert.deepEqual(row.slice(3), [(tic < stairsTic ? ordinary : stair)*unit, Number(owned)], `sector ${s} tic ${tic}`);
        }
    }
    assert.equal(rows.filter(r => r[0] === "sector").length, (finalTic+1)*platform);
}
try {
    const native = values.upstream ? nativeRows(path.resolve(root, values.upstream)) : null;
    if (native) verify(native);
    const actual = fletcherRows();
    verify(actual);
    if (native) {
        assert.equal(actual.length, native.length);
        for (const [i,row] of actual.entries()) assert.deepEqual(row, native[i], `floor trace row ${i}`);
    }
    console.log(`Passed ${count} simultaneous tagged floors, one concurrent platform, and a ${count}-sector stair chain; checked ${actual.length} rows.`);
} finally {
    rmSync(scratch,{recursive:true,force:true});
}
