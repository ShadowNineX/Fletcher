// Exercise both finale paths with generated WAD text, patches, and sprites.
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
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-finale-"));

function words(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => bytes.writeUInt16LE(value & 65535, index * 2));
    return bytes;
}

function wad(lumps) {
    const directory = 12 + lumps.reduce((length, [, bytes]) => length + bytes.length, 0);
    const result = Buffer.alloc(directory + lumps.length * 16);
    result.write("PWAD"); result.writeInt32LE(lumps.length, 4); result.writeInt32LE(directory, 8);
    let offset = 12;
    for (const [index, [name, bytes]] of lumps.entries()) {
        const entry = directory + index * 16;
        result.writeInt32LE(offset, entry); result.writeInt32LE(bytes.length, entry + 4); result.write(name, entry + 8);
        bytes.copy(result, offset); offset += bytes.length;
    }
    return result;
}

function solidPatch(width, height, color) {
    const firstColumn = 8 + width * 4, columnSize = height + 5;
    const result = Buffer.alloc(firstColumn + width * columnSize);
    result.writeInt16LE(width, 0); result.writeInt16LE(height, 2);
    for (let column = 0; column < width; column++) {
        const offset = firstColumn + column * columnSize;
        result.writeUInt32LE(offset, 8 + column * 4);
        result[offset + 1] = height;
        result.fill(color, offset + 3, offset + 3 + height);
        result[offset + 4 + height] = 255;
    }
    return result;
}

function tinyMus() {
    const score = Buffer.from([0x40, 0x00, 0x90, 0xbc, 100, 4, 0x60]);
    const result = Buffer.alloc(16 + score.length);
    result.write("MUS\x1a"); result.writeUInt16LE(score.length, 4); result.writeUInt16LE(16, 6);
    result.writeUInt16LE(1, 8); score.copy(result, 16);
    return result;
}

function terminalLevel(name) {
    const vertices = words([-64, -64, 64, -64, 64, 64, -64, 64]);
    const lines = Buffer.concat([[0, 1], [2, 1], [2, 3], [3, 0]].map(([first, last], index) =>
        words([first, last, 0, index === 1 ? 11 : 0, 0, index === 3 ? 1 : 0, 65535])));
    const sides = Buffer.alloc(60);
    sides.writeInt16LE(1, 30 + 28);
    const sector = Buffer.alloc(26);
    sector.writeInt16LE(128, 2); sector.write("MFLR8_4", 4); sector.write("CEIL1_1", 12); sector.writeInt16LE(160, 20);
    return [[name, Buffer.alloc(0)], ["THINGS", words([0, 0, 0, 1, 7])], ["LINEDEFS", lines], ["SIDEDEFS", sides],
        ["VERTEXES", vertices], ["SEGS", Buffer.concat([[0, 1], [1, 2], [2, 3], [3, 0]].map(([first, last], index) =>
            words([first, last, 0, index, 0, 0])))], ["SSECTORS", words([4, 0])], ["NODES", Buffer.alloc(0)],
        ["SECTORS", Buffer.concat([sector, sector])], ["REJECT", Buffer.alloc(1)], ["BLOCKMAP", words([-64, -64, 1, 1, 5, 0, 1, 2, 3, -1])]];
}

function finalResources(flat) {
    const palette = Buffer.alloc(256 * 3);
    palette.set([255, 0, 0], 3); palette.set([255, 255, 255], 6); palette.set([0, 0, 255], 9);
    palette.set([255, 255, 0], 12); palette.set([0, 255, 0], 15); palette.set([128, 0, 128], 18);
    return [["F_START", Buffer.alloc(0)], [flat, Buffer.alloc(4096, 1)], ["F_END", Buffer.alloc(0)],
        ["PLAYPAL", palette], ["COLORMAP", Buffer.from(Array.from({ length: 33 * 256 }, (_, index) => index & 255))],
        ["STCFN065", solidPatch(16, 16, 2)], ["STCFN066", solidPatch(16, 16, 5)], ["INTERPIC", solidPatch(320, 200, 3)],
        ["M_PAUSE", solidPatch(10, 8, 5)]];
}

function episodeWad(withOpening = false) {
    return wad([...terminalLevel("E3M8"), ...finalResources("MFLR8_4"), ["D_VICTOR", tinyMus()], ["E3TEXT", Buffer.from("a\0B")],
        ["PFUB1", solidPatch(320, 200, 3)], ["PFUB2", solidPatch(320, 200, 4)],
        ["END0", solidPatch(16, 16, 5)], ["END6", solidPatch(16, 16, 6)],
        // Keep E3M8 first for the standalone WAD startup.
        ...(withOpening ? terminalLevel("E3M1") : [])]);
}

function castWad() {
    const frames = Array.from("ABCDEFGHIJKL", (name, index) => [`POSS${name}0`, solidPatch(16, 16, index < 7 ? 5 : 3)]);
    return wad([...terminalLevel("MAP30"), ...finalResources("RROCK17"), ["D_EVIL", tinyMus()], ["BOSSBACK", solidPatch(320, 200, 1)],
        ["FCAST00", Buffer.from("A")], ["S_START", Buffer.alloc(0)], ...frames, ["S_END", Buffer.alloc(0)]]);
}

function previewSource() {
    const preview = path.join(scratch, "preview");
    mkdirSync(preview);
    for (const name of readdirSync(path.join(port, "wad-bsp")).filter(name => name.endsWith(".flt"))) {
        let source = readFileSync(path.join(port, "wad-bsp", name), "utf8");
        if (name === "main.flt") {
            const tick = "    tick {";
            assert.ok(source.includes(tick));
            source = source.replace(tick, `${tick}
        log("finale-tic", finale.Stage, finale.Tics, finale.EndFrame, finale.Cast.Index, finale.Cast.State, finale.Cast.Dying, gameTime, automapActive, gamePaused, soundtrack.Active, soundtrackPaused, soundtrack.Cursor.Position, soundtrackId)
        log("wipe-frame", screenWipe.Melt.Active, finale.Stage, finale.Tics, screenWipe.Melt.Rows[0], screenWipe.Melt.Rows[1], campaignMenu.Stage)`);
            const exit = "                        next levelExited = true";
            const music = "            next soundtrackId = requestedTrack";
            for (const anchor of [exit, music]) assert.equal(source.split(anchor).length, 2);
            source = source.replace(exit, `                        log("finale-exit-clock", gameTime, automapActive)\n${exit}`)
                .replace(music, `            log("finale-music-clock", requestedTrack, gameTime)\n${music}`);
        }
        writeFileSync(path.join(preview, name), source);
    }
    return path.join(preview, "main.flt");
}

function build(entry, archive) {
    const output = path.join(scratch, "finale.json");
    writeFileSync(path.join(scratch, "LEVEL.WAD"), archive);
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
}

function rows(sim) {
    return sim.logs.filter(row => row[0] === "finale-tic").map(([, stage, tics, endFrame, index, state, dying, gameTic, automap, paused, active, soundtrackIsPaused, cursor, track]) =>
        ({ stage, tics, endFrame, index, state, dying, gameTic, automap, paused, active, soundtrackIsPaused, cursor, track }));
}

function wipeRows(sim) {
    return sim.logs.filter(row => row[0] === "wipe-frame").map(([, active, stage, tics, first, second, menu]) =>
        ({ active: Boolean(active), stage: Number(stage), tics: Number(tics), first: Number(first), second: Number(second), menu }));
}

function stepUntil(sim, keys, predicate, message) {
    for (let host = 0; host < 1300 && !predicate(); host++) sim.step([], new Map(), keys);
    assert.ok(predicate(), `${message}: ${JSON.stringify(sim.logs.slice(-12))}`);
}

function press(sim, key) { sim.step([], new Map(), [key]); sim.step(); }

function pulseUntil(sim, predicate, message) {
    for (let host = 0; host < 1300 && !predicate(); host++) sim.step([], new Map(), host % 16 < 8 ? [] : [6]);
    assert.ok(predicate(), `${message}: ${JSON.stringify(sim.logs.slice(-12))}`);
}

const colorAt = (sim, x, y) => sim.tileAt({ x, y }).extra;

function viewportColors(sim) {
    const colors = new Set();
    for (let y = -48; y < 48; y++) for (let x = -64; x < 64; x++) colors.add(colorAt(sim, x, y));
    return colors;
}

function verifyWipe(sim, colors, message, keys = []) {
    let mixed = false, observed = false;
    const observedColors = new Set();
    for (let host = 0; host < 1300; host++) {
        sim.step([], new Map(), keys);
        const wipe = wipeRows(sim).at(-1);
        if (wipe?.active) {
            observed = true;
            const visible = viewportColors(sim);
            for (const color of visible) observedColors.add(color);
            if (colors.every(color => visible.has(color))) mixed = true;
        }
        if (observed && wipe && !wipe.active) break;
    }
    assert.ok(observed, `${message}: no active melt frame`);
    assert.ok(mixed, `${message}: no intermediate frame contained ${colors.join(" and ")}, saw ${[...observedColors].join(",")}`);
    assert.equal(wipeRows(sim).at(-1)?.active, false, `${message}: melt did not complete`);
}

function exitLevel(sim, fromAutomap = false) {
    for (let host = 0; host < 50; host++) sim.step([], new Map(), [23]);
    if (fromAutomap) stepUntil(sim, [13], () => sim.logs.some(row => row[0] === "Doom automap opened"), "open the automap before using the exit");
    stepUntil(sim, [6], () => sim.logs.some(row => row[0] === "Doom level exit requested"), "use the terminal exit");
}

function castWipes(sim) {
    const history = wipeRows(sim);
    return history.filter((wipe, index) => wipe.active && wipe.stage === 3 && !history[index - 1]?.active);
}

function freshCast(entry) {
    const sim = build(entry, castWad());
    exitLevel(sim);
    pulseUntil(sim, () => sim.logs.some(row => row[0] === "Doom story finale requested"), "reach MAP30 story");
    verifyWipe(sim, [2, 1], "fresh MAP30 intermission-to-story transition");
    stepUntil(sim, [6], () => sim.logs.some(row => row[0] === "Doom cast finale requested"), "enter fresh MAP30 cast");
    verifyWipe(sim, [1, 4], "fresh MAP30 story-to-cast transition", [6]);
    stepUntil(sim, [], () => !wipeRows(sim).at(-1)?.active, "finish fresh cast wipe");
    return sim;
}

try {
    const entry = previewSource();
    const episodeText = path.join(scratch, "E3TEXT.txt");
    writeFileSync(episodeText, "b\0A");
    const sim = build(entry, episodeWad());
    rmSync(episodeText);
    exitLevel(sim, true);
    const [, exitTic, mapWasOpen] = sim.logs.find(row => row[0] === "finale-exit-clock");
    assert.ok(mapWasOpen, "the test uses the exit from the active automap");
    assert.ok(!sim.logs.some(row => row[0] === "Doom episode finale requested"), "the exit tic queues victory");
    stepUntil(sim, [], () => sim.logs.some(row => row[0] === "Doom episode finale requested"), "dispatch victory on the next game tic");
    assert.deepEqual(Array.from(sim.logs.find(row => row[0] === "finale-music-clock" && row[1] === 31)),
        ["finale-music-clock", 31, exitTic + 1], "victory music starts on the first finale tic");
    stepUntil(sim, [], () => rows(sim).some(row => row.stage === 1), "observe the first episode story frame");
    const firstStory = rows(sim).find(row => row.stage === 1);
    assert.deepEqual([firstStory.tics, firstStory.gameTic, firstStory.automap], [1, exitTic + 2, false],
        "the story advances once and closes the automap before its first wipe");
    assert.ok(wipeRows(sim).some(wipe => wipe.active && wipe.stage === 1 && wipe.tics === 1));
    // The tick log shows the register before the corresponding frame is drawn.
    const at = (stage, count) => {
        const row = rows(sim).at(-1);
        return row?.stage === stage && row.tics === count;
    };
    stepUntil(sim, [], () => at(1, 11), "reach the frame before text reveal");
    assert.equal(colorAt(sim, -59, -42), 1, "the backdrop is red before the glyph appears");
    stepUntil(sim, [], () => at(1, 12), "reveal the text on finale tic thirteen");
    assert.equal(colorAt(sim, -59, -42), 4, "external lowercase E3TEXT overrides the WAD and uses the uppercase green glyph");
    stepUntil(sim, [6], () => at(1, 253), "wait through the episode's one-character story delay even with F held");
    verifyWipe(sim, [1, 2], "E3 story-to-bunny transition");
    stepUntil(sim, [], () => at(2, 0), "begin the bunny finale after its melt completes");
    assert.equal(colorAt(sim, 0, 0), 2, "PFUB1 is blue at art tic zero");
    stepUntil(sim, [], () => at(2, 230), "reach the last frame before BunnyScroll movement");
    assert.equal(colorAt(sim, -64, 0), 2);
    stepUntil(sim, [], () => at(2, 231), "move to the first column of PFUB2 at art tic 232");
    assert.equal(colorAt(sim, -64, 0), 3, "the first column belongs to the yellow PFUB2 panel");
    assert.equal(colorAt(sim, 63, 0), 2, "the right column still belongs to PFUB1");
    stepUntil(sim, [], () => at(2, 869), "reach the fully scrolled frame at art tic 870");
    assert.equal(colorAt(sim, 63, 0), 3, "PFUB2 covers the frame");
    stepUntil(sim, [], () => at(2, 1129), "draw END0 at art tic 1130");
    assert.equal(colorAt(sim, -18, -13), 4, "END0 covers PFUB2 at the native overlay position");
    stepUntil(sim, [], () => at(2, 1209), "draw END6 at art tic 1210");
    assert.equal(colorAt(sim, -18, -13), 6, "END6 replaces END0 with the final patch");

    // P pauses the soundtrack during story presentation, but the finale clock
    // itself continues to advance; pressing it again resumes the loaded track.
    const pausedStory = build(entry, episodeWad());
    exitLevel(pausedStory);
    stepUntil(pausedStory, [], () => pausedStory.logs.some(row => row[0] === "Doom episode finale requested"),
        "queue the story for the pause test");
    stepUntil(pausedStory, [], () => rows(pausedStory).some(row => row.stage === 1 && !wipeRows(pausedStory).at(-1)?.active),
        "finish the story wipe before pausing");
    stepUntil(pausedStory, [], () => rows(pausedStory).at(-1)?.tics >= 13, "reveal the story supplied inside the WAD");
    assert.equal(colorAt(pausedStory, -59, -42), 0, "the WAD's white glyph appears when there is no external story file");
    const storyBeforePause = rows(pausedStory).at(-1);
    const storyBackdropPixel = colorAt(pausedStory, -13, -46);
    press(pausedStory, 16); // P
    stepUntil(pausedStory, [], () => rows(pausedStory).at(-1)?.paused, "pause the story soundtrack");
    const storyPaused = rows(pausedStory).at(-1);
    assert.ok(storyPaused.gameTic > storyBeforePause.gameTic, "story keeps ticking while paused");
    assert.equal(storyPaused.soundtrackIsPaused, true, "P pauses the story soundtrack");
    assert.equal(storyPaused.cursor, storyBeforePause.cursor, "the paused MUS cursor does not advance");
    pausedStory.step();
    assert.equal(colorAt(pausedStory, -13, -46), 4, "M_PAUSE overlays the story frame");
    press(pausedStory, 16);
    stepUntil(pausedStory, [], () => rows(pausedStory).at(-1)?.paused === false, "resume the story soundtrack");
    assert.equal(rows(pausedStory).at(-1).soundtrackIsPaused, false, "P resumes the loaded story track");
    stepUntil(pausedStory, [], () => rows(pausedStory).at(-1)?.cursor !== storyPaused.cursor, "advance the resumed MUS cursor");
    pausedStory.step();
    assert.equal(colorAt(pausedStory, -13, -46), storyBackdropPixel, "resuming removes M_PAUSE");

    const menuStory = build(entry, episodeWad(true));
    exitLevel(menuStory);
    const menuWipe = () => wipeRows(menuStory).at(-1);
    stepUntil(menuStory, [], () => menuWipe()?.stage === 1 && !menuWipe().active, "finish the initial story wipe");
    stepUntil(menuStory, [20], () => menuWipe()?.stage === 1 && menuWipe().menu === 1, "open the episode selector during the story");
    stepUntil(menuStory, [], () => menuWipe()?.stage === 2 && menuWipe().active, "reach bunny art behind the open menu");
    let meltFrames = 0;
    for (; meltFrames < 160 && menuWipe().active; meltFrames++) {
        assert.equal(menuWipe().menu, 1, "the menu state survives each melt frame");
        assert.equal(colorAt(menuStory, -48, -37), 6, "the purple menu border stays over the melt");
        // A single T tap during the wipe is handled after the transition.
        menuStory.step([], new Map(), meltFrames === 0 ? [20] : []);
    }
    assert.ok(meltFrames > 1 && !menuWipe().active, "the bunny wipe completes with the menu visible");
    stepUntil(menuStory, [], () => menuWipe().menu === 0, "dismiss the menu with the queued T tap");
    assert.deepEqual(viewportColors(menuStory), new Set([2]), "dismissal reveals the whole blue PFUB1 frame");

    const commercialText = path.join(scratch, "C4TEXT.txt");
    const castLabel = path.join(scratch, "FCAST00.txt");
    writeFileSync(commercialText, "B");
    writeFileSync(castLabel, "B");
    const cast = build(entry, castWad());
    rmSync(commercialText);
    rmSync(castLabel);
    exitLevel(cast);
    pulseUntil(cast, () => cast.logs.some(row => row[0] === "Doom story finale requested"),
        "reach MAP30's story presentation after the intermission");
    verifyWipe(cast, [2, 1], "MAP30 intermission-to-story transition");
    stepUntil(cast, [], () => rows(cast).at(-1)?.stage === 1 && rows(cast).at(-1)?.tics >= 13,
        "reveal the external MAP30 story");
    assert.equal(colorAt(cast, -59, -42), 4, "the MAP30 ending reads C4TEXT.txt");
    stepUntil(cast, [6], () => cast.logs.some(row => row[0] === "Doom cast finale requested"), "advance into the MAP30 cast");
    verifyWipe(cast, [1, 4], "MAP30 story-to-cast transition", [6]);
    const castDeath = freshCast(entry);
    assert.equal(colorAt(castDeath, -2, 41), 0, "the WAD's centered cast name appears when there is no external label");
    // In cast mode P is a death key, not the global pause command. It must
    // dispatch only after the wipe and leave cast music advancing.
    const castBeforeDeath = rows(castDeath).at(-1);
    press(castDeath, 16);
    stepUntil(castDeath, [], () => rows(castDeath).at(-1)?.dying, "dispatch fresh P as the cast death key");
    const castAfterDeath = rows(castDeath).at(-1);
    assert.ok(castAfterDeath.gameTic > castBeforeDeath.gameTic, "cast music keeps advancing after P");
    assert.equal(castAfterDeath.paused, false, "P does not pause the cast");

    const castQueued = freshCast(entry);
    // Queue a new cast wipe, release F, then pulse I while the melt is active.
    // The raw key must survive the wipe and dispatch on the first eligible tic.
    stepUntil(castQueued, [6], () => castWipes(castQueued).length === 2, "request the queued cast wipe");
    castQueued.step();
    castQueued.step([], new Map(), [9]); // I during the active wipe
    castQueued.step();
    stepUntil(castQueued, [], () => !wipeRows(castQueued).at(-1)?.active, "finish the queued-input cast wipe");
    stepUntil(castQueued, [], () => rows(castQueued).at(-1)?.dying, "dispatch I after the cast wipe");

    stepUntil(cast, [6], () => castWipes(cast).length === 2, "a held start button requests another native cast wipe");
    stepUntil(cast, [], () => !wipeRows(cast).at(-1)?.active, "release the start button and finish the second wipe");
    assert.equal(castWipes(cast).length, 2, "releasing the start button stops cast restarts");
    assert.equal(cast.logs.filter(row => row[0] === "finale-music-clock" && row[1] === 63).length, 1,
        "restarting the cast keeps the same song");
    assert.equal(colorAt(cast, -64, -48), 1, "BOSSBACK is visible behind the cast");
    assert.equal(colorAt(cast, 1, 36), 4, "the first cast sprite is centered at the native anchor");
    assert.equal(colorAt(cast, -2, 41), 4, "the external FCAST00 label overrides the WAD and remains centered");
    cast.step();
    stepUntil(cast, [23], () => rows(cast).at(-1)?.dying, "a fresh movement key dispatches the cast responder");
    assert.equal(colorAt(cast, 1, 36), 2, "the selected cast member switches to its death sprite");
    console.log("WAD preview passed external episode and commercial text, cast labels, bunny art, and repeated MAP30 wipes.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-finale-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
