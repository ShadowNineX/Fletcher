// Exercise the live automap through the compiled Logic Arrows preview.  Every
// lump here is generated test data; no Doom WAD or art is checked into the repo.
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
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-automap-"));
const Width = 128, Height = 96;
const Mapped = 0x100, DontDraw = 0x80;

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

function line(a, b, flags, front) { return words([a, b, flags, 0, 0, front, 0xffff]); }

function level(remoteFlags, includeActor = false) {
    // The first four lines form the rendered room. The two remote lines are
    // intentionally absent from SEGS: one is only shown by ML_MAPPED or the
    // computer-map power, and ML_DONTDRAW must suppress the other forever.
    const vertices = words([-128, -64, -128, 64, 128, 64, 128, -64, 256, -64, 256, 64, 512, -64, 512, 64]);
    const lines = Buffer.concat([
        line(0, 1, 0, 0), line(1, 2, 0, 1), line(2, 3, 0, 2), line(3, 0, 0, 3),
        line(4, 5, remoteFlags, 4), line(6, 7, remoteFlags | DontDraw, 5),
    ]);
    const sides = Buffer.alloc(6 * 30);
    for (let index = 0; index < 6; index++) sides.writeUInt16LE(0, index * 30 + 28);
    const segs = Buffer.concat([[0, 1, 0x4000, 0, 0, 0], [1, 2, 0, 1, 0, 0],
        [2, 3, 0xc000, 2, 0, 0], [3, 0, 0x8000, 3, 0, 0]].map(value => words(value)));
    const sector = Buffer.alloc(26);
    sector.writeInt16LE(128, 2); sector.write("FLOOR0_1", 4); sector.write("CEIL1_1", 12); sector.writeInt16LE(160, 20);
    const things = includeActor ? [0, 0, 0, 1, 7, 64, 0, 0, 3004, 7] : [0, 0, 0, 1, 7];
    return [["E1M1", Buffer.alloc(0)], ["THINGS", words(things)], ["LINEDEFS", lines], ["SIDEDEFS", sides],
        ["VERTEXES", vertices], ["SEGS", segs], ["SSECTORS", words([4, 0])], ["NODES", Buffer.alloc(0)],
        ["SECTORS", sector], ["REJECT", Buffer.alloc(1)], ["BLOCKMAP", words([-128, -128, 2, 2, 8, 8, 8, 8, 0, 1, 2, 3, -1])]];
}

function resources(withCustomTitle = true) {
    const palette = Buffer.alloc(256 * 3);
    // Strong primary palette entries ensure ordinary world and automap lines
    // remain observable after the host's native color projection.
    const colors = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 128, 0], [128, 0, 128], [255, 255, 255]];
    for (let index = 0; index < 256; index++) palette.set(colors[index & 7], index * 3);
    palette.set([0, 0, 0], 0);       // automap background
    palette.set([255, 0, 0], 176 * 3); // one-sided wall
    palette.set([128, 0, 128], 104 * 3); // grid
    palette.set([255, 255, 255], 99 * 3); // all-map-only wall
    palette.set([0, 255, 0], 209 * 3); // player arrow
    palette.set([0, 255, 0], 112 * 3); // IDDT actor triangles
    palette.set([255, 128, 0], 96 * 3); // crosshair
    const lumps = [["F_START", Buffer.alloc(0)], ["FLOOR0_1", Buffer.alloc(4096, 2)], ["CEIL1_1", Buffer.alloc(4096, 3)], ["F_END", Buffer.alloc(0)],
        ["PLAYPAL", palette], ["COLORMAP", Buffer.from(Array.from({ length: 33 * 256 }, (_, i) => i & 255))],
        ["M_PAUSE", patch(10, 8, 4)], ["AMMNUM0", patch(5, 7, 3)]];
    if (withCustomTitle) {
        // User-supplied metadata. No stock Doom title or artwork is present.
        lumps.push(["AMTITLE", Buffer.from("TEST MAP\0")]);
    } else {
        // The only WILV patch identifies E1M1, proving the per-map fallback.
        lumps.push(["WILV00", patch(15, 7, 17)]);
    }
    for (let code = 33; code <= 95; code++) lumps.push(["STCFN" + String(code).padStart(3, "0"), patch(5, 7, 17)]);
    return lumps;
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

function previewSource() {
    const preview = path.join(scratch, "preview");
    mkdirSync(preview);
    for (const name of readdirSync(path.join(port, "wad-bsp")).filter(name => name.endsWith(".flt"))) {
        let source = readFileSync(path.join(port, "wad-bsp", name), "utf8");
        if (name === "main.flt") {
            assert.match(source, /register mapView automap\.View/, "automap preview state is exposed");
            assert.match(source, /register automapActive bit/, "automap visibility is exposed");
            assert.match(source, /next mapView = updatedMapView/, "automap input is committed once per preview tic");
            const held = "                    redraw := mapChanged ||";
            assert.equal(source.split(held).length, 2, "trace the held-world automap");
            source = source.replace(held, `                    log("held-map", mapOpen, updatedMapView.Follow, updatedMapView.Grid,
                        updatedMapView.Full, updatedMapView.Window.X, updatedMapView.Window.Y, updatedMapView.Window.Scale,
                        updatedMapMarks.Count, levelTime, player.Body.X, player.Body.Y, player.Angle, lightState.Random.GameplayIndex)
${held}`);
            const allMap = "                    allMap := frame.Contacts.Inventory.Powers[play.PowerAllMap] != 0";
            assert.ok(source.includes(allMap), "computer-map hook moved");
            source = source.replace(allMap, `                    // Test-only grant: this copied preview never reaches the repository.
                    if fire { frame.Contacts.Inventory.Powers[play.PowerAllMap] = 100 }
                    log("automap-grant", fire, frame.Contacts.Inventory.Powers[play.PowerAllMap])
${allMap}`);
            const anchor = "                invisible := weaponUsesFuzz(frame.Contacts.Inventory.Powers[play.PowerInvisibility])";
            assert.ok(source.includes(anchor), "automap preview test hook anchor moved");
            source = source.replace(anchor, `                // Test-only computer-map grant and state trace; this source is copied to temp.
                log("automap-state", automapActive, mapView.Follow, mapView.Grid, mapView.Full,
                    mapView.Window.X, mapView.Window.Y, mapView.Window.Scale)
${anchor}`);
        }
        writeFileSync(path.join(preview, name), source);
    }
    return path.join(preview, "main.flt");
}

function build(entry, flags, name, withCustomTitle = true, includeActor = false) {
    writeFileSync(path.join(scratch, "LEVEL.WAD"), wad([...level(flags, includeActor), ...resources(withCustomTitle)]));
    const output = path.join(scratch, `${name}.json`);
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
function count(frame, color) { return frame.reduce((total, pixel) => total + (pixel === color), 0); }
function titlePixels(frame) {
    return frame.reduce((total, pixel, index) => total + (pixel === 1 && Math.floor(index / Width) >= 76), 0);
}

function start(sim) {
    for (let host = 0; host < 120 && !sim.logs.some(row => row[0] === "Classic WAD BSP frame rendered"); host++) sim.step();
    assert.ok(sim.logs.some(row => row[0] === "Classic WAD BSP frame rendered"), JSON.stringify(sim.logs.slice(-12)));
}

function press(sim, key) { sim.step([], new Map(), [key]); sim.step(); }
function typeIddt(sim) {
    // The native sequence is rising I, D, D, T; release every key so held D
    // cannot satisfy the sequence repeatedly.
    for (const key of [9, 4, 4, 20]) press(sim, key);
}
function state(sim) { return sim.logs.filter(row => row[0] === "automap-state").at(-1); }
function holdForLog(sim, key, name, expected) {
    for (let host = 0; host < 12; host++) {
        sim.step([], new Map(), [key]);
        const row = sim.logs.filter(entry => entry[0] === name).at(-1);
        if (row && row.at(-1) === expected) return screen(sim);
    }
    assert.fail(`held key ${key} did not produce ${name}=${expected}: ${JSON.stringify(sim.logs.slice(-12))}`);
}

function checkPausedAutomap(sim) {
    const rows = () => sim.logs.filter(([tag]) => tag === "held-map");
    function decodeState([, open, follow, grid, full, x, y, scale, marks, level, playerX, playerY, angle, random]) {
        return { open, follow, grid, full, x, y, scale, marks, world: [level, playerX, playerY, angle, random] };
    }
    function command(key, accepted) {
        const before = rows().length;
        for (let host = 0; host < 50; host++) {
            sim.step([], new Map(), [key]);
            if (rows().length > before && accepted(decodeState(rows().at(-1)))) {
                const next = decodeState(rows().at(-1));
                for (let tick = 0; tick < 6; tick++) sim.step();
                return next;
            }
        }
        assert.fail(`paused automap key ${key}: ${JSON.stringify(sim.logs.slice(-12))}`);
    }
    const frozen = command(16, view => !view.open);
    const ordinary = screen(sim);
    const opened = command(13, view => view.open);
    assert.notDeepEqual(screen(sim), ordinary, "M draws the automap during pause");
    assert.equal(screen(sim)[2 * Width + 51], 3, "the pause patch remains on top of the map");
    assert.equal(opened.follow, false, "reopening retains free roaming mode");
    const following = command(21, view => view.follow);
    const zoomed = command(26, view => view.scale > following.scale);
    assert.deepEqual(decodeState(rows().at(-1)), zoomed, "stationary follow stays at the selected zoom");
    command(21, view => !view.follow);
    const panned = command(23, view => view.y > zoomed.y);
    command(7, view => view.grid !== panned.grid);
    command(14, view => view.marks === 1);
    command(22, view => view.marks === 0);
    const beforeFull = decodeState(rows().at(-1));
    const full = command(2, view => view.full);
    assert.ok(full.scale < beforeFull.scale, "B fits the full level during pause");
    const restored = command(2, view => !view.full);
    assert.deepEqual([restored.x, restored.y], [beforeFull.x, beforeFull.y]);
    const mappedPixelsBeforeClose = screen(sim);
    const closed = command(13, view => !view.open);
    assert.deepEqual(closed.world, frozen.world);
    assert.notDeepEqual(screen(sim), mappedPixelsBeforeClose, "closing the automap restores the paused view");
    for (const row of rows()) assert.deepEqual(decodeState(row).world, frozen.world, "map controls hold the gameplay clock, actor and RNG");
    press(sim, 16);
    assert.ok(sim.logs.some(([tag]) => tag === "Doom resumed"), "P resumes with the automap closed");
}

try {
    const entry = previewSource();
    const hidden = build(entry, 0, "hidden");
    const mapped = build(entry, Mapped, "mapped");
    const dontDraw = build(entry, Mapped | DontDraw, "dontdraw");
    for (const sim of [hidden, mapped, dontDraw]) start(sim);

    const ordinary = screen(hidden);
    press(hidden, 13); // M: open automap.
    press(mapped, 13);
    press(dontDraw, 13);
    // Frame the complete synthetic level so deliberately remote lines are in
    // the viewport rather than merely present in the WAD bounds.
    press(hidden, 2); // B: full map.
    press(mapped, 2);
    press(dontDraw, 2);
    const hiddenMap = screen(hidden), mappedMap = screen(mapped), dontDrawMap = screen(dontDraw);
    assert.notDeepEqual(hiddenMap, ordinary, "M replaces the ordinary 3D view with the automap");
    assert.ok(count(hiddenMap, 1) > 0, "segments seen by the BSP renderer use the visible red wall color");
    assert.notDeepEqual(mappedMap, hiddenMap, "ML_MAPPED draws an authored-but-not-rendered remote line");
    assert.deepEqual(dontDrawMap, hiddenMap, "ML_DONTDRAW suppresses a line even when it is also ML_MAPPED");
    assert.ok(titlePixels(hiddenMap) > 0, "the mounted AMTITLE text is drawn above the original status-bar line");

    const patchTitle = build(entry, 0, "patch-title", false);
    start(patchTitle);
    press(patchTitle, 13); // M: open automap.
    assert.ok(titlePixels(screen(patchTitle)) > 0, "E1M1 selects the mounted WILV00 title patch when AMTITLE is absent");

    // IDDT is an automap-only rising-key sequence. Use a separate fixture with
    // one sector-linked monster so reveal mode 2 can be distinguished from the
    // all-lines mode without changing the earlier rendering assertions.
    const iddt = build(entry, 0, "iddt", true, true);
    start(iddt);
    press(iddt, 16); // P: freeze player/camera before exercising reveal state.
    press(iddt, 13); // M: open automap.
    press(iddt, 2);  // B: frame the remote lines and actor.
    const iddtNormal = screen(iddt);
    const normalActors = count(iddtNormal, 4);
    press(iddt, 9);  // Wrong/incomplete input must not reveal anything.
    press(iddt, 24); // X is an unrelated rising key and must reset the sequence.
    press(iddt, 4);
    press(iddt, 4);
    assert.equal(count(screen(iddt), 1), count(iddtNormal, 1), "an interrupted IDDT sequence resets");
    press(iddt, 20); // Ordinary T still opens the campaign menu outside IDDT.
    assert.ok(iddt.logs.some(row => row[0] === "Doom campaign menu opened"), "ordinary T remains the menu fallback");
    press(iddt, 20); // Close the fallback menu before typing the valid sequence.
    assert.ok(iddt.logs.some(row => row[0] === "Doom campaign menu closed"), "ordinary T closes its fallback menu");
    typeIddt(iddt); // mode 0 -> 1: all lines, including ML_DONTDRAW.
    const iddtAllLines = screen(iddt);
    assert.ok(count(iddtAllLines, 1) > count(iddtNormal, 1), "IDDT mode 1 reveals additional walls");
    const allLineActors = count(iddtAllLines, 4);
    typeIddt(iddt); // mode 1 -> 2: lines plus sector-linked actor triangles.
    const iddtActors = screen(iddt);
    assert.ok(count(iddtActors, 4) > allLineActors || iddtActors.some((pixel, index) => pixel === 4 && iddtAllLines[index] !== 4),
        "IDDT mode 2 reveals sector-linked actors in the projected green palette");
    assert.ok(count(iddtActors, 1) >= count(iddtAllLines, 1), "IDDT mode 2 retains all revealed lines");
    press(iddt, 13); // close, then reopen without clearing the selected mode.
    press(iddt, 13);
    assert.ok(count(screen(iddt), 4) > normalActors, "closing and reopening preserves IDDT reveal mode");
    typeIddt(iddt); // mode 2 -> 0: exact normal reveal.
    assert.deepEqual(screen(iddt), iddtNormal, "IDDT mode 0 restores the normal paused automap pixels");

    // The remote unflagged line is behind the renderer's SEGS. It only appears
    // after the test-only computer-map grant, proving all-map reveal is not the
    // same thing as normal R_StoreWallRange visibility.
    const allMap = holdForLog(hidden, 18, "automap-grant", 100); // R: test-only PowerAllMap injection.
    assert.notDeepEqual(allMap, hiddenMap, "computer-map power reveals the otherwise hidden remote line");
    hidden.step(); // release R before later input.

    const opened = state(mapped);
    assert.equal(opened[1], true, "M records the active automap state");
    press(mapped, 7); // G: grid.
    assert.equal(state(mapped)[3], true, "G toggles the grid on its rising edge");
    assert.notDeepEqual(screen(mapped), mappedMap, "grid draws over the map without leaving automap mode");
    press(mapped, 21); // U: disable follow and permit panning.
    const free = state(mapped);
    assert.equal(free[2], false, "U disables follow mode");
    press(mapped, 23); // W: pan north while follow is off (and consume gameplay movement).
    const panned = state(mapped);
    assert.notEqual(panned[6], free[6], "W pans the free automap window");
    press(mapped, 26); // Z: zoom in.
    const zoomed = state(mapped);
    assert.ok(Number(zoomed[7]) > Number(panned[7]), "Z increases the automap scale");
    press(mapped, 3); // C: zoom out.
    assert.ok(Number(state(mapped)[7]) < Number(zoomed[7]), "C reverses the zoom direction");

    press(mapped, 13); // M: close automap.
    assert.equal(state(mapped)[1], false, "second M closes the automap");
    assert.ok(mapped.logs.some(row => row[0] === "Doom automap closed"), "closing reports the native automap event");
    assert.notDeepEqual(screen(mapped), mappedMap, "closing restores ordinary 3D rendering rather than leaving the map framebuffer");

    checkPausedAutomap(mapped);

    console.log("WAD preview passed automap rendering, live and paused controls, and a frozen world during paused exploration.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-automap-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
