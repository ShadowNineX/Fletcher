// Exercise Doom's STBAR widgets, palette rows, and H toggle through the
// compiled Logic Arrows preview. All WAD data below is synthetic.
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
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-status-"));
const Width = 128, Height = 96;

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

function patch(width, height, index) {
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

function level() {
    // The floor uses palette index 1 and STBAR uses index 10, making the
    // palette shift on both sides of the viewport boundary observable.
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
    const palette = Buffer.alloc(14 * 256 * 3);
    // Direct primary colours deliberately project to distinct Logic Arrows
    // colours. Every row changes the same known source index (10).
    const rowColor = [[128, 0, 128], [0, 255, 0], [0, 255, 0], [0, 255, 0], [0, 255, 0], [0, 255, 0], [0, 255, 0], [0, 255, 0], [0, 255, 0],
        [0, 0, 255], [0, 0, 255], [0, 0, 255], [0, 0, 255], [255, 255, 0]];
    for (let row = 0; row < 14; row++) {
        const offset = row * 256 * 3;
        const world = row === 0 ? [128, 0, 128] : row < 9 ? [255, 0, 0] : row < 13 ? [0, 255, 0] : [0, 0, 255];
        palette.set(world, offset + 1 * 3);
        palette.set(rowColor[row], offset + 10 * 3); // STBAR backing
        for (let digit = 0; digit < 10; digit++) palette.set([255, 255, 255], offset + (40 + digit) * 3);
        palette.set([255, 0, 0], offset + 46 * 3); // tall 6
        palette.set([255, 128, 0], offset + 48 * 3); // tall 8
        palette.set([128, 0, 128], offset + 60 * 3); // short reserve digits
        palette.set([255, 128, 0], offset + 61 * 3); // short 9
        palette.set([255, 0, 0], offset + 62 * 3); // owned shotgun digit
        palette.set([0, 0, 255], offset + 63 * 3); // unowned shotgun digit
        palette.set([255, 255, 0], offset + 64 * 3); // blue card
        palette.set([0, 0, 255], offset + 65 * 3); // blue skull
        palette.set([255, 0, 0], offset + 66 * 3); // damage face
        palette.set([255, 128, 0], offset + 67 * 3); // weapon grin
        palette.set(row === 0 ? [255, 255, 0] : world, offset + 70 * 3); // Doom border flat
        palette.set([0, 255, 0], offset + 71 * 3); // Doom II border flat
        palette.set([255, 255, 255], offset + 72 * 3); // border bevel
    }
    const maps = Buffer.from(Array.from({ length: 33 * 256 }, (_, index) => index & 255));
    const lumps = [["F_START", Buffer.alloc(0)], ["FLOOR0_1", Buffer.alloc(4096, 1)], ["CEIL1_1", Buffer.alloc(4096, 1)], ["F_END", Buffer.alloc(0)],
        ["PLAYPAL", palette], ["COLORMAP", maps], ["STBAR", patch(320, 32, 10)], ["STTPRCNT", patch(8, 14, 49)],
        ["STGNUM3", patch(6, 9, 63)], ["STKEYS0", patch(8, 9, 64)], ["STKEYS3", patch(8, 9, 65)],
        ["STFKILL3", patch(16, 20, 66)], ["STFEVL3", patch(16, 20, 67)]];
    lumps.push(["FLOOR7_2", Buffer.alloc(4096, 70)], ["GRNROCK", Buffer.alloc(4096, 71)]);
    for (const part of ["T", "B", "L", "R", "TL", "TR", "BL", "BR"]) lumps.push([`BRDR_${part}`, patch(8, 8, 72)]);
    for (let digit = 0; digit < 10; digit++) {
        lumps.push([`STTNUM${digit}`, patch(10, 14, 40 + digit)]);
        lumps.push([`STYSNUM${digit}`, patch(6, 8, digit === 3 ? 62 : digit === 9 ? 61 : 60)]);
    }
    return lumps;
}

function previewSource(blocks = 10) {
    const preview = path.join(scratch, `preview-${blocks}`);
    mkdirSync(preview);
    for (const name of readdirSync(path.join(port, "wad-bsp")).filter(name => name.endsWith(".flt"))) {
        let source = readFileSync(path.join(port, "wad-bsp", name), "utf8");
        if (name === "display.flt") {
            assert.match(source, /^const ViewBlocks = 10\b/m);
            source = source.replace(/^const ViewBlocks = 10\b/m, `const ViewBlocks = ${blocks}`);
        }
        if (name === "main.flt") {
            const anchor = "                invisible := weaponUsesFuzz(frame.Contacts.Inventory.Powers[play.PowerInvisibility])";
            assert.ok(source.includes(anchor), "status test hook anchor moved");
            source = source.replace(anchor, `                // Synthetic values isolate the native STBAR widgets and palette policy.
                if gameTime == 2 {
                    frame.Contacts.Inventory.Health = 34
                    frame.Contacts.Inventory.Armor = 56
                    frame.Contacts.Inventory.Ammo[play.AmmoClip] = 78
                    frame.Contacts.Inventory.MaxAmmo[play.AmmoClip] = 99
                    frame.Contacts.Inventory.Cards[play.CardBlue] = true
                    frame.Contacts.Inventory.Cards[play.CardBlueSkull] = true
                    frame.Contacts.Inventory.DamageCount = 1
                }
                if gameTime == 3 {
                    frame.Contacts.Inventory.DamageCount = 0
                    frame.Contacts.Inventory.BonusCount = 1
                    frame.Contacts.Inventory.Weapons[play.WeaponShotgun] = true
                }
                if gameTime == 4 { frame.Contacts.Inventory.BonusCount = 0; frame.Contacts.Inventory.Powers[play.PowerIronFeet] = 200 }
${anchor}`);
            const detailAnchor = "        next lowDetail = selectedDetail";
            assert.ok(source.includes(detailAnchor), "detail selection test hook anchor moved");
            source = source.replace(detailAnchor, `${detailAnchor}
        log("detail-state", selectedDetail)
        if detailChanged { log("detail-selection", selectedDetail) }`);
            const gammaAnchor = "        next gammaLevel = selectedGamma";
            assert.ok(source.includes(gammaAnchor), "gamma selection test hook anchor moved");
            source = source.replace(gammaAnchor, `${gammaAnchor}
        log("gamma-state", selectedGamma)
        if gammaChanged { log("gamma-selection", selectedGamma) }`);
            const drawResult = "return CameraDraw{Valid: true, FuzzPhase: masked.Phase,";
            const drawCommit = "if painted.Valid {";
            assert.ok(source.includes(drawResult) && source.includes(drawCommit), "detail projection test hooks moved");
            source = source.replace("type CameraDraw struct {", `type CameraDraw struct {
    TestDetailShift int
    TestColumns int
    TestPhysicalWidth int`);
            source = source.replace(drawResult, `${drawResult}
        TestDetailShift: view.DetailShift, TestColumns: view.Width, TestPhysicalWidth: window.Width,`);
            source = source.replace(drawCommit, `${drawCommit}
                                log("detail-projection", painted.TestDetailShift, painted.TestColumns, painted.TestPhysicalWidth)`);
            source = source.replace("    tick {", `    tick {
        if currentTick() == 0 {
            view := previewViewWindow(true, configuredViewBlocks)
            log("viewport", view.X, view.Y, view.Width, view.Height)
        }`);
            const resize = "        next viewBlocks = selectedBlocks";
            assert.ok(source.includes(resize), "resize test hook anchor moved");
            source = source.replace(resize, `        if viewChanged || hideStatus != statusHidden {
            log("screen-size", menuBlocks)
        }
${resize}`);
        }
        writeFileSync(path.join(preview, name), source);
    }
    return path.join(preview, "main.flt");
}

function build(entry, commercial = false) {
    const map = level();
    if (commercial) map[0][0] = "MAP01";
    writeFileSync(path.join(scratch, "LEVEL.WAD"), wad([...map, ...resources()]));
    const output = path.join(scratch, "status.json");
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

function pixel(frame, x, y) { return frame[y * Width + x]; }

function tap(sim, key) {
    for (let host = 0; host < 4; host++) sim.step([], new Map(), [key]);
    for (let host = 0; host < 4; host++) sim.step();
}

function waitFor(sim, predicate, description, keys = []) {
    for (let tic = 0; tic < 160; tic++) {
        sim.step([], new Map(), keys);
        if (predicate()) return;
    }
    assert.fail(`${description}: ${JSON.stringify(sim.logs.slice(-10))}`);
}

try {
    const sim = build(previewSource());
    waitFor(sim, () => sim.logs.some(row => row[0] === "Classic WAD BSP frame rendered"), "load the synthetic WAD");

    // At source y=171, the 10x14 tall digits project into display row 85.
    // These points are the interior of ready ammo 78, health 34, and armor 56.
    waitFor(sim, () => pixel(screen(sim), 1, 90) === 4, "draw the damage palette");
    const damage = screen(sim);
    assert.equal(pixel(damage, 1, 90), 4, "damage palette row tints the known STBAR source index green");
    assert.equal(pixel(damage, 64, 80), 1, "the damage row also tints the textured floor above STBAR");
    assert.equal(pixel(damage, 1, 81), 4, "the status bar starts on row 81");
    assert.equal(pixel(damage, 15, 85), 5, "ready ammo 78 draws the orange tall 8 over STBAR");
    assert.equal(pixel(damage, 33, 85), 0, "health 34 draws the white tall 4 over STBAR");
    assert.equal(pixel(damage, 85, 85), 1, "armor 56 draws the red tall 6 over STBAR");
    assert.equal(pixel(damage, 97, 84), 2, "the blue skull replaces the yellow card of the same key type");
    assert.equal(pixel(damage, 51, 84), 2, "the unowned shotgun uses its gray-number patch");
    assert.equal(pixel(damage, 125, 84), 5, "the visible maximum ammo 99 uses the short 9 patch");
    assert.equal(pixel(damage, 58, 85), 1, "the face shows a pain-level-three rampage after damage");

    waitFor(sim, () => pixel(screen(sim), 1, 90) === 2, "bonus palette row");
    const bonus = screen(sim);
    assert.equal(pixel(bonus, 51, 84), 1, "owning the shotgun switches to the colored number patch");
    assert.equal(pixel(bonus, 58, 85), 5, "picking up a new weapon replaces the damage face with the grin");
    waitFor(sim, () => pixel(screen(sim), 1, 90) === 3, "radiation palette row");

    const shown = screen(sim);
    sim.step([], new Map(), [8]); // H: hide the status bar.
    sim.step([], new Map(), [8]); // Holding H keeps the bar hidden.
    sim.step(); // release so a later H press is a distinct toggle.
    const hidden = screen(sim);
    assert.notEqual(pixel(shown, 1, 90), pixel(hidden, 1, 90), "H replaces the STBAR backing at the status region");
    assert.notEqual(pixel(hidden, 1, 90), 3, "the radiation-tinted STBAR is absent after H hides it");
    assert.equal(pixel(hidden, 64, 90), 2, "the textured floor retains the radiation row in full-screen view");

    sim.step([], new Map(), [8]);
    sim.step();
    const restored = screen(sim);
    assert.equal(pixel(restored, 1, 90), 3, "a second H press restores the active palette STBAR");
    assert.equal(pixel(restored, 15, 85), 5, "widget pixels are restored with the status bar");

    // Five stock screen blocks are 160×80 at (80,44) in Doom's 320×200
    // viewport. Scaling the two corners gives (32,22) through (96,60).
    const entry = previewSource(5);
    for (const commercial of [false, true]) {
        const narrow = build(entry, commercial);
        waitFor(narrow, () => narrow.logs.some(row => row[0] === "Classic WAD BSP frame rendered"), "render the windowed view");
        assert.deepEqual(narrow.logs.find(row => row[0] === "viewport"), ["viewport", 32, 22, 64, 38]);
        const opening = screen(narrow);
        const border = commercial ? 4 : 3;
        assert.equal(pixel(opening, 0, 20), border, "the active campaign supplies its own border flat");
        assert.equal(pixel(opening, 30, 20), 0, "the corner patch reaches the left and top edges");
        assert.equal(pixel(opening, 64, 21), 0, "the top bevel stops at the scene");
        assert.equal(pixel(opening, 64, 59), 6, "the floor reaches the last scene row");
        assert.equal(pixel(opening, 64, 60), 0, "the bottom bevel starts below the scene");
        assert.equal(pixel(opening, 95, 56), 5, "the wall reaches the last scene column");
        assert.equal(pixel(opening, 96, 56), 0, "the right bevel starts outside the scene");
        assert.equal(pixel(opening, 1, 90), 6, "the status bar still fills the screen width");

        waitFor(narrow, () => pixel(screen(narrow), 1, 90) === 4, "refresh the border on damage");
        const damaged = screen(narrow);
        assert.equal(pixel(damaged, 0, 20), commercial ? border : 1, "the cached border follows PLAYPAL changes");
        assert.equal(pixel(damaged, 64, 59), 1, "the floor uses the same palette row");
        narrow.step([], new Map(), [8]);
        narrow.step();
        assert.notEqual(pixel(screen(narrow), 64, 21), 0, "H covers the border with the full-screen scene");
        narrow.step([], new Map(), [8]);
        narrow.step();
        assert.equal(pixel(screen(narrow), 64, 21), 0, "H restores the window and bevel");

        narrow.step([], new Map(), [25]); // Y: save the bordered frame.
        waitFor(narrow, () => narrow.logs.some(row => row[0] === "Doom checkpoint saved"), "save the windowed view");
        const saved = screen(narrow);
        narrow.roundTripScriptState();
        narrow.step([], new Map(), [8]);
        narrow.step();
        assert.notDeepEqual(screen(narrow), saved, "the full-screen view differs from the checkpoint");
        narrow.step([], new Map(), [12]); // L: restore the checkpoint.
        waitFor(narrow, () => narrow.logs.some(row => row[0] === "Doom checkpoint loaded"), "restore the windowed view");
        assert.deepEqual(screen(narrow), saved, "the checkpoint restores the exact viewport, border, and status pixels");
        if (commercial) continue;

        tap(narrow, 20); // T: open the campaign menu.
        waitFor(narrow, () => narrow.logs.some(([tag]) => tag === "Doom campaign menu opened"), "open the windowed menu");
        const detailSelections = () => narrow.logs.filter(([tag]) => tag === "detail-selection").map(([, selected]) => selected);
        const detailStates = () => narrow.logs.filter(([tag]) => tag === "detail-state").map(([, selected]) => selected);
        const gammaSelections = () => narrow.logs.filter(([tag]) => tag === "gamma-selection").map(([, selected]) => selected);
        const gammaStates = () => narrow.logs.filter(([tag]) => tag === "gamma-state").map(([, selected]) => selected);
        assert.equal(gammaStates().at(-1), 0, "the campaign starts at Doom gamma row zero");
        const gammaBefore = gammaSelections().length;
        for (let host = 0; host < 12; host++) narrow.step([], new Map(), [10]); // Held J.
        narrow.step();
        assert.deepEqual(gammaSelections().slice(gammaBefore), [1], "held J advances gamma once while the menu is open");
        for (let row = 0; row < 4; row++) tap(narrow, 10);
        assert.deepEqual(gammaSelections().slice(-4), [2, 3, 4, 0], "J cycles all five gamma settings and wraps");
        tap(narrow, 20);
        const gammaOutside = gammaSelections().length;
        const gammaStateOutside = gammaStates().at(-1);
        tap(narrow, 10);
        assert.equal(gammaSelections().length, gammaOutside, "J outside the menu remains the message-recall control");
        assert.equal(gammaStates().at(-1), gammaStateOutside, "message recall does not change gamma");
        tap(narrow, 20);
        const detailBefore = detailSelections().length;
        for (let host = 0; host < 12; host++) narrow.step([], new Map(), [7]); // Held G.
        narrow.step();
        assert.deepEqual(detailSelections().slice(detailBefore), [true], "held G changes detail once while the menu is open");
        assert.deepEqual(narrow.logs.findLast(([tag]) => tag === "detail-projection"),
            ["detail-projection", 1, 32, 64], "changing detail redraws the menu backdrop with paired columns");
        tap(narrow, 20);
        const outsideDetail = detailSelections().length;
        for (let host = 0; host < 12; host++) narrow.step([], new Map(), [7]);
        narrow.step();
        assert.equal(detailSelections().length, outsideDetail, "G outside the menu remains the automap-grid control");
        tap(narrow, 20);
        assert.equal(pixel(screen(narrow), 25, 66), 5, "the A in the screen-size label is painted");
        tap(narrow, 10);
        assert.equal(gammaStates().at(-1), 1, "change gamma after saving the checkpoint");
        const sizes = () => narrow.logs.filter(([tag]) => tag === "screen-size").map(([, size]) => size);
        const previous = sizes().length;
        for (let tick = 0; tick < 4; tick++) narrow.step([], new Map(), [4]); // Held D.
        narrow.step();
        assert.deepEqual(sizes().slice(previous), [6], "a held resize key adjusts one step");
        tap(narrow, 20);
        assert.notEqual(pixel(screen(narrow), 64, 62), 0, "the larger live view replaces the old bottom bevel");
        tap(narrow, 8);
        tap(narrow, 8);
        assert.deepEqual(sizes().slice(-2), [11, 6], "H returns to the live selection");

        tap(narrow, 20);
        for (let press = 0; press < 5; press++) tap(narrow, 1);
        assert.deepEqual(sizes().slice(-3), [5, 4, 3], "the slider stops at three blocks");
        for (let press = 0; press < 10; press++) tap(narrow, 4);
        assert.deepEqual(sizes().slice(-8), [4, 5, 6, 7, 8, 9, 10, 11], "the slider stops at full screen");
        tap(narrow, 1);
        assert.equal(sizes().at(-1), 10, "decreasing from full screen restores the status bar");
        tap(narrow, 20);
        assert.equal(gammaStates().at(-1), 1, "the changed gamma remains active before loading");
        waitFor(narrow, () => narrow.logs.filter(([tag]) => tag === "Doom checkpoint loaded").length === 2,
            "restore the checkpoint after moving the slider", [12]);
        assert.deepEqual(screen(narrow), saved, "loading restores the saved five-block frame after runtime resizing");
        narrow.step();
        assert.equal(detailStates().at(-1), false, "the checkpoint restores the saved high-detail setting");
        assert.equal(gammaStates().at(-1), 0, "the checkpoint restores the saved gamma setting");
        tap(narrow, 8);
        tap(narrow, 8);
        assert.deepEqual(sizes().slice(-2), [11, 5], "the checkpoint also restores the saved screen size");
        const compact = build(previewSource(3), false);
        waitFor(compact, () => compact.logs.some(([tag]) => tag === "Classic WAD BSP frame rendered"), "render the compact detail fixture");
        const oddOpening = screen(compact);
        tap(compact, 20); // T: open the campaign menu.
        waitFor(compact, () => compact.logs.some(([tag]) => tag === "Doom campaign menu opened"), "open the compact menu");
        tap(compact, 7); // G: select low detail while the menu is open.
        assert.equal(compact.logs.filter(([tag, selected]) => tag === "detail-selection" && selected).length, 1,
            "compact low-detail selection reaches the runtime state");
        assert.deepEqual(compact.logs.findLast(([tag]) => tag === "detail-projection"),
            ["detail-projection", 1, 19, 38], "the compact viewport uses whole column pairs");
        tap(compact, 20);
        assert.ok(compact.logs.some(([tag]) => tag === "Doom campaign menu closed"));
        const compactFrame = screen(compact);
        assert.equal(pixel(compactFrame, 83, 48), pixel(compactFrame, 100, 48),
            "the border flat fills the unpaired rightmost column");
        assert.notEqual(pixel(oddOpening, 83, 48), pixel(oddOpening, 100, 48),
            "the same column belongs to the scene in high detail");
    }
    console.log("WAD preview passed STBAR widgets, palette flashes, Doom and Doom II borders, runtime sizing and detail, and exact viewport checkpoint restoration.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-status-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
