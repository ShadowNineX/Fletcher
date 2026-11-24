// A vanilla ceiling that misses the 30-pointer control registry still thinks and owns its sector.
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
const port = path.join(root, "examples", "doom-engine");
const scratch = mkdtempSync(path.join(os.tmpdir(), "fletcher-ceiling-capacity-"));
const count = 224, unit = 65536;
// Line 0 starts terminal ceilings, line 1 stops, line 2 resumes or allocates.
const commands = [0, 1, 1, 2, -1, -1, 2, -1, -1, 1, 2];
const floor = i => i % 4;
const height = i => floor(i) + 2 + (i % 2);

function run(cmd, args) {
    const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", timeout: 45000 });
    if (r.error) throw r.error;
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout;
}
function words(...values) {
    const b = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => b.writeUInt16LE(v & 65535, 2 * i));
    return b;
}
function room() {
    // The fixed camera stays in sector zero; each moving chamber is unobstructed.
    const sectors = Buffer.alloc((count + 1) * 26);
    sectors.writeInt16LE(128, 2);
    for (let s = 1; s <= count; s++) {
        sectors.writeInt16LE(floor(s), 26 * s);
        sectors.writeInt16LE(height(s), 26 * s + 2);
        sectors.writeInt16LE(7, 26 * s + 24);
    }
    const records = [
        ["Vertices", 2, words(0, -32, 0, 32)], ["Sides", 1, Buffer.alloc(30)], ["Sectors", count + 1, sectors],
        ["Lines", 3, Buffer.concat([43, 74, 73].map(action => words(0, 1, 0, action, 7, 0, -1)))],
        ["Nodes", 0, Buffer.alloc(0)], ["Segs", 1, words(0, 1, 0, 0, 0, 0)], ["Subsectors", 1, words(1, 0)],
    ];
    writeFileSync(path.join(scratch, "ROOM.BIN"), Buffer.concat(records.map(record => record[2])));
    let offset = 0;
    return records.map(([field, n, data]) => {
        const result = `${field}: wad.Lump{Valid: true, Count: ${n}, Offset: ${offset}}`;
        offset += data.length;
        return result;
    }).join(",\n");
}
function fletcherTrace() {
    const entry = path.join(scratch, "main.flt"), output = path.join(scratch, "level.json");
    writeFileSync(entry, `package main
import "play"
import "wad"
const Room = readFile("ROOM.BIN")
const Commands = [${commands.length}]int{${commands.join(",")}}
map "Simultaneous ceiling controls" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register saved play.LevelSpecials = play.LevelSpecials{}
    register tic int = 0
    tick {
        base := wad.BspLevel{Valid: true, File: Room, ${room()}}
        state := saved
        level := state.ApplyTo(base)
        index := Commands[tic]
        if index == 0 { state = play.UseActorLine(level, state, index, false, true, play.PlayerInventory{}).State }
        if index > 0 { state = play.CrossLevelSpecial(level, state, index) }
        log("start", tic, state.Ceilings.Count, state.Ceilings.TrackedCount)
        moved := play.TickLevelMoversAt(base, wad.BlockMapInfo{}, state, play.MapActor{Height: 16 << 16}, tic)
        state = moved.State
        level = state.ApplyTo(base)
        for i := range moved.Sounds.Count { log("sound", tic, moved.Sounds.At(i).Sector) }
        for i := range ${count} {
            s := i + 1
            log("sector", tic, s, level.SectorHeightsAt(s).Ceiling, state.MoverOccupied(s))
        }
        log("end", tic, state.Ceilings.Count, state.Ceilings.TrackedCount, moved.Valid)
        next saved = state
        next tic = tic + 1
    }
}`);
    run("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    const rows = [];
    for (let host = 0; host < 10000; ++host) {
        const first = sim.logs.length;
        sim.step();
        for (const [tag, ...values] of sim.logs.slice(first)) {
            const row = [tag, ...values.map(Number)];
            rows.push(row);
            if (tag === "start" && row[1] === 0) {
                assert.deepEqual(row.slice(2), [count, 30], "one tagged action schedules every thinker and tracks 30");
            }
            if (tag === "end" && row[1] === 1) sim.roundTripScriptState();
            if (tag === "end" && row[1] === commands.length - 1) return rows;
        }
    }
    assert.fail("all ceiling tics must finish in the host budget");
}

function nativeTrace(directory) {
    const read = f => readFileSync(path.join(directory, f), "utf8").replaceAll("\r\n", "\n");
    const ceilings = read("ceiling-p_ceilng.c"), scheduler = read("p_tick.c");
    const start = ceilings.search(/ceiling_t\s*\*\s*activeceilings\s*\[/);
    assert.ok(start >= 0);
    const source = path.join(scratch, "capacity.c"), exe = path.join(scratch, process.platform === "win32" ? "capacity.exe" : "capacity");
    writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
#define FRACUNIT 65536
#define CEILSPEED FRACUNIT
#define MAXCEILINGS 30
enum {false,true,PU_LEVSPEC=51,sfx_stnmov,sfx_pstop};
typedef int boolean,fixed_t,mobj_t;
typedef enum {ok,crushed,pastdest} result_e;
typedef enum {lowerToFloor,raiseToHighest,lowerAndCrush,crushAndRaise,fastCrushAndRaise,silentCrushAndRaise} ceiling_e;
typedef void (*actionf_v)(void);
typedef void (*actionf_p1)(void *);
typedef struct thinker_s {struct thinker_s *prev,*next; union {actionf_v acv;actionf_p1 acp1;} function;} thinker_t;
typedef struct {int tag,soundorg;fixed_t floorheight,ceilingheight;void *specialdata;} sector_t;
typedef struct {int tag;} line_t;
typedef struct {thinker_t thinker;ceiling_e type;sector_t *sector;fixed_t bottomheight,topheight,speed;
                boolean crush;int direction,tag,olddirection;} ceiling_t;
static sector_t sectors[${count+1}]; static int numsectors=${count+1},leveltime;
static thinker_t thinkercap;
static void *Z_Malloc(size_t n,int tag,void *owner){return calloc(1,n);}
// P_RunThinkers still reads the unlinked node's next pointer during this pass.
static void Z_Free(void *p){}
static boolean P_ChangeSector(sector_t *s,boolean crush){return false;}
static fixed_t P_FindHighestCeilingSurrounding(sector_t *s){abort();}
static void S_StartSound(mobj_t *origin,int sound){
    if(sound!=sfx_stnmov) abort();
    printf("sound,%d,%d\\n",leveltime,*origin);
}
void P_AddActiveCeiling(ceiling_t *c);void P_RemoveActiveCeiling(ceiling_t *c);void P_ActivateInStasisCeiling(line_t *l);
${["P_InitThinkers","P_AddThinker","P_RemoveThinker","P_RunThinkers"].map(name => extractFunction(scheduler,"void",name)).join("\n")}
${extractFunction(read("animated-p_spec.c"), "int", "P_FindSectorFromLineTag")}
${extractFunction(read("door-p_floor.c"), "result_e", "T_MovePlane")}
${ceilings.slice(start)}
static void totals(const char *tag,boolean end){
    int owned=0,tracked=0;
    for(int s=1;s<numsectors;++s) owned += sectors[s].specialdata!=NULL;
    for(int i=0;i<MAXCEILINGS;++i) tracked += activeceilings[i]!=NULL;
    printf("%s,%d,%d,%d%s\\n",tag,leveltime,owned,tracked,end?",1":"");
}
int main(void){
    const int commands[]={${commands.join(",")}};
    line_t line={.tag=7};
    P_InitThinkers();
    for(int s=1;s<numsectors;++s){
        sectors[s].tag=7; sectors[s].soundorg=s; sectors[s].floorheight=(s%4)*FRACUNIT;
        sectors[s].ceilingheight=(s%4+2+s%2)*FRACUNIT;
    }
    for(leveltime=0;leveltime<${commands.length};++leveltime){
        switch(commands[leveltime]){
          case 0: EV_DoCeiling(&line,lowerToFloor); break;
          case 1: EV_CeilingCrushStop(&line); break;
          case 2: EV_DoCeiling(&line,crushAndRaise); break;
        }
        totals("start",false);
        P_RunThinkers();
        for(int s=1;s<numsectors;++s) printf("sector,%d,%d,%d,%d\\n",leveltime,s,sectors[s].ceilingheight,sectors[s].specialdata!=NULL);
        totals("end",true);
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
    const sectors = Array.from({ length: count }, (_, i) => i + 1);
    const soundOrder = tic => rows.filter(row => row[0] === "sound" && row[1] === tic).map(row => row[2]);
    assert.deepEqual(soundOrder(0), sectors);
    assert.deepEqual(soundOrder(8), [...sectors.slice(30), ...sectors.slice(0, 30)]);
    const at = (tic, s) => rows.find(row => row[0] === "sector" && row[1] === tic && row[2] === s).slice(3);
    for (const s of sectors) {
        assert.deepEqual(at(1, s), [(height(s) - (s <= 30 ? 1 : 2)) * unit, 1], `stasis affects the registered slots only, sector ${s}`);
        assert.deepEqual(at(5, s), [floor(s) * unit, Number(s > 30)], `terminal ownership for sector ${s}`);
    }
    assert.deepEqual(rows.find(row => row[0] === "end" && row[1] === 5), ["end", 5, count - 30, 0, 1]);
    assert.deepEqual(rows.find(row => row[0] === "start" && row[1] === 6), ["start", 6, count, 30]);
}
try {
    const native = values.upstream ? nativeTrace(path.resolve(root, values.upstream)) : null;
    if (native) verify(native);
    const observed = fletcherTrace();
    verify(observed);
    if (native) {
        assert.equal(observed.length, native.length);
        for (const [i, row] of observed.entries()) assert.deepEqual(row, native[i], `ceiling trace row ${i}`);
    }
    console.log(`Passed ${count} simultaneous ceilings, tracked stasis, slot reuse, and sound order; checked ${observed.length} rows.`);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
