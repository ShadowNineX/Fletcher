// Exercise player sector specials through the production Logic Arrows preview.
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
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-player-sectors-"));
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

function playerSectorMap(leftSpecial, invulnerability = false) {
    const vertices = words([-128, -64, -128, 64, 0, 64, 0, -64, 256, 64, 256, -64]);
    const lines = words([
        2, 3, 4, 0, 0, 0, 1,
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
    sectors.writeInt16LE(leftSpecial, 22);
    const block = words([-128, -128, 4, 2, ...Array(8).fill(12), 0, 1, 2, 3, 4, 5, 6, -1]);
    const things = words([-50, 0, 0, 1, 7, ...(invulnerability ? [-10, 0, 0, 2022, 7] : [])]);
    const palette = Buffer.alloc(256 * 3);
    palette.set([255, 0, 0], 3);
    palette.set([0, 0, 255], 6);
    const colorMaps = Buffer.from(Array.from({ length: 33 * 256 }, (_, index) => index & 255));
    colorMaps[32 * 256 + 1] = 2;
    return [["E1M1", Buffer.alloc(0)], ["THINGS", things], ["LINEDEFS", lines], ["SIDEDEFS", sides],
        ["VERTEXES", vertices], ["SEGS", segs], ["SSECTORS", words([4, 0, 4, 4])],
        ["NODES", words([0, -64, 0, 128, 64, -64, 0, 256, 64, -64, -128, 0, 0x8001, 0x8000])],
        ["SECTORS", sectors], ["REJECT", Buffer.alloc(1)], ["BLOCKMAP", block],
        ["F_START", Buffer.alloc(0)], ["FLOOR0_1", Buffer.alloc(4096, 1)], ["F_END", Buffer.alloc(0)],
        ["PLAYPAL", palette], ["COLORMAP", colorMaps]];
}

function preparePreview() {
    const preview = path.join(scratch, "preview");
    mkdirSync(preview);
    for (const name of readdirSync(path.join(port, "wad-bsp")).filter(name => name.endsWith(".flt"))) {
        let source = readFileSync(path.join(port, "wad-bsp", name), "utf8");
        if (name === "main.flt") {
            const insertion = "                    next player = moved";
            assert.ok(source.includes(insertion));
            source = source.replace(insertion, `
                    current := actorFrame.Actors.ActorAt(actorFrame.Actors.PlayerActors[0] - 1)
                    log("sector-tic", levelTime, moved.Body.X, frame.Contacts.Inventory.Health,
                        frame.Contacts.Inventory.SecretCount, level.SectorSpecial(0), level.SectorSpecial(1),
                        current.Sector, current.Physics.Body.Z, current.Physics.Body.Floor,
                        frame.Contacts.Inventory.Powers[play.PowerInvulnerability], frame.Contacts.Inventory.FixedColormap)
${insertion}`);
        }
        writeFileSync(path.join(preview, name), source);
    }
    return path.join(preview, "main.flt");
}

function build(entry, special, invulnerability = false) {
    const output = path.join(scratch, `special-${special}.json`);
    writeFileSync(path.join(scratch, "LEVEL.WAD"), wad(playerSectorMap(special, invulnerability)));
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    return simulator(decode(encoded), true);
}

function rows(sim) {
    return sim.logs.filter(row => row[0] === "sector-tic").map(([, tic, x, health, secrets, left, right, sector, z, floor, invulnerability, colormap]) =>
        ({ tic: Number(tic), x: Number(x), health: Number(health), secrets: Number(secrets), left: Number(left), right: Number(right),
            sector: Number(sector), z: Number(z), floor: Number(floor), invulnerability: Number(invulnerability), colormap: Number(colormap) }));
}

function stepUntil(sim, keys, condition, message) {
    for (let host = 0; host < 1300 && !condition(); host++) sim.step([], new Map(), keys);
    assert.ok(condition(), `${message}: ${JSON.stringify(sim.logs.slice(-8))}`);
}

function screenHash(sim) {
    const pixels = Buffer.alloc(128 * 96);
    for (let index = 0; index < pixels.length; index++) {
        pixels[index] = sim.tileAt({ x: index % 128 - 64, y: Math.floor(index / 128) - 48 }).extra;
    }
    return pixels.toString("base64");
}

try {
    const entry = preparePreview();

    const acid = build(entry, 5);
    const acidHits = () => rows(acid).filter((row, index, all) => row.health < 100 && (index === 0 || row.health !== all[index - 1].health));
    stepUntil(acid, [], () => acidHits().length >= 3, "observe three hellslime damage pulses");
    assert.deepEqual(acidHits().slice(0, 3).map(row => row.health), [90, 80, 70]);
    assert.deepEqual(acidHits().slice(1, 3).map((row, index) => row.tic - acidHits()[index].tic), [32, 32]);

    const secret = build(entry, 9);
    stepUntil(secret, [], () => rows(secret).some(row => row.secrets === 1 && row.left === 0), "claim the starting secret sector");
    stepUntil(secret, [23], () => rows(secret).at(-1).x > 16 * unit, "leave the consumed secret sector");
    stepUntil(secret, [19], () => rows(secret).at(-1).x < -16 * unit, "return through the consumed secret sector");
    assert.equal(rows(secret).at(-1).secrets, 1, "a cleared secret cannot increment the count twice");
    assert.equal(rows(secret).at(-1).left, 0);

    const exit = build(entry, 11);
    stepUntil(exit, [], () => exit.logs.some(row => row[0] === "Doom level exit requested"), "damage through the E1M8 exit sector");
    const exitRows = rows(exit);
    assert.equal(exitRows.at(-1).health, 1, "the exit sector leaves the player alive with one health");
    const paused = exitRows.length;
    for (let host = 0; host < 40; host++) exit.step();
    assert.equal(rows(exit).length, paused, "the preview stops after the exit request");
    assert.deepEqual(exit.logs.filter(row => row[0] === "Doom level exit requested"), [["Doom level exit requested"]]);

    const power = build(entry, 0, true);
    stepUntil(power, [], () => rows(power).length > 2, "render the unpowered room");
    stepUntil(power, [23], () => rows(power).some(row => row.invulnerability > 0 && row.colormap === 32),
        "pick up the invulnerability sphere and apply its inverse colormap");
    const pickup = rows(power).find(row => row.invulnerability > 0);
    assert.equal(pickup.invulnerability, 30 * 35);
    stepUntil(power, [], () => rows(power).length > 5 && rows(power).slice(-4).every(row => row.x === rows(power).at(-1).x),
        "settle after picking up the invulnerability sphere");
    const inverse = screenHash(power);
    stepUntil(power, [], () => rows(power).at(-1).invulnerability > 0 && rows(power).at(-1).invulnerability < 4 * 32 &&
        rows(power).at(-1).colormap === 0,
        "reach the invulnerability blink interval");
    const blink = rows(power).at(-1);
    const ordinary = screenHash(power);
    assert.notEqual(ordinary, inverse, "the renderer changes its palette row when invulnerability blinks");
    assert.ok(blink.invulnerability < 4 * 32);
    stepUntil(power, [], () => rows(power).at(-1).invulnerability === 0, "finish the invulnerability countdown");
    const expired = rows(power).at(-1);
    assert.equal(expired.tic - pickup.tic, 30 * 35);
    assert.equal(expired.colormap, 0);
    assert.equal(screenHash(power), ordinary, "expiry restores ordinary shading on the same stationary scene");

    console.log("WAD preview passed sector damage cadence, one-shot secrets, E1M8 exit damage, and invulnerability blinking and expiry.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-player-sectors-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
