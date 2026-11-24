// Generate two local Levels that time the same sustained XOR workload in the
// installed game. The simulator validates signals only. The game times ticks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.resolve(root, process.argv[2] ?? "artifacts/backend-bench");
const cli = path.join(root, "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const columns = 32, rows = 32, spacing = 4, samples = 240;
const startX = -columns * spacing / 2, startY = -rows * spacing / 2;
mkdirSync(output, { recursive: true });

function probe(scripted) {
    return `
onStart(() => {
    game.focusCamera(${startX - 4}, ${startY - 4}, ${-startX + 4}, ${-startY + 4});
});
always(() => {
    const tick = world.getTick();
    if (tick >= 5 && state.startTick === undefined) {
        state.startTick = tick;
        state.startMs = Date.now();
    }
    if (state.startTick === undefined || tick - state.startTick < ${samples}) return;
    const elapsed = Date.now() - state.startMs;
    let wrong = 0;
    for (let row = 0; row < ${rows}; row++) {
        for (let column = 0; column < ${columns}; column++) {
            const x = ${startX} + column * ${spacing}, y = ${startY} + row * ${spacing};
            const index = row * ${columns} + column;
            const want = Boolean(index & 1) !== Boolean(index & 2);
            // A forwarding arrow exposes the settled signal in both backends.
            // A scripted setSignal is queued and doesn't immediately read back.
            if ((world.getSignal(x + 1, y) > 0) !== want) wrong++;
        }
    }
    const message = "${scripted ? "Script Sources" : "Native arrows"}: " + ${samples} + " ticks in " + elapsed +
        " ms, " + wrong + " wrong outputs / ${rows * columns}";
    if (typeof showText === "function") showText(message);
    log(message);
    state.startTick = tick;
    state.startMs = Date.now();
});`;
}

const scriptXor = `const { x, y } = getPosition();
always(() => {
    const a = world.getSignal(x - 1, y) > 0;
    const b = world.getSignal(x, y + 1) > 0;
    world.setSignal(x, y, Number(a !== b));
});`;

function build(scripted) {
    const id = scripted ? "script" : "arrows";
    const source = path.join(output, `xor-${id}.flt`);
    const level = path.join(output, `xor-${id}.json`);
    const tiles = [];
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const x = startX + column * spacing, y = startY + row * spacing;
            const index = row * columns + column;
            tiles.push(`place ${index & 1 ? "not" : "arrow"} at (${x - 1}, ${y}) facing ${scripted ? "left" : "right"}`);
            tiles.push(`place ${index & 2 ? "not" : "arrow"} at (${x}, ${y + 1}) facing ${scripted ? "down" : "up"}`);
            tiles.push(scripted ? `place scriptSource at (${x}, ${y}) facing right with { code = ${JSON.stringify(scriptXor)} }`
                : `place xor at (${x}, ${y}) facing right`);
            tiles.push(`place arrow at (${x + 1}, ${y}) facing right`);
        }
    }
    tiles.push(`place scriptBlock at (${startX - 3}, ${startY - 3}) with { code = ${JSON.stringify(probe(scripted))} }`);
    writeFileSync(source, `map "Fletcher XOR ${scripted ? "Script" : "Arrows"}" {\n${tiles.join("\n")}\n}\n`);
    const result = spawnSync("dotnet", [cli, "build", source, "-o", level], { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const decoded = decode(JSON.parse(readFileSync(level, "utf8")).data);
    const model = simulator(decoded);
    for (let tick = 0; tick < 4; tick++) model.step();
    const values = Array.from({ length: rows * columns }, (_, index) => Number(model.value({
        x: startX + index % columns * spacing + 1, y: startY + Math.floor(index / columns) * spacing,
    })));
    console.log(`${level} (${decoded.length} tiles, ${values.length} settled XOR outputs)`);
    return values;
}

const native = build(false), scripted = build(true);
assert.deepEqual(native, scripted);
assert.equal(native.reduce((total, bit) => total + bit, 0), rows * columns / 2);
