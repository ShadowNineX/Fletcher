// The physical phase register emits rows without a host drive between samples.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { decode, destinations, keyOf, simulator } from "./logic-arrows-simulator.mjs";

const { values } = parseArgs({ options: { packets: { type: "string" } } });
const root = resolve(import.meta.dirname, "..");
const output = join(root, "artifacts/doom-native-wall-stream");
const cli = join(root, "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const phaseBits = 23;
const fractionalBits = 16;
const bitPitch = 8;
const settle = 200;
const layout = new Map();
const phasePads = [], stepPads = [], rowPins = [];

function place(type, x, y, facing = "") {
    const position = { x, y };
    const key = keyOf(position);
    assert.ok(!layout.has(key), "overlapping tiles at " + key);
    layout.set(key, `    place ${type} at (${x}, ${y})${facing ? " facing " + facing : ""}`);
    return position;
}

for (let bit = 0; bit < phaseBits; bit++) {
    const x = bit * bitPitch;
    // The AND tile is a majority gate with these three inputs.
    place("lSplitter", x - 1, 0, "right");
    place("and", x, 0, "right");
    if (bit < phaseBits - 1) for (let offset = 1; offset <= 6; offset++) place("arrow", x + offset, 0, "right");
    phasePads.push(place("arrow", x, -3, "down"));
    place("toggle", x, -2, "down");
    place(bit >= fractionalBits ? "lSplitter" : "arrow", x, -1, "down");
    if (bit >= fractionalBits) rowPins.push(place("arrow", x - 1, -1, "up"));
    stepPads.push(place("arrow", x, 3, "up"));
    place("toggle", x, 2, "up");
    place("lSplitter", x, 1, "up flipped");

    // Q XOR (Q XOR step XOR carry) is step XOR carry. Apply that
    // toggle request on the clock's edge. Blue jumps avoid both buses.
    place("xor", x - 1, 1, "down");
    place("and", x - 1, 2, "down");
    place("blueArrow", x - 1, 3, "right");
    place("arrow", x + 1, 3, "right");
    place("arrow", x + 2, 3, "up");
    place("arrow", x + 2, 2, "up");
    place("blueArrow", x + 2, 1, "up");
    place("arrow", x + 2, -1, "up");
    place("arrow", x + 2, -2, "left");
    place("arrow", x + 1, -2, "left");
    for (let y = 5; y >= 3; y--) place("arrow", x - 2, y, "up");
    place("arrow", x - 2, 2, "right");
}

// The loop carries one token. It drives each bit four ticks after the
// preceding one, while new carries take at least eight ticks per bit.
// This lets every bit sample its old carry before any new one arrives.
const left = -4, right = (phaseBits - 1) * bitPitch + 2, top = 6, bottom = 40;
const period = right - left + bottom - top;
const startPad = place("blueArrow", left - 2, top, "right");
const valid = place("arrow", left, top - 1, "up");
place("blueLSplitter", left, top, "right flipped");
for (let x = left + 2; x < right; x += 2) {
    const clockBranch = (x + 2) % bitPitch === 0;
    place(clockBranch ? "blueLSplitter" : "blueArrow", x, top, clockBranch ? "right flipped" : "right");
}
for (let y = top; y < bottom; y += 2) place("blueArrow", right, y, "down");
for (let x = right; x > left; x -= 2) place("blueArrow", x, bottom, "left");
for (let y = bottom; y > top; y -= 2) place("blueArrow", left, y, "up");

// Optional manual demo on the same map. These buttons seed phase zero
// and a step of 1.0, with no Script Block on either the board or its pads.
const stepButton = place("button", bitPitch * fractionalBits, 4, "up");
const startButton = place("button", left - 3, top, "right");
place("lamp", valid.x, valid.y - 1);
for (const pin of rowPins) place("lamp", pin.x, pin.y - 1);

mkdirSync(output, { recursive: true });
const entry = join(output, "main.flt");
const level = join(output, "board.json");
writeFileSync(entry, `map "Doom native wall stream" {\n${[...layout.values()].join("\n")}\n}\n`);
const built = spawnSync("dotnet", [cli, "build", entry, "-o", level], { cwd: root, encoding: "utf8", timeout: 30000 });
if (built.error) throw built.error;
assert.equal(built.status, 0, built.stderr || built.stdout);
const tiles = decode(JSON.parse(readFileSync(level, "utf8")).data);
assert.equal(tiles.length, layout.size);
assert.ok(tiles.every(tile => ![22, 23, 33].includes(tile.type)), "zero Script Blocks");

const inputs = new Map();
for (const tile of tiles) {
    for (const destination of destinations(tile)) {
        if (!layout.has(destination)) continue;
        if (!inputs.has(destination)) inputs.set(destination, []);
        inputs.get(destination).push(keyOf(tile));
    }
}
for (let bit = 0; bit < phaseBits; bit++) {
    const x = bit * bitPitch;
    assert.deepEqual(inputs.get(`${x},0`)?.sort(), [`${x},-1`, `${x},1`, `${x - 1},0`].sort(), "carry needs three isolated inputs");
    assert.deepEqual(inputs.get(`${x - 1},2`)?.sort(), [`${x - 2},2`, `${x - 1},1`].sort(), "commit needs delta and clock only");
}

function pulseWord(scene, pads, word) {
    for (const [bit, pad] of pads.entries()) {
        if ((word >>> bit) & 1) scene.drive(pad, 1);
    }
}

function verifyStream(phase, step, count, manual = false) {
    const scene = simulator(tiles);
    if (manual) scene.step([keyOf(stepButton)]);
    else {
        pulseWord(scene, phasePads, phase);
        pulseWord(scene, stepPads, step);
    }
    for (let tick = 0; tick < settle; tick++) {
        scene.step();
        assert.equal(scene.value(valid), 0, "no sample before start");
    }
    if (manual) scene.step([keyOf(startButton)]);
    else scene.drive(startPad, 1);
    let expectedPhase = BigInt(phase);
    const delta = BigInt(step);
    let samples = 0, previous = -1;
    // After the start pulse, no script or test drive can affect phase.
    for (let tick = 0; tick <= period * count && samples < count; tick++) {
        scene.step();
        if (!scene.value(valid)) continue;
        const firstSample = manual ? 2 : 1;
        assert.equal(tick, samples === 0 ? firstSample : previous + period, "one valid pulse per circuit traversal");
        const row = rowPins.reduce((sum, pin, bit) => sum | (scene.value(pin) << bit), 0);
        assert.equal(row, Number((expectedPhase >> 16n) & 127n), `phase ${phase}, step ${step}, sample ${samples}`);
        expectedPhase += delta;
        previous = tick;
        samples++;
    }
    assert.equal(samples, count);
}

const samples = [
    [0, 0, 20],
    [0x7fffff, 1, 26],
    [-1, -1, 20],
    [0, 0x10000, 40],
    [0x54a234, 0x156752, 30],
    [-0x80000000, 0x7fffffff, 20],
];
for (const [phase, step, count] of samples) verifyStream(phase, step, count);
verifyStream(0, 0x10000, 12, true);
console.log(`Physical wall stream matched ${samples.length} phase/step cases and the button demo on ${tiles.length} tiles. Cadence ${period} host ticks per row. Zero Script Blocks.`);

if (values.packets !== undefined) {
    const captured = JSON.parse(readFileSync(values.packets, "utf8"));
    assert.ok(Array.isArray(captured) && captured.length > 0 && captured.every(packet =>
        Array.isArray(packet) && packet.length === 2 && packet.every(value => (value | 0) === value && typeof value === "number")),
    "--packets requires signed int32 phase/step pairs");
    let streams = 0;
    for (let start = 0; start < captured.length;) {
        const [phase, step] = captured[start];
        let end = start + 1;
        while (end < captured.length && captured[end][1] === step &&
            captured[end][0] === ((captured[end - 1][0] + step) | 0)) end++;
        verifyStream(phase, step, end - start);
        streams++;
        start = end;
    }
    console.log(`Matched ${captured.length} captured wall phases in ${streams} physical streams.`);
}
console.log(`Map ${level}. For the demo, click step (${stepButton.x},${stepButton.y}) once, wait ${settle} host ticks, then click start (${startButton.x},${startButton.y}) once.`);
