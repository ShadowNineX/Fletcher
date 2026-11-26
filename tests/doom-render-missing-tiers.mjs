// Check Doom's absent wall tiers and the write order for a shared sky plane.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-missing-tiers-"));

function textureWad() {
    const patch = Buffer.alloc(145);
    patch.writeInt16LE(1); patch.writeInt16LE(128, 2); patch.writeUInt32LE(12, 8);
    patch[13] = 128; patch.fill(1, 15, 143); patch[144] = 255;
    const names = Buffer.alloc(12);
    names.writeUInt32LE(1); names.write("PANEL", 4);
    const textures = Buffer.alloc(76);
    textures.writeUInt32LE(2); textures.writeUInt32LE(12, 4); textures.writeUInt32LE(44, 8);
    for (const [index, name] of ["RESERVED", "TIER"].entries()) {
        const offset = 12 + index * 32;
        textures.write(name, offset); textures.writeInt16LE(1, offset + 12); textures.writeInt16LE(128, offset + 14);
        textures.writeInt16LE(1, offset + 20);
    }
    const palette = Buffer.alloc(3 * 256);
    palette.set([255, 0, 0], 3);
    const lumps = [["PANEL", patch], ["PNAMES", names], ["TEXTURE1", textures], ["PLAYPAL", palette],
        ["COLORMAP", Buffer.from(Array.from({ length: 33 * 256 }, (_, index) => index & 255))]];
    const directory = 12 + lumps.reduce((sum, [, data]) => sum + data.length, 0);
    const wad = Buffer.alloc(directory + 16 * lumps.length);
    wad.write("PWAD"); wad.writeUInt32LE(lumps.length, 4); wad.writeUInt32LE(directory, 8);
    let offset = 12;
    for (const [index, [name, data]] of lumps.entries()) {
        const entry = directory + 16 * index;
        wad.writeUInt32LE(offset, entry); wad.writeUInt32LE(data.length, entry + 4); wad.write(name, entry + 8);
        data.copy(wad, offset); offset += data.length;
    }
    return wad;
}

try {
    writeFileSync(path.join(scratch, "ART.WAD"), textureWad());
    const entry = path.join(scratch, "main.flt");
    writeFileSync(entry, `package main
import "engine"
import "numeric"
import "wad"
import "walls"
const Art = readFile("ART.WAD")
const Width = 16
const Height = 16

func edge(z int, center int, scale engine.WallScale, columnOffset int) int {
    return center - cport.C_FixedMul(z >> 4, scale.First) - columnOffset * cport.C_FixedMul(z >> 4, scale.Step)
}

map "Doom missing portal tiers" {
    screen at (0, 0) size (Width, Height) with { style = "solid", hold = true }
    tick {
        profile := currentTick()
        if profile < 9 {
            for y := range Height { pixel(8, y, true, color.Green) }
            camera := engine.Camera{View: engine.NewViewProjection(Width)}
            first := engine.Vertex{X: 64 << 16, Y: 128 << 16}
            last := engine.Vertex{X: 64 << 16, Y: -128 << 16}
            wall := wad.WallSegment{First: first, Last: last, Direction: 0xc0000000, TwoSided: profile != 6, Light: 255,
                Front: engine.SectorHeights{Floor: -32 << 16, Ceiling: 32 << 16},
                Back: engine.SectorHeights{Floor: -16 << 16, Ceiling: 16 << 16}}
            sharedSky := profile >= 7
            if profile == 7 { wall.Front.Floor = -64 << 16 }
            dash, tier := wad.LumpName{Low: 45}, wad.LumpName{Low: 0x52454954}
            sides := wad.SideMaterial{Upper: dash, Lower: dash}
            if profile == 1 || profile == 3 { sides.Upper = tier }
            if profile == 1 || profile == 2 { sides.Lower = tier }
            if profile >= 5 {
                reserved := wad.LumpName{Low: 0x45534552, High: 0x44455652} // RESERVED, texture zero.
                sides.Upper, sides.Lower, sides.Middle = reserved, reserved, reserved
            }
            var materials walls.WallMaterials
            var shading walls.WadShading
            if profile != 4 {
                mounted := wad.OpenArchive(Art)
                shading = walls.LoadShading(mounted)
                textures := walls.Materials{Textures: wad.LoadMountedTextureSet(mounted)}
                materials = walls.ResolveWallMaterials(textures, wall, sides, camera.Z)
                if !shading.Valid { log("missing fixture art") }
            }
            surface := walls.Surface{Front: wall.Front, Back: wall.Back, Solid: !wall.TwoSided, TwoSided: wall.TwoSided,
                MarkCeiling: true, MarkFloor: true, FrontSky: sharedSky,
                Shade: color.Red, Materials: materials}
            view := walls.WallView{Height: Height, ColumnAngles: engine.ViewColumnAngles(camera.View)}
            var coverage engine.ColumnCoverage
            if sharedSky {
                sky := engine.PlaneKey{TextureLow: 0x4b535f46, TextureHigh: 0x3159, Sky: true}
                floor, ceiling := sky, sky
                floor.Height, ceiling.Height = wall.Front.Floor, wall.Front.Ceiling
                coverage = engine.BeginSubsectorPlanes(coverage, camera.Z, floor, ceiling)
            }
            projected := walls.ProjectWall(camera, coverage, first, last)
            drawn := walls.DrawProjectedWall(camera, coverage, first, last, wall.Direction, surface, view, projected, shading)
            // Feed the pinned column loop the same projected wall heights.
            // The renderer independently determines whether to clip/paint the tiers.
            distance := engine.PrepareWall(camera, first, wall.Direction, projected.FirstAngle)
            scale := engine.ScaleWallSpan(camera, distance, projected.Span)
            center := (Height / 2) << 12
            columnOffset := 8 - projected.Span.First
            top, bottom := edge(wall.Front.Ceiling, center, scale, columnOffset), edge(wall.Front.Floor, center, scale, columnOffset)
            high, low := edge(wall.Back.Ceiling, center, scale, columnOffset), edge(wall.Back.Floor, center, scale, columnOffset)
            clip := drawn.Rows[8]
            skyFirst, skyEnd := -1, -1
            if sharedSky && drawn.CeilingPlane == drawn.FloorPlane && drawn.CeilingPlane > 0 {
                raster := drawn.Planes.RasterAt(drawn.CeilingPlane - 1)
                if raster.HasRows {
                    rows := raster.Rows.ReadRows()
                    skyFirst, skyEnd = int(rows[8] >> 16), int(rows[8] & 65535)
                }
            }
            log(Height, top, bottom, high, low, profile == 1 || profile == 3, profile == 1 || profile == 2,
                sharedSky, int(clip >> 16) - 1, int(clip & 65535), skyFirst, skyEnd, drawn.Failed)
        }
    }
}`);
    const output = path.join(scratch, "preview.json");
    const built = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (built.error) throw built.error;
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    const inputs = [], rows = [];
    for (let profile = 0; profile < 9; profile++) {
        sim.step();
        const row = Array.from(sim.logs[profile], Number);
        assert.equal(row.pop(), 0, "the wall range renders");
        inputs.push(row.slice(0, 8));
        const pixel = y => sim.tileAt({ x: 8, y })?.extra;
        const painted = Array.from({ length: 16 }, (_, y) => pixel(y)).filter(value => value !== pixel(0)).length;
        const clipAndPaint = [...row.slice(8, 10), painted];
        rows.push(profile < 7 ? clipAndPaint : [...clipAndPaint, ...row.slice(10)]);
    }
    const [missing, textured, lower, upper, diagnostic, namedZero, missingMiddle] = rows;
    assert.equal(missing[2], 0, "explicitly absent tiers leave the existing framebuffer visible");
    assert.ok(lower[2] > 0 && upper[2] > 0 && textured[2] === lower[2] + upper[2]);
    assert.deepEqual(diagnostic, textured, "the asset-free geometry diagnostic still uses fallback color");
    assert.deepEqual(namedZero, missing, "naming texture zero also leaves an empty upper and lower tier");
    assert.deepEqual(missingMiddle, missing, "texture zero leaves the one-sided middle tier undrawn");
    assert.ok(rows[7][3] === 0 && rows[7][4] > 0 && rows[7][4] < 8, "ceiling-only sky fragment survives");
    assert.ok(rows[8][3] > 8 && rows[8][4] === 16, "visible floor replaces ceiling on the shared sky column");
    if (values.upstream) {
        const { runNativeMissingTiersOracle } = await import("./doom-native-missing-tiers-oracle.mjs");
        const withMaterials = (_, profile) => profile !== 4;
        assert.deepEqual(rows.filter(withMaterials), runNativeMissingTiersOracle(path.resolve(root, values.upstream), scratch, inputs.filter(withMaterials)),
            "the wall pixels and remaining portal span match pinned R_RenderSegLoop");
    }
    console.log("Missing wall tiers and shared sky matched Doom's opaque drawing and portal clipping.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-missing-tiers-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
