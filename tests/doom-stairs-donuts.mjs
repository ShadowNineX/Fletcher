import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const scratchParent = realpathSync(artifacts);
const scratch = mkdtempSync(path.join(scratchParent, "doom-stairs-donuts-"));
const unit = 65536;
const lastTic = 20;
const stair = {
    sectors: [
        { floor: 0, flat: "STEP_A", tag: 7 }, { floor: 0, flat: "STEP_A" },
        { floor: 0, flat: "STEP_A", tag: 7 }, { floor: 0, flat: "OTHER" },
        { floor: 0, flat: "STEP_A" }, { floor: 0, flat: "STEP_A" }, { floor: 0, flat: "STEP_A" },
    ],
    // The mismatched flat is ignored, the occupied match consumes a riser,
    // and the incoming link into sector 4 is ignored. Sector 2's tag is
    // passed over when the scan resumes beyond the end of the chain.
    edges: [[0, 3], [0, 1], [0, 4], [5, 4], [4, 6]],
    action: 8, tag: 7,
};
const turbo = {
    sectors: [{ floor: 0, flat: "STEP_A", tag: 7 }, { floor: 0, flat: "STEP_A" }],
    edges: [[0, 1]], action: 100, tag: 7,
};
const donut = {
    sectors: [{ floor: 16, flat: "HOLE", tag: 9 }, { floor: 0, flat: "RING", special: 9 },
        { floor: 8, flat: "MODEL", special: 42 }],
    edges: [[1, 0], [1, 0], [1, 2]], action: 0, tag: 9, probeLine: 2,
};
const dispatch = [7, 8, 9, 100, 127].map(action => ({
    ...(action === 9 ? donut : turbo),
    edges: action === 9 ? donut.edges : [[0, 1], [0, 1], [0, 1]],
    action, routed: true,
}));

function records(name, fixture) {
    const { sectors, edges, action, tag, probeLine } = fixture;
    const linesOffset = sectors.length * 26;
    const sidesOffset = linesOffset + edges.length * 14;
    const verticesOffset = sidesOffset + edges.length * 60;
    const leafOffset = verticesOffset + 8;
    const bytes = Buffer.alloc(leafOffset + (probeLine === undefined ? 0 : 16));
    for (const [index, { floor, flat, tag = 0, special = 0 }] of sectors.entries()) {
        const offset = index * 26;
        bytes.writeInt16LE(floor, offset);
        bytes.writeInt16LE(128, offset + 2);
        bytes.write(flat, offset + 4, 8);
        bytes.writeInt16LE(special, offset + 22);
        bytes.writeInt16LE(tag, offset + 24);
    }
    for (const [index, [front, back]] of edges.entries()) {
        const line = linesOffset + index * 14;
        const side = sidesOffset + index * 60;
        bytes.writeUInt16LE(1, line + 2);
        bytes.writeUInt16LE(4, line + 4);
        if (index === 0 || fixture.routed) {
            bytes.writeUInt16LE(action, line + 6);
            bytes.writeUInt16LE(fixture.routed && index === 2 ? 99 : tag, line + 8);
        }
        bytes.writeUInt16LE(index * 2, line + 10);
        bytes.writeUInt16LE(index * 2 + 1, line + 12);
        bytes.writeUInt16LE(front, side + 28);
        bytes.writeUInt16LE(back, side + 58);
    }
    bytes.writeInt16LE(64, verticesOffset + 4);
    if (probeLine !== undefined) {
        // A node-less BSP places the probe actor in the model sector.
        bytes.writeUInt16LE(1, leafOffset);
        bytes.writeUInt16LE(probeLine, leafOffset + 10);
        bytes.writeUInt16LE(1, leafOffset + 12);
    }
    writeFileSync(path.join(scratch, name.toLowerCase() + ".bin"), bytes);
    const probe = probeLine === undefined ? "" : `, Nodes: wad.Lump{Valid: true},
        Subsectors: wad.Lump{Valid: true, Count: 1, Offset: ${leafOffset}},
        Segs: wad.Lump{Valid: true, Count: 1, Offset: ${leafOffset + 4}}`;
    return `wad.BspLevel{Valid: true, File: ${name}, Sectors: wad.Lump{Valid: true, Count: ${sectors.length}},
        Lines: wad.Lump{Valid: true, Count: ${edges.length}, Offset: ${linesOffset}},
        Sides: wad.Lump{Valid: true, Count: ${edges.length * 2}, Offset: ${sidesOffset}},
        Vertices: wad.Lump{Valid: true, Count: 2, Offset: ${verticesOffset}}${probe}}`;
}

function runFletcher() {
    const source = path.join(scratch, "main.flt");
    const output = path.join(scratch, "output.json");
    writeFileSync(source, `package main
import "play"
import "wad"
const Unit = ${unit}
const Stair = readFile("stair.bin")
const Turbo = readFile("turbo.bin")
const Donut = readFile("donut.bin")
${dispatch.map(f => `const Route${f.action} = readFile("route${f.action}.bin")`).join("\n")}
map "Doom stairs and donut" {
    screen at (-64, -48) size (128, 96) with { style = "solid" }
    register ring play.LevelSpecials = play.LevelSpecials{}
    tick {
        donut := ${records("Donut", donut)}
        tic := currentTick()
        if tic == 0 {
            stairs := ${records("Stair", stair)}
            fast := ${records("Turbo", turbo)}
            var held play.LevelSpecials
            held.Floors = held.Floors.Append(play.SectorFloor{Sector: 1,
                Motion: play.FloorState{Active: true, Destination: Unit, Speed: Unit, Direction: 1, Mode: play.FloorRaise}})
            held.Doors.NextMover = 1
            normal := play.CrossLevelSpecial(stairs, held, 0)
            firstStair := normal.Floors.Following(normal.Floors.First())
            nextStair := normal.Floors.Following(firstStair)
            first := normal.Floors.EntryAt(firstStair).Motion
            nextStep := normal.Floors.EntryAt(nextStair)
            lastStep := normal.Floors.EntryAt(normal.Floors.Following(nextStair))
            sector2, sector5 := -1, -1
            if normal.MoverOccupied(2) { sector2 = 2 }
            if normal.MoverOccupied(5) { sector5 = 5 }
            log(normal.Floors.Count, first.Destination, first.Speed,
                nextStep.Sector, nextStep.Motion.Destination, lastStep.Sector, lastStep.Motion.Destination,
                sector2, sector5)
            log(normal.ApplyTo(stairs).LineAt(0).Action)

            raised := play.CrossLevelSpecial(fast, play.LevelSpecials{}, 0)
            firstTurbo := raised.Floors.First()
            turboStart := raised.Floors.EntryAt(firstTurbo).Motion
            turboNext := raised.Floors.EntryAt(raised.Floors.Following(firstTurbo)).Motion
            log(raised.Floors.Count, turboStart.Destination, turboStart.Speed, turboNext.Destination, turboNext.Speed)
            log(raised.ApplyTo(fast).LineAt(0).Action)

            formed := play.StartDonut(donut, held, 9)
            floors := formed.State.Floors
            ringHandle := floors.Following(floors.First())
            rise, lower := floors.EntryAt(ringHandle), floors.EntryAt(floors.Following(ringHandle))
            log(formed.Started, formed.State.Floors.Count, rise.Sector, rise.Motion.Destination, rise.Motion.Speed,
                rise.OnFinish.Flat.Low, rise.OnFinish.Special, lower.Sector, lower.Motion.Destination, lower.Motion.Speed)
            next ring = formed.State
        } else if tic <= ${lastTic} {
            frame := play.TickLevelMovers(donut, wad.BlockMapInfo{}, ring,
                play.MapActor{Height: 56 * Unit, Floor: 8 * Unit, Z: 8 * Unit, Player: true})
            level := frame.State.ApplyTo(donut)
            log(tic, frame.Valid, level.SectorHeightsAt(1).Floor, level.SectorHeightsAt(0).Floor,
                level.FloorNameAt(1).Low, level.SectorSpecial(1), frame.State.MoverOccupied(1), frame.State.MoverOccupied(0))
            next ring = frame.State
        } else {
            var base wad.BspLevel
            action := 0
            switch tic {
${dispatch.map((f, i) => `            case ${lastTic + 1 + i}: base, action = ${records("Route" + f.action, f)}, ${f.action}`).join("\n")}
            }
            var state play.LevelSpecials
            for step := range 6 {
                line, used := 0, -1
                if step == 2 { line = 2 }
                if step == 4 { line = 1 }
                live := state.ApplyTo(base)
                if action == 8 || action == 100 {
                    if step < 2 { state = play.CrossMonsterLine(live, state, line) } else {
                        state = play.CrossLevelSpecial(live, state, line)
                    }
                } else {
                    outcome := play.UseActorLine(live, state, line, step == 1, step != 0, play.PlayerInventory{})
                    state, used = outcome.State, 0
                    if outcome.Used { used = 1 }
                }
                live = state.ApplyTo(base)
                floors := state.Floors
                first := floors.EntryAt(floors.First())
                second := floors.EntryAt(floors.Following(floors.First()))
                log(action, step, used, live.LineAt(0).Action, live.LineAt(1).Action, live.LineAt(2).Action,
                    floors.Count, first.Sector, first.Motion.Direction, first.Motion.Speed, first.Motion.Destination,
                    second.Sector, second.Motion.Direction, second.Motion.Speed, second.Motion.Destination)
            }
        }
    }
}
`);
    const build = spawnSync("dotnet", [cli, "build", source, "--package-root", path.join(root, "examples", "doom-engine"),
        "--asset-root", scratch, "-o", output], { encoding: "utf8", cwd: root, timeout: 15_000 });
    assert.equal(build.status, 0, build.error?.message ?? build.stderr);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
    for (let tic = 0; tic <= lastTic + dispatch.length; tic++) sim.step();
    return sim.logs.map(row => Array.from(row, Number));
}

function runNative(floorPath, specPath) {
    const read = file => readFileSync(path.resolve(root, file), "utf8").replaceAll("\r\n", "\n");
    const floors = read(floorPath), specials = read(specPath);
    const directory = path.dirname(path.resolve(root, specPath));
    const switchPath = [process.argv[5], path.join(directory, "switch-p_switch.c"), path.join(directory, "p_switch.c"),
        path.join(artifacts, "doom-upstream", "switch-p_switch.c")].filter(Boolean).find(file => existsSync(path.resolve(root, file)));
    assert.ok(switchPath, "provide pinned p_switch.c beside p_spec.c or as the fourth path argument");
    const switches = read(switchPath);
    const use = extractFunction(switches, "boolean", "P_UseSpecialLine");
    const cross = extractFunction(specials, "void", "P_CrossSpecialLine");
    const others = [...new Set((use + cross).match(/\b(?:G_|EV_)[A-Za-z]+\b/g))]
        .filter(name => !["EV_BuildStairs", "EV_DoDonut"].includes(name));
    function routine(file, pattern) {
        const start = file.search(pattern);
        const end = file.indexOf("\n}", start);
        assert.ok(start >= 0 && end > start, `locate ${pattern}`);
        return file.slice(start, end + 2);
    }
    const flatIds = [...new Set([stair, turbo, donut].flatMap(fixture => fixture.sectors.map(sector => sector.flat)))];
    function flatWord(name) {
        const word = Buffer.alloc(4);
        word.write(name, 0, 4, "ascii");
        return word.readUInt32LE();
    }
    function load({ sectors, edges }) {
        const values = sectors.map(({ floor, flat, tag = 0, special = 0 }) =>
            `{${floor},${flatIds.indexOf(flat)},${tag},${special}}`).join(",");
        const linked = edges.map(([front, back]) => `{${front},${back}}`).join(",");
        return `load(${sectors.length}, (const int[][4]){${values}}, ${edges.length}, (const int[][2]){${linked}});`;
    }
    const source = path.join(scratch, "native-stairs-donuts.c");
    const executable = path.join(scratch, process.platform === "win32" ? "native-stairs-donuts.exe" : "native-stairs-donuts");
    writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define FRACUNIT ${unit}
#define FLOORSPEED FRACUNIT
enum { ML_TWOSIDED = 4, PU_LEVSPEC = 51, sfx_stnmov, sfx_pstop, false = 0, true = 1 };
enum { ML_SECRET = 32, MT_ROCKET = 33, MT_PLASMA, MT_BFG, MT_TROOPSHOT = 31, MT_HEADSHOT, MT_BRUISERSHOT = 16,
    sfx_swtchn, sfx_swtchx, top, middle, bottom, BUTTONTIME = 35 };
typedef int boolean;
typedef int fixed_t;
typedef enum { ok, crushed, pastdest } result_e;
typedef enum { lowerFloor, lowerAndChange = 6, donutRaise = 11 } floor_e;
typedef enum { build8, turbo16 } stair_e;
typedef struct sector sector_t;
typedef struct { int flags, tag; sector_t *frontsector, *backsector; int special, sidenum[2]; } line_t;
typedef struct { int type, player; } mobj_t;
typedef struct { int toptexture, midtexture, bottomtexture; } side_t;
struct sector { fixed_t floorheight, ceilingheight; int floorpic, tag, special, linecount;
    line_t **lines; void *specialdata; mobj_t soundorg; };
typedef void (*actionf_p1)(void *);
typedef struct { union { actionf_p1 acp1; } function; boolean active; } thinker_t;
typedef struct { thinker_t thinker; floor_e type; boolean crush; sector_t *sector;
    int direction, newspecial, texture; fixed_t floordestheight, speed; } floormove_t;
static sector_t sectors[7];
static line_t lines[8];
static line_t *memberships[7][8];
static int numsectors, leveltime;
static thinker_t *thinkers[12];
static int count;
static floormove_t held;
static const int flatWords[] = {${flatIds.map(flatWord).join(",")}};
// The synthetic sides contain plain material. A successful one-shot clears
// its line in P_ChangeSwitchTexture even when no switch texture matches.
static side_t sides[1];
static int numswitches=1, switchlist[]={1,2};
static struct { mobj_t *soundorg; } buttonlist[1];
static void P_StartButton(line_t *line,int where,int tex,int timer) {
    (void)line;(void)where;(void)tex;(void)timer; abort();
}

static boolean P_ChangeSector(sector_t *sector, boolean crush) { (void)sector; (void)crush; return false; }
static void S_StartSound(mobj_t *origin, int sound) { (void)origin; (void)sound; }
static void *Z_Malloc(size_t size, int tag, void *owner) {
    (void)tag;
    (void)owner;
    void *result = calloc(1, size);
    if (!result) exit(1);
    return result;
}
static void P_AddThinker(thinker_t *thinker) {
    if (count >= 12) exit(2);
    thinker->active = true;
    thinkers[count++] = thinker;
}
static void P_RemoveThinker(thinker_t *thinker) { thinker->active = false; }

${routine(specials, /\nsector_t\*\s+getNextSector\s*\n/)}
${routine(specials, /\nint\s+P_FindSectorFromLineTag\s*\n/)}
${routine(floors, /\nresult_e\s+T_MovePlane\s*\n/)}
${routine(floors, /\nvoid T_MoveFloor\s*\(/)}
${routine(floors, /\nint\s+EV_BuildStairs\s*\n/)}
${routine(specials, /\nint EV_DoDonut\s*\(/)}
${extractFunction(switches, "void", "P_ChangeSwitchTexture")}
static int unexpectedAction(void) { abort(); }
${others.map(n => n === "EV_Teleport" ? "#define EV_Teleport(line,side,thing) ((void)(side), unexpectedAction())" :
    `#define ${n}(...) unexpectedAction()`).join("\n")}
${use}
${cross}

static void unload(void) {
    for (int i = 0; i < count; ++i)
        if (thinkers[i] != &held.thinker) free(thinkers[i]);
    count = 0;
}
static void load(int size, const int values[][4], int edgeCount, const int edges[][2]) {
    unload();
    numsectors = size;
    memset(sectors, 0, sizeof sectors);
    for (int i = 0; i < size; ++i) {
        sectors[i].floorheight = values[i][0] * FRACUNIT;
        sectors[i].ceilingheight = 128 * FRACUNIT;
        sectors[i].floorpic = values[i][1];
        sectors[i].tag = values[i][2];
        sectors[i].special = values[i][3];
        sectors[i].lines = memberships[i];
    }
    for (int i = 0; i < edgeCount; ++i) {
        sector_t *front = &sectors[edges[i][0]];
        sector_t *back = &sectors[edges[i][1]];
        lines[i] = (line_t){.flags=ML_TWOSIDED,.frontsector=front,.backsector=back};
        front->lines[front->linecount++] = &lines[i];
        back->lines[back->linecount++] = &lines[i];
    }
}
static void holdRing(void) {
    held = (floormove_t){.sector = &sectors[1], .direction = 1, .speed = FRACUNIT, .floordestheight = FRACUNIT};
    P_AddThinker(&held.thinker);
    sectors[1].specialdata = &held;
}
static void runDispatch(int action,int tag) {
    for(int i=0;i<3;i++) { lines[i].special=action; lines[i].tag=i==2?99:tag; }
    for(int step=0;step<6;step++) {
        int index=step==2?2:step==4?1:0,used=-1;
        boolean walk=action==8 || action==100;
        mobj_t actor={.type=1,.player=walk?step>=2:step!=0};
        if(walk) P_CrossSpecialLine(index,step==1,&actor);
        else used=lines[index].special && P_UseSpecialLine(&actor,&lines[index],step==1);
        printf("%d %d %d %d %d %d %d", action,step,used,lines[0].special,lines[1].special,lines[2].special,count);
        for(int i=0;i<2;i++) {
            floormove_t *mover=i<count?(floormove_t *)thinkers[i]:NULL;
            printf(" %d %d %d %d",mover?(int)(mover->sector-sectors):0,mover?mover->direction:0,
                mover?mover->speed:0,mover?mover->floordestheight:0);
        }
        puts("");
    }
}
int main(void) {
    line_t trigger = {.tag = 7};
    ${load(stair)}
    holdRing();
    EV_BuildStairs(&trigger, build8);
    if (count != 4) return 3;
    floormove_t *first = (floormove_t *)thinkers[1], *second = (floormove_t *)thinkers[2], *last = (floormove_t *)thinkers[3];
    printf("%d %d %d %d %d %d %d %d %d\\n", count, first->floordestheight, first->speed,
        (int)(second->sector - sectors), second->floordestheight, (int)(last->sector - sectors), last->floordestheight,
        sectors[2].specialdata ? 2 : -1, sectors[5].specialdata ? 5 : -1);
    ${load(turbo)}
    EV_BuildStairs(&trigger, turbo16);
    if (count != 2) return 4;
    first = (floormove_t *)thinkers[0];
    second = (floormove_t *)thinkers[1];
    printf("%d %d %d %d %d\\n", count, first->floordestheight, first->speed, second->floordestheight, second->speed);
    ${load(donut)}
    holdRing();
    trigger.tag = 9;
    int started = EV_DoDonut(&trigger);
    if (count != 3) return 5;
    floormove_t *rise = (floormove_t *)thinkers[1], *lower = (floormove_t *)thinkers[2];
    printf("%d %d %d %d %d %d %d %d %d %d\\n", started, count, (int)(rise->sector - sectors),
        rise->floordestheight, rise->speed, flatWords[rise->texture], rise->newspecial, (int)(lower->sector - sectors),
        lower->floordestheight, lower->speed);
    for (int tic = 1; tic <= ${lastTic}; ++tic) {
        leveltime = tic;
        for (int i = 0; i < count; ++i)
            if (thinkers[i]->active) T_MoveFloor((floormove_t *)thinkers[i]);
        printf("%d 1 %d %d %d %d %d %d\\n", tic, sectors[1].floorheight, sectors[0].floorheight,
            flatWords[sectors[1].floorpic], sectors[1].special, sectors[1].specialdata != NULL, sectors[0].specialdata != NULL);
    }
    ${dispatch.map(f => `${load(f)} runDispatch(${f.action},${f.tag});`).join("\n    ")}
    unload();
    return 0;
}
`);
    const build = spawnSync("gcc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-Wno-parentheses", "-Wno-maybe-uninitialized",
        source, "-o", executable], { encoding: "utf8", timeout: 15_000 });
    assert.equal(build.status, 0, build.error?.message ?? build.stderr);
    const result = spawnSync(executable, [], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout.trim().split(/\r?\n/).map(line => line.split(" ").map(Number));
}

try {
    const rows = runFletcher();
    assert.deepEqual(rows.splice(3, 1), [[0]], "fast walkover is consumed");
    assert.deepEqual(rows.splice(1, 1), [[0]], "normal walkover is consumed");
    const routeRows = rows.splice(3 + lastTic);
    assert.equal(rows.length, 3 + lastTic);
    assert.equal(routeRows.length, dispatch.length * 6);
    const digest = createHash("sha256").update(rows.map(row => row.join(" ")).join("\n")).digest("hex");
    assert.equal(digest, "393da0aa4830ff034a4872597050230b52c00073465043738a89382cc5562361", "pinned stairs and donut trace");
    const routeDigest = createHash("sha256").update(routeRows.map(row => row.join(" ")).join("\n")).digest("hex");
    assert.equal(routeDigest, "19beb15e3fa9c68cbc7b3a93ba5e0907934babcac568ed915af33f3dd9497a67", "pinned stair and donut activation trace");
    if (process.argv[3] || process.argv[4]) {
        assert.ok(process.argv[3] && process.argv[4], "provide both pinned p_floor.c and p_spec.c");
        assert.deepEqual([...rows, ...routeRows], runNative(process.argv[3], process.argv[4]));
        console.log(`Doom stairs and donuts matched three setup cases, ${lastTic} mover tics and ${routeRows.length} dispatch rows for specials 7, 8, 9, 100 and 127 with pinned C.`);
    } else {
        console.log("Doom stair and donut traces matched the recorded native results.");
    }
} finally {
    assert.match(path.relative(scratchParent, realpathSync(scratch)), /^doom-stairs-donuts-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

