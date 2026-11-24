import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-sector-thinker-order-"));
const unit = 65536;

function run(command, args) {
    const result = spawnSync(command, args, { cwd: scratch, encoding: "utf8", timeout: 60_000,
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function words(...values) {
    const buffer = Buffer.alloc(values.length * 2);
    values.forEach((value, i) => buffer.writeUInt16LE(value & 0xffff, i * 2));
    return buffer;
}

function room() {
    // Two pairs of adjacent sectors with one lit and one dark sector each.
    // The single test subsector maps the player's position to sector zero.
    const sectors = Buffer.alloc(4 * 26);
    const sides = Buffer.alloc(4 * 30);
    [10, 17, 14, 8].forEach((special, i) => {
        sectors.writeUInt16LE(i === 0 ? 56 : 128, i * 26 + 2);
        sectors.writeUInt16LE(i % 2 === 0 ? 64 : 160, i * 26 + 20);
        sectors.writeUInt16LE(special, i * 26 + 22);
        if (i === 1) sectors.writeUInt16LE(9, i * 26 + 24);
        sides.writeUInt16LE(i, i * 30 + 28);
    });
    const blocks = words(-128, -128, 4, 4, ...Array(16).fill(20), 0, 1, -1);
    const lumps = [
        ["Vertices", 2, words(0, -32, 0, 32)], ["Lines", 2, words(0, 1, 4, 17, 9, 0, 1, 0, 1, 4, 0, 0, 2, 3)],
        ["Sides", 4, sides], ["Sectors", 4, sectors], ["Nodes", 0, Buffer.alloc(0)],
        ["Segs", 1, words(0, 1, 0x4000, 0, 0, 0)], ["Subsectors", 1, words(1, 0)], ["BlockMap", blocks.length, blocks],
    ];
    writeFileSync(path.join(scratch, "ROOM.BIN"), Buffer.concat(lumps.map(([, , buffer]) => buffer)));
    let offset = 0;
    return lumps.map(([name, count, buffer]) => {
        const field = `${name}: wad.Lump{Valid: true, Offset: ${offset}, Count: ${count}}`;
        offset += buffer.length;
        return field;
    }).join(",\n");
}

function fletcherRows() {
    const entry = path.join(scratch, "main.flt"), output = path.join(scratch, "order.json");
    writeFileSync(entry, `package main
import "actorinfo"
import "play"
import "wad"
const Room = readFile("ROOM.BIN")
map "Mixed sector thinker order" {
    tick {
        level := wad.BspLevel{File: Room, Valid: true, ${room()}}
        blocks := wad.LoadBlockMap(level)
        random := play.RandomState{MenuIndex: 41}
        if currentTick() == 0 {
            state := play.LevelSpecials{Doors: play.LoadTimedDoors(level), Lighting: play.LoadLevelLights(level, random)}
            doors, lights := state.Doors, state.Lighting.Lights
            first := doors.First()
            second := doors.Following(first)
            log("startup", doors.EntryAt(first).Order, lights.EntryAt(0).Order, doors.EntryAt(second).Order, lights.EntryAt(1).Order,
                doors.NextMover, doors.EntryAt(first).Sector, lights.EntryAt(0).Sector, doors.EntryAt(second).Sector, lights.EntryAt(1).Sector)
            frame := play.TickLevelMoversAt(level, blocks, state, play.MapActor{}, 1)
            doors, lights = frame.State.Doors, frame.State.Lighting.Lights
            log("camera", frame.Valid, doors.EntryAt(first).State.Countdown, lights.EntryAt(0).Count,
                doors.EntryAt(second).State.Countdown, lights.EntryAt(1).Level, frame.State.Lighting.Changed,
                frame.State.Lighting.Random.GameplayIndex, frame.State.Lighting.Random.MenuIndex)
            activated := play.CrossLevelSpecial(level, state, 0)
            frame = play.TickLevelMoversAt(level, blocks, activated, play.MapActor{}, 1)
            lights = frame.State.Lighting.Lights
            log("strobe", frame.Valid, lights.Count, lights.EntryAt(2).Sector, lights.EntryAt(2).Order == state.Doors.NextMover,
                activated.Doors.NextMover == lights.EntryAt(2).Order + 1, lights.EntryAt(2).Count, lights.LightAt(1, -1),
                frame.State.Lighting.Random.GameplayIndex)
        } else {
            // A due flicker and a descending crusher compete for the same PRNG.
            light := play.SpawnSectorLight(1, 17, 160, 64, random).Light
            light.Count = 1
            light.Order = currentTick() - 1
            motion := play.StartCeiling(play.CeilingCrushAndRaise, 56 << 16, 0, 0)
            var state play.LevelSpecials
            state.Doors.NextMover = 2
            state.Lighting.Random = random
            state.Lighting.Lights = state.Lighting.Lights.Append(light)
            state.Ceilings = state.Ceilings.Append(play.SectorCeiling{Sector: 0, Order: 1 - light.Order, Motion: motion})
            player := play.SpawnMobj(level, actorinfo.ActorPlayer, 40 << 16, 8 << 16, play.ActorOnFloor, 2, random).Actor
            player.PlayerSlot, player.Physics.Body.Player = 0, true
            actors := play.MapActors{}.AppendActor(player)
            actors.PlayerActors[0] = 1
            world := play.CombatWorld{Actors: actors, Links: play.BuildActorLinks(actors, blocks), Random: random}
            world.Players[0] = play.NewPlayerInventory(100)
            frame := play.TickLevelMoversWithActors(level, blocks, state, world, 1, 4, play.CombatRules{Skill: 2}, play.DefaultWalkoverTelefrag{})
            blood := frame.World.Actors.ActorAt(1)
            result := frame.State.Lighting
            log("mixed", frame.Valid, result.Lights.EntryAt(0).Level, result.Lights.EntryAt(0).Count,
                frame.World.Players[0].Health, frame.State.Ceilings.EntryAt(1).Motion.Height, frame.State.Ceilings.EntryAt(1).Motion.Speed,
                blood.Kind == actorinfo.ActorBlood && blood.Valid, blood.Physics.MomentumX, blood.Physics.MomentumY,
                frame.World.Random.GameplayIndex, result.Random.GameplayIndex, frame.World.Random.MenuIndex, result.Random.MenuIndex)
        }
    }
}`);
    run("dotnet", [cli, "build", entry, "--package-root", path.join(root, "examples", "doom-engine"), "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let i = 0; i < 3; ++i) sim.step();
    return Array.from(sim.logs, row => Array.from(row));
}

function nativeRows(upstream) {
    const read = name => readFileSync(path.resolve(root, upstream, name), "utf8").replaceAll("\r\n", "\n");
    const tick = read("p_tick.c"), map = read("movement-p_map.c");
    const startup = extractFunction(read("animated-p_spec.c"), "void", "P_SpawnSpecials");
    // Isolate the original sector loop. Command-line timers, scrolling
    // linedefs and global array cleanup after this loop do not spawn thinkers.
    const sectorLoop = startup.match(/sector = sectors;[\s\S]*?(?=\/\/\s*Init line EFFECTs)/)?.[0];
    assert.ok(sectorLoop?.includes("P_SpawnFireFlicker"), "missing P_SpawnSpecials sector loop");
    const source = path.join(scratch, "sector-thinkers.c"), exe = path.join(scratch, "sector-thinkers.exe");
    writeFileSync(source, `#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
typedef enum { false, true } boolean;
typedef int32_t fixed_t;
typedef void (*actionf_v)(void);
typedef struct thinker_s thinker_t;
struct thinker_s {
    thinker_t *prev, *next;
    union { actionf_v acv; void (*acp1)(thinker_t *); } function;
};
static thinker_t thinkercap;
static void Z_Free(void *p) { abort(); }
${extractFunction(tick, "void", "P_InitThinkers")}
${extractFunction(tick, "void", "P_AddThinker")}
${extractFunction(tick, "void", "P_RunThinkers")}
${read("light-m_random.c")}

enum { U = 65536, BOXTOP = 0, BOXBOTTOM, BOXLEFT, BOXRIGHT, MF_SOLID = 2, MF_SHOOTABLE = 4, MF_DROPPED = 0x20000 };
enum { S_GIBS, MT_BLOOD, sfx_stnmov, sfx_pstop };
enum { lowerToFloor, raiseToHighest, lowerAndCrush, crushAndRaise, fastCrushAndRaise, silentCrushAndRaise, CEILSPEED=U };
typedef enum { ok, crushed, pastdest } result_e;
typedef struct { int special, floorheight, ceilingheight, blockbox[4], lightlevel, soundorg; } sector_t;
typedef struct { thinker_t thinker; sector_t *sector; int count, minlight, maxlight; } fireflicker_t;
typedef struct { thinker_t thinker; sector_t *sector; int type, speed, topheight, bottomheight, crush, direction; } ceiling_t;
typedef struct mobj_s {
    int health, x, y, z, momx, momy, height, radius, ceilingz, floorz, flags;
    struct mobj_s *bnext;
} mobj_t;
static sector_t sectors[4] = {{.special=10}, {.special=17}, {.special=14}, {.special=8}};
static thinker_t startupActors[4];
static int startupOrder[4], used, numsectors = 4, totalsecret;
enum { FASTDARK=15, SLOWDARK=35 };
static void record(thinker_t *thinker) { startupOrder[used++] = sectors[thinker-startupActors].special; }
static void spawn(sector_t *sector) {
    thinker_t *thinker = &startupActors[sector-sectors];
    thinker->function.acp1 = record;
    P_AddThinker(thinker);
}
static void P_SpawnDoorCloseIn30(sector_t *s) { assert(s->special == 10); spawn(s); }
static void P_SpawnDoorRaiseIn5Mins(sector_t *s, int i) { assert(s->special == 14 && s == &sectors[i]); spawn(s); }
static void P_SpawnFireFlicker(sector_t *s) { assert(s->special == 17); spawn(s); }
static void P_SpawnGlowingLight(sector_t *s) { assert(s->special == 8); spawn(s); }
static void P_SpawnLightFlash(sector_t *s) { abort(); }
static void P_SpawnStrobeFlash(sector_t *s, int dark, int sync) { abort(); }
static void spawnSectorThinkers(void) {
    sector_t *sector;
    int i;
    ${sectorLoop}
}

static mobj_t player, blood, *blocklinks[1];
static int bmapwidth=1, bmapheight=1, leveltime=4, tmfloorz, tmceilingz, bloodCount;
static boolean nofit, crushchange;
// One occupied cell and an unobstructed origin subsector. P_DamageMobj's
// surviving-target pain roll and P_SpawnMobj's lastlook roll are prescribed.
static boolean P_CheckPosition(mobj_t *actor, int x, int y) {
    tmfloorz = sectors[0].floorheight;
    tmceilingz = sectors[0].ceilingheight;
    return true;
}
static void P_DamageMobj(mobj_t *actor, void *inflictor, void *source, int amount) {
    assert(actor == &player && !inflictor && !source);
    actor->health -= amount;
    P_Random();
}
static mobj_t *P_SpawnMobj(int x, int y, int z, int type) {
    assert(type == MT_BLOOD && ++bloodCount == 1);
    P_Random();
    return &blood;
}
static void P_SetMobjState(mobj_t *actor, int state) { abort(); }
static void P_RemoveMobj(mobj_t *actor) { abort(); }
static void P_RemoveActiveCeiling(ceiling_t *ceiling) { abort(); }
static void S_StartSound(mobj_t *origin, int sound) { abort(); }
${extractFunction(read("movement-p_maputl.c"), "boolean", "P_BlockThingsIterator")}
${extractFunction(map, "boolean", "P_ThingHeightClip")}
${extractFunction(map, "boolean", "PIT_ChangeSector")}
${extractFunction(map, "boolean", "P_ChangeSector")}
${extractFunction(read("door-p_floor.c"), "result_e", "T_MovePlane")}
${extractFunction(read("ceiling-p_ceilng.c"), "void", "T_MoveCeiling")}
${extractFunction(read("light-p_lights.c"), "void", "T_FireFlicker")}
static void crusherTick(thinker_t *t) { T_MoveCeiling((ceiling_t *)t); }
static void flickerTick(thinker_t *t) { T_FireFlicker((fireflicker_t *)t); }

int main(void) {
    P_InitThinkers();
    spawnSectorThinkers();
    P_RunThinkers();
    assert(used == 4);
    printf("[%d,%d,%d,%d]\\n", startupOrder[0], startupOrder[1], startupOrder[2], startupOrder[3]);
    for (int flickerFirst = 1; flickerFirst >= 0; --flickerFirst) {
        P_InitThinkers();
        M_ClearRandom();
        sectors[0].ceilingheight = 56*U;
        sectors[1].lightlevel = 160;
        ceiling_t ceiling = {.sector=&sectors[0], .direction=-1, .speed=U, .type=crushAndRaise,
            .topheight=56*U, .bottomheight=8*U, .crush=true};
        fireflicker_t light = {.sector=&sectors[1], .count=1, .minlight=80, .maxlight=160};
        ceiling.thinker.function.acp1 = crusherTick;
        light.thinker.function.acp1 = flickerTick;
        player = (mobj_t){.health=100, .height=56*U, .ceilingz=56*U, .flags=MF_SHOOTABLE};
        blocklinks[0] = &player;
        bloodCount = 0;
        P_AddThinker(flickerFirst ? &light.thinker : &ceiling.thinker);
        P_AddThinker(flickerFirst ? &ceiling.thinker : &light.thinker);
        P_RunThinkers();
        printf("[%d,%d,%d,%d,%d,%d,%d,%d]\\n", light.sector->lightlevel, light.count, player.health,
            ceiling.sector->ceilingheight, ceiling.speed, blood.momx, blood.momy, prndindex);
    }
    return 0;
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(line => JSON.parse(line));
}

try {
    const native = values.upstream ? nativeRows(values.upstream) : null;
    const rows = fletcherRows();
    assert.equal(rows.length, 5, "one startup, camera, strobe and two damage traces");
    const [startup, camera, strobe, lightFirst, ceilingFirst] = rows;
    assert.equal(startup[0], "startup");
    const orders = startup.slice(1, 5);
    assert.deepEqual(orders, [0, 1, 2, 3], "timed doors and lights follow sector order at startup");
    assert.ok(startup[5] > Math.max(...orders), "later thinkers append after all startup entries");
    assert.deepEqual(startup.slice(6), [0, 1, 2, 3], "sector identities across the two stores");
    assert.deepEqual(camera, ["camera", true, 1049, 3, 10499, 152, true, 0, 41], "camera-only pass ticks waiting doors and lights");
    assert.deepEqual(strobe, ["strobe", true, 3, 1, true, true, 35, 64, 1], "crossing line 17 appends and ticks a shared-sector strobe");
    const common = [4, 90, 55 * unit, unit / 8, true];
    assert.deepEqual(lightFirst, ["mixed", true, 160, ...common, -19 * 4096, 42 * 4096, 7, 7, 41, 41]);
    assert.deepEqual(ceilingFirst, ["mixed", true, 112, ...common, -2 * 4096, 92 * 4096, 7, 7, 41, 41]);
    if (native) {
        const startupTypes = [10, 17, 14, 8];
        const scheduled = orders.map((order, i) => [order, startupTypes[i]]).sort(([a], [b]) => a - b).map(([, type]) => type);
        const observed = [scheduled, ...[lightFirst, ceilingFirst].map(row => [...row.slice(2, 7), ...row.slice(8, 11)])];
        assert.deepEqual(observed, native, "pinned sector spawn loop, thinker execution, flicker and crusher");
    }
    console.log("Sector thinker order passed startup, camera-only ticking, a triggered strobe, and both crusher/flicker RNG orders.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-sector-thinker-order-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
