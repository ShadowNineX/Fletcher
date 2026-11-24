// Build two asset-free Levels. Each times the same 124-bit audio output bus
// and checks the forwarding arrows and Doom-configured lamps on every sampled tick.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.resolve(root, process.argv[2] ?? "artifacts/output-bridge-bench");
const cli = path.join(root, "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const widths = [8, 12, ...Array(8).fill(13)];
const sampleTicks = 240;
const lanes = widths.flatMap((width, word) => Array.from({ length: width }, (_, bit) => ({
    word, bit, x: -24 + bit * 4, y: -9 + word * 2,
})));
assert.equal(lanes.length, 124);
mkdirSync(output, { recursive: true });

// Mix the tick into the high bits too, so every lane changes many times per run.
function packet(tick, word) {
    const mixed = Math.imul(tick + 1, 0x45d9f3b) ^ Math.imul(word + 1, 0x119de1f3);
    return (mixed ^ (mixed >>> 16)) >>> 0;
}

const publisher = `
${packet}
const widths = ${JSON.stringify(widths)};
always(() => {
    const t = world.getTick();
    const frame = { t, v: widths.map((width, word) => packet(t, word) & ((1 << width) - 1)) };
    if (t % 2 === 0) globalState.__fletcherEven = frame;
    else globalState.__fletcherOdd = frame;
});`;

const previousFrame = `const t = world.getTick() - 1;
    const frame = t < 0 ? null : t % 2 === 0 ? globalState.__fletcherEven : globalState.__fletcherOdd;`;

function laneDriver({ word, bit }) {
    return `const {x, y} = getPosition();
always(() => {
    ${previousFrame}
    const value = frame?.t === t ? frame.v[${word}] : 0;
    world.setSignal(x, y, (value >>> ${bit}) & 1);
});`;
}

const batchDriver = `always(() => {
    ${previousFrame}
    const values = frame?.t === t ? frame.v : [];
    ${lanes.map(({ x, y, word, bit }) =>
        `world.setSignal(${x}, ${y}, (values[${word}] >>> ${bit}) & 1);`).join("\n    ")}
});`;

function probe(label) {
    return `
${packet}
const widths = ${JSON.stringify(widths)};
onStart(() => game.focusCamera(-28, -13, 28, 13));
always(() => {
    if (state.result) return;
    const tick = world.getTick();
    if (state.start === undefined) state.start = tick + 4;
    if (tick < state.start) return;
    if (tick === state.start) {
        state.startMs = Date.now();
        state.samples = 0;
        state.errors = 0;
        return;
    }
    state.samples++;
    // The driver writes the preceding packet. The receiving lamp adds one hop.
    for (let word = 0; word < widths.length; word++) {
        const expected = packet(tick - 2, word);
        for (let bit = 0; bit < widths[word]; bit++) {
            const got = world.getSignal(-23 + bit * 4, -9 + word * 2) > 0;
            if (got !== Boolean((expected >>> bit) & 1)) {
                state.errors++;
                if (!state.first) state.first = " at tick " + tick + " word " + word + " bit " + bit;
            }
        }
    }
    const elapsedTicks = tick - state.start;
    if (elapsedTicks < ${sampleTicks}) return;
    const pass = !state.errors && state.samples === ${sampleTicks} && elapsedTicks === ${sampleTicks};
    state.result = (pass ? "PASS " : "FAIL ") + "${label}: " + elapsedTicks + " host ticks in " +
        (Date.now() - state.startMs) + " ms, " + state.samples + " samples, " + state.errors +
        " wrong / " + state.samples * ${lanes.length} + " bits" + (state.first || "");
    if (typeof showText === "function") showText(state.result);
    log(state.result);
});`;
}

function scriptTile(kind, x, y, code) {
    return `place ${kind} at (${x}, ${y}) facing right with { code = ${JSON.stringify(code)} }`;
}

function build(batched) {
    const id = batched ? "native-arrows" : "script-sources";
    const label = batched ? "Batched native arrows" : "Per-lane Script Sources";
    const tiles = [scriptTile("scriptBlock", -27, -12, publisher), scriptTile("scriptBlock", -27, 12, probe(label))];
    if (batched) tiles.push(scriptTile("scriptSource", -27, -11, batchDriver));
    for (const lane of lanes) {
        tiles.push(batched ? `place arrow at (${lane.x}, ${lane.y}) facing right` :
            scriptTile("scriptSource", lane.x, lane.y, laneDriver(lane)));
        tiles.push(`place lamp at (${lane.x + 1}, ${lane.y}) with { color = "green", bright = true }`);
    }
    const source = path.join(output, `output-bridge-${id}.flt`);
    const level = path.join(output, `output-bridge-${id}.json`);
    writeFileSync(source, `map "Fletcher Direct Bridge ${label}" {\n${tiles.join("\n")}\n}\n`);
    const result = spawnSync("dotnet", [cli, "build", source, "-o", level], { encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const decoded = decode(JSON.parse(readFileSync(level, "utf8")).data);
    assert.equal(decoded.filter(tile => tile.type === 22).length, batched ? 1 : lanes.length);
    assert.equal(decoded.filter(tile => tile.type === 1).length, batched ? lanes.length : 0);
    assert.equal(decoded.filter(tile => tile.type === 27 && tile.extra === 0x14).length, lanes.length);
    const highTicks = Array(lanes.length).fill(0);
    for (const controllerLast of [false, true]) {
        const model = simulator(decoded, controllerLast);
        for (let tick = 0; tick <= 4 + sampleTicks; tick++) {
            model.step();
            for (const [index, { x, y, word, bit }] of lanes.entries()) {
                const expected = tick < 2 ? 0 : (packet(tick - 2, word) >>> bit) & 1;
                assert.equal(model.value({ x: x + 1, y }), expected,
                    `${id}, controllerLast=${controllerLast}, tick ${tick}, word ${word}, bit ${bit}`);
                if (!controllerLast && tick > 4) highTicks[index] += expected;
            }
        }
        assert.equal(model.logs.length, 1);
        assert.match(model.logs[0][0], /^PASS .*240 host ticks in \d+ ms, 240 samples, 0 wrong \/ 29760 bits$/);
    }
    assert.ok(highTicks.every(count => count > 0 && count < sampleTicks), "every measured lane carried both values");
    console.log(`${level} — both simulator callback orders passed, 29,760 measured lamp signals each.`);
}

build(false);
build(true);
