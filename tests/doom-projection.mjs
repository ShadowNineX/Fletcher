import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(path.join(artifacts, "doom-projection-"));

function build(entry) {
    const output = path.join(scratch, "output.json");
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "-o", output], {
        encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return decode(JSON.parse(readFileSync(output, "utf8")).data);
}

function digest(rows) {
    return rows.reduce((hash, [value]) => Math.imul(hash ^ value, 16777619) >>> 0, 2166136261);
}

try {
    const entry = path.join(scratch, "main.flt");
    writeFileSync(entry, `package main
import "engine"

const Widths = [4]int{2, 95, 160, 320}
const Unit = engine.FracUnit
const WallPoints = [9][4]int{
    [4]int{64,16,64,-16}, [4]int{128,160,128,-160}, [4]int{64,-16,64,16}, [4]int{-64,-16,-64,16},
    [4]int{64,120,64,96}, [4]int{64,128,64,0}, [4]int{64,0,64,-128}, [4]int{1024,2,1024,1}, [4]int{0,64,32,-64},
}
const DistancePoints = [6][2]int{
    [2]int{64,16}, [2]int{96,-16}, [2]int{128,160}, [2]int{-30,-23}, [2]int{1,1}, [2]int{300,7},
}
const PlaneHeadings = [6]bits<32>{0, 0x00004027, 0x20000000, 0x4670baba, 0x80000000, 0xd00705fd}
const PlanePoints = [6][3]int{
    [3]int{0,0,96}, [3]int{24,1,0}, [3]int{47,31,44}, [3]int{48,63,40}, [3]int{51,64,48}, [3]int{95,127,0},
}
const PlaneIntervals = [11][2]int{
    [2]int{0,0}, [2]int{1,5}, [2]int{2,4}, [2]int{0,6}, [2]int{0,6}, [2]int{5,8},
    [2]int{6,8}, [2]int{0,0}, [2]int{2,7}, [2]int{1,7}, [2]int{1,6},
}

type SpanTrace struct {}
func (trace SpanTrace) PlaneSpan(row int, firstColumn int, endColumn int) {
    pixel(firstColumn, row, true, color.Red)
    for offset := range endColumn - firstColumn - 1 {
        pixel(firstColumn + offset + 1, row, true, color.Green)
    }
}

type CachedSpanTrace struct {
    View engine.PlaneView
    Z int
    Pass int
}

func (trace CachedSpanTrace) DrawPlaneSpan(row int, firstColumn int, endColumn int, cached engine.PlaneSample) {
    plain := engine.MapPlane(trace.View, trace.Z, row, firstColumn)
    y := trace.Pass * 8 + row
    if cached.U != plain.U || cached.V != plain.V || cached.StepU != plain.StepU || cached.StepV != plain.StepV ||
        cached.Distance != plain.Distance || ((cached.Distance == 0) != (trace.Pass == 0 || trace.Pass == 5)) {
        pixel(firstColumn, y, true, color.Purple)
        return
    }
    SpanTrace{}.PlaneSpan(y, firstColumn, endColumn)
}

map "Doom projection parity" {
    screen at (0, 0) size (16, 48) with { style = "solid" }
    tick {
        tickIndex := currentTick()
        if tickIndex < 160 {
            view := engine.NewViewProjection(Widths[tickIndex / 40])
            phase := tickIndex % 40
            if phase == 0 { log(view.ClipAngle) }
            if phase < 32 {
                for i := range 128 {
                    angle := (bits<32>(phase * 128 + i) << engine.FineAngleShift) - 0x40000000
                    log(engine.ColumnForAngle(view, angle))
                }
            } else {
                for i := range 48 {
                    column := (phase - 32) * 48 + i
                    if column <= view.Width { log(engine.AngleForColumn(view, column)) }
                }
            }
        } else if tickIndex == 160 {
            view := engine.NewViewProjection(96)
            for _, p := range WallPoints {
                first := engine.PointToAngle(0, 0, p[0] * Unit, p[1] * Unit)
                last := engine.PointToAngle(0, 0, p[2] * Unit, p[3] * Unit)
                span := engine.WallColumns(view, 0, first, last)
                if span.First == span.End { log(0, 0) } else { log(span.First, span.End) }
            }
            box := engine.Box{Top: 16 * Unit, Bottom: -16 * Unit, Left: 64 * Unit, Right: 128 * Unit}
            coverage := engine.ColumnCoverage{}
            open := engine.BoxVisible(view, 0, 0, 0, box, coverage)
            coverage = engine.CoverSpan(coverage, engine.ColumnSpan{First: 40, End: 56})
            partly := engine.BoxVisible(view, 0, 0, 0, box, coverage)
            coverage = engine.CoverSpan(coverage, engine.ColumnSpan{First: 34, End: 62})
            log(open, partly, engine.BoxVisible(view, 0, 0, 0, box, coverage),
                engine.BoxVisible(view, 0x80000000, 0, 0, box, coverage),
                engine.BoxVisible(view, 0x80000000, 96 * Unit, 0, box, coverage))
            for _, p := range DistancePoints { log(engine.PointToDistance(0, 0, p[0] * Unit, p[1] * Unit)) }
            camera := engine.Camera{View: engine.NewViewProjection(128)}
            for _, p := range [2][3]int{[3]int{64,16,0xe000}, [3]int{128,160,0xc000}} {
                vertex := engine.Vertex{X: p[0] * Unit, Y: p[1] * Unit}
                angle := engine.PointToAngle(0, 0, vertex.X, vertex.Y)
                wall := engine.PrepareWall(camera, vertex, bits<32>(p[2]) << 16, angle)
                scale := engine.ScaleWallSpan(camera, wall, engine.ColumnSpan{First: 45, End: 75})
                log(wall.Normal, wall.Distance, scale.First, scale.Last, scale.Step)
            }
        } else if tickIndex == 161 {
            view := engine.NewViewProjection(128)
            for i, p := range PlanePoints {
                camera := engine.Camera{X: 10 * Unit + 17, Y: -7 * Unit + 231, Z: 41 * Unit,
                    View: view, Heading: PlaneHeadings[i]}
                sample := engine.MapPlane(engine.NewPlaneView(camera, 96), p[2] * Unit, p[0], p[1])
                log(sample.U, sample.V, sample.StepU, sample.StepV, sample.Distance)
            }
        } else if tickIndex <= 164 {
            var columns [engine.MaxViewWidth]bits<32>
            for i, interval := range PlaneIntervals {
                columns[4 + i] = (bits<32>(interval[0]) << 16) | bits<32>(interval[1])
            }
            bounds := engine.ColumnSpan{First: 4, End: 15}
            if tickIndex == 162 {
                engine.MakePlaneSpans(SpanTrace{}, columns, bounds)
            } else {
                viewHeight := 96
                if tickIndex == 164 { viewHeight = 81 }
                view := engine.NewPlaneView(engine.Camera{Z: 41 * Unit, View: engine.NewViewProjection(128),
                    Heading: PlaneHeadings[tickIndex - 162]}, viewHeight)
                var angles [engine.MaxViewWidth]bits<32>
                if tickIndex == 164 { angles = engine.ViewColumnAngles(view.Camera.View) }
                cache := engine.NewPlaneSpanCache(view, angles, tickIndex == 164)
                for pass, height := range [6]int{41, 0, 82, 64, 0, 41} {
                    painter := CachedSpanTrace{View: view, Z: height * Unit, Pass: pass}
                    cache = engine.MakeProjectedPlaneSpans(painter, columns, bounds, painter.Z, cache)
                }
            }
        } else if tickIndex == 165 {
            for i, width := range [2]int{128, 320} {
                height := 96
                if i == 1 { height = 168 }
                view := engine.NewLowDetailProjection(width)
                log(view.Width, height, view.DetailShift, view.ClipAngle, engine.AngleForColumn(view, view.Width / 4),
                    engine.AngleForColumn(view, view.Width / 2), engine.AngleForColumn(view, view.Width - 1))
                camera := engine.Camera{X: 10 * Unit + 17, Y: -7 * Unit + 231, Z: 41 * Unit, View: view}
                scale := engine.ScaleWallSpan(camera, engine.WallDistance{Normal: 0x20000000, Distance: 48 * Unit + 321},
                    engine.ColumnSpan{First: view.Width / 8, End: 5 * view.Width / 8 + 1})
                log(scale.First, scale.Last, scale.Step)
                for j, heading := range [3]bits<32>{0, 0x4670baba, 0xd00705fd} {
                    camera.Heading = heading
                    row, column, z := 0, 0, 0
                    if j == 1 { row, column, z = height / 2 - 1, view.Width / 3, 48 * Unit }
                    if j == 2 { row, column, z = height - 1, view.Width - 1, 65 * Unit }
                    sample := engine.MapPlane(engine.NewPlaneView(camera, height), z, row, column)
                    log(sample.U, sample.V, sample.StepU, sample.StepV, sample.Distance)
                }
            }
            odd := engine.NewLowDetailProjection(127)
            log(odd.Width, odd.DetailShift)
        }
    }
}
`);
    const tiles = build(entry);
    assert.ok(tiles.some(tile => tile.payload?.toString().includes(" = __unpackTable(")));
    const sim = simulator(tiles);
    for (let i = 0; i < 163; i++) sim.step();
    const rows = JSON.parse(JSON.stringify(sim.logs));
    // Exact results of R_InitTextureMapping in Linux Doom 1.10, with the pinned
    // finetangent array. Hashes cover all 4096 forward angles and each inverse column.
    const expected = [
        [2, 537395200, 1876816324, 835778487], [95, 537395200, 3467784813, 1034367301],
        [160, 537395200, 1896554334, 3988702879], [320, 537395200, 190290168, 2836328479],
    ];
    let cursor = 0;
    for (const [width, clip, forward, reverse] of expected) {
        assert.deepEqual(rows[cursor++], [clip]);
        assert.equal(digest(rows.slice(cursor, cursor + 4096)), forward, `forward projection at ${width}`);
        cursor += 4096;
        assert.equal(digest(rows.slice(cursor, cursor + width + 1)), reverse, `inverse projection at ${width}`);
        cursor += width + 1;
    }
    // R_AddLine, R_CheckBBox, R_PointToDist, R_ScaleFromGlobalAngle,
    // and R_MapPlane results from the pinned C.
    assert.deepEqual(rows.slice(cursor), [
        [37, 60], [0, 96], [0, 0], [0, 0], [0, 0], [0, 48], [48, 96], [0, 0], [0, 96],
        [true, true, false, false, true],
        [4323475], [6378466], [13426493], [2477008], [92717], [19665901],
        [536870912, 3707503, 68042, 44258, -820], [0, 8385616, 32779, 32779, 0],
        [5511883, -4409211, 0, 75809, 4856555], [7973046, -6753327, 0, 114227, 7317721],
        [9260861, -26525238, 278016, 277632, 25165824], [-794679, -7804885, 129408, -20608, 8388608],
        [-7733226, 461722, 0, -130944, 8388604], [-1250496, 5166587, -52204, 21654, 3620341],
    ]);

    function readSpans(top) {
        const spans = [];
        for (let y = 0; y < 8; y++) {
            let first = -1;
            for (let x = 0; x < 16; x++) {
                const color = sim.tileAt({ x, y: top + y }).extra;
                assert.notEqual(color, 6, "cached projection matches the uncached span");
                if (color === 4) {
                    assert.ok(first >= 0, "each span starts with a red pixel");
                    continue;
                }
                if (first >= 0) spans.push([y, first, x]);
                first = color === 1 ? x : -1;
            }
            assert.equal(first, -1, "the sample plane ends before the edge of the display");
        }
        return spans;
    }
    // Half-open spans emitted by the pinned R_MakeSpans, sorted by row and start column.
    const spans = readSpans(0);
    assert.deepEqual(spans, [
        [0, 7, 9], [1, 5, 6], [1, 7, 9], [1, 13, 15], [2, 5, 9], [2, 12, 15],
        [3, 5, 9], [3, 12, 15], [4, 5, 6], [4, 7, 9], [4, 12, 15],
        [5, 7, 10], [5, 12, 15], [6, 9, 11], [6, 12, 14], [7, 9, 11],
    ]);

    for (let frame = 0; frame < 2; frame++) {
        sim.step();
        for (let pass = 0; pass < 6; pass++) {
            assert.deepEqual(readSpans(pass * 8), spans);
        }
    }

    sim.step();
    // R_InitTextureMapping, R_ScaleFromGlobalAngle and R_MapPlane compiled
    // from pinned C with the paired-column view setup in R_ExecuteSetViewSize.
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs.slice(rows.length))), [
        [64, 96, 1, 537395200, 317194240, 0, 3768582144], [108154, 46330, -1932],
        [4275681, -3170152, 0, 113080, 3620341], [-28557376, -54347847, 1811712, -289408, 58720256],
        [-430904, 3202321, -61149, 25352, 2119224],
        [160, 168, 1, 537395200, 317194240, 0, 3762290688], [270387, 115825, -1932],
        [5803982, -4701986, 0, 64342, 5148657], [-71507235, -136694189, 1809920, -288960, 146800640],
        [-939608, 4381301, -34767, 14394, 3013848], [127, 0],
    ]);

    const demo = simulator(build(path.join(port, "bsp-demo", "main.flt")));
    const middle = () => Array.from({ length: 96 }, (_, i) => demo.tileAt({x: i - 48, y: 0}).extra);
    demo.step();
    assert.deepEqual(middle(), [...Array(37).fill(2), ...Array(23).fill(5), ...Array(36).fill(2)]);
    demo.step(["0,39"]);
    demo.step();
    assert.deepEqual(middle(), Array(96).fill(5), "the full near wall occludes the far BSP child");
    assert.deepEqual(demo.logs, []);
    console.log("Doom projection, clipping, high and low detail wall and plane scaling, plane span cache, and interactive BSP checks passed.");
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
