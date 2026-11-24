import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(path.join(artifacts, "doom-map-things-"));

function build(entry) {
    const output = path.join(scratch, "output.json");
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output], { encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
}

function things(records) {
    const out = Buffer.alloc(records.length * 10);
    records.forEach(([x, y, angle, type, options], index) => {
        const at = index * 10; out.writeInt16LE(x, at); out.writeInt16LE(y, at + 2); out.writeInt16LE(angle, at + 4); out.writeInt16LE(type, at + 6); out.writeInt16LE(options, at + 8);
    });
    return out;
}

try {
    writeFileSync(path.join(scratch, "THINGS.BIN"), things([
        [-12, 34, -90, 1, 16], [10, 20, 0, 11, 7], [30, 40, 0, 4, 7],
        [1, 2, 0, 300, 1], [3, 4, 0, 300, 17], [5, 6, 0, 300, 2],
        [7, 8, 0, 68, 1], [50, 60, 0, 1, 7],
    ]));
    const entry = path.join(scratch, "main.flt");
    writeFileSync(entry, `package main
import "wad"
const Source = readFile("THINGS.BIN")
map "Doom map things" {
    tick {
        level := wad.BspLevel{File: Source, Things: wad.Lump{Offset: 0, Count: 8, Valid: true}}
        single := wad.ThingRules{Skill: 0}
        commercial := single; commercial.Commercial = true
        normal := single; normal.Skill = 2
        first := level.ThingAt(0)
        spawn := wad.SpawnThing(level.ThingAt(3), single, wad.ThingActorClass{Known: true})
        netOnly := wad.SpawnThing(level.ThingAt(4), single, wad.ThingActorClass{Known: true})
        normalSpawn := wad.SpawnThing(level.ThingAt(5), normal, wad.ThingActorClass{Known: true})
        noMonster := normal; noMonster.NoMonsters = true
        blockedMonster := wad.SpawnThing(level.ThingAt(5), noMonster, wad.ThingActorClass{Known: true, CountKill: true})
        unknown := wad.SpawnThing(level.ThingAt(5), normal, wad.ThingActorClass{})
        log(first.Valid, first.X, first.Y, first.Angle, first.Type, first.Options)
        log(spawn.SpawnActor, netOnly.SpawnActor, normalSpawn.SpawnActor, blockedMonster.SpawnActor, unknown.UnknownActor)
        for i := range 3 {
            start := wad.SpawnThing(level.ThingAt(i), single, wad.ThingActorClass{})
            log(start.Valid, start.SpawnPlayer, start.SpawnActor, start.UnknownActor, start.StopLoad)
        }
        extra := level.ThingAt(6)
        log(wad.SpawnThing(extra, single, wad.ThingActorClass{}).StopLoad,
            wad.SpawnThing(extra, commercial, wad.ThingActorClass{Known: true}).SpawnActor, level.ThingAt(99).Valid)
    }
}
`);
    const sim = build(entry); sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [true, -12, 34, -90, 1, 16], [true, false, true, false, true],
        [true, true, false, false, false], [true, false, false, false, false], [true, false, false, false, false],
        [true, true, false],
    ]);
    console.log("Doom THINGS decoding, ordered commercial break, starts, and spawn filters passed.");
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
