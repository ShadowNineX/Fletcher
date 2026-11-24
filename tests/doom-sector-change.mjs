import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values, positionals } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } }, allowPositionals: true });
const cli = path.resolve(root, values.cli ?? positionals[0] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-sector-change-"));
const entry = path.join(scratch, "main.flt");
const output = path.join(scratch, "map.json");

// Trace tags keep the native inputs and comparison fields apart from the
// source-derived rows. Case 7 exercises inventory, and 10 high actor handles.
function nativeTrace(source) {
    return values.upstream ? `if tic != 7 && tic != 10 { ${source} }` : "";
}

// One subsector uses sector zero. A two-sided line at x=0 exposes the
// narrower neighbor only to things whose bounding boxes straddle it.
function fixture() {
    const vertices = Buffer.alloc(8), lines = Buffer.alloc(14), sides = Buffer.alloc(60);
    const sectors = Buffer.alloc(52), segs = Buffer.alloc(12), subsectors = Buffer.alloc(4);
    vertices.writeInt16LE(-32, 2);
    vertices.writeInt16LE(32, 6);
    lines.writeUInt16LE(1, 2);
    lines.writeUInt16LE(4, 4);
    lines.writeUInt16LE(1, 12);
    sides.writeUInt16LE(1, 58);
    sectors.writeInt16LE(8);
    sectors.writeInt16LE(40, 2);
    sectors.writeInt16LE(16, 26);
    sectors.writeInt16LE(32, 28);
    segs.writeUInt16LE(1, 2);
    subsectors.writeUInt16LE(1);
    const words = [-128, -128, 4, 4, ...Array(16).fill(20), 0, -1];
    const blocks = Buffer.alloc(words.length * 2);
    words.forEach((word, i) => blocks.writeInt16LE(word, i * 2));
    const lumps = [
        ["Vertices", vertices, 2], ["Lines", lines, 1], ["Sides", sides, 2], ["Sectors", sectors, 2],
        ["Segs", segs, 1], ["Subsectors", subsectors, 1], ["BlockMap", blocks, blocks.length],
    ];
    writeFileSync(path.join(scratch, "MAP.BIN"), Buffer.concat(lumps.map(([, data]) => data)));
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
const Geometry = readFile("MAP.BIN")
func thing(x int, y int, z int, height int, flags bits<32>) play.LevelActor {
    return play.LevelActor{Valid: true, Kind: actorinfo.ActorPlayer, PlayerSlot: -1, Health: 100,
        Physics: play.ActorPhysics{Body: play.MapActor{X: x << 16, Y: y << 16, Z: z << 16,
            Height: height << 16, Radius: 8 << 16, Ceiling: 128 << 16, Flags: flags}}}
}
map "Sector height changes" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        scene := wad.BspLevel{Valid: true, File: Geometry, Nodes: wad.Lump{Valid: true}, ${fixture()}}
        blocks := wad.LoadBlockMap(scene)
        var actors play.MapActors
        health := 100
        tic := currentTick()
        switch tic {
        case 0:
            actors = actors.AppendActor(thing(-64, -64, 0, 16, 0))
            actors = actors.AppendActor(thing(-64, 64, 30, 16, 0))
            actors = actors.AppendActor(thing(64, -64, 2, 12, 0))
            actors = actors.AppendActor(thing(192, 64, 0, 16, 0))
            actors = actors.AppendActor(thing(1, 0, 0, 16, 0))
            actors = actors.AppendActor(thing(64, 64, 0, 16, play.ActorNoBlockMap))
        case 1:
            // The solid neighbor stops P_CheckPosition before the portal.
            actors = actors.AppendActor(thing(1, 0, 0, 16, 0))
            actors = actors.AppendActor(thing(2, 0, 0, 16, play.ActorSolid))
        case 2:
            actors = actors.AppendActor(thing(80, 8, 0, 56, 0))
            corpse := thing(40, 8, 0, 56, play.ActorSolid | play.PickupDropped)
            corpse.Health = 0
            actors = actors.AppendActor(corpse)
            actors = actors.AppendTransient(thing(16, 8, 0, 56, play.PickupDropped))
        case 3, 4, 5, 6, 10:
            if tic == 5 { health = 5 }
            player := thing(40, 8, 0, 56, play.ActorShootable | play.ActorSolid)
            player.Health, player.PlayerSlot, player.Physics.Body.Player = health, 0, true
            actors = actors.AppendActor(player)
            if tic == 10 {
                decoration := thing(192, 64, 0, 16, play.ActorNoBlockMap | play.ActorNoSector)
                for range 1024 { actors = actors.AppendActor(decoration) }
            }
        case 7:
            // Player -> pickup -> decoration in one block. Removing the
            // pickup must leave the decoration reachable by the outer scan.
            actors = actors.AppendActor(thing(80, 8, 0, 16, 0))
            item := thing(41, 8, 0, 16, play.ActorSpecial | play.ActorCountItem)
            item.Sprite = play.SpriteBon1
            actors = actors.AppendActor(item)
            player := thing(40, 8, 0, 16, play.ActorPickup)
            player.PlayerSlot, player.Physics.Body.Player = 0, true
            actors = actors.AppendActor(player)
        case 8:
            actors = actors.AppendActor(thing(48, -52, 0, 56, play.ActorShootable))
            actors = actors.AppendActor(thing(-92, 48, 0, 56, play.ActorShootable))
            actors = actors.AppendActor(thing(-42, 48, 0, 56, play.ActorShootable))
        case 9:
            settled := thing(48, -52, 8, 16, 0)
            settled.Physics.Body.Floor, settled.Physics.Body.Ceiling = 8 << 16, 40 << 16
            actors = actors.AppendActor(settled)
        }
        world := play.CombatWorld{Actors: actors, Links: play.BuildActorLinks(actors, blocks)}
        world.Players[0] = play.NewPlayerInventory(health)
        levelTime := 4
        if tic == 3 { levelTime = 3 }
        ${nativeTrace(`log(-101, levelTime, tic != 6)
            for i := range actors.Count {
                actor := actors.ActorAt(i)
                b := actor.Physics.Body
                log(-102, b.X, b.Y, b.Z, b.Floor, b.Ceiling, b.Radius, b.Height, b.Flags, actor.Health, b.Player)
            }`)}
        result := play.ChangeSector(play.WalkoverState{Level: scene, World: world}, blocks, 0,
            levelTime, tic != 6, play.CombatRules{Skill: 2}, play.DefaultWalkoverTelefrag{})
        world = result.State.World
        ${nativeTrace(`log(-103, result.Blocked, world.Random.GameplayIndex)
            for i := range world.Actors.Count {
                actor := world.Actors.ActorAt(i)
                b := actor.Physics.Body
                if i < actors.Count {
                    log(-103, actor.Valid, b.Floor, b.Ceiling, b.Z, b.Height, b.Radius, actor.Health,
                        actor.State == actorinfo.StateGibs, b.Flags & play.ActorSolid != 0)
                } else {
                    log(-103, actor.Kind == actorinfo.ActorBlood, b.X, b.Y, b.Z, actor.Physics.MomentumX,
                        actor.Physics.MomentumY, actor.Physics.MomentumZ, actor.Tics)
                }
            }`)}
        log(result.State.Failed, result.Blocked, result.Changed, world.Random.GameplayIndex)
        if tic == 0 || tic == 1 {
            for i := range world.Actors.Count {
                body := world.Actors.ActorAt(i).Physics.Body
                log(body.Floor >> 16, body.Ceiling >> 16, body.Z >> 16)
            }
        } else if tic == 2 {
            corpse, item := world.Actors.ActorAt(1), world.Actors.ActorAt(2)
            log(corpse.State == actorinfo.StateGibs, corpse.Physics.Body.Flags & play.ActorSolid == 0,
                corpse.Physics.Body.Height, corpse.Physics.Body.Radius, item.Valid, item.Transient)
            log(world.Links.BlockFirst(1, 1), world.Links.BlockNext(2), world.Actors.ActorAt(0).Physics.Body.Z >> 16)
        } else if tic == 7 {
            log(world.Players[0].Health, world.Players[0].ItemCount, world.Actors.ActorAt(1).Valid,
                world.Actors.ActorAt(0).Physics.Body.Z >> 16, result.PickupSound, result.PickupMessage)
        } else if tic == 8 {
            for i := range 3 {
                blood := world.Actors.ActorAt(3 + i)
                log(blood.Kind == actorinfo.ActorBlood, blood.Physics.Body.X >> 16, blood.Physics.Body.Y >> 16)
            }
        } else if tic == 9 {
            log(world.Actors.ActorAt(0).Health)
        } else if tic == 10 {
            blood := world.Actors.ActorAt(actors.Count)
            log(world.Actors.ActorAt(0).Health, world.Actors.Count, world.Actors.TransientFirst())
            log(blood.Kind == actorinfo.ActorBlood, blood.Transient, blood.Physics.Body.Z >> 16,
                blood.Physics.MomentumX, blood.Physics.MomentumY, blood.Physics.MomentumZ, blood.Tics)
        } else {
            player := world.Actors.ActorAt(0)
            log(player.Health, player.Physics.Body.Height >> 16, world.Players[0].Health, world.Actors.Count)
            if world.Actors.Count == 2 {
                blood := world.Actors.ActorAt(1)
                log(blood.Kind == actorinfo.ActorBlood, blood.Transient, blood.Physics.Body.Z >> 16,
                    blood.Physics.MomentumX, blood.Physics.MomentumY, blood.Physics.MomentumZ, blood.Tics)
            }
        }
        log("sector-frame", tic)
    }
}`);
    const build = spawnSync("dotnet", [cli, "build", entry, "--package-root", path.join(root, "examples/doom-engine"),
        "--asset-root", scratch, "-o", output], { cwd: root, encoding: "utf8", timeout: 30_000 });
    if (build.error) throw build.error;
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    const adjusted = [false, false, true, 0];
    const blocked = [false, true, true, 0];
    const crushed = [false, true, true, 6];
    // P_DamageMobj consumes one roll (pain or death tics), P_SpawnMobj
    // consumes one for lastlook, then PIT_ChangeSector draws four for XY.
    const blood = z => [true, true, z, (220 - 222) << 12, (241 - 149) << 12, 0, 8];
    const expected = [
        ["floor riders, ceiling clamp, portal, BLOCKMAP bounds", [adjusted, [8, 40, 8], [8, 40, 24], [8, 40, 2],
            [0, 128, 0], [16, 32, 16], [0, 128, 0]]],
        ["solid thing before line opening", [adjusted, [8, 40, 8], [16, 32, 16]]],
        ["corpse before dropped flag and removed head preserves successor", [adjusted, [true, true, 0, 0, false, true], [2, 1, 8]]],
        ["crusher between damage tics", [blocked, [100, 56, 100, 1]]],
        ["crushing damage and blood momentum", [crushed, [90, 56, 90, 2], blood(36)]],
        ["lethal crush sprays at post-death height", [crushed, [-5, 14, 0, 2], blood(15)]],
        ["non-crushing plane still reports obstruction", [blocked, [100, 56, 100, 1]]],
        ["pickup in height check preserves next live thing", [adjusted, [101, 1, false, 8, 32, 3]]],
        ["X-major block scan and head-first thing order", [[false, true, true, 18],
            [true, -42, 48], [true, -92, 48], [true, 48, -52]]],
        ["unchanged actor keeps Changed clear", [[false, false, false, 0], [100]]],
        ["blood allocation succeeds beyond the old roster limit", [crushed, [90, 1026, 1026], blood(36)]],
    ];
    const nativeCases = [];
    for (const [tic, [description, rows]] of expected.entries()) {
        const start = sim.logs.length;
        const complete = () => sim.logs.at(-1)?.[0] === "sector-frame" && sim.logs.at(-1)[1] === tic;
        for (let host = 0; host < 500 && !complete(); host++) sim.step();
        assert.ok(complete(), description);
        const trace = Array.from(sim.logs.slice(start, -1), row => Array.from(row));
        assert.deepEqual(trace.filter(row => ![-101, -102, -103].includes(row[0])), rows, description);
        const setup = trace.find(row => row[0] === -101);
        if (setup) {
            const select = tag => trace.filter(row => row[0] === tag).map(row => row.slice(1).map(Number));
            nativeCases.push({ description, levelTime: setup[1], crush: Number(setup[2]), actors: select(-102), result: select(-103) });
        }
    }
    console.log(`Verified ${expected.length} compiled Doom sector-change scenarios.`);
    if (values.upstream) {
        assert.equal(nativeCases.length, 9);
        const { compareNativeSectorChange } = await import("./doom-native-sector-change-oracle.mjs");
        compareNativeSectorChange(path.resolve(root, values.upstream), scratch, nativeCases);
        console.log(`Matched ${nativeCases.length} scenarios against the extracted Linux Doom sector-change functions.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-sector-change-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
