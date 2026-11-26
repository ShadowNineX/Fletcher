// Compare the physical texture-row bounds check with the wall renderer.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const repo = resolve(import.meta.dirname, "..");
const cli = join(repo, "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const directory = join(repo, "artifacts/doom-native-wall-coverage");
mkdirSync(directory, { recursive: true });
const rowPads = Array.from({ length: 7 }, (_, lane) => ({ x: 0, y: 4 * lane }));
const heightPads = Array.from({ length: 8 }, (_, lane) => ({ x: 0, y: 2 + 4 * lane }));
const pads = [...rowPads, ...heightPads];

function compileBoard(folder, program) {
    mkdirSync(folder, { recursive: true });
    const source = join(folder, "main.flt");
    const level = join(folder, "board.json");
    writeFileSync(source, program);
    const compiled = spawnSync("dotnet", [cli, "build", source, "--explain", "-o", level],
        { cwd: repo, encoding: "utf8", timeout: 30000 });
    if (compiled.error) throw compiled.error;
    assert.equal(compiled.status, 0, compiled.stderr);
    return { tiles: decode(JSON.parse(readFileSync(level, "utf8")).data), report: compiled.stdout };
}

const routed = compileBoard(directory, `package main
func Covered(row bits<7>, height bits<8>) bit {
    var less bit
    for i := range 7 {
        less = (!row[i] && height[i]) || ((row[i] == height[i]) && less)
    }
    return height[7] || less
}
map "Doom native wall row coverage" {
    ${pads.map(({ x, y }) => `place arrow at (${x}, ${y}) facing right`).join("\n    ")}
    input row bits<7> at (0, 0) with { tap = true, tapPitch = 4 }
    input height bits<8> at (0, 2) with { tap = true, tapPitch = 4 }
    circuit { output covered bit = Covered(row, height) }
}
`);
const route = routed.report.match(/^covered\s+circuit\s+at \((-?\d+),\s*(-?\d+)\)\s+(\d+) route ticks/m);
assert.ok(route, "the compiler explains the native output latency");

// Each AND tile accepts the low bits' result, ~row and height. Two of
// those signals must be present, so one tile implements the borrow step.
// Feed each successive bit one tick later and preserve the packet order.
const compactRow = rowPads.map((_, x) => ({ x, y: -x - 2 }));
const compactHeight = heightPads.map((_, x) => ({ x, y: x + 2 }));
const compactLayout = [];
for (const { x, y } of compactRow) {
    compactLayout.push(`place and at (${x}, 0) facing right`, `place not at (${x}, -1) facing down`);
    for (let wire = y; wire <= -2; wire++) compactLayout.push(`place arrow at (${x}, ${wire}) facing down`);
}
for (const { x, y } of compactHeight) {
    for (let wire = y; wire >= 1; wire--) compactLayout.push(`place arrow at (${x}, ${wire}) facing up`);
}
compactLayout.push("place arrow at (7, 0) facing right", "place lamp at (8, 0)");
const compact = compileBoard(join(directory, "compact"), `map "Doom compact wall row coverage" {
    ${compactLayout.join("\n    ")}
}
`);

function verify(board, inputs, output, latency) {
    assert.ok(board.tiles.some(tile => tile.type === 16), "the comparator uses physical AND tiles");
    assert.ok(board.tiles.every(tile => ![22, 23, 33].includes(tile.type)), "the board contains zero Script Blocks");
    const scene = simulator(board.tiles);
    assert.equal(scene.tileAt(output)?.type, 27);
    const signals = new Map();
    const keys = inputs.map(({ x, y }) => `${x},${y}`);
    const cases = 1 << keys.length;
    // The odd multiplier permutes all inputs and switches them while other
    // packets are still in flight.
    const sample = ordinal => (ordinal * 15417) & (cases - 1);
    for (let tick = 0; tick < cases + latency; tick++) {
        const packet = tick < cases ? sample(tick) : 0;
        for (const [lane, key] of keys.entries()) signals.set(key, (packet >> lane) & 1);
        scene.step([], signals);
        if (tick < latency) continue;
        const expected = sample(tick - latency);
        const row = expected & 127, height = expected >> 7;
        assert.equal(scene.value(output), Number(row < height), `texture row ${row} at height ${height}`);
    }
    console.log(`Physical wall coverage matched ${cases} inputs on ${board.tiles.length} tiles with ${latency} route ticks and zero Script Blocks.`);
}

verify(routed, pads, { x: Number(route[1]), y: Number(route[2]) }, Number(route[3]));
verify(compact, [...compactRow, ...compactHeight], { x: 8, y: 0 }, 10);
