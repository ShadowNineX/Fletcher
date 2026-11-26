import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(path.join(os.tmpdir(), "fletcher-campaign-menu-"));

function map(name) {
    return [[name, 0], ["THINGS", 10], ["LINEDEFS", 14], ["SIDEDEFS", 30], ["VERTEXES", 8],
        ["SEGS", 12], ["SSECTORS", 4], ["NODES", 0], ["SECTORS", 26]];
}
function writeWad(filename, lumps) {
    const directory = 12 + lumps.reduce((total, [, size]) => total + size, 0);
    const file = Buffer.alloc(directory + 16 * lumps.length);
    file.write("PWAD");
    file.writeInt32LE(lumps.length, 4);
    file.writeInt32LE(directory, 8);
    let offset = 12;
    const markers = {};
    for (const [i, [name, size]] of lumps.entries()) {
        const entry = directory + 16 * i;
        file.writeInt32LE(offset, entry);
        file.writeInt32LE(size, entry + 4);
        file.write(name, entry + 8);
        if (name === "THINGS") { file.writeUInt16LE(1, offset + 6); file.writeUInt16LE(7, offset + 8); }
        if (name === "LINEDEFS") { file.writeUInt16LE(1, offset + 2); file.writeUInt16LE(0xffff, offset + 12); }
        if (name === "VERTEXES") file.writeInt16LE(64, offset + 4);
        if (name === "SEGS") file.writeUInt16LE(1, offset + 2);
        if (name === "SSECTORS") file.writeUInt16LE(1, offset);
        if (name === "SECTORS") file.writeInt16LE(128, offset + 2);
        offset += size;
        markers[name] = entry;
    }
    writeFileSync(path.join(scratch, filename), file);
    return markers;
}

try {
    const markers = writeWad("GAME.WAD", [...map("E4M1"), ...map("E1M1"), ...map("E2M1"),
        ...map("E3M2"), ...map("MAP01"), ["E2M1", 0]]); // Later, incomplete E2M1 overrides the good one.
    const single = writeWad("SINGLE.WAD", map("E3M1"));
    writeWad("EPISODES.WAD", [...map("E1M1"), ...map("E2M1"), ...map("E3M1"), ...map("E4M1")]);
    writeWad("BAD.WAD", [["E1M1", 1], ["MAP01", 0]]);
    const inputs = [];
    const expected = [];
    const letterSounds = new Map();
    function open(source, commercial, skill, stage, cursor, episodes, title) {
        const operation = title === undefined ? "OpenCampaignMenu" : "OpenCampaignMain";
        const titleArgument = title === undefined ? "" : `, ${title}`;
        inputs.push(`opened = play.${operation}(wad.OpenArchive(${source}), ${commercial}, ${skill}${titleArgument})`);
        expected.push([stage, cursor, episodes.length, ...Array.from({ length: 4 }, (_, i) => episodes[i] ?? 0),
            title !== undefined, title === true]);
    }
    function tick(keys, stage, cursor, changed, marker = -1, skill = 0, checkpoint = "", option = {}) {
        const fields = keys.map(key => key + ": true");
        if (option.keys) fields.push(option.keys);
        inputs.push(option.helpShortcut ? "event = play.CampaignMenuStep{Menu: saved.OpenHelp(true), Changed: true, Marker: -1, Slot: -1}"
            : `event = play.TickCampaignMenu(saved, play.CampaignMenuInput{${fields.join(", ")}})`);
        expected.push([stage, cursor, changed, marker >= 0, marker, skill, checkpoint === "load", checkpoint === "save",
            option.messages ?? false, option.detail ?? false, option.screen ?? 0, option.sensitivity ?? 0,
            option.effects ?? 0, option.music ?? 0, option.end ?? false, option.slot ?? -1, option.name ?? "", option.quit ?? false]);
    }
    function adjust(keys, stage, cursor, option) {
        tick(keys, stage, cursor, true, -1, 0, "", option);
    }
    function letter(key, stage, cursor, changed, matched = true) {
        letterSounds.set(inputs.length, matched ? 19 : 0);
        tick([], stage, cursor, changed, -1, 0, "", { keys: `CursorKey: saved.LetterCursor(${JSON.stringify(key)})` });
    }

    open("Game", false, 2, 1, 0, [1, 4]);
    tick(["Up"], 1, 1, true); // Wrap to E4.
    tick(["Confirm"], 2, 2, true);
    tick(["Up"], 2, 1, true);
    tick(["Back"], 1, 1, true);
    tick(["Confirm"], 2, 1, true); // Remembers both selections.
    tick(["Down", "Up"], 2, 1, false);
    tick(["Down"], 2, 2, true);
    tick(["Confirm"], 0, 2, true, markers.E4M1, 2);
    tick(["Confirm"], 0, 2, false); // Start emitted once.

    open("Game", true, 0, 2, 0, [1]);
    tick(["Up"], 2, 4, true);
    tick(["Confirm"], 3, 0, true);
    tick(["Confirm"], 2, 4, true); // Default Cancel.
    tick(["Confirm"], 3, 0, true);
    tick(["Down"], 3, 1, true);
    tick(["Back", "Confirm"], 2, 4, true); // Back wins even over a pending start.
    tick(["Confirm"], 3, 0, true);
    tick(["Up"], 3, 1, true);
    tick(["Confirm"], 0, 1, true, markers.MAP01, 4);
    open("Game", true, 20, 2, 2, [1]);
    tick(["Back"], 0, 2, true);

    open("Single", false, 4, 1, 0, [3]);
    tick(["Down"], 1, 0, false);
    tick(["Confirm"], 2, 4, true);
    tick(["Down"], 2, 0, true);
    tick(["Confirm"], 0, 0, true, single.E3M1, 0);
    open("Single", false, 4, 1, 0, [3]);
    tick(["Back"], 0, 0, true);
    open("Single", true, 3, 0, 0, []);
    open("Bad", true, 3, 0, 0, []);
    open("Bad", false, 3, 0, 0, []);

    open("Game", false, 2, 4, 0, [1, 4], true);
    tick(["Confirm"], 1, 0, true);
    tick(["Confirm"], 2, 2, true);
    tick(["Back"], 1, 0, true);
    tick(["Back"], 4, 0, true);
    tick(["Down"], 4, 1, true);
    tick(["Confirm"], 5, 0, true);
    tick(["Confirm"], 5, 0, false); // Cannot end a running game from the title.
    tick(["Down"], 5, 1, true);
    adjust(["Confirm"], 5, 1, { messages: true });
    tick(["Right"], 5, 1, false); // Arrows only adjust sliders.
    tick(["Down"], 5, 2, true);
    adjust(["Confirm"], 5, 2, { detail: true });
    tick(["Down"], 5, 3, true);
    adjust(["Left"], 5, 3, { screen: -1 });
    adjust(["Confirm"], 5, 3, { screen: 1 });
    tick(["Left", "Right"], 5, 3, false);
    tick(["Down"], 5, 5, true); // Skip the thermometer spacer.
    adjust(["Right"], 5, 5, { sensitivity: 1 });
    tick(["Up"], 5, 3, true);
    tick(["Back"], 4, 1, true);
    tick(["Confirm"], 5, 3, true); // Restore the last row.
    tick(["Back"], 4, 1, true);
    tick(["Down"], 4, 2, true);
    tick(["Confirm"], 9, 0, true);
    tick(["Confirm"], 9, 0, false); // Empty load slot is selectable and does nothing.
    adjust([], 9, 1, { keys: "CursorKey: 2" });
    tick(["Back"], 4, 2, true);
    tick(["Confirm"], 9, 1, true); // Load remembers its own cursor.
    tick(["Confirm"], 0, 1, true, -1, 0, "load",
        { keys: 'SaveNames: [6]string{"", "DECK"}', slot: 1 });

    open("Game", true, 3, 4, 0, [1], false);
    tick(["Confirm"], 2, 3, true); // Doom II skips episode select.
    tick(["Back"], 4, 0, true);
    tick(["Up"], 4, 4, true);
    tick(["Confirm"], 16, 4, true); // Commercial Doom puts Quit on the fifth row.
    tick(["Confirm"], 16, 4, false); // Only Y accepts a confirmation prompt.
    tick(["Dismiss"], 0, 4, true);
    open("Game", true, 3, 4, 0, [1], false);
    adjust([], 6, 0, { helpShortcut: true });
    tick(["Confirm"], 4, 0, true); // Commercial F1 has one page.
    tick(["Up"], 4, 4, true);
    tick(["Up"], 4, 3, true);
    tick(["Confirm", "SaveAllowed"], 10, 0, true);
    tick(["Up"], 10, 5, true);
    tick(["Confirm", "SaveAllowed"], 11, 5, true);
    tick(["Confirm", "SaveAllowed"], 10, 5, true); // No commit for an empty description.
    adjust(["Confirm", "SaveAllowed"], 11, 5, { keys: 'SaveNames: [6]string{"", "", "", "", "", "LAST"}', name: "LAST" });
    adjust(["Erase"], 11, 5, { name: "LAS" });
    tick(["Back"], 10, 5, true);
    adjust(["Confirm", "SaveAllowed"], 11, 5, { keys: 'SaveNames: [6]string{"", "", "", "", "", "LAST"}', name: "LAST" });
    tick([], 11, 5, false, -1, 0, "", { keys: 'Character: "X"', name: "LAST" }); // Width limit.
    adjust(["TextFits"], 11, 5, { keys: 'Character: " "', name: "LAST " });
    adjust(["TextFits"], 11, 5, { keys: 'Character: "F"', name: "LAST F" });
    tick(["Confirm", "SaveAllowed"], 0, 5, true, -1, 0, "save", { slot: 5, name: "LAST F" });

    open("Game", false, 2, 4, 0, [1, 4], false);
    tick(["Down"], 4, 1, true);
    tick(["Confirm"], 5, 0, true);
    tick(["Up"], 5, 7, true);
    tick(["Confirm"], 8, 0, true);
    adjust(["Left"], 8, 0, { effects: -1 });
    tick(["Down"], 8, 2, true);
    adjust(["Confirm"], 8, 2, { music: 1 });
    adjust(["Left"], 8, 2, { music: -1 });
    tick(["Back"], 5, 7, true);
    tick(["Confirm"], 8, 2, true);
    tick(["Back"], 5, 7, true);
    tick(["Down"], 5, 0, true);
    tick(["Confirm"], 7, 0, true);
    tick(["Confirm"], 7, 0, false);
    tick(["Dismiss"], 0, 0, true);

    open("Game", false, 2, 4, 0, [1, 4], false);
    tick(["Down"], 4, 1, true);
    tick(["Confirm"], 5, 0, true);
    tick(["Confirm"], 7, 0, true);
    tick(["Down"], 7, 0, false);
    adjust(["Yes"], 0, 0, { end: true }); // The attract sequence takes over.

    open("Game", false, 4, 4, 0, [1, 4], false);
    tick(["Confirm"], 1, 0, true);
    tick(["Confirm"], 2, 4, true);
    tick(["Confirm"], 3, 0, true);
    tick(["Confirm"], 3, 0, false);
    tick(["Yes"], 0, 0, true, markers.E1M1, 4);

    open("Game", false, 2, 4, 0, [1, 4], true);
    tick(["Up"], 4, 5, true);
    tick(["Up"], 4, 4, true);
    tick(["Confirm"], 6, 0, true);
    tick(["Up"], 6, 0, false);
    tick(["Confirm"], 15, 0, true);
    tick(["Back"], 6, 0, true);
    tick(["Confirm"], 15, 0, true);
    tick(["Confirm"], 4, 4, true);
    adjust([], 15, 0, { helpShortcut: true }); // Retail F1 opens CREDIT directly.
    tick(["Confirm"], 4, 4, true);
    tick(["Down"], 4, 5, true);
    tick(["Confirm"], 16, 5, true);
    tick(["Yes", "Dismiss"], 0, 5, true); // Cancellation wins buffered chords.

    open("Game", false, 2, 4, 0, [1, 4], false);
    tick(["Up"], 4, 5, true);
    tick(["Confirm"], 16, 5, true);
    adjust(["Yes"], 0, 5, { quit: true });

    open("Episodes", false, 2, 4, 0, [1, 2, 3, 4], false);
    letter("S", 4, 3, true);
    letter("N", 4, 0, true);
    tick(["Confirm"], 1, 0, true);
    letter("T", 1, 1, true);
    letter("T", 1, 3, true);
    letter("T", 1, 1, true);
    tick(["Confirm"], 2, 2, true);
    letter("H", 2, 1, true);
    letter("H", 2, 2, true);
    letter("I", 2, 0, true);
    letter("S", 2, 0, false, false);
    tick(["Back"], 1, 1, true);
    tick(["Back"], 4, 0, true);
    letter("O", 4, 1, true);
    letter("O", 4, 1, false); // The same row still plays sfx_pstop.
    tick(["Confirm"], 5, 0, true);
    letter("M", 5, 1, true);
    letter("M", 5, 5, true);
    letter("M", 5, 1, true);
    letter("S", 5, 3, true);
    letter("S", 5, 7, true);
    letter(" ", 5, 7, false, false);
    tick(["Confirm"], 8, 0, true);
    letter("M", 8, 2, true);
    letter("S", 8, 0, true);
    letter("S", 8, 0, false);

    open("Game", false, 2, 4, 0, [1, 4], false);
    tick(["Confirm"], 1, 0, true);
    letter("T", 1, 1, true); // E4 keeps its own letter in the sparse archive.
    letter("I", 1, 1, false, false);
    open("Single", false, 2, 4, 0, [3], false);
    tick(["Confirm"], 1, 0, true);
    letter("I", 1, 0, false);
    open("Game", true, 2, 4, 0, [1], false);
    letter("R", 4, 0, false, false);
    letter("Q", 4, 4, true);

    const commands = inputs.map((command, i) => `case ${i}:
            ${command}
            isOpenCommand = ${command.startsWith("opened")}`).join("\n        ");
    const entry = path.join(scratch, "main.flt"), output = path.join(scratch, "map.json");
    writeFileSync(entry, `package main
import "play"
import "wad"
const Game = readFile("GAME.WAD")
const Single = readFile("SINGLE.WAD")
const Bad = readFile("BAD.WAD")
const Episodes = readFile("EPISODES.WAD")
map "Campaign menu tests" {
    register saved play.CampaignMenu = play.CampaignMenu{}
    tick {
        var opened play.CampaignMenu
        var event play.CampaignMenuStep
        var isOpenCommand bit
        switch currentTick() {
        ${commands}
        }
        if isOpenCommand {
            log(opened.Stage, opened.Cursor, opened.Count, opened.Episodes[0], opened.Episodes[1],
                opened.Episodes[2], opened.Episodes[3], opened.FromMain, opened.PanelTitle)
            next saved = opened
        } else {
            log(event.Menu.Stage, event.Menu.Cursor, event.Changed, event.Start, event.Marker, event.Skill,
                event.LoadCheckpoint, event.SaveCheckpoint, event.ToggleMessages, event.ToggleDetail,
                event.ScreenDelta, event.SensitivityDelta, event.EffectsDelta, event.MusicDelta, event.EndGame,
                event.Slot, event.Menu.SaveName, event.Quit, event.Sound)
            next saved = event.Menu
        }
    }
}`);
    const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
    const build = spawnSync("dotnet", [cli, "build", entry, "--package-root", path.join(root, "examples/doom-engine"),
        "--asset-root", scratch, "-o", output], { cwd: root, encoding: "utf8", timeout: 30_000 });
    if (build.error) throw build.error;
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    expected.forEach((row, i) => {
        sim.step();
        const actual = Array.from(sim.logs[i]);
        assert.deepEqual(actual.slice(0, row.length), row, inputs[i]);
        if (letterSounds.has(i)) assert.equal(actual.at(-1), letterSounds.get(i), inputs[i]);
    });
    console.log(`Verified ${expected.length} compiled campaign menu transitions and archive selections.`);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
