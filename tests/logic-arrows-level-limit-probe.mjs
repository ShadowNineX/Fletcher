// Generate matching v5 Levels at and above the desktop loader's expanded limit.
// This probe bypasses Fletcher's validation so the game decides what loads.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { decode } from "./logic-arrows-simulator.mjs";

const output = resolve(process.argv[2] ?? join(import.meta.dirname, "../artifacts/logic-arrows-level-limit"));
mkdirSync(output, { recursive: true });

const heartbeat = Buffer.from(`let step = 0;
const values = [];
always(() => {
    const sample = step >> 2;
    if (sample >= 4) return;
    if ((step & 3) === 3) values.push(world.getSignal(3, 3));
    world.setSignal(2, 3, sample & 1);
    world.setSignal(3, 2, (sample >> 1) & 1);
    world.setSignal(3, 4, (sample >> 1) & 1);
    if (++step === 16) showText("Host reached the board | arrow samples " + values.join(", "));
});`);

const word = value => Buffer.from([value & 255, value >> 8]);
const envelope = compressed => Buffer.concat([Buffer.from([5, 0, 1]), compressed]).toString("base64");
const board = Buffer.from([
    0, 0, 0, 0, 1,                         // Chunk (0, 0), two groups.
    1, 3, 0x23, 2, 0x32, 1, 0x33, 1, 0x43, 0, // Four red arrows.
    33, 0, 0,                             // One Script Block at (0, 0).
]);
const preview = envelope(deflateSync(Buffer.concat([word(1), board, Buffer.from([0])])));
const messageCount = 256;
const messageChunk = Buffer.from([1, 0, 0, 0, 0, 34, messageCount - 1]);
const messagePrefix = Buffer.from("LGS1\x01", "latin1");
const header = Buffer.concat([word(2), board, Buffer.from([24]), word(heartbeat.length), heartbeat, messageChunk]);
const payloadBudget = messageCount * 4 + header.length;
const boundary = 16 * 1024 * 1024;

const levels = [["00 Level Limit A", boundary], ["00 Level Limit B", boundary + 1]];
for (const [name, size] of levels) {
    // Valid inert message payloads grow the body without loading large scripts.
    const messageSize = Math.floor((size - payloadBudget) / messageCount);
    const remainder = (size - payloadBudget) % messageCount;
    const messages = Array.from({ length: messageCount }, (_, i) => {
        const length = messageSize + Number(i < remainder);
        return Buffer.concat([
            Buffer.from([i, 24]), word(length), messagePrefix,
            Buffer.alloc(length - messagePrefix.length, 88),
        ]);
    });
    const body = Buffer.concat([header, ...messages]);
    assert.equal(body.length, size);
    const compressed = deflateSync(body);
    const data = envelope(compressed);
    assert.equal(decode(data).length, messageCount + 5);
    writeFileSync(join(output, name + ".json"), JSON.stringify({
        name, version: 3, map_type: "Level", preview_data: preview, tags: ["level"],
        _preview_header_end: { version: 1, fields: 395 }, data,
        level_settings: { show_progress: false, all_arrows: true, predict_signals: false },
    }));
    console.log(`${name}: ${body.length} expanded bytes, ${compressed.length} compressed bytes`);
}
