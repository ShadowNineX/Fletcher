// Exercise ordinary floor specials from the use/cross/shoot dispatchers to thinker retirement.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const upstream = path.resolve(root, values.upstream ?? "artifacts/doom-upstream");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-line-floors-"));
const walk = [5, 91, 19, 83, 36, 98, 37, 84, 38, 82, 56, 94, 58, 92, 59, 93, 119, 128, 130, 129];
const press = [18, 69, 23, 60, 55, 65, 71, 70, 101, 64, 102, 45, 131, 132];
const cases = [...walk, ...press, 24];
const descending = new Set([19, 83, 36, 98, 37, 84, 38, 82, 23, 60, 71, 70, 102, 45]);
const last = 32;

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 60000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function words(values) {
    const bytes = Buffer.alloc(2 * values.length);
    values.forEach((value, i) => bytes.writeInt16LE(value, i * 2));
    return bytes;
}

function records() {
    // Two independent triggers in the control sector, then its portal to the tagged
    // sector and the tagged sector's other neighbor. No switch textures or actors.
    const bytes = [Buffer.from("PWAD"), Buffer.alloc(8)], decl = [];
    let pos = 12;
    function lump(name, count, data) {
        decl.push(`${name}: wad.Lump{Valid: true, Count: ${count}, Offset: ${pos}}`);
        bytes.push(data);
        pos += data.length;
    }
    lump("Vertices", 8, words([-64,-32,-64,32,-32,-32,-32,32,0,-32,0,32,32,-32,32,32]));
    const sides = Buffer.alloc(3 * 30);
    for (let s = 0; s < 3; ++s) sides.writeInt16LE(s, s * 30 + 28);
    lump("Sides", 3, sides);
    lump("Segs", 1, words([0,1,0,0,0,0]));
    lump("Subsectors", 1, words([1,0]));
    lump("Nodes", 0, Buffer.alloc(0));
    const sectorsStart = pos;
    for (const middle of [16, 32]) {
        const sectors = Buffer.alloc(3 * 26);
        for (const [s, floor] of [8, middle, 20].entries()) {
            sectors.writeInt16LE(floor, s * 26);
            sectors.writeInt16LE(s === 0 ? 40 : 64, s * 26 + 2);
            sectors.write(["MODEL", "START", "OTHER"][s], s * 26 + 4);
            sectors.writeInt16LE([7, 5, 0][s], s * 26 + 22);
            sectors.writeInt16LE(s === 1 ? 23 : 0, s * 26 + 24);
        }
        bytes.push(sectors);
        pos += sectors.length;
    }
    for (const action of cases) {
        bytes.push(words([0,1,4,action,23,0,0, 2,3,4,action,23,0,0, 5,4,4,0,0,0,1, 7,6,4,0,0,1,2]));
    }
    writeFileSync(path.join(scratch, "ROOM.BIN"), Buffer.concat(bytes));
    return { decl: decl.join(",\n"), sectorsStart, linesStart: pos };
}

function compiled() {
    const geo = records(), entry = path.join(scratch, "main.flt"), output = path.join(scratch, "level.json");
    writeFileSync(entry, `package main
import "play"
import "wad"
const Room = readFile("ROOM.BIN")
const sectorOffsets = [${cases.length}]int{${cases.map(id => geo.sectorsStart + (descending.has(id) ? 78 : 0)).join(", ")}}
map "Ordinary floor dispatch" {
    screen at (0, 0) size (1, 1) with {style = "solid", hold = true, slice = true}
    register saved play.LevelSpecials = play.LevelSpecials{}
    register trial int = 0
    register phase int = 0
    tick {
        base := wad.BspLevel{Valid: true, File: Room, ${geo.decl},
            Sectors: wad.Lump{Valid: true, Count: 3, Offset: sectorOffsets[trial]},
            Lines: wad.Lump{Valid: true, Count: 4, Offset: ${geo.linesStart} + trial * 56}}
        state := saved
        live := state.ApplyTo(base)
        used, valid := -1, true
        if phase <= 2 || phase >= 31 {
            line := 0
            if phase == 2 || phase == 32 { line = 1 }
            player := phase != 0
            if trial < ${walk.length} {
                if player { state = play.CrossLevelSpecial(live, state, line) } else { state = play.CrossMonsterLine(live, state, line) }
            } else if trial < ${walk.length + press.length} {
                response := play.UseActorLine(live, state, line, false, player, play.PlayerInventory{})
                state, used = response.State, 0
                if response.Used { used = 1 }
            } else { state = play.ShootLevelSpecial(live, state, line, player) }
        } else {
            ticked := play.TickLevelMoversAt(base, wad.BlockMapInfo{}, state, play.MapActor{}, phase - 3)
            state, valid = ticked.State, ticked.Valid
        }
        live = state.ApplyTo(base)
        motion := state.Floors.EntryAt(state.Floors.FindSector(1)).Motion
        log(trial, phase, used, valid, live.LineAt(0).Action, live.LineAt(1).Action, state.Floors.Count,
            motion.Mode, motion.Direction, motion.Crush, motion.Speed, motion.Destination,
            live.SectorHeightsAt(1).Floor, live.FloorNameAt(1).Low & 255, live.SectorSpecial(1))
        if phase == ${last} {
            next phase = 0
            next trial = trial + 1
            next saved = play.LevelSpecials{}
        } else { next phase = phase + 1; next saved = state }
    }
}`);
    run("dotnet", [cli, "build", entry, "--package-root", path.join(root, "examples/doom-engine"), "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    const total = cases.length * (last + 1);
    for (let host = 0; host < 60000 && sim.logs.length < total; ++host) sim.step();
    assert.equal(sim.logs.length, total, "sliced Logic Arrows floor fixture completed");
    return sim.logs.map(row => Array.from(row, Number));
}

function native() {
    const read = name => readFileSync(path.join(upstream, name), "utf8").replaceAll("\r\n", "\n");
    const spec = read("animated-p_spec.c"), switches = read("switch-p_switch.c"), floors = read("door-p_floor.c");
    const use = extractFunction(switches, "boolean", "P_UseSpecialLine");
    const cross = extractFunction(spec, "void", "P_CrossSpecialLine"), shoot = extractFunction(spec, "void", "P_ShootSpecialLine");
    const unused = [...new Set((use + cross + shoot).match(/\b(?:EV_|G_)[A-Za-z]+\b/g))].filter(n => n !== "EV_DoFloor");
    const source = path.join(scratch, "floor.c"), exe = path.join(scratch, process.platform === "win32" ? "floor.exe" : "floor");
    writeFileSync(source, `#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef int fixed_t,boolean;
enum {false,true, FRACUNIT=65536,FLOORSPEED=FRACUNIT, MAXINT=INT_MAX,PU_LEVSPEC=51,
      MAX_ADJOINING_SECTORS=20,ML_SECRET=32,ML_TWOSIDED=4,
      sfx_stnmov,sfx_pstop,sfx_swtchn,sfx_swtchx,top,middle,bottom,BUTTONTIME=35};
enum { MT_ROCKET=33,MT_PLASMA,MT_BFG,MT_TROOPSHOT=31,MT_HEADSHOT,MT_BRUISERSHOT=16 };
typedef enum {ok,crushed,pastdest} result_e;
typedef enum {lowerFloor,lowerFloorToLowest,turboLower,raiseFloor,raiseFloorToNearest,
    raiseToTexture,lowerAndChange,raiseFloor24,raiseFloor24AndChange,raiseFloorCrush,raiseFloorTurbo,donutRaise,raiseFloor512} floor_e;
typedef struct { int player,type; } mobj_t;
typedef struct sector_s sector_t;
typedef struct { int tag,special,flags,sidenum[2]; sector_t *frontsector,*backsector; } line_t;
struct sector_s { fixed_t floorheight,ceilingheight; int special,tag,floorpic,linecount; mobj_t soundorg;
    line_t *lines[4]; void *specialdata; };
typedef struct { sector_t *sector; int toptexture,midtexture,bottomtexture; } side_t;
typedef void (*actionf_p1)(void*);
typedef struct { struct { actionf_p1 acp1; } function; } thinker_t;
typedef struct { thinker_t thinker; sector_t *sector; floor_e type; int direction,newspecial,texture,crush;
    fixed_t floordestheight,speed; } floormove_t;
typedef struct { mobj_t *soundorg; } button_t;
static sector_t sectors[3]; static side_t sides[3]; static line_t lines[4];
static int leveltime,numsectors=3,textureheight[]={FRACUNIT},numswitches=1,switchlist[]={1,2};
static button_t buttonlist[1];
static floormove_t mover;
static void *Z_Malloc(size_t size,int tag,void *user) {
    assert(size==sizeof(mover) && !sectors[1].specialdata);
    memset(&mover,0,sizeof(mover)); return &mover;
}
static void P_AddThinker(thinker_t *t) { assert(t==&mover.thinker); }
static void P_RemoveThinker(thinker_t *t) { assert(t==&mover.thinker); }
static void S_StartSound(mobj_t *origin,int sound) {}
static void P_StartButton(line_t *line,int where,int tex,int timer) { abort(); }
static int P_ChangeSector(sector_t *sector,int crush) { return 0; } // Empty moving sector.
${extractFunction(spec,"sector_t\\*","getNextSector")}
${extractFunction(spec,"int","P_FindSectorFromLineTag")}
${extractFunction(spec,"side_t\\*","getSide")}
${extractFunction(spec,"sector_t\\*","getSector")}
${extractFunction(spec,"int","twoSided")}
${["P_FindHighestFloorSurrounding","P_FindLowestFloorSurrounding","P_FindNextHighestFloor","P_FindLowestCeilingSurrounding"].map(n=>extractFunction(spec,"fixed_t",n)).join("\n")}
${extractFunction(floors,"result_e","T_MovePlane")}
${extractFunction(floors,"void","T_MoveFloor")}
${extractFunction(floors,"int","EV_DoFloor")}
${extractFunction(switches,"void","P_ChangeSwitchTexture")}
${unused.map(n=>`#define ${n}(...) (abort(),0)`).join("\n")}
${use}
${cross}
${shoot}
static void setup(int special,int targetFloor) {
    const int front[4]={0,0,0,1},back[4]={0,0,1,2};
    memset(sectors,0,sizeof(sectors));
    for (int s=0;s<3;s++) {
        sectors[s].floorheight=(s==0?8:s==1?targetFloor:20)*FRACUNIT;
        sectors[s].ceilingheight=(s==0?40:64)*FRACUNIT;
        sectors[s].special=(int[]){7,5,0}[s];
        sectors[s].floorpic="MSO"[s]; sectors[s].tag=s==1?23:0; sides[s].sector=&sectors[s];
    }
    for (int i=0;i<4;i++) {
        sector_t *a=&sectors[front[i]],*b=&sectors[back[i]];
        lines[i]=(line_t){.tag=i<2?23:0,.special=i<2?special:0,.flags=ML_TWOSIDED,
            .sidenum={front[i],back[i]},.frontsector=a,.backsector=b};
        a->lines[a->linecount++]=&lines[i]; if (a!=b) b->lines[b->linecount++]=&lines[i];
    }
}
int main(void) {
    const int ids[]={${cases}},initialFloors[]={${cases.map(id => descending.has(id) ? 32 : 16)}};
    // Normalize native floor_e values to the port's public FloorState.Mode values.
    const int modes[]={[lowerFloor]=1,[lowerFloorToLowest]=2,[turboLower]=3,[raiseFloor]=4,
        [raiseFloorCrush]=5,[raiseFloorTurbo]=6,[raiseFloorToNearest]=7,[raiseFloor24]=8,
        [raiseFloor24AndChange]=10,[lowerAndChange]=12};
    for (int trial=0;trial<${cases.length};trial++) {
        setup(ids[trial],initialFloors[trial]);
        for (int phase=0;phase<=${last};phase++) {
            int used=-1;
            if (phase<=2 || phase>=31) {
                int index=phase==2 || phase==32;
                mobj_t actor={.player=phase!=0};
                if (trial<${walk.length}) P_CrossSpecialLine(index,0,&actor);
                else if (trial<${walk.length + press.length}) {
                    // PTR_UseTraverse calls P_UseSpecialLine only for live special lines.
                    used=lines[index].special && P_UseSpecialLine(&actor,&lines[index],0);
                } else P_ShootSpecialLine(&actor,&lines[index]);
            } else {
                leveltime=phase-3;
                if (sectors[1].specialdata) T_MoveFloor(sectors[1].specialdata);
            }
            floormove_t *f=sectors[1].specialdata;
            printf("%d,%d,%d,1,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\\n",
                trial,phase,used,lines[0].special,lines[1].special,!!f,f?modes[f->type]:0,
                f?f->direction:0,f?f->crush:0,f?f->speed:0,f?f->floordestheight:0,
                sectors[1].floorheight,sectors[1].floorpic,sectors[1].special);
        }
    }
    return 0;
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(row => row.split(",").map(Number));
}

try {
    const expected = native(), observed = compiled();
    assert.equal(expected.length, cases.length * (last + 1));
    for (const [i, row] of expected.entries()) {
        const [trial, phase] = row, action = cases[trial];
        assert.deepEqual(observed[i], row, `special ${action}, phase ${phase}`);
        if (phase === 0 || phase === 30) assert.equal(row[6], 0, "no owned floor before use or after retirement");
        if (phase === 1 || phase === 2) assert.equal(row[6], 1, "the first activation owns this sector");
    }
    console.log(`Matched ${expected.length} floor snapshots for ${walk.length} walk, ${press.length} use and one shoot special with pinned Doom C.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-line-floors-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
