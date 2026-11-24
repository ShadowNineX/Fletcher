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
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-textures-"));

function name(value) {
    const result = Buffer.alloc(8);
    result.write(value);
    return result;
}

function patch(width, height, columns) {
    const header = 8 + width * 4;
    const data = [];
    const offsets = [];
    for (const posts of columns) {
        offsets.push(header + data.length);
        for (const [top, pixels] of posts) data.push(top, pixels.length, 0, ...pixels, 0);
        data.push(255);
    }
    const result = Buffer.alloc(header + data.length);
    result.writeInt16LE(width, 0);
    result.writeInt16LE(height, 2);
    for (let i = 0; i < width; i++) result.writeUInt32LE(offsets[i], 8 + i * 4);
    Buffer.from(data).copy(result, header);
    return result;
}

function texture(nameValue, width, height, patches) {
    const result = Buffer.alloc(22 + patches.length * 10);
    name(nameValue).copy(result);
    result.writeInt16LE(width, 12);
    result.writeInt16LE(height, 14);
    result.writeInt16LE(patches.length, 20);
    for (const [i, { x, y, patch }] of patches.entries()) {
        const offset = 22 + i * 10;
        result.writeInt16LE(x, offset);
        result.writeInt16LE(y, offset + 2);
        result.writeInt16LE(patch, offset + 4);
    }
    return result;
}

function textureDirectory(definitions) {
    const offsets = [];
    let position = 4 + definitions.length * 4;
    for (const definition of definitions) {
        offsets.push(position);
        position += definition.length;
    }
    const result = Buffer.alloc(position);
    result.writeInt32LE(definitions.length, 0);
    offsets.forEach((offset, index) => result.writeInt32LE(offset, 4 + index * 4));
    definitions.forEach((definition, index) => definition.copy(result, offsets[index]));
    return result;
}

function wad(lumps, signature = "PWAD") {
    const directory = 12 + lumps.reduce((total, [, data]) => total + data.length, 0);
    const result = Buffer.alloc(directory + lumps.length * 16);
    result.write(signature);
    result.writeInt32LE(lumps.length, 4);
    result.writeInt32LE(directory, 8);
    let cursor = 12;
    lumps.forEach(([lumpName, data], index) => {
        result.writeInt32LE(cursor, directory + index * 16);
        result.writeInt32LE(data.length, directory + index * 16 + 4);
        name(lumpName).copy(result, directory + index * 16 + 8);
        data.copy(result, cursor);
        cursor += data.length;
    });
    return result;
}

function lumpEntry(file, lumpName) {
    const count = file.readInt32LE(4);
    const directory = file.readInt32LE(8);
    for (let index = count - 1; index >= 0; index--) {
        const entry = directory + index * 16;
        if (file.subarray(entry + 8, entry + 16).equals(name(lumpName))) return entry;
    }
    throw new Error(`Missing fixture lump ${lumpName}`);
}

function build(file) {
    const output = path.join(scratch, "output.json");
    const result = spawnSync("dotnet", [cli, "build", file, "--package-root", port, "--asset-root", scratch, "-o", output], {
        encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
}

try {
    const first = patch(2, 4, [
        [[0, [10, 11]], [1, [30, 31]]],
        [[1, [20, 21]]],
    ]);
    const overlay = patch(1, 3, [[[0, [100, 101, 102]]]]);
    const pnames = Buffer.concat([Buffer.from([2, 0, 0, 0]), name("patch0"), name("PATCH1")]);
    const texture1 = textureDirectory([texture("MIXED", 2, 4, [
        { x: 0, y: 0, patch: 0 }, { x: 1, y: 1, patch: 1 },
    ])]);
    // R_DrawColumnInCache clips at the destination while retaining the
    // post's first source byte. A source offset would yield 101 and 102.
    const texture2 = textureDirectory([texture("SECOND", 1, 2, [{ x: 0, y: -1, patch: 1 }])]);
    writeFileSync(path.join(scratch, "TEXTURES.WAD"), wad([
        ["PNAMES", pnames], ["PATCH0", first], ["PATCH1", Buffer.alloc(0)], ["PATCH1", overlay],
        ["TEXTURE1", texture1], ["TEXTURE2", texture2],
    ]));
    const source = path.join(scratch, "main.flt");
    writeFileSync(source, `package main
import "wad"
const Archive = readFile("TEXTURES.WAD")
func sample(texture wad.TextureDef, x int, y int) int {
    pixel := wad.TexturePixelAt(texture, x, y)
    if !pixel.Valid { return -2 }
    if !pixel.Covered { return -1 }
    return int(pixel.Value)
}
map "Doom texture data" {
    tick {
        set := wad.LoadTextureSet(Archive)
        first := wad.TextureAt(set, 0)
        second := wad.TextureAt(set, 1)
        log(set.Valid, wad.TextureCount(set), first.Valid, first.Width, first.Height, first.PatchCount)
        for y := range 4 { for x := range 2 { log(sample(first, x, y)) } }
        log(second.Valid, second.Width, second.Height, sample(second, 0, 0), sample(second, 0, 1))
        log(wad.TextureAt(set, 2).Valid)
    }
}
`);
    const sim = build(source);
    sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [true, 2, true, 2, 4, 2],
        [10], [-1], [30], [100], [31], [101], [-1], [102],
        [true, 1, 2, 100, 101], [false],
    ]);

    // The base supplies PNAMES and TEXTURE1. The add-on supplies a new
    // texture and the final bytes for patches referenced by both directories.
    writeFileSync(path.join(scratch, "BASE.WAD"), wad([
        ["PNAMES", pnames], ["TEXTURE1", texture1], ["PATCH0", first],
    ], "IWAD"));
    const replacement = patch(2, 4, [[[0, [77]]], [[0, [55]]]]);
    writeFileSync(path.join(scratch, "ADDON.WAD"), wad([
        ["PATCH0", replacement], ["PATCH1", overlay], ["TEXTURE2", texture2],
    ]));
    writeFileSync(source, `package main
import "wad"
const Base = readFile("BASE.WAD")
const Addon = readFile("ADDON.WAD")
map "Mounted Doom texture data" {
    tick {
        mounts := wad.AddArchive(wad.OpenArchive(Base), Addon)
        set := wad.LoadMountedTextureSet(mounts)
        first := wad.TextureAt(set, 0)
        second := wad.TextureAt(set, 1)
        log(set.Valid, wad.TextureCount(set))
        log(wad.TexturePixelAt(first, 0, 0).Value, wad.TexturePixelAt(first, 1, 1).Value)
        log(wad.TexturePixelAt(second, 0, 0).Value, wad.TexturePixelAt(second, 0, 1).Value)
    }
}
`);
    const layered = build(source);
    layered.step();
    assert.deepEqual(JSON.parse(JSON.stringify(layered.logs)), [[true, 2], [77, 100], [100, 101]]);

    const original = readFileSync(path.join(scratch, "TEXTURES.WAD"));
    const patchOffset = original.readInt32LE(lumpEntry(original, "PATCH0"));
    const malformedOffset = Buffer.from(original);
    malformedOffset.writeUInt32LE(8, patchOffset + 8);
    writeFileSync(path.join(scratch, "OFFSET.WAD"), malformedOffset);
    const malformedTail = Buffer.from(original);
    malformedTail[patchOffset + 28] = 0;
    malformedTail[patchOffset + 29] = 255;
    writeFileSync(path.join(scratch, "TRAILING.WAD"), malformedTail);
    const malformedTexture = Buffer.from(original);
    malformedTexture.writeUInt32LE(4, malformedTexture.readInt32LE(lumpEntry(malformedTexture, "TEXTURE1")) + 4);
    writeFileSync(path.join(scratch, "DIRECTORY.WAD"), malformedTexture);
    const malformedSecond = Buffer.from(original);
    malformedSecond.writeUInt32LE(original.length + 1, lumpEntry(original, "TEXTURE2"));
    writeFileSync(path.join(scratch, "SECOND.WAD"), malformedSecond);
    writeFileSync(source, `package main
import "wad"
const Offset = readFile("OFFSET.WAD")
const Trailing = readFile("TRAILING.WAD")
const Directory = readFile("DIRECTORY.WAD")
const Second = readFile("SECOND.WAD")
map "Broken Doom texture data" {
    tick {
        offset := wad.LoadTextureSet(Offset)
        trailing := wad.LoadTextureSet(Trailing)
        directory := wad.LoadTextureSet(Directory)
        log(wad.TexturePixelAt(wad.TextureAt(offset, 0), 0, 0).Valid)
        log(wad.TexturePixelAt(wad.TextureAt(trailing, 0), 0, 0).Valid)
        log(wad.TextureAt(directory, 0).Valid)
        log(wad.LoadTextureSet(Second).Valid)
    }
}
`);
    const invalid = build(source);
    invalid.step();
    assert.deepEqual(JSON.parse(JSON.stringify(invalid.logs)), [[false], [false], [false], [false]]);
    console.log("Doom texture records, patch posts, clipping, overlap, TEXTURE2, and bounds checks passed.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-textures-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
