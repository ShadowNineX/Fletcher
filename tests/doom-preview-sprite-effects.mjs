// Exercise shadow sprites and the first-person invisibility path through the
// WAD preview. Every WAD lump below is generated test data.
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
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-sprite-effects-"));
const Width = 128, Height = 96;
const lowDetail = process.argv.includes("--low-detail");

function words(values) {
    const result = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => result.writeUInt16LE(value & 65535, index * 2));
    return result;
}

function wad(lumps) {
    const directory = 12 + lumps.reduce((size, [, value]) => size + value.length, 0);
    const result = Buffer.alloc(directory + lumps.length * 16);
    result.write("PWAD"); result.writeUInt32LE(lumps.length, 4); result.writeUInt32LE(directory, 8);
    let offset = 12;
    for (const [index, [name, value]] of lumps.entries()) {
        const entry = directory + index * 16;
        result.writeUInt32LE(offset, entry); result.writeUInt32LE(value.length, entry + 4); result.write(name, entry + 8);
        value.copy(result, offset); offset += value.length;
    }
    return result;
}

function solidPatch(width, height, index) {
    const directory = 8 + width * 4, column = height + 5;
    const result = Buffer.alloc(directory + width * column);
    result.writeInt16LE(width, 0); result.writeInt16LE(height, 2);
    for (let x = 0; x < width; x++) {
        const offset = directory + x * column;
        result.writeUInt32LE(offset, 8 + x * 4);
        result[offset + 1] = height;
        result.fill(index, offset + 3, offset + 3 + height);
        result[offset + height + 4] = 255;
    }
    return result;
}

function mapLumps(actor, withInvisibility) {
    // The front portal opens into a second sector. This is deliberately the
    // same tiny BSP shape used by the established sprite-preview coverage:
    // an ordinary enclosing box would correctly occlude the actor completely.
    const shape = [[24, 160, 24, -160, 0, 96], [88, 160, 88, -160, 24, 96]];
    const vertices = Buffer.alloc(16), lines = Buffer.alloc(28), segs = Buffer.alloc(24);
    const sides = Buffer.alloc(120), sectors = Buffer.alloc(52), leaves = words([1, 0, 1, 1]);
    for (const [index, [x1, y1, x2, y2, floor, ceiling]] of shape.entries()) {
        const twoSided = index === 0;
        vertices.writeInt16LE(x1, index * 8); vertices.writeInt16LE(y1, index * 8 + 2);
        vertices.writeInt16LE(x2, index * 8 + 4); vertices.writeInt16LE(y2, index * 8 + 6);
        lines.writeUInt16LE(index * 2, index * 14); lines.writeUInt16LE(index * 2 + 1, index * 14 + 2);
        lines.writeUInt16LE(twoSided ? 4 : 0, index * 14 + 4);
        lines.writeUInt16LE(index * 2, index * 14 + 10); lines.writeUInt16LE(twoSided ? index * 2 + 1 : 65535, index * 14 + 12);
        segs.writeUInt16LE(index * 2, index * 12); segs.writeUInt16LE(index * 2 + 1, index * 12 + 2);
        segs.writeUInt16LE(0xc000, index * 12 + 4); segs.writeUInt16LE(index, index * 12 + 6);
        sides.writeUInt16LE(index, index * 60 + 28); if (twoSided) sides.writeUInt16LE(index + 1, index * 60 + 58);
        sectors.writeInt16LE(floor, index * 26); sectors.writeInt16LE(ceiling, index * 26 + 2);
        sectors.write("FLOOR0_1", index * 26 + 4); sectors.write("CEIL1_1", index * 26 + 12); sectors.writeInt16LE(160, index * 26 + 20);
    }
    const nodes = Buffer.alloc(28);
    [36, 0, 0, 1, 160, -160, 88, 88, 160, -160, 24, 24].forEach((value, index) => nodes.writeInt16LE(value, index * 2));
    nodes.writeUInt16LE(0x8001, 24); nodes.writeUInt16LE(0x8000, 26);
    const things = [[0, 0, 0, 1, 7]];
    if (actor) things.push([48, 0, 180, actor, 7]);
    if (withInvisibility) things.push([12, 0, 0, 2024, 7]);
    return [["E1M1", Buffer.alloc(0)], ["THINGS", words(things.flat())], ["LINEDEFS", lines], ["SIDEDEFS", sides],
        ["VERTEXES", vertices], ["SEGS", segs], ["SSECTORS", leaves], ["NODES", nodes], ["SECTORS", sectors], ["REJECT", Buffer.alloc(1)],
        // Two rows cover y = -128 through 128, including the player and the
        // pickup at y = 0. Each points at the same small linedef list.
        ["BLOCKMAP", words([-128, -128, 3, 2, 10, 10, 10, 10, 10, 10, 0, 1, -1])]];
}

function resources() {
    const palette = Buffer.alloc(256 * 3);
    const colors = [[0, 0, 0], [255, 255, 255], [255, 0, 0], [255, 128, 0],
        [255, 255, 0], [0, 255, 0], [0, 0, 255], [128, 0, 128]];
    for (let index = 0; index < 256; index++) palette.set(colors[index & 7], index * 3);
    // Distinct display colors make the visible palette path and the indexed
    // fuzz lookup independently observable in Logic Arrows' framebuffer.
    palette.set([255, 0, 0], 77 * 3);   // demon sprite
    palette.set([0, 0, 255], 111 * 3);  // pistol sprite
    palette.set([0, 255, 0], 108 * 3);  // COLORMAP row 6 applied to flat 17
    const colorMap = Buffer.from(Array.from({ length: 32 * 256 }, (_, position) => {
        const row = position >> 8, index = position & 255;
        return row === 6 ? (index + 91) & 255 : index;
    }));
    return [["F_START", Buffer.alloc(0)], ["FLOOR0_1", Buffer.alloc(4096, 17)], ["CEIL1_1", Buffer.alloc(4096, 17)], ["F_END", Buffer.alloc(0)],
        ["PLAYPAL", palette], ["COLORMAP", colorMap], ["S_START", Buffer.alloc(0)],
        ["SARGA0", solidPatch(32, 56, 77)], ["PISGA0", solidPatch(64, 64, 111)], ["PINSA0", solidPatch(16, 16, 45)], ["S_END", Buffer.alloc(0)]];
}

function previewSource(blink) {
    const preview = path.join(scratch, blink ? "blink" : "preview");
    mkdirSync(preview);
    for (const name of readdirSync(path.join(port, "wad-bsp")).filter(name => name.endsWith(".flt"))) {
        let source = readFileSync(path.join(port, "wad-bsp", name), "utf8");
        if (lowDetail && name === "display.flt") {
            assert.match(source, /^const LowDetail = false$/m);
            source = source.replace(/^const LowDetail = false$/m, "const LowDetail = true");
        }
        if (name === "main.flt") {
            const tick = "    tick {";
            assert.ok(source.includes(tick));
            source = source.replace(tick, `${tick}\n        log("effect", gameTime, inventory.Powers[play.PowerInvisibility], screenFuzzPhase, screenFuzzVisible)`);
            if (lowDetail) {
                const statusBar = "    if display.StatusVisible { DrawStatusBar";
                assert.ok(source.includes(statusBar));
                source = source.replace("type CameraDraw struct {", "type CameraDraw struct {\n    DetailMismatch int\n    DetailSamples int");
                source = source.replace(statusBar, `    mismatches, indexed := 0, 0
    for row := range viewHeight {
        for column := range Width / 2 {
            first, second := pixelIndexAt(2 * column, row), pixelIndexAt(2 * column + 1, row)
            if first != second { mismatches = mismatches + 1 }
            if first >= 0 { indexed = indexed + 1 }
        }
    }
${statusBar}`);
                source = source.replace("return CameraDraw{Valid: true,", "return CameraDraw{Valid: true, DetailMismatch: mismatches, DetailSamples: indexed,");
                source = source.replace(/^([ \t]*)if (painted|rendered)\.Valid \{$/gm, (line, indent, name) =>
                    `${line}\n${indent}    log("detail-pairs", ${name}.DetailMismatch, ${name}.DetailSamples)`);
            }
            if (blink) {
                const invisible = "                invisible := weaponUsesFuzz(frame.Contacts.Inventory.Powers[play.PowerInvisibility])";
                assert.ok(source.includes(invisible));
                source = source.replace(invisible, `                // Test-only countdown samples for Doom's final invisibility blink.\n                if gameTime == 2 { frame.Contacts.Inventory.Powers[play.PowerInvisibility] = 136; log("applied", 136) }\n                if gameTime == 3 { frame.Contacts.Inventory.Powers[play.PowerInvisibility] = 128; log("applied", 128) }\n                if gameTime == 4 { frame.Contacts.Inventory.Powers[play.PowerInvisibility] = 120; log("applied", 120) }\n${invisible}`);
            }
        }
        writeFileSync(path.join(preview, name), source);
    }
    return path.join(preview, "main.flt");
}

function build(entry, archive, name) {
    writeFileSync(path.join(scratch, "LEVEL.WAD"), archive);
    const output = path.join(scratch, `${name}.json`);
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
}

function frame(sim) {
    return Buffer.from(Array.from({ length: Width * Height }, (_, index) =>
        sim.tileAt({ x: index % Width - 64, y: Math.floor(index / Width) - 48 }).extra));
}

function count(buffer, index) { return buffer.reduce((total, value) => total + (value === index), 0); }

function checkPairs(sim, minimumFrames = 1) {
    if (!lowDetail) return;
    const samples = sim.logs.filter(([label]) => label === "detail-pairs");
    assert.ok(samples.length >= minimumFrames, "captured complete low-detail renders");
    for (const [, mismatches, indexed] of samples) {
        assert.equal(mismatches, 0, "each pair stores the same raw WAD palette index");
        assert.ok(indexed > Width, "the scene draws indexed WAD planes and sprites");
    }
}

function start(sim) {
    for (let host = 0; host < 100 && !sim.logs.some(row => row[0] === "Classic WAD BSP frame rendered"); host++) sim.step();
    assert.ok(sim.logs.some(row => row[0] === "Classic WAD BSP frame rendered"), JSON.stringify(sim.logs));
}

function visibleFrames(entry) {
    const absent = build(entry, wad([...mapLumps(0, false), ...resources()]), "absent");
    const demon = build(entry, wad([...mapLumps(3002, false), ...resources()]), "demon");
    const spectre = build(entry, wad([...mapLumps(58, false), ...resources()]), "spectre");
    for (const simulation of [absent, demon, spectre]) {
        start(simulation);
        checkPairs(simulation);
    }
    return [frame(absent), frame(demon), frame(spectre)];
}

try {
    const ordinaryEntry = previewSource(false);
    const [background, demon, spectre] = visibleFrames(ordinaryEntry);
    assert.ok(count(demon, 1) > 0, `DoomEd 3002 renders the red ordinary demon patch. Colors ${[...new Set(demon)].join(",")}`);
    assert.ok(count(demon, 1) > count(spectre, 1), "DoomEd 58 omits the spectre's opaque red sprite texels");
    assert.notDeepEqual(spectre, background, "the spectre fuzz pass samples and changes the indexed background");
    assert.notDeepEqual(spectre, demon, "the spectre and visible demon use distinct renderer paths");

    const pickup = build(ordinaryEntry, wad([...mapLumps(0, true), ...resources()]), "pickup");
    start(pickup);
    const before = frame(pickup);
    assert.ok(count(before, 2) > 0, "the normal blue pistol patch is visible before the invisibility pickup");
    for (let host = 0; host < 80 && !pickup.logs.some(row => row[0] === "effect" && Number(row[2]) > 0); host++) {
        pickup.step([], new Map(), [23]);
    }
    assert.ok(pickup.logs.some(row => row[0] === "effect" && Number(row[2]) > 0), "DoomEd 2024 grants invisibility through the live player contact path");
    const hidden = frame(pickup);
    assert.ok(count(hidden, 2) < count(before, 2), "invisibility replaces most blue pistol texels with fuzz samples");
    assert.ok(count(hidden, 4) > count(before, 4), "the fuzz pass writes the green COLORMAP-shaded indexed background");
    assert.notDeepEqual(hidden, before, "the pickup repaints the first-person weapon overlay");
    const lastEffect = () => pickup.logs.filter(row => row[0] === "effect").at(-1);
    const previous = lastEffect();
    for (let host = 0; host < 80 && lastEffect() === previous; ++host) pickup.step();
    const next = lastEffect();
    assert.equal(next[1], previous[1] + 1, "the next logical tic renders the invisible player");
    assert.notEqual(next[3], previous[3], "successive invisible renders advance the persistent fuzz phase");
    checkPairs(pickup, 3);

    const blinkEntry = previewSource(true);
    const blink = build(blinkEntry, wad([...mapLumps(0, false), ...resources()]), "blink");
    start(blink);
    const samples = new Map();
    for (let host = 0; host < 40 && samples.size < 3; host++) {
        blink.step();
        const row = blink.logs.filter(entry => entry[0] === "applied").at(-1);
        if (!row) continue;
        const power = Number(row[1]);
        if ([136, 128, 120].includes(power)) samples.set(power, frame(blink));
    }
    assert.ok(count(samples.get(128), 2) > count(samples.get(136), 2), "the primed 136-tic invisibility frame fuzzes the weapon");
    assert.ok(count(samples.get(128), 2) > 0, "128 tics is an off blink frame with the normal weapon");
    assert.ok(count(samples.get(128), 2) > count(samples.get(120), 2), "120 tics is an on blink frame with fuzz again");
    checkPairs(blink, 4);
    console.log(`WAD preview passed spectre fuzz, invisibility pickup, and final blink weapon rendering in ${lowDetail ? "low" : "high"} detail.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-sprite-effects-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
