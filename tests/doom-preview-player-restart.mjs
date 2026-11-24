// Exercise a complete player death and same-level restart in the WAD preview.
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
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-player-restart-"));
const unit = 65536;

function words(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => bytes.writeUInt16LE(value & 65535, index * 2));
    return bytes;
}

function wad(lumps) {
    const directory = 12 + lumps.reduce((length, [, bytes]) => length + bytes.length, 0);
    const result = Buffer.alloc(directory + lumps.length * 16);
    result.write("PWAD");
    result.writeInt32LE(lumps.length, 4);
    result.writeInt32LE(directory, 8);
    let offset = 12;
    for (const [index, [name, bytes]] of lumps.entries()) {
        const entry = directory + index * 16;
        result.writeInt32LE(offset, entry);
        result.writeInt32LE(bytes.length, entry + 4);
        result.write(name, entry + 8);
        bytes.copy(result, offset);
        offset += bytes.length;
    }
    return result;
}

function restartMap() {
    const vertices = words([-128, -64, -128, 64, 0, 64, 0, -64, 256, 64, 256, -64]);
    const lines = words([
        // The exit is within use range of the start, so a stale held command is observable.
        2, 3, 4, 11, 0, 0, 1,
        0, 1, 0, 0, 0, 0, 65535, 1, 2, 0, 0, 0, 0, 65535, 3, 0, 0, 0, 0, 0, 65535,
        2, 4, 0, 0, 0, 1, 65535, 4, 5, 0, 0, 0, 1, 65535, 5, 3, 0, 0, 0, 1, 65535,
    ]);
    const sides = Buffer.alloc(60);
    sides.writeUInt16LE(1, 58);
    const segs = words([
        0, 1, 0x4000, 1, 0, 0, 1, 2, 0, 2, 0, 0, 2, 3, 0xc000, 0, 0, 0, 3, 0, 0x8000, 3, 0, 0,
        3, 2, 0x4000, 0, 1, 0, 2, 4, 0, 4, 0, 0, 4, 5, 0xc000, 5, 0, 0, 5, 3, 0x8000, 6, 0, 0,
    ]);
    const sectors = Buffer.alloc(52);
    for (const offset of [0, 26]) {
        sectors.writeInt16LE(128, offset + 2);
        sectors.write("FLOOR0_1", offset + 4);
        sectors.write("CEIL1_1", offset + 12);
        sectors.writeInt16LE(160, offset + 20);
    }
    sectors.writeInt16LE(16, 26 + 22);
    const block = words([-128, -128, 4, 2, ...Array(8).fill(12), 0, 1, 2, 3, 4, 5, 6, -1]);
    // DoomEd 5 is the blue card. It is in the start room, out of touch range.
    const things = words([-50, 0, 0, 1, 7, -9, 0, 0, 5, 7]);
    return [["E1M1", Buffer.alloc(0)], ["THINGS", things], ["LINEDEFS", lines], ["SIDEDEFS", sides],
        ["VERTEXES", vertices], ["SEGS", segs], ["SSECTORS", words([4, 0, 4, 4])],
        ["NODES", words([0, -64, 0, 128, 64, -64, 0, 256, 64, -64, -128, 0, 0x8001, 0x8000])],
        ["SECTORS", sectors], ["REJECT", Buffer.alloc(1)], ["BLOCKMAP", block]];
}

function previewSource() {
    const preview = path.join(scratch, "preview");
    mkdirSync(preview);
    for (const name of readdirSync(path.join(port, "wad-bsp")).filter(name => name.endsWith(".flt"))) {
        let source = readFileSync(path.join(port, "wad-bsp", name), "utf8");
        if (name === "main.flt") {
            const insertion = "                    next player = moved";
            assert.ok(source.includes(insertion));
            source = source.replace(insertion, `
                    log("restart-tic", gameTime, levelTime, moved.Body.X, moved.ViewHeight,
                        frame.Contacts.Inventory.Health, frame.Contacts.Inventory.Ammo[play.AmmoClip],
                        frame.Contacts.Inventory.Cards[play.CardBlue], frame.Contacts.Inventory.Dead,
                        actorFrame.Actors.ActorAt(actorFrame.Actors.PlayerActors[0] - 1).State,
                        actorFrame.Actors.ActorAt(actorFrame.Actors.PlayerActors[0] - 1).Tics,
                        lighting.Random.GameplayIndex, displayedMessage)
${insertion}`);
        }
        writeFileSync(path.join(preview, name), source);
    }
    return path.join(preview, "main.flt");
}

function build(entry) {
    const output = path.join(scratch, "restart.json");
    writeFileSync(path.join(scratch, "LEVEL.WAD"), wad(restartMap()));
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    return simulator(decode(encoded), true);
}

function rows(sim) {
    return sim.logs.filter(row => row[0] === "restart-tic").map(([, game, level, x, view, health, clip, blue, dead, state, tics, rng, message]) =>
        ({ game: Number(game), level: Number(level), x: Number(x), view: Number(view), health: Number(health),
            clip: Number(clip), blue: Number(blue), dead: Boolean(dead), state: Number(state), tics: Number(tics), rng: Number(rng), message }));
}

function stepUntil(sim, keys, condition, message) {
    for (let host = 0; host < 1700 && !condition(); host++) sim.step([], new Map(), keys);
    assert.ok(condition(), `${message}: ${JSON.stringify(sim.logs.slice(-10))}`);
}

try {
    const sim = build(previewSource());
    stepUntil(sim, [6], () => rows(sim).length > 0, "render the starting room while F is held");
    const first = rows(sim).at(-1);
    assert.deepEqual([first.game, first.level, first.x, first.health, first.clip, first.blue, first.dead],
        [0, 0, -50 * unit, 100, 50, 0, false]);
    assert.ok(!sim.logs.some(row => row[0] === "Doom level exit requested"), "a key held during startup cannot activate the exit");

    stepUntil(sim, [18], () => rows(sim).at(-1).clip < 50, "spend pistol ammunition before restarting");
    stepUntil(sim, [23], () => rows(sim).at(-1).blue === 1, "pick up the starting blue card");
    assert.equal(rows(sim).at(-1).message, "BLUE KEYCARD COLLECTED", "the real pickup reaches the HUD on the same tic");
    stepUntil(sim, [23], () => rows(sim).at(-1).x > 16 * unit, "walk into the damaging room");
    stepUntil(sim, [], () => rows(sim).at(-1).dead, "die in the super hellslime room");
    stepUntil(sim, [], () => rows(sim).filter(row => row.dead && row.view > 6 * unit).length >= 3,
        "observe three falling death-camera tics");
    const deathRows = rows(sim).filter(row => row.dead && row.view > 6 * unit);
    assert.ok(deathRows.length >= 3, "observe the death camera descending");
    assert.deepEqual(deathRows.slice(1, 3).map((row, index) => deathRows[index].view - row.view), [unit, unit]);
    assert.ok(deathRows.some((row, index) => index > 0 && row.tics !== deathRows[index - 1].tics),
        "the corpse state timer advances while the dead player remains in the level");
    assert.equal(rows(sim).at(-1).health, 0);
    stepUntil(sim, [], () => rows(sim).at(-1).view === 6 * unit, "reach the six-unit death-camera floor");

    stepUntil(sim, [6], () => sim.logs.some(row => row[0] === "Doom level restarted"), "restart the dead player with F");
    stepUntil(sim, [6], () => {
        const row = rows(sim).at(-1);
        return row && !row.dead && row.level === 0 && row.x === -50 * unit;
    }, "finish rebuilding the original level while F remains held");
    const restarted = rows(sim).at(-1);
    const lastDead = rows(sim).findLast(row => row.dead);
    assert.deepEqual([restarted.health, restarted.clip, restarted.blue, restarted.dead], [100, 50, 0, false]);
    assert.equal(restarted.message, "", "restarting the level clears its current HUD message");
    assert.equal(restarted.game, lastDead.game + 1, "the reload itself does not consume a gameplay tic");
    assert.equal(restarted.rng, (lastDead.rng + first.rng) & 255, "map spawns consume the continuing gameplay RNG");
    assert.equal(sim.logs.filter(row => row[0] === "Doom level restarted").length, 1, "held F cannot repeatedly restart the map");
    for (let host = 0; host < 30; host++) sim.step([], new Map(), [6]);
    assert.equal(sim.logs.filter(row => row[0] === "Doom level restarted").length, 1);
    assert.ok(!sim.logs.some(row => row[0] === "Doom level exit requested"), "held use does not activate the exit after rebirth");

    stepUntil(sim, [23], () => rows(sim).at(-1).blue === 1, "pick up the respawned blue card");
    assert.equal(rows(sim).at(-1).message, "BLUE KEYCARD COLLECTED", "the respawned pickup posts a new HUD message");
    stepUntil(sim, [6], () => sim.logs.some(row => row[0] === "Doom level exit requested"),
        "use the exit after releasing and pressing F again");
    assert.deepEqual(sim.logs.filter(row => row[0] === "Classic WAD BSP frame rendered"), [["Classic WAD BSP frame rendered"]]);
    console.log("WAD preview passed death camera descent, same-level restart, held-use gating, clock continuity, and pickup respawn.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-player-restart-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
