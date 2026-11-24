// Compare native XOR gates with one Script Block driving the same output sites.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.resolve(root, process.argv[2] ?? "artifacts/active-backend-bench");
const cli = path.join(root, "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const columns = 32, rows = 16, pitch = 5;
const left = -columns * pitch / 2, top = -rows * pitch / 2;
const warmup = 32, timed = 480, verify = 32;
mkdirSync(output, { recursive: true });

function controller(batched) {
    // Drive the same pads in both maps. The holding arrows isolate the
    // sampled inputs from callback order and any immediate setSignal writes.
    return `
onStart(() => game.focusCamera(${left - 5}, ${top - 4}, ${-left + 5}, ${-top + 4}));
always(() => {
    const host = world.getTick();
    if (state.result) return;
    if (state.armed === undefined) {
        if (!(world.getSignal(${left - 2}, ${top - 2}) > 0)) return;
        state.armed = host;
        state.checked = 0;
        state.errors = 0;
    }
    const tick = host - state.armed;
    if (tick === ${warmup}) state.startMs = Date.now();
    if (tick === ${warmup + timed}) state.elapsed = Date.now() - state.startMs;
    const phase = tick >> 3;
    const sample = (tick & 7) === 7 && (tick < ${warmup} || tick >= ${warmup + timed});
    for (let row = 0; row < ${rows}; row++) {
        const y = ${top} + ${pitch} * row;
        for (let col = 0; col < ${columns}; col++) {
            const x = ${left} + ${pitch} * col;
            const i = row * ${columns} + col;
            const a = (phase ^ i) & 1;
            const b = ((phase >> 1) ^ (i >> 1)) & 1;
            world.setSignal(x - 2, y, a);
            world.setSignal(x, y + 2, b);
            ${batched ? `const actualA = world.getSignal(x - 1, y) > 0;
            const actualB = world.getSignal(x, y + 1) > 0;
            world.setSignal(x, y, Number(actualA !== actualB));` : ""}
            if (sample) {
                state.checked++;
                if (Number(world.getSignal(x + 1, y) > 0) !== (a ^ b)) state.errors++;
            }
        }
    }
    if (tick === ${warmup + timed + verify - 1}) {
        state.result = "XOR ${batched ? "Batched Script" : "Native Arrows"} | ${rows * columns} lanes | ${timed} ticks | " +
            state.elapsed + " ms | " + state.errors + " mismatches / " + state.checked;
        if (typeof showText === "function") showText(state.result);
        log(state.result);
    }
});`;
}

function build(batched) {
    const kind = batched ? "batched" : "arrows";
    const label = batched ? "Batched Script" : "Native Arrows";
    const entry = path.join(output, `active-xor-${kind}.flt`);
    const level = path.join(output, `active-xor-${kind}.json`);
    const tiles = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < columns; col++) {
            const x = left + pitch * col, y = top + pitch * row;
            tiles.push(
                `place arrow at (${x - 2}, ${y}) facing right`,
                `place arrow at (${x - 1}, ${y}) facing ${batched ? "up" : "right"}`,
                `place arrow at (${x}, ${y + 2}) facing up`,
                `place arrow at (${x}, ${y + 1}) facing ${batched ? "right" : "up"}`,
                `place ${batched ? "arrow" : "xor"} at (${x}, ${y}) facing right`,
                `place arrow at (${x + 1}, ${y}) facing right`,
            );
        }
    }
    tiles.push(
        `place key at (${left - 3}, ${top - 2}) facing right with { key = 2 }`,
        `place arrow at (${left - 2}, ${top - 2}) facing up`,
        `place scriptBlock at (${left - 4}, ${top - 3}) with { code = ${JSON.stringify(controller(batched))} }`,
    );
    writeFileSync(entry, `map "Active XOR ${label}" {\n${tiles.join("\n")}\n}\n`);
    const compile = spawnSync("dotnet", [cli, "build", entry, "-o", level], { cwd: root, encoding: "utf8", timeout: 30000 });
    if (compile.error) throw compile.error;
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const bytes = readFileSync(level);
    const encoded = decode(JSON.parse(bytes).data);
    const board = simulator(encoded);
    board.step();
    for (let i = 0; i < warmup + timed + verify; i++) board.step([], new Map(), i === 0 ? [2] : []);
    const expected = `0 mismatches / ${rows * columns * (warmup + verify) / 8}`;
    assert.equal(board.logs.length, 1);
    assert.ok(board.logs[0][0].endsWith(expected), board.logs[0][0]);
    console.log(`${level} (${encoded.length} tiles; ${expected}) ${createHash("sha256").update(bytes).digest("hex")}`);
}

build(false);
build(true);
