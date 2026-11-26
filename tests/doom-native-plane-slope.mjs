// Compare the 160x120 plane-slope table with a physical read-only array.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "artifacts/doom-native-plane-slope");
const cli = join(root, "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
mkdirSync(output, { recursive: true });

const rows = 64;
const visibleRows = 60;
const bits = 24;
const columns = bits + 1;
const bankCount = 4;
const bankRows = rows / bankCount;
const bankStride = 2 * columns + 4;
const firstRowTick = columns + 1;
const scanTicks = firstRowTick + 2 * (bankRows - 1);
const firstReadTick = firstRowTick + 1;
const numerator = 80 * (1 << 17);
const words = Array.from({ length: rows }, (_, row) =>
    row < visibleRows ? Number(BigInt(numerator) / BigInt(2 * row + 1)) : 0);

const layout = [];
const place = (type, x, y, facing) => layout.push(`place ${type} at (${x}, ${y}) facing ${facing}`);
const banks = Array.from({ length: bankCount }, (_, bank) => {
    const left = bank * bankStride;
    const clock = { x: left - 1, y: 0 };
    const pins = [];
    for (let row = 0; row < bankRows; row++) {
        // The clock skips down every other row and launches one horizontal
        // pulse at each split. A stored one also splits into the rising bus.
        place("blueLSplitter", clock.x, 2 * row, "down flipped");
        for (let bit = 0; bit < columns; bit++) {
            const x = left + 2 * bit, y = 2 * row;
            const set = bit === bits || ((words[bank * bankRows + row] >>> bit) & 1) !== 0;
            place(set ? "blueLSplitter" : "blueArrow", x, y, set ? "right flipped" : "right");
            if (row > 0) place("blueArrow", x, y - 1, "up");
        }
    }
    for (let bit = 0; bit < columns; bit++) {
        const x = left + 2 * bit;
        const pad = { x, y: -1 - 2 * (bits - bit) };
        // The early horizontal columns take a longer return route. Every
        // output pin, including the separate valid lane, settles together.
        for (let y = -1; y > pad.y; y -= 2)
            place("blueArrow", x, y, "up");
        pins.push(pad);
        place("arrow", pad.x, pad.y, "up");
    }
    return { clock, pins };
});

function compile(name, suffix = "") {
    const entry = join(output, name + ".flt");
    const file = join(output, name + ".json");
    writeFileSync(entry, `map "${name}" {\n${layout.join("\n")}\n${suffix}\n}\n`);
    const result = spawnSync("dotnet", [cli, "build", entry, "-o", file],
        { cwd: root, encoding: "utf8", timeout: 30_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return decode(JSON.parse(readFileSync(file, "utf8")).data);
}

const physical = compile("Plane Slope Physical");
assert.equal(physical.length, layout.length, "all placed tiles survive encoding");
assert.ok(physical.every(tile => ![22, 23, 33].includes(tile.type)), "zero Script Blocks in the ROM");
const scene = simulator(physical);
const wordsFromArrows = Array.from(banks, () => []);
for (const { clock } of banks) scene.drive(clock, 1);
for (let tick = 1; tick <= scanTicks + 2; tick++) {
    scene.step();
    for (const [bank, { pins }] of banks.entries()) {
        if (!scene.value(pins[bits])) continue;
        const bankWords = wordsFromArrows[bank];
        assert.equal(tick, firstRowTick + 2 * bankWords.length, "row timing");
        bankWords.push(pins.slice(0, bits).reduce((value, pin, bit) => value | (scene.value(pin) << bit), 0));
    }
}
assert.deepEqual(wordsFromArrows.flat(), words, "all plane slopes and the unused addresses match");
console.log(`Physical plane slopes matched ${rows} addresses on ${physical.length} tiles in ${scanTicks} route ticks.`);

if (!process.argv.includes("--bench")) process.exit(0);

// Seed red-arrow pads so the game generates the proper pulse for each
// Blue L-Splitter. The pad adds one hop to the standalone ROM delay.
const pads = banks.map(({ clock }) => `place arrow at (${clock.x - 1}, ${clock.y}) facing right`).join("\n    ");
for (const native of [true, false]) {
    const name = `00 Plane Slope ${native ? "Arrows" : "Script"}`;
    const bridge = `
const expected = ${JSON.stringify(words)};
${native ? `const banks = ${JSON.stringify(banks)};` : ""}
let row = 0, started, errors = 0, ticks = 0;
always(() => {
    if (row === ${native ? bankRows : rows}) return;
    if (started === undefined) {
        if (!(world.getSignal(-4, -2) > 0)) return;
        started = Date.now();
        ${native ? `for (const { clock } of banks) world.setSignal(clock.x - 1, clock.y, 1); return;` : ""}
    }
    ticks++;
    ${native ? `
    if (ticks < ${firstReadTick} || (ticks - ${firstReadTick}) % 2 !== 0) return;
    for (const [bank, { pins }] of banks.entries()) {
        if (!(world.getSignal(pins[${bits}].x, pins[${bits}].y) > 0)) { errors++; continue; }
        let value = 0;
        for (let bit = 0; bit < ${bits}; bit++) {
            const { x, y } = pins[bit];
            if (world.getSignal(x, y) > 0) value |= 1 << bit;
        }
        if (value !== expected[bank * ${bankRows} + row]) errors++;
    }
    row++;
    ` : `
    for (; row < expected.length; row++) {
        const value = row < ${visibleRows} ? Math.floor(${numerator} / (2 * row + 1)) : 0;
        if (value !== expected[row]) errors++;
    }
    `}
    if (row !== ${native ? bankRows : rows}) return;
    const text = "${name} | " + (Date.now() - started) + " ms | " + errors +
        " mismatches / " + expected.length + " | " + ticks + " host ticks";
    if (typeof showText === "function") showText(text);
    log(text);
});
`;
    const tiles = compile(name, `
    ${pads}
    place key at (-5, -2) facing right with { key = 2 }
    place arrow at (-4, -2) facing up
    place scriptBlock at (-3, -3) with { code = ${JSON.stringify(bridge)} }`);
    const replay = simulator(tiles);
    for (let tick = 0; tick <= scanTicks + 3; tick++)
        replay.step([], new Map(), tick === 0 ? [2] : []);
    assert.equal(replay.logs.length, 1);
    assert.ok(replay.logs[0][0].endsWith(`0 mismatches / ${rows} | ${native ? scanTicks + 1 : 1} host ticks`), replay.logs[0][0]);
    console.log(`${name} matched ${rows} addresses in the simulator.`);
}
