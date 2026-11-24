// An imp fireball clears a 64-unit ceiling, but the same horizontal step
// explodes when an earlier thinker lowers that ceiling to 60 units.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-mixed-thinker-order-"));
const unit = 65536;

function run(command, args) {
    const result = spawnSync(command, args, { cwd: scratch, encoding: "utf8", timeout: 60_000,
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function words(values) {
    const buffer = Buffer.alloc(values.length * 2);
    values.forEach((value, i) => buffer.writeUInt16LE(value & 0xffff, i * 2));
    return buffer;
}

function room() {
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0]];
    const angles = [0x4000, 0, 0xc000, 0x8000];
    const sector = Buffer.alloc(26);
    sector.writeUInt16LE(64, 2);
    const blocks = words([-128, -128, 2, 2, 8, 8, 8, 8, 0, 1, 2, 3, -1]);
    const lumps = [
        ["Vertices", 4, words([-96, -96, -96, 96, 96, 96, 96, -96])],
        ["Lines", 4, words(edges.flatMap(([a, b]) => [a, b, 1, 0, 0, 0, -1]))],
        ["Sides", 1, Buffer.alloc(30)], ["Sectors", 1, sector], ["Nodes", 0, Buffer.alloc(0)],
        ["Segs", 4, words(edges.flatMap(([a, b], i) => [a, b, angles[i], i, 0, 0]))],
        ["Subsectors", 1, words([4, 0])], ["BlockMap", blocks.length, blocks],
    ];
    writeFileSync(path.join(scratch, "LEVEL.WAD"), Buffer.concat(lumps.map(([, , bytes]) => bytes)));
    let offset = 0;
    return lumps.map(([name, count, bytes]) => {
        const field = `${name}: wad.Lump{Valid: true, Offset: ${offset}, Count: ${count}}`;
        offset += bytes.length;
        return field;
    }).join(",\n");
}

function previewRows() {
    for (const file of ["combat-preview", "monster-preview", "action-preview", "player-preview", "teleport-preview", "sound-cues"]) {
        copyFileSync(path.join(port, "wad-bsp", file + ".flt"), path.join(scratch, file + ".flt"));
    }
    const entry = path.join(scratch, "main.flt");
    writeFileSync(entry, `package main
import "actorinfo"
import "play"
import "wad"
const Archive = readFile("LEVEL.WAD")
map "Spawned missile and moving plane" {
    tick {
        tic := currentTick()
        level := wad.BspLevel{File: Archive, Valid: true, ${room()}}
        blocks := wad.LoadBlockMap(level)
        random := play.RandomState{GameplayIndex: 1, MenuIndex: 7}
        player := play.SpawnMobj(level, actorinfo.ActorPlayer, -(64 << 16), -(32 << 16), play.ActorOnFloor, 2, random).Actor
        player.PlayerSlot, player.Physics.Body.Player = 0, true
        if tic >= 2 { player.Physics.Body.Height = 64 << 16 }
        shot := play.SpawnMobj(level, actorinfo.ActorTroopShot, 40 << 16, 8 << 16, 54 << 16, 2, random).Actor
        shot.Physics.MomentumX = 4 << 16
        actors := play.MapActors{}.AppendActor(player)
        actors.PlayerActors[0] = 1
        missileOrder := tic
        if tic >= 2 { missileOrder = 0 }
        planeOrder, nextOrder := 1 - missileOrder, 2
        if tic == 2 { planeOrder, nextOrder = 0, 1 }
        actors.NextThinkerOrder = missileOrder
        order, afterAppend := -1, 0
        if tic != 2 {
            actors = actors.AppendTransient(shot)
            order, afterAppend = actors.TransientOrder(2), actors.NextThinkerOrder
        }
        actors.NextThinkerOrder = nextOrder
        links := play.BuildActorLinks(actors, blocks)
        var specials play.LevelSpecials
        specials.Doors.NextMover = nextOrder
        motion := play.StartCeiling(play.CeilingLowerToFloor, 64 << 16, 0, 0)
        levelTime := 1
        if tic >= 2 {
            motion = play.StartCeiling(play.CeilingCrushAndRaise, 64 << 16, 0, 0)
            levelTime = 4
        }
        motion.Speed = 4 << 16
        specials.Ceilings = specials.Ceilings.Append(play.SectorCeiling{Sector: 0, Order: planeOrder, Motion: motion})
        specials.Lighting.Random = random
        world := play.CombatWorld{Actors: actors, Links: links, Random: random}
        world.Players[0] = play.NewPlayerInventory(100)
        scene := PreviewCombat{World: world, Base: level, Level: level, Specials: specials, MapActors: 1, Rules: play.CombatRules{Skill: 2}}
        step := tickPreviewDynamicThinkers(scene, blocks, levelTime)
        scene = step.Combat
        if tic < 2 {
            shot = scene.World.Actors.ActorAt(1)
            info := actorinfo.KindAt(actorinfo.ActorTroopShot)
            log(scene.Failed, step.MoverChanged, order, afterAppend, scene.World.Actors.Count,
                scene.World.Actors.TransientFirst(), scene.World.Actors.TransientNext(2),
                scene.Level.SectorHeightsAt(0).Ceiling, scene.World.Actors.ActorAt(0).Physics.Body.Ceiling,
                shot.Valid, shot.Physics.Body.Flags & play.MoveMissile != 0, shot.State == info.DeathState, shot.Tics,
                shot.Physics.Body.X, shot.Physics.Body.Z, shot.Physics.MomentumX, shot.Physics.Body.Ceiling,
                scene.World.Random.GameplayIndex, scene.Specials.Lighting.Random.GameplayIndex, scene.World.Random.MenuIndex)
        } else {
            actors = scene.World.Actors
            bloodHandle := actors.Count
            blood := actors.ActorAt(bloodHandle - 1)
            log("sector-append", scene.Failed, scene.World.Players[0].Health, actors.TransientFirst(),
                actors.TransientNext(2), actors.TransientNext(bloodHandle), actors.TransientOrder(bloodHandle),
                actors.NextThinkerOrder, blood.Valid && blood.Kind == actorinfo.ActorBlood, blood.Tics,
                blood.Physics.Body.Z, blood.Physics.MomentumZ, scene.World.Random.GameplayIndex)
        }
    }
}`);
    const output = path.join(scratch, "order.json");
    run("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let i = 0; i < 4; ++i) sim.step();
    return Array.from(sim.logs, row => Array.from(row));
}

function nativeRows(upstream) {
    const read = name => readFileSync(path.resolve(root, upstream, name), "utf8").replaceAll("\r\n", "\n");
    const tick = read("p_tick.c"), map = read("movement-p_map.c"), mobj = read("p_mobj.c"), enemy = read("p_enemy.c");
    const flags = read("p_mobj.h").match(/typedef enum\s*\{[\s\S]*?\}\s*mobjflag_t;/)?.[0];
    assert.ok(flags?.includes("MF_NOBLOCKMAP"));
    const stateTable = read("info.c").split("\n");
    const states = ["S_TBALL1", "S_TBALL2", "S_TBALLX1", "S_TBALLX2", "S_TBALLX3"].map(name => {
        const row = stateTable.find(line => line.trimEnd().endsWith("// " + name));
        assert.ok(row, "missing original projectile state " + name);
        return `[${name}] = ${row.split("//")[0].trim()}`;
    });
    states.push("[S_SC1] = {0,0,1,{0},S_SC2,0,0},", "[S_SC2] = {0,0,5,{A_Scream},S_SC2,0,0}");
    const source = path.join(scratch, "mixed.c"), exe = path.join(scratch, "mixed.exe");
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
${flags}
enum { FRACUNIT=65536, VIEWHEIGHT=41*FRACUNIT, MAXMOVE=30*FRACUNIT, FLOATSPEED=4*FRACUNIT,
    GRAVITY=FRACUNIT, CEILSPEED=FRACUNIT, FRICTION=0xe800, STOPSPEED=0x1000, CF_NOMOMENTUM=4 };
enum { S_NULL, S_TBALL1, S_TBALL2, S_TBALLX1, S_TBALLX2, S_TBALLX3, S_PLAY, S_PLAY_RUN1, S_SC1, S_SC2 };
enum { SPR_BAL1, sfx_firxpl, sfx_oof, sfx_stnmov, sfx_pstop, sfx_podth1=59, sfx_podth2, sfx_podth3, sfx_bgdth1=62, sfx_bgdth2, MT_SPIDER=19, MT_CYBORG=20 };
enum { lowerToFloor, raiseToHighest, lowerAndCrush, crushAndRaise, fastCrushAndRaise, silentCrushAndRaise };
typedef enum { ok, crushed, pastdest } result_e;
typedef int statenum_t;
typedef struct mobj_s mobj_t;
typedef struct { int sprite, frame, tics; struct { void (*acp1)(mobj_t *); } action; int nextstate, misc1, misc2; } state_t;
static void A_Scream(mobj_t *actor);
static state_t states[] = {
${states.join("\n")}
};
typedef struct { int spawnstate, deathstate, deathsound; } mobjinfo_t;
typedef struct { fixed_t floorheight, ceilingheight; int soundorg, ceilingpic; } sector_t;
typedef struct { int special; sector_t *backsector; } line_t;
typedef struct { sector_t *sector; } subsector_t;
typedef struct { mobj_t *mo; int cheats, viewheight, deltaviewheight; struct { int forwardmove, sidemove; } cmd; } player_t;
struct mobj_s {
    thinker_t thinker;
    fixed_t x, y, z, height, floorz, ceilingz, momx, momy, momz;
    int type, flags, tics, sprite, frame, movecount;
    state_t *state;
    mobjinfo_t *info;
    player_t *player;
    mobj_t *target;
    subsector_t *subsector;
};
typedef struct { thinker_t thinker; sector_t *sector; int type, direction, speed, topheight, bottomheight, crush; } ceiling_t;
static thinker_t thinkercap;
static sector_t room;
static mobj_t player, shot, screamer;
static mobjinfo_t mobjinfo[] = {{S_TBALL1, S_TBALLX1, sfx_firxpl}, {S_SC1, S_SC1, sfx_podth1}};
static int respawnmonsters, leveltime=1, skyflatnum, numspechit, lastSound;
static line_t *ceilingline, *spechit[1], lines[1];
static fixed_t tmfloorz, tmceilingz, tmdropoffz;
static boolean floatok;
${read("light-m_random.c")}
static void Z_Free(void *p) { abort(); }
static void P_RemoveMobj(mobj_t *m) { abort(); }
static void P_NightmareRespawn(mobj_t *m) { abort(); }
static void P_RemoveActiveCeiling(ceiling_t *c) { abort(); }
static void P_SlideMove(mobj_t *m) { abort(); }
static fixed_t P_AproxDistance(fixed_t x, fixed_t y) { abort(); }
static fixed_t FixedMul(fixed_t x, fixed_t y) { abort(); }
static int P_PointOnLineSide(fixed_t x, fixed_t y, line_t *line) { abort(); }
static void P_CrossSpecialLine(int line, int side, mobj_t *m) { abort(); }
static void S_StartSound(mobj_t *m, int sound) { assert(m == &shot || m == &screamer); lastSound = sound; }

// No blockers or crossed lines inside the test room. P_TryMove performs the
// native height checks and relinks only a successful horizontal step.
static boolean P_CheckPosition(mobj_t *m, fixed_t x, fixed_t y) {
    assert(x > -96*FRACUNIT && x < 96*FRACUNIT && y > -96*FRACUNIT && y < 96*FRACUNIT);
    tmfloorz = tmdropoffz = room.floorheight;
    tmceilingz = room.ceilingheight;
    numspechit = 0;
    return true;
}

static void P_UnsetThingPosition(mobj_t *m) { assert(m == &shot && (m->flags & MF_NOBLOCKMAP)); }
static void P_SetThingPosition(mobj_t *m) { assert(m == &shot && (m->flags & MF_NOBLOCKMAP)); }
${extractFunction(tick, "void", "P_InitThinkers")}
${extractFunction(tick, "void", "P_AddThinker")}
${extractFunction(tick, "void", "P_RunThinkers")}
${extractFunction(map, "boolean", "P_TryMove")}
${extractFunction(map, "boolean", "P_ThingHeightClip")}
static boolean P_ChangeSector(sector_t *s, boolean crush) {
    assert(s == &room && !crush && (shot.flags & MF_NOBLOCKMAP));
    return !P_ThingHeightClip(&player); // The player is the only block-linked actor.
}
${extractFunction(read("door-p_floor.c"), "result_e", "T_MovePlane")}
${extractFunction(read("ceiling-p_ceilng.c"), "void", "T_MoveCeiling")}
${extractFunction(mobj, "boolean", "P_SetMobjState")}
${extractFunction(mobj, "void", "P_ExplodeMissile")}
${extractFunction(mobj, "void", "P_XYMovement")}
${extractFunction(mobj, "void", "P_ZMovement")}
${extractFunction(mobj, "void", "P_MobjThinker")}
${extractFunction(enemy, "void", "A_Scream")}
static void missileTick(thinker_t *t) { P_MobjThinker((mobj_t *)t); }
static void ceilingTick(thinker_t *t) { T_MoveCeiling((ceiling_t *)t); }

int main(void) {
    for (int missileOrder=0; missileOrder<=1; ++missileOrder) {
        P_InitThinkers();
        prndindex=1;
        room=(sector_t){.ceilingheight=64*FRACUNIT};
        player=(mobj_t){.x=-64*FRACUNIT, .y=-32*FRACUNIT, .height=56*FRACUNIT, .ceilingz=room.ceilingheight};
        shot=(mobj_t){.x=40*FRACUNIT, .y=8*FRACUNIT, .z=54*FRACUNIT, .momx=4*FRACUNIT, .height=8*FRACUNIT,
            .ceilingz=room.ceilingheight, .flags=MF_NOBLOCKMAP|MF_MISSILE|MF_DROPOFF|MF_NOGRAVITY,
            .state=&states[S_TBALL1], .tics=states[S_TBALL1].tics, .info=&mobjinfo[0]};
        ceiling_t ceiling={.sector=&room, .type=lowerToFloor, .direction=-1, .speed=4*FRACUNIT};
        shot.thinker.function.acp1=missileTick;
        ceiling.thinker.function.acp1=ceilingTick;
        P_AddThinker(missileOrder == 0 ? &shot.thinker : &ceiling.thinker);
        P_AddThinker(missileOrder == 0 ? &ceiling.thinker : &shot.thinker);
        P_RunThinkers();
        printf("[%d,%d,%d,%d,%d,%d,%d,%d,%d,%d]\\n", room.ceilingheight, player.ceilingz,
            !!(shot.flags & MF_MISSILE), shot.state == &states[S_TBALLX1], shot.tics,
            shot.x, shot.z, shot.momx, shot.ceilingz, prndindex);
    }
    P_InitThinkers();
    prndindex=1; room=(sector_t){.ceilingheight=64*FRACUNIT};
    player=(mobj_t){.x=-64*FRACUNIT,.y=-32*FRACUNIT,.height=56*FRACUNIT,.ceilingz=room.ceilingheight};
    screamer=(mobj_t){.state=&states[S_SC1],.tics=1,.info=&mobjinfo[1]};
    shot=(mobj_t){.x=40*FRACUNIT,.y=8*FRACUNIT,.z=54*FRACUNIT,.momx=4*FRACUNIT,.height=8*FRACUNIT,.ceilingz=room.ceilingheight,
        .flags=MF_NOBLOCKMAP|MF_MISSILE|MF_DROPOFF|MF_NOGRAVITY,.state=&states[S_TBALL1],.tics=4,.info=&mobjinfo[0]};
    ceiling_t actionCeiling={.sector=&room,.type=lowerToFloor,.direction=-1,.speed=4*FRACUNIT};
    screamer.thinker.function.acp1=missileTick; actionCeiling.thinker.function.acp1=ceilingTick; shot.thinker.function.acp1=missileTick;
    P_AddThinker(&screamer.thinker); P_AddThinker(&actionCeiling.thinker); P_AddThinker(&shot.thinker);
    for (int tic=0; tic<2; ++tic) {
        lastSound=0; P_RunThinkers();
        printf("[%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d]\\n", room.ceilingheight, screamer.state==&states[S_SC2], screamer.tics,
            !!(shot.flags&MF_MISSILE), shot.state==&states[S_TBALLX1], shot.tics, shot.x, shot.z, shot.momx, prndindex, lastSound);
    }
    return 0;
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(line => JSON.parse(line));
}

function actionRows() {
    for (const file of ["combat-preview", "monster-preview", "action-preview", "player-preview", "teleport-preview", "sound-cues"]) {
        copyFileSync(path.join(port, "wad-bsp", file + ".flt"), path.join(scratch, file + ".flt"));
    }
    const entry = path.join(scratch, "main.flt");
    writeFileSync(entry, `package main
import "actorinfo"
import "play"
import "wad"
const Archive = readFile("LEVEL.WAD")
map "Mixed actor action, ceiling and missile" {
    register saved PreviewCombat = PreviewCombat{}
    tick {
        base := wad.BspLevel{File: Archive, Valid: true, ${room()}}
        blocks := wad.LoadBlockMap(base)
        if currentTick() == 0 {
            random := play.RandomState{GameplayIndex: 1, MenuIndex: 7}
            player := play.SpawnMobj(base, actorinfo.ActorPlayer, -(64 << 16), -(32 << 16), play.ActorOnFloor, 2, random).Actor
            player.PlayerSlot, player.Physics.Body.Player = 0, true
            screamer := play.SpawnMobj(base, actorinfo.ActorPossessed, 0, 0, play.ActorOnFloor, 2, random).Actor
            screamer.State, screamer.Tics = actorinfo.KindAt(actorinfo.ActorPossessed).DeathState, 1
            shot := play.SpawnMobj(base, actorinfo.ActorTroopShot, 40 << 16, 8 << 16, 54 << 16, 2, random).Actor
            shot.Physics.MomentumX = 4 << 16
            actors := play.MapActors{}.AppendActor(player)
            actors.PlayerActors[0], actors.NextThinkerOrder = 1, 0
            actors = actors.AppendTransient(screamer)
            actors.NextThinkerOrder = 2
            actors = actors.AppendTransient(shot)
            var specials play.LevelSpecials
            motion := play.StartCeiling(play.CeilingLowerToFloor, 64 << 16, 0, 0)
            motion.Speed = 4 << 16
            specials.Ceilings = specials.Ceilings.Append(play.SectorCeiling{Sector: 0, Order: 1, Motion: motion})
            specials.Doors.NextMover, specials.Lighting.Random = 3, random
            scene := PreviewCombat{World: play.CombatWorld{Actors: actors, Links: play.BuildActorLinks(actors, blocks), Random: random},
                Base: base, Level: base, Specials: specials, MapActors: 1, Rules: play.CombatRules{Skill: 2}}
            scene.World.Players[0] = play.NewPlayerInventory(100)
            next saved = scene
            // A damaged map actor counting down must still be seen by the
            // map-thinker cursor and renderer. Its scream belongs to the next tic.
            screamer.Tics, screamer.Damaged = 2, true
            scene.World.Actors = actors.WithActor(2, screamer)
            scene.MapActors, scene.LastSound = 2, 9
            scene = tickPreviewActor(scene, blocks, 2, 0)
            after := scene.World.Actors.ActorAt(1)
            log("countdown", scene.Failed, scene.Changed, scene.FirstActive, after.State == screamer.State,
                after.Tics, scene.LastSound, scene.World.Random.GameplayIndex, scene.World.Random.MenuIndex)
        } else if currentTick() <= 2 {
            // LastSound is an observer field; clear it to observe this tic's
            // callback exactly like the native oracle's sound capture.
            scene := saved
            scene.LastSound = 0
            scene = tickPreviewDynamicThinkers(scene, blocks, currentTick() - 1).Combat
            scream, shot := scene.World.Actors.ActorAt(1), scene.World.Actors.ActorAt(2)
            log(scene.Failed, scene.Level.SectorHeightsAt(0).Ceiling, scream.State, scream.Tics,
                shot.Physics.Body.Flags & play.MoveMissile != 0, shot.State, shot.Tics, shot.Physics.Body.X,
                shot.Physics.Body.Z, shot.Physics.MomentumX, scene.World.Random.GameplayIndex,
                scene.Specials.Lighting.Random.GameplayIndex, scene.LastSound)
            next saved = scene
        }
    }
}`);
    const output = path.join(scratch, "action-order.json");
    run("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let host = 0; host < 10 && sim.logs.length < 3; host++) sim.step();
    const rows = Array.from(sim.logs, row => Array.from(row));
    assert.deepEqual(rows.shift(), ["countdown", false, true, 2, true, 1, 9, 1, 7]);
    return rows;
}

try {
    const native = values.upstream ? nativeRows(values.upstream) : null;
    const actionLogs = actionRows();
    assert.ok(actionLogs.every(([failed]) => failed === false), "Fletcher completed both integrated action tics");
    const actions = actionLogs.map(row => row.slice(1).map(Number));
    const rows = previewRows();
    const heights = [60 * unit, 60 * unit, true];
    assert.deepEqual(rows, [
        [false, true, 0, 1, 2, 2, 0, ...heights, true, false, 3, 44 * unit, 54 * unit, 4 * unit, 64 * unit, 1, 1, 7],
        [false, true, 1, 2, 2, 2, 0, ...heights, false, true, 4, 40 * unit, 54 * unit, 0, 64 * unit, 2, 2, 7],
        // Both newborns must execute immediately, with S_BLOOD1 decremented
        // once and downward gravity applied when they start above the floor.
        ["sector-append", false, 90, 2, 0, 0, 1, 2, true, 7, 32 * unit, -2 * unit, 7],
        ["sector-append", false, 90, 2, 3, 0, 2, 3, true, 7, 32 * unit, -2 * unit, 7],
    ], "ordered thinkers and same-tic blood spawns, including an append after an already-visited tail");
    if (native) {
        const comparable = rows.slice(0, 2).map(row => [...row.slice(7, 9), ...row.slice(10, 18)].map(Number));
        assert.deepEqual(comparable, native.slice(0, 2), "native thinker order, plane movement, missile clearance and explosion jitter");
        const comparableActions = actions.map(([ceiling, screamState, screamTics, missile, shotState, shotTics, x, z, momentum, random, , sound]) =>
            [ceiling, screamState == 190 ? 1 : 0, screamTics, missile, shotState == 99 ? 1 : 0,
                shotTics, x, z, momentum, random, sound == 17 ? 1 : 0]);
        const nativeActions = native.slice(2).map(([ceiling, screamState, screamTics, missile, shotState, shotTics, x, z, momentum, random, sound]) =>
            [ceiling, screamState, screamTics, missile, shotState, shotTics, x, z, momentum, random, sound]);
        assert.deepEqual(comparableActions, nativeActions,
            "pinned C actor action, plane movement, missile and shared RNG across two tics");
    }
    assert.deepEqual(actions, [
        [60 * unit, 190, 5, 0, 99, 5, 40 * unit, 54 * unit, 0, 3, 3, 17],
        [56 * unit, 190, 4, 0, 99, 4, 40 * unit, 54 * unit, 0, 3, 3, 0],
    ], "Fletcher state action, plane movement, missile, sound and shared RNG across two tics");
    console.log("Mixed thinker order passed missile clearance, a pinned A_Scream transition, plane movement, shared RNG across two tics, and same-tic crusher blood appends.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-mixed-thinker-order-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
