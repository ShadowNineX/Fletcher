import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-texture-index-"));

function name(value) {
    const result = Buffer.alloc(8);
    result.write(value);
    return result;
}

function texture(value, width, height) {
    const result = Buffer.alloc(22);
    name(value).copy(result);
    result.writeInt16LE(width, 12);
    result.writeInt16LE(height, 14);
    return result;
}

function directory(definitions, badOffset = []) {
    const result = Buffer.alloc(4 + definitions.length * 4 + definitions.reduce((n, d) => n + d.length, 0));
    result.writeInt32LE(definitions.length);
    let cursor = 4 + definitions.length * 4;
    definitions.forEach((definition, index) => {
        result.writeInt32LE(badOffset.includes(index) ? 4 : cursor, 4 + index * 4);
        definition.copy(result, cursor);
        cursor += definition.length;
    });
    return result;
}

function wad(lumps, signature = "PWAD") {
    const directoryOffset = 12 + lumps.reduce((total, [, data]) => total + data.length, 0);
    const result = Buffer.alloc(directoryOffset + lumps.length * 16);
    result.write(signature);
    result.writeInt32LE(lumps.length, 4);
    result.writeInt32LE(directoryOffset, 8);
    let cursor = 12;
    lumps.forEach(([lumpName, data], index) => {
        result.writeInt32LE(cursor, directoryOffset + index * 16);
        result.writeInt32LE(data.length, directoryOffset + index * 16 + 4);
        name(lumpName).copy(result, directoryOffset + index * 16 + 8);
        data.copy(result, cursor);
        cursor += data.length;
    });
    return result;
}

function packed(value) {
    const bytes = Buffer.alloc(8);
    bytes.write(value);
    return [bytes.readInt32LE(0), bytes.readInt32LE(4)];
}

function build(source) {
    const output = path.join(scratch, "output.json");
    const result = spawnSync("dotnet", [cli, "build", source, "--package-root", port, "--asset-root", scratch, "-o", output], {
        encoding: "utf8", cwd: root, timeout: 20_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
}

try {
    const pnames = Buffer.alloc(4);
    pnames.writeInt32LE(0);
    const first = directory([
        texture("ZERO", 8, 8),
        texture("DUP", 0, 8),
        texture("BAD", 8, 8),
        texture("LaTeR\0XX", 16, 8),
    ], [2]);
    const second = directory([
        texture("ZERO", 32, 32),
        texture("DUP", 32, 32),
        texture("SECOND", 24, 12),
        texture("BAD", 8, 8),
    ]);
    writeFileSync(path.join(scratch, "BASE.WAD"), wad([["PNAMES", pnames], ["TEXTURE1", first]], "IWAD"));
    writeFileSync(path.join(scratch, "ADDON.WAD"), wad([["TEXTURE2", second]]));
    const dense = [
        texture("ZERO", 8, 8), texture("SV1YHMM6", 8, 8), texture("Y8FRVVWE", 16, 8),
        ...Array.from({ length: 1800 }, (_, index) => texture(`L${String(index).padStart(7, "0")}`, 8, 8)),
    ];
    writeFileSync(path.join(scratch, "DENSE.WAD"), wad([
        ["PNAMES", pnames], ["TEXTURE1", directory(dense)],
        ["TEXTURE2", directory([texture("Y8FRVVWE", 32, 8), texture("DENSEEND", 8, 8)])],
    ]));

    const [zeroLow, zeroHigh] = packed("zero");
    const [dupLow, dupHigh] = packed("DUP");
    const [badLow, badHigh] = packed("BAD");
    const [laterLow, laterHigh] = packed("LATER");
    const [secondLow, secondHigh] = packed("second");
    const [sharedLow, sharedHigh] = packed("Y8FRVVWE");
    const [firstHashLow, firstHashHigh] = packed("SV1YHMM6");
    const [endLow, endHigh] = packed("denseend");
    const source = path.join(scratch, "main.flt");
    writeFileSync(source, `package main
import "wad"
const Base = readFile("BASE.WAD")
const Addon = readFile("ADDON.WAD")
const Dense = readFile("DENSE.WAD")
map "Doom texture name index" {
    register textures wad.TextureSet = wad.TextureSet{}
    tick {
        zero := wad.LumpName{Low: ${zeroLow}, High: ${zeroHigh}}
        dup := wad.LumpName{Low: ${dupLow}, High: ${dupHigh}}
        bad := wad.LumpName{Low: ${badLow}, High: ${badHigh}}
        later := wad.LumpName{Low: ${laterLow}, High: ${laterHigh}}
        second := wad.LumpName{Low: ${secondLow}, High: ${secondHigh}}
        working := textures
        if currentTick() == 0 {
            mounts := wad.AddArchive(wad.OpenArchive(Base), Addon)
            working = wad.LoadMountedTextureSet(mounts)
            log(wad.TextureIndex(working, dup), wad.TextureIndex(working, zero), wad.TextureIndex(working, later), wad.TextureIndex(working, second), working.CanIndexNames(), working.NameIndexReady())
        } else if currentTick() < 8 {
            working = working.BuildNameIndex(2)
            log(wad.TextureIndex(working, dup), wad.TextureIndex(working, zero), wad.TextureIndex(working, bad),
                wad.TextureIndex(working, later), wad.TextureIndex(working, second), wad.TextureAt(working, 1).Valid,
                working.CanIndexNames(), working.NameIndexReady())
        } else if currentTick() == 8 {
            working = wad.LoadTextureSet(Dense)
            log(working.CanIndexNames(), working.NameIndexReady(), wad.TextureCount(working))
        } else if !working.NameIndexReady() {
            working = working.BuildNameIndex(71)
            if working.NameIndexReady() {
                firstHash := wad.TextureIndex(working, wad.LumpName{Low: ${firstHashLow}, High: ${firstHashHigh}})
                secondHash := wad.TextureIndex(working, wad.LumpName{Low: ${sharedLow}, High: ${sharedHigh}})
                last := wad.TextureIndex(working, wad.LumpName{Low: ${endLow}, High: ${endHigh}})
                beyondCache := wad.TextureAt(working, last)
                log(firstHash, secondHash, last, wad.TextureAt(working, secondHash).Width, beyondCache.Valid, beyondCache.Width)
            }
        }
        next textures = working
    }
}
`);
    const sim = build(source);
    for (let i = 0; i < 36; i++) sim.step();
    const logs = JSON.parse(JSON.stringify(sim.logs));
    assert.deepEqual(logs[0], [1, -1, 3, 6, true, false]);
    assert.deepEqual(logs.slice(1, 8), Array.from({ length: 7 }, (_, i) =>
        [1, -1, 7, 3, 6, false, true, i >= 3]));
    assert.deepEqual(logs.slice(8), [[true, false, dense.length + 2], [1, 2, dense.length + 1, 16, true, 8]]);
    console.log("Doom texture-name index passed batching, malformed entries, layered TEXTURE2, and a dense directory with exact hash collisions.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-texture-index-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
