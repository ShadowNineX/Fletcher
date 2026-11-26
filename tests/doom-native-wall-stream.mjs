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
const bitDelay = 5;
const settle = 200;
const layout = new Map();
const phasePads = [], stepPads = [], rowPins = [];

function place(type, x, y, facing = "", board = layout) {
    const position = { x, y };
    const key = keyOf(position);
    assert.ok(!board.has(key), "overlapping tiles at " + key);
    board.set(key, { type, x, y, facing });
    return position;
}

for (let bit = 0; bit < phaseBits; bit++) {
    const x = bit * bitPitch;
    // The AND tile is a majority gate with these three inputs.
    place("lSplitter", x - 1, 0, "right");
    place("and", x, 0, "right");
    if (bit < phaseBits - 1) {
        for (const offset of [1, 3, 5]) place("blueArrow", x + offset, 0, "right");
    }
    phasePads.push(place("arrow", x, -3, "down"));
    place("toggle", x, -2, "down");
    place(bit >= fractionalBits ? "lSplitter" : "arrow", x, -1, "down");
    if (bit >= fractionalBits) {
        const alignment = bitDelay * (phaseBits - 1 - bit);
        for (let y = -1; y > -1 - alignment; y--) place("arrow", x - 1, y, "up");
        rowPins.push(place("arrow", x - 1, -1 - alignment, "up"));
    }
    stepPads.push(place("arrow", x, 3, "up"));
    place("toggle", x, 2, "up");
    place("lSplitter", x, 1, "up flipped");

    // Q XOR (Q XOR step XOR carry) is step XOR carry. Clock that toggle
    // request from below and route it back to Q over both buses.
    place("xor", x - 1, 1, "down");
    place("and", x - 1, 2, "left");
    place("blueArrow", x - 2, 2, "up");
    place("blueArrow", x - 2, 0, "up");
    place("blueArrow", x - 2, -2, "right");
    place("arrow", x - 2, 5, "right");
    for (let y = 5; y >= 3; y--) place("arrow", x - 1, y, "up");
}

// A short clock loop feeds a one-way bus. Both the clock and the carry
// advance one bit per five ticks, so a write can only affect a later cycle.
const clockX = -4, top = 6;
const loopRight = -6, loopSize = 4;
const loopLeft = loopRight - loopSize, bottom = top + loopSize;
const period = 2 * loopSize;
const startPad = place("blueArrow", loopLeft - 2, top, "right");
for (let x = loopLeft; x < loopRight; x += 2) place("blueArrow", x, top, "right");
place("blueLSplitter", loopRight, top, "down flipped");
for (let y = top + 2; y < bottom; y += 2) place("blueArrow", loopRight, y, "down");
for (let x = loopRight; x > loopLeft; x -= 2) place("blueArrow", x, bottom, "left");
for (let y = bottom; y > top; y -= 2) place("blueArrow", loopLeft, y, "up");
place("arrow", clockX - 1, top, "right");
place("blueLSplitter", clockX, top, "right flipped");
for (let bit = 0; bit < phaseBits; bit++) {
    const branch = bit * bitPitch - 2;
    place("blueLSplitter", branch, top, "right flipped");
    if (bit === phaseBits - 1) break;
    for (const offset of [2, 4]) place("blueArrow", branch + offset, top, "right");
    for (const offset of [6, 7]) place("arrow", branch + offset, top, "right");
}

// From the clock bus entrance to the last row pin there is one hop to
// the first branch, five to the write gate, four to the latch, and two
// to the pin. Sample the previous word two ticks before that change.
const validDelay = 1 + bitDelay * (phaseBits - 1) + 5 + 4 + 2 - 2;
for (let y = top - 1; y > top - validDelay; y--) place("arrow", clockX, y, "up");
const valid = place("arrow", clockX, top - validDelay, "up");
const firstSampleTick = loopSize / 2 + 2 + validDelay;

// Optional manual demo on the same map. These buttons seed phase zero
// and a step of 1.0, with no Script Block on either the board or its pads.
const stepButton = place("button", bitPitch * fractionalBits, 4, "up");
const startButton = place("button", startPad.x - 1, top, "right");
place("lamp", valid.x, valid.y - 1);
for (const pin of rowPins) place("lamp", pin.x, pin.y - 1);

mkdirSync(output, { recursive: true });
function compile(name, board, entry, level) {
    const statements = [...board.values()].map(({ type, x, y, facing }) =>
        `    place ${type} at (${x}, ${y})${facing ? " facing " + facing : ""}`);
    writeFileSync(entry, `map "${name}" {\n${statements.join("\n")}\n}\n`);
    const built = spawnSync("dotnet", [cli, "build", entry, "-o", level], { cwd: root, encoding: "utf8", timeout: 30000 });
    if (built.error) throw built.error;
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const tiles = decode(JSON.parse(readFileSync(level, "utf8")).data);
    assert.equal(tiles.length, board.size);
    assert.ok(tiles.every(tile => ![22, 23, 33].includes(tile.type)), "zero Script Blocks");
    return tiles;
}
const level = join(output, "board.json");
const tiles = compile("Doom native wall stream", layout, join(output, "main.flt"), level);

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
    assert.deepEqual(inputs.get(`${x - 1},2`)?.sort(), [`${x - 1},3`, `${x - 1},1`].sort(), "commit needs delta and clock only");
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
    const firstSample = firstSampleTick + Number(manual);
    // After the start pulse, no script or test drive can affect phase.
    for (let tick = 0; tick <= firstSample + period * count && samples < count; tick++) {
        scene.step();
        if (!scene.value(valid)) continue;
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
    [0, 0x10000, 144],
    [0x54a234, 0x156752, 30],
    [-0x80000000, 0x7fffffff, 20],
];
for (const [phase, step, count] of samples) verifyStream(phase, step, count);
verifyStream(0, 0x10000, 12, true);
console.log(`Physical wall stream matched ${samples.length} phase/step cases and the button demo on ${tiles.length} tiles. First sample after ${firstSampleTick + 1} ticks from the start pad, then one row every ${period} ticks. Zero Script Blocks.`);

// Each lane produces every eighth row. The blue-arrow launch bus delays the
// next lane by 97 ticks, so its cadence is one tick later modulo eight.
const lanes = period;
const lanePitch = 194, laneDelay = lanePitch / 2;
assert.equal(laneDelay % period, 1, "lane clocks must cover successive phases");
const parallel = new Map();
for (let lane = 0; lane < lanes; lane++)
    for (const { type, x, y, facing } of layout.values())
        place(type, x + lane * lanePitch, y, facing, parallel);

const busY = bottom + 2, lastStartX = startPad.x + (lanes - 1) * lanePitch;
const launch = place("button", startPad.x - 1, busY, "right", parallel);
for (let x = startPad.x; x <= lastStartX; x += 2) {
    const tap = (x - startPad.x) % lanePitch === 0;
    place(tap ? "blueLSplitter" : "blueArrow", x, busY, tap ? "right flipped" : "right", parallel);
    if (tap) for (let y = busY - 1; y > top; y--) place("arrow", x, y, "up", parallel);
}

const parallelLevel = join(output, "interleaved.json");
const parallelTiles = compile("Doom interleaved wall stream", parallel, join(output, "interleaved.flt"), parallelLevel);
const parallelScene = simulator(parallelTiles);
const phase = 0x74ae35, step = -0x01954b;
const lanePins = [];
for (let lane = 0; lane < lanes; lane++) {
    const dx = lane * lanePitch;
    const shift = ({ x, y }) => ({ x: x + dx, y });
    pulseWord(parallelScene, phasePads.map(shift), phase + lane * laneDelay * step);
    pulseWord(parallelScene, stepPads.map(shift), step * lanes);
    lanePins.push({ valid: shift(valid), row: rowPins.map(shift) });
}
for (let tick = 0; tick < settle; tick++) parallelScene.step();
parallelScene.step([keyOf(launch)]);
const firstLane = busY - top + 1 + firstSampleTick;
const steadyStart = firstLane + (lanes - 1) * laneDelay;
let alignedRows = 0;
for (let tick = 0; tick < steadyStart + 120; tick++) {
    parallelScene.step();
    const active = lanePins.filter(pins => parallelScene.value(pins.valid));
    if (tick < steadyStart) continue;
    assert.equal(active.length, 1, "each steady tick has one valid lane");
    const actual = active[0].row.reduce((sum, pin, bit) => sum | (parallelScene.value(pin) << bit), 0);
    const expected = ((phase + (tick - firstLane) * step) >> 16) & 127;
    assert.equal(actual, expected, "interleaved row at tick " + tick);
    alignedRows++;
}
assert.equal(alignedRows, 120);
console.log(`Eight physical lanes matched ${alignedRows} consecutive rows at one row per host tick after the launch bus filled. ${parallelTiles.length} tiles and zero Script Blocks.`);

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
