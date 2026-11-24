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
    writeWad("BAD.WAD", [["E1M1", 1], ["MAP01", 0]]);
    const inputs = [];
    const expected = [];
    function open(source, commercial, skill, stage, cursor, episodes) {
        inputs.push(`opened = play.OpenCampaignMenu(wad.OpenArchive(${source}), ${commercial}, ${skill})`);
        expected.push([stage, cursor, episodes.length, ...Array.from({ length: 4 }, (_, i) => episodes[i] ?? 0)]);
    }
    function tick(keys, stage, cursor, changed, marker = -1, skill = 0) {
        const fields = keys.map(key => key + ": true").join(", ");
        inputs.push(`event = play.TickCampaignMenu(saved, play.CampaignMenuInput{${fields}})`);
        expected.push([stage, cursor, changed, marker >= 0, marker, skill]);
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
                opened.Episodes[2], opened.Episodes[3])
            next saved = opened
        } else {
            log(event.Menu.Stage, event.Menu.Cursor, event.Changed, event.Start, event.Marker, event.Skill)
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
        assert.deepEqual(Array.from(sim.logs[i]), row, inputs[i]);
    });
    console.log(`Verified ${expected.length} compiled campaign menu transitions and archive selections.`);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
