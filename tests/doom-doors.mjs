import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(path.join(artifacts, "doom-doors-"));

// Traces of the exact T_VerticalDoor and T_MovePlane routines, with a
// P_ChangeSector shim for standing-player clearance.
const variants = [
    ["normal", 1, 300, 301, 56, "9c2e583345f421a3bdac6677356f07e92efc8cefed87f4c5a61920cd1b7ac1a3"],
    ["blocked", 1, 300, 150, 56, "0e5254eab8adecd19029cf1df9a953bde83d05db6359465f2af4938d39e13e2c"],
    ["fast-raise", 117, 190, 301, 56, "1cea688799bd6868183bcb88511d2405d0dd5af9ab08f11803ac7f0b4c302b58"],
    ["open", 31, 68, 301, 56, "f6ad7e28caf35d421e4e65b4a220b2a14ac82b38c445bfd1d3bd3ae2335a04ff"],
    ["fast-open", 118, 19, 301, 56, "7f700c041965165ba3623b4d94acab0242e6ed2b5b0f595ce07347e26c59366e"],
    ["terminal-rollback", 0, 2, 1, 1, "6aa76b9a312559b5cc179b5cf8f8ec7d49ee9fab7764e977a3e4ee4a0b2b02c4"],
];

const timed = [
    ["close10", 1084, "play.SpawnTimedDoor(10, 64 * Unit, 0, 128 * Unit)",
        "eb0b1749391661d994b8b53f4da0aebcde46791c78b4f9a5e71fb5c47e5389d3"],
    ["raise14", 10780, "play.SpawnTimedDoor(14, 0, 0, 128 * Unit)",
        "ab7f8227442fd18c0e7df607dd20a1b325c05f491da8af0257da856c95ac6b68"],
    ["close30", 1134, "play.OpenTaggedDoor(play.DoorClose30ThenOpen, 80 * Unit, 0, 128 * Unit)",
        "ce927c9e232c3e7f9e38a0cfcd5e77b81cfc4fd5d1d9bb4775c8fb2ad341195b"],
];

const source = path.join(scratch, "main.flt");
const output = path.join(scratch, "output.json");

function simulate(count) {
    const build = spawnSync("dotnet", [cli, "build", source, "--package-root", path.join(root, "examples", "doom-engine"),
        "--asset-root", scratch, "-o", output], { encoding: "utf8", cwd: root, timeout: 15_000 });
    assert.equal(build.status, 0, build.error?.message ?? build.stderr);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
    for (let tic = 0; tic <= count; tic++) sim.step();
    return sim.logs;
}

function nativeTrace(oracle, variant) {
    const native = spawnSync(path.resolve(oracle), [variant], { encoding: "utf8", timeout: 5000 });
    assert.equal(native.status, 0, native.error?.message ?? native.stderr);
    return native.stdout.replaceAll("\r", "").trim();
}

try {
    for (const [name, special, count, blockAfter, height, digest] of variants) {
        const initial = special === 0 ? "play.DoorState{Active: true, Ceiling: Unit, Speed: play.DoorSpeed, Direction: -1, Mode: play.DoorClose}"
            : `play.OpenManualDoor(${special}, 0, 0, 128 * Unit)`;
        writeFileSync(source, `package main
import "engine"
import "play"
const Unit = engine.FracUnit

map "Doom door traces" {
    register door play.DoorState = play.DoorState{}
    tick {
        tic := currentTick()
        moved := door
        if tic == 0 {
            moved = ${initial}
        } else {
            trial := play.TickDoor(door, false)
            blocked := tic >= ${blockAfter} && trial.Ceiling - trial.Floor < ${height} * Unit
            moved = play.TickDoor(door, blocked)
        }
        active := 0
        if moved.Active { active = 1 }
        next door = moved
        log(tic, moved.Ceiling, moved.Direction, moved.Countdown, active)
    }
}
`);
        const trace = simulate(count).map(row => row.join(" ")).join("\n");
        assert.equal(createHash("sha256").update(trace).digest("hex"), digest, `pinned door trace for ${name}`);
        if (process.argv[3]) assert.equal(trace, nativeTrace(process.argv[3], name));
    }
    console.log("Doom vertical door thinkers matched 885 native samples across six traces.");

    for (const [name, count, initial, digest] of timed) {
        writeFileSync(source, `package main
import "engine"
import "play"
const Unit = engine.FracUnit

map "Doom timed door traces" {
    register door play.DoorState = play.DoorState{}
    tick {
        tic := currentTick()
        var moved play.DoorState
        if tic == 0 { moved = ${initial} } else { moved = play.TickDoor(door, false) }
        active := 0
        if moved.Active { active = 1 }
        next door = moved
        log(tic, moved.Ceiling, moved.Direction, moved.Countdown, active, moved.Mode)
    }
}
`);
        const trace = simulate(count).map(row => row.join(" ")).join("\n");
        assert.equal(createHash("sha256").update(trace).digest("hex"), digest, `pinned timed door trace for ${name}`);
        if (process.argv[4]) assert.equal(trace, nativeTrace(process.argv[4], name).split("\n").slice(1).join("\n"));
    }
    console.log("Doom timed doors and close-then-open matched 13,001 native ticks.");

    const sectors = Buffer.alloc(4 * 26);
    for (const [i, tag] of [7, 7, 0, 7].entries()) sectors.writeInt16LE(tag, i * 26 + 24);
    sectors.writeInt16LE(128, 26 + 2);
    sectors.writeInt16LE(10, 26 + 22);
    const lines = Buffer.alloc(4 * 14);
    for (const [i, tag] of [7, 7, 0, 99].entries()) {
        const at = i * 14;
        lines.writeUInt16LE(1, at + 2);
        lines.writeUInt16LE(4, at + 4);
        lines.writeUInt16LE(i < 2 ? 86 : 2, at + 6);
        lines.writeInt16LE(tag, at + 8);
        lines.writeUInt16LE([1, 3, 2, 1][i], at + 12);
    }
    const sides = Buffer.alloc(4 * 30);
    for (const [i, sector] of [1, 0, 2, 3].entries()) sides.writeUInt16LE(sector, i * 30 + 28);
    const vertices = Buffer.alloc(8);
    vertices.writeInt16LE(32, 4);
    writeFileSync(path.join(scratch, "level.bin"), Buffer.concat([sectors, lines, sides, vertices]));
    writeFileSync(source, `package main
import "play"
import "wad"
const Records = readFile("level.bin")

map "Doom door tags" {
    register doors play.LevelDoors = play.LevelDoors{}
    tick {
        level := wad.BspLevel{Valid: true, File: Records, Sectors: wad.Lump{Valid: true, Count: 4},
            Lines: wad.Lump{Valid: true, Count: 4, Offset: ${sectors.length}},
            Sides: wad.Lump{Valid: true, Count: 4, Offset: ${sectors.length + lines.length}},
            Vertices: wad.Lump{Valid: true, Count: 2, Offset: ${sectors.length + lines.length + sides.length}}}
        tic := currentTick()
        frame := doors
        if tic == 0 {
            untouched := play.CrossLevelDoor(level, play.LevelDoors{}, 3)
            log(untouched.Count, untouched.UsedCount, untouched.ApplyTo(level).LineAt(3).Action)
            frame = play.LoadTimedDoors(level)
            log(frame.Count, frame.ApplyTo(level).SectorSpecial(1))
        }
        index := frame.Count
        view := frame.ApplyTo(level)
        tag := view.LineAt(tic).Tag
        frame = play.CrossLevelDoor(view, frame, tic)
        applied := 0
        if frame.Count > index { applied = 1 }
        first := frame.First()
        second := frame.Following(first)
        third := frame.Following(second)
        fourth := frame.Following(third)
        if frame.Count == 3 {
            log(tag, applied, frame.Count, frame.EntryAt(first).Sector, frame.EntryAt(second).Sector, frame.EntryAt(third).Sector)
        } else {
            log(tag, applied, frame.Count, frame.EntryAt(first).Sector, frame.EntryAt(second).Sector, frame.EntryAt(third).Sector, frame.EntryAt(fourth).Sector)
        }
        next doors = frame
        if tic == 3 {
            appliedLevel := frame.ApplyTo(level)
            log(appliedLevel.LineAt(0).Action, appliedLevel.LineAt(2).Action, appliedLevel.LineAt(3).Action,
                frame.EntryAt(second).State.Top >> 16, frame.EntryAt(fourth).State.Top >> 16)
        }
    }
}
`);
    const rows = JSON.parse(JSON.stringify(simulate(3)));
    assert.deepEqual(rows.slice(0, 2), [[0, 1, 0], [1, 0]]);
    const tags = ["7 1 3 1 0 3", "7 0 3 1 0 3", "0 1 4 1 0 3 2", "99 0 4 1 0 3 2"].join("\n");
    assert.equal(rows.slice(2, 6).map(row => row.join(" ")).join("\n"), tags);
    assert.deepEqual(rows[6], [86, 0, 0, 124, 124]);
    if (process.argv[4]) assert.equal(tags, nativeTrace(process.argv[4], "tags"));
    console.log("Doom tagged doors matched native sector order, occupied sectors, zero tags, and missing tags.");
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
