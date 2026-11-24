// Compare shared ceiling heights after completed doors and ceilings release their thinkers.
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
const scratch = mkdtempSync(path.join(os.tmpdir(), "fletcher-ceiling-history-"));
const sectors = 50, unit = 65536;
const switches = Array.from({ length: sectors }, (_, i) => [61, 43].map(action => ({ action, sector: i + 1 }))).flat();
switches.push({ action: 86, sector: 1 }, { action: 63, sector: 2 });
const floor = s => s ? 4 + s % 3 : 0;
const ceiling = s => s ? 12 + s % 5 : 32;

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 45000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}
function words(...values) {
    const b = Buffer.alloc(values.length * 2);
    values.forEach((value, i) => b.writeUInt16LE(value & 65535, i * 2));
    return b;
}
function room() {
    const sideData = Buffer.alloc((sectors + 1) * 30), sectorData = Buffer.alloc((sectors + 1) * 26);
    for (let s = 0; s <= sectors; ++s) {
        sideData.writeInt16LE(s, s * 30 + 28);
        sectorData.writeInt16LE(floor(s), s * 26);
        sectorData.writeInt16LE(ceiling(s), s * 26 + 2);
        sectorData.writeInt16LE(s, s * 26 + 24);
    }
    // The camera occupies the common front sector; every target borders it.
    const records = [
        ["Vertices", 2, words(0, -32, 0, 32)], ["Sides", sectors + 1, sideData], ["Sectors", sectors + 1, sectorData],
        ["Lines", switches.length, Buffer.concat(switches.map(({ action, sector }) => words(0, 1, 4, action, sector, 0, sector)))],
        ["Nodes", 0, Buffer.alloc(0)], ["Segs", 1, words(0, 1, 0, 0, 0, 0)], ["Subsectors", 1, words(1, 0)],
    ];
    writeFileSync(path.join(scratch, "ROOM.BIN"), Buffer.concat(records.map(record => record[2])));
    let offset = 0;
    return records.map(([field, count, data]) => {
        const result = `${field}: wad.Lump{Valid: true, Count: ${count}, Offset: ${offset}}`;
        offset += data.length;
        return result;
    }).join(",\n");
}
function fletcherTrace() {
    const entry = path.join(scratch, "main.flt"), output = path.join(scratch, "map.json");
    writeFileSync(entry, `package main
import "play"
import "wad"
const Room = readFile("ROOM.BIN")
map "Door and ceiling history" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register saved play.LevelSpecials = play.LevelSpecials{}
    register operation int = 0
    register age int = 0
    tick {
        base := wad.BspLevel{Valid: true, File: Room, ${room()}}
        state := saved
        active := state.ApplyTo(base)
        line := active.LineAt(operation)
        if age == 0 {
            if line.Action == 86 {
                state = play.CrossLevelSpecial(active, state, operation)
            } else {
                state = play.UseActorLine(active, state, operation, false, true, play.PlayerInventory{}).State
            }
            occupied := 0
            for sector := range ${sectors + 1} { if state.MoverOccupied(sector) { occupied = occupied + 1 } }
            log("start", operation, line.Action, line.Tag, active.SectorHeightsAt(line.Tag).Ceiling, occupied)
        }
        moved := play.TickLevelMoversAt(base, wad.BlockMapInfo{}, state, play.MapActor{Height: 16 << 16}, age)
        state = moved.State
        active = state.ApplyTo(base)
        owned := state.MoverOccupied(line.Tag)
        log("tic", operation, age, active.SectorHeightsAt(line.Tag).Ceiling, owned, moved.Valid)
        next saved = state
        if owned { next age = age + 1 } else {
            log("released", operation, state.Doors.Count, state.Ceilings.Count, state.Ceilings.TrackedCount)
            next operation = operation + 1
            next age = 0
            if operation == ${switches.length - 1} {
                for sector := range ${sectors + 1} {
                    log("final", sector, active.SectorHeightsAt(sector).Ceiling, state.MoverOccupied(sector))
                }
            }
        }
    }
}`);
    run("dotnet", [cli, "build", entry, "--package-root", path.join(root, "examples", "doom-engine"), "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    const result = { start: [], tic: [], released: [], final: [] };
    for (let host = 0; host < 15000; ++host) {
        const pos = sim.logs.length;
        sim.step();
        for (const log of sim.logs.slice(pos)) {
            const [tag, ...row] = log;
            const sample = row.map(Number);
            if (tag === "start") assert.equal(sample[4], 1, `special ${sample[1]} must start solely its target sector ${sample[2]}`);
            if (tag === "tic") assert.equal(sample.pop(), 1, `valid sector thinker for operation ${sample[0]}`);
            result[tag].push(sample);
            if (tag === "tic" && sample[0] === 2 * sectors - 1 && !sample[3]) sim.roundTripScriptState();
        }
        if (result.final.length === sectors + 1) return result;
    }
    assert.fail("the sequential movers did not finish");
}

function nativeTrace(directory) {
    const read = name => readFileSync(path.join(directory, name), "utf8").replaceAll("\r\n", "\n");
    const doors = read("door-p_doors.c"), ceilings = read("ceiling-p_ceilng.c"), specials = read("animated-p_spec.c");
    const ceilingStart = ceilings.search(/ceiling_t\s*\*\s*activeceilings\s*\[/);
    assert.ok(ceilingStart >= 0);
    const source = path.join(scratch, "history.c"), exe = path.join(scratch, process.platform === "win32" ? "history.exe" : "history");
    writeFileSync(source, `#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#define FRACUNIT 65536
#define MAXINT INT_MAX
#define MAXCEILINGS 30
#define CEILSPEED FRACUNIT
#define VDOORSPEED (2*FRACUNIT)
#define VDOORWAIT 150
enum { false,true,ML_TWOSIDED=4,PU_LEVSPEC=51,sfx_stnmov,sfx_pstop,sfx_bdcls,sfx_bdopn,sfx_dorcls,sfx_doropn };
typedef int boolean,fixed_t,mobj_t;
typedef enum {ok,crushed,pastdest} result_e;
typedef enum {normal,close30ThenOpen,close,open,raiseIn5Mins,blazeRaise,blazeOpen,blazeClose} vldoor_e;
typedef enum {lowerToFloor,raiseToHighest,lowerAndCrush,crushAndRaise,fastCrushAndRaise,silentCrushAndRaise} ceiling_e;
typedef void (*actionf_p1)(void *); typedef void (*actionf_v)(void);
typedef struct {union {actionf_p1 acp1;actionf_v acv;} function;} thinker_t;
typedef struct sector_s sector_t;
typedef struct {int tag,flags;sector_t *frontsector,*backsector;} line_t;
struct sector_s {fixed_t floorheight,ceilingheight;int tag,soundorg,linecount;line_t *lines[${switches.length}]; void *specialdata;};
typedef struct {thinker_t thinker;vldoor_e type;sector_t *sector;fixed_t topheight,speed;int direction,topwait,topcountdown;} vldoor_t;
typedef struct {thinker_t thinker;ceiling_e type;sector_t *sector;fixed_t bottomheight,topheight,speed;boolean crush;int direction,tag,olddirection;} ceiling_t;
static sector_t sectors[${sectors + 1}]; static line_t lines[${switches.length}];
static int numsectors=${sectors+1},leveltime,live;
static void *Z_Malloc(size_t bytes,int tag,void *owner){return calloc(1,bytes);}
static void P_AddThinker(thinker_t *p){++live;}
static void P_RemoveThinker(thinker_t *p){--live;p->function.acv=NULL;}
static boolean P_ChangeSector(sector_t *s,boolean crush){return false;}
static void S_StartSound(mobj_t *m,int sound){}
void P_AddActiveCeiling(ceiling_t *c);void P_RemoveActiveCeiling(ceiling_t *c);void P_ActivateInStasisCeiling(line_t *l);
${extractFunction(specials,"sector_t\\*","getNextSector")}
${extractFunction(specials,"int","P_FindSectorFromLineTag")}
${extractFunction(specials,"fixed_t","P_FindLowestCeilingSurrounding")}
${extractFunction(specials,"fixed_t","P_FindHighestCeilingSurrounding")}
${extractFunction(read("door-p_floor.c"),"result_e","T_MovePlane")}
${extractFunction(doors,"void","T_VerticalDoor")}
${extractFunction(doors,"int","EV_DoDoor")}
${ceilings.slice(ceilingStart)}
int main(void){
    const int tags[]={${switches.map(s=>s.sector).join(",")}}, actions[]={${switches.map(s=>s.action).join(",")}};
    for (int i=0;i<numsectors;++i){
        sectors[i].tag=i;
        sectors[i].floorheight=(i?4+i%3:0)*FRACUNIT;
        sectors[i].ceilingheight=(i?12+i%5:32)*FRACUNIT;
    }
    for (int i=0;i<${switches.length};++i){
        line_t *l=&lines[i];
        *l=(line_t){tags[i],ML_TWOSIDED,&sectors[0],&sectors[tags[i]]};
        l->frontsector->lines[l->frontsector->linecount++]=l;
        l->backsector->lines[l->backsector->linecount++]=l;
    }
    for (int op=0;op<${switches.length};++op){
        line_t *l=&lines[op];sector_t *s=l->backsector;
        int isCeiling=actions[op]==43;
        int started=isCeiling?EV_DoCeiling(l,lowerToFloor):EV_DoDoor(l,actions[op]==63?normal:open);
        if (!started || live!=1) abort();
        void *thinker=s->specialdata;
        printf("start,%d,%d,%d,%d,%d\\n",op,actions[op],tags[op],s->ceilingheight,live);
        for (leveltime=0;s->specialdata;++leveltime){
            if (leveltime>200) abort();
            if (isCeiling) T_MoveCeiling(thinker); else T_VerticalDoor(thinker);
            printf("tic,%d,%d,%d,%d\\n",op,leveltime,s->ceilingheight,live);
        }
        int tracked=0;
        for (int i=0;i<MAXCEILINGS;++i) tracked+=activeceilings[i]!=NULL;
        printf("released,%d,%d,%d,%d\\n",op,isCeiling?0:live,isCeiling?live:0,tracked);
        free(thinker);
    }
    for (int i=0;i<numsectors;++i) printf("final,%d,%d,%d\\n",i,sectors[i].ceilingheight,sectors[i].specialdata!=NULL);
    return 0;
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", source, "-o", exe]);
    const result = { start: [], tic: [], released: [], final: [] };
    for (const line of run(exe, []).trim().split(/\r?\n/)) {
        const [tag, ...values] = line.split(",");
        result[tag].push(values.map(Number));
    }
    return result;
}
try {
    const observed = fletcherTrace();
    if (values.upstream) {
        const native = nativeTrace(path.resolve(root, values.upstream));
        assert.deepEqual(observed.start, native.start, "initial height and active thinker count for every activation");
        assert.equal(observed.tic.length, native.tic.length);
        for (const [i, row] of observed.tic.entries()) assert.deepEqual(row, native.tic[i], `operation ${row[0]}, tic ${row[1]}`);
        assert.deepEqual(observed.released, native.released, "door and ceiling slots become available on the completion tic");
        assert.deepEqual(observed.final, native.final);
    }
    assert.equal(observed.start.length, switches.length);
    assert.equal(observed.tic.filter(row => !row[3]).length, switches.length);
    assert.deepEqual(observed.start.slice(-2).map(row => row[3]), [floor(1)*unit, floor(2)*unit]);
    for (const [operation, row] of observed.released.entries()) assert.deepEqual(row, [operation, 0, 0, 0]);
    for (let i = 0; i <= sectors; ++i) {
        const height = i === 0 ? 32 : i === 1 ? 28 : floor(i);
        assert.deepEqual(observed.final[i], [i, height * unit, 0]);
    }
    console.log(`Passed ${observed.tic.length} tics and ${switches.length} door/ceiling operations in ${sectors} target sectors, peak occupancy one.`);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
