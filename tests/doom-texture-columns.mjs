import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values, positionals } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" } }, allowPositionals: true });
const cli = path.resolve(root, values.cli ?? positionals[0] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-texture-columns-"));

function name(value) {
    const out = Buffer.alloc(8);
    out.write(value);
    return out;
}

function patch(width, height, columns) {
    const header = 8 + width * 4, data = [], offsets = [];
    for (const posts of columns) {
        offsets.push(header + data.length);
        for (const [top, pixels] of posts) data.push(top, pixels.length, 0, ...pixels, 0);
        data.push(255);
    }
    const out = Buffer.alloc(header + data.length);
    out.writeInt16LE(width, 0);
    out.writeInt16LE(height, 2);
    offsets.forEach((offset, index) => out.writeUInt32LE(offset, 8 + index * 4));
    Buffer.from(data).copy(out, header);
    return out;
}

function texture(label, width, height, patches) {
    const out = Buffer.alloc(22 + patches.length * 10);
    name(label).copy(out);
    out.writeInt16LE(width, 12);
    out.writeInt16LE(height, 14);
    out.writeInt16LE(patches.length, 20);
    for (const [i, { x, y, patch: index }] of patches.entries()) {
        const at = 22 + i * 10;
        out.writeInt16LE(x, at);
        out.writeInt16LE(y, at + 2);
        out.writeInt16LE(index, at + 4);
    }
    return out;
}

function textureDirectory(definitions) {
    let cursor = 4 + definitions.length * 4;
    const length = cursor + definitions.reduce((bytes, definition) => bytes + definition.length, 0);
    const out = Buffer.alloc(length);
    out.writeInt32LE(definitions.length, 0);
    for (const [index, definition] of definitions.entries()) {
        out.writeInt32LE(cursor, 4 + index * 4);
        definition.copy(out, cursor);
        cursor += definition.length;
    }
    return out;
}

function wad(lumps) {
    const directory = 12 + lumps.reduce((size, [, data]) => size + data.length, 0);
    const out = Buffer.alloc(directory + lumps.length * 16);
    out.write("PWAD");
    out.writeInt32LE(lumps.length, 4);
    out.writeInt32LE(directory, 8);
    let cursor = 12;
    for (const [index, [label, data]] of lumps.entries()) {
        const entry = directory + index * 16;
        out.writeInt32LE(cursor, entry);
        out.writeInt32LE(data.length, entry + 4);
        name(label).copy(out, entry + 8);
        data.copy(out, cursor);
        cursor += data.length;
    }
    return out;
}
function build(entry) {
    const output = path.join(scratch, "output.json");
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output], { encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
}

function nativeOverlap(upstream, base, overlay, height) {
    const routine = extractFunction(readFileSync(path.join(upstream, "r_data.c"), "utf8"), "void", "R_DrawColumnInCache");
    const postBytes = bytes => Array.from(bytes.subarray(bytes.readUInt32LE(8))).join(",");
    const input = path.join(scratch, "overlap.c"), executable = path.join(scratch, "overlap.exe");
    writeFileSync(input, `#include <stdio.h>
#include <string.h>
typedef unsigned char byte;
typedef struct { byte topdelta, length; } column_t;
${routine}
int main(void) {
    byte base[] = {${postBytes(base)}};
    byte overlay[] = {${postBytes(overlay)}};
    byte pixels[${height}];
    memset(pixels, 255, sizeof(pixels));
    R_DrawColumnInCache((column_t *)base, pixels, 0, ${height});
    R_DrawColumnInCache((column_t *)overlay, pixels, -1, ${height});
    for (int row = 0; row < ${height}; row++) printf("%d\\n", pixels[row] == 255 ? -1 : pixels[row]);
    return 0;
}
`);
    const compilation = spawnSync(process.env.CC ?? "gcc", ["-std=c11", "-O2", input, "-o", executable],
        { encoding: "utf8", timeout: 15000 });
    if (compilation.error) throw compilation.error;
    assert.equal(compilation.status, 0, compilation.stderr);
    const native = spawnSync(executable, [], { encoding: "utf8", timeout: 10000 });
    if (native.error) throw native.error;
    assert.equal(native.status, 0, native.stderr);
    return native.stdout.trim().split(/\s+/).map(Number);
}

try {
    const opaque = patch(2, 4, [[[0, [10, 11, 12, 13]]], [[0, [20, 21, 22, 23]]]]);
    const overlay = patch(1, 4, [[[1, [100, 101]]]]);
    const shifted = patch(1, 3, [[[0, [50, 51, 52]]]]);
    const tallBase = patch(1, 40, [[[0, Array.from({ length: 27 }, (_, row) => 128 + row)]]]);
    const tallOverlay = patch(1, 40, [[[0, [240, 241, 242]], [32, [1, 2, 3, 4, 5, 6, 7, 8, 9]]]]);
    const pnames = Buffer.concat([Buffer.from([5, 0, 0, 0]), name("OPAQUE"), name("OVERLAY"), name("SHIFTED"),
        name("TALLBASE"), name("TALLOVR")]);
    const directory = textureDirectory([
        texture("DIRECT3", 3, 4, [{ x: 0, y: 0, patch: 0 }, { x: 2, y: 0, patch: 1 }]),
        texture("MIXED", 1, 4, [{ x: 0, y: 0, patch: 0 }, { x: 0, y: 0, patch: 1 }]),
        texture("SHIFT", 1, 2, [{ x: 0, y: -1, patch: 2 }]),
        texture("MANY", 1, 4, [...Array.from({ length: 64 }, () => ({ x: 2, y: 0, patch: 1 })), { x: 0, y: 0, patch: 1 }]),
        texture("CROSS", 1, 39, [{ x: 0, y: 0, patch: 3 }, { x: 0, y: -1, patch: 4 }]),
    ]);
    writeFileSync(path.join(scratch, "COLUMNS.WAD"), wad([["PNAMES", pnames], ["OPAQUE", opaque], ["OVERLAY", overlay],
        ["SHIFTED", shifted], ["TALLBASE", tallBase], ["TALLOVR", tallOverlay], ["TEXTURE1", directory]]));
    const source = path.join(scratch, "main.flt");
    writeFileSync(source, `package main
import "wad"
const Archive = readFile("COLUMNS.WAD")
func sample(column wad.TextureColumn, row int) int {
    pixel := wad.TextureColumnPixel(column, row)
    if !pixel.Valid { return -2 }
    if !pixel.Covered { return -1 }
    return int(pixel.Value)
}
map "Doom texture columns" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        set := wad.LoadTextureSet(Archive)
        direct := wad.TextureAt(set, 0)
        mixed := wad.TextureAt(set, 1)
        shifted := wad.TextureAt(set, 2)
        first := wad.PrepareTextureColumn(direct, 0)
        wrapped := wad.PrepareTextureColumn(direct, 2)
        composite := wad.PrepareTextureColumn(mixed, 0)
        clipped := wad.PrepareTextureColumn(shifted, 0)
        log(wad.TextureColumnWidthMask(direct), first.Valid, first.Direct, first.DirectRaw, first.DirectOffset > 0)
        for y := range 4 { log(sample(first, y), sample(wrapped, y)) }
        log(composite.Valid, composite.Direct, composite.DirectRaw)
        for y := range 4 { log(sample(composite, y)) }
        log(clipped.Valid, clipped.Direct, clipped.DirectRaw, sample(clipped, 0), sample(clipped, 1))
        // A wall run caches this prepared result for repeated wrapped columns;
        // this is the per-tick 128-pixel hot path after one preparation.
        for column := range 128 { log(sample(composite, 0)) }
        mixedRun := wad.PrepareTextureColumns(mixed)
        mixedColumn := mixedRun.ColumnAt(0)
        for y := range 4 { log(sample(mixedColumn, y)) }
        manyRun := wad.PrepareTextureColumns(wad.TextureAt(set, 3))
        manyColumn := manyRun.ColumnAt(0)
        log(manyColumn.Valid, manyColumn.Direct, manyColumn.DirectRaw)
        for y := range 4 { log(sample(manyColumn, y)) }
        cross := wad.PrepareTextureColumn(wad.TextureAt(set, 4), 0)
        log(cross.Valid, cross.Direct, cross.Height)
        for y := range 40 { log(sample(cross, y)) }
    }
}
`);
    const sim = build(source);
    const before = performance.now();
    for (let host = 0; host < 32 && sim.logs.length === 0; host++) sim.step();
    const elapsed = performance.now() - before;
    const rows = JSON.parse(JSON.stringify(sim.logs));
    assert.deepEqual(rows.slice(0, 10), [
        [1, true, true, true, true], [10, 10], [11, 11], [12, 12], [13, 13],
        [true, false, false], [10], [100], [101], [13],
    ]);
    assert.deepEqual(rows[10], [true, true, true, 50, 51], "the original direct column ignores Y origin");
    assert.ok(rows.slice(11, 139).every(row => row[0] === 10), "cached composite retains opaque base data");
    assert.deepEqual(rows.slice(139, 143), [[10], [100], [101], [13]], "the run cache preserves the patch overlap order");
    assert.deepEqual(rows.slice(143, 148), [[true, true, false], [-1], [100], [101], [-1]], "patch tables past the cache size still resolve every patch");
    assert.deepEqual(rows[148], [true, false, 39]);
    const expected = [240, 241, ...Array.from({ length: 25 }, (_, row) => row + 130), -1, -1, -1, -1,
        1, 2, 3, 4, 5, 6, 7, 8, -2];
    assert.deepEqual(rows.slice(149), expected.map(value => [value]),
        "unaligned posts keep neighboring texels, high palette indices, holes, and classic negative-origin clipping");
    if (values.upstream) {
        assert.deepEqual(rows.slice(149, -1).map(([value]) => value),
            nativeOverlap(path.resolve(root, values.upstream), tallBase, tallOverlay, 39));
        console.log("All 39 overlap rows matched pinned R_DrawColumnInCache.");
    }
    console.log(`Doom direct/composite texture column parity passed (128 cached samples in ${elapsed.toFixed(2)} ms).`);

    const malformed = Buffer.from(readFileSync(path.join(scratch, "COLUMNS.WAD")));
    const patchOffset = malformed.readInt32LE(malformed.readInt32LE(8) + 16);
    malformed.writeUInt32LE(8, patchOffset + 8);
    writeFileSync(path.join(scratch, "BROKEN.WAD"), malformed);
    writeFileSync(source, `package main
import "wad"
const Archive = readFile("BROKEN.WAD")
map "Broken Doom texture column" {
    tick {
        set := wad.LoadTextureSet(Archive)
        composite := wad.PrepareTextureColumns(wad.TextureAt(set, 1))
        log(wad.PrepareTextureColumn(wad.TextureAt(set, 0), 0).Valid, composite.ColumnAt(0).Valid)
        log(wad.TextureColumnWidthMask(wad.TextureDef{Width: 64}))
        for _, width := range [12]int{-1, 0, 1, 2, 3, 127, 128, 129, 8192, 16383, 16384, 32767} {
            log(width, wad.TextureColumnWidthMask(wad.TextureDef{Valid: true, Width: width}))
        }
    }
}
`);
    const invalid = build(source);
    invalid.step();
    assert.deepEqual(JSON.parse(JSON.stringify(invalid.logs)), [[false, false], [0],
        [-1, 0], [0, 0], [1, 0], [2, 1], [3, 1], [127, 63], [128, 127], [129, 127],
        [8192, 8191], [16383, 8191], [16384, 16383], [32767, 16383]], "texture widths round down to the original power-of-two mask");

    writeFileSync(source, `package main
import "wad"
import "walls"
const Archive = readFile("COLUMNS.WAD")
const Other = readFile("BROKEN.WAD")
map "Texture column cache identity" {
    screen at (0, 0) size (1, 1) with { style = "solid" }
    tick {
        texture := wad.TextureAt(wad.LoadTextureSet(Archive), 0)
        column := wad.PrepareTextureColumn(texture, 0)
        texture.Width = 8192
        before := walls.ColumnCache{Enabled: true}
        original := before.Store(texture, 0, walls.CachedTextureColumn{Data: column})
        replaced := original.Store(texture, 4096, walls.CachedTextureColumn{})
        _, empty := before.Lookup(texture, 0)
        first, retained := original.Lookup(texture, 0)
        _, evicted := replaced.Lookup(texture, 0)
        missing, cachedInvalid := replaced.Lookup(texture, 4096)
        other := texture
        other.File = Other
        _, otherDefinition := original.Lookup(other, 0)
        other = texture
        other.PNames.File = Other
        _, otherNames := original.Lookup(other, 0)
        log(empty, retained, first.ReadColumn().Valid, evicted, cachedInvalid, missing.ReadColumn().Valid,
            otherDefinition, otherNames)
    }
}
`);
    const cached = build(source);
    cached.step();
    assert.deepEqual(JSON.parse(JSON.stringify(cached.logs)), [[false, true, true, false, true, false, false, false]],
        "cache hits preserve the original snapshot and respect file identity after a collision");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-texture-columns-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
