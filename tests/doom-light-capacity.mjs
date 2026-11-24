// Offline comparison of startup light thinkers, tagged static levels, and overlapping strobes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" }, port: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.resolve(root, values.port ?? "examples/doom-engine");
const upstream = values.upstream ? path.resolve(root, values.upstream) : null;
const scratch = mkdtempSync(path.join(os.tmpdir(), "fletcher-light-capacity-"));
const count = 72, staticTic = 12, taggedTic = 13, finalTic = 31;
const startup = [1, 2, 3, 4, 8, 12, 13, 17];
const ids = Array.from({ length: count }, (_, i) => i + 1);
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
    const sides = Buffer.alloc((count + 1) * 30), sectors = Buffer.alloc((count + 1) * 26);
    for (let s = 0; s <= count; ++s) {
        sides.writeInt16LE(s, 30 * s + 28);
        sectors.writeInt16LE(128, 26 * s + 2);
        sectors.writeInt16LE(s ? 128 + 8 * (s % 12) : 48, 26 * s + 20);
        sectors.writeInt16LE(s ? startup[(s-1) % startup.length] : 0, 26 * s + 22);
        sectors.writeInt16LE(s ? 7 : 0, 26 * s + 24);
    }
    const plain = Buffer.from(sectors);
    for (const s of ids) plain.writeInt16LE(5, 26 * s + 22);
    const records = [
        ["Vertices", 2, words(0,-32,0,32)], ["Sides", count+1, sides], ["Sectors", count+1,sectors],
        ["Lines", count, Buffer.concat(ids.map(s => words(0,1,4,[81,17,17][s-1] ?? 0,7,0,s)))],
        ["Nodes", 0, Buffer.alloc(0)], ["Segs", 1, words(0,1,0,0,0,0)], ["Subsectors", 1, words(1,0)],
    ];
    let offset = 0;
    const fields = records.map(([field,n,b]) => {
        const decl = `${field}: wad.Lump{Valid: true, Count: ${n}, Offset: ${offset}}`;
        offset += b.length;
        return decl;
    }).join(",\n");
    writeFileSync(path.join(scratch, "ROOM.BIN"), Buffer.concat([...records.map(r=>r[2]),plain]));
    return { fields, plain: `wad.Lump{Valid: true, Count: ${count+1}, Offset: ${offset}}` };
}
function compiledRows() {
    const geo = room(), source = path.join(scratch, "main.flt"), output = path.join(scratch, "map.json");
    writeFileSync(source, `package main
import "play"
import "wad"
const Room = readFile("ROOM.BIN")
map "Sector light capacity" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register saved play.LevelSpecials = play.LevelSpecials{}
    register tic int = 0
    tick {
        base := wad.BspLevel{Valid: true, File: Room, ${geo.fields}}
        if tic >= ${staticTic} { base.Sectors = ${geo.plain} }
        state := saved
        if tic == 0 || tic == ${staticTic} || tic == ${taggedTic} {
            state = play.LevelSpecials{Lighting: play.LoadLevelLights(base, play.RandomState{MenuIndex: 41})}
        }
        line := -1
        if tic == ${staticTic} { line = 0 }
        if tic == ${taggedTic} || tic == ${taggedTic+1} { line = 1 }
        if tic == ${taggedTic+3} { line = 2 }
        if line >= 0 { state = play.CrossLevelSpecial(state.ApplyTo(base), state, line) }
        moved := play.TickLevelMoversAt(base, wad.BlockMapInfo{}, state, play.MapActor{Height: 16 << 16}, tic)
        state = moved.State
        lights := state.Lighting.Lights
        live := state.ApplyTo(base)
        for i := range ${count} {
            s := i + 1
            log("sector", tic, s, lights.LightAt(s, base.SectorLight(s)), lights.SectorSpecialAt(s, base.SectorSpecial(s)))
        }
        log("end", tic, lights.ThinkerCount, state.Lighting.Random.GameplayIndex, state.Lighting.Random.MenuIndex,
            live.LineAt(1).Action, live.LineAt(2).Action, moved.Valid)
        next saved = state
        next tic = tic + 1
    }
}`);
    run("dotnet", [cli, "build", source, "--package-root", port, "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true), rows = [];
    for (let host = 0; host < 40000; ++host) {
        const pos = sim.logs.length;
        sim.step();
        for (const [tag,...fields] of sim.logs.slice(pos)) {
            const row = [tag,...fields.map(Number)];
            rows.push(row);
            if (tag === "end" && row[1] === taggedTic+3) sim.roundTripScriptState();
            if (tag === "end" && row[1] === finalTic) return rows;
        }
    }
    assert.fail("sliced lighting simulation exceeded host budget");
}
function nativeRows() {
    const read = file => readFileSync(path.join(upstream,file),"utf8").replaceAll("\r\n","\n");
    const lights = read("light-p_lights.c"), spec = read("animated-p_spec.c"), tick = read("p_tick.c");
    const spawnLoop = extractFunction(spec,"void","P_SpawnSpecials").match(/sector = sectors;[\s\S]*?(?=\/\/\s*Init line EFFECTs)/)?.[0];
    assert.ok(spawnLoop?.includes("P_SpawnFireFlicker"));
    const crossing = extractFunction(spec,"void","P_CrossSpecialLine");
    const actions = [17,81].map(n => {
        const body = crossing.match(new RegExp("case "+n+":([\\s\\S]*?break;)"));
        assert.ok(body, "missing native light action "+n);
        return body[0];
    }).join("\n");
    const source = path.join(scratch,"lights.c"), exe = path.join(scratch,process.platform==="win32"?"lights.exe":"lights");
    writeFileSync(source,`#include <stdio.h>
#include <stdlib.h>
enum {false,true,ML_TWOSIDED=4,PU_LEVSPEC=51,FASTDARK=15,SLOWDARK=35,STROBEBRIGHT=5,GLOWSPEED=8};
typedef int boolean;
typedef void (*actionf_v)(void);typedef void (*actionf_p1)(void *);
typedef struct thinker_s {struct thinker_s *prev,*next;union {actionf_v acv;actionf_p1 acp1;}function;} thinker_t;
typedef struct sector_s sector_t;
typedef struct {sector_t *frontsector,*backsector;int flags,tag,special;} line_t;
struct sector_s {int lightlevel,special,tag,linecount;line_t *lines[${count}];void *specialdata;};
typedef struct {thinker_t thinker;sector_t *sector;int count,minlight,maxlight;} fireflicker_t;
typedef struct {thinker_t thinker;sector_t *sector;int count,minlight,maxlight,mintime,maxtime;} lightflash_t;
typedef struct {thinker_t thinker;sector_t *sector;int count,minlight,maxlight,darktime,brighttime;} strobe_t;
typedef struct {thinker_t thinker;sector_t *sector;int minlight,maxlight,direction;} glow_t;
static thinker_t thinkercap;
static sector_t sectors[${count+1}];static line_t lines[${count}];static int numsectors=${count+1},totalsecret;
static void Z_Free(void *p){abort();}
static void *Z_Malloc(size_t n,int tag,void *owner){return calloc(1,n);}
static void P_SpawnDoorCloseIn30(sector_t *s){abort();}
static void P_SpawnDoorRaiseIn5Mins(sector_t *s,int i){abort();}
${["P_InitThinkers","P_AddThinker","P_RunThinkers"].map(n=>extractFunction(tick,"void",n)).join("\n")}
${read("light-m_random.c")}
${extractFunction(spec,"sector_t\\*","getNextSector")}
${extractFunction(spec,"int","P_FindMinSurroundingLight")}
${extractFunction(spec,"int","P_FindSectorFromLineTag")}
${["T_FireFlicker","P_SpawnFireFlicker","T_LightFlash","P_SpawnLightFlash","T_StrobeFlash","P_SpawnStrobeFlash",
    "EV_StartLightStrobing","EV_LightTurnOn","T_Glow","P_SpawnGlowingLight"].map(n=>extractFunction(lights,"void",n)).join("\n")}
static void spawnSectorThinkers(void){sector_t *sector;int i;${spawnLoop}}
static void cross(line_t *line){switch(line->special){${actions}}}
int main(void){
    const int types[]={${startup.join(",")}};
    for(int s=1;s<numsectors;++s){
        line_t *l=&lines[s-1];*l=(line_t){&sectors[0],&sectors[s],ML_TWOSIDED,7,0};
        sectors[0].lines[sectors[0].linecount++]=l;sectors[s].lines[sectors[s].linecount++]=l;
        sectors[s].tag=7;
    }
    for(int tic=0;tic<=${finalTic};++tic){
        if(tic==0||tic==${staticTic}||tic==${taggedTic}){
            P_InitThinkers();M_ClearRandom();rndindex=41;
            sectors[0].lightlevel=48;
            for(int s=1;s<numsectors;++s){sectors[s].lightlevel=128+8*(s%12);sectors[s].special=tic?5:types[(s-1)%8];}
            lines[0].special=81;lines[1].special=lines[2].special=17;
            spawnSectorThinkers();
        }
        if(tic==${staticTic})cross(&lines[0]);
        if(tic==${taggedTic}||tic==${taggedTic+1})cross(&lines[1]);
        if(tic==${taggedTic+3})cross(&lines[2]);
        P_RunThinkers();
        int active=0;
        for(thinker_t *t=thinkercap.next;t!=&thinkercap;t=t->next)++active;
        for(int s=1;s<numsectors;++s)printf("sector,%d,%d,%d,%d\\n",tic,s,sectors[s].lightlevel,sectors[s].special);
        printf("end,%d,%d,%d,%d,%d,%d,1\\n",tic,active,prndindex,rndindex,lines[1].special,lines[2].special);
    }
    return 0;
}`);
    run(process.env.CC ?? "gcc", ["-std=c11","-O2","-fno-strict-aliasing",source,"-o",exe]);
    return run(exe,[]).trim().split(/\r?\n/).map(line=>{
        const [tag,...fields]=line.split(",");
        return [tag,...fields.map(Number)];
    });
}
function checkpoints(rows) {
    const end = tic => rows.find(r=>r[0]==="end" && r[1]===tic);
    return {
        startupThinkers: end(0)[2],
        staticBright: rows.filter(r=>r[0]==="sector" && r[1]===staticTic && r[3]===255).length,
        taggedThinkers: end(taggedTic)[2],
        consumedLineThinkers: end(taggedTic+1)[2],
        stackedThinkers: end(taggedTic+3)[2],
        stackedRandom: end(taggedTic+3)[3],
    };
}
try {
    const expected = {startupThinkers:count, staticBright:count, taggedThinkers:count,
        consumedLineThinkers:count, stackedThinkers:2*count, stackedRandom:2*count};
    const actual = compiledRows();
    assert.deepEqual(checkpoints(actual), expected, "startup lights, static changes, one-shot consumption, and independent strobes");
    if (upstream) {
        const native = nativeRows();
        assert.deepEqual(checkpoints(native), expected);
        assert.equal(actual.length, native.length);
        for (const [i, row] of actual.entries()) assert.deepEqual(row, native[i], `light trace row ${i}`);
    }
    const digest = createHash("sha256").update(JSON.stringify(actual)).digest("hex");
    assert.equal(digest, "18b59466aa1d2d49d5d8bdd95327e3a296f2538c23c5d7e52377d5ff9eb56991",
        "pinned native lighting trace");
    console.log(`Matched ${actual.length} rows for ${count} startup lights, ${count} static changes, and ${2 * count} overlapping strobes. SHA-256 ${digest}.`);
} finally {
    rmSync(scratch,{recursive:true,force:true});
}
