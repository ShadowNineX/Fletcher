// Tagged doors from the walk/use/shoot dispatchers through retirement and reactivation.
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
const scratch = mkdtempSync(path.join(temp, "fletcher-door-dispatch-"));
const walk = [2,86,3,75,4,90,16,76,108,105,109,106,110,107];
const press = [29,63,50,42,103,61,111,114,112,115,113,116];
const ids = [...walk, ...press, 46];

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

function writeRooms() {
    // A control room and adjacent door sector. Three test lines share its
    // switch sidedef: primary and sibling tag 7, third line with absent tag 99.
    const sides = Buffer.alloc(60), sectors = Buffer.alloc(52);
    sides.write("SW1BRCOM", 4);
    sides.writeInt16LE(1, 58);
    sectors.writeInt16LE(20, 2);
    sectors.writeInt16LE(8, 28);
    sectors.writeInt16LE(7, 50);
    const tables = [
        ["Vertices", 8, words([-96,-32,-96,32,-64,-32,-64,32,-32,-32,-32,32,0,-32,0,32])],
        ["Sides", 2, sides], ["Sectors", 2, sectors], ["Nodes", 0, Buffer.alloc(0)],
        ["Segs", 1, words([0,1,0,0,0,0])], ["Subsectors", 1, words([1,0])],
    ];
    let offset = 12;
    const fields = tables.map(([name, count, bytes]) => {
        const field = `${name}: wad.Lump{Valid: true, Count: ${count}, Offset: ${offset}}`;
        offset += bytes.length;
        return field;
    });
    const lines = ids.map(action => words([0,1,4,action,7,0,0, 2,3,4,action,7,0,0,
        4,5,4,action,99,0,0, 7,6,4,0,0,0,1]));
    const textures = Buffer.alloc(82);
    textures.writeInt32LE(3);
    ["DUMMY","SW1BRCOM","SW2BRCOM"].forEach((name, i) => {
        const pos = 16 + 22 * i;
        textures.writeInt32LE(pos, 4 + 4 * i);
        textures.write(name, pos);
        textures.writeInt16LE(1, pos + 12);
        textures.writeInt16LE(1, pos + 14);
    });
    const lumps = [["ROOMS", Buffer.concat([...tables.map(table => table[2]), ...lines])], ["PNAMES", Buffer.alloc(4)], ["TEXTURE1", textures]];
    const directory = lumps.reduce((sum, [, data]) => sum + data.length, 12);
    const file = Buffer.alloc(directory + 16 * lumps.length);
    file.write("PWAD"); file.writeInt32LE(lumps.length, 4); file.writeInt32LE(directory, 8);
    let cursor = 12;
    for (const [i, [name, data]] of lumps.entries()) {
        const entry = directory + 16 * i;
        file.writeInt32LE(cursor, entry); file.writeInt32LE(data.length, entry + 4); file.write(name, entry + 8);
        data.copy(file, cursor); cursor += data.length;
    }
    writeFileSync(path.join(scratch, "ROOMS.WAD"), file);
    return { fields: fields.join(",\n"), lines: offset };
}

function compiled(rows) {
    const room = writeRooms(), entry = path.join(scratch, "main.flt"), output = path.join(scratch, "map.json");
    writeFileSync(entry, `package main
import "play"
import "wad"
const Room = readFile("ROOMS.WAD")
map "Tagged door dispatch" {
    screen at (0, 0) size (1, 1) with {style = "solid", hold = true, slice = true}
    register saved play.LevelSpecials = play.LevelSpecials{}
    register trial int = 0
    register phase int = 0
    register clock int = 0
    tick {
        base := wad.BspLevel{Valid: true, File: Room, ${room.fields},
            Lines: wad.Lump{Valid: true, Count: 4, Offset: ${room.lines} + 56 * trial}}
        state := saved
        state.Doors = state.Doors.ClearSounds()
        live := state.ApplyTo(base)
        used, valid := -1, true
        if phase == 4 {
            moved := play.TickLevelMoversAt(base, wad.BlockMapInfo{}, state, play.MapActor{}, clock)
            state, valid = moved.State, moved.Valid
            state.Doors = state.Doors.TickButtonTimers(base)
        } else {
            line := 0
            if phase == 0 { line = 2 }
            if phase == 3 || phase == 6 { line = 1 }
            player := phase != 1
            if trial < ${walk.length} {
                if player { state = play.CrossLevelSpecial(live, state, line) } else { state = play.CrossMonsterLine(live, state, line) }
            } else if trial < ${walk.length + press.length} {
                response := play.UseActorLine(live, state, line, false, player, play.PlayerInventory{})
                state, used = response.State, 0
                if response.Used { used = 1 }
            } else { state = play.ShootLevelSpecial(live, state, line, player) }
        }
        live = state.ApplyTo(base)
        door := state.Doors.EntryAt(state.Doors.First()).State
        wait := 0
        if door.Active && door.Direction == 0 { wait = door.Countdown }
        buttons := state.Doors.Switches
        log(trial, phase, clock, used, valid, live.LineAt(0).Action, live.LineAt(1).Action,
            live.LineAt(2).Action, state.Doors.Count, live.SectorHeightsAt(1).Ceiling, door.Mode,
            door.Direction, door.Top, door.Speed, wait, buttons.ButtonCount, buttons.Buttons[0].Tics,
            buttons.Buttons[1].Tics, buttons.Buttons[2].Tics, live.SideMaterialAt(live.LineFrontSide(0)).Upper.Low == 0x42325753)
        if phase == 6 {
            next trial = trial + 1
            next phase = 0
            next clock = 0
            next saved = play.LevelSpecials{}
        } else {
            next saved = state
            if phase == 4 { next clock = clock + 1 }
            if phase != 4 || state.Doors.Count == 0 { next phase = phase + 1 }
        }
    }
}`);
    run("dotnet", [cli, "build", entry, "--package-root", path.join(root, "examples/doom-engine"), "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let host = 0; host < 100000 && sim.logs.length < rows.length; ++host) {
        const start = sim.logs.length;
        sim.step();
        for (let i = start; i < sim.logs.length; ++i) {
            const expected = rows[i];
            assert.deepEqual(Array.from(sim.logs[i], Number), expected,
                `door ${ids[expected[0]]}, phase ${expected[1]}, thinker tic ${expected[2]}`);
        }
    }
    assert.equal(sim.logs.length, rows.length, "all sliced door traces reached the final replay");
}

function native() {
    const read = file => readFileSync(path.join(upstream, file), "utf8").replaceAll("\r\n", "\n");
    const spec = read("animated-p_spec.c"), switches = read("switch-p_switch.c"), doors = read("door-p_doors.c");
    const use = extractFunction(switches, "boolean", "P_UseSpecialLine");
    const cross = extractFunction(spec, "void", "P_CrossSpecialLine"), shoot = extractFunction(spec, "void", "P_ShootSpecialLine");
    const other = [...new Set((use + cross + shoot).match(/\b(?:EV_|G_)[A-Za-z]+\b/g))].filter(name => name !== "EV_DoDoor");
    const timer = extractFunction(spec, "void", "P_UpdateSpecials").match(/\/\/\s*DO BUTTONS\s*([\s\S]*)\}\s*$/)?.[1];
    assert.ok(timer?.includes("sizeof(button_t)"), "native button expiry loop");
    const source = path.join(scratch, "doors.c"), exe = path.join(scratch, process.platform === "win32" ? "doors.exe" : "doors");
    writeFileSync(source, `#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
enum {false,true,FRACUNIT=65536,VDOORSPEED=2*FRACUNIT,VDOORWAIT=150,MAXINT=INT_MAX,
    ML_TWOSIDED=4,ML_SECRET=32,PU_LEVSPEC=51,MAXBUTTONS=16,BUTTONTIME=35};
enum {MT_ROCKET=33,MT_PLASMA,MT_BFG,MT_TROOPSHOT=31,MT_HEADSHOT,MT_BRUISERSHOT=16};
enum {sfx_doropn,sfx_dorcls,sfx_bdopn,sfx_bdcls,sfx_swtchn,sfx_swtchx};
typedef int fixed_t,boolean;
typedef enum {ok,crushed,pastdest} result_e;
typedef enum {normal,close30ThenOpen,close,open,raiseIn5Mins,blazeRaise,blazeOpen,blazeClose} vldoor_e;
typedef enum {top,middle,bottom} bwhere_e;
typedef struct { int type,player; } mobj_t;
typedef struct sector_s sector_t;
typedef struct { sector_t *frontsector,*backsector; int special,tag,flags,sidenum[2]; } line_t;
struct sector_s { int floorheight,ceilingheight,tag,linecount; line_t *lines[4]; mobj_t soundorg; void *specialdata; };
typedef struct { int toptexture,midtexture,bottomtexture; } side_t;
typedef void (*actionf_p1)(void *);
typedef struct { union {actionf_p1 acp1;} function; } thinker_t;
typedef struct { thinker_t thinker;sector_t *sector;vldoor_e type;int speed,direction,topheight,topwait,topcountdown; } vldoor_t;
typedef struct { line_t *line;bwhere_e where;int btimer,btexture;mobj_t *soundorg; } button_t;
static int numsectors=2,numswitches=1,switchlist[]={1,2};
static line_t lines[4];static sector_t sectors[2];static side_t sides[2];static button_t buttonlist[MAXBUTTONS];static vldoor_t mover;
static void *Z_Malloc(size_t size,int tag,void *user) {
    assert(size==sizeof(mover) && !sectors[1].specialdata); memset(&mover,0,sizeof(mover));return &mover;
}
static void P_AddThinker(thinker_t *t) { assert(t==&mover.thinker); }
static void P_RemoveThinker(thinker_t *t) { assert(t==&mover.thinker); }
static void S_StartSound(mobj_t *origin,int sound) {}
static void I_Error(char *message) { fprintf(stderr,"%s\\n",message);abort(); }
static int P_ChangeSector(sector_t *sector,int crush) { return 0; } // Empty door sector.
${extractFunction(spec,"sector_t\\*","getNextSector")}
${extractFunction(spec,"fixed_t","P_FindLowestCeilingSurrounding")}
${extractFunction(spec,"int","P_FindSectorFromLineTag")}
${extractFunction(read("door-p_floor.c"),"result_e","T_MovePlane")}
${extractFunction(doors,"void","T_VerticalDoor")}
${extractFunction(doors,"int","EV_DoDoor")}
${extractFunction(switches,"void","P_StartButton")}
${extractFunction(switches,"void","P_ChangeSwitchTexture")}
${other.map(n=>`#define ${n}(...) (abort(),0)`).join("\n")}
${use}
${cross}
${shoot}
static void tickButtons(void) { int i; ${timer} }
static void setup(int action) {
    memset(buttonlist,0,sizeof(buttonlist));
    sectors[0]=(sector_t){.ceilingheight=20*FRACUNIT,.linecount=4,.lines={lines,lines+1,lines+2,lines+3}};
    sectors[1]=(sector_t){.ceilingheight=8*FRACUNIT,.tag=7,.linecount=1,.lines={lines+3}};
    sides[0].toptexture=1;
    for (int i=0;i<4;i++) {
        int back=i==3;
        lines[i]=(line_t){.frontsector=sectors,.backsector=sectors+back,.flags=ML_TWOSIDED,.sidenum={0,back},
            .special=i<3?action:0,.tag=i==2?99:i<2?7:0};
    }
}
int main(void) {
    const int ids[]={${ids}};
    for (int trial=0;trial<${ids.length};trial++) {
        setup(ids[trial]);
        int clock=0;
        for (int phase=0;phase<=6;) {
            int used=-1;
            if (phase==4) {
                assert(clock<1100 && sectors[1].specialdata);
                T_VerticalDoor(sectors[1].specialdata);
                tickButtons();
            } else {
                int index=phase==0?2:phase==3||phase==6?1:0;
                mobj_t actor={.type=1,.player=phase!=1};
                if (trial<${walk.length}) P_CrossSpecialLine(index,0,&actor);
                else if (trial<${walk.length+press.length}) {
                    // PTR_UseTraverse only dispatches nonzero line specials.
                    used=lines[index].special && P_UseSpecialLine(&actor,&lines[index],0);
                } else P_ShootSpecialLine(&actor,&lines[index]);
            }
            vldoor_t *d=sectors[1].specialdata; int buttons=0;
            for (int i=0;i<MAXBUTTONS;i++) buttons+=buttonlist[i].btimer!=0;
            printf("%d,%d,%d,%d,1,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\\n",
                trial,phase,clock,used,lines[0].special,lines[1].special,lines[2].special,!!d,sectors[1].ceilingheight,
                d?d->type:0,d?d->direction:0,d?d->topheight:0,d?d->speed:0,d&&d->direction==0?d->topcountdown:0,
                buttons,buttonlist[0].btimer,buttonlist[1].btimer,buttonlist[2].btimer,sides[0].toptexture==2);
            if (phase==4) clock++;
            if (phase!=4 || !d) phase++;
        }
    }
    return 0;
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(row => row.split(",").map(Number));
}

try {
    const rows = native();
    assert.equal(rows.filter(row => row[1] === 6).length, ids.length, "replay every special after its door retires");
    const gun = rows.filter(r => ids[r[0]] === 46);
    assert.deepEqual([gun[0][8], gun[0][15], gun[1][8], gun[1][15], gun[3][15]], [0,1,1,2,3],
        "the gun switch flips on a missing tag, allows monster impact, and starts another button on a busy sibling");
    assert.equal(rows.filter(r => ids[r[0]] === 16 && r[1] === 4 && r[8] === 1 && r[11] === 0).length, 1050,
        "close-then-open runs its full 30-second wait");
    compiled(rows);
    console.log(`Matched ${rows.length} tagged door snapshots for ${walk.length} walk, ${press.length} use and gun special 46 with pinned Doom C.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-door-dispatch-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
