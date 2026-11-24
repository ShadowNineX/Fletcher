import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-platforms-"));
const lastTic = 240;
const cases = [
    { mode: 1, random: 0, blocked: [2, 123] },
    { mode: 2, random: 0, blocked: [1, 115] },
    { mode: 3, random: 0, blocked: [] },
    { mode: 4, random: 0, blocked: [] },
    { mode: 5, random: 0, blocked: [2] },
    { mode: 1, random: 1, blocked: [] },
    { mode: 4, random: 0, blocked: [6] },
];
const geometry = { floor: 10, low: 0, high: 16, next: 13, amount: 5 };
const unit = 65536;
const pinnedDigest = "046d4bafaabb030f04ae19d916bc1b136a022ec2467df4173c497bb436a834d4";
const pinnedTriggerDigest = "94404d2b726120e719bbd92555a8fe33d0923cd8bd5b6e929a37c2b4f4a61ad6";
const triggers = [
    ...[10, 22, 53, 54, 87, 88, 89, 95, 120, 121].map(special => ({ special, kind: "cross", seed: [54, 89].includes(special) })),
    ...[14, 15, 20, 21, 62, 66, 67, 68, 122, 123].map(special => ({ special, kind: "use" })),
    { special: 47, kind: "shoot" },
    { special: 10, kind: "cross", seed: true },
    { special: 14, kind: "use", seed: true },
    { special: 47, kind: "shoot", seed: true },
    { special: 47, kind: "shoot", monster: true },
    { special: 20, kind: "use", back: true },
    { special: 87, kind: "cross", seed: true, stopped: true },
];
const triggerTicks = 4;

function triggerFixture() {
    function words(fields) {
        const bytes = Buffer.alloc(2 * fields.length);
        fields.forEach((value, i) => bytes.writeUInt16LE(value, i * 2));
        return bytes;
    }
    const heights = [geometry.low, geometry.floor, geometry.next, geometry.high];
    const sectors = Buffer.alloc(26 * heights.length), sides = Buffer.alloc(30 * heights.length);
    for (const [index, floor] of heights.entries()) {
        const tagged = index === 1;
        sectors.writeUInt16LE(floor, index * 26);
        sectors.writeUInt16LE(128, index * 26 + 2);
        sectors.write(tagged ? "OLD" : "NEW", index * 26 + 4);
        sectors.writeUInt16LE(tagged ? 7 : 0, index * 26 + 22);
        sectors.writeUInt16LE(tagged ? 7 : 0, index * 26 + 24);
        sides.writeUInt16LE(index, index * 30 + 28);
    }
    const specialLines = [...triggers.map(entry => entry.special), 87, 89];
    const lines = [...specialLines.map(special => [0, 1, 4, special, 7, 0, 1]),
        [0, 1, 4, 0, 0, 1, 2], [0, 1, 4, 0, 0, 1, 3]];
    const records = [["Sectors", 4, sectors], ["Sides", 4, sides], ["Vertices", 2, words([0, 0, 0, 64])],
        ["Lines", lines.length, words(lines.flat())], ["Segs", 1, words([0, 1, 0, 0, 0, 0])],
        ["Subsectors", 1, words([1, 0])], ["Nodes", 0, Buffer.alloc(0)]];
    let offset = 0;
    const lumps = records.map(([name, count, data]) => {
        const record = `${name}: wad.Lump{Valid: true, Offset: ${offset}, Count: ${count}}`;
        offset += data.length;
        return record;
    });
    writeFileSync(path.join(scratch, "triggers.bin"), Buffer.concat(records.map(record => record[2])));
    return `wad.BspLevel{Valid: true, File: Triggers, ${lumps.join(", ")}}`;
}

function triggerDispatch() {
    return triggers.map(({ kind, seed, stopped, monster, back }, index) => {
        const cross = line => `state = play.CrossLevelSpecial(state.ApplyTo(base), state, ${line})`;
        const state = [seed && cross(triggers.length), stopped && cross(triggers.length + 1)].filter(Boolean);
        if (kind === "cross") state.push(cross(index));
        if (kind === "use") state.push(`state = play.UseActorLine(state.ApplyTo(base), state, ${index}, ${!!back}, true, play.PlayerInventory{}).State`);
        if (kind === "shoot") state.push(`state = play.ShootLevelSpecial(state.ApplyTo(base), state, ${index}, ${!monster})`);
        return `        case ${index}:\n            ${state.join("\n            ")}`;
    }).join("\n");
}

function registryFixture() {
    const count = 31, line = count * 26, side = line + 14, vertices = side + 30;
    const bytes = Buffer.alloc(vertices + 8);
    for (let index = 0; index < count; index++) bytes.writeInt16LE(7, index * 26 + 24);
    bytes.writeUInt16LE(1, line + 2);
    bytes.writeUInt16LE(53, line + 6);
    bytes.writeUInt16LE(7, line + 8);
    bytes.writeUInt16LE(0xffff, line + 12);
    bytes.writeInt16LE(16, vertices + 4);
    writeFileSync(path.join(scratch, "registry.bin"), bytes);
    return `wad.BspLevel{Valid: true, File: Registry, Sectors: wad.Lump{Valid: true, Count: ${count}},
        Lines: wad.Lump{Valid: true, Count: 1, Offset: ${line}}, Sides: wad.Lump{Valid: true, Count: 1, Offset: ${side}},
        Vertices: wad.Lump{Valid: true, Count: 2, Offset: ${vertices}}}`;
}

function run(command, args, timeout) {
    const result = spawnSync(command, args, { encoding: "utf8", cwd: root, timeout });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout;
}

function runFletcher() {
    const entry = path.join(scratch, "main.flt");
    const output = path.join(scratch, "platforms.json");
    writeFileSync(entry, `package main
import "play"
import "wad"
const Unit = ${unit}
const Registry = readFile("registry.bin")
const Triggers = readFile("triggers.bin")
const Modes = [${cases.length}]int{${cases.map(item => item.mode).join(", ")}}
const Rolls = [${cases.length}]int{${cases.map(item => item.random).join(", ")}}
func obstructed(index int, tic int) bit {
    switch index {
    ${cases.flatMap((item, index) => item.blocked.length ?
        [`case ${index}: return ${item.blocked.map(tic => `tic == ${tic}`).join(" || ")}`] : []).join("\n    ")}
    }
    return false
}
func activateTrigger(index int) (wad.BspLevel, play.LevelSpecials) {
    base := ${triggerFixture()}
    var state play.LevelSpecials
    switch index {
${triggerDispatch()}
    }
    return base, state
}
map "Doom platforms" {
    screen at (-64, -48) size (128, 96) with { style = "solid" }
    register states [${cases.length}]play.PlatformState = [${cases.length}]play.PlatformState{}
    tick {
        tic := currentTick()
        if tic == 0 {
            level := ${registryFixture()}
            state := play.CrossLevelSpecial(level, play.LevelSpecials{}, 0)
            moved := play.TickLevelMovers(level, wad.BlockMapInfo{}, state, play.MapActor{})
            last := state.Doors.Sounds.At(state.Doors.Sounds.Count - 1)
            log("registry", state.Floors.Count, state.Floors.ActivePlatforms, state.Lighting.Random.GameplayIndex,
                state.Doors.Sounds.Count, last.Id, last.Sector, state.MoverOccupied(29), state.MoverOccupied(30),
                state.ApplyTo(level).LineAt(0).Action, state.Floors.PlatformOverflow, moved.Valid)
        }
        if tic > 0 && tic <= ${triggers.length} {
            line := tic - 1
            base, state := activateTrigger(line)
            for age := range ${triggerTicks} {
                live := state.ApplyTo(base)
                motion := state.Floors.EntryAt(state.Floors.FindSector(1)).Platform
                starts, cue := 0, 0
                if age == 0 {
                    starts = state.Doors.Sounds.Count
                    cue = state.Doors.Sounds.At(starts - 1).Id
                }
                log("trigger", line, age, live.LineAt(line).Action, live.SectorHeightsAt(1).Floor,
                    live.FloorNameAt(1).Low == 0x57454e, live.SectorSpecial(1), state.Floors.ActivePlatforms,
                    motion.Mode, motion.Low, motion.High, motion.Speed, motion.Wait, motion.Count, motion.Status, motion.OldStatus,
                    state.Lighting.Random.GameplayIndex, starts, cue)
                moved := play.TickLevelMoversAt(base, wad.BlockMapInfo{}, state, play.MapActor{Height: 16 << 16}, age)
                if !moved.Valid { log("trigger mover failed", line, age) }
                state = moved.State
            }
        }
        frame := states
        for index := range ${cases.length} {
            motion := frame[index]
            if tic == 0 {
                motion = play.StartPlatform(Modes[index], ${geometry.floor} * Unit, ${geometry.low} * Unit,
                    ${geometry.high} * Unit, ${geometry.next} * Unit, ${geometry.amount}, Rolls[index])
            } else {
                if tic == 7 && motion.Active {
                    motion.OldStatus, motion.Status = motion.Status, play.PlatformStasis
                }
                if tic == 11 && motion.Active { motion.Status = motion.OldStatus }
                motion = play.TickPlatform(motion, obstructed(index, tic))
            }
            log(tic, index, motion.Height, motion.Low, motion.High, motion.Speed, motion.Wait, motion.Count,
                motion.Status, motion.OldStatus, motion.Mode, motion.Active)
            frame[index] = motion
        }
        next states = frame
    }
}
`);
    run("dotnet", [cli, "build", entry, "--package-root", port, "-o", output], 20_000);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
    for (let tic = 0; tic <= lastTic; tic++) sim.step();
    const registry = sim.logs.find(row => row[0] === "registry");
    const activated = sim.logs.filter(row => row[0] === "trigger");
    assert.equal(activated.length, triggers.length * triggerTicks, "every line ran through the compiled dispatcher");
    assert.ok(!sim.logs.some(row => row[0] === "trigger mover failed"), "every triggered mover advanced");
    return { registry: Array.from(registry.slice(1), Number), activated: Array.from(activated, row => Array.from(row.slice(1), Number)),
        trace: Array.from(sim.logs.filter(row => typeof row[0] === "number"), row => Array.from(row, Number)) };
}

function runNative(platformPath, floorPath) {
    const read = file => readFileSync(path.resolve(root, file), "utf8").replaceAll("\r\n", "\n");
    const platforms = read(platformPath), floors = read(floorPath);
    const upstream = path.dirname(path.resolve(root, platformPath));
    const spec = read(path.join(upstream, "p_spec.c")), switches = read(path.join(upstream, "p_switch.c"));
    const cross = extractFunction(spec, "void", "P_CrossSpecialLine");
    const use = extractFunction(switches, "boolean", "P_UseSpecialLine");
    const shoot = extractFunction(spec, "void", "P_ShootSpecialLine");
    const otherActions = [...new Set((cross + use + shoot).match(/\b(?:EV_|G_)[A-Za-z]+\b/g))]
        .filter(name => name !== "EV_DoPlat" && name !== "EV_StopPlat");
    const first = platforms.search(/plat_t\s*\*\s*activeplats\s*\[/);
    const planeStart = floors.search(/result_e\s+T_MovePlane\s*\n/);
    const planeEnd = floors.indexOf("\n}", planeStart);
    assert.ok(first >= 0 && planeStart >= 0 && planeEnd > planeStart, "locate exact platform and plane routines");
    const source = path.join(scratch, "native.c");
    const executable = path.join(scratch, process.platform === "win32" ? "native.exe" : "native");
    writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FRACUNIT ${unit}
#define PLATWAIT 3
#define PLATSPEED FRACUNIT
#define MAXPLATS 30
#define CASES ${cases.length}
enum { false, true, PU_LEVSPEC = 51, ML_SECRET = 32, BUTTONTIME = 35 };
enum { top, middle, bottom };
enum { MT_ROCKET = 33, MT_PLASMA, MT_BFG, MT_TROOPSHOT = 31, MT_HEADSHOT, MT_BRUISERSHOT = 16 };
${read(path.join(upstream, "sounds.h"))}
typedef enum { ok, crushed, pastdest } result_e;
typedef enum { up, down, waiting, in_stasis } plat_e;
typedef enum { perpetualRaise, downWaitUpStay, raiseAndChange, raiseToNearestAndChange, blazeDWUS } plattype_e;
typedef int boolean, fixed_t;
typedef struct { int player, type; } mobj_t;
typedef void (*actionf_p1)(void *);
typedef void (*actionf_v)(void);
typedef struct { union { actionf_p1 acp1; actionf_v acv; } function; } thinker_t;
typedef struct {
    fixed_t floorheight, ceilingheight;
    int floorpic, special, soundorg;
    void *specialdata;
} sector_t;
typedef struct { sector_t *sector; int toptexture, midtexture, bottomtexture; } side_t;
typedef struct { int tag, sidenum[2], special, flags; } line_t;
typedef struct {
    thinker_t thinker;
    sector_t *sector;
    fixed_t speed, low, high;
    int wait, count;
    plat_e status, oldstatus;
    boolean crush;
    int tag;
    plattype_e type;
} plat_t;

static int blocked, leveltime, roll, registrations, draws, starts, lastSound, lastSector;
static int numswitches, switchlist[2]; // No wall materials in this fixture.
static struct { mobj_t *soundorg; } buttonlist[1];
static line_t lines[3];
static sector_t sectors[MAXPLATS + 1], front;
static side_t sides[] = {{ &front }};
extern plat_t *activeplats[MAXPLATS];
static void P_AddThinker(thinker_t *p) { ++registrations; }
static void P_RemoveThinker(thinker_t *p) { p->function.acv = NULL; }
static void S_StartSound(mobj_t *from, int sound) {
    ++starts;
    lastSound = sound;
    for (int i = 0; i <= MAXPLATS; ++i) {
        if (from == (mobj_t *)&sectors[i].soundorg) { lastSector = i; return; }
    }
    abort();
}
static void I_Error(const char *text) {
    if (strcmp(text, "P_AddActivePlat: no more plats!") == 0) {
        int slots = 0;
        for (int i = 0; i < MAXPLATS; ++i) slots += activeplats[i] != NULL;
        printf("%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,0\\n", registrations, slots, draws, starts, lastSound, lastSector,
            sectors[29].specialdata != NULL, sectors[30].specialdata != NULL, lines[0].special, 1);
    }
    fprintf(stderr, "%s\\n", text);
    exit(2);
}
static void *Z_Malloc(size_t bytes, int tag, void *owner) {
    void *p = calloc(1, bytes);
    if (!p) I_Error("allocation failed");
    return p;
}
static int P_Random(void) { ++draws; return roll; }
static int P_ChangeSector(sector_t *sector, boolean crush) { return blocked; }
static int P_FindSectorFromLineTag(line_t *line, int previous) {
    if (line->tag == 99) return previous < MAXPLATS ? previous + 1 : -1;
    return previous < 0 ? line->tag - 1 : -1;
}
static int P_FindHighestFloorSurrounding(sector_t *sector) { return ${geometry.high} * FRACUNIT; }
static int P_FindLowestFloorSurrounding(sector_t *sector) { return ${geometry.low} * FRACUNIT; }
static int P_FindNextHighestFloor(sector_t *sector, fixed_t floor) { return ${geometry.next} * FRACUNIT; }
static void P_StartButton(line_t *line, int where, int texture, int time) { abort(); }

void P_ActivateInStasis(int tag);
void P_AddActivePlat(plat_t *plat);
void P_RemoveActivePlat(plat_t *plat);

${floors.slice(planeStart, planeEnd + 2)}
${platforms.slice(first)}
${extractFunction(switches, "void", "P_ChangeSwitchTexture")}
${otherActions.map(name => `#define ${name}(...) (abort(), 0)`).join("\n")}
${cross}
${use}
${shoot}
static int obstructed(int index, int tic) {
    switch (index) {
${cases.flatMap((item, index) => item.blocked.length ?
    [`    case ${index}: return ${item.blocked.map(tic => `tic == ${tic}`).join(" || ")};`] : []).join("\n")}
    default: return 0;
    }
}
static void traceTrigger(int index, int special, int kind, int seed, int stopped, int monster, int back) {
    memset(activeplats, 0, sizeof(activeplats));
    sectors[1] = (sector_t){.floorheight = ${geometry.floor} * FRACUNIT, .ceilingheight = 128 * FRACUNIT, .floorpic = 1, .special = 7};
    front.floorpic = 2;
    draws = starts = lastSound = blocked = 0;
    roll = 8; // The first native P_Random value is even.
    lines[0] = (line_t){.tag = 2, .special = special};
    lines[1] = (line_t){.tag = 2, .special = 87};
    lines[2] = (line_t){.tag = 2, .special = 89};
    mobj_t player = {.player = 1};
    if (seed) P_CrossSpecialLine(1, 0, &player);
    if (stopped) P_CrossSpecialLine(2, 0, &player);
    if (kind == 0) P_CrossSpecialLine(0, 0, &player);
    if (kind == 1) P_UseSpecialLine(&player, &lines[0], back);
    if (kind == 2) {
        mobj_t shooter = {.player = !monster};
        P_ShootSpecialLine(&shooter, &lines[0]);
    }
    plat_t *allocated = sectors[1].specialdata;
    for (int tic = 0; tic < ${triggerTicks}; ++tic) {
        plat_t empty = {0};
        plat_t *p = activeplats[0] ? activeplats[0] : &empty;
        printf("%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\\n", index, tic,
            lines[0].special, sectors[1].floorheight, sectors[1].floorpic == 2, sectors[1].special, activeplats[0] != NULL,
            activeplats[0] ? p->type + 1 : 0, p->low, p->high, p->speed, p->wait, p->count, p->status, p->oldstatus,
            draws, tic ? 0 : starts, tic ? 0 : lastSound);
        leveltime = tic;
        if (p->thinker.function.acp1) T_PlatRaise(p);
    }
    free(allocated);
}
int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "overflow") == 0) {
        mobj_t player = {.player = 1};
        lines[0] = (line_t){.tag = 99, .special = 53};
        P_CrossSpecialLine(0, 0, &player);
        return 1;
    }
    if (argc > 1) {
${triggers.map(({ special, kind, seed, stopped, monster, back }, index) =>
    `        traceTrigger(${index}, ${special}, ${["cross", "use", "shoot"].indexOf(kind)}, ${+!!seed}, ${+!!stopped}, ${+!!monster}, ${+!!back});`).join("\n")}
        return 0;
    }
    const int modes[] = { ${cases.map(item => item.mode - 1).join(", ")} };
    const int rolls[] = { ${cases.map(item => item.random).join(", ")} };
    plat_t *states[CASES] = {0};
    for (int tic = 0; tic <= ${lastTic}; tic++) {
        leveltime = tic;
        for (int i = 0; i < CASES; i++) {
            line_t line = { i + 1, { 0, 0 } };
            sector_t *sec = &sectors[i];
            if (tic == 0) {
                roll = rolls[i];
                sec->floorheight = ${geometry.floor} * FRACUNIT;
                EV_DoPlat(&line, modes[i], ${geometry.amount});
                states[i] = sec->specialdata;
                if (!states[i]) I_Error("platform did not start");
            } else {
                if (tic == 7) EV_StopPlat(&line);
                if (tic == 11) P_ActivateInStasis(line.tag);
                blocked = obstructed(i, tic);
                if (states[i]->thinker.function.acp1) T_PlatRaise(states[i]);
            }
            plat_t *p = states[i];
            printf("%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\\n", tic, i, sec->floorheight,
                   p->low, p->high, p->speed, p->wait, p->count, p->status, p->oldstatus,
                   p->type + 1, sec->specialdata != NULL);
        }
    }
    for (int i = 0; i < CASES; i++) free(states[i]);
    return 0;
}
`);
    run("gcc", ["-std=c99", "-O2", source, "-o", executable], 20_000);
    const overflow = spawnSync(executable, ["overflow"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(overflow.status, 2, overflow.error?.message ?? overflow.stderr);
    assert.match(overflow.stderr, /P_AddActivePlat: no more plats!/);
    const rows = output => output.trim().split(/\r?\n/).map(line => line.split(",").map(Number));
    return { registry: rows(overflow.stdout)[0], activated: rows(run(executable, ["triggers"], 10_000)),
        trace: rows(run(executable, [], 10_000)) };
}

try {
    const { registry, activated, trace: actual } = runFletcher();
    assert.equal(actual.length, cases.length * (lastTic + 1));
    const [platformPath, floorPath] = process.argv.slice(3);
    if (platformPath || floorPath) {
        assert.ok(platformPath && floorPath, "pass both p_plats.c and p_floor.c");
        const native = runNative(platformPath, floorPath), expected = native.trace;
        assert.equal(activated.length, native.activated.length);
        for (const [index, tick] of activated.entries()) {
            assert.deepEqual(tick, native.activated[index], `platform trigger ${triggers[tick[0]].special}, tic ${tick[1]}`);
        }
        assert.deepEqual(registry, native.registry, "31st platform effects before the fatal registry overflow");
        assert.equal(actual.length, expected.length);
        for (const [index, tick] of actual.entries()) {
            assert.deepEqual(tick, expected[index], `platform case ${tick[1]}, tic ${tick[0]}`);
        }
    }
    assert.deepEqual(registry, [31, 30, 31, 31, 18, 30, 1, 1, 53, 1, 0], "platform startup before registry overflow");
    const digest = createHash("sha256").update(JSON.stringify(actual)).digest("hex");
    assert.equal(digest, pinnedDigest, "trace digest from the pinned Doom C source");
    const triggerDigest = createHash("sha256").update(JSON.stringify(activated)).digest("hex");
    assert.equal(triggerDigest, pinnedTriggerDigest, "line activation digest from the pinned Doom C source");
    console.log(`Doom platforms matched ${actual.length} samples across all five modes, both random starts, stasis, and obstruction.`);
    console.log(`Matched ${activated.length} activation and mover snapshots across ${triggers.length} requests, plus the 31st platform's state at overflow.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-platforms-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
