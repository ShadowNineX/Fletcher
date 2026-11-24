// Exercise the sound flood on WAD sector and linedef indices beyond 4095.
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
const scratch = mkdtempSync(path.join(os.tmpdir(),"fletcher-noise-capacity-"));
const sectorCount = 4105, padding = 4096, cut = 2048;
const source = 4097, blockedRoute = 4098, junction = 4099, door = 4100, gate = 4101, tail = 4102, beyond = 4103;
// Doom first enters the junction through one blocker. Its later zero-blocker
// visit must propagate through the blocked portal to gate, then stop at beyond.
const portals = [[source,blockedRoute,68],[blockedRoute,junction,4],[junction,gate,68],
    [source,door,4],[door,junction,4],[gate,tail,4],[tail,beyond,68]];
const sample = [0,padding,source,blockedRoute,junction,door,gate,tail,beyond,sectorCount-1];
function run(command,args) {
    const r = spawnSync(command,args,{cwd:root,encoding:"utf8",timeout:60000,maxBuffer:8*1024*1024});
    if (r.error) throw r.error;
    assert.equal(r.status,0,r.stderr || r.stdout);
    return r.stdout;
}
function makeGeometry() {
    const vertices = Buffer.alloc(8), sectors = Buffer.alloc(26*sectorCount), sides = Buffer.alloc(30*sectorCount);
    vertices.writeInt16LE(32,4);
    for (let s = 0; s < sectorCount; ++s) {
        sectors.writeInt16LE(128,26*s+2);
        sides.writeUInt16LE(s,30*s+28);
    }
    function lineRecords(records) {
        const b = Buffer.alloc(records.length*14);
        records.forEach(([a,z,flags],i)=>{
            b.writeUInt16LE(1,i*14+2);
            b.writeUInt16LE(flags,i*14+4);
            b.writeUInt16LE(a,i*14+10);
            b.writeUInt16LE(z<0?65535:z,i*14+12);
        });
        return b;
    }
    const walls = Array.from({length:padding},(_,i)=>[i,-1,0]);
    const sparse = lineRecords([...walls,...portals]);
    const chain = lineRecords(Array.from({length:sectorCount-1},(_,s)=>[s,s+1,s===cut?68:4]));
    const data = [vertices,sectors,sides,sparse,chain];
    writeFileSync(path.join(scratch,"ROOM.BIN"),Buffer.concat(data));
    let offset = 0;
    const lump = (b,size)=>{
        const field = `wad.Lump{Valid: true, Count: ${b.length/size}, Offset: ${offset}}`;
        offset += b.length;
        return field;
    };
    const fields = `Vertices: ${lump(vertices,4)}, Sectors: ${lump(sectors,26)}, Sides: ${lump(sides,30)}, Lines: ${lump(sparse,14)}`;
    return {fields,chain:lump(chain,14)};
}
function fletcherRows() {
    const geo = makeGeometry(), entry = path.join(scratch,"main.flt"), output = path.join(scratch,"map.json");
    writeFileSync(entry,`package main
import "engine"
import "play"
import "wad"
const Geometry = readFile("ROOM.BIN")
const Sample = [${sample.length}]int{${sample.join(",")}}
type DoorOpening struct { Closed bit }
func (live DoorOpening) ReadHeights(sector int, original engine.SectorHeights) engine.SectorHeights {
    if live.Closed && sector == ${door} { original.Ceiling = original.Floor }
    return original
}
func (live DoorOpening) ReadLineAction(line int, original int) int { return original }
func (live DoorOpening) ReadSectorSpecial(sector int, original int) int { return original }
func (live DoorOpening) ReadSideMaterial(side int, original wad.SideMaterial) wad.SideMaterial { return original }
func (live DoorOpening) ReadFloorName(sector int, original wad.LumpName) wad.LumpName { return original }
map "High sector sound targets" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register savedGraph play.SoundGraph = play.SoundGraph{}
    register savedTargets play.SoundTargets = play.SoundTargets{}
    register tic int = 0
    tick {
        base := wad.BspLevel{Valid: true, File: Geometry, ${geo.fields}}
        graph := savedGraph
        targets := savedTargets
        if tic >= 3 { base.Lines = ${geo.chain} }
        if tic == 0 || tic == 3 {
            graph = play.BuildSoundGraph(base)
            targets = play.SoundTargets{}
            log("graph", tic, graph.Valid)
        }
        emitter := ${source}
        if tic == 2 { emitter = ${tail} }
        if tic >= 3 { emitter = ${sectorCount-1} }
        if graph.Valid {
            targets = play.NoiseAlert(base.WithChanges(DoorOpening{Closed: tic == 1}), graph, targets, emitter, 11 + tic)
            if tic < 3 {
                for i := range ${sample.length} {
                    s := Sample[i]
                    heard := targets.At(s)
                    log("heard", tic, s, heard.Target, heard.Traversed)
                }
            } else {
                for s := range ${sectorCount} {
                    heard := targets.At(s)
                    log("heard", tic, s, heard.Target, heard.Traversed)
                }
            }
        }
        log("end", tic, targets.Valid)
        next savedGraph = graph
        next savedTargets = targets
        next tic = tic + 1
    }
}`);
    run("dotnet",[cli,"build",entry,"--package-root",path.join(root,"examples","doom-engine"),"--asset-root",scratch,"-o",output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output,"utf8")).data),true), rows = [];
    let started = 0;
    const slices = [];
    for (let host=1;host<=2500;++host) {
        const from = sim.logs.length;
        sim.step();
        for (const [tag,...fields] of sim.logs.slice(from)) {
            const row = [tag,...fields.map(Number)];
            rows.push(row);
            if (tag==="graph") assert.equal(row[2],1,`sound graph must accept ${sectorCount} sectors and ${row[1]===0?padding+portals.length:sectorCount-1} linedefs`);
            if (tag==="end") {
                assert.equal(row[2],1,"sound flood must finish");
                slices.push(host-started);
                started=host;
                if (row[1]===1) sim.roundTripScriptState();
                if (row[1]===3) return {rows,slices};
            }
        }
    }
    assert.fail("large sound flood exceeded its host slice budget");
}
function nativeRows(upstream) {
    const read = f=>readFileSync(path.join(upstream,f),"utf8").replaceAll("\r\n","\n");
    const enemy = read("p_enemy.c"), map = read("movement-p_maputl.c");
    const src = path.join(scratch,"noise.c"), exe = path.join(scratch,process.platform==="win32"?"noise.exe":"noise");
    writeFileSync(src,`#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define N ${sectorCount}
#define ML_TWOSIDED 4
#define ML_SOUNDBLOCK 64
typedef struct sector_s sector_t;
typedef struct {sector_t *sector;} side_t,subsector_t;
typedef struct {subsector_t *subsector;} mobj_t;
typedef struct {int flags,sidenum[2];sector_t *frontsector,*backsector;} line_t;
struct sector_s {int floorheight,ceilingheight,validcount,soundtraversed,linecount;line_t *lines[4];mobj_t *soundtarget;};
static sector_t sectors[N];static line_t lines[N];static side_t sides[N];static subsector_t leaf;static mobj_t emitter={&leaf}, targets[4],*soundtarget;
static int validcount,opentop,openbottom,openrange,lowfloor;
${extractFunction(map,"void","P_LineOpening")}
${extractFunction(enemy,"void","P_RecursiveSound")}
${extractFunction(enemy,"void","P_NoiseAlert")}
static void linkLine(int i,int a,int b,int flags){
    line_t *l=&lines[i];*l=(line_t){flags,{a,b},&sectors[a], b<0?NULL:&sectors[b]};
    sectors[a].lines[sectors[a].linecount++]=l;
    if(b>=0)sectors[b].lines[sectors[b].linecount++]=l;
}
static void reset(void){
    memset(sectors,0,sizeof(sectors));validcount=0;
    for(int s=0;s<N;s++){sectors[s].ceilingheight=128*65536;sides[s].sector=&sectors[s];}
}
static void heard(int tic,int s){
    mobj_t *target=sectors[s].soundtarget;
    printf("heard,%d,%d,%d,%d\\n",tic,s,target?(int)(target-targets)+11:0,sectors[s].soundtraversed);
}
int main(void){
    const int portals[][3]={${portals.map(p=>"{"+p.join(",")+"}").join(",")}};
    const int sample[]={${sample.join(",")}};
    reset();
    for(int i=0;i<${padding};i++)linkLine(i,i,-1,0);
    for(int i=0;i<${portals.length};i++)linkLine(${padding}+i,portals[i][0],portals[i][1],portals[i][2]);
    for(int tic=0;tic<4;tic++){
        if(tic==3){
            reset();for(int i=0;i<N-1;i++)linkLine(i,i,i+1,i==${cut}?68:4);
        }
        if(tic==0||tic==3)printf("graph,%d,1\\n",tic);
        sectors[${door}].ceilingheight=tic==1?0:128*65536;
        leaf.sector=&sectors[tic==3?N-1:tic==2?${tail}:${source}];
        P_NoiseAlert(&targets[tic],&emitter);
        if(tic==3){for(int s=0;s<N;s++)heard(tic,s);}
        else {for(int i=0;i<${sample.length};i++)heard(tic,sample[i]);}
        printf("end,%d,1\\n",tic);
    }
    return 0;
}`);
    run(process.env.CC ?? "gcc",["-std=c11","-O2",src,"-o",exe]);
    return run(exe,[]).trim().split(/\r?\n/).map(line=>{
        const [tag,...fields]=line.split(",");
        return [tag,...fields.map(Number)];
    });
}
function verify(rows) {
    const expected = [
        [[0,0],[0,0],[11,1],[11,1],[11,1],[11,1],[11,2],[11,2],[0,0],[0,0]],
        [[0,0],[0,0],[12,1],[12,2],[12,2],[11,1],[11,2],[11,2],[0,0],[0,0]],
        [[0,0],[0,0],[13,2],[13,2],[13,2],[13,2],[13,1],[13,1],[13,2],[0,0]],
    ];
    for(let tic=0;tic<3;tic++){
        assert.deepEqual(rows.filter(r=>r[0]==="heard" && r[1]===tic),sample.map((s,i)=>["heard",tic,s,...expected[tic][i]]));
    }
    const chain=rows.filter(r=>r[0]==="heard" && r[1]===3);
    assert.equal(chain.length,sectorCount);
    chain.forEach((row,s)=>assert.deepEqual(row,["heard",3,s,14,s<=cut?2:1]));
}
try {
    const native=values.upstream?nativeRows(path.resolve(root,values.upstream)):null;
    if(native)verify(native);
    const {rows,slices}=fletcherRows();
    verify(rows);
    if(native)assert.deepEqual(rows,native);
    assert.ok(slices[3]>1,"the deep graph and flood must span host slices");
    console.log(`Passed ${rows.length} noise rows over ${sectorCount} sectors, including a full-depth chain; host slices per logical tic: ${slices.join(", ")}.`);
} finally {
    rmSync(scratch,{recursive:true,force:true});
}
