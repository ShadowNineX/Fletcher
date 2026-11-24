// Verify all stock Ultimate Doom episode endings from an external IWAD.  The
// temporary Fletcher package contains no IWAD data or original story strings.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { wad: { type: "string" }, cli: { type: "string" } } });
assert.ok(values.wad, "Pass --wad PATH to a local Ultimate Doom IWAD");
const wadPath = path.resolve(values.wad);
const bytes = readFileSync(wadPath);
assert.equal(bytes.toString("ascii", 0, 4), "IWAD");
const directory = bytes.readUInt32LE(8), count = bytes.readUInt32LE(4);
assert.ok(directory + count * 16 <= bytes.length, "IWAD directory fits");
const names = new Set();
for (let index = 0; index < count; index++) names.add(bytes.toString("ascii", directory + index * 16 + 8,
    directory + index * 16 + 16).replace(/\0.*$/, ""));
for (const name of ["E1M8", "E2M8", "E3M8", "E4M8", "CREDIT", "VICTORY2", "PFUB1", "PFUB2", "ENDPIC"])
    assert.ok(names.has(name), `Ultimate Doom supplies ${name}`);

const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-iwad-episode-finales-"));
const textWait = [1570, 1648, 1726, 1759];

function frame(sim) {
    const pixels = [];
    for (let y = -48; y < 48; y++) for (let x = -64; x < 64; x++) pixels.push(sim.tileAt({ x, y }).extra);
    return pixels.join(",");
}

try {
    const preview = path.join(scratch, "preview");
    cpSync(path.join(port, "wad-bsp"), preview, { recursive: true });
    const entry = path.join(preview, "main.flt"), output = path.join(scratch, "episode-finales.json");
    let entrySource = readFileSync(entry, "utf8");
    entrySource = entrySource.replace('const Archive = readFile("LEVEL.WAD")',
        `const Archive = readFile(${JSON.stringify(path.basename(wadPath))})`);
    const mapStart = entrySource.indexOf('map "Original WAD BSP View" {');
    assert.ok(mapStart >= 0, "preview entry point has its map declaration");
    writeFileSync(entry, entrySource.slice(0, mapStart) + `

func episodeRoute(episode int) play.CampaignRoute {
    return play.CampaignRoute{Valid: true, Episode: episode, LastMap: 7, Finale: play.CampaignVictory}
}

func expectedArt(episode int) wad.LumpName {
    switch episode {
    case 0: return wad.LumpName{Low: 0x44455243, High: 0x5449} // CREDIT
    case 1: return wad.LumpName{Low: 0x54434956, High: 0x3259524f} // VICTORY2
    case 2: return wad.LumpName{Low: 0x42554650, High: 49} // PFUB1
    case 3: return wad.LumpName{Low: 0x50444e45, High: 0x4349} // ENDPIC
    }
    return wad.LumpName{}
}

map "Ultimate Doom stock episode finales" {
    screen at (-64, -48) size (128, 96) with { style = "solid", hold = true, slice = true }
    tick {
        episode, mode := currentTick() / 4, currentTick() % 4
        if episode < 4 {
            mounts := wad.OpenArchive(Archive)
            materials := walls.LoadMaterials(mounts, wad.LumpName{})
            route := episodeRoute(episode)
            story := finaleStoryText(mounts, route)
            state := play.StartFinale(route, 0)
            if mode == 0 {
                // F_Ticker is still in story at TextWait; its next tic starts the art.
                state.Tics = state.TextWait - 1
                state = play.TickFinale(state, false, false)
                after := play.TickFinale(state, false, false)
                drawFinale(mounts, materials, state, story, false)
                log("story", episode, story.Valid, state.Stage, state.Tics, state.TextWait, after.Stage, after.Tics)
            } else if mode == 1 {
                state.Tics = state.TextWait
                state = play.TickFinale(state, false, false)
                drawFinale(mounts, materials, state, story, false)
                log("art", episode, state.Stage, state.Tics, state.Wipe, mounts.Find(expectedArt(episode)).Valid)
            } else if mode == 2 {
                clearFinale()
                drawIntermissionPatch(readIntermissionPatch(mounts, expectedArt(episode)), materials.Shade, 0, 0)
                log("expected", episode, mounts.Find(expectedArt(episode)).Valid)
            } else {
                clearFinale()
                drawFinaleBackdrop(materials, route)
                log("backdrop", episode)
            }
        }
    }
}`);
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", path.dirname(wadPath), "-o", output],
        { cwd: root, encoding: "utf8", timeout: 120000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    const observed = [];
    for (let host = 0; host < 800 && observed.length < 16; host++) {
        const before = sim.logs.length;
        sim.step();
        for (const row of sim.logs.slice(before)) observed.push({ row: Array.from(row), pixels: frame(sim) });
    }
    assert.equal(observed.length, 16, "all four story/art/reference frames completed");
    const artFrames = [];
    for (let episode = 0; episode < 4; episode++) {
        const story = observed[episode * 4], art = observed[episode * 4 + 1], expected = observed[episode * 4 + 2],
            backdrop = observed[episode * 4 + 3];
        assert.deepEqual(story.row, ["story", episode, false, 1, textWait[episode], textWait[episode], 2, 0],
            `E${episode + 1} has no exposed E${episode + 1}TEXT lump and holds its native story boundary`);
        assert.deepEqual(art.row, ["art", episode, 2, 0, true, true],
            `E${episode + 1} crosses to its ending art and requests the native wipe on the next tic`);
        assert.deepEqual(expected.row, ["expected", episode, true]);
        assert.deepEqual(backdrop.row, ["backdrop", episode]);
        assert.equal(story.pixels, backdrop.pixels,
            `E${episode + 1} missing text is exactly its stock finale backdrop at the final story tic`);
        assert.equal(art.pixels, expected.pixels, `E${episode + 1} finale draws its expected stock WAD art`);
        artFrames.push(art.pixels);
    }
    assert.equal(new Set(artFrames).size, 4, "CREDIT, VICTORY2, PFUB1, and ENDPIC produce distinct ending frames");
    console.log("Ultimate Doom episode finales passed missing E?TEXT timing and CREDIT, VICTORY2, PFUB1, ENDPIC art selection from the external IWAD.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-iwad-episode-finales-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
