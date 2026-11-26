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
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-lines-"));

function fixture() {
    const vertices = Buffer.alloc(5 * 4);
    for (const [index, [x, y]] of [[-64, 32], [128, 32], [-64, 160], [128, 160], [128, -96]].entries()) {
        vertices.writeInt16LE(x, index * 4);
        vertices.writeInt16LE(y, index * 4 + 2);
    }
    const lines = Buffer.alloc(5 * 14);
    function line(index, first, last, flags, action, tag, front, back) {
        const offset = index * 14;
        lines.writeUInt16LE(first, offset); lines.writeUInt16LE(last, offset + 2);
        lines.writeUInt16LE(flags, offset + 4); lines.writeInt16LE(action, offset + 6);
        lines.writeInt16LE(tag, offset + 8); lines.writeUInt16LE(front, offset + 10); lines.writeUInt16LE(back, offset + 12);
    }
    line(0, 0, 1, 4, 12, 77, 0, 1);
    line(1, 0, 2, 0, 0, 0, 0, 0xffff);
    line(2, 0, 3, 4 | 8 | 16, -2, -7, 0, 2);
    line(3, 0, 4, 0, 0, 0, 0, 1);
    line(4, 0, 9, 0, 0, 0, 0, 1);
    const sides = Buffer.alloc(3 * 30);
    sides.writeInt16LE(3, 0);
    sides.writeUInt16LE(0, 28); sides.writeUInt16LE(1, 58); sides.writeUInt16LE(2, 88);
    const sectors = Buffer.alloc(3 * 26);
    sectors.writeInt16LE(0, 0); sectors.writeInt16LE(128, 2);
    sectors.writeInt16LE(32, 26); sectors.writeInt16LE(96, 28);
    sectors.writeInt16LE(128, 54);
    // Both names decode to FLAT. The original renderer still compares all eight bytes.
    sectors.write("FLAT\0A", 4);
    sectors.write("FLAT\0B", 56);
    sectors.write("f_sKy1\0X", 12);
    const segs = Buffer.alloc(2 * 12);
    segs.writeUInt16LE(3, 2);
    segs.writeUInt16LE(2, 6);
    segs.writeInt16LE(-2, 10);
    segs.writeUInt16LE(9, 12);
    return Buffer.concat([vertices, lines, sides, sectors, segs]);
}

const source = `package main

import "wad"
import "engine"

const Source = readFile("LINES.BIN")

type LiveGeometry struct { Marker int }
func (change LiveGeometry) ReadHeights(sector int, original engine.SectorHeights) engine.SectorHeights {
    if sector == 0 { original.Floor, original.Ceiling = 16 << 16, 112 << 16 }
    if sector == 2 { original.Ceiling = 80 << 16 }
    return original
}
func (change LiveGeometry) ReadLineAction(index int, original int) int { return original }
func (change LiveGeometry) ReadSectorSpecial(index int, original int) int { return original }
func (change LiveGeometry) ReadFloorName(index int, original wad.LumpName) wad.LumpName {
    if index == 0 { return wad.LumpName{Low: 0x74616c66, High: 50} } // flat2
    if index == 2 { return wad.LumpName{Low: 88} }
    return original
}
func (change LiveGeometry) ReadSideMaterial(index int, original wad.SideMaterial) wad.SideMaterial {
    original.OffsetU = original.OffsetU + (change.Marker << 16)
    original.Middle = wad.LumpName{Low: 89}
    return original
}

map "Doom collision line parity" {
    tick {
        if currentTick() == 0 {
            level := wad.BspLevel{
                File: Source,
                Vertices: wad.Lump{Offset: 0, Count: 5, Valid: true},
                Lines: wad.Lump{Offset: 20, Count: 5, Valid: true},
                Sides: wad.Lump{Offset: 90, Count: 3, Valid: true},
                Sectors: wad.Lump{Offset: 180, Count: 3, Valid: true},
                Segs: wad.Lump{Offset: 258, Count: 2, Valid: true},
            }
            horizontal := level.LineAt(0)
            vertical := level.LineAt(1)
            positive := level.LineAt(2)
            negative := level.LineAt(3)
            invalid := level.LineAt(4)
            badSides := level
            badSides.Sides.Count = 1
            badSector := level
            badSector.Sectors.Count = 1
            opening := wad.LineOpening(level, horizontal)
            closed := wad.LineOpening(level, vertical)
            log(horizontal.Valid, horizontal.First.X >> 16, horizontal.Last.Y >> 16, horizontal.DeltaX >> 16, horizontal.DeltaY >> 16,
                horizontal.Slope, horizontal.Bounds.Left >> 16, horizontal.Bounds.Right >> 16, horizontal.Bounds.Bottom >> 16, horizontal.Bounds.Top >> 16,
                horizontal.FrontSector, horizontal.BackSector, horizontal.Flags, horizontal.Action, horizontal.Tag)
            log(vertical.Valid, vertical.Slope, vertical.BackSector, positive.Slope, positive.Action, positive.Tag, negative.Slope,
                invalid.Valid, badSides.LineAt(0).Valid, badSector.LineAt(0).Valid)
            log(opening.Valid, opening.TwoSided, opening.OpenTop >> 16, opening.OpenBottom >> 16, opening.LowFloor >> 16, opening.Range >> 16)
            log(closed.Valid, closed.TwoSided, closed.OpenTop, closed.OpenBottom, closed.LowFloor, closed.Range)
            log(wad.LineOpening(badSector, horizontal).Valid)
            cached := level.CacheWallAt(0)
            original := level.SegmentAt(0)
            log(original, cached.ReadWall(level), level.MaterialAt(original), cached.ReadWallMaterial(level))
            live := level.WithChanges(LiveGeometry{Marker: 17})
            refreshed := live.SegmentAt(0)
            log(refreshed, cached.ReadWall(live), live.MaterialAt(refreshed), cached.ReadWallMaterial(live))
            log(cached.ReadWall(level), cached.ReadWallMaterial(level), level.CacheWallAt(1).Base.Valid)
            floor, ceiling := cached.ReadPlaneKeys(level, original)
            log(level.PlaneKey(original, false), floor, level.PlaneKey(original, true), ceiling)
            lit := refreshed
            lit.Light = 171
            floor, ceiling = cached.ReadPlaneKeys(live, lit)
            log(live.PlaneKey(lit, false), floor, live.PlaneKey(lit, true), ceiling)
        }
    }
}
`;

try {
    writeFileSync(path.join(scratch, "LINES.BIN"), fixture());
    const main = path.join(scratch, "main.flt");
    const output = path.join(scratch, "map.json");
    writeFileSync(main, source);
    const result = spawnSync("dotnet", [cli, "build", main, "--package-root", port, "--asset-root", scratch, "-o", output], {
        encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
    sim.step();
    const logs = JSON.parse(JSON.stringify(sim.logs));
    assert.deepEqual(logs.slice(0, 5), [
        [true, -64, 32, 192, 0, 0, -64, 128, 32, 32, 0, 1, 4, 12, 77],
        [true, 1, -1, 2, -2, -7, 3, false, false, false],
        [true, true, 96, 32, 0, 64],
        [true, false, 0, 0, 0, 0],
        [false],
    ]);
    for (const [direct, cached, directMaterial, cachedMaterial] of logs.slice(5, 7)) {
        assert.deepEqual(cached, direct, "cached segments match direct parsing and live sector changes");
        assert.deepEqual(cachedMaterial, directMaterial, "live material changes precede SEG offsets and peg flags");
    }
    assert.equal(logs[5][0].MarkFloor, true);
    assert.equal(logs[6][0].Back.Ceiling, 80 << 16);
    assert.equal(logs[6][3].OffsetU, 18 << 16);
    assert.deepEqual(logs[7], [logs[5][0], logs[5][2], false], "live changes leave the cached base intact");
    for (const [directFloor, cachedFloor, directCeiling, cachedCeiling] of logs.slice(8, 10)) {
        assert.deepEqual(cachedFloor, directFloor, "cached floor names follow live height, light and floor transfers");
        assert.deepEqual(cachedCeiling, directCeiling, "cached sky names use live height and omit sector light");
    }
    assert.deepEqual(logs[9][1], { Height: 16 << 16, Light: 171, TextureLow: 0x54414c46, TextureHigh: 50, Sky: false });
    assert.deepEqual(logs[9][3], { Height: 112 << 16, Light: 0, TextureLow: 0x4b535f46, TextureHigh: 0x3159, Sky: true });
    console.log("Doom collision lines and cached SEG geometry passed raw names, live sector changes, sidedef overrides, and invalid references.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-lines-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
