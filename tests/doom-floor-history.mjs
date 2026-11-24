// Reuse repeatable platform lines across more sectors than the active-mover array.
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
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-floor-history-"));
const shafts = 50, unit = 65536;
const switches = [{ sector: 1, action: 66 }, ...[62, 68].flatMap(action =>
    Array.from({ length: shafts }, (_, i) => ({ sector: 1 + i, action })))];
const sequence = [...switches.keys(), 0, 1];
const baseFloor = i => i ? 4 + (i % 3) * 4 : 0;
const flat = i => i ? "LIFTBASE" : "MODELPIC";
function words(...values) {
    const data = Buffer.alloc(values.length * 2);
    values.forEach((val, i) => data.writeUInt16LE(val & 65535, i * 2));
    return data;
}
function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 45000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}
function records() {
    // Every switch borders the common model sector and its own shaft. The one
    // subsector locates the stationary probe in the model sector during motion.
    const sectors = Buffer.alloc(26 * (1 + shafts)), sides = Buffer.alloc(30 * (1 + shafts));
    for (let i = 0; i <= shafts; i++) {
        sectors.writeInt16LE(baseFloor(i), 26 * i);
        sectors.writeInt16LE(128, 26 * i + 2);
        sectors.write(flat(i), 26 * i + 4);
        sectors.writeInt16LE(i ? 5 : 0, 26 * i + 22);
        sectors.writeInt16LE(i, 26 * i + 24);
        sides.writeInt16LE(i, 30 * i + 28);
    }
    const lumps = [
        ["Vertices", 2, words(0, -32, 0, 32)], ["Sides", 1 + shafts, sides], ["Sectors", 1 + shafts, sectors],
        ["Lines", switches.length, Buffer.concat(switches.map(({ sector, action }) => words(0, 1, 4, action, sector, 0, sector)))],
        ["Nodes", 0, Buffer.alloc(0)], ["Segs", 1, words(0, 1, 0, 0, 0, 0)], ["Subsectors", 1, words(1, 0)],
    ];
    writeFileSync(path.join(scratch, "ROOM.BIN"), Buffer.concat(lumps.map(lump => lump[2])));
    let offset = 0;
    return lumps.map(([field, count, data]) => {
        const decl = `${field}: wad.Lump{Valid: true, Offset: ${offset}, Count: ${count}}`;
        offset += data.length;
        return decl;
    }).join(",\n");
}

function fletcherTrace() {
    const source = path.join(scratch, "main.flt"), output = path.join(scratch, "map.json");
    writeFileSync(source, `package main
import "play"
import "wad"
const Room = readFile("ROOM.BIN")
const Sequence = [${sequence.length}]int{${sequence.join(",")}}
map "Platform sector history" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register specials play.LevelSpecials = play.LevelSpecials{}
    register operation int = 0
    register age int = 0
    tick {
        base := wad.BspLevel{Valid: true, File: Room, ${records()}}
        state := specials
        index := Sequence[operation]
        active := state.ApplyTo(base)
        sector := active.LineAt(index).Tag
        if age == 0 {
            used := play.UseActorLine(active, state, index, false, true, play.PlayerInventory{})
            state = used.State
        }
        atStart := state.Floors.ActivePlatforms
        frame := play.TickLevelMoversAt(base, wad.BlockMapInfo{}, state, play.MapActor{Height: 56 << 16}, age)
        state = frame.State
        active = state.ApplyTo(base)
        name := active.FloorNameAt(sector)
        log(operation, age, atStart, state.Floors.ActivePlatforms, active.SectorHeightsAt(sector).Floor,
            name.Low, name.High, active.SectorSpecial(sector), frame.Valid, state.Floors.PlatformOverflow)
        next specials = state
        if state.Floors.ActivePlatforms == 0 {
            if operation == ${sequence.length - 1} {
                for s := range ${shafts + 1} {
                    retained := active.FloorNameAt(s)
                    log(s, active.SectorHeightsAt(s).Floor, retained.Low, retained.High, active.SectorSpecial(s))
                }
            }
            next age = 0
            next operation = operation + 1
        } else { next age = age + 1 }
    }
}`);
    run("dotnet", [cli, "build", source, "--package-root", path.join(root, "examples", "doom-engine"), "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    const trace = [], final = [];
    for (let host = 0; host < 20000; host++) {
        const pos = sim.logs.length;
        sim.step();
        for (const log of sim.logs.slice(pos)) {
            const row = Array.from(log, Number);
            if (row.length === 5) {
                final.push(row);
            } else {
                trace.push(row.slice(0, 8));
                assert.deepEqual(row.slice(8), [1, 0], `platform ${row[0]} tic ${row[1]} must fit while occupancy is ${row[2]}`);
                if (row[0] === switches.length - 1 && row[3] === 0) sim.roundTripScriptState();
            }
        }
        if (final.length === shafts + 1) return { trace, final };
    }
    assert.fail("platform sequence did not complete in 20000 host ticks");
}

function nativeTrace(directory) {
    const read = name => readFileSync(path.join(directory, name), "utf8").replaceAll("\r\n", "\n");
    const plats = read("platform-p_plats.c"), floors = read("door-p_floor.c"), spec = read("animated-p_spec.c");
    const platformStart = plats.search(/plat_t\s*\*\s*activeplats\s*\[/);
    assert.ok(platformStart >= 0);
    const source = path.join(scratch, "history.c"), exe = path.join(scratch, process.platform === "win32" ? "history.exe" : "history");
    const flatWords = [0, 1].map(i => [0, 4].map(offset => Buffer.from(flat(i)).readInt32LE(offset)));
    writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
#define FRACUNIT 65536
#define MAXPLATS 30
#define PLATWAIT 3
#define PLATSPEED FRACUNIT
enum {false, true, ML_TWOSIDED=4, PU_LEVSPEC=51, sfx_stnmov, sfx_pstart, sfx_pstop};
typedef int boolean, fixed_t, mobj_t;
typedef enum {ok,crushed,pastdest} result_e;
typedef enum {up,down,waiting,in_stasis} plat_e;
typedef enum {perpetualRaise,downWaitUpStay,raiseAndChange,raiseToNearestAndChange,blazeDWUS} plattype_e;
typedef void (*actionf_p1)(void *); typedef void (*actionf_v)(void);
typedef struct { union {actionf_p1 acp1; actionf_v acv;} function; } thinker_t;
typedef struct sector_s sector_t;
typedef struct {sector_t *frontsector,*backsector; int tag,flags,sidenum[2],special;} line_t;
struct sector_s {fixed_t floorheight,ceilingheight; int floorpic,special,soundorg,tag,linecount; void *specialdata; line_t *lines[${switches.length}];};
typedef struct {sector_t *sector;} side_t;
typedef struct {thinker_t thinker; sector_t *sector; fixed_t speed,low,high; int wait,count; plat_e status,oldstatus; boolean crush; int tag; plattype_e type;} plat_t;
static sector_t sectors[${shafts+1}]; static side_t sides[${shafts+1}]; static line_t lines[${switches.length}];
static int numsectors=${shafts+1},leveltime;
static const int flats[][2]={${flatWords.map(pair=>"{"+pair.join(",")+"}").join(",")}};
static void I_Error(const char *s){fprintf(stderr,"%s",s);abort();}
static void *Z_Malloc(size_t n,int tag,void *owner){return calloc(1,n);}
static void P_AddThinker(thinker_t *t){} static void P_RemoveThinker(thinker_t *t){t->function.acv=NULL;}
static void S_StartSound(mobj_t *p,int s){} static int P_Random(void){abort();}
static boolean P_ChangeSector(sector_t *s,boolean crush){return false;}
void P_ActivateInStasis(int tag); void P_AddActivePlat(plat_t *p); void P_RemoveActivePlat(plat_t *p);
${extractFunction(spec, "sector_t\\*", "getNextSector")}
${extractFunction(spec, "int", "P_FindSectorFromLineTag")}
${extractFunction(spec, "fixed_t", "P_FindHighestFloorSurrounding")}
${extractFunction(spec, "fixed_t", "P_FindLowestFloorSurrounding")}
#define MAX_ADJOINING_SECTORS 20
${extractFunction(spec, "fixed_t", "P_FindNextHighestFloor")}
${extractFunction(floors, "result_e", "T_MovePlane")}
${plats.slice(platformStart)}
static int occupancy(void){int count=0;for(int i=0;i<MAXPLATS;i++) count+=activeplats[i]!=NULL;return count;}
int main(void){
 const int sequence[]={${sequence.join(",")}}, tags[]={${switches.map(s=>s.sector).join(",")}}, actions[]={${switches.map(s=>s.action).join(",")}};
 for (int i=0; i<numsectors; ++i) {
    sector_t *s=&sectors[i];
    sides[i].sector=s;
    s->tag=i;
    s->floorheight=(i ? 4+(i%3)*4 : 0)*FRACUNIT;
    s->ceilingheight=128*FRACUNIT;
    s->floorpic=i!=0;
    s->special=i ? 5 : 0;
 }
 for (int i=0; i<${switches.length}; ++i) {
    line_t *l=&lines[i];
    *l=(line_t){.frontsector=&sectors[0], .backsector=&sectors[tags[i]], .tag=tags[i],
                .flags=ML_TWOSIDED, .sidenum={0,tags[i]}, .special=actions[i]};
    l->frontsector->lines[l->frontsector->linecount++]=l;
    l->backsector->lines[l->backsector->linecount++]=l;
 }
 for (int op=0; op<${sequence.length}; ++op) {
    line_t *l=&lines[sequence[op]];
    sector_t *s=l->backsector;
    int started=0;
    switch (l->special) {
      case 62: started=EV_DoPlat(l,downWaitUpStay,1); break;
      case 66: started=EV_DoPlat(l,raiseAndChange,24); break;
      case 68: started=EV_DoPlat(l,raiseToNearestAndChange,0); break;
    }
    if (!started) abort();
    plat_t *p=s->specialdata;
    for (leveltime=0; s->specialdata; ++leveltime) {
      if (leveltime>=160) abort();
      int before=occupancy();
      T_PlatRaise(p);
      printf("%d,%d,%d,%d,%d,%d,%d,%d\\n",op,leveltime,before,occupancy(),s->floorheight,
             flats[s->floorpic][0],flats[s->floorpic][1],s->special);
    }
    free(p);
 }
 puts("final");
 for (int i=0; i<numsectors; ++i) {
    sector_t *s=&sectors[i];
    printf("%d,%d,%d,%d,%d\\n",i,s->floorheight,flats[s->floorpic][0],flats[s->floorpic][1],s->special);
 }
 return 0;
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", source, "-o", exe]);
    const [ticks, end] = run(exe, []).trim().split(/\r?\nfinal\r?\n/);
    const rows = text => text.split(/\r?\n/).map(line => line.split(",").map(Number));
    return { trace: rows(ticks), final: rows(end) };
}

try {
    const observed = fletcherTrace();
    if (values.upstream) {
        const native = nativeTrace(path.resolve(root, values.upstream));
        assert.equal(observed.trace.length, native.trace.length);
        for (const [i, row] of observed.trace.entries()) assert.deepEqual(row, native.trace[i], `platform operation ${row[0]}, tic ${row[1]}`);
        assert.deepEqual(observed.final, native.final);
    }
    assert.equal(Math.max(...observed.trace.map(row => row[2])), 1);
    assert.equal(observed.trace.filter(row => row[3] === 0).length, sequence.length);
    const model = Buffer.from(flat(0));
    for (let sector = 0; sector <= shafts; sector++) {
        assert.deepEqual(observed.final[sector], [sector, (baseFloor(sector) + (sector === 1 ? 48 : 0)) * unit,
            model.readInt32LE(0), model.readInt32LE(4), 0], `retained floor ${sector}`);
    }
    console.log(`Passed ${observed.trace.length} ticks for ${sequence.length} sequential platform activations across ${shafts} sectors, with peak occupancy 1.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-floor-history-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
