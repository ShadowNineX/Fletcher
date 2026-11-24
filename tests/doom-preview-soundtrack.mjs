// Verify WAD MUS playback is translated into live native Music Arrows.
// The fixture contains only structural map data and a tiny synthetic MUS score.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runNativeIntermissionOracle } from "./doom-native-intermission-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" } } });
const cli = path.join(root, "src", "Fletcher.Cli", "bin", "Debug", "net11.0", "fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-soundtrack-"));
const toggleAudio = [15]; // O

function words(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => bytes.writeUInt16LE(value & 0xffff, index * 2));
    return bytes;
}

function wad(lumps) {
    const directory = 12 + lumps.reduce((size, [, bytes]) => size + bytes.length, 0);
    const out = Buffer.alloc(directory + lumps.length * 16);
    out.write("PWAD"); out.writeUInt32LE(lumps.length, 4); out.writeUInt32LE(directory, 8);
    let offset = 12;
    for (const [index, [name, bytes]] of lumps.entries()) {
        const entry = directory + index * 16;
        out.writeUInt32LE(offset, entry); out.writeUInt32LE(bytes.length, entry + 4); out.write(name, entry + 8);
        bytes.copy(out, offset); offset += bytes.length;
    }
    return out;
}

function mus(score) {
    const out = Buffer.alloc(16 + score.length);
    out.write("MUS\x1a"); out.writeUInt16LE(score.length, 4); out.writeUInt16LE(16, 6);
    // The instrument table is optional metadata; the score changes program
    // explicitly, so keep this synthetic lump's score immediately after header.
    out.writeUInt16LE(2, 8); out.writeUInt16LE(0, 10); out.writeUInt16LE(0, 12);
    score.copy(out, 16);
    return out;
}

// Program 0 is GM Acoustic Grand Piano. The first event group starts C4 and
// E4 simultaneously; the later C4 is intentionally repeated to exercise the
// alternating physical Music Arrow bank.
function pianoScore() {
    return mus(Buffer.from([
        0x40, 0x00, 0x00,             // channel 0 program change: piano
        0x11, 0xc0, 100,              // channel 1 note-on E4
        0x90, 0xbc, 100, 4,           // channel 0 C4, same MUS time group
        0x81, 60, 2,                   // release channel 0 C4
        0x91, 0xc0, 100, 4,           // repeat channel 1 E4
        0x90, 0xbc, 100, 4,           // later channel 0 C4
        0x60,                         // MUS score end
    ]));
}

function level(marker, exit = false) {
    const vertices = words([-64, -64, -64, 64, 64, 64, 64, -64]);
    const lines = Buffer.concat([[0, 1], [1, 2], [2, 3], [3, 0]].map(([first, last], index) =>
        words([first, last, 0, exit && index === 2 ? 11 : 0, 0, 0, 65535])));
    const sector = Buffer.alloc(26);
    sector.writeInt16LE(128, 2); sector.write("FLOOR0_1", 4); sector.write("CEIL1_1", 12); sector.writeInt16LE(160, 20);
    return [[marker, Buffer.alloc(0)], ["THINGS", words([16, 0, 0, 1, 7])], ["LINEDEFS", lines], ["SIDEDEFS", Buffer.alloc(30)],
        ["VERTEXES", vertices], ["SEGS", words([[0, 1], [1, 2], [2, 3], [3, 0]].flatMap(([first, last], index) =>
            [first, last, [0x4000, 0, 0xc000, 0x8000][index], index, 0, 0]))],
        ["SSECTORS", words([4, 0])], ["NODES", Buffer.alloc(0)], ["SECTORS", sector], ["REJECT", Buffer.alloc(1)],
        ["BLOCKMAP", words([-64, -64, 1, 1, 5, 0, 1, 2, 3, -1])]];
}

function inputWad(track = pianoScore()) {
    const lumps = [...level("E1M1"), ...level("E1M2")];
    if (track) lumps.push(["D_E1M1", track]);
    // This optional stage track must never make a minimal WAD unloadable.
    lumps.push(["D_INTER", pianoScore()]);
    return wad(lumps);
}

function compile(input, name, entry = path.join(port, "wad-bsp", "main.flt")) {
    const output = path.join(scratch, `${name}.json`);
    writeFileSync(path.join(scratch, "LEVEL.WAD"), input);
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port,
        "--asset-root", scratch, "-o", output], { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return decode(JSON.parse(readFileSync(output, "utf8")).data);
}

const build = (...args) => simulator(compile(...args), true);

function bank(i, phase) {
    return { driver: { x: 16 + 5 * i + (phase ? 0 : 2), y: 64 }, music: { x: 17 + 5 * i + (phase ? 0 : 2), y: 64 } };
}

function pulseTrace(sim, lanes, ticks, keys = []) {
    const pulses = Array.from({ length: lanes.length }, () => []);
    const previous = lanes.map(lane => sim.value(lane.music) ?? 0);
    for (let tick = 0; tick < ticks; tick++) {
        sim.step([], new Map(), keys);
        for (const [index, lane] of lanes.entries()) {
            const current = sim.value(lane.music) ?? 0;
            if (previous[index] <= 0 && current > 0) pulses[index].push({ tick, extra: sim.tileAt(lane.music).extra });
            previous[index] = current;
        }
    }
    return pulses;
}

function logicalNotes(trace) {
    return trace.flatMap((lane, index) => lane.map(({ tick, extra }) => ({ tick, extra, voice: index >> 1 })))
        .sort((a, b) => a.tick - b.tick || a.voice - b.voice);
}

function intermissionArt(width = 320, height = 200, color = 17) {
    const header = 8 + width * 4, stride = height + 5;
    const patch = Buffer.alloc(header + stride * width);
    patch.writeUInt16LE(width); patch.writeUInt16LE(height, 2);
    for (let x = 0; x < width; x++) {
        const offset = header + x * stride;
        patch.writeUInt32LE(offset, 8 + x * 4);
        patch[offset + 1] = height;
        patch.fill(color, offset + 3, offset + 3 + height);
        patch[offset + 4 + height] = 255;
    }
    return patch;
}

function transitionPreview() {
    const copy = path.join(scratch, "transition-preview");
    cpSync(path.join(port, "wad-bsp"), copy, { recursive: true });
    const entry = path.join(copy, "main.flt");
    let source = readFileSync(entry, "utf8");
    const exit = "                    } else if used.ExitRequested {";
    const track = "            next soundtrackId = requestedTrack";
    for (const anchor of [exit, track]) assert.equal(source.split(anchor).length, 2, `unique trace hook: ${anchor}`);
    source = source.replace(exit, `${exit}\n                        log("music-exit", gameTime)`);
    source = source.replace(track, `            log("music-track", requestedTrack, gameTime, levelExited,
                intermission.BackgroundTics, requestedTrack != musicBunny)
${track}`);
    const tick = "    tick {";
    assert.equal(source.split(tick).length, 2);
    source = source.replace(tick, `${tick}
        log("music-menu", campaignMenu.Stage, intermission.Stage, intermission.BackgroundTics,
            intermission.Countdown, screenWipe.Melt.Active, soundtrackId)
        if intermission.Stage == play.IntermissionStats && !screenWipe.Melt.Active {
            log("music-intermission", intermission.BackgroundTics, intermission.StatsState,
                soundtrackPaused, soundtrack.Cursor.Position, soundtrack.Wait)
        }`);
    const stage = "                next intermission = advanced";
    assert.equal(source.split(stage).length, 2);
    source = source.replace(stage, `${stage}
                if advanced.Stage != intermission.Stage {
                    log("intermission-stage", advanced.Route.LastMap, advanced.Stage)
                }`);
    writeFileSync(entry, source);
    return entry;
}

function checkCompactedSoundtrackPulses(trace) {
    const eTrue = trace[0].find(event => event.extra === 68);
    const eFalse = trace[1].find(event => event.extra === 68);
    const cTrue = trace[2].find(event => event.extra === 64);
    assert.ok(eTrue && eFalse && cTrue, "the compact conductor routes both banks and the second voice");
    assert.ok(eFalse.tick > eTrue.tick, "consecutive packets alternate the E4 Music Arrow bank");
    assert.equal(cTrue.tick, eTrue.tick, "simultaneous C4 and E4 reach separate voices together");
}

function checkSlowClockCheckpoint(tiles, lanes) {
    let millis = 0;
    const sim = simulator(tiles, true, undefined, () => millis);
    pulseTrace(sim, lanes, 24);
    assert.ok(sim.logs.some(([tag]) => tag === "Classic WAD BSP frame rendered"), "slow-clock preview starts");
    // Give each active host callback seven score tics, then observe all
    // physical pulses before the next jump. Keep time frozen while saving
    // or loading so their key paths do not consume different score intervals.
    const window = () => {
        millis += 200;
        return logicalNotes(pulseTrace(sim, lanes, 4)).map(note => [note.extra, note.voice]);
    };
    const replay = () => Array.from({ length: 16 }, window).flat();
    window();
    pulseTrace(sim, lanes, 16, [25]);
    assert.ok(sim.logs.some(([tag]) => tag === "Doom checkpoint saved"), "slow-clock checkpoint saves");
    const beforeLoad = replay();
    pulseTrace(sim, lanes, 16, [12]);
    assert.ok(sim.logs.some(([tag]) => tag === "Doom checkpoint loaded"), "slow-clock checkpoint loads");
    assert.deepEqual(replay(), beforeLoad, "slow-clock restore resumes the committed MUS sequence");
}

function checkDenseSoundtrack(lanes) {
    const chord = Array.from({ length: 53 }, (_, index) => 24 + index);
    const later = [84, 85, 86];
    const score = mus(Buffer.from([
        ...chord.slice(0, -1).flatMap(key => [0x10, key]),
        0x90, chord.at(-1), 4,
        ...later.flatMap(key => [0x90, key, 4]),
        0x60,
    ]));
    const tiles = compile(inputWad(score), "dense-soundtrack");
    let millis = 0;
    const sim = simulator(tiles, true, undefined, () => millis);
    assert.deepEqual(pulseTrace(sim, lanes, 24).flat(), [], "a frozen clock holds the score at its start");
    assert.ok(sim.logs.some(([tag]) => tag === "Classic WAD BSP frame rendered"));

    const pianoExtra = key => 16 * (Math.floor(key / 12) - 1) + key % 12;
    const events = trace => logicalNotes(trace).map(note => note.extra);
    millis = 29; // One score tic is due. Each callback can deliver sixteen notes.
    sim.step();
    const first = pulseTrace(sim, lanes, 16, [25]); // Save with the remaining chord queued.
    assert.ok(sim.logs.some(([tag]) => tag === "Doom checkpoint saved"));
    assert.deepEqual(events(first), chord.map(pianoExtra), "every note reaches a physical bank once, in score order");
    const firstNotes = logicalNotes(first);
    assert.equal(firstNotes.filter(note => note.tick === firstNotes[0].tick).length, 16,
        "all sixteen voices can play at once");

    sim.roundTripScriptState();
    const replay = pulseTrace(sim, lanes, 16, [12]); // L reloads the partially delivered chord.
    assert.ok(sim.logs.some(([tag]) => tag === "Doom checkpoint loaded"));
    assert.deepEqual(events(replay), chord.slice(16).map(pianoExtra),
        "loading replays the undelivered chord tail without clock debt or duplicated onsets");

    millis = 115; // Three more score tics now fit in one host callback.
    const caughtUp = logicalNotes(pulseTrace(sim, lanes, 16));
    assert.deepEqual(caughtUp.map(note => note.extra), later.map(pianoExtra));
    assert.equal(new Set(caughtUp.map(note => note.tick)).size, 1, "overdue tics share available banks");
}

function menuBorder(sim) {
    // The 96 by 85 campaign panel is centered on the 128 by 96 display.
    const colors = [];
    for (const x of [-48, -12, 18, 47]) {
        for (const y of [-43, 41]) colors.push(sim.tileAt({ x, y }).extra);
    }
    return colors;
}

function displayFrame(sim) {
    return Buffer.from(Array.from({ length: 128 * 96 }, (_, i) =>
        sim.tileAt({ x: i % 128 - 64, y: Math.floor(i / 128) - 48 }).extra));
}

function checkMenuHandoff(tiles, cleanLevel) {
    const sim = simulator(tiles, true);
    const last = tag => sim.logs.findLast(row => row[0] === tag);
    const wait = (predicate, keys, reason) => {
        for (let host = 0; host < 400 && !predicate(); ++host) sim.step([], new Map(), keys);
        assert.ok(predicate(), `${reason}: ${JSON.stringify(sim.logs.slice(-6))}`);
    };
    wait(() => last("Classic WAD BSP frame rendered"), [], "start MAP01");
    wait(() => last("music-exit"), [6], "exit MAP01");
    wait(() => last("music-intermission"), [], "enter the stats screen");
    wait(() => last("music-intermission")?.[2] === 10, [18], "finish counting stats");
    const background = () => sim.tileAt({ x: -64, y: -48 }).extra;
    assert.equal(background(), 1, "Doom gamma zero maps the intermission patch to red");
    wait(() => last("music-menu")?.[1] === 2, [20], "open the skill menu over the completed stats");
    wait(() => background() === 5, [10], "gamma one redraws the patch as orange outside the panel");
    wait(() => last("music-menu")?.[1] === 0, [20], "close the skill menu over the same stats");
    assert.equal(background(), 5, "closing the menu keeps the updated intermission palette");
    const release = last("music-intermission")[1];
    wait(() => last("music-intermission")[1] >= release + 2, [], "release attack");
    wait(() => last("music-menu")?.[2] === 3, [18], "enter the commercial ten-tic delay");
    assert.ok(!displayFrame(sim).equals(cleanLevel), "the intermission backdrop differs from MAP02");
    wait(() => last("music-menu")?.[1] === 2, [20], "open the skill menu during that delay");
    const first = last("music-menu");
    assert.equal(first[2], 3);
    const border = menuBorder(sim);
    assert.deepEqual(border, Array(8).fill(6), "the menu's purple border is visible over intermission");

    wait(() => last("Doom next level rendered"), [], "advance to MAP02 with the menu open");
    const delay = sim.logs.filter(([tag, menu, stage]) => tag === "music-menu" && menu === 2 && stage === 3);
    assert.ok(delay.length >= 2, "the open menu spans multiple intermission tics");
    assert.equal(delay.at(-1)[4], 1, "the delay reaches its final tic under the menu");
    assert.equal(delay.at(-1)[3] - first[3], first[4] - 1, "the intermission clock advances once per countdown tic");
    const onNewLevel = () => last("music-menu")?.[6] === 34; // D_STALKS
    wait(() => onNewLevel() && last("music-menu")[5], [], "begin the MAP02 wipe");
    for (let tic = 0; tic < 100 && last("music-menu")[5]; ++tic) {
        const row = last("music-menu");
        assert.equal(row[1], 2, "the menu stays open during each wipe tic");
        assert.deepEqual(menuBorder(sim), border, "the panel stays visible over the wipe");
        wait(() => last("music-menu") !== row, [], "advance the wipe");
    }
    assert.equal(last("music-menu")[5], false, "the new-level wipe completes");
    assert.deepEqual(menuBorder(sim), border, "the completed wipe still shows the panel");
    const earlierDismissal = last("Doom campaign menu closed");
    wait(() => last("Doom campaign menu closed") !== earlierDismissal, [20], "dismiss the menu on MAP02");
    wait(() => last("music-menu")?.[1] === 0, [], "commit the dismissal");
    assert.ok(displayFrame(sim).equals(cleanLevel), "dismissal reveals the full menu-free MAP02 frame");
    assert.deepEqual(sim.logs.filter(([tag]) => tag === "music-track").map(row => row[1]), [33, 67, 34],
        "MAP01, intermission and MAP02 each start their track once");
}

function checkIntermissionMusic(entry, lanes, commercial) {
    const [first, second, levelTrack, intermissionTrack, nextTrack, picture] = commercial
        ? ["MAP01", "MAP02", "D_RUNNIN", "D_DM2INT", "D_STALKS", "INTERPIC"]
        : ["E1M1", "E1M2", "D_E1M1", "D_INTER", "D_E1M2", "WIMAP0"];
    const melody = key => mus(Buffer.from([0x90, key | 128, 100, 16, 0x60]));
    const palette = Buffer.alloc(768);
    palette.set([0, 255, 0, 255, 55, 0], 17 * 3);
    const art = intermissionArt();
    art[art.readUInt32LE(8) + 3] = 18; // Probe gamma with the first texel of column zero.
    const levelStart = commercial ? 33 : 1;
    const music = commercial ? 67 : 28;
    const stageKey = commercial ? 70 : 67;
    const nextKey = commercial ? 71 : 69;
    const tiles = compile(wad([...level(first, true), ...level(second), [levelTrack, pianoScore()],
        [intermissionTrack, melody(stageKey)], [nextTrack, melody(nextKey)], [picture, art],
        ["PLAYPAL", palette], ["COLORMAP", Buffer.from(Array.from({ length: 33 * 256 }, (_, index) => index & 255))]]), first, entry);
    const sim = simulator(tiles, true);
    const log = tag => sim.logs.find(row => row[0] === tag);
    const tracks = () => sim.logs.filter(([tag]) => tag === "music-track");
    for (let tick = 0; tick < 150 && !log("Classic WAD BSP frame rendered"); tick++) sim.step();
    assert.equal(tracks()[0]?.[1], levelStart, "the initial level selects its song");
    for (let tick = 0; tick < 120 && !log("music-exit"); tick++) sim.step([], new Map(), [6]);
    assert.ok(log("music-exit"), `exit switch accepted: ${JSON.stringify(sim.logs.slice(-10))}`);
    assert.equal(tracks().length, 1, "exiting the level leaves its song active for the final world tic");
    const stageNotes = logicalNotes(pulseTrace(sim, lanes, 145));
    const [, id, gameTic, exited, backgroundBefore, repeat] = tracks()[1];
    assert.deepEqual([id, gameTic, exited, backgroundBefore, repeat], [music, log("music-exit")[1] + 1, true, 0, true]);
    const extra = 64 + stageKey % 12;
    const firstStageNote = stageNotes.findIndex(note => note.extra === extra);
    assert.ok(firstStageNote >= 0, "the first intermission score reaches a Music Arrow");
    assert.ok(stageNotes.slice(firstStageNote).every(note => note.extra === extra), "the level score stops when the intermission track starts");
    const intermission = () => Array.from(sim.logs.findLast(row => row[0] === "music-intermission"));
    assert.ok(intermission()[2] < 10, "the intermission is still counting before the pause command");
    pulseTrace(sim, lanes, 16, [16]); // P sends BT_SPECIAL | BTS_PAUSE.
    const paused = intermission();
    assert.deepEqual(paused.slice(2, 4), [10, true], "the pause command's attack bit completes the stats count");
    assert.deepEqual(logicalNotes(pulseTrace(sim, lanes, 32)), [], "the paused intermission emits no soundtrack notes");
    const held = intermission();
    assert.ok(held[1] > paused[1], "the intermission clock advances while the score is paused");
    assert.deepEqual(held.slice(4), paused.slice(4), "the paused intermission retains its MUS cursor and wait");
    const resumed = logicalNotes(pulseTrace(sim, lanes, 24, [16]));
    assert.ok(resumed.some(note => note.extra === extra), "P resumes the intermission score before entering the next map");
    for (let tick = 0; tick < 600 && !log("Doom next level rendered"); tick++) {
        sim.step([], new Map(), tick % 16 < 8 ? [6] : []);
    }
    assert.ok(log("Doom next level rendered"), "finish the intermission and enter the next map");
    assert.deepEqual(tracks().map(row => row[1]), [levelStart, music, levelStart + 1], "each stage changes tracks once");
    assert.ok(logicalNotes(pulseTrace(sim, lanes, 100)).some(note => note.extra === 64 + nextKey % 12));
    if (commercial) checkMenuHandoff(tiles, displayFrame(sim));
    return [Number(commercial), backgroundBefore + 1, id, Number(repeat)];
}

function checkEpisodePointer(entry) {
    const palette = Buffer.alloc(768);
    palette.set([0, 255, 0, 255, 0, 0], 17 * 3);
    const sim = build(wad([...level("E1M1", true), ...level("E1M2", true), ...level("E1M3"),
        ["WIMAP0", intermissionArt()], ["WIURH0", intermissionArt(10, 10, 18)], ["PLAYPAL", palette],
        ["COLORMAP", Buffer.from(Array.from({ length: 33 * 256 }, (_, index) => index & 255))]]), "episode-pointer", entry);
    const last = tag => sim.logs.findLast(([rowTag]) => rowTag === tag);
    const wait = (condition, keys, message) => {
        for (let host = 0; host < 650; host++) {
            sim.step([], new Map(), keys);
            if (condition()) return;
        }
        assert.fail(message + ": " + JSON.stringify(sim.logs.slice(-12)));
    };
    const stage = (index, phase) => last("intermission-stage")?.[1] === index && last("intermission-stage")?.[2] === phase;
    const pixel = (x, y) => sim.tileAt({ x: Math.ceil(x * 128 / 320) - 64, y: Math.ceil(y * 96 / 200) - 48 })?.extra;
    const hasPointer = (x, y) => Number(pixel(x, y) !== pixel(x + 15, y));
    wait(() => last("Classic WAD BSP frame rendered"), [], "render E1M1");
    return [[148, 143], [69, 122]].map(([x, y], index) => {
        const previousExit = last("music-exit");
        wait(() => last("music-exit") && last("music-exit") !== previousExit, [6], "use each real exit linedef");
        wait(() => last("music-intermission")?.[1] === 1, [], "finish the stats wipe");
        wait(() => last("music-intermission")?.[2] === 10, [18], "finish the stats count");
        wait(() => stage(index, 2), [6], "render the first next-location frame");
        const first = hasPointer(x, y);
        wait(() => stage(index, 2) && hasPointer(x, y) === 0, [], "reach an off phase before leaving the world map");
        wait(() => stage(index, 3), [18], "render the no-state frame");
        const delay = hasPointer(x, y);
        if (index === 0) wait(() => last("Doom next level rendered"), [], "finish the next level handoff");
        return [index, first, delay];
    });
}

try {
    const soundtrackTiles = compile(inputWad(), "soundtrack");
    const sim = simulator(soundtrackTiles, true);
    const lanes = Array.from({ length: 16 }, (_, voice) => [bank(voice, true), bank(voice, false)]).flat();
    for (const [index, lane] of lanes.entries()) {
        const music = sim.tileAt(lane.music), driver = sim.tileAt(lane.driver);
        assert.equal(music?.type, 29, `bank ${index} is a native Music Arrow`);
        assert.equal(music.rotation, 1, `bank ${index} Music Arrow faces right`);
        assert.equal(driver?.type, index === 0 ? 22 : 1,
            `bank ${index} uses the one conductor or an ordinary Arrow driver`);
        assert.equal(driver.rotation, 1, `bank ${index} driver faces its Music Arrow`);
    }

    // No preloaded note may ring before the first MUS event. Afterwards C4
    // (packed 0 * 256 + 4 * 16 + 0) and E4 (+4) must reach distinct voices.
    assert.deepEqual(pulseTrace(sim, lanes, 2).flat(), [], "startup has no phantom soundtrack pulse");
    const firstPass = pulseTrace(sim, lanes, 140);
    const all = firstPass.flat();
    assert.ok(all.some(event => event.extra === 64), "MIDI 60 becomes Piano octave 4 note 0");
    assert.ok(all.some(event => event.extra === 68), "MIDI 64 becomes Piano octave 4 note 4");
    assert.ok(firstPass[0].some(event => event.extra === 68), "repeated E4 reaches voice 0 phase-true bank");
    assert.ok(firstPass[1].some(event => event.extra === 68), "repeated E4 reaches voice 0 phase-false bank");
    assert.ok(firstPass[2].some(event => event.extra === 64) || firstPass[3].some(event => event.extra === 64),
        "simultaneous C4 uses a separate logical voice");
    checkCompactedSoundtrackPulses(firstPass);
    checkSlowClockCheckpoint(soundtrackTiles, lanes);
    checkDenseSoundtrack(lanes);

    pulseTrace(sim, lanes, 16, [20]);
    assert.ok(sim.logs.some(([tag]) => tag === "Doom campaign menu opened"));
    assert.ok(logicalNotes(pulseTrace(sim, lanes, 100)).length > 0, "the campaign menu leaves the running soundtrack audible");
    pulseTrace(sim, lanes, 16, [20]);
    assert.ok(sim.logs.some(([tag]) => tag === "Doom campaign menu closed"));

    pulseTrace(sim, lanes, 16, [16]); // P pauses the running level and soundtrack.
    pulseTrace(sim, lanes, 12);
    assert.deepEqual(pulseTrace(sim, lanes, 100).flat(), [],
        "the compact conductor settles after pause without extra Music Arrow pulses");
    pulseTrace(sim, lanes, 16, [20]);
    assert.deepEqual(logicalNotes(pulseTrace(sim, lanes, 60)), [], "a menu opened over a paused level leaves the soundtrack paused");
    pulseTrace(sim, lanes, 16, [20]);
    pulseTrace(sim, lanes, 16, [25]);
    assert.ok(sim.logs.some(row => row[0] === "Doom checkpoint saved"));
    const resumedNotes = logicalNotes(pulseTrace(sim, lanes, 156, [16]));
    assert.ok(resumedNotes.length > 0, "resuming play resumes soundtrack delivery");

    // O gates delivery without restarting the transport. A score that loops
    // while muted has no native edge; the active clock produces another edge
    // once O is released again.
    pulseTrace(sim, lanes, 16, toggleAudio);
    // Let already-routed native edges clear before observing the muted period.
    pulseTrace(sim, lanes, 12);
    assert.deepEqual(pulseTrace(sim, lanes, 100).flat(), [], "muting silences existing soundtrack clock");
    pulseTrace(sim, lanes, 16, toggleAudio);
    assert.ok(pulseTrace(sim, lanes, 140).flat().length > 0, "unmuting resumes soundtrack delivery");

    pulseTrace(sim, lanes, 16, [16]);
    pulseTrace(sim, lanes, 12);
    assert.deepEqual(logicalNotes(pulseTrace(sim, lanes, 24, [12])), [], "loading a paused checkpoint emits no phantom notes");
    assert.ok(sim.logs.some(row => row[0] === "Doom checkpoint loaded"));
    const restoredNotes = logicalNotes(pulseTrace(sim, lanes, 156, [16]));
    // Host clock rounding can change how many consecutive score tics share
    // a callback. The deterministic slow-clock check also compares voice lanes.
    const restoredSequence = restoredNotes.map(note => note.extra);
    const resumedSequence = resumedNotes.map(note => note.extra);
    assert.deepEqual(restoredSequence.slice(0, resumedSequence.length), resumedSequence,
        "the saved host MUS cursor resumes the same score order after pause and mute");

    // Optional track failures remain localized to audio; map startup still runs.
    for (const [name, track] of [["no-track", null], ["bad-track", Buffer.from("not-mus")]]) {
        const candidate = build(inputWad(track), name);
        for (let tick = 0; tick < 20; tick++) candidate.step();
        assert.equal(candidate.logs.filter(row => row[0] === "Doom WAD invalid").length, 0, `${name} does not block map loading`);
    }
    const entry = transitionPreview();
    const transitions = [false, true].map(commercial => checkIntermissionMusic(entry, lanes, commercial));
    const pointers = checkEpisodePointer(entry);
    if (values.upstream) {
        assert.deepEqual(transitions, runNativeIntermissionOracle(path.resolve(root, values.upstream), scratch, { music: true }));
        assert.deepEqual(pointers, runNativeIntermissionOracle(path.resolve(root, values.upstream), scratch, { pointer: true }));
    }
    assert.deepEqual(pointers, [[0, 0, 1], [1, 1, 1]], "the first next-location frame preserves Doom's pointer latch across level handoffs");
    console.log("Music Arrows passed level and intermission pause, menu, mute, and checkpoint behavior. Doom and Doom II changed tracks on the first intermission tic. The intermission gamma update, MAP02 menu wipe, and episode pointer carry passed.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-soundtrack-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
