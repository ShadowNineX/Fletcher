// Exercise the actual WAD preview with an original room and synthetic patches.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-weapons-"));
const empty = Buffer.alloc(0);
const red = 1, white = 0, blue = 2, black = 7;

function words(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, i) => bytes.writeUInt16LE(value & 0xffff, i * 2));
    return bytes;
}

function patch(width, height, left, top, color) {
    const header = 8 + width * 4, columnSize = height + 5;
    const bytes = Buffer.alloc(header + width * columnSize);
    bytes.writeInt16LE(width);
    bytes.writeInt16LE(height, 2);
    bytes.writeInt16LE(left, 4);
    bytes.writeInt16LE(top, 6);
    for (let x = 0; x < width; x++) {
        const offset = header + x * columnSize;
        bytes.writeUInt32LE(offset, 8 + x * 4);
        bytes[offset + 1] = height;
        bytes.fill(color, offset + 3, offset + 3 + height);
        bytes[offset + height + 4] = 255;
    }
    return bytes;
}

function wad(lumps) {
    const directory = 12 + lumps.reduce((size, [, bytes]) => size + bytes.length, 0);
    const bytes = Buffer.alloc(directory + lumps.length * 16);
    bytes.write("PWAD");
    bytes.writeInt32LE(lumps.length, 4);
    bytes.writeInt32LE(directory, 8);
    let offset = 12;
    for (const [i, [name, data]] of lumps.entries()) {
        const entry = directory + i * 16;
        bytes.writeInt32LE(offset, entry);
        bytes.writeInt32LE(data.length, entry + 4);
        bytes.write(name, entry + 8);
        data.copy(bytes, offset);
        offset += data.length;
    }
    return bytes;
}

function mapWad(rocket, monster) {
    const farWall = monster === "revenant" ? 768 : rocket || monster ? 384 : 128;
    const vertices = words([-128, -64, -128, 64, farWall, 64, farWall, -64]);
    const lines = Buffer.concat([[0, 1], [1, 2], [2, 3], [3, 0]].map(([a, b]) => words([a, b, 0, 0, 0, 0, 0xffff])));
    const sides = Buffer.alloc(30);
    const segs = Buffer.concat([[0, 1, 0, 0, 0, 0], [1, 2, 0, 1, 0, 0], [2, 3, 0, 2, 0, 0], [3, 0, 0, 3, 0, 0]].map(v => words(v)));
    const sector = Buffer.alloc(26);
    sector.writeInt16LE(128, 2);
    sector.write("FLOOR0_1", 4);
    sector.write("CEIL1_1", 12);
    sector.writeInt16LE(160, 20);
    const columns = (farWall + 128) / 128, cells = columns * 2;
    const block = words([-128, -128, columns, 2, ...Array(cells).fill(4 + cells), 0, 0, 1, 2, 3, -1]);
    const things = [0, 0, 0, 1, 7];
    if (rocket) things.push(8, 0, 0, 2003, 7, 225, 0, 0, 2035, 7, 278, 28, 0, 2035, 7);
    if (monster === "brain") things.push(8, 0, 0, 2001, 7, 12, 0, 0, 2049, 7, 76, 0, 0, 88, 7);
    // Give the revenant room to finish its reaction time and attempt a
    // ranged attack before the chase takes it inside Doom's missile cutoff.
    if (monster === "revenant") things.push(660, 45, 0, 66, 7);
    else if (monster === "vile") things.push(245, 40, 0, 64, 7);
    else if (monster === "boss") things.push(182, -32, 0, 89, 7, 182, 42, 0, 87, 7);
    else if (monster === "imp") things.push(219, 45, 0, 3001, 7);
    const label = monster === "boss" || monster === "brain" ? "MAP30" : "MAP01";
    return [[label, empty], ["THINGS", words(things)], ["LINEDEFS", lines], ["SIDEDEFS", sides],
        ["VERTEXES", vertices], ["SEGS", segs], ["SSECTORS", words([4, 0])], ["NODES", empty],
        ["SECTORS", sector], ["REJECT", Buffer.alloc(1)], ["BLOCKMAP", block]];
}

function spriteLumps(rocket, monster) {
    const palette = Buffer.alloc(256 * 3);
    palette.set([255, 0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 0]);
    const maps = Buffer.from(Array.from({ length: 32 * 256 }, (_, i) => i & 255));
    const arsenal = rocket ? [
        ["MISGA0", patch(94, 82, -112, -92, 0)], ["MISGB0", patch(94, 82, -112, -92, 2)],
        ...["A", "B"].map(frame => [`BAR1${frame}0`, patch(32, 56, 16, 52, 0)]),
        ...["A", "B", "C", "D"].map(frame => [`MISL${frame}0`, patch(30, 28, 15, 15, 1)]),
        ...["A", "B", "C", "D", "E"].map(frame => [`BEXP${frame}0`, patch(44, 57, 22, 48, 2)]),
    ] : [
        ["PISGA0", patch(94, 82, -112, -92, 0)], ["PISGB0", patch(94, 82, -112, -92, 2)],
        ["PISGC0", patch(94, 82, -112, -92, 2)], ["PISFA0", patch(34, 36, -150, -70, 1)],
        ["PUNGA0", patch(70, 68, -124, -100, 1)],
        ...["A", "B", "C", "D"].map(frame => [`PUFF${frame}0`, patch(24, 24, 12, 12, 3)]),
    ];
    if (monster === "revenant") {
        arsenal.length = 0;
        for (const frame of "ABCDEFGHIJKLMNOPQ") arsenal.push([`SKEL${frame}0`, patch(33, 64, 16, 60, 0)]);
        for (const frame of "AB") arsenal.push([`FATB${frame}0`, patch(24, 22, 12, 14, 1)]);
        for (const frame of "ABC") arsenal.push([`FBXP${frame}0`, patch(30, 24, 15, 16, 2)]);
        for (const frame of "ABCD") arsenal.push([`PUFF${frame}0`, patch(12, 12, 6, 6, 3)]);
    } else if (monster === "vile") {
        arsenal.length = 0;
        for (const frame of "ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]") arsenal.push([`VILE${frame}0`, patch(33, 64, 16, 60, 0)]);
        for (const frame of "ABCDEFGH") arsenal.push([`FIRE${frame}0`, patch(28, 64, 14, 60, 1)]);
    } else if (monster === "boss") {
        arsenal.length = 0;
        for (const frame of "ABCD") arsenal.push([`BOSF${frame}0`, patch(34, 34, 17, 28, 1)]);
        for (const frame of "ABCDEFGH") arsenal.push([`FIRE${frame}0`, patch(28, 64, 14, 60, 0)]);
    } else if (monster === "brain") {
        arsenal.push(...["A", "B", "C", "D"].map(frame => [`SHTG${frame}0`, patch(94, 82, -112, -92, 1)]));
        arsenal.push(["BBRNA0", patch(36, 40, 18, 32, 0)], ["BBRNB0", patch(36, 40, 18, 32, 2)]);
        for (const frame of "ABCD") arsenal.push([`MISL${frame}0`, patch(30, 28, 15, 15, 1)]);
    } else if (monster === "imp") {
        arsenal.length = 0;
        for (const frame of "ABCDEFGHIJKLMNO") arsenal.push([`TROO${frame}0`, patch(33, 56, 16, 53, 0)]);
        for (const frame of "ABCDE") arsenal.push([`BAL1${frame}0`, patch(24, 22, 12, 14, 1)]);
    }
    return [["S_START", empty], ...arsenal, ["S_END", empty], ["PLAYPAL", palette], ["COLORMAP", maps]];
}

function waitFor(sim, predicate, maxTics, description) {
    for (let elapsed = 0; elapsed < maxTics; elapsed++) {
        if (predicate()) return;
        sim.step();
    }
    assert.fail(`${description}. Map log ${JSON.stringify(sim.logs)}`);
}

const at = (sim, x, y) => sim.tileAt({ x, y }).extra;

function preview(rocket = false, monster = "", paired = false) {
    const name = monster || (rocket ? "rocket" : "pistol");
    const level = path.join(scratch, "LEVEL.WAD"), output = path.join(scratch, `${name}.json`);
    writeFileSync(level, wad([...mapWad(rocket, monster), ...spriteLumps(rocket, monster)]));
    const built = spawnSync("dotnet", [cli, "build", path.join(port, "wad-bsp", "main.flt"), "--package-root", port, "--asset-root", scratch, "-o", output], { cwd: root, encoding: "utf8", timeout: 30000 });
    if (built.error) throw built.error;
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    const buildSim = () => simulator(decode(encoded), true);
    return paired ? [buildSim(), buildSim()] : buildSim();
}

function pistolScenario() {
    const sim = preview();
    const pistolColor = () => at(sim, -8, 25);
    const flashColor = () => at(sim, 0, 8);
    const puffVisible = () => [-2, -1, 0, 1, 2].some(x =>
        [-4, -3, -2, -1, 0, 1, 2].some(y => at(sim, x, y) === black));
    waitFor(sim, () => pistolColor() === red, 96, "pistol rises into view");
    for (let i = 0; i < 60; i++) sim.step();
    assert.equal(pistolColor(), red);
    assert.equal(puffVisible(), false);
    sim.step([], new Map(), [18]);
    waitFor(sim, () => pistolColor() === blue && flashColor() === white && puffVisible(), 45, "R fires a visible round");
    waitFor(sim, () => pistolColor() === red && flashColor() !== white && !puffVisible(), 55, "flash and puff expire");
    for (let i = 0; i < 12; i++) sim.step();
    sim.step([], new Map(), [18]);
    waitFor(sim, () => flashColor() === white && puffVisible(), 45, "a second shot still fires");
    waitFor(sim, () => pistolColor() === red && flashColor() !== white && !puffVisible(), 55, "returns to ready after the second shot");
    for (let i = 0; i < 12; i++) sim.step();
    sim.step([], new Map(), [24]);
    waitFor(sim, () => pistolColor() === white, 80, "X selects the owned fist");
    assert.deepEqual(sim.logs.map(row => [...row]), [["Classic WAD BSP frame rendered"]]);
}

function rocketScenario() {
    const sim = preview(true);
    const scenePixels = () => {
        const pixels = [];
        for (let y = -8; y <= 6; y++) for (let x = -18; x <= 18; x++) pixels.push(at(sim, x, y));
        return pixels;
    };
    waitFor(sim, () => sim.tileWrites > 0 && scenePixels().includes(red), 55, "two barrels render in the original room");
    for (let i = 0; i < 58; i++) sim.step();
    sim.step([], new Map(), [23]);
    waitFor(sim, () => at(sim, -8, 25) === red, 90, "walking over the launcher selects it");
    for (let i = 0; i < 30; i++) sim.step();
    const beforeShot = scenePixels();
    assert.equal(beforeShot.includes(white), false);
    const hasNewColor = color => scenePixels().some((pixel, index) => pixel === color && beforeShot[index] !== color);
    sim.step([], new Map(), [18]);
    waitFor(sim, () => hasNewColor(white), 110, "rocket moves and renders in world space");
    waitFor(sim, () => hasNewColor(blue) && !scenePixels().includes(red), 140, "rocket and radius damage destroy both barrels");
    waitFor(sim, () => !hasNewColor(blue) && !hasNewColor(white), 360, "rocket and barrel explosions expire");
    assert.deepEqual(sim.logs.map(row => [...row]), [["Classic WAD BSP frame rendered"]]);
}

function monsterScenario(monster, projectileFrames) {
    const [quiet, gunfire] = preview(false, monster, true);
    function frameInfo(sim) {
        const body = [], projectile = [];
        for (let y = -18; y <= 12; y++) {
            for (let x = -28; x <= 26; x++) {
                const tile = at(sim, x, y);
                if (tile === red) body.push(`${x}/${y}`);
                if (tile === white) projectile.push(`${x}/${y}`);
            }
        }
        return { body, projectile };
    }
    for (let i = 0; i < 63; i++) { quiet.step(); gunfire.step(); }
    const idle = frameInfo(quiet).body;
    assert.ok(idle.length > 2, "sleeping monster was visible");
    assert.deepEqual(frameInfo(gunfire).body, idle);
    let moved = false;
    const visibleProjectiles = new Set();
    for (let i = 0; i < 260 && visibleProjectiles.size < projectileFrames; i++) {
        quiet.step();
        gunfire.step([], new Map(), i < 4 ? [18] : []);
        const active = frameInfo(gunfire);
        moved ||= active.body.length > 0 && active.body.join() !== idle.join();
        if (active.projectile.length) visibleProjectiles.add(active.projectile.join());
    }
    assert.deepEqual(frameInfo(quiet).body, idle, "the isolated comparison monster never sees the player behind it");
    assert.ok(moved, "gunfire woke the rear-facing monster and started its chase");
    assert.equal(visibleProjectiles.size, projectileFrames, `${monster} launched a visible projectile`);
    for (const sim of [quiet, gunfire]) assert.deepEqual(sim.logs.map(row => [...row]), [["Classic WAD BSP frame rendered"]]);
}

function vileScenario() {
    const [quiet, active] = preview(false, "vile", true);
    const fireVisible = sim => {
        for (let y = -18; y <= 12; y++) for (let x = -28; x <= 26; x++) {
            if (at(sim, x, y) === white) return true;
        }
        return false;
    };
    const viewportEdge = sim => Array.from({ length: 88 }, (_, i) => at(sim, -62, i - 44)).join();
    for (let i = 0; i < 63; i++) { quiet.step(); active.step(); }
    assert.equal(fireVisible(quiet), false);
    assert.equal(fireVisible(active), false);
    let lit = false;
    for (let i = 0; i < 360 && !lit; i++) {
        quiet.step();
        active.step([], new Map(), i < 4 ? [18] : []);
        lit = fireVisible(active);
    }
    assert.ok(lit, "arch-vile FIRE sprite became visible after wake-up");
    assert.equal(fireVisible(quiet), false, "the isolated comparison remained quiet");
    const stationary = viewportEdge(quiet);
    waitFor(active, () => viewportEdge(active) !== stationary, 220, "the blast moves the player viewpoint");
    waitFor(active, () => !fireVisible(active), 240, "arch-vile flame effect leaves the viewport after its attack");
    assert.deepEqual(quiet.logs.map(row => [...row]), [["Classic WAD BSP frame rendered"]]);
    assert.deepEqual(active.logs.map(row => [...row]), [["Classic WAD BSP frame rendered"]]);
}

function iconOfSinScenario() {
    const [quiet, active] = preview(false, "boss", true);
    const markerPixels = (sim, color) => {
        const pixels = new Set();
        for (let y = -32; y < 34; y++) for (let x = -50; x < 50; x++) {
            if (at(sim, x, y) === color) pixels.add(`${x}/${y}`);
        }
        return pixels;
    };
    for (let i = 0; i < 70; i++) { quiet.step(); active.step(); }
    const beforeCube = markerPixels(quiet, white), beforeFog = markerPixels(quiet, red);
    let cube = false, fog = false;
    // Gunfire wakes the rear-facing eye. Its first spit follows a 181-tic hold.
    for (let i = 0; i < 1200 && !fog; i++) {
        quiet.step();
        active.step([], new Map(), i < 4 ? [18] : []);
        cube ||= [...markerPixels(active, white)].some(pixel => !beforeCube.has(pixel));
        fog = cube && [...markerPixels(active, red)].some(pixel => !beforeFog.has(pixel));
    }
    assert.ok(cube, "Icon of Sin BOSF cube became visible");
    assert.ok(fog, "Icon of Sin FIRE fog became visible after the cube arrived");
    assert.deepEqual(markerPixels(quiet, white), beforeCube);
    assert.deepEqual(markerPixels(quiet, red), beforeFog);
    assert.deepEqual(quiet.logs.map(row => [...row]), [["Classic WAD BSP frame rendered"]]);
    assert.deepEqual(active.logs.map(row => [...row]), [["Classic WAD BSP frame rendered"]]);
}

function brainDeathScenario() {
    const sim = preview(false, "brain");
    waitFor(sim, () => sim.tileWrites > 0, 70, "boss brain room loads");
    for (let i = 0; i < 60; i++) sim.step();
    assert.equal(at(sim, -8, 25), red, "pistol is ready before picking up the shotgun");
    sim.step([], new Map(), [23]);
    waitFor(sim, () => at(sim, -8, 25) === white, 90, "walk to the shotgun in the brain room");
    for (let i = 0; i < 30; i++) sim.step();
    const exited = () => sim.logs.some(row => row[0] === "Doom level exit requested");
    for (let i = 0; i < 1100 && !exited(); i++) sim.step([], new Map(), [18]);
    assert.ok(exited(), `brain death requests a level exit. Map log ${JSON.stringify(sim.logs)}`);
    for (let i = 0; i < 16; i++) sim.step([], new Map(), [23]);
    assert.deepEqual(sim.logs.map(row => [...row]), [["Classic WAD BSP frame rendered"], ["Doom level exit requested"]]);
}

try {
    pistolScenario();
    rocketScenario();
    monsterScenario("imp", 1);
    monsterScenario("revenant", 2);
    vileScenario();
    iconOfSinScenario();
    brainDeathScenario();
    console.log("Doom WAD preview passed weapon controls, rocket splash and cleanup, imp and revenant counterattacks, arch-vile flame effects, and the Icon of Sin spawn and death sequences.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-weapons-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
