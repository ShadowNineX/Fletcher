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
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-flats-"));

function name(value) {
    const result = Buffer.alloc(8);
    result.write(value);
    return result;
}

function wad(magic, lumps) {
    const directory = 12 + lumps.reduce((total, [, data]) => total + data.length, 0);
    const result = Buffer.alloc(directory + lumps.length * 16);
    result.write(magic);
    result.writeInt32LE(lumps.length, 4);
    result.writeInt32LE(directory, 8);
    let cursor = 12;
    lumps.forEach(([lumpName, data], index) => {
        const entry = directory + index * 16;
        result.writeInt32LE(cursor, entry);
        result.writeInt32LE(data.length, entry + 4);
        name(lumpName).copy(result, entry + 8);
        data.copy(result, cursor);
        cursor += data.length;
    });
    return result;
}

function palette(count, transform) {
    const data = Buffer.alloc(count * 256 * 3);
    for (let table = 0; table < count; table++) for (let index = 0; index < 256; index++) {
        const offset = (table * 256 + index) * 3;
        const [red, green, blue] = transform(table, index);
        data[offset] = red;
        data[offset + 1] = green;
        data[offset + 2] = blue;
    }
    return data;
}

function colorMaps(count, transform) {
    const data = Buffer.alloc(count * 256);
    for (let table = 0; table < count; table++) for (let index = 0; index < 256; index++)
        data[table * 256 + index] = transform(table, index);
    return data;
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
    const baseFlat = Buffer.from(Array.from({ length: 4096 }, (_, index) => index & 255));
    const patchFlat = Buffer.alloc(4096, 201);
    writeFileSync(path.join(scratch, "BASE.WAD"), wad("IWAD", [
        ["F_START", Buffer.alloc(0)], ["FLAT0", baseFlat], ["BROKEN", Buffer.alloc(17)], ["F_END", Buffer.alloc(0)],
        ["PLAYPAL", palette(2, (table, index) => [index, (index + table * 10) & 255, (255 - index) & 255])],
        ["COLORMAP", colorMaps(2, (table, index) => (index + table) & 255)],
    ]));
    writeFileSync(path.join(scratch, "PATCH.WAD"), wad("PWAD", [
        ["F_START", Buffer.alloc(0)], ["FLAT1", patchFlat], ["F_END", Buffer.alloc(0)],
        ["PLAYPAL", palette(1, (_, index) => [index, (index + 20) & 255, (index + 40) & 255])],
        ["COLORMAP", colorMaps(1, (_, index) => (255 - index) & 255)],
    ]));
    writeFileSync(path.join(scratch, "MALFORMED.WAD"), wad("PWAD", [
        ["PLAYPAL", Buffer.alloc(767)], ["COLORMAP", Buffer.alloc(257)],
    ]));
    const source = path.join(scratch, "main.flt");
    writeFileSync(source, `package main
import "wad"
const Base = readFile("BASE.WAD")
const Patch = readFile("PATCH.WAD")
const Malformed = readFile("MALFORMED.WAD")
map "Doom flats and palettes" {
    tick {
        base := wad.OpenArchive(Base)
        mounted := wad.AddArchive(base, Patch)
        flats := wad.LoadFlats(base)
        mountedFlats := wad.LoadFlats(mounted)
        palette := wad.LoadPalettes(base)
        mountedPalette := wad.LoadPalettes(mounted)
        maps := wad.LoadColorMaps(base)
        mountedMaps := wad.LoadColorMaps(mounted)
        malformed := wad.OpenArchive(Malformed)
        first := wad.SampleFlat(flats, 0, 65, -1)
        broken := wad.SampleFlat(flats, 1, 0, 0)
        overlaid := wad.SampleFlat(mountedFlats, 0, 65, -1)
        color := wad.SamplePalette(palette, 1, 7)
        patchColor := wad.SamplePalette(mountedPalette, 0, 7)
        shade := wad.SampleColorMap(maps, 1, 7)
        patchShade := wad.SampleColorMap(mountedMaps, 0, 7)
        log(flats.Valid, flats.Count, first.Valid, first.Value, broken.Valid)
        log(mountedFlats.Valid, mountedFlats.Count, overlaid.Valid, overlaid.Value)
        log(palette.Valid, palette.Count, color.Valid, color.Red, color.Green, color.Blue)
        log(mountedPalette.Valid, mountedPalette.Count, patchColor.Valid, patchColor.Red, patchColor.Green, patchColor.Blue)
        log(maps.Valid, maps.Count, shade.Valid, shade.Value, patchShade.Valid, patchShade.Value)
        log(wad.SamplePalette(palette, 2, 0).Valid, wad.SampleColorMap(maps, 2, 0).Valid)
        log(wad.LoadPalettes(malformed).Valid, wad.LoadColorMaps(malformed).Valid)
    }
}
`);
    const sim = build(source);
    sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [true, 2, true, 193, false],
        [true, 1, true, 201],
        [true, 2, true, 7, 17, 248],
        [true, 1, true, 7, 27, 47],
        [true, 2, true, 8, true, 248],
        [false, false],
        [false, false],
    ]);
    console.log("Doom F_START/F_END flats, palette triplets, COLORMAP lookup, mounting, and malformed flat checks passed.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-flats-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
