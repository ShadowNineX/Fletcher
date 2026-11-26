// Compare the wall renderer's 16.16 row increment with a physical adder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const { values: options } = parseArgs({
    options: { bench: { type: "boolean" }, packets: { type: "string" } },
});
assert.ok(options.bench || options.packets === undefined, "--packets requires --bench");

const repo = resolve(import.meta.dirname, "..");
const cli = join(repo, "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const directory = join(repo, "artifacts/doom-native-wall-phase");
mkdirSync(directory, { recursive: true });
const source = join(directory, "main.flt");
const level = join(directory, "board.json");

const fractionalBits = 16;
const phaseBits = 23;
const lastBit = phaseBits - 1;
const carryTail = fractionalBits - 1;
const rowBitSpacing = 3;
const lastColumn = carryTail + (lastBit - carryTail) * rowBitSpacing;
const latency = lastColumn + 2;
const layout = [];
const inputs = [];
const outputs = [];
const place = (type, x, y, facing = "") =>
    layout.push(`place ${type} at (${x}, ${y})${facing ? " facing " + facing : ""}`);

for (let bit = 0; bit < phaseBits; bit++) {
    const emitsRowBit = bit >= fractionalBits;
    const x = emitsRowBit ? carryTail + (bit - carryTail) * rowBitSpacing : bit;
    // The carry advances through one majority gate per bit. The seven
    // row bits also branch to XOR tiles, where they need two relay sites.
    if (bit < lastBit) place("and", x, 0, "right");
    if (emitsRowBit) {
        place("arrow", x - 2, 0, "right");
        place("lSplitter", x - 1, 0, "right");
    }
    if (bit < lastBit) place("arrow", x, -1, "down");
    place(emitsRowBit && bit < lastBit ? "lSplitter" : "arrow", x, 1,
        bit === lastBit ? "left" : emitsRowBit ? "up flipped" : "up");
    inputs.push({
        bit,
        delay: x,
        a: bit < lastBit ? `${x},-1` : null,
        b: `${x},1`,
        aForSum: emitsRowBit ? `${x - 2},1` : null,
    });
    if (!emitsRowBit) continue;
    place("arrow", x - 2, 1, "right");
    place("xor", x - 1, 1, "down");
    const end = 2 + lastColumn - x;
    for (let y = 2; y < end; y++) place("arrow", x - 1, y, "down");
    // In the desktop host, world.getSignal can read this arrow. The same
    // test with a regular lamp at the output read back zero.
    place("arrow", x - 1, end, "down");
    outputs.push({ x: x - 1, y: end });
}

function compile(name, entry, output, extra = "") {
    writeFileSync(entry, `map "${name}" {
    ${layout.join("\n    ")}
    ${extra}
}
`);
    const compiled = spawnSync("dotnet", [cli, "build", entry, "-o", output],
        { cwd: repo, encoding: "utf8", timeout: 30000 });
    if (compiled.error) throw compiled.error;
    assert.equal(compiled.status, 0, compiled.stderr);
    return decode(JSON.parse(readFileSync(output, "utf8")).data);
}

const tiles = compile("Doom physical wall phase", source, level);
assert.ok(tiles.every(tile => ![22, 23, 33].includes(tile.type)), "the board contains zero Script Blocks");
const scene = simulator(tiles);
assert.ok(outputs.every(output => scene.tileAt(output)?.type === 1), "seven physical texture-row outputs");

const edges = [0, 1, -1, 0xffff, 0x10000, 0x7fffff, 0x800000, -0x80000000, 0x7fffffff, -65536];
const packets = edges.flatMap(phase => edges.map(step => [phase, step]));
let seed = 0x8172a1c5;
function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return seed;
}
for (let trial = 0; trial < 8192; trial++) packets.push([random(), random()]);

const forced = new Map();
const zero = [0, 0];
for (let tick = 0; tick < packets.length + latency; tick++) {
    // Like the light-board bridge, the feeder only aligns the input bits
    // with the native carry. The XOR tiles calculate the output row.
    for (const { bit, delay, a, b, aForSum } of inputs) {
        const [phase, step] = packets[tick - delay] ?? zero;
        if (a !== null) forced.set(a, (phase >>> bit) & 1);
        forced.set(b, (step >>> bit) & 1);
        if (aForSum !== null) forced.set(aForSum, (phase >>> bit) & 1);
    }
    scene.step([], forced);
    if (tick < latency) continue;
    const [phase, step] = packets[tick - latency];
    const row = outputs.reduce((value, lamp, bit) => value | (scene.value(lamp) << bit), 0);
    assert.equal(row, ((phase + step) >> fractionalBits) & 127, `phase packet ${tick - latency}`);
}
console.log(`Physical wall phase matched ${packets.length} inputs on ${tiles.length} tiles with ${latency} route ticks and zero Script Blocks.`);

if (options.bench) {
    const sampleCount = 2048;
    const samples = options.packets === undefined
        ? packets.slice(0, sampleCount)
        : JSON.parse(readFileSync(options.packets, "utf8"));
    assert.ok(Array.isArray(samples) && samples.length === sampleCount &&
        samples.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(value => (value | 0) === value)),
    "the benchmark requires 2,048 pairs of signed 32-bit integers");
    const expected = samples.map(([phase, step]) => Number(((BigInt(phase) + BigInt(step)) >> 16n) & 127n));
    for (const native of [true, false]) {
        const name = `Wall Phase ${native ? "Arrows" : "Script"}`;
        const folder = join(directory, native ? "arrows" : "script");
        mkdirSync(folder, { recursive: true });
        const bridge = `
const packets = ${JSON.stringify(samples)};
const results = ${JSON.stringify(expected)};
const latency = ${native ? latency : 0};
${native ? `
const inputs = ${JSON.stringify(inputs.map(({ bit, delay, a, b, aForSum }) =>
    ({ bit, delay, a: a?.split(",").map(Number), b: b.split(",").map(Number), aForSum: aForSum?.split(",").map(Number) })))};
const outputs = ${JSON.stringify(outputs)};
` : ""}
let tick = 0, start, wrong = 0, armed;
always(() => {
    if (tick === packets.length + latency) return;
    if (armed === undefined) {
        if (!(world.getSignal(-4, -2) > 0)) return;
        armed = world.getTick() + 24;
    }
    if (world.getTick() < armed) return;
    if (tick === 0) start = Date.now();
    ${native ? `
    for (const { bit, delay, a, b, aForSum } of inputs) {
        const packet = packets[tick - delay];
        if (packet === undefined) continue;
        const [phase, step] = packet;
        if (a) world.setSignal(a[0], a[1], (phase >>> bit) & 1);
        world.setSignal(b[0], b[1], (step >>> bit) & 1);
        if (aForSum) world.setSignal(aForSum[0], aForSum[1], (phase >>> bit) & 1);
    }
    let row = 0;
    if (tick >= latency) {
        for (let bit = 0; bit < outputs.length; bit++) {
            const { x, y } = outputs[bit];
            if (world.getSignal(x, y) > 0) row |= 1 << bit;
        }
    }` : `
    const [phase, step] = packets[tick];
    const row = ((phase + step) >> 16) & 127;`}
    if (tick >= latency && row !== results[tick - latency]) wrong++;
    if (++tick !== packets.length + latency) return;
    const message = "${name} | " + (Date.now() - start) + " ms | " +
        wrong + " mismatches / " + packets.length + " | " + tick + " host ticks";
    if (typeof showText === "function") showText(message);
    log(message);
});
`;
        const benchmark = compile(name, join(folder, "main.flt"), join(directory, `${name}.json`),
            `place key at (-5, -2) facing right with { key = 2 }
    place arrow at (-4, -2) facing up
    place scriptBlock at (-3, -3) with { code = ${JSON.stringify(bridge)} }`);
        const replay = simulator(benchmark);
        const ticks = samples.length + (native ? latency : 0);
        for (let tick = 0; tick < ticks + 27; tick++) replay.step([], new Map(), tick === 0 ? [2] : []);
        assert.equal(replay.logs.length, 1);
        assert.ok(replay.logs[0][0].endsWith(`0 mismatches / ${samples.length} | ${ticks} host ticks`), replay.logs[0][0]);
        console.log(`${name} matched ${samples.length} inputs in the simulator.`);
    }
}
