// Exercise MUS scheduling at Doom's 35 Hz game-tic cadence.  The generated
// PWAD contains only synthetic music streams, never proprietary game data.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "src", "Fletcher.Cli", "bin", "Debug", "net11.0", "fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-mus-sequencer-"));

function mus(score) {
    const data = Buffer.alloc(16 + score.length);
    data.write("MUS\x1a"); data.writeUInt16LE(score.length, 4); data.writeUInt16LE(16, 6);
    score.copy(data, 16);
    return data;
}

function wad(lumps) {
    const directory = 12 + lumps.reduce((size, [, bytes]) => size + bytes.length, 0);
    const data = Buffer.alloc(directory + lumps.length * 16);
    data.write("PWAD"); data.writeUInt32LE(lumps.length, 4); data.writeUInt32LE(directory, 8);
    let offset = 12;
    for (const [index, [name, bytes]] of lumps.entries()) {
        const entry = directory + index * 16;
        data.writeUInt32LE(offset, entry); data.writeUInt32LE(bytes.length, entry + 4); data.write(name, entry + 8);
        bytes.copy(data, offset); offset += bytes.length;
    }
    return data;
}

function build() {
    const entry = path.join(scratch, "main.flt"), output = path.join(scratch, "map.json");
    writeFileSync(entry, `package main
import "audio"
import "wad"
const Archive = readFile("MUSIC.WAD")
func source(mounts wad.Archives, low int) wad.LumpRef { return mounts.Find(wad.LumpName{Low: low}) }
map "MUS sequencer" {
    register started bit = false
    register timed audio.MusPlayer = audio.MusPlayer{}
    register looped audio.MusPlayer = audio.MusPlayer{}
    register percussion audio.MusPlayer = audio.MusPlayer{}
    register burst audio.MusPlayer = audio.MusPlayer{}
    register damaged audio.MusPlayer = audio.MusPlayer{}
    tick {
        if !started {
            mounts := wad.OpenArchive(Archive)
            next started = true
            next timed = audio.LoadMusPlayer(source(mounts, 0x454d4954), false)
            next looped = audio.LoadMusPlayer(source(mounts, 0x504f4f4c), true)
            next percussion = audio.LoadMusPlayer(source(mounts, 0x43524550), false)
            next burst = audio.LoadMusPlayer(source(mounts, 0x54535242), false)
            next damaged = audio.LoadMusPlayer(source(mounts, 0x444142), false)
        } else {
            timedFrame := audio.TickMusPlayer(timed)
            loopFrame := audio.TickMusPlayer(looped)
            percussionFrame := audio.TickMusPlayer(percussion)
            burstFrame := audio.TickMusPlayer(burst)
            damagedFrame := audio.TickMusPlayer(damaged)
            next timed = timedFrame.Player
            next looped = loopFrame.Player
            next percussion = percussionFrame.Player
            next burst = burstFrame.Player
            next damaged = damagedFrame.Player
            log("timed", timedFrame.Notes.Count, timedFrame.Notes.At(0).Key, timedFrame.Notes.At(0).Program,
                timedFrame.Notes.At(0).Velocity, timedFrame.Player.Active)
            log("loop", loopFrame.Notes.Count, loopFrame.Notes.At(0).Key, loopFrame.Player.Active)
            log("perc", percussionFrame.Notes.Count, percussionFrame.Notes.At(0).Key, percussionFrame.Notes.At(0).Channel,
                percussionFrame.Notes.At(0).Program, percussionFrame.Notes.At(0).Velocity)
            log("burst", burstFrame.Notes.Count, burstFrame.Notes.At(0).Key, burstFrame.Notes.At(17).Key,
                burstFrame.Notes.At(18).Key, burstFrame.Notes.At(16).Program)
            log("bad", damagedFrame.Notes.Count, damagedFrame.Player.Active)
        }
    }
}`);
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output], {
        cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
}

try {
    // Controller 0 selects program 7.  The second note inherits velocity 90;
    // a four-clock delay puts it at the start of the next 35 Hz tic.
    const timed = Buffer.from([0x40, 0, 7, 0x90, 0x80 | 60, 90, 4, 0x90, 62, 1, 0x60]);
    // Four one-clock loops fit inside the half-open gameplay tic.
    const loop = Buffer.from([0x90, 0x80 | 48, 70, 1, 0x60]);
    // Channel 15 is the MUS percussion channel.  Program selection still
    // travels with the voice metadata, without remapping its channel.
    const percussion = Buffer.from([0x4f, 0, 12, 0x9f, 0x80 | 35, 80, 4, 0x60]);
    const controls = Buffer.from(Array.from({ length: 300 }, (_, index) => [0x40, 0, index % 16]).flat());
    const burst = Buffer.concat([controls,
        Buffer.from([...Array.from({ length: 18 }, (_, key) => [0x10, key + 40]).flat(), 0x90, 50, 4, 0x60])]);
    const truncated = Buffer.concat([Buffer.from([0x10, 40]), controls, Buffer.from([0x90])]);
    writeFileSync(path.join(scratch, "MUSIC.WAD"), wad([
        ["TIME", mus(timed)], ["LOOP", mus(loop)], ["PERC", mus(percussion)], ["BRST", mus(burst)],
        ["BAD", mus(truncated)],
    ]));

    const sim = build();
    for (let tick = 0; tick < 5; tick++) sim.step();
    const rows = name => sim.logs.filter(row => row[0] === name).map(row => row.slice(1));
    assert.deepEqual(rows("timed").slice(0, 3), [
        [1, 60, 7, 90, true], [1, 62, 7, 90, false], [0, 0, 0, 0, false],
    ], "program change, explicit/implicit velocity, exact 4-clock boundary, and natural end");
    assert.deepEqual(rows("loop").slice(0, 3), [[4, 48, true], [4, 48, true], [4, 48, true]], "repeat restarts four times per gameplay tic");
    assert.deepEqual(rows("perc")[0], [1, 35, 15, 12, 80], "percussion preserves MUS channel 15 and program metadata");
    assert.deepEqual(rows("burst")[0], [19, 40, 57, 50, 11], "same-clock notes remain ordered across inline and paged storage");
    assert.deepEqual(rows("bad")[0], [0, false], "a truncated tail after 300 controllers discards earlier notes");
    console.log("Doom MUS sequencer matched 140 Hz timing, program/velocity state, percussion, bounded bursts, end, and looping.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-mus-sequencer-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
