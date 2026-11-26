// Read the movement table from physical tiles in the compiled campaign.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const { values } = parseArgs({ options: { map: { type: "string" } } });
assert.ok(values.map, "Pass --map PATH to a compiled Doom campaign");
const campaign = decode(JSON.parse(readFileSync(values.map, "utf8")).data);
const bridge = campaign.find(tile => tile.type === 33 && tile.payload?.includes("doomKeyboardDeltas = results"));
assert.ok(bridge, "the campaign includes the native command collector");
const inputX = bridge.x + 3;
const circuit = campaign.filter(tile => tile.x >= inputX && tile.y >= bridge.y);
assert.ok(circuit.some(tile => tile.type === 17), "the command board has physical XOR gates");
assert.ok(circuit.every(tile => ![22, 33].includes(tile.type)), "the command path contains physical gates and wires");
const lamps = circuit.filter(tile => tile.type === 27).sort((left, right) => left.y - right.y || left.x - right.x);
assert.equal(lamps.length, 17, "both boards have data lanes and a valid bit");
const buses = [lamps.slice(0, 8), lamps.slice(8)];
assert.ok(buses[0][0].y < buses[1][0].y, "the buses occupy separate rows");
for (const bus of buses)
    assert.ok(bus.every((lamp, lane) => lamp.y === bus[0].y && lamp.x === bus[0].x + 2 * lane),
        "the output bus has uniform spacing");

const observer = {
    x: bridge.x - 1, y: bridge.y, type: 33, rotation: 0, flip: false, extra: 0,
    payload: Buffer.from(`always(() => {
        if (!state.reported && globalState.doomKeyboardDeltas) {
            state.reported = true;
            log("test-native-command", globalState.doomKeyboardDeltas, world.getTick());
        }
    });`),
};

function capture(tiles, rewind = false) {
    const scene = simulator([bridge, ...tiles, observer], true);
    for (let host = 0; host < 1450; host++) {
        if (rewind && host === 128) scene.setTick(0);
        scene.step();
        const record = scene.logs.find(row => row[0] === "test-native-command");
        if (record) return { table: Buffer.from(record[1]), ticks: record[2] };
    }
    assert.fail("the physical board never published its movement table");
}

function expected(mask, forwardRun = (mask >> 6) & 1, sideRun = (mask >> 6) & 1) {
    const key = index => (mask >> index) & 1;
    const strafe = key(7);
    const turning = key(2) - key(3);
    const forward = (key(0) - key(1)) * (forwardRun ? 50 : 25);
    const side = (key(5) - key(4) - strafe * turning) * (sideRun ? 40 : 24);
    const turn = strafe ? 0 : turning * (sideRun ? 4 : 2);
    return (forward & 0x7f) | (side & 0xff) << 7 | (turn & 15) << 15;
}

const intact = capture(circuit);
assert.equal(intact.table.length, 256 * 3);
for (let mask = 0; mask < 256; mask++) {
    assert.equal(intact.table.readUIntLE(mask * 3, 3), expected(mask), `native movement mask ${mask}`);
}
assert.deepEqual(capture(circuit, true).table, intact.table, "a host tick discontinuity flushes the incomplete native run");
for (const [x, y, forward] of [[inputX, bridge.y + 4, true], [inputX + 100, bridge.y + 8, false]]) {
    const pad = circuit.find(tile => tile.x === x && tile.y === y);
    assert.equal(pad?.type, 1, "the Run pad is a physical arrow");
    const disconnected = capture(circuit.map(tile => tile === pad ? { ...tile, type: 25, extra: 7 } : tile));
    for (let mask = 0; mask < 256; mask++) {
        const run = (mask >> 6) & 1;
        assert.equal(disconnected.table.readUIntLE(mask * 3, 3), expected(mask, forward ? 0 : run, forward ? run : 0),
            `disconnected ${forward ? "forward" : "side and turn"} Run lane, mask ${mask}`);
    }
}
console.log(`Native command boards matched 256 movement rows in ${intact.ticks} host ticks on ${circuit.length} physical tiles. Rewind and both Run-lane disconnections passed.`);
