// Drive paired floor and ceiling actions and tagged crushers with original WAD geometry.
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
const { values } = parseArgs({ options: { wad: { type: "string" }, upstream: { type: "string" }, cli: { type: "string" } } });
assert.ok(values.wad, "Pass --wad PATH to the original Ultimate Doom IWAD");
const wad = path.resolve(values.wad);
const upstream = path.resolve(root, values.upstream ?? "artifacts/doom-upstream");
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const unit = 65536;

function mapRecords(data, name) {
    assert.equal(data.toString("ascii", 0, 4), "IWAD");
    const count = data.readUInt32LE(4), directory = data.readUInt32LE(8);
    assert.ok(directory + 16 * count <= data.length, "valid directory extent");
    const entries = Array.from({ length: count }, (_, i) => {
        const offset = directory + 16 * i;
        return { offset, name: data.toString("ascii", offset + 8, offset + 16).replace(/\0.*$/, "") };
    });
    const index = entries.findLastIndex(entry => entry.name === name);
    assert.ok(index >= 0, `${name} is present`);
    function lump(lumpName, stride) {
        const entry = entries.slice(index + 1, index + 11).find(entry => entry.name === lumpName);
        assert.ok(entry, `${name} has ${lumpName}`);
        const offset = data.readUInt32LE(entry.offset), length = data.readUInt32LE(entry.offset + 4);
        assert.ok(offset + length <= data.length && length % stride === 0, `valid ${lumpName} extent`);
        return Array.from({ length: length / stride }, (_, i) => data.subarray(offset + i * stride, offset + (i + 1) * stride));
    }
    const sides = lump("SIDEDEFS", 30);
    const sectors = lump("SECTORS", 26).map(record => ({
        floor: record.readInt16LE(0), ceiling: record.readInt16LE(2), tag: record.readInt16LE(24),
    }));
    const lines = lump("LINEDEFS", 14).map(record => {
        const side = n => sides[record.readUInt16LE(n)]?.readUInt16LE(28) ?? -1;
        return { flags: record.readUInt16LE(4), action: record.readInt16LE(6), tag: record.readInt16LE(8),
            front: side(10), back: side(12) };
    });
    const starts = lump("THINGS", 10).filter(record => record.readUInt16LE(6) === 1);
    assert.equal(starts.length, 1, "original player one start");
    const [x, y] = [0, 2].map(offset => starts[0].readInt16LE(offset) * unit);
    return { name, lines, sectors, x, y, marker: entries[index].offset };
}

function select(map, tag, special) {
    return map.lines.flatMap((line, i) => line.action === special && line.tag === tag ? [i] : []);
}

function fixture(map, tags, tics, trials) {
    const targets = map.sectors.flatMap((sector, i) => tags.includes(sector.tag) ? [i] : []);
    const triggers = [...new Set(trials.flatMap(events => events.map(([, line]) => line)))].sort((a, b) => a - b);
    assert.ok(targets.length && triggers.every(line => Number.isInteger(line)), `${map.name} has the test sectors and triggers`);
    return { map, tags, tics, trials, targets, triggers };
}

function pairedMovers(map) {
    const raises = select(map, 6, 40), lowers = select(map, 6, 38);
    const single = select(map, 14, 44);
    assert.deepEqual([raises.length, lowers.length, single.length], [4, 4, 1], "original E3M5 triggers");
    const trials = [
        [raises[0], lowers[0], ...raises.slice(1), ...lowers.slice(1)],
        [lowers[0], raises[0], ...lowers.slice(1), ...raises.slice(1)],
    ].map((lines, trial) => [...lines.map((line, index) => [index < 5 ? index : (trial ? 94 : 70) + index - 5, line]), [8, single[0]]]);
    return fixture(map, [6, 14], 176, trials);
}

function sharedCrushers(map) {
    const normal = select(map, 16, 73), stop = select(map, 16, 74), fast = select(map, 16, 77);
    const trials = [
        [[0, normal[0]], [29, stop[0]], [42, fast[0]], [79, normal[1]], [109, stop[1]], [121, fast[1]],
            [154, normal[2]], [169, stop[2]], [180, normal[3]], [210, normal[4]]],
        [[0, fast[1]], [40, stop[0]], [55, normal[4]], [80, fast[0]], [89, stop[1]], [103, normal[3]],
            [147, normal[2]], [158, stop[2]], [169, normal[1]], [226, normal[0]]],
    ];
    return fixture(map, [16], 256, trials);
}

function separateCrushers(map) {
    const normal = select(map, 9, 73)[0], stoppedNormal = select(map, 9, 74);
    const fast = select(map, 11, 77), stoppedFast = select(map, 11, 74);
    const other = select(map, 23, 73)[0], stoppedOther = select(map, 23, 74);
    const events = [[0, normal], [1, fast[0]], [2, other], [20, stoppedNormal[0]], [34, fast[1]],
        [40, stoppedFast[0]], [45, normal], [54, stoppedOther[0]], [55, fast[2]], [67, stoppedFast[1]],
        [73, stoppedOther[1]], [75, fast[3]], [80, other], [122, stoppedNormal[1]], [135, normal],
        [162, stoppedOther[2]], [190, other]];
    return fixture(map, [9, 11, 23], 320, [events]);
}

function oneShotCrushers(map) {
    const [line] = select(map, 9, 25);
    return fixture(map, [9], 256, [[[0, line], [50, line]]]);
}

const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-e3m5-movers-"));

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 120000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function fletcherRows({ map, tags, tics, trials, targets, triggers }) {
    const source = path.join(scratch, "main.flt"), output = path.join(scratch, "map.json");
    writeFileSync(source, `package main
import "play"
import "wad"
const Archive = readFile(${JSON.stringify(path.basename(wad))})
const Triggers = [${triggers.length}]int{${triggers.join(", ")}}
const Targets = [${targets.length}]int{${targets.join(", ")}}
map "${map.name} sector movers" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register state play.LevelSpecials = play.LevelSpecials{}
    register trial int = 0
    register tic int = 0
    tick {
        if trial < ${trials.length} {
            base := wad.LoadBspLevel(Archive, ${map.marker})
            player := play.MapActor{X: ${map.x}, Y: ${map.y}, Height: 16 << 16}
            occupied := base.SectorAtPoint(player.X, player.Y)
            if !base.Valid || !occupied.Valid || ${tags.map(tag => `base.SectorTag(occupied.Index) == ${tag}`).join(" || ")} {
                log("invalid test setup")
            }
            nextState := state
            line := -1
            switch trial {
${trials.map((events, trial) => `            case ${trial}:
                switch tic {
${events.map(([age, index]) => `                case ${age}: line = ${index}`).join("\n")}
                }`).join("\n")}
            }
            if line >= 0 { nextState = play.CrossLevelSpecial(state.ApplyTo(base), state, line) }
            moved := play.TickLevelMoversAt(base, wad.BlockMapInfo{}, nextState, player, tic)
            if !moved.Valid { log("invalid mover tic", trial, tic) }
            nextState = moved.State
            live := nextState.ApplyTo(base)
            consumed := 0
            for index := range ${triggers.length} {
                if live.LineAt(Triggers[index]).Action == 0 { consumed = consumed | (1 << index) }
            }
            log(trial, tic, consumed, nextState.Floors.Count, nextState.Ceilings.Count, nextState.Ceilings.TrackedCount, moved.Sounds.Count)
            for index := range ${targets.length} {
                sector := Targets[index]
                height := live.SectorHeightsAt(sector)
                ceiling := nextState.Ceilings.EntryAt(nextState.Ceilings.FindSector(sector)).Motion
                log(sector, height.Floor, height.Ceiling, nextState.MoverOccupied(sector),
                    ceiling.Mode, ceiling.Direction, ceiling.OldDirection, ceiling.Speed, ceiling.Top, ceiling.Bottom, ceiling.Crush)
            }
            for index := range moved.Sounds.Count {
                sound := moved.Sounds.At(index)
                log(sound.Id, sound.Sector)
            }
            next state = nextState
            next tic = tic + 1
            if tic + 1 == ${tics} {
                next state = play.LevelSpecials{}
                next tic = 0
                next trial = trial + 1
            }
            if trial == ${trials.length - 1} && tic == ${tics - 1} { log("mover test complete") }
        }
    }
}
`);
    run("dotnet", [cli, "build", source, "--package-root", path.join(root, "examples/doom-engine"), "--asset-root", path.dirname(wad), "-o", output]);
    const payload = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(payload, "base64")[2], 1, "the private IWAD import remains compressed");
    const sim = simulator(decode(payload), true);
    for (let host = 0; host < 16000 && sim.logs.at(-1)?.[0] !== "mover test complete"; host++) sim.step();
    assert.equal(sim.logs.pop()?.[0], "mover test complete", "mover simulation finished");
    assert.ok(sim.logs.every(row => typeof row[0] === "number"), JSON.stringify(sim.logs.find(row => typeof row[0] !== "number")));
    return Array.from(sim.logs, row => Array.from(row, Number));
}

function nativeRows({ map, tics, trials, targets, triggers }) {
    const read = name => readFileSync(path.join(upstream, name), "utf8").replaceAll("\r\n", "\n");
    const spec = read("p_spec.c"), floor = read("door-p_floor.c"), ceiling = read("ceiling-p_ceilng.c"), tick = read("p_tick.c");
    const from = (file, type, name) => extractFunction(file, type, name);
    const cross = from(spec, "void", "P_CrossSpecialLine");
    const unused = [...new Set(cross.match(/\b(?:EV_|G_)[A-Za-z]+\b/g))]
        .filter(name => !["EV_DoCeiling", "EV_DoFloor", "EV_CeilingCrushStop"].includes(name));
    const connected = new Set(targets);
    const boundary = map.lines.flatMap(({ front, back }, index) =>
        connected.has(front) || connected.has(back) || triggers.includes(index) ? [index] : []);
    const source = path.join(scratch, "native.c"), exe = path.join(scratch, process.platform === "win32" ? "native.exe" : "native");
    writeFileSync(source, `#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define FRACUNIT ${unit}
#define FLOORSPEED FRACUNIT
#define CEILSPEED FRACUNIT
#define MAXCEILINGS 30
#define MAXINT INT_MAX
#define MAX_ADJOINING_SECTORS 20
enum {false, true, ML_TWOSIDED=4, PU_LEVSPEC=51, sfx_stnmov=22, sfx_pstop=19};
enum {MT_ROCKET=33, MT_PLASMA, MT_BFG, MT_TROOPSHOT=31, MT_HEADSHOT, MT_BRUISERSHOT=16};
typedef int fixed_t, boolean;
typedef struct { int player, type; } mobj_t;
typedef struct thinker_s thinker_t;
typedef void (*actionf_p1)(void *);
typedef void (*actionf_v)(void);
struct thinker_s { thinker_t *prev, *next; union { actionf_p1 acp1; actionf_v acv; } function; };
typedef struct sector_s sector_t;
typedef struct { sector_t *frontsector, *backsector; int flags, special, tag, sidenum[2]; } line_t;
struct sector_s { fixed_t floorheight, ceilingheight; int tag, floorpic, special, linecount; line_t **lines; void *specialdata; mobj_t soundorg; };
typedef struct { int bottomtexture; sector_t *sector; } side_t;
typedef enum { ok, crushed, pastdest } result_e;
typedef enum { lowerToFloor, raiseToHighest, lowerAndCrush, crushAndRaise, fastCrushAndRaise, silentCrushAndRaise } ceiling_e;
typedef enum { lowerFloor, lowerFloorToLowest, turboLower, raiseFloor, raiseFloorToNearest, raiseToTexture,
    lowerAndChange, raiseFloor24, raiseFloor24AndChange, raiseFloorCrush, raiseFloorTurbo, donutRaise, raiseFloor512 } floor_e;
typedef struct { thinker_t thinker; sector_t *sector; ceiling_e type; fixed_t bottomheight, topheight, speed;
    int direction, tag, olddirection; boolean crush; } ceiling_t;
typedef struct { thinker_t thinker; sector_t *sector; floor_e type; int direction, newspecial, texture;
    boolean crush; fixed_t speed, floordestheight; } floormove_t;
static thinker_t thinkercap;
static sector_t sectors[${map.sectors.length}];
static line_t lines[${map.lines.length}];
static int numsectors=${map.sectors.length}, leveltime, textureheight[1];
static const int targets[]={${targets.join(", ")}}, triggers[]={${triggers.join(", ")}};
static const int commands[][3]={${trials.flatMap((commands, trial) => commands.map(([age, line]) => `{${trial},${age},${line}}`)).join(",")}};
enum { targetCount=${targets.length}, triggerCount=${triggers.length}, commandCount=sizeof commands/sizeof commands[0] };
static int sounds[targetCount*2][2], soundCount;
static void *blocks[128];
static size_t used;
static void *Z_Malloc(size_t n,int tag,void *user) {
    assert(used < sizeof blocks / sizeof blocks[0]);
    blocks[used] = calloc(1, n);
    assert(blocks[used]);
    return blocks[used++];
}
// The native iterator still reads next after Z_Free. Release after the trial.
static void Z_Free(void *block) {}
static void S_StartSound(mobj_t *origin,int sound) {
    assert(soundCount < targetCount*2);
    for (int i=0;i<targetCount;++i) {
        const int sector=targets[i];
        if (origin != &sectors[sector].soundorg) continue;
        sounds[soundCount][0]=sound;
        sounds[soundCount++][1]=sector;
        return;
    }
    abort();
}
static int P_ChangeSector(sector_t *sector,int crush) { return 0; }
static int twoSided(int sector,int line) { abort(); }
static side_t *getSide(int sector,int line,int side) { abort(); }
static sector_t *getSector(int sector,int line,int side) { abort(); }
void P_AddActiveCeiling(ceiling_t *c);
void P_RemoveActiveCeiling(ceiling_t *c);
void P_ActivateInStasisCeiling(line_t *line);
${["P_InitThinkers","P_AddThinker","P_RemoveThinker","P_RunThinkers"].map(name => from(tick,"void",name)).join("\n")}
${from(spec, "sector_t\\*", "getNextSector")}
${from(spec, "int", "P_FindSectorFromLineTag")}
${["P_FindLowestFloorSurrounding","P_FindHighestFloorSurrounding","P_FindNextHighestFloor",
    "P_FindLowestCeilingSurrounding","P_FindHighestCeilingSurrounding"].map(name => from(spec,"fixed_t",name)).join("\n")}
${from(floor, "result_e", "T_MovePlane")}
${from(floor, "void", "T_MoveFloor")}
${from(floor, "int", "EV_DoFloor")}
${ceiling.slice(ceiling.search(/ceiling_t\s*\*\s*activeceilings\s*\[/))}
${unused.map(name => `#define ${name}(...) (abort(),0)`).join("\n")}
${cross}
static void load(void) {
    P_InitThinkers();
    memset(activeceilings, 0, sizeof activeceilings);
    memset(sectors, 0, sizeof sectors);
    memset(lines, 0, sizeof lines);
${map.sectors.map(({ floor, ceiling, tag }, i) => `    sectors[${i}]=(sector_t){.floorheight=${floor}*FRACUNIT,.ceilingheight=${ceiling}*FRACUNIT,.tag=${tag}};`).join("\n")}
${boundary.map(i => {
    const { front, back, flags, action, tag } = map.lines[i];
    const sector = index => index < 0 ? "NULL" : `&sectors[${index}]`;
    return `    lines[${i}]=(line_t){.frontsector=${sector(front)},.backsector=${sector(back)},.flags=${flags},.special=${action},.tag=${tag}};`;
}).join("\n")}
${targets.map(i => {
    const attached = boundary.filter(line => map.lines[line].front === i || map.lines[line].back === i);
    return `    static line_t *neighbors${i}[]={${attached.map(line => `&lines[${line}]`).join(",")}};
    sectors[${i}].linecount=${attached.length}; sectors[${i}].lines=neighbors${i};`;
}).join("\n")}
}
int main(void) {
    mobj_t player={.player=1};
    for (int trial=0; trial<${trials.length}; ++trial) {
        load();
        for (leveltime=0; leveltime<${tics}; ++leveltime) {
            soundCount=0;
            for (int i=0;i<commandCount;++i) if (commands[i][0]==trial && commands[i][1]==leveltime)
                P_CrossSpecialLine(commands[i][2],0,&player);
            P_RunThinkers();
            int mask=0, floors=0, tracked=0;
            for (int i=0;i<triggerCount;++i) if (!lines[triggers[i]].special) mask |= 1<<i;
            for (int i=0;i<targetCount;++i) {
                thinker_t *owner=sectors[targets[i]].specialdata;
                if (owner && owner->function.acp1 == (actionf_p1)T_MoveFloor) ++floors;
            }
            for (int i=0;i<MAXCEILINGS;++i) tracked += activeceilings[i]!=NULL;
            printf("%d,%d,%d,%d,%d,%d,%d\\n",trial,leveltime,mask,floors,tracked,tracked,soundCount);
            for (int i=0;i<targetCount;++i) {
                sector_t *target=&sectors[targets[i]];
                ceiling_t empty={0}, *motion=&empty;
                for (int slot=0;slot<MAXCEILINGS;++slot)
                    if (activeceilings[slot] && activeceilings[slot] == target->specialdata) motion=activeceilings[slot];
                printf("%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\\n",targets[i],target->floorheight,target->ceilingheight,target->specialdata!=NULL,
                    motion == &empty ? 0 : motion->type+1,motion->direction,motion->olddirection,motion->speed,motion->topheight,
                    motion->bottomheight,motion->crush);
            }
            for (int i=0;i<soundCount;++i) printf("%d,%d\\n",sounds[i][0],sounds[i][1]);
        }
        for (size_t index=0;index<used;++index) free(blocks[index]);
        used=0;
    }
}
`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(line => line.split(",").map(Number));
}

function compare(fixture) {
    const { map, trials, tics, targets, triggers } = fixture;
    const native = nativeRows(fixture), compiled = fletcherRows(fixture);
    assert.equal(compiled.length, native.length);
    let offset = 0;
    const frames = trials.map((_, trial) => Array.from({ length: tics }, (__, tic) => {
        const metadata = native[offset];
        assert.deepEqual(metadata.slice(0, 2), [trial, tic]);
        const stride = 1 + targets.length + metadata[6];
        const end = offset + stride;
        assert.deepEqual(compiled.slice(offset, end), native.slice(offset, end), `${map.name} trial ${trial}, tic ${tic}`);
        const sectors = native.slice(offset + 1, offset + 1 + targets.length);
        offset = end;
        return { metadata, sectors };
    }));
    assert.equal(offset, native.length, "all mover and sound rows were compared");
    console.log(`${map.name}: ${triggers.length} original linedefs matched pinned C across ${trials.length * tics} tics and ${offset} rows.`);
    return frames;
}

function verifyPaired(frames, fixture) {
    assert.deepEqual(frames[0][1].metadata.slice(2, 6), [17, 0, 8, 8], "the early floor trigger is consumed while ceilings own the targets");
    assert.deepEqual(frames[1][1].metadata.slice(2, 6), [17, 8, 0, 0], "the early ceiling trigger is consumed while floors own the targets");
    for (const trial of frames) {
        const final = trial.at(-1);
        assert.deepEqual(final.metadata.slice(2, 6), [511, 0, 0, 0], "all lines are consumed and the movers finish");
        for (const [sector, floor, height, occupied] of final.sectors) {
            const lowering = fixture.map.sectors[sector].tag === 14;
            assert.deepEqual([floor, height, occupied], lowering ? [8 * unit, 16 * unit, 0] : [0, 128 * unit, 0]);
        }
        const lowering = trial[8].sectors.find(row => fixture.map.sectors[row[0]].tag === 14);
        assert.deepEqual([lowering[4], lowering[5], lowering[10]], [3, -1, 0], "special 44 lowers once with the native noncrushing flag");
    }
}

function verifyShared(frames) {
    for (const [trial, freeze, restart, expectedMode, expectedSpeed] of [[0, 29, 42, 4, unit], [1, 40, 55, 5, 2 * unit]]) {
        const timeline = frames[trial];
        for (const [i, stopped] of timeline[freeze].sectors.entries()) {
            const [sector, , height, occupied, mode, direction, old, speed] = stopped;
            const prior = timeline[freeze - 1].sectors[i], resumed = timeline[restart].sectors[i];
            assert.deepEqual([sector, height, occupied, mode, direction, old, speed], [prior[0], prior[2], 1, expectedMode, 0, prior[5], expectedSpeed]);
            assert.deepEqual(timeline[restart - 1].sectors[i], stopped, "stasis keeps the whole thinker unchanged");
            assert.equal(resumed[4], mode, "the other start linedef resumes the existing crusher mode");
            assert.equal(resumed[7], speed, "resuming preserves the speed");
            assert.ok(resumed[5] && resumed[2] !== height, "resuming advances the ceiling again");
        }
    }
}

function verifySeparate(frames, fixture) {
    const timeline = frames[0];
    const [tag9, tag11] = [9, 11].map(tag => fixture.targets.findIndex(sector => fixture.map.sectors[sector].tag === tag));
    assert.equal(timeline[20].sectors[tag9][5], 0, "tag 9 stops");
    assert.equal(timeline[20].sectors[tag9][2], timeline[19].sectors[tag9][2]);
    assert.equal(timeline[20].sectors[tag11][5], -1, "tag 11 keeps descending during a stop for tag 9");
    assert.equal(timeline[20].sectors[tag11][2] - timeline[19].sectors[tag11][2], -2 * unit);
    assert.equal(timeline[45].sectors[tag11][5], 0, "tag 11 stays stopped as tag 9 restarts");
    assert.equal(timeline[45].sectors[tag9][5], -1);
    assert.equal(timeline[45].sectors[tag9][2] - timeline[44].sectors[tag9][2], -unit);
}

function verifyOneShot([timeline]) {
    assert.ok(timeline.every(frame => frame.metadata[2] === 1), "the once-only crusher consumes its line");
    assert.ok(timeline[0].sectors.every(row => row[4] === 4 && row[5] === -1 && row[10] === 1));
    assert.ok(timeline.some(frame => frame.sectors.every(row => row[5] === 1)), "the crushers reach their lower endpoint and reverse");
    assert.ok(timeline.at(-1).sectors.every(row => row[5] === -1), "the crushers reach the top and start the next descent");
}

try {
    const data = readFileSync(wad);
    const paired = pairedMovers(mapRecords(data, "E3M5"));
    verifyPaired(compare(paired), paired);
    verifyShared(compare(sharedCrushers(mapRecords(data, "E2M2"))));
    const separate = separateCrushers(mapRecords(data, "E2M4"));
    verifySeparate(compare(separate), separate);
    verifyOneShot(compare(oneShotCrushers(mapRecords(data, "E4M7"))));
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-e3m5-movers-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
