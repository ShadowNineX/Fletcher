import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const temp = mkdtempSync(path.join(os.tmpdir(), "fletcher-doom-sprite-"));

function name(value) { const result = Buffer.alloc(8); result.write(value); return result; }
function wad(lumps) {
    const dataEnd = 12 + lumps.reduce((sum, [, data]) => sum + data.length, 0);
    const result = Buffer.alloc(dataEnd + lumps.length * 16);
    result.write("PWAD"); result.writeInt32LE(lumps.length, 4); result.writeInt32LE(dataEnd, 8);
    let cursor = 12;
    lumps.forEach(([label, data], index) => {
        const entry = dataEnd + index * 16;
        result.writeInt32LE(cursor, entry); result.writeInt32LE(data.length, entry + 4);
        name(label).copy(result, entry + 8); data.copy(result, cursor); cursor += data.length;
    });
    return result;
}
function patch() {
    const result = Buffer.alloc(8 + 4 + 6 + 5 + 1);
    result.writeInt16LE(1, 0); result.writeInt16LE(4, 2);
    result.writeInt16LE(0, 4); result.writeInt16LE(0, 6); result.writeUInt32LE(12, 8);
    // Two opaque posts with a transparent gap: source rows 0,1 then row 3.
    result[12] = 0; result[13] = 2; result[14] = 0; result[15] = 1; result[16] = 2; result[17] = 0;
    result[18] = 3; result[19] = 1; result[20] = 0; result[21] = 3; result[22] = 0; result[23] = 255;
    return result;
}

function tallPatch() {
    const length = 130;
    const result = Buffer.alloc(12 + 4 + length + 1);
    result.writeInt16LE(1, 0); result.writeInt16LE(length, 2); result.writeUInt32LE(12, 8);
    result[13] = length;
    result.fill(9, 15, 15 + length);
    result[15 + 128] = 0x70;
    result[15 + 129] = 0x7f;
    result[16 + length] = 255;
    return result;
}

try {
    const source = path.join(temp, "main.flt");
    const maps = Buffer.alloc(32 * 256);
    for (let row = 0; row < 32; row++) for (let index = 0; index < 256; index++) maps[row * 256 + index] = index;
    maps[256 + 0x60] = 5; maps[256 + 0x6f] = 6;
    maps[256 + 0x70] = 4; maps[256 + 0x7f] = 4;
    writeFileSync(path.join(temp, "SPRITE.WAD"), wad([["PATCH", patch()], ["TALL", tallPatch()], ["COLORMAP", maps]]));
    writeFileSync(source, `package main
import "sprites"
import "engine"
import "walls"
import "wad"
const Archive = readFile("SPRITE.WAD")
map "Doom sprite pixels" {
    screen at (0, 0) size (4, 4) with { style = "solid", hold = true }
    tick {
        mounts := wad.OpenArchive(Archive)
        patch := mounts.Find(wad.LumpName{Low: 0x43544150, High: 0x48})
        tall := mounts.Find(wad.LumpName{Low: 0x4c4c4154})
        maps := mounts.Find(wad.LumpName{Low: 0x4f4c4f43, High: 0x50414d52})
        shade := walls.WadShading{ColorMaps: maps, Palette: [256]color{color.Black, color.Red, color.Green, color.Blue, color.Yellow, color.Purple, color.Orange, color.White}, Valid: true}
        walls.DrawSprite(sprites.ProjectedSprite{Valid: true, Span: engine.ColumnSpan{First: 1, End: 2}, Scale: 65536, StartFrac: 0, XStep: 65536, TextureMid: 131072, Patch: patch, LightRow: 0}, 4, [engine.MaxViewWidth]bits<32>{}, shade)
        walls.DrawSprite(sprites.ProjectedSprite{Valid: true, Span: engine.ColumnSpan{First: 2, End: 3}, Scale: 65536,
            XStep: 65536, TextureMid: 130 * 65536, Patch: tall, LightRow: 1, Translation: 1},
            4, [engine.MaxViewWidth]bits<32>{}, shade)
        log(pixelIndexAt(2, 0), pixelIndexAt(2, 1), pixelIndexAt(2, 2))
    }
}
`);
    // The fixture is intentionally compiled by the normal CLI path; malformed
    // patch/post bounds are covered by the bounded sprite column parser.
    const output = path.join(temp, "output.json");
    const result = spawnSync("dotnet", [cli, "build", source, "--package-root", root + "/examples/doom-engine", "--asset-root", temp, "-o", output], { encoding: "utf8", cwd: root });
    assert.equal(result.status, 0, result.stderr);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
    sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [[5, 6, -1]]);
    assert.equal(sim.tileAt({ x: 1, y: 0 }).extra, 1, "first source row maps to red");
    assert.equal(sim.tileAt({ x: 1, y: 1 }).extra, 4, "second source row maps to green");
    assert.equal(sim.tileAt({ x: 1, y: 2 }).extra, 7, "transparent post gap stays black");
    assert.equal(sim.tileAt({ x: 1, y: 3 }).extra, 2, "later post maps to blue after the gap");
    assert.equal(sim.tileAt({ x: 2, y: 0 }).extra, 6, "source row 128 translates before its COLORMAP lookup");
    assert.equal(sim.tileAt({ x: 2, y: 1 }).extra, 5, "the end of the source ramp also translates before shading");
    console.log("Doom masked and translated sprite post raster fixture passed.");
} finally {
    rmSync(temp, { recursive: true, force: true });
}
