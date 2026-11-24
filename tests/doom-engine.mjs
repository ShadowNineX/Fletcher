import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectWad } from "../examples/doom-engine/inspect-wad.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(path.join(artifacts, "doom-engine-test-"));

function fletcher(...args) {
    const result = spawnSync("dotnet", [cli, ...args], {
        encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
}

function simulate(entry, ...args) {
    const output = path.join(scratch, "map.json");
    fletcher("build", entry, "-o", output, ...args);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
}

function fixedDivision(a, b) {
    if ((Math.abs(a) >>> 14) >= Math.abs(b)) return (a ^ b) < 0 ? -2147483648 : 2147483647;
    return Number((BigInt(a) * 65536n) / BigInt(b));
}

try {
    mkdirSync(path.join(scratch, "numeric"));
    const regenerated = path.join(scratch, "numeric", "portable.flt");
    fletcher("transpile-c", path.join(port, "source", "portable-engine.c"), "-o", regenerated);
    const normalized = file => readFileSync(file, "utf8").replaceAll("\r\n", "\n");
    const checkedIn = normalized(path.join(port, "numeric", "portable.flt"));
    assert.match(checkedIn, /^\/\/ SPDX-License-Identifier: GPL-2\.0-only/m);
    assert.equal(checkedIn.slice(checkedIn.indexOf("// Generated")), normalized(regenerated));

    // Build in a disposable tree with the regenerated source on the import path.
    mkdirSync(path.join(scratch, "engine"));
    for (const file of ["angles.flt", "bsp.flt", "coverage.flt", "draw-segments.flt", "geometry.flt", "paged-slots.flt",
        "projection.flt", "records.flt", "slope-table.flt", "tangent-table.flt", "visplanes.flt"]) {
        copyFileSync(path.join(port, "engine", file), path.join(scratch, "engine", file));
    }

    let random = 0x12345678;
    function next() {
        random = (Math.imul(random, 1664525) + 1013904223) | 0;
        return random;
    }
    const vectors = [[0, 0], [-1, 0], [65536, 3], [-65536, 3], [65536, -3], [65536, 4],
        [65536, 5], [2147483647, -2147483648], [-2147483648, 1], [-2147483648, -2147483648],
        [0x12345678, 0x89abcdef | 0]];
    for (let i = 0; i < 96; i++) vectors.push([next(), next() >> (i % 32)]);
    const pairs = vectors.map(([a, b]) => `[2]int{${a}, ${b}}`).join(", ");

    const entry = path.join(scratch, "main.flt");
    writeFileSync(entry, `package main

import "numeric"
import "engine"

type Nodes struct {
    Count int
    Records [2]engine.Node
}

func (nodes Nodes) NodeCount() int { return nodes.Count }
func (nodes Nodes) NodeAt(index int) engine.Node { return nodes.Records[index] }

type BspTraceScene struct {
    FrontBounds engine.Box
    BackBounds engine.Box
}

func (scene BspTraceScene) NodeCount() int { return 1 }
func (scene BspTraceScene) SubsectorCount() int { return 2 }
func (scene BspTraceScene) PartitionAt(index int) engine.BspPartition {
    return engine.BspPartition{DeltaY: engine.FracUnit, Front: engine.SubsectorFlag, Back: engine.SubsectorFlag + 1}
}
func (scene BspTraceScene) ChildAt(index int, side int) int {
    if side == 0 { return engine.SubsectorFlag }
    return engine.SubsectorFlag + 1
}
func (scene BspTraceScene) ChildBoundsAt(index int, side int) engine.Box {
    if side == 0 { return scene.FrontBounds }
    return scene.BackBounds
}
func (scene BspTraceScene) DrawBspSubsector(index int, frame engine.BspFrame<int>) engine.BspFrame<int> {
    if frame.Data == 0 {
        frame.Coverage = engine.CoverSpan(frame.Coverage, engine.ColumnSpan{End: 128})
    }
    frame.Data = frame.Data * 10 + index + 1
    return frame
}

func traceBsp(front engine.Box, back engine.Box, x int) engine.BspFrame<int> {
    scene := BspTraceScene{FrontBounds: front, BackBounds: back}
    return engine.RenderBspFrame(scene, engine.NewViewProjection(128), 0, x, 0, engine.BspFrame<int>{})
}

map "Engine parity" {
    tick {
        for _, pair := range [${vectors.length}][2]int{${pairs}} {
            a, b := pair[0], pair[1]
            left, right := bits<32>(a), bits<32>(b)
            log(cport.C_FixedMul(a, b), cport.C_FixedDiv(a, b), cport.C_SwapLONG(left), cport.C_SwapSHORT(left),
                cport.C_SlopeDiv(left, right), cport.C_R_ColumnTexel(a), cport.C_R_SpanTexel(a, b))
        }
        box := engine.AddToBox(engine.ClearBox(), 7, -2)
        log(box.Left, box.Bottom, box.Right, box.Top)
        box = engine.AddPointToBox(box, 1, -8)
        log(box.Left, box.Bottom, box.Right, box.Top)

        nodes := Nodes{Count: 2}
        leaf := engine.SubsectorFlag
        nodes.Records[0] = engine.Node{DeltaX: engine.FracUnit, Front: leaf, Back: leaf + 1}
        nodes.Records[1] = engine.Node{DeltaY: engine.FracUnit, Front: 0, Back: leaf + 2}
        log(engine.PointInSubsector(nodes, 3, 1, -1), engine.PointInSubsector(nodes, 3, 1, 1),
            engine.PointInSubsector(nodes, 3, 0, 0), engine.PointInSubsector(Nodes{}, 1, 0, 0))
        nodes.Records[0].Front = 1
        log(engine.PointInSubsector(nodes, 3, 1, -1), engine.PointInSubsector(nodes, 2, 0, 0))
        unit := engine.FracUnit
        log(engine.PointOnSegSide(2 * unit, unit, 0, 0, unit, unit),
            engine.PointOnSegSide(unit, 2 * unit, 0, 0, unit, unit),
            engine.PointOnSegSide(unit, unit, 0, 0, unit, unit),
            engine.PointOnSegSide(unit, -unit, 0, 0, unit, unit))

        // The first leaf fills the active view. Doom still visits a deferred
        // child whose conservative bbox contains the camera or puts it exactly
        // on an edge; an ordinary deferred bbox is rejected by coverage.
        insideFront := engine.Box{Top: 4 * unit, Bottom: -3 * unit, Left: -4 * unit, Right: unit / 2}
        insideBack := engine.Box{Top: 3 * unit, Bottom: -5 * unit, Left: -unit / 2, Right: 5 * unit}
        insideRight := traceBsp(insideFront, insideBack, unit)
        insideLeft := traceBsp(insideFront, insideBack, -unit)
        edgeFront := engine.Box{Top: 5 * unit, Bottom: -2 * unit, Left: -6 * unit, Right: -unit}
        edgeBack := engine.Box{Top: 2 * unit, Bottom: -4 * unit, Left: -7 * unit, Right: unit}
        edgeRight := traceBsp(edgeFront, edgeBack, unit)
        edgeLeft := traceBsp(edgeFront, edgeBack, -unit)
        ordinaryFront := engine.Box{Top: 3 * unit, Bottom: -2 * unit, Left: -9 * unit, Right: -6 * unit}
        ordinaryBack := engine.Box{Top: 2 * unit, Bottom: -5 * unit, Left: 6 * unit, Right: 10 * unit}
        ordinaryRight := traceBsp(ordinaryFront, ordinaryBack, unit)
        ordinaryLeft := traceBsp(ordinaryFront, ordinaryBack, -unit)
        log(insideRight.Data, insideRight.Coverage.Failed, insideLeft.Data, insideLeft.Coverage.Failed,
            edgeRight.Data, edgeRight.Coverage.Failed, edgeLeft.Data, edgeLeft.Coverage.Failed,
            ordinaryRight.Data, ordinaryRight.Coverage.Failed, ordinaryLeft.Data, ordinaryLeft.Coverage.Failed)

        log(engine.PointToAngle(0, 0, 0, 0), engine.PointToAngle(0, 0, 65536, 0),
            engine.PointToAngle(0, 0, 0, 65536), engine.PointToAngle(0, 0, -65536, 0), engine.PointToAngle(0, 0, 0, -65536))
        log(engine.PointToAngle(100, -500, 327780, 196108), engine.PointToAngle(0, 0, 196608, 327680),
            engine.PointToAngle(0, 0, -196608, 327680), engine.PointToAngle(0, 0, -327680, 196608),
            engine.PointToAngle(0, 0, -327680, -196608), engine.PointToAngle(0, 0, -196608, -327680),
            engine.PointToAngle(0, 0, 196608, -327680), engine.PointToAngle(0, 0, 327680, -196608),
            engine.PointToAngle(0, 0, 65536, 65536))
        for page := range 8 {
            log(engine.PointToAngle(0, 0, 2048 * unit, (128 + page * 256) * unit))
        }

        vertex := engine.DecodeVertex([4]bits<8>{0xff, 0x7f, 0, 0x80})
        leafRecord := engine.DecodeSubsector([4]bits<8>{5, 0, 0x23, 0x81})
        log(vertex.X, vertex.Y, leafRecord.SegmentCount, leafRecord.FirstSegment)
        node := engine.DecodeNode([28]bits<8>{
            1, 0, 0xff, 0xff, 2, 0, 0, 0,
            3, 0, 0xfd, 0xff, 0xfa, 0xff, 6, 0,
            7, 0, 0xf9, 0xff, 0xf8, 0xff, 8, 0,
            2, 0x80, 1, 0,
        })
        log(node.X / unit, node.Y / unit, node.DeltaX / unit, node.DeltaY / unit, node.Front, node.Back,
            node.FrontBounds.Top / unit, node.FrontBounds.Bottom / unit, node.FrontBounds.Left / unit, node.FrontBounds.Right / unit,
            node.BackBounds.Top / unit, node.BackBounds.Bottom / unit, node.BackBounds.Left / unit, node.BackBounds.Right / unit)
    }
}
`);
    const parity = simulate(entry);
    parity.step();
    const actual = JSON.parse(JSON.stringify(parity.logs));
    const expected = vectors.map(([a, b]) => {
        const bytes = Buffer.alloc(4);
        bytes.writeInt32LE(a);
        const denominator = b >>> 0;
        return [
            Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b)) >> 16n)), fixedDivision(a, b),
            bytes.readUInt32BE(), bytes.readUInt16BE(),
            denominator < 512 ? 2048 : Math.min(2048, Math.trunc(((a << 3) >>> 0) / (denominator >>> 8))),
            Math.floor(a / 65536) & 127, (Math.floor(b / 65536) & 63) * 64 + (Math.floor(a / 65536) & 63),
        ];
    });
    assert.deepEqual(actual.slice(0, vectors.length), expected);
    assert.deepEqual(actual.slice(vectors.length), [
        [7, -2, -2147483648, -2147483648], [1, -8, 1, -8], [0, 1, 2, 0], [-1, -1], [0, 1, 1, 0],
        [12, false, 21, false, 12, false, 21, false, 1, false, 2, false],
        // These angles also come from the pinned upstream R_PointToAngle2 and tantoangle, compiled as C with GCC.
        [0, 0, 1073741823, 2147483647, 3221225472],
        [369215648, 704526175, 1442957472, 1778267999, 2516699296, 2852009823, 3590441120, 3925751648, 536870911],
        ...[42667332, 126697424, 207041584, 281909472, 350251648, 411702720, 466407904, 514828064].map(value => [value]),
        [2147418112, -2147483648, 5, 0x8123 - 65536], [1, -1, 2, 0, 0x8002, 1, 3, -3, -6, 6, 7, -7, -8, 8],
    ]);

    const raster = simulate(path.join(port, "main.flt"));
    raster.step();
    for (let y = 0; y < 12; y++) {
        for (let x = 0; x < 24; x++) {
            const expectedColor = y >= 6 ? (((y - 6 + x) & 4) ? 6 : 2) :
                y < 1 + Math.floor(x / 8) ? 7 : y < 4 ? 5 : 3;
            assert.equal(raster.tileAt({ x: x - 12, y: y - 6 }).extra, expectedColor, `pixel (${x},${y})`);
        }
    }
    const writes = raster.tileWrites;
    raster.step();
    assert.equal(raster.tileWrites, writes, "raster holds the frame after drawing once");

    const file = path.join(scratch, "synthetic.wad");
    const count = 260;
    const directory = 32;
    const wad = Buffer.alloc(directory + count * 16);
    wad.write("PWAD", 0, "ascii");
    wad.writeInt32LE(count, 4);
    wad.writeInt32LE(directory, 8);
    function lump(index, name, offset, size) {
        const start = directory + index * 16;
        wad.writeInt32LE(offset, start);
        wad.writeInt32LE(size, start + 4);
        wad.write(name, start + 8, "ascii");
    }
    lump(0, "SYNTH001", 12, 4);
    lump(1, "MARKER", -1, 0);
    lump(259, "SYNTH001", 16, 8);
    writeFileSync(file, wad);
    const metadata = {
        kind: "PWAD", count, directoryOffset: directory,
        matches: { synth001: { index: 259, offset: 16, size: 8 }, marker: { index: 1, offset: -1, size: 0 }, missing: null },
    };
    assert.deepEqual(inspectWad(file, ["synth001", "marker", "missing"]), metadata);
    const report = spawnSync(process.execPath, [path.join(port, "inspect-wad.mjs"), file, "synth001", "marker", "missing"], { encoding: "utf8" });
    assert.equal(report.status, 0, report.stderr);
    assert.deepEqual(JSON.parse(report.stdout), metadata);
    writeFileSync(file, wad.subarray(0, -1));
    assert.throws(() => inspectWad(file), /directory lies outside/);
    lump(259, "SYNTH001", wad.length, 1);
    writeFileSync(file, wad);
    assert.throws(() => inspectWad(file), /lump 259 lies outside/);
    wad.write("NOPE", 0, "ascii");
    writeFileSync(file, wad);
    assert.throws(() => inspectWad(file), /IWAD or PWAD signature/);

    console.log(`Doom engine parity passed for ${vectors.length} numeric cases, BSP traversal, 22 upstream angles, raster output, and WAD records and directory checks.`);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
