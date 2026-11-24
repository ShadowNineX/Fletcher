// Physical R_InitLightTables/R_ExecuteSetViewSize parity and renderer consumption.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const scratch = mkdtempSync(path.join(os.tmpdir(), "fletcher-light-board-"));
const boardY = 15;

function build(width) {
    const source = `package main
import "engine"
import "wad"
import "walls"
const Width = ${width}
const lightmap = readFile("colormap.bin")
const flat = readFile("flat.bin")
const samples = readFile("paired-texels.bin")

map "Doom physical light table fixture" {
    screen at (0, 0) size (4, 4) with { style = "solid", slice = true }
    expand DoomLightBoard(-Width / 2, ${boardY})
    place scriptBlock at (4, -3) with { code = "always(() => { if (!state.sent && globalState.doomLightRows) { state.sent = true; log('table', globalState.doomLightRows, globalState.doomWindowWallRows, globalState.doomPairedWindowWallRows); } });" }
    register ready bit = false
    tick {
        if currentTick() == 0 {
            var shade walls.WadShading = walls.WadShading{ColorMaps: wad.LumpRef{File: lightmap}, FixedRow: 5, Dithered: true}
            shade.Patterns.First[5], shade.Patterns.Second[5], shade.Patterns.Coverage[5] = color.Red, color.Blue, 4
            shade.Patterns.First[9], shade.Patterns.Second[9], shade.Patterns.Coverage[9] = color.Green, color.Yellow, 4
            span := walls.WadPlanePainter{Flat: wad.LumpRef{File: samples, Size: wad.FlatBytes, Valid: true}, Shade: shade}
            span.DrawPlaneSpan(0, 0, 4, engine.PlaneSample{StepU: engine.FracUnit / 2})
            log("paired", pixelIndexAt(0, 0), pixelIndexAt(1, 0), pixelIndexAt(2, 0), pixelIndexAt(3, 0))
            span.DrawPlaneSpan(0, 0, 4, engine.PlaneSample{V: engine.FracUnit, StepU: engine.FracUnit})
            log("equal-source", pixelIndexAt(0, 0), pixelIndexAt(1, 0), pixelIndexAt(2, 0), pixelIndexAt(3, 0))
        }
        table := sharedBytes("doomLightRows")
        if currentTick() == 0 || (len(table) != 0 && !ready) {
            view := engine.NewPlaneView(engine.Camera{Z: 3 * engine.FracUnit, View: engine.NewViewProjection(Width)}, 4)
            painter := walls.WadPlanePainter{View: view, Light: 128, CachedAngles: true,
                Flat: wad.LumpRef{File: flat}, Shade: walls.WadShading{ColorMaps: wad.LumpRef{File: lightmap}, LightRows: table}}
            if len(table) > 0 { painter.LightRowBase = engine.PlaneLightTableOffset + 8 * engine.MaxLightZ }
            painter.PlaneSpan(2, 0, 1)
            log("span", len(table), pixelIndexAt(0, 2))
            if len(table) > 0 {
                painter.Shade.WindowLightRows = sharedBytes("doomWindowWallRows")
                painter.Shade.WindowLightOffset = 2 * engine.PlaneLightTableOffset
                wallRows, base := painter.Shade.WallLightTable(32, 0)
                log("window-light", int(wallRows[base + 7]))
            }
            next ready = len(table) > 0
        }
    }
}
`;
    const entry = path.join(scratch, "main.flt");
    const output = path.join(scratch, "board.json");
    writeFileSync(entry, source);
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "-o", output], { encoding: "utf8" });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return decode(JSON.parse(readFileSync(output, "utf8")).data);
}

// Independent scalar equivalent of id Software's two initialization loops.
function expected(width) {
    const rows = [];
    for (const count of [48, 128]) {
        for (let band = 0; band < 16; band++) {
            const start = (15 - band) * 2 * 32 / 16;
            for (let j = 0; j < count; j++) {
                const level = count === 48
                    ? start - Math.trunc(j * 320 / (width * 2))
                    : start - Math.trunc(Math.trunc(160 / (j + 1)) / 2);
                rows.push(Math.max(0, Math.min(31, level)));
            }
        }
    }
    return rows;
}

function checkInputPads(tiles, width) {
    // A simultaneous pulse from every tile detects any incoming route to a
    // bridge-driven Arrow, including an accidental connection from a neighbor.
    const bare = tiles.map(tile => ({ ...tile, payload: undefined }));
    const sim = simulator(bare);
    for (const tile of bare) sim.drive(tile, 1);
    sim.step();
    const left = -Math.floor(width / 2);
    const boardArrows = bare.filter(tile => tile.type === 1 && tile.y >= boardY - 1 &&
        tile.y <= boardY + 7 && tile.x > left && tile.x <= left + 127);
    const joined = boardArrows.filter(tile => sim.value(tile)).map(tile => `${tile.x},${tile.y}`).sort();
    const expectedJoins = [];
    for (let lane = 0; lane < 8; lane++) {
        const x = left + 5 + 16 * lane;
        expectedJoins.push(`${x},${boardY}`);
        for (let bit = 0; bit < 5; bit++) expectedJoins.push(`${x - 2 + 3 * bit},${boardY + 6}`);
    }
    assert.deepEqual(joined, expectedJoins.sort());
    assert.equal(boardArrows.length - joined.length, 8 * 29);
}

function run(tiles, options = {}) {
    const sim = simulator(tiles, options.controllerLast);
    for (let t = 0; t < 56; t++) {
        if (t === options.jumpAt) sim.setTick(500);
        sim.step();
        if (t === 0) {
            const colors = Array.from({ length: 4 }, (_, x) => sim.tileAt({ x, y: 0 }).extra);
            assert.deepEqual(colors, [2, 1, 3, 4], "each repeated lit texel still uses both screen-space swatches");
        }
    }
    assert.deepEqual(sim.logs.find(([kind]) => kind === "paired"), ["paired", 5, 5, 9, 9]);
    assert.deepEqual(sim.logs.find(([kind]) => kind === "equal-source"), ["equal-source", 5, 5, 9, 9]);
    const tables = sim.logs.filter(([kind]) => kind === "table");
    const spans = sim.logs.filter(([kind]) => kind === "span");
    assert.equal(tables.length, 1);
    assert.equal(spans.length, 2);
    assert.equal(spans[0][1], 0);
    assert.equal(spans[1][1], 2816);
    return {
        rows: Array.from(tables[0][1]), windowRows: Array.from(tables[0][2]), pairedRows: Array.from(tables[0][3]),
        before: spans[0][2], after: spans[1][2],
        windowSample: sim.logs.find(([kind]) => kind === "window-light")?.[1],
    };
}

try {
    copyFileSync(path.join(port, "wad-bsp", "native-light-tables.flt"), path.join(scratch, "native-light-tables.flt"));
    writeFileSync(path.join(scratch, "flat.bin"), Buffer.alloc(4096));
    const pairedTexels = Buffer.alloc(4096);
    pairedTexels[1] = 4;
    pairedTexels.set([0, 0, 4, 4], 64);
    writeFileSync(path.join(scratch, "paired-texels.bin"), pairedTexels);
    writeFileSync(path.join(scratch, "colormap.bin"), Buffer.from(Array.from({ length: 8192 }, (_, i) => (i >> 8) + (i & 255))));
    for (const width of [128, 320, 127]) {
        const tiles = build(width);
        checkInputPads(tiles, width);
        const oracle = expected(width);
        const windowWidths = Array.from({ length: 7 }, (_, i) => {
            const nativeWidth = (i + 3) * 32;
            const left = (320 - nativeWidth) / 2;
            return Math.ceil((left + nativeWidth) * width / 320) - Math.ceil(left * width / 320);
        });
        const windowOracle = windowWidths.flatMap(w => expected(w).slice(0, 16 * 48));
        const pairedOracle = [...windowWidths, width].flatMap(w => expected(w & ~1).slice(0, 16 * 48));
        const windowSample = windowOracle[(2 * 16 + 2) * 48 + 7];
        for (const options of [{}, { controllerLast: true, jumpAt: 17 }]) {
            const result = run(tiles, options);
            assert.deepEqual(result.rows, oracle, `every ${width}-wide COLORMAP row`);
            assert.deepEqual(result.windowRows, windowOracle, `every narrow COLORMAP row on width ${width}`);
            assert.deepEqual(result.pairedRows, pairedOracle, `every paired COLORMAP row on width ${width}`);
            assert.equal(result.windowSample, windowSample, "the wall renderer selects the active width table");
            assert.equal(result.after, result.before, "the fallback and physical plane spans match");
            assert.equal(result.after & 1, 1, "fixture deliberately selects an odd COLORMAP");
        }
        // Disconnect the low result bit of each lane. The actual production
        // plane span must now paint with the adjacent even-numbered COLORMAP.
        const disconnected = new Set(Array.from({ length: 8 }, (_, lane) => -Math.floor(width / 2) + 3 + 16 * lane));
        const broken = tiles.map(tile => tile.type === 16 && tile.y === boardY + 7 && disconnected.has(tile.x)
            ? { ...tile, type: 25 } : tile);
        assert.equal(broken.filter((tile, i) => tile !== tiles[i]).length, 8);
        const damaged = run(broken);
        assert.equal(damaged.after, damaged.before - 1);
        assert.deepEqual(damaged.rows, oracle.map(row => row & ~1));
        assert.deepEqual(damaged.windowRows, windowOracle.map(row => row & ~1));
        assert.deepEqual(damaged.pairedRows, pairedOracle.map(row => row & ~1));
        assert.equal(damaged.windowSample, windowSample & ~1);
    }
    console.log("Physical Doom lighting passed high-detail and paired tables, pad isolation, restart, callback order, broken-gate wall and plane rows, and repeated indices with dithered swatches.");
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
