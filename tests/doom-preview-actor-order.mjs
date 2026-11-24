import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-actor-order-"));

function words(...values) {
    const result = Buffer.alloc(values.length * 2);
    values.forEach((value, i) => result.writeUInt16LE(value & 0xffff, i * 2));
    return result;
}

function geometry() {
    // Both THINGS directories use the same rectangular room and BLOCKMAP.
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0]];
    const things = x => words(x, 0, 0, 2035, 7);
    const lumps = [
        ["Vertices", 4, words(-256, -128, -256, 128, 256, 128, 256, -128)],
        ["Lines", 4, Buffer.concat(edges.map(([a, b]) => words(a, b, 1, 0, 0, 0, -1)))],
        ["Sides", 1, Buffer.alloc(30)],
        ["Segs", 4, Buffer.concat(edges.map(([a, b], i) => words(a, b, [16384, 0, 49152, 32768][i], i, 0, 0)))],
        ["Subsectors", 1, words(4, 0)],
        ["Nodes", 0, Buffer.alloc(0)],
        ["Sectors", 1, Buffer.concat([words(0, 1024), Buffer.alloc(16), words(160, 0, 0)])],
        ["Reject", 1, Buffer.alloc(1)],
        ["BlockMap", 34, words(-256, -128, 4, 2, ...Array(8).fill(12), 0, 1, 2, 3, -1)],
        ["Things", 2, Buffer.concat([things(137), things(0)])],
    ];
    let offset = 0;
    const fields = lumps.map(([name, count, data]) => {
        const field = `${name}: wad.Lump{Valid: true, Offset: ${offset}, Count: ${count}}`;
        offset += data.length;
        return field;
    });
    const reverse = Buffer.concat([things(0), things(137)]);
    writeFileSync(path.join(scratch, "ROOM.BIN"), Buffer.concat([...lumps.map(([, , data]) => data), reverse]));
    return fields.join(",\n");
}

try {
    // Compile the same combat dispatch used by the live preview, with a small
    // map entry so rendering and host frame timing cannot affect the result.
    for (const file of ["combat-preview", "monster-preview", "action-preview", "player-preview", "teleport-preview", "sound-cues"]) {
        copyFileSync(path.join(port, "wad-bsp", file + ".flt"), path.join(scratch, file + ".flt"));
    }
    const entry = path.join(scratch, "main.flt");
    writeFileSync(entry, `package main
import "actorinfo"
import "play"
import "wad"
const Room = readFile("ROOM.BIN")

map "Doom actor thinker order" {
    tick {
        level := wad.BspLevel{File: Room, Valid: true, ${geometry()}}
        blocks := wad.LoadBlockMap(level)
        switch currentTick() {
        case 0, 1:
            origin, victim := 2, 1
            if currentTick() == 1 {
                level.Things.Offset = level.Things.Offset + 2 * wad.ThingSize
                origin, victim = 1, 2
            }
            rules := play.CombatRules{Skill: 2}
            var health [wad.VanillaPlayers]int
            actors := play.SpawnMapActors(level, wad.ThingRules{Skill: 2}, health,
                play.RandomState{GameplayIndex: 50, MenuIndex: 11})
            passive := play.SelectPassiveActors(actors)
            barrel := actorinfo.KindAt(actorinfo.ActorBarrel)
            live := actors.ActorAt(victim - 1)
            live.Tics = 2
            dying := actors.ActorAt(origin - 1)
            dying = play.SetMobjState(dying, barrel.DeathState + 2).Actor
            dying.Tics, dying.Damaged, dying.Health = 1, true, 0
            dying.Physics.Body.Flags = dying.Physics.Body.Flags & ~bits<32>(play.ActorShootable)
            actors = actors.WithActor(origin, dying).WithActor(victim, live)
            links := play.BuildActorLinks(actors, blocks)
            scene := PreviewCombat{Base: level, Level: level, Rules: rules, FirstActive: origin, MapActors: actors.Count,
                World: play.CombatWorld{Actors: actors, Links: links, Random: actors.Random}}
            result := tickPreviewMapActors(PreviewMapActorStep{Combat: scene}, blocks, 0, passive, 1, actors.Count + 1)
            combat := result.Combat
            live, dying = combat.World.Actors.ActorAt(victim - 1), combat.World.Actors.ActorAt(origin - 1)
            log(blocks.Valid, actors.Failed, actors.Count, passive.Count, actors.Random.GameplayIndex, combat.Failed,
                dying.State - barrel.DeathState, dying.Tics, live.Damaged, live.Health, live.State - barrel.SpawnState, live.Tics,
                live.Physics.Body.X - (137 << 16), live.Physics.Body.Y, live.Physics.MomentumX, live.Physics.MomentumY,
                combat.World.Random.GameplayIndex, combat.World.Random.MenuIndex)
        case 2:
            // The last puff state expires on its own turn and stays queued as a tombstone.
            puff := play.LevelActor{Valid: true, Kind: actorinfo.ActorPuff, State: actorinfo.StatePuff3 + 1, Tics: 1}
            var scene PreviewCombat
            scene.Level, scene.Base, scene.Rules = level, level, play.CombatRules{Skill: 2}
            scene.World.Actors = scene.World.Actors.AppendTransient(puff)
            scene.World.Links = play.BuildActorLinks(scene.World.Actors, blocks)
            scene = tickPreviewDynamicThinkers(scene, blocks, 0).Combat
            expired := scene.World.Actors.ActorAt(0)
            log("marked", scene.Failed, expired.Valid, expired.Transient, scene.World.Actors.TransientFirst(),
                scene.World.Actors.NextTransientHandle())

            // On the next pass slot 1 is reclaimed before slot 2's callback. Its
            // spawned rocket reuses slot 1 and still runs after its parent this tic.
            parent := play.LevelActor{Valid: true, Kind: actorinfo.ActorRocket,
                State: actorinfo.StateBrainExplode1 + 1, Tics: 1}
            scene.World.Actors = scene.World.Actors.AppendTransient(parent)
            log("queued", scene.World.Actors.TransientFirst(), scene.World.Actors.TransientNext(1))
            scene = tickPreviewDynamicThinkers(scene, blocks, 1).Combat
            parent = scene.World.Actors.ActorAt(1)
            child := scene.World.Actors.ActorAt(0)
            log("appended", scene.Failed, scene.World.Actors.Count, scene.World.Actors.TransientFirst(),
                scene.World.Actors.TransientNext(2), scene.World.Actors.TransientNext(1),
                parent.State - actorinfo.StateBrainExplode1, parent.Tics, child.Valid, child.Kind == actorinfo.ActorRocket,
                child.State - actorinfo.StateBrainExplode1, child.Tics, child.Physics.Body.X, child.Physics.Body.Z,
                child.Physics.MomentumZ, scene.World.Random.GameplayIndex)
        }
    }
}`);
    const output = path.join(scratch, "order.json");
    const build = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
    if (build.error) throw build.error;
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    sim.step();
    sim.step();
    sim.step();
    // A_Explode deals 128 - (137 - 10) = 1, applies 1/8-unit thrust and
    // consumes one pain roll. Each barrel's state timer advances exactly once.
    const common = [true, false, 2, 2, 54, false, 3, 10, true, 19, 0, 1];
    const rows = Array.from(sim.logs, row => Array.from(row));
    assert.equal(rows.length, 5);
    assert.deepEqual(rows[0], [...common, 0, 0, 8191, 3, 55, 11], "victim ticks before the blast");
    assert.deepEqual(rows[1], [...common, 8191, 3, 7423, 2, 55, 11], "victim moves and receives friction after the blast");
    assert.deepEqual(rows[2], ["marked", false, false, true, 1, 2], "a self-removed thinker remains linked until the next pass");
    assert.deepEqual(rows[3], ["queued", 1, 2], "the next spawn cannot reuse the pending removal");
    const childMomentum = 241 * 512;
    assert.deepEqual(rows[4], ["appended", false, 2, 2, 1, 0, 2, 10, true, true, 0, 4,
        (8 - 109) * 2048, 128 + 220 * 2 * 65536 + childMomentum, childMomentum, 6],
        "the callback appends and ticks the reclaimed lower slot in the same pass");
    console.log("Preview actor order passed barrel damage, thrust and RNG, deferred transient removal, and same-tic append into a reused slot.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-actor-order-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
