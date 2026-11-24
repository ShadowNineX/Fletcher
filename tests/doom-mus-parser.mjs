// Synthetic MUS fixtures exercised through the compiled Fletcher parser.
// These are byte-level descriptors, not Doom music or WAD assets.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "src", "Fletcher.Cli", "bin", "Debug", "net11.0", "fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-mus-"));

function mus(score, { scoreOffset = 18, instruments = 1, magic = "MUS\x1a", declaredLength = score.length } = {}) {
    const header = Buffer.alloc(scoreOffset);
    header.write(magic, 0, "latin1");
    header.writeUInt16LE(declaredLength, 4); header.writeUInt16LE(scoreOffset, 6);
    header.writeUInt16LE(1, 8); header.writeUInt16LE(0, 10); header.writeUInt16LE(instruments, 12);
    return Buffer.concat([header, Buffer.from(score)]);
}

function source() {
    return `package mus_test
import "audio"
import "wad"
const Data = readFile("MUSIC.bin")
map "MUS parser" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register done bit = false
    tick {
        if !done {
            cursor := audio.OpenMus(wad.LumpRef{File: Data, Size: len(Data), Valid: true})
            first := audio.ReadMusEvent(cursor)
            second := audio.ReadMusEvent(first.Cursor)
            third := audio.ReadMusEvent(second.Cursor)
            end := audio.ReadMusEvent(third.Cursor)
            log("open", cursor.Valid)
            log("events", first.Valid, first.Kind, first.Channel, first.Data1, first.Data2, first.Delay,
                second.Valid, second.Kind, second.Channel, second.Data1, second.Data2, second.Delay,
                third.Valid, third.Kind, third.Data1, third.Data2, third.Delay, end.Valid, end.Kind, end.Delay)
            next done = true
        }
    }
}`;
}

function compile(data, name) {
    const folder = path.join(scratch, name), output = path.join(folder, "map.json");
    mkdirSync(folder); writeFileSync(path.join(folder, "main.flt"), source()); writeFileSync(path.join(folder, "MUSIC.bin"), data);
    const built = spawnSync("dotnet", [cli, "build", path.join(folder, "main.flt"), "--package-root", port,
        "--asset-root", folder, "-o", output], { cwd: root, encoding: "utf8", timeout: 30000 });
    assert.equal(built.status, 0, built.stderr || built.stdout);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
}

function logs(sim, label) { return sim.logs.filter(row => row[0] === label); }
function run(data, name) {
    const sim = compile(data, name);
    for (let i = 0; i < 8 && logs(sim, "events").length === 0; i++) sim.step();
    return sim;
}

try {
    // note-on (new velocity) + 130-tick VLQ, controller, release + zero delay, end.
    const valid = run(mus([0x90, 0xbc, 100, 0x81, 0x02, 0x4f, 3, 42, 0x80, 0xc1, 0, 0x60]), "valid");
    assert.deepEqual(logs(valid, "open")[0], ["open", true]);
    assert.deepEqual(logs(valid, "events")[0], ["events",
        true, 1, 0, 60, 100, 130, true, 4, 15, 3, 42, 0,
        true, 0, 65, -1, 0, true, 6, 0]);

    const inheritedVelocity = run(mus([0x11, 64, 0x60]), "inherited-velocity");
    assert.deepEqual(logs(inheritedVelocity, "events")[0].slice(0, 7), ["events", true, 1, 1, 64, -1, 0]);

    // An event requiring a velocity byte and a delay continuation must reject
    // truncation, while malformed headers must never produce a cursor.
    const truncated = run(mus([0x90, 60]), "truncated");
    assert.deepEqual(logs(truncated, "events")[0].slice(0, 7), ["events", false, 0, 0, 0, -1, 0]);
    const badHeader = run(mus([0x60], { instruments: 2, scoreOffset: 18 }), "bad-header");
    assert.deepEqual(logs(badHeader, "open")[0], ["open", false]);
    assert.deepEqual(logs(badHeader, "events")[0].slice(0, 2), ["events", false]);
    const unterminatedDelay = run(mus([0x80, 60, 0x80]), "unterminated-delay");
    assert.deepEqual(logs(unterminatedDelay, "events")[0].slice(0, 2), ["events", false]);
    console.log("Doom MUS parser decoded grouped events, VLQ timing, inherited velocity, and bounded malformed streams.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-mus-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
