import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const scratch = mkdtempSync(path.join(os.tmpdir(), "fletcher-doom-palette-dither-"));

function name(value) { const result = Buffer.alloc(8); result.write(value); return result; }
function wad(lumps) {
    const directory = 12 + lumps.reduce((sum, [, data]) => sum + data.length, 0);
    const result = Buffer.alloc(directory + lumps.length * 16);
    result.write("PWAD"); result.writeInt32LE(lumps.length, 4); result.writeInt32LE(directory, 8);
    let cursor = 12;
    lumps.forEach(([label, data], index) => {
        const entry = directory + index * 16;
        result.writeInt32LE(cursor, entry); result.writeInt32LE(data.length, entry + 4); name(label).copy(result, entry + 8);
        data.copy(result, cursor); cursor += data.length;
    });
    return result;
}

try {
    const palette = Buffer.alloc(2 * 256 * 3);
    // Include common lit and shadow texels alongside true colored trim.
    [[1, 128, 128, 128], [2, 120, 70, 30], [3, 255, 0, 0],
        [5, 27, 27, 27], [6, 35, 35, 35], [7, 23, 15, 7], [8, 31, 23, 11],
        [9, 0, 0, 59], [10, 11, 23, 7], [11, 20, 0, 20], [12, 55, 51, 55]].forEach(([index, red, green, blue]) => {
        palette[index * 3] = red; palette[index * 3 + 1] = green; palette[index * 3 + 2] = blue;
    });
    palette[(256 + 3) * 3 + 2] = 255;
    palette.fill(32, 4 * 3, 5 * 3);
    palette.fill(80, (256 + 4) * 3, (256 + 5) * 3);
    const maps = Buffer.from(Array.from({ length: 35 * 256 }, (_, index) => ((index >> 8) * 13 + index) & 255));
    const overlay = maps.map(index => 255 - index);
    const sources = [1, 127, 128, 255];
    const flat = Buffer.alloc(4096);
    flat.set(sources);
    writeFileSync(path.join(scratch, "PALETTE.WAD"), wad([["PLAYPAL", palette], ["COLORMAP", maps]]));
    writeFileSync(path.join(scratch, "OVERLAY.WAD"), wad([["COLORMAP", overlay]]));
    writeFileSync(path.join(scratch, "flat.bin"), flat);
    const source = path.join(scratch, "main.flt");
    writeFileSync(source, `package main
import "engine"
import "wad"
import "walls"
const Archive = readFile("PALETTE.WAD")
const Overlay = readFile("OVERLAY.WAD")
const Flat = readFile("flat.bin")

func paintMap(shade walls.WadShading, light int, row int) {
    plane := walls.WadPlanePainter{Flat: wad.LumpRef{File: Flat, Size: wad.FlatBytes, Valid: true}, Shade: shade.WithFixedColormap(light)}
    plane.DrawPlaneSpan(row, 0, 4, engine.PlaneSample{StepU: engine.FracUnit})
}

map "Doom palette dither" {
    screen at (0, 0) size (4, 5) with { style = "solid", hold = true }
    tick {
        base := wad.OpenArchive(Archive)
        shade := walls.LoadShading(base).WithDithering()
        log(shade.Patterns.First[1] == color.Black, shade.Patterns.Second[1] == color.White,
            shade.ColorAt(1, 0, 0) == color.White, shade.ColorAt(1, 0, 3) == color.Black)
        log(shade.Patterns.First[2] == color.Purple, shade.Patterns.Second[2] == color.Purple)
        log(shade.ColorAt(3, 0, 0) == color.Red, shade.ColorAt(3, 3, 3) == color.Red)
        shifted := shade.WithPalette(1)
        log(shifted.ColorAt(3, 0, 0) == color.Blue, shifted.ColorAt(3, 3, 3) == color.Blue,
            shade.ColorAt(3, 0, 0) == color.Red, shifted.WithPalette(0).ColorAt(3, 3, 3) == color.Red)

        direct := walls.LoadShading(base).WithContrast()
        for level := range engine.DoomGammaCount {
            solid := direct.WithGamma(level)
            log("solid", solid.ColorAt(5, 0, 0), solid.ColorAt(6, 0, 0),
                solid.ColorAt(7, 0, 0), solid.ColorAt(8, 0, 0), solid.ColorAt(9, 0, 0),
                solid.ColorAt(10, 0, 0), solid.ColorAt(11, 0, 0), solid.ColorAt(12, 0, 0),
                solid.ColorAt(5, 3, 3), solid.WithPalette(1).ColorAt(3, 0, 0))
        }
        log(direct.ColorAt(4, 0, 0) == color.Black, direct.WithGamma(4).ColorAt(4, 0, 0) == color.White)

        layered := wad.AddArchive(base, Overlay)
        replacement := shade
        replacement.ColorMaps = wad.LoadColorMaps(layered).Data
        shiftedSource := shade
        shiftedSource.ColorMaps.Offset = shiftedSource.ColorMaps.Offset + wad.ColorMapBytes
        paintMap(shifted, 32, 0)
        paintMap(shade, 34, 1)
        paintMap(walls.LoadShading(layered), 32, 2)
        paintMap(replacement, 32, 3)
        paintMap(shiftedSource, 31, 4)
        for y := range 5 {
            log(pixelIndexAt(0, y), pixelIndexAt(1, y), pixelIndexAt(2, y), pixelIndexAt(3, y))
        }
        bright := shifted.WithGamma(4)
        log(bright.PaletteRow == 1, bright.Patterns.Coverage[4] > shifted.Patterns.Coverage[4],
            bright.Patterns.Coverage[4] == shade.WithGamma(4).WithPalette(1).Patterns.Coverage[4],
            bright.WithGamma(0).Patterns.Coverage[4] == shifted.Patterns.Coverage[4],
            bright.WithPalette(0).Patterns.Coverage[4] == shade.WithGamma(4).Patterns.Coverage[4])
        for level := range engine.DoomGammaCount {
            for component := range 256 {
                log("gamma-byte", engine.DoomGammaByte(level, bits<8>(component)))
            }
        }
    }
}
`);
    const output = path.join(scratch, "output.json");
    const result = spawnSync("dotnet", [cli, "build", source, "--package-root", port, "--asset-root", scratch, "-o", output], {
        encoding: "utf8", cwd: root, timeout: 30_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data)); sim.step();
    const from = (table, row) => sources.map(index => table[row * 256 + index]);
    const logs = JSON.parse(JSON.stringify(sim.logs));
    assert.deepEqual(logs.filter(([tag]) => tag !== "gamma-byte" && tag !== "solid"), [
        [true, true, true, true], [false, false], [true, true], [true, true, true, true],
        [true, true],
        from(maps, 32), from(maps, 34), from(overlay, 32), from(overlay, 32), from(maps, 32),
        [true, true, true, true, true],
    ]);
    const solid = logs.filter(([tag]) => tag === "solid");
    // Stock wall tile IDs for black, white, black, orange, blue, green, purple,
    // white, the same shadow at another coordinate, and the tinted blue swatch.
    assert.deepEqual(solid, Array.from({ length: 5 }, () => ["solid", 7, 0, 7, 5, 2, 4, 6, 0, 7, 2]));
    const gamma = logs.filter(([tag]) => tag === "gamma-byte").map(([, value]) => value);
    assert.equal(gamma.length, 5 * 256);
    // SHA-256 of id Software's gammatable in pinned linuxdoom-1.10/v_video.c.
    assert.equal(createHash("sha256").update(Buffer.from(gamma)).digest("hex"),
        "e14a1da57838e65bcb7a5bdc3f866eea41361b9e067d1539b08557f0577de63a");
    console.log("Doom palette projection passed solid shadows and hues, ordered dithering, all five gamma tables, palette tints, and layered COLORMAP sampling.");
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
