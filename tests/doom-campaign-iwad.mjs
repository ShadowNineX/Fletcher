// Exercise all original episode openings with a local Ultimate Doom IWAD.
// The temporary preview adds a start selector and diagnostic logs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: {
    wad: { type: "string" }, cli: { type: "string" }, soak: { type: "boolean" }, "full-resolution": { type: "boolean" },
    "low-detail": { type: "boolean" }, "view-blocks": { type: "string" },
} });
const [width, height] = values["full-resolution"] ? [320, 200] : [128, 96];
const viewBlocks = Number(values["view-blocks"] ?? 10);
assert.ok(Number.isInteger(viewBlocks) && viewBlocks >= 3 && viewBlocks <= 10, "--view-blocks accepts an integer from 3 to 10");
assert.ok(values.wad, "Pass --wad PATH to a local Ultimate Doom IWAD");
const wad = path.resolve(values.wad);
const bytes = readFileSync(wad);
assert.equal(bytes.toString("ascii", 0, 4), "IWAD");
const count = bytes.readUInt32LE(4), directory = bytes.readUInt32LE(8);
assert.ok(directory + 16 * count <= bytes.length, "the IWAD directory fits in the file");
const markers = new Map();
for (let i = 0; i < count; ++i) {
    const offset = directory + 16 * i;
    const name = bytes.toString("ascii", offset + 8, offset + 16).replace(/\0.*$/, "");
    if (/^E[1-4]M[1-9]$/.test(name)) markers.set(name, offset);
}
assert.equal(markers.size, 36, "the IWAD contains all four episodes including the secret levels");
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples/doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-campaign-iwad-"));

function compile() {
    const preview = path.join(scratch, "preview");
    cpSync(path.join(port, "wad-bsp"), preview, { recursive: true });
    if (values["full-resolution"] || values["low-detail"] || viewBlocks !== 10) {
        const display = path.join(preview, "display.flt");
        let profile = readFileSync(display, "utf8");
        if (values["full-resolution"]) {
            assert.match(profile, /^const Width = 128\b/m);
            assert.match(profile, /^const Height = 96\b/m);
            profile = profile.replace(/^const Width = 128\b/m, `const Width = ${width}`)
                .replace(/^const Height = 96\b/m, `const Height = ${height}`);
        }
        if (values["low-detail"]) {
            assert.match(profile, /^const LowDetail = false$/m);
            profile = profile.replace(/^const LowDetail = false$/m, "const LowDetail = true");
        }
        if (viewBlocks !== 10) {
            assert.match(profile, /^const ViewBlocks = 10\b/m);
            profile = profile.replace(/^const ViewBlocks = 10\b/m, `const ViewBlocks = ${viewBlocks}`);
        }
        writeFileSync(display, profile);
    }
    const entry = path.join(preview, "main.flt"), output = path.join(scratch, "map.json");
    let source = readFileSync(entry, "utf8").replaceAll("\r\n", "\n");
    function replace(anchor, replacement) {
        assert.equal(source.split(anchor).length, 2, `unique diagnostic anchor: ${anchor}`);
        source = source.replace(anchor, () => replacement);
    }
    replace('readFile("LEVEL.WAD")', `readFile(${JSON.stringify(path.basename(wad))})`);
    // Physical digit keys 1–6 select the map for this fresh simulator.
    // Key 7 latches it only after the input tiles have propagated.
    const selection = "                        next marker = found";
    replace(selection, `                        if weapon7 {
                            var choice bits<6>
                            choice[0], choice[1], choice[2] = weapon1, weapon2, weapon3
                            choice[3], choice[4], choice[5] = weapon4, weapon5, weapon6
                            episode, mission := int(choice) / 9 + 1, int(choice) % 9 + 1
                            name := wad.LumpName{Low: 0x304d3045 + (episode << 8) + (mission << 24)}
                            selected := mounts.Find(name)
                            if selected.Found { next marker = selected.Entry }
                            log("probe-selected", name.Low, selected.Entry)
                        }`);
    const spawn = "                                    next player = initial";
    replace(spawn, `${spawn}
                                    log("probe-spawn", level.MapName.Low, loadMarker, initial.Body.X, initial.Body.Y,
                                        spawned.Count, blocks.Valid)`);
    const moved = "                    next player = moved";
    replace(moved, `${moved}
                    if forward && blockMap.Valid && (moved.Body.X != player.Body.X || moved.Body.Y != player.Body.Y) {
                        log("probe-moved", moved.Body.X, moved.Body.Y)
                    }`);
    replace("    tick {", `    tick {
        if done && marker >= 0 && blockMap.Valid {
            log("probe-committed", player.Body.X, player.Body.Y, gameTime, inventory.Ammo[play.AmmoClip])
        }`);
    writeFileSync(entry, source);
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", path.dirname(wad), "-o", output],
        { cwd: root, encoding: "utf8", timeout: 120000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    console.log(`Compiled one temporary ${width}×${height} ${values["low-detail"] ? "low-detail" : "high-detail"} Level at ${viewBlocks} view blocks (${Buffer.byteLength(encoded, "base64")} encoded-format bytes).`);
    return decode(encoded);
}

function checkMap(tiles, name, index, soakTics) {
    const sim = simulator(tiles, true);
    const selector = [34]; // Key 7.
    for (let bit = 0; bit < 6; ++bit) if ((index >>> bit) & 1) selector.push(28 + bit);
    let selected = false, spawn, moved, rendered = false, colors = 0;
    let firstMoveTic, fired = false, inMotion = false;
    for (let host = 0; host < 6000; ++host) {
        const from = sim.logs.length;
        let keys = [];
        if (!selected) keys = selector;
        else if (spawn && firstMoveTic === undefined) keys = [23]; // W.
        else if (firstMoveTic !== undefined) keys = [4, 18]; // Turn right and fire.
        sim.step([], new Map(), keys);
        for (const [tag, ...data] of sim.logs.slice(from)) {
            switch (tag) {
                case "probe-selected":
                    assert.equal(data[0], Buffer.from(name).readUInt32LE());
                    assert.equal(data[1], markers.get(name), "selected IWAD directory entry");
                    selected = true;
                    break;
                case "Classic WAD BSP frame rendered":
                    rendered = true;
                    break;
                case "probe-spawn":
                    assert.deepEqual(data.slice(0, 2), [Buffer.from(name).readUInt32LE(), markers.get(name)]);
                    assert.ok(data[4] > 0 && data[5], "spawned actors and loaded the level BLOCKMAP");
                    spawn = data;
                    break;
                case "probe-moved":
                    moved ??= data;
                    break;
                case "probe-committed":
                    if (rendered && moved && data[0] === moved[0] && data[1] === moved[1]) {
                        assert.notDeepEqual(moved, spawn.slice(2, 4));
                        firstMoveTic ??= data[2];
                    }
                    if (firstMoveTic !== undefined) {
                        fired ||= data[3] < 50;
                        inMotion ||= data[0] !== moved[0] || data[1] !== moved[1];
                        if (data[2] >= firstMoveTic + soakTics && (!soakTics || fired && inMotion)) {
                            return { ticks: host + 1, actors: spawn[4], colors };
                        }
                    }
                    break;
                default:
                    throw new Error(`unexpected controller log: ${tag} ${data.join(" ")}`);
            }
        }
        if (spawn && !colors) {
            const shades = new Set();
            for (let y = -height / 2; y < height / 2; ++y) {
                for (let x = -width / 2; x < width / 2; ++x) shades.add(sim.tileAt({ x, y }).extra);
            }
            colors = shades.size;
            assert.ok(rendered && colors >= 2, "opening frame has visible color variation");
        }
    }
    throw new Error(`6000 host ticks without completing the ${soakTics ? "play" : "movement"} check; latest logs ${JSON.stringify(sim.logs.slice(-4))}`);
}

try {
    console.log(`IWAD: ${bytes.length} bytes, SHA-256 ${createHash("sha256").update(bytes).digest("hex")}`);
    const tiles = compile(), failures = [];
    const maps = values.soak ? ["E1M6", "E2M7", "E4M9"] : [...markers.keys()].sort();
    for (const map of maps) {
        const index = (Number(map[1]) - 1) * 9 + Number(map[3]) - 1;
        try {
            const { ticks, actors, colors } = checkMap(tiles, map, index, values.soak ? 35 : 0);
            console.log(`${map} passed (${ticks} host ticks, ${actors} actors, ${colors} opening colors).`);
        } catch (error) {
            failures.push(map);
            console.error(`${map} failed: ${error.message}`);
        }
    }
    const checks = values.soak ? "large maps opened, moved, and completed 35 play tics with firing" :
        "simulator openings rendered and committed W movement";
    console.log(`${maps.length - failures.length}/${maps.length} ${checks}.`);
    assert.equal(failures.length, 0, `Failed maps: ${failures.join(", ")}`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-campaign-iwad-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
