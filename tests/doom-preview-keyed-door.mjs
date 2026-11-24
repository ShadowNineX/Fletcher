// Exercise the preview's keyboard, pickup, collision, and line dispatch together.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "src", "Fletcher.Cli", "bin", "Debug", "net11.0", "fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-keyed-door-"));
const unit = 65536;
const use = [6]; // F
const forward = [23]; // W

function words(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, i) => bytes.writeUInt16LE(value & 65535, i * 2));
    return bytes;
}

function encodeWad(lumps) {
    const directory = 12 + lumps.reduce((length, [, bytes]) => length + bytes.length, 0);
    const out = Buffer.alloc(directory + lumps.length * 16);
    out.write("PWAD");
    out.writeInt32LE(lumps.length, 4);
    out.writeInt32LE(directory, 8);
    let offset = 12;
    for (const [i, [name, bytes]] of lumps.entries()) {
        const entry = directory + i * 16;
        out.writeInt32LE(offset, entry);
        out.writeInt32LE(bytes.length, entry + 4);
        out.write(name, entry + 8);
        bytes.copy(out, offset);
        offset += bytes.length;
    }
    return out;
}

function testMap(action) {
    const vertices = words([-128, -64, -128, 64, 0, 64, 0, -64, 256, 64, 256, -64]);
    const lines = words([
        2, 3, 4, action, 7, 0, 1,
        0, 1, 0, 0, 0, 0, 65535, 1, 2, 0, 0, 0, 0, 65535, 3, 0, 0, 0, 0, 0, 65535,
        2, 4, 0, 0, 0, 1, 65535, 4, 5, 0, 0, 0, 1, 65535, 5, 3, 0, 0, 0, 1, 65535,
    ]);
    const sides = Buffer.alloc(60);
    sides.writeUInt16LE(1, 58);
    const segs = words([
        0, 1, 0x4000, 1, 0, 0, 1, 2, 0, 2, 0, 0, 2, 3, 0xc000, 0, 0, 0, 3, 0, 0x8000, 3, 0, 0,
        3, 2, 0x4000, 0, 1, 0, 2, 4, 0, 4, 0, 0, 4, 5, 0xc000, 5, 0, 0, 5, 3, 0x8000, 6, 0, 0,
    ]);
    const nodes = words([0, -64, 0, 128, 64, -64, 0, 256, 64, -64, -128, 0, 0x8001, 0x8000]);
    const keyed = action === 26;
    const sectors = Buffer.alloc(52);
    sectors.writeInt16LE(7, 50);
    for (const offset of [0, 26]) {
        sectors.writeInt16LE(keyed && offset === 26 ? 0 : 128, offset + 2);
        sectors.write("FLOOR0_1", offset + 4);
        sectors.write("CEIL1_1", offset + 12);
        sectors.writeInt16LE(160, offset + 20);
    }
    const block = words([-128, -128, 4, 2, ...Array(8).fill(12), 0, 1, 2, 3, 4, 5, 6, -1]);
    const things = words([-50, 0, 0, 1, 7, ...(keyed ? [-9, 0, 0, 5, 7] : [])]);
    return [[action === 124 ? "MAP15" : "E1M1", Buffer.alloc(0)], ["THINGS", things], ["LINEDEFS", lines],
        ["SIDEDEFS", sides], ["VERTEXES", vertices], ["SEGS", segs], ["SSECTORS", words([4, 0, 4, 4])],
        ["NODES", nodes], ["SECTORS", sectors], ["REJECT", Buffer.alloc(1)], ["BLOCKMAP", block],
        ...(action === 124 ? [["MAP31", Buffer.alloc(0)]] : [])];
}

function previewSource() {
    const preview = path.join(scratch, "preview");
    mkdirSync(preview);
    const original = path.join(port, "wad-bsp");
    for (const name of readdirSync(original).filter(name => name.endsWith(".flt"))) {
        let source = readFileSync(path.join(original, name), "utf8");
        if (name === "main.flt") {
            const insertion = "                    next player = moved";
            assert.ok(source.includes(insertion));
            source = source.replace(insertion, `
                    log("door-tic", levelTime, moved.Body.X, frame.Contacts.Inventory.Cards[play.CardBlue],
                        level.SectorHeightsAt(1).Ceiling, used.Doors.Count)
                    if displayedMessage != "" { log("door-hud", displayedMessage) }
${insertion}`);
        }
        writeFileSync(path.join(preview, name), source);
    }
    return path.join(preview, "main.flt");
}

function buildPreview(entry, action) {
    const output = path.join(scratch, "preview.json");
    writeFileSync(path.join(scratch, "LEVEL.WAD"), encodeWad(testMap(action)));
    const built = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (built.error) throw built.error;
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    return simulator(decode(encoded), true);
}

function logs(sim, label) {
    return sim.logs.filter(row => row[0] === label);
}

function stepUntil(sim, keys, condition, description) {
    for (let host = 0; host < 220 && !condition(); host++) sim.step([], new Map(), keys);
    assert.ok(condition(), `${description}: ${JSON.stringify(sim.logs.slice(-6))}`);
}

try {
    const entry = previewSource();
    const sim = buildPreview(entry, 26);
    const row = () => logs(sim, "door-tic").at(-1);
    const denied = () => logs(sim, "Blue key required").length;
    stepUntil(sim, [], () => row(), "observe the initial player tic");
    assert.deepEqual(Array.from(row().slice(2), Number), [-50 * unit, 0, 0, 0]);
    stepUntil(sim, use, () => denied() === 1, "deny use without a key");
    assert.deepEqual(logs(sim, "door-hud").at(-1), ["door-hud", "BLUE KEY REQUIRED"],
        "the denial reaches the current HUD message on the same tic");
    const denialTic = row()[1];
    stepUntil(sim, use, () => row()[1] >= denialTic + 8, "hold the use button for eight more tics");
    assert.equal(denied(), 1, "held use must not repeat the denial");
    stepUntil(sim, forward, () => Number(row()[3]) === 1, "walk up to and pick up the blue card");
    assert.deepEqual(Array.from(row().slice(4), Number), [0, 0], "pickup leaves the door closed");
    stepUntil(sim, use, () => row()[4] >= 32 * unit, "unlock and raise the ceiling while holding use");
    assert.equal(Number(row()[5]), 1);
    assert.equal(denied(), 1);
    stepUntil(sim, forward, () => row()[2] > 16 * unit, "cross into the sector after opening");

    for (const [action, keys, message] of [[11, use, "Doom level exit requested"], [124, forward, "Doom secret level exit requested"]]) {
        const ending = buildPreview(entry, action);
        stepUntil(ending, [], () => logs(ending, "door-tic").length, "observe initial tic before the exit");
        stepUntil(ending, keys, () => logs(ending, message).length === 1, message);
        const lastTic = logs(ending, "door-tic").at(-1);
        for (let host = 0; host < 30; host++) ending.step([], new Map(), keys);
        assert.deepEqual(logs(ending, "door-tic").at(-1), lastTic, "preview stops once the exit is requested");
        assert.equal(logs(ending, message).length, 1);
    }
    console.log("WAD preview passed held-use denial, blue-card pickup, opening and traversal, and normal and secret exits.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-keyed-door-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
