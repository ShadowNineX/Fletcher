// Verify that level-mover sounds reach the native Music Arrow mechanism lane
// through the compiled playable preview. The WAD is generated test geometry.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "src", "Fletcher.Cli", "bin", "Debug", "net11.0", "fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-mover-audio-"));
const mechanism = { x: -17, y: 63 };

function words(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => bytes.writeUInt16LE(value & 65535, index * 2));
    return bytes;
}

function wad(lumps) {
    const directory = 12 + lumps.reduce((size, [, bytes]) => size + bytes.length, 0);
    const result = Buffer.alloc(directory + lumps.length * 16);
    result.write("PWAD"); result.writeUInt32LE(lumps.length, 4); result.writeUInt32LE(directory, 8);
    let offset = 12;
    for (const [index, [name, bytes]] of lumps.entries()) {
        const entry = directory + index * 16;
        result.writeUInt32LE(offset, entry); result.writeUInt32LE(bytes.length, entry + 4); result.write(name, entry + 8);
        bytes.copy(result, offset); offset += bytes.length;
    }
    return result;
}

// Sector special 10 is Doom's close-in-30-seconds timed door. The copied
// preview below shortens only its fixture countdown, retaining the production
// map-load and mover paths.
function level(marker, distance) {
    const box = [-64, -64, 64, -64, 64, 64, -64, 64];
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0]];
    const vertices = words([...box, ...box.map((value, index) => index % 2 ? value : value + (distance ?? 0))]);
    const lines = words((distance === null ? [0] : [0, 4]).flatMap(offset => edges.flatMap(([first, last], index) =>
        [first + offset, last + offset, 0, 0, 0, index + offset, 65535])));
    const sides = Buffer.alloc(8 * 30);
    for (let index = 4; index < 8; index++) sides.writeInt16LE(1, index * 30 + 28);
    const sectors = Buffer.alloc(52);
    for (const offset of [0, 26]) {
        sectors.writeInt16LE(128, offset + 2); sectors.write("FLOOR0_1", offset + 4); sectors.write("CEIL1_1", offset + 12);
        sectors.writeInt16LE(160, offset + 20);
    }
    sectors.writeInt16LE(10, 26 + 22);
    return [[marker, Buffer.alloc(0)], ["THINGS", words([0, 0, 0, 1, 7])], ["LINEDEFS", lines], ["SIDEDEFS", sides],
        ["VERTEXES", vertices], ["SEGS", words(edges.flatMap(([first, last], index) => [first, last, 0, index, 0, 0]))],
        ["SSECTORS", words([4, 0])], ["NODES", Buffer.alloc(0)], ["SECTORS", sectors], ["REJECT", Buffer.alloc(1)],
        ["BLOCKMAP", words([-64, -64, 1, 1, 5, 0, 1, 2, 3, -1])]];
}

function previewSource() {
    const preview = path.join(scratch, "preview");
    mkdirSync(preview);
    for (const name of readdirSync(path.join(port, "wad-bsp")).filter(name => name.endsWith(".flt"))) {
        let source = readFileSync(path.join(port, "wad-bsp", name), "utf8");
        if (name === "main.flt") {
            const anchor = "                                    next doors = play.LoadTimedDoors(level)";
            assert.ok(source.includes(anchor), "timed-door load hook moved");
            source = source.replace(anchor, `                                    timedDoors := play.LoadTimedDoors(level)
                                    if timedDoors.Count > 0 {
                                        handle := timedDoors.First()
                                        door := timedDoors.EntryAt(handle).State
                                        door.Countdown = 20
                                        timedDoors = timedDoors.WithState(handle, door)
                                    }
                                    next doors = timedDoors`);
            const cue = "gameplayCues = gameplayCues | previewMoverCues(level, moved, soundBounds, stepped.Sounds)";
            assert.equal(source.split(cue).length, 2, "unique mover-cue hook");
            source = source.replace(cue, `for index := range stepped.Sounds.Count {
                            sound := stepped.Sounds.At(index)
                            log("mover-sound", sound.Id, sound.Sector)
                        }
                        ${cue}`);
        }
        writeFileSync(path.join(preview, name), source);
    }
    return path.join(preview, "main.flt");
}

function build(entry, marker, distance) {
    writeFileSync(path.join(scratch, "LEVEL.WAD"), wad(level(marker, distance)));
    const output = path.join(scratch, "mover-audio.json");
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
}

function stepUntilLogged(sim, keys, message) {
    for (let host = 0; host < 150; host++) {
        if (sim.logs.some(row => row[0] === message)) return;
        sim.step([], new Map(), keys);
    }
    assert.fail(`${message}: ${JSON.stringify(sim.logs.slice(-10))}`);
}

function mechanismEdges(sim) {
    const edges = [];
    let previous = sim.value(mechanism) ?? 0;
    for (let host = 0; host < 100; host++) {
        sim.step();
        const current = sim.value(mechanism) ?? 0;
        if (previous <= 0 && current > 0) edges.push(host);
        previous = current;
    }
    return edges;
}

try {
    const entry = previewSource();
    const sim = build(entry, "E1M1", 1130);
    const music = sim.tileAt(mechanism), source = sim.tileAt({ x: mechanism.x, y: mechanism.y - 1 });
    assert.equal(music?.type, 29, "mechanism cue lane ends in a native Music Arrow");
    assert.equal(source?.type, 16, "the mechanism cue is driven by a native AND gate");

    stepUntilLogged(sim, [], "Classic WAD BSP frame rendered");
    stepUntilLogged(sim, [25], "Doom checkpoint saved");
    const edges = mechanismEdges(sim);
    assert.ok(edges.length > 0 && edges[0] > 3, "the pending door timer fires on its own after the save");
    stepUntilLogged(sim, [12], "Doom checkpoint loaded");
    assert.deepEqual(mechanismEdges(sim), edges, "the restored door repeats its cue at the same time without an extra pulse");

    for (const [marker, distance, audible] of [["E1M1", 1131, false], ["E1M8", 1600, true], ["E1M1", null, true]]) {
        const scenario = build(entry, marker, distance);
        stepUntilLogged(scenario, [], "Classic WAD BSP frame rendered");
        const scenarioEdges = mechanismEdges(scenario);
        assert.ok(scenario.logs.some(([tag, id, sector]) => tag === "mover-sound" && id === 21 && sector === 1),
            `${marker} thinker emitted the door-close event from sector one`);
        const origin = distance === null ? "in a sector without linedefs" : `at ${distance} units`;
        assert.equal(scenarioEdges.length > 0, audible, `${marker} timed door ${origin}`);
    }
    console.log("Timed doors matched Doom's 1130/1131-unit boundary, map-eight exception, and empty-sector origin. Checkpoint replay retained cue timing.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-mover-audio-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
