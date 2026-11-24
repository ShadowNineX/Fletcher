// W1/WR raise-to-texture includes both sidedefs' raw texture numbers, even zero.
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
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const scratch = mkdtempSync(path.join(os.tmpdir(), "fletcher-floor-texture-"));
const unit = 65536;
const steps = 26;
const cases = [
    { front: "SHORT", back: "TALL", special: 30, rise: 8 },
    { front: "TALL", back: "sHoRt", special: 96, rise: 8 },
    { front: "SHORT", back: "SHORT", special: 30, rise: 8 },
    { front: "-", back: "TALL", special: 96, rise: 8 },
    { front: "TALL", back: "TALL", special: 30, rise: 24 },
    { front: "SHORT", back: "TALL", special: 96, isolated: true },
];

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function words(values) {
    const bytes = Buffer.alloc(2 * values.length);
    values.forEach((value, i) => bytes.writeUInt16LE(value & 65535, 2 * i));
    return bytes;
}

function makeMap(test) {
    // Two adjoining rooms share the trigger. A separate room provides the
    // sector without two-sided lines while the trigger remains crossable.
    const vertices = words([-128, -64, -128, 64, 0, 64, 0, -64, 128, 64, 128, -64, 192, -64, 192, 64, 256, 64, 256, -64]);
    const edges = [[2, 3, 0, 1], [0, 1, 0, -1], [1, 2, 0, -1], [3, 0, 0, -1],
        [2, 4, 1, -1], [4, 5, 1, -1], [5, 3, 1, -1], [6, 7, 2, -1], [7, 8, 2, -1], [8, 9, 2, -1], [9, 6, 2, -1]];
    const lines = words(edges.flatMap(([a, b, front, back], i) =>
        [a, b, back < 0 ? 1 : 4, i === 0 ? test.special : 0, i === 0 ? 7 : 0, front, back]));
    const sides = Buffer.alloc(90), sectors = Buffer.alloc(78);
    for (const [i, lower] of [test.front, test.back, "-"].entries()) {
        sides.write(lower, i * 30 + 12);
        sides.writeUInt16LE(i, i * 30 + 28);
        sectors.writeInt16LE(-16, i * 26);
        sectors.writeInt16LE(128, i * 26 + 2);
    }
    sectors.writeInt16LE(7, (test.isolated ? 2 : 0) * 26 + 24);
    const order = [1, 2, 0, 3, 0, 4, 5, 6, 7, 8, 9, 10];
    const angles = [0x4000, 0, 0xc000, 0x8000];
    const segs = words(order.flatMap((line, i) => {
        const [a, b] = edges[line], angle = angles[i % 4];
        return i === 4 ? [b, a, angle, line, 1, 0] : [a, b, angle, line, 0, 0];
    }));
    const nodes = words([0, -64, 0, 128, 64, -64, 0, 128, 64, -64, -128, 0, 0x8001, 0x8000,
        160, -64, 0, 128, 64, -64, 192, 256, 64, -64, -128, 128, 0x8002, 0]);
    const textures = Buffer.alloc(56);
    textures.writeInt32LE(2);
    for (const [i, name] of ["SHORT", "TALL"].entries()) {
        const offset = 12 + 22 * i;
        textures.writeInt32LE(offset, 4 + 4 * i);
        textures.write(name, offset);
        textures.writeInt16LE(16, offset + 12);
        textures.writeInt16LE(i ? 24 : 8, offset + 14);
    }
    const lumps = [["MAP01", Buffer.alloc(0)], ["THINGS", words([-64, 0, 0, 1, 7])], ["LINEDEFS", lines], ["SIDEDEFS", sides],
        ["VERTEXES", vertices], ["SEGS", segs], ["SSECTORS", words([4, 0, 4, 4, 4, 8])], ["NODES", nodes], ["SECTORS", sectors],
        ["REJECT", Buffer.alloc(2)], ["BLOCKMAP", words([-128, -128, 3, 2, ...Array(6).fill(10), 0, ...edges.keys(), -1])],
        ["PNAMES", Buffer.alloc(4)], ["TEXTURE1", textures]];
    const directory = 12 + lumps.reduce((size, [, data]) => size + data.length, 0);
    const file = Buffer.alloc(directory + lumps.length * 16);
    file.write("PWAD");
    file.writeInt32LE(lumps.length, 4);
    file.writeInt32LE(directory, 8);
    let offset = 12;
    for (const [i, [name, data]] of lumps.entries()) {
        const entry = directory + 16 * i;
        file.writeInt32LE(offset, entry);
        file.writeInt32LE(data.length, entry + 4);
        file.write(name, entry + 8);
        data.copy(file, offset);
        offset += data.length;
    }
    return file;
}

function preview() {
    for (const [i, test] of cases.entries()) writeFileSync(path.join(scratch, `case${i}.wad`), makeMap(test));
    const entry = path.join(scratch, "main.flt"), out = path.join(scratch, "fixture.json");
    writeFileSync(entry, `package main
import "play"
import "wad"
${cases.map((_, i) => `const map${i} = readFile("case${i}.wad")`).join("\n")}
map "Raise to shortest lower texture" {
    screen at (0, 0) size (1, 1) with {style = "solid", hold = true, slice = true}
    tick {
        file, target := map0, 0
        switch currentTick() {
${cases.map((test, i) => `        case ${i}: file, target = map${i}, ${test.isolated ? 2 : 0}`).join("\n")}
        }
        level := wad.LoadBspLevel(file, wad.LE32(file, 8))
        state := play.CrossLevelSpecial(level, play.LevelSpecials{}, 0)
        handle := state.Floors.FindSector(target)
        motion := state.Floors.EntryAt(handle).Motion
        for step := range ${steps} {
            live := state.ApplyTo(level)
            log(currentTick(), step, state.Floors.Count, live.SectorHeightsAt(target).Floor, motion.Destination, live.LineAt(0).Action)
            state = play.TickLevelMoversAt(level, wad.BlockMapInfo{}, state, play.MapActor{X: -(64 << 16)}, step).State
        }
    }
}`);
    run("dotnet", [cli, "build", entry, "--package-root", path.join(root, "examples/doom-engine"), "--asset-root", scratch, "-o", out]);
    const sim = simulator(decode(JSON.parse(readFileSync(out, "utf8")).data), true);
    for (let i = 0; i < 350 && sim.logs.length < steps * cases.length; i++) sim.step();
    return Array.from(sim.logs, row => Array.from(row, Number));
}

function native(upstream) {
    const read = name => readFileSync(path.join(upstream, name), "utf8").replaceAll("\r\n", "\n");
    const floor = read("door-p_floor.c"), spec = read("animated-p_spec.c");
    const crossing = extractFunction(spec, "void", "P_CrossSpecialLine");
    const unused = [...new Set(crossing.match(/\b(?:EV_|G_)[A-Za-z]+\b/g))].filter(name => name !== "EV_DoFloor");
    const entry = path.join(scratch, "floor.c"), exe = path.join(scratch, "floor.exe");
    writeFileSync(entry, `#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <strings.h>
typedef int fixed_t,boolean;
typedef struct { int type,player; } mobj_t;
typedef enum { ok,crushed,pastdest } result_e;
enum {false,true,FRACUNIT=65536,FLOORSPEED=65536,MAXINT=INT_MAX,sfx_stnmov=1,sfx_pstop=2,
    PU_LEVSPEC=51,ML_TWOSIDED=4};
typedef enum {lowerFloor,lowerFloorToLowest,turboLower,raiseFloor,raiseFloorToNearest,raiseToTexture,
    lowerAndChange,raiseFloor24,raiseFloor24AndChange,raiseFloorCrush,raiseFloorTurbo,donutRaise,raiseFloor512} floor_e;
enum {MT_ROCKET,MT_PLASMA,MT_BFG,MT_TROOPSHOT,MT_HEADSHOT,MT_BRUISERSHOT};
typedef void (*actionf_p1)(void*);
typedef struct { struct { actionf_p1 acp1; } function; } thinker_t;
typedef struct sector_s sector_t;
typedef struct { sector_t *frontsector; int special,tag,flags,sidenum[2]; } line_t;
struct sector_s { fixed_t floorheight,ceilingheight; int linecount,special,floorpic,tag; mobj_t soundorg;
    line_t *lines[4]; void *specialdata; };
typedef struct { int bottomtexture; sector_t *sector; } side_t;
typedef struct { thinker_t thinker; sector_t *sector; int type,direction,newspecial,texture,crush; fixed_t speed,floordestheight; } floormove_t;
typedef struct { char name[8]; } texture_t;
static texture_t names[]={{"SHORT"},{"TALL"}}, *textures[]={names,names+1};
static int numtextures=2,textureheight[]={8*FRACUNIT,24*FRACUNIT},leveltime,numsectors=3;
static sector_t sectors[3];
static line_t lines[2]; // A two-sided portal and a representative ordinary boundary.
static side_t sides[2];
static floormove_t mover;
static void *Z_Malloc(size_t size,int tag,void *user) { assert(size==sizeof(mover)); return &mover; }
static void P_AddThinker(thinker_t *thinker) { assert(thinker==&mover.thinker); }
static int P_ChangeSector(sector_t *sector,int crush) { return 0; }
static void P_RemoveThinker(thinker_t *thinker) { assert(thinker==&mover.thinker); }
static void S_StartSound(mobj_t *origin,int sound) {}
#define P_FindHighestFloorSurrounding(...) (abort(),0)
#define P_FindLowestFloorSurrounding(...) (abort(),0)
#define P_FindNextHighestFloor(...) (abort(),0)
#define P_FindLowestCeilingSurrounding(...) (abort(),0)
${extractFunction(spec, "int", "P_FindSectorFromLineTag")}
${extractFunction(spec, "side_t\\*", "getSide")}
${extractFunction(spec, "sector_t\\*", "getSector")}
${extractFunction(spec, "int", "twoSided")}
${extractFunction(read("r_data.c"), "int", "R_CheckTextureNumForName")}
${extractFunction(floor, "result_e", "T_MovePlane")}
${extractFunction(floor, "void", "T_MoveFloor")}
${extractFunction(floor, "int", "EV_DoFloor")}
${unused.map(name => `#define ${name}(...) abort()`).join("\n")}
${crossing}
static void trace(int idx,char *front,char *back,int special,int isolatedSector) {
    sector_t *sector=&sectors[isolatedSector ? 2 : 0];
    mobj_t player={.player=1};
    sectors[0].tag=sectors[2].tag=0;
    *sector=(sector_t){.floorheight=-16*FRACUNIT,.ceilingheight=128*FRACUNIT,.tag=7,.linecount=4,
        .lines={isolatedSector ? &lines[1] : &lines[0],&lines[1],&lines[1],&lines[1]}};
    lines[0]=(line_t){.frontsector=sectors,.special=special,.tag=7,.flags=ML_TWOSIDED,.sidenum={0,1}};
    sides[0].bottomtexture=R_CheckTextureNumForName(front);
    sides[1].bottomtexture=R_CheckTextureNumForName(back);
    P_CrossSpecialLine(0,0,&player);
    assert(sector->specialdata==&mover);
    for (leveltime=0;leveltime<${steps};leveltime++) {
        printf("%d %d %d %d %d %d\\n",idx,leveltime,!!sector->specialdata,sector->floorheight,mover.floordestheight,lines[0].special);
        if (sector->specialdata) T_MoveFloor(&mover);
    }
}
int main(void) {
${cases.map((c, i) => `    trace(${i},"${c.front}","${c.back}",${c.special},${Number(!!c.isolated)});`).join("\n")}
    return 0;
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", entry, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(row => row.split(" ").map(Number));
}

try {
    const rows = preview();
    assert.equal(rows.length, steps * cases.length);
    for (const [i, step, active, height, destination, special] of rows) {
        const test = cases[i], rise = test.rise ?? Infinity;
        assert.deepEqual([active, height, destination, special], [Number(step <= rise), (-16 + Math.min(step, rise)) * unit,
            test.isolated ? 0x7fffffff - 16 * unit : (rise - 16) * unit, test.special === 30 ? 0 : 96],
            `case ${i} (${test.front}/${test.back}), step ${step}`);
    }
    if (values.upstream) assert.deepEqual(rows, native(path.resolve(root, values.upstream)), "pinned lower-texture heights and floor motion");
    console.log(`Verified ${rows.length} raise-to-texture floor snapshots across W1 and WR triggers.`);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
