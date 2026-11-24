// Compare simultaneous tagged doors, ordered retirement, and timed startup with linuxdoom.
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
const scratch = mkdtempSync(path.join(os.tmpdir(), "fletcher-door-capacity-"));
const count = 72, unit = 65536;
const sectors = Array.from({ length: count }, (_, i) => i + 1);
const commands = [86, 0, 0, 0, 107, 106, 106, 0, 107, 0, 106, 0];
const timedTic = commands.length;

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 60000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}
function words(...fields) {
    const b = Buffer.alloc(fields.length * 2);
    fields.forEach((v, i) => b.writeUInt16LE(v & 65535, i * 2));
    return b;
}
function room() {
    const sides = Buffer.alloc((count + 1) * 30), chambers = Buffer.alloc((count + 1) * 26);
    chambers.writeInt16LE(12, 2);
    for (const s of sectors) {
        sides.writeInt16LE(s, s * 30 + 28);
        chambers.writeInt16LE(s % 3, s * 26);
        chambers.writeInt16LE(4 + s % 4, s * 26 + 2);
        chambers.writeInt16LE(7, s * 26 + 24);
    }
    const timed = Buffer.from(chambers);
    for (const s of sectors) timed.writeInt16LE(s % 2 ? 10 : 14, s * 26 + 22);
    // Each door borders the common room. Its 12-unit ceiling gives an 8-unit door top.
    const lines = sectors.map(s => words(0, 1, 4, [86, 107, 106][s - 1] ?? 0, 7, 0, s));
    const records = [
        ["Vertices", 2, words(0, -32, 0, 32)], ["Sides", count + 1, sides], ["Sectors", count + 1, chambers],
        ["Lines", count, Buffer.concat(lines)], ["Nodes", 0, Buffer.alloc(0)],
        ["Segs", 1, words(0, 1, 0, 0, 0, 0)], ["Subsectors", 1, words(1, 0)],
    ];
    let offset = 0;
    const fields = records.map(([field, size, bytes]) => {
        const value = `${field}: wad.Lump{Valid: true, Count: ${size}, Offset: ${offset}}`;
        offset += bytes.length;
        return value;
    }).join(",\n");
    writeFileSync(path.join(scratch, "ROOM.BIN"), Buffer.concat([...records.map(r => r[2]), timed]));
    return { fields, timed: `wad.Lump{Valid: true, Count: ${count + 1}, Offset: ${offset}}` };
}
function fletcherRows() {
    const geometry = room(), entry = path.join(scratch, "main.flt"), output = path.join(scratch, "map.json");
    writeFileSync(entry, `package main
import "play"
import "wad"
const Room = readFile("ROOM.BIN")
const Commands = [${commands.length}]int{${commands.join(",")}}
map "Tagged and timed doors" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register saved play.LevelSpecials = play.LevelSpecials{}
    register tic int = 0
    tick {
        base := wad.BspLevel{Valid: true, File: Room, ${geometry.fields}}
        state := saved
        if tic == ${timedTic} {
            base.Sectors = ${geometry.timed}
            state = play.LevelSpecials{Doors: play.LoadTimedDoors(base)}
        } else {
            action := Commands[tic]
            line := -1
            if action == 86 { line = 0 }
            if action == 107 { line = 1 }
            if action == 106 { line = 2 }
            if line >= 0 { state = play.CrossLevelSpecial(state.ApplyTo(base), state, line) }
        }
        log("start", tic, state.Doors.Count)
        for i := range state.Doors.Sounds.Count {
            cue := state.Doors.Sounds.At(i)
            log("sound", tic, 0, cue.Sector, cue.Id)
        }
        state.Doors = state.Doors.ClearSounds()
        moved := play.TickLevelMoversAt(base, wad.BlockMapInfo{}, state, play.MapActor{Height: 4 << 16}, tic)
        state = moved.State
        for i := range moved.Sounds.Count {
            cue := moved.Sounds.At(i)
            log("sound", tic, 1, cue.Sector, cue.Id)
        }
        live := state.ApplyTo(base)
        for i := range ${count} {
            s := i + 1
            log("sector", tic, s, live.SectorHeightsAt(s).Ceiling, state.MoverOccupied(s), live.SectorSpecial(s))
        }
        log("end", tic, state.Doors.Count, moved.Valid)
        next saved = state
        next tic = tic + 1
    }
}`);
    run("dotnet", [cli, "build", entry, "--package-root", path.join(root, "examples", "doom-engine"), "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    const rows = [];
    for (let host = 0; host < 20000; ++host) {
        const first = sim.logs.length;
        sim.step();
        for (const [tag, ...fields] of sim.logs.slice(first)) {
            const row = [tag, ...fields.map(Number)];
            rows.push(row);
            if (tag === "start" && row[1] === 0) assert.equal(row[2], count, "one repeatable trigger must register every tagged door");
            if (tag === "end" && row[1] === 4) sim.roundTripScriptState();
            if (tag === "end" && row[1] === timedTic) return rows;
        }
    }
    assert.fail("sliced door simulation exceeded its host budget");
}

function nativeRows(directory) {
    const read = name => readFileSync(path.join(directory, name), "utf8").replaceAll("\r\n", "\n");
    const doors = read("door-p_doors.c"), specials = read("animated-p_spec.c"), scheduler = read("p_tick.c");
    const source = path.join(scratch, "doors.c"), exe = path.join(scratch, process.platform === "win32" ? "doors.exe" : "doors");
    writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
#include <limits.h>
#define FRACUNIT 65536
#define VDOORSPEED (2*FRACUNIT)
#define VDOORWAIT 150
#define MAXINT INT_MAX
enum {false,true,ML_TWOSIDED=4,PU_LEVSPEC=51,sfx_doropn=20,sfx_dorcls=21,sfx_bdopn=88,sfx_bdcls=89};
typedef int boolean,fixed_t,mobj_t;
typedef enum {ok,crushed,pastdest} result_e;
typedef enum {normal,close30ThenOpen,close,open,raiseIn5Mins,blazeRaise,blazeOpen,blazeClose} vldoor_e;
typedef void (*actionf_p1)(void *); typedef void (*actionf_v)(void);
typedef struct thinker_s {struct thinker_s *prev,*next; union {actionf_p1 acp1;actionf_v acv;} function;} thinker_t;
typedef struct sector_s sector_t;
typedef struct {int tag,flags;sector_t *frontsector,*backsector;} line_t;
struct sector_s {fixed_t floorheight,ceilingheight;int tag,special,soundorg,linecount;line_t *lines[${count}];void *specialdata;};
typedef struct {thinker_t thinker; vldoor_e type;sector_t *sector;fixed_t topheight,speed;int direction,topwait,topcountdown;} vldoor_t;
static thinker_t thinkercap;
static sector_t sectors[${count + 1}]; static line_t lines[${count}];
static int numsectors=${count + 1},leveltime,phase,nsounds,soundSector[${count}],soundId[${count}];
static void *Z_Malloc(size_t n,int tag,void *owner){return calloc(1,n);}
// P_RunThinkers reads next from a removed node even after calling Z_Free.
static void Z_Free(void *p){}
static boolean P_ChangeSector(sector_t *s,boolean crush){return false;}
static void S_StartSound(mobj_t *p,int id){if(nsounds==${count})abort(); soundSector[nsounds]=*p;soundId[nsounds++]=id;}
static void sounds(void){for(int i=0;i<nsounds;++i)printf("sound,%d,%d,%d,%d\\n",leveltime,phase,soundSector[i],soundId[i]);nsounds=0;}
${["P_InitThinkers","P_AddThinker","P_RemoveThinker","P_RunThinkers"].map(n=>extractFunction(scheduler,"void",n)).join("\n")}
${extractFunction(specials,"sector_t\\*","getNextSector")}
${extractFunction(specials,"int","P_FindSectorFromLineTag")}
${extractFunction(specials,"fixed_t","P_FindLowestCeilingSurrounding")}
${extractFunction(read("door-p_floor.c"),"result_e","T_MovePlane")}
${extractFunction(doors,"void","T_VerticalDoor")}
${extractFunction(doors,"int","EV_DoDoor")}
${extractFunction(doors,"void","P_SpawnDoorCloseIn30")}
${extractFunction(doors,"void","P_SpawnDoorRaiseIn5Mins")}
static int occupied(void){int n=0;for(int s=1;s<numsectors;++s)n+=sectors[s].specialdata!=NULL;return n;}
int main(void){
    const int cmd[]={${commands.join(",")}};
    P_InitThinkers();
    sectors[0].ceilingheight=12*FRACUNIT;
    for(int s=1;s<numsectors;++s){
        sector_t *sec=&sectors[s];sec->tag=7;sec->floorheight=s%3*FRACUNIT;
        sec->ceilingheight=(4+s%4)*FRACUNIT;sec->soundorg=s;
        line_t *line=&lines[s-1];*line=(line_t){7,ML_TWOSIDED,&sectors[0],sec};
        sec->lines[sec->linecount++]=line;sectors[0].lines[sectors[0].linecount++]=line;
    }
    for(leveltime=0;leveltime<=${timedTic};++leveltime){
        phase=0;
        if(leveltime==${timedTic}){
            P_InitThinkers();
            for(int s=1;s<numsectors;++s){
                sector_t *sec=&sectors[s];sec->ceilingheight=(4+s%4)*FRACUNIT;
                sec->special=s%2?10:14;
                if(sec->special==10)P_SpawnDoorCloseIn30(sec);else P_SpawnDoorRaiseIn5Mins(sec,s);
            }
        }else if(cmd[leveltime]){
            vldoor_e mode=cmd[leveltime]==86?open:cmd[leveltime]==107?blazeClose:blazeOpen;
            EV_DoDoor(&lines[0],mode);
        }
        printf("start,%d,%d\\n",leveltime,occupied());sounds();
        phase=1;P_RunThinkers();sounds();
        for(int s=1;s<numsectors;++s)printf("sector,%d,%d,%d,%d,%d\\n",leveltime,s,sectors[s].ceilingheight,sectors[s].specialdata!=NULL,sectors[s].special);
        printf("end,%d,%d,1\\n",leveltime,occupied());
    }
    return 0;
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fno-strict-aliasing", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(line => {
        const [tag, ...fields] = line.split(",");
        return [tag, ...fields.map(Number)];
    });
}
function verify(rows) {
    const sounds = (tic, phase) => rows.filter(r => r[0] === "sound" && r[1] === tic && r[2] === phase).map(r => r.slice(3));
    assert.deepEqual(sounds(0, 0), sectors.map(s => [s, 20]));
    assert.deepEqual(sounds(4, 0), sectors.map(s => [s, 89]));
    assert.deepEqual(sounds(4, 1), sectors.filter(s => s % 3).map(s => [s, 89]));
    assert.deepEqual(sounds(5, 0), sectors.filter(s => s % 3).map(s => [s, 88]));
    assert.deepEqual(sounds(5, 1), sectors.filter(s => s % 3 === 0).map(s => [s, 89]));
    assert.deepEqual(sounds(6, 0), sectors.filter(s => s % 3 === 0).map(s => [s, 88]));
    assert.deepEqual(sounds(10, 0), sectors.map(s => [s, 88]));
    for (const tic of [3, 7, 11, timedTic]) {
        const actual = rows.filter(r => r[0] === "sector" && r[1] === tic);
        assert.deepEqual(actual, sectors.map(s =>
            ["sector", tic, s, (tic === timedTic ? 4 + s % 4 : 8) * unit, Number(tic === timedTic), 0]));
    }
    const occupancy = [54, 18, 0, 0, 24, 0, 24, 0, 24, 0, 24, 0, 72];
    assert.deepEqual(rows.filter(r => r[0] === "end").map(r => r.slice(2)), occupancy.map(n => [n, 1]));
}
try {
    const native = values.upstream ? nativeRows(path.resolve(root, values.upstream)) : null;
    if (native) verify(native);
    const actual = fletcherRows();
    verify(actual);
    if (native) {
        assert.equal(actual.length, native.length);
        for (const [i, row] of actual.entries()) assert.deepEqual(row, native[i], `door trace row ${i}`);
    }
    console.log(`Passed ${count} simultaneous tagged doors, timed door startup, and ordered reactivation; checked ${actual.length} rows.`);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
