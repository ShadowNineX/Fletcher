// Exercise the compiled HU message widget using generated WAD glyph patches.
// The fixture deliberately contains no Doom art, level, or message strings.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" } } });
const cli = path.join(root, "src", "Fletcher.Cli", "bin", "Debug", "net11.0", "fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-hud-messages-"));
const Width = 128, Height = 96;

function words(values) {
    const result = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => result.writeUInt16LE(value & 0xffff, index * 2));
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

function patch(width, height, color) {
    const directory = 8 + width * 4, column = height + 5;
    const result = Buffer.alloc(directory + width * column);
    result.writeInt16LE(width, 0); result.writeInt16LE(height, 2);
    for (let x = 0; x < width; x++) {
        const offset = directory + x * column;
        result.writeUInt32LE(offset, 8 + x * 4);
        result[offset + 1] = height;
        result.fill(color, offset + 3, offset + 3 + height);
        result[offset + height + 4] = 255;
    }
    return result;
}

function level() {
    const vertices = words([-128, -64, -128, 64, 128, 64, 128, -64]);
    const lines = Buffer.concat([[0, 1], [1, 2], [2, 3], [3, 0]].map(([a, b]) => words([a, b, 0, 0, 0, 0, 65535])));
    const sides = Buffer.alloc(30), segs = Buffer.concat([[0, 1, 0x4000, 0, 0, 0], [1, 2, 0, 1, 0, 0],
        [2, 3, 0xc000, 2, 0, 0], [3, 0, 0x8000, 3, 0, 0]].map(value => words(value)));
    const sector = Buffer.alloc(26);
    sector.writeInt16LE(128, 2); sector.write("FLOOR0_1", 4); sector.write("CEIL1_1", 12); sector.writeInt16LE(160, 20);
    return [["E1M1", Buffer.alloc(0)], ["THINGS", words([0, 0, 0, 1, 7])], ["LINEDEFS", lines], ["SIDEDEFS", sides],
        ["VERTEXES", vertices], ["SEGS", segs], ["SSECTORS", words([4, 0])], ["NODES", Buffer.alloc(0)],
        ["SECTORS", sector], ["REJECT", Buffer.alloc(1)], ["BLOCKMAP", words([-128, -128, 2, 2, 8, 8, 8, 8, 0, 1, 2, 3, -1])]];
}

function resources() {
    const palette = Buffer.alloc(256 * 3);
    palette.set([128, 0, 128], 1 * 3); // ordinary fallback world
    palette.set([0, 255, 0], 17 * 3);  // generated HUD glyphs
    palette.set([255, 0, 0], 18 * 3);
    palette.set([0, 0, 255], 19 * 3);
    palette.set([255, 255, 0], 20 * 3);
    const lumps = [["F_START", Buffer.alloc(0)], ["FLOOR0_1", Buffer.alloc(4096, 1)], ["CEIL1_1", Buffer.alloc(4096, 1)], ["F_END", Buffer.alloc(0)],
        ["PLAYPAL", palette], ["COLORMAP", Buffer.from(Array.from({ length: 33 * 256 }, (_, index) => index & 255))],
        ["STBAR", patch(320, 32, 0)], ["M_PAUSE", patch(10, 8, 19)],
        ...[0, 1, 2].map(index => ["STFST0" + index, patch(8, 8, 18 + index)])];
    for (let code = 33; code <= 95; code++) lumps.push(["STCFN" + String(code).padStart(3, "0"), patch(5, 7, 17)]);
    return lumps;
}

function previewSource() {
    const preview = path.join(scratch, "preview");
    mkdirSync(preview);
    for (const name of readdirSync(path.join(port, "wad-bsp")).filter(name => name.endsWith(".flt"))) {
        let source = readFileSync(path.join(port, "wad-bsp", name), "utf8");
        if (name === "main.flt") {
            assert.match(source, /register hudMessages play\.HudMessages/, "HUD state register is present");
            assert.match(source, /register hudMessagesEnabled bit/, "HUD display toggle register is present");
            assert.match(source, /drawHudMessage\(archives, shade,/, "HUD renderer is invoked after the world");
            const anchor = "                    messages = play.TickHudMessages(messages, enabled, hudPressed[6])";
            assert.equal(source.split(anchor).length, 2, "observe only held-world HUD tics");
            source = source.replace(anchor, `${anchor}
                    log("held-hud", gameTime, levelTime, lightState.Random.GameplayIndex, lightState.Random.MenuIndex,
                        lighting.Random.MenuIndex, roll.Value, hudMessages.Tics, messages.Tics, messages.Visible, hudPressed[6], face.Index)`);
        }
        writeFileSync(path.join(preview, name), source);
    }
    return path.join(preview, "main.flt");
}

function build(entry) {
    writeFileSync(path.join(scratch, "LEVEL.WAD"), wad([...level(), ...resources()]));
    const output = path.join(scratch, "hud-messages.json");
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
}

function screen(sim) {
    return Buffer.from(Array.from({ length: Width * Height }, (_, index) =>
        sim.tileAt({ x: index % Width - 64, y: Math.floor(index / Width) - 48 }).extra));
}

function messageRegion(sim) { return screen(sim).subarray(0, Width * 4); }

function stepUntil(sim, key, predicate, description, limit = 40) {
    for (let host = 0; host < limit; host++) {
        sim.step([], new Map(), key === undefined ? [] : [key]);
        if (predicate()) return;
    }
    assert.fail(description + ": " + JSON.stringify(sim.logs.slice(-12)));
}

function release(sim, limit = 12) {
    for (let host = 0; host < limit; host++) sim.step();
}

function checkNativeHeldHud(upstream, rows) {
    const read = name => readFileSync(path.join(upstream, name), "utf8").replaceAll("\r\n", "\n");
    const random = read("light-m_random.c");
    const table = random.match(/^unsigned char rndtable\[256\] = \{[\s\S]*?^};/m);
    assert.ok(table, "pinned Doom random table");
    const ticker = extractFunction(read("hu_stuff.c"), "void", "HU_Ticker");
    const singlePlayer = ticker.indexOf("// check for incoming chat characters");
    assert.ok(singlePlayer > 0);
    const source = path.join(scratch, "held.c"), exe = path.join(scratch, "held.exe");
    writeFileSync(source, `#include <stdio.h>
#include <stdbool.h>
enum { HU_MSGTIMEOUT = 140 };
static int rndindex, st_randomnumber, st_oldhealth;
static unsigned int st_clock;
static int message_counter, message_on, message_nottobefuckedwith, message_dontfuckwithme, showMessages, w_message;
static struct { int health; const char *message; } player = {100, 0}, *plyr = &player, *plr = &player;
static void ST_updateWidgets(void) {}
static void HUlib_addMessageToSText(int *target, int prefix, const char *message) {
    (void)target; (void)prefix; (void)message;
}
${table[0]}
${extractFunction(random, "int", "M_Random")}
${extractFunction(read("st_stuff.c"), "void", "ST_Ticker")}
${ticker.slice(0, singlePlayer)}
}
int main(void) {
    const int inputs[][3] = {
${rows.map(({ menuIndex, previousTics, refresh }) => `        {${menuIndex}, ${previousTics}, ${Number(refresh)}},`).join("\n")}
    };
    for (unsigned i = 0; i < sizeof(inputs)/sizeof(*inputs); ++i) {
        rndindex=inputs[i][0]; message_counter=inputs[i][1]; message_on=message_counter > 0;
        if (inputs[i][2]) { message_on=true; message_counter=HU_MSGTIMEOUT; }
        ST_Ticker(); HU_Ticker();
        printf("%d %d %d %d\\n", rndindex, st_randomnumber, message_counter, message_on);
    }
}`);
    const compile = spawnSync(process.env.CC ?? "gcc", ["-std=c99", "-O2", source, "-o", exe], { encoding: "utf8", timeout: 30000 });
    if (compile.error) throw compile.error;
    assert.equal(compile.status, 0, compile.stderr);
    const native = spawnSync(exe, [], { encoding: "utf8", timeout: 30000 });
    if (native.error) throw native.error;
    assert.equal(native.status, 0, native.stderr);
    const expected = native.stdout.trim().split(/\r?\n/).map(line => line.split(" ").map(Number));
    assert.deepEqual(rows.map(({ nextMenuIndex, roll, tics, visible }) => [nextMenuIndex, roll, tics, Number(visible)]), expected);
}

try {
    const sim = build(previewSource());
    stepUntil(sim, undefined, () => sim.logs.some(row => row[0] === "Classic WAD BSP frame rendered"), "load synthetic WAD");
    const ordinary = screen(sim);
    const origin = ordinary[0];

    // M opens the map. G is an actual HUD event producer and its glyph begins
    // at native pixel (0, 0), which projects to output pixel (0, 0).
    stepUntil(sim, 13, () => sim.logs.some(row => row[0] === "Doom automap opened"), "open automap");
    release(sim);
    const mapFrame = screen(sim), mapOrigin = mapFrame[0];
    stepUntil(sim, 7, () => screen(sim)[0] === 4, "draw green GRID ENABLED glyph", 32);
    const shown = screen(sim);
    assert.equal(shown[0], 4, "HUD glyph is drawn at the native top-left origin in its fixture swatch");
    assert.equal(shown[Width * 3], 4, "seven native glyph rows project through output row three");
    assert.equal(shown[Width * 4], mapFrame[Width * 4], "the glyph does not extend into output row four");
    release(sim);

    // HU_MSGREFRESH refreshes the current string without changing it. J is
    // Fletcher's preview binding for that native responder path.
    for (let tic = 0; tic < 110; tic++) sim.step();
    assert.equal(screen(sim)[0], 4, "message remains visible before HU_MSGTIMEOUT");
    stepUntil(sim, 10, () => screen(sim)[0] === 4, "refresh visible message");
    release(sim);
    for (let tic = 0; tic < 110; tic++) sim.step();
    assert.equal(screen(sim)[0], 4, "J restarts the HUD message timeout");

    for (let tic = 0; tic < 170; tic++) sim.step();
    assert.equal(screen(sim)[0], mapOrigin, "expired HUD glyph restores the current framebuffer without ghost pixels");
    const cleared = messageRegion(sim);
    stepUntil(sim, 10, () => screen(sim)[0] === 4, "recall expired message");
    release(sim);
    for (let tic = 0; tic < 170; tic++) sim.step();
    assert.deepEqual(messageRegion(sim), cleared, "HUD timeout removes every glyph pixel without ghosts");

    // K flips showMessages and queues its forced confirmation. The forced
    // confirmation must draw even when ordinary pickup messages are disabled.
    stepUntil(sim, 11, () => screen(sim)[0] !== mapOrigin, "show forced display-toggle confirmation");
    assert.notEqual(screen(sim)[0], mapOrigin, "forced HUD confirmation draws while messages are disabled");
    assert.notDeepEqual(screen(sim), ordinary, "automap frame remains active below the message overlay");

    stepUntil(sim, 16, () => sim.logs.some(([tag]) => tag === "Doom paused"), "pause with the forced message visible");
    assert.equal(screen(sim)[2 * Width + 51], 2, "M_PAUSE appears behind the modal layer");
    stepUntil(sim, undefined, () => screen(sim)[0] === mapOrigin, "the message expires during pause", 300);
    assert.equal(screen(sim)[2 * Width + 51], 2, "redrawing the expired glyph retains M_PAUSE");
    assert.deepEqual(messageRegion(sim).subarray(0, Width * 2), cleared.subarray(0, Width * 2));
    stepUntil(sim, 10, () => screen(sim)[0] === 4, "recall the prior message while paused");
    stepUntil(sim, 20, () => sim.logs.some(([tag]) => tag === "Doom campaign menu opened"), "open menu over the paused viewport");
    const withMenu = screen(sim);
    assert.equal(withMenu[0], 4, "the menu preserves the message outside its panel");
    assert.equal(withMenu[2 * Width + 51], 2, "the menu preserves the pause patch outside its panel");
    release(sim);
    stepUntil(sim, undefined, () => screen(sim)[0] === mapOrigin, "the message expires behind the menu", 300);
    assert.equal(screen(sim)[48 * Width + 48], withMenu[48 * Width + 48], "the modal panel survives the HUD redraw");
    stepUntil(sim, 20, () => sim.logs.some(([tag]) => tag === "Doom campaign menu closed"), "close the menu while paused");
    assert.equal(screen(sim)[0], mapOrigin, "closing the menu restores the updated backdrop");
    assert.equal(screen(sim)[2 * Width + 51], 2, "closing the menu keeps the paused level");
    const held = sim.logs.filter(([tag]) => tag === "held-hud")
        .map(([, gameTic, levelTic, gameplayIndex, menuIndex, nextMenuIndex, roll, previousTics, tics, visible, refresh, face]) =>
            ({ gameTic, levelTic, gameplayIndex, menuIndex, nextMenuIndex, roll, previousTics, tics, visible, refresh, face }));
    assert.ok(held.length >= 250, "the freeze spans more than one HUD timeout");
    assert.equal(new Set(held.map(row => row.levelTic)).size, 1, "level clock stays fixed while the HUD ticks");
    assert.equal(new Set(held.map(row => row.gameplayIndex)).size, 1, "gameplay RNG stays fixed while the HUD ticks");
    assert.ok(new Set(held.map(row => row.face)).size > 1, "the status face rotates while the world is held");
    for (let index = 1; index < held.length; index++) {
        assert.equal(held[index].gameTic, held[index - 1].gameTic + 1, "one HUD update per game tic");
        assert.equal(held[index].menuIndex, held[index - 1].nextMenuIndex, "the status RNG carries to the next tic");
    }
    if (values.upstream) checkNativeHeldHud(path.resolve(root, values.upstream), held);

    console.log(`WAD preview passed HUD glyphs, refresh and timeout, pause and menu compositing, and ${held.length} held-world HUD tics.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-hud-messages-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
