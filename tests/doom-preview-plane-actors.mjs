// A floor thinker steps past two hanging bodies after their original thinkers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-plane-actors-"));
const unit = 65536;

function words(...values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => bytes.writeUInt16LE(value & 0xffff, 2 * index));
    return bytes;
}

function room() {
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0]];
    const lumps = [
        ["Vertices", 4, words(-256, -128, -256, 128, 256, 128, 256, -128)],
        ["Lines", 4, Buffer.concat(edges.map(([a, b]) => words(a, b, 1, 0, 0, 0, -1)))],
        ["Sides", 1, Buffer.alloc(30)],
        ["Segs", 4, Buffer.concat(edges.map(([a, b], i) => words(a, b, [0x4000, 0, 0xc000, 0x8000][i], i, 0, 0)))],
        ["Subsectors", 1, words(4, 0)],
        ["Nodes", 0, Buffer.alloc(0)],
        ["Sectors", 1, Buffer.concat([words(27, 128), Buffer.alloc(16), words(160, 0, 0)])],
        ["Reject", 1, Buffer.alloc(1)],
        ["BlockMap", 34, words(-256, -128, 4, 2, ...Array(8).fill(12), 0, 1, 2, 3, -1)],
        ["Things", 3, words(-128, 0, 0, 1, 7, 0, 0, 0, 49, 7, 96, 0, 0, 52, 7)],
    ];
    writeFileSync(path.join(scratch, "ROOM.BIN"), Buffer.concat(lumps.map(([, , data]) => data)));
    let offset = 0;
    return lumps.map(([name, count, data]) => {
        const field = `${name}: wad.Lump{Valid: true, Offset: ${offset}, Count: ${count}}`;
        offset += data.length;
        return field;
    }).join(",\n            ");
}

try {
    const modules = ["combat-preview", "monster-preview", "action-preview", "player-preview", "teleport-preview", "sound-cues"];
    for (const name of modules) copyFileSync(path.join(port, "wad-bsp", name + ".flt"), path.join(scratch, name + ".flt"));
    const entry = path.join(scratch, "main.flt");
    writeFileSync(entry, `package main
import "play"
import "wad"

const Room = readFile("ROOM.BIN")

map "Doom hanging bodies and floor thinkers" {
    register saved PreviewCombat = PreviewCombat{}
    register passive play.PassiveActors = play.PassiveActors{}
    tick {
        if currentTick() == 0 {
            base := wad.BspLevel{Valid: true, File: Room, ${room()}}
            var health [wad.VanillaPlayers]int
            health[0] = 100
            actors := play.SpawnMapActors(base, wad.ThingRules{Skill: 2}, health, play.RandomState{})
            animated, still := actors.ActorAt(1), actors.ActorAt(2)
            // Both kept their original Z when the ceiling opened from 96 to 128.
            animated.Physics.Body.Z = (96 << 16) - animated.Physics.Body.Height
            still.Physics.Body.Z = (96 << 16) - still.Physics.Body.Height
            animated.Tics = 2
            actors = actors.WithActor(2, animated).WithActor(3, still)
            var scene PreviewCombat
            scene.Base, scene.Level, scene.Rules = base, base, play.CombatRules{Skill: 2}
            scene.World = play.CombatWorld{Actors: actors, Links: play.BuildActorLinks(actors, wad.LoadBlockMap(base))}
            scene.World.Players[0] = play.NewPlayerInventory(100)
            scene.MapActors, scene.FirstActive = actors.Count, initialPreviewThinker(actors)
            scene.Specials.Floors = play.LevelFloors{}.Append(play.SectorFloor{Sector: 0, Order: 1,
                Motion: play.FloorState{Active: true, Height: 27 << 16, Speed: 4 << 16, Destination: 33 << 16,
                    Direction: 1, Mode: play.FloorRaiseTurbo}})
            next passive = play.SelectPassiveActors(actors)
            next saved = scene
        } else if currentTick() <= 3 {
            time := currentTick() - 1
            blocks := wad.LoadBlockMap(saved.Base)
            scene := tickPreviewMapActors(PreviewMapActorStep{Combat: saved}, blocks, time, passive, 1, saved.MapActors + 1).Combat
            scene = tickPreviewDynamicThinkers(scene, blocks, time).Combat
            animated, still := scene.World.Actors.ActorAt(1), scene.World.Actors.ActorAt(2)
            log(scene.Failed, time, scene.Level.SectorHeightsAt(0).Floor,
                animated.Physics.Body.Z, animated.Physics.Body.Floor, animated.State, animated.Tics,
                still.Physics.Body.Z, still.Physics.Body.Floor, still.State, still.Tics, scene.World.Random.GameplayIndex)
            next saved = scene
        }
    }
}`);
    const output = path.join(scratch, "plane-actors.json");
    const args = [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output];
    const built = spawnSync("dotnet", args, { cwd: root, encoding: "utf8", timeout: 60_000 });
    if (built.error) throw built.error;
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let host = 0; host < 20 && sim.logs.length < 3; host++) sim.step();
    assert.equal(sim.logs.length, 3);
    const trace = Array.from(sim.logs, ([failed, ...row]) => {
        assert.equal(failed, false, "the floor and actors completed their thinker slot");
        return Array.from(row);
    });
    if (values.upstream) {
        const { runNativePlaneActorOracle } = await import("./doom-native-plane-actor-oracle.mjs");
        assert.deepEqual(trace, runNativePlaneActorOracle(path.resolve(root, values.upstream), scratch), "pinned floor and actor thinker trace");
    }
    assert.deepEqual(trace, [
        [0, 31 * unit, 28 * unit, 31 * unit, 888, 1, 28 * unit, 31 * unit, 904, -1, 0],
        [1, 33 * unit, 33 * unit, 33 * unit, 889, 15, 33 * unit, 33 * unit, 904, -1, 0],
        [2, 33 * unit, 33 * unit, 33 * unit, 889, 14, 33 * unit, 33 * unit, 904, -1, 0],
    ], "both hanging actors correct their position before the floor's second turn");
    console.log("Preview plane actors passed floor carry, normal animation timing, and original thinker order.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-plane-actors-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
