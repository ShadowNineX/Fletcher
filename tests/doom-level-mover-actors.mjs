// Exercise the public level-mover integration API with a compact compiled BSP.
// The generated geometry and actors are synthetic. No Doom WAD or artwork is
// needed for these actor/plane regression cases.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-level-mover-actors-"));
const entry = path.join(scratch, "main.flt");
const output = path.join(scratch, "map.json");
const unit = 65536;

// One 0..40 sector with a valid BLOCKMAP and sector-line bounds. It is small
// enough to make the actor contact scan deterministic while still exercising
// the exact runtime path used by movers.
function fixture(timed = false) {
    const vertices = Buffer.alloc(8), lines = Buffer.alloc(42), sides = Buffer.alloc(60);
    const sectors = Buffer.alloc(52), segs = Buffer.alloc(12), subsectors = Buffer.alloc(4);
    vertices.writeInt16LE(-32, 2);
    vertices.writeInt16LE(32, 6);
    lines.writeUInt16LE(1, 2);
    lines.writeUInt16LE(4, 4);
    lines.writeUInt16LE(1, 6);
    lines.writeUInt16LE(1, 12);
    lines.copy(lines, 14, 0, 14);
    lines.writeUInt16LE(58, 20);  // raise the other sector by 24
    lines.writeUInt16LE(7, 22);
    lines.copy(lines, 28, 0, 14);
    lines.writeUInt16LE(118, 34); // fast open-stay door
    sides.writeUInt16LE(1, 58);
    sectors.writeInt16LE(40, 2);
    sectors.writeInt16LE(16, 26);
    sectors.writeInt16LE(timed ? 17 : 32, 28);
    if (timed) sectors.writeInt16LE(10, 48);
    sectors.writeInt16LE(7, 50);
    segs.writeUInt16LE(1, 2);
    subsectors.writeUInt16LE(1);
    const words = [-128, -128, 4, 4, ...Array(16).fill(20), 0, -1];
    const blocks = Buffer.alloc(words.length * 2);
    words.forEach((word, index) => blocks.writeInt16LE(word, index * 2));
    const lumps = [
        ["Vertices", vertices, 2], ["Lines", lines, 3], ["Sides", sides, 2], ["Sectors", sectors, 2],
        ["Segs", segs, 1], ["Subsectors", subsectors, 1], ["BlockMap", blocks, blocks.length],
    ];
    writeFileSync(path.join(scratch, timed ? "TIMED.BIN" : "MAP.BIN"), Buffer.concat(lumps.map(([, bytes]) => bytes)));
    let offset = 0;
    return lumps.map(([name, bytes, count]) => {
        const field = `${name}: wad.Lump{Offset: ${offset}, Count: ${count}, Valid: true}`;
        offset += bytes.length;
        return field;
    }).join(",\n");
}

try {
    writeFileSync(entry, `package main
import "actorinfo"
import "play"
import "wad"

const Unit = ${unit}
const Geometry = readFile("MAP.BIN")
const TimedGeometry = readFile("TIMED.BIN")

func testActor(height int) play.LevelActor {
    info := actorinfo.KindAt(actorinfo.ActorPossessed)
    return play.LevelActor{Valid: true, Kind: actorinfo.ActorPossessed, Health: 100, State: info.SpawnState,
        Physics: play.ActorPhysics{Body: play.MapActor{X: -64 * Unit, Y: -64 * Unit, Z: 0,
            Floor: 0, Ceiling: 40 * Unit, Radius: 8 * Unit, Height: height * Unit,
            Flags: play.ActorShootable | play.ActorSolid}}}
}

func worldWith(actor play.LevelActor, blocks wad.BlockMapInfo) play.CombatWorld {
    playerInfo := actorinfo.KindAt(actorinfo.ActorPlayer)
    player := play.LevelActor{Valid: true, Kind: actorinfo.ActorPlayer, PlayerSlot: 0, Health: 100,
        State: playerInfo.SpawnState, Physics: play.ActorPhysics{Body: play.MapActor{X: 192 * Unit, Y: 64 * Unit,
            Floor: 0, Ceiling: 40 * Unit, Player: true}}}
    actors := play.MapActors{}.AppendActor(player)
    actors = actors.AppendActor(actor)
    world := play.CombatWorld{Actors: actors, Links: play.BuildActorLinks(actors, blocks)}
    world.Players[0] = play.NewPlayerInventory(100)
    return world
}

type QueueFloorOnPain struct {}

func (handler QueueFloorOnPain) OnTelefrag(state play.WalkoverState, event play.CombatStep, rules play.CombatRules) play.WalkoverState {
    if event.State.Action == actorinfo.ActionPain {
        state.Specials = play.CrossLevelSpecial(state.Level, state.Specials, 1)
        state.Level = state.Specials.ApplyTo(state.Level)
    }
    return state
}

map "Doom level mover actors" {
    screen at (-64, -48) size (128, 96) with { style = "solid" }
    tick {
        base := wad.BspLevel{Valid: true, File: Geometry, Nodes: wad.Lump{Valid: true}, ${fixture()}}
        blocks := wad.LoadBlockMap(base)

        switch currentTick() {
        case 0:
            // A normal closing door must reverse and restore the attempted ceiling
            // when a live non-player actor no longer fits.
            var closing play.LevelSpecials
            closing.Doors = closing.Doors.Append(play.SectorDoor{Sector: 0, Order: 0,
                State: play.DoorState{Active: true, Ceiling: 40 * Unit, Floor: 0, Top: 40 * Unit,
                    Speed: 2 * Unit, Direction: -1, Mode: play.DoorNormal}})
            door := play.TickLevelMoversWithActors(base, blocks, closing, worldWith(testActor(40), blocks), 1, 1,
                play.CombatRules{Skill: 2}, play.DefaultWalkoverTelefrag{})
            doorBody := door.World.Actors.ActorAt(1).Physics.Body
            doorState := door.State.Doors.EntryAt(door.State.Doors.First()).State
            log("door", door.Valid, doorState.Ceiling / Unit, doorState.Direction, doorBody.Floor / Unit, doorBody.Ceiling / Unit)
            log("door-sound", door.Sounds.Count, door.Sounds.At(0).Id, door.Sounds.At(0).Sector)

            initial := play.UseActorLine(base, play.LevelSpecials{}, 0, false, true, play.PlayerInventory{})
            reused := initial.State
            reused.Doors = reused.Doors.ClearSounds()
            toggled := play.UseActorLine(base, reused, 0, false, true, play.PlayerInventory{})
            log("manual-sound", initial.State.Doors.Sounds.Count, initial.State.Doors.Sounds.At(0).Id,
                initial.State.Doors.Sounds.At(0).Sector, toggled.State.Doors.Sounds.Count)

            // Floors carry every linked actor standing on their support plane.
            var lifting play.LevelSpecials
            lifting.Floors = lifting.Floors.Append(play.SectorFloor{Sector: 0, Order: 0,
                Motion: play.FloorState{Active: true, Height: 0, Destination: 24 * Unit,
                    Speed: 2 * Unit, Direction: 1, Mode: play.FloorRaise}})
            liftHandle := lifting.Floors.First()
            floor := play.TickLevelMoversWithActors(base, blocks, lifting, worldWith(testActor(32), blocks), 1, 1,
                play.CombatRules{Skill: 2}, play.DefaultWalkoverTelefrag{})
            floorBody := floor.World.Actors.ActorAt(1).Physics.Body
            log("floor", floor.Valid, floor.Changed, floor.ActorsChanged, floor.State.Floors.EntryAt(liftHandle).Motion.Height / Unit,
                floorBody.Z / Unit, floorBody.Floor / Unit)

            liftMotion := lifting.Floors.EntryAt(liftHandle).Motion
            liftMotion.Destination = Unit
            lifting.Floors = lifting.Floors.WithMotion(liftHandle, liftMotion)
            lifting.Doors.Switches.Buttons[0] = play.ButtonTimer{Tics: 1, Line: 0, Side: 0, Tier: wad.SwitchMiddle}
            lifting.Doors.Switches.ButtonCount = 1
            ending := play.TickLevelMoversWithActors(base, blocks, lifting, worldWith(testActor(32), blocks), 1, 8,
                play.CombatRules{Skill: 2}, play.DefaultWalkoverTelefrag{})
            finishButtons := ending.State.Doors.TickButtonTimers(base)
            log("floor-sounds", ending.Valid, ending.Sounds.Count, ending.Sounds.At(0).Id, ending.Sounds.At(0).Sector,
                ending.Sounds.At(1).Id, ending.Sounds.At(1).Sector, ending.State.Doors.Switches.ButtonCount,
                finishButtons.Sounds.At(0).Id, finishButtons.Sounds.At(0).Sector, finishButtons.Switches.ButtonCount)

            // Crushers retain their downward plane advance. They only apply damage
            // on the original four-tic cadence, and add the ordinary blood effect.
            var crushing play.LevelSpecials
            crushing.Ceilings = crushing.Ceilings.Append(play.SectorCeiling{Sector: 0, Order: 0,
                Motion: play.CeilingState{Active: true, Height: 40 * Unit, Bottom: 8 * Unit,
                    Speed: 2 * Unit, Direction: -1, Mode: play.CeilingCrushAndRaise, Crush: true}})
            firstCrush := play.TickLevelMoversWithActors(base, blocks, crushing, worldWith(testActor(40), blocks), 1, 1,
                play.CombatRules{Skill: 2}, play.DefaultWalkoverTelefrag{})
            secondCrush := play.TickLevelMoversWithActors(base, blocks, firstCrush.State, firstCrush.World, 1, 4,
                play.CombatRules{Skill: 2}, play.DefaultWalkoverTelefrag{})
            victim := secondCrush.World.Actors.ActorAt(1)
            blood := secondCrush.World.Actors.ActorAt(2)
            log("crusher", firstCrush.State.Ceilings.EntryAt(1).Motion.Height / Unit,
                secondCrush.State.Ceilings.EntryAt(1).Motion.Height / Unit, victim.Health,
                secondCrush.ActorsChanged, secondCrush.World.Actors.Count, blood.Valid, blood.Kind == actorinfo.ActorBlood)

            // A blocked overshooting close reports its terminal completion even
            // though P_ChangeSector restores the ceiling. Thinker release is the
            // observable side effect that later specials depend upon.
            var terminalState play.LevelSpecials
            terminalState.Doors = terminalState.Doors.Append(play.SectorDoor{Sector: 0, Order: 0,
                State: play.DoorState{Active: true, Ceiling: Unit, Floor: 0, Top: Unit,
                    Speed: 2 * Unit, Direction: -1, Mode: play.DoorNormal}})
            terminal := play.TickLevelMoversWithActors(base, blocks, terminalState, worldWith(testActor(1), blocks), 1, 1,
                play.CombatRules{Skill: 2}, play.DefaultWalkoverTelefrag{})
            log("terminal", terminal.Valid, terminal.State.ApplyTo(base).SectorHeightsAt(0).Ceiling / Unit,
                terminal.State.Doors.Count, terminal.State.MoverOccupied(0))

            // When both the attempted and restored openings are too short, the
            // terminal crushing step visits the victim twice in the same tic.
            terminalMotion := crushing.Ceilings.EntryAt(1).Motion
            terminalMotion.Bottom = 39 * Unit
            crushing.Ceilings = crushing.Ceilings.WithMotion(1, terminalMotion)
            overshoot := play.TickLevelMoversWithActors(base, blocks, crushing, worldWith(testActor(56), blocks), 1, 4,
                play.CombatRules{Skill: 2}, play.DefaultWalkoverTelefrag{})
            restored := overshoot.State.Ceilings.EntryAt(1).Motion
            log("terminal-crush", overshoot.Valid, overshoot.Changed, restored.Height / Unit, restored.Direction,
                overshoot.World.Actors.ActorAt(1).Health, overshoot.World.Actors.Count)
        case 1:
            var queued play.LevelSpecials
            queued.Floors = queued.Floors.Append(play.SectorFloor{Sector: 1, Order: 0,
                Motion: play.FloorState{Active: true, Height: 16 * Unit, Destination: 16 * Unit,
                    Speed: Unit, Direction: 1, Mode: play.FloorRaise}})
            queued = play.TickLevelMovers(base, blocks, queued, play.MapActor{}).State
            log("retired-floor", queued.Floors.Count, queued.ApplyTo(base).SectorHeightsAt(1).Floor / Unit)

            queued.Doors.NextMover = 3
            queued.Floors = queued.Floors.Append(play.SectorFloor{Sector: 0, Order: 2,
                Motion: play.FloorState{Active: true, Destination: 24 * Unit, Speed: 2 * Unit,
                    Direction: 1, Mode: play.FloorRaiseCrush, Crush: true}})
            // This kind invokes A_Pain immediately on its pain-state entry.
            target := testActor(40)
            target.Kind, target.State = actorinfo.ActorCyborg, actorinfo.KindAt(actorinfo.ActorCyborg).SpawnState
            stepped := play.TickLevelMoversWithActors(base, blocks, queued, worldWith(target, blocks), 1, 8,
                play.CombatRules{Skill: 2}, QueueFloorOnPain{})
            floors := stepped.State.Floors
            first := floors.First()
            old, appended := floors.EntryAt(first), floors.EntryAt(floors.Following(first))
            log("reused-floor", stepped.Valid, stepped.State.Floors.Count, old.Sector, old.Order, old.Motion.Height / Unit,
                appended.Sector, appended.Order, appended.Motion.Height / Unit, stepped.World.Actors.ActorAt(1).Health,
                stepped.World.Random.GameplayIndex, stepped.State.Lighting.Random.GameplayIndex,
                stepped.Sounds.Count, stepped.Sounds.At(0).Sector, stepped.Sounds.At(1).Sector)
        case 2:
            var overlap play.LevelSpecials
            overlap.Ceilings = overlap.Ceilings.Append(play.SectorCeiling{Sector: 1, Order: 0,
                Motion: play.CeilingState{Active: true, Height: 32 * Unit, Bottom: 16 * Unit,
                    Speed: Unit, Direction: -1, Mode: play.CeilingLowerToFloor}})
            overlap.Doors.NextMover = 1
            overlapping := play.UseActorLine(overlap.ApplyTo(base), overlap, 2, false, true, play.PlayerInventory{}).State
            log("overlap-start", overlapping.Doors.Count, overlapping.Ceilings.Count, overlapping.MoverOccupied(1))
            open := play.TickLevelMovers(base, blocks, overlapping, play.MapActor{}).State
            log("overlap-open", open.Doors.Count, open.Ceilings.Count, open.MoverOccupied(1), open.ApplyTo(base).SectorHeightsAt(1).Ceiling / Unit)
            resumed := play.TickLevelMovers(base, blocks, open, play.MapActor{}).State
            log("overlap-resume", resumed.Ceilings.Count, resumed.MoverOccupied(1), resumed.ApplyTo(base).SectorHeightsAt(1).Ceiling / Unit)
        case 3:
            timedBase := wad.BspLevel{Valid: true, File: TimedGeometry, Nodes: wad.Lump{Valid: true}, ${fixture(true)}}
            timed := play.LoadTimedDoors(timedBase)
            log("timed-spawn", timedBase.SectorSpecial(1), timed.Count, timed.ApplyTo(timedBase).SectorSpecial(1))
            timedHandle := timed.First()
            timedState := timed.EntryAt(timedHandle).State
            timedState.Countdown = 1
            timed = timed.WithState(timedHandle, timedState)
            timed = play.TickLevelDoors(timedBase, blocks, timed, play.MapActor{}).Doors
            retired := play.TickLevelDoors(timedBase, blocks, timed, play.MapActor{}).Doors
            settled := retired.ApplyTo(timedBase)
            log("timed-retired", retired.Count, settled.SectorSpecial(1), settled.SectorHeightsAt(1).Ceiling / Unit)
            reopened := play.UseActorLine(settled, play.LevelSpecials{Doors: retired}, 2, false, true, play.PlayerInventory{}).State
            reopened = play.TickLevelMovers(timedBase, blocks, reopened, play.MapActor{}).State
            log("timed-reopen", reopened.Doors.Count, reopened.ApplyTo(timedBase).SectorSpecial(1),
                reopened.ApplyTo(timedBase).SectorHeightsAt(1).Ceiling / Unit)
        }
    }
}
`);

    const build = spawnSync("dotnet", [cli, "build", entry, "--package-root", path.join(root, "examples", "doom-engine"),
        "--asset-root", scratch, "-o", output], { cwd: root, encoding: "utf8", timeout: 30000 });
    if (build.error) throw build.error;
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let tic = 0; tic < 4; tic++) sim.step();
    const rows = new Map(sim.logs.map(row => [row[0], Array.from(row.slice(1), Number)]));

    assert.deepEqual(rows.get("door"), [1, 40, 1, 0, 40],
        "a normal blocked door reverses and restores the live sector height");
    assert.deepEqual(rows.get("door-sound"), [1, 20, 0], "an obstructed door uses the normal open sound");
    assert.deepEqual(rows.get("manual-sound"), [1, 20, 1, 0], "a new manual door sounds once and a manual reversal is silent");
    assert.deepEqual(rows.get("floor"), [1, 1, 1, 2, 2, 2],
        "a rising floor carries an ordinary linked actor on its support plane");
    assert.deepEqual(rows.get("floor-sounds"), [1, 2, 22, 0, 19, 0, 1, 23, 0, 0],
        "floor movement precedes its stop sound and the button reset");
    assert.deepEqual(rows.get("crusher"), [38, 37, 90, 1, 3, 1, 1],
        "a crusher advances through obstruction, damages on tic four, and spawns blood");
    assert.deepEqual(rows.get("terminal"), [1, 1, 0, 0],
        "a blocked terminal door move keeps completion and thinker-release side effects");
    assert.deepEqual(rows.get("terminal-crush"), [1, 0, 40, 1, 80, 4],
        "terminal crusher rollback applies both sector checks and keeps their damage and blood");
    assert.deepEqual(rows.get("retired-floor"), [0, 16], "a completed floor releases its slot and keeps its height");
    // Both callbacks sound on tic eight. The second plane is blocked by the
    // still-obstructed thing in the shared block box, so its height stays 16.
    assert.deepEqual(rows.get("reused-floor"), [1, 2, 0, 2, 2, 1, 3, 16, 90, 6, 6, 2, 0, 1],
        "an action can restart a completed floor without overwriting its caller or postponing its own tick");
    assert.deepEqual(rows.get("overlap-start"), [1, 1, 1], "a fast manual door appends over a lowering ceiling");
    assert.deepEqual(rows.get("overlap-open"), [0, 1, 0, 36], "the retiring door frees ownership and leaves the older thinker scheduled");
    assert.deepEqual(rows.get("overlap-resume"), [1, 0, 35], "the older thinker continues from the shared height");
    assert.deepEqual(rows.get("timed-spawn"), [10, 1, 0], "a timed door clears its startup sector special");
    assert.deepEqual(rows.get("timed-retired"), [0, 0, 16], "standalone ticking retains height and the cleared special without a live door");
    assert.deepEqual(rows.get("timed-reopen"), [1, 0, 24], "a new door starts from the stored height");
    console.log("Verified mover clipping, floor riders, crushers, terminal doors, shared ceilings, and same-tic slot reuse.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-level-mover-actors-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
