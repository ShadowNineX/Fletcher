// Exercise the compiled title loop with a local Ultimate Doom IWAD.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: {
    wad: { type: "string" }, cli: { type: "string" }, full: { type: "boolean" }, "native-traces": { type: "string" },
    "native-actors": { type: "boolean" },
} });
assert.ok(values.wad, "Pass --wad PATH to a local Ultimate Doom IWAD");
assert.ok(!values["native-actors"] || values["native-traces"], "--native-actors requires --native-traces");
const wad = readFileSync(path.resolve(values.wad));
assert.equal(wad.toString("ascii", 0, 4), "IWAD");
const directory = wad.readUInt32LE(8);
const lumps = new Map();
for (let i = 0; i < wad.readUInt32LE(4); i++) {
    const entry = directory + 16 * i;
    const name = wad.toString("ascii", entry + 8, entry + 16).replace(/\0.*$/, "");
    lumps.set(name, entry);
}

const sampleTics = 48;
const demoStages = [2, 4, 6, 7];
const nativeFields = [
    "x", "y", "z", "angle", "momx", "momy", "momz", "viewz", "viewheight", "deltaviewheight", "health", "armor",
    "bullets", "shells", "kills", "items", "secrets", "gameplay RNG", "weapon", "damage",
];
const expectedCommands = [];
const expectedStarts = [];
for (const [index, stage] of demoStages.entries()) {
    const entry = lumps.get(`DEMO${index + 1}`);
    assert.ok(entry, "all four retail demos are present");
    const size = wad.readUInt32LE(entry + 4);
    assert.ok(size > 13 + 4 * sampleTics);
    const start = wad.readUInt32LE(entry);
    assert.equal(wad[start], 109);
    const marker = lumps.get(`E${wad[start + 2]}M${wad[start + 3]}`);
    assert.ok(marker);
    expectedStarts.push([stage, wad[start + 1], marker]);
    const recordLimit = values.full ? Math.floor((size - 13) / 4) : sampleTics;
    let tic = 0;
    for (; tic < recordLimit; tic++) {
        const at = start + 13 + 4 * tic;
        if (wad[at] === 128) break;
        expectedCommands.push([stage, wad.readInt8(at), wad.readInt8(at + 1), wad.readInt8(at + 2) << 8, wad[at + 3]]);
    }
    assert.ok(tic >= sampleTics, "the original demo contains the entire sample");
    if (values.full) {
        assert.equal(wad[start + 13 + 4 * tic], 128, "the original demo ends at its marker");
    } else {
        // Insert an early terminal record only in the test copy, to exercise
        // every title-loop boundary quickly with the original command prefixes.
        wad[start + 13 + 4 * tic] = 128;
        wad.writeUInt32LE(13 + 4 * tic + 1, entry + 4);
    }
}

const scratch = mkdtempSync(path.join(os.tmpdir(), "fletcher-doom-attract-"));
try {
    const port = path.join(root, "examples/doom-engine");
    const preview = path.join(scratch, "preview");
    cpSync(path.join(port, "wad-bsp"), preview, { recursive: true });
    writeFileSync(path.join(scratch, "LEVEL.WAD"), wad);
    const profile = path.join(preview, "display.flt");
    let display = readFileSync(profile, "utf8").replace("const ClassicMenu = false", "const ClassicMenu = true");
    if (values.full) {
        // The soak checks game tics. Use a small canvas to keep the
        // wall/sprite projection cost out of an 8,000+ command replay.
        display = display.replace("const Width = 128", "const Width = 48")
            .replace("const Height = 96", "const Height = 36")
            .replace("const LowDetail = false", "const LowDetail = true")
            .replace("const DisplaySliceWork = 0", "const DisplaySliceWork = 1000000");
    }
    writeFileSync(profile, display);
    const entry = path.join(preview, "main.flt");
    let source = readFileSync(entry, "utf8");
    const stageProbe = "if attractActive || stageChanged { next attract = nextAttract }";
    const commitProbe = "if playingDemo { nextAttract.Demo = recorded.Demo }";
    const cursorCommit = "nextAttract.Demo = recorded.Demo";
    const demoStart = 'log("Doom demo started", attract.Stage, rules.Skill, loadMarker)';
    const nativeProbe = values["native-traces"] ? `
            log("Demo player state", attract.Stage, moved.Body.X, moved.Body.Y, moved.Body.Z, int(moved.Angle),
                moved.MomentumX, moved.MomentumY, moved.MomentumZ, cameraZ, moved.ViewHeight, moved.ViewHeightDelta,
                frame.Contacts.Inventory.Health, frame.Contacts.Inventory.Armor,
                frame.Contacts.Inventory.Ammo[0], frame.Contacts.Inventory.Ammo[1],
                frame.Contacts.Inventory.KillCount, frame.Contacts.Inventory.ItemCount, frame.Contacts.Inventory.SecretCount,
                lighting.Random.GameplayIndex, frame.Contacts.Inventory.ReadyWeapon, frame.Contacts.Inventory.DamageCount)` : "";
    const actorProbe = values["native-actors"] ? `
            if (levelTime & 15) == 0 {
                for i := range actorFrame.Actors.Count {
                    actor := actorFrame.Actors.ActorAt(i)
                    if actor.Valid {
                        b := actor.Physics.Body
                        log("Demo actor state", attract.Stage, levelTime, actor.Kind, b.X, b.Y, b.Z, int(actor.Physics.Angle),
                            actor.Physics.MomentumX, actor.Physics.MomentumY, actor.Physics.MomentumZ, int(b.Flags), actor.Health,
                            actor.State, actor.Tics, actor.Sprite, actor.Frame, b.Floor, b.Ceiling, b.Radius, b.Height)
                    }
                }
            }` : "";
    assert.ok(source.includes(stageProbe) && source.includes(commitProbe) && source.includes(demoStart), "observe sequence and gameplay commits");
    source = source.replace("register startTick int = 0", `register testGameTick int = 0
    register startTick int = 0`)
        .replace(stageProbe, `if !screenWipe.Melt.Active { next testGameTick = testGameTick + 1 }
        if stageChanged { log("Attract stage", nextAttract.Stage, testGameTick) }
        ${stageProbe}`)
        .replace(commitProbe, `if playingDemo {
            ${cursorCommit}
            log("Demo player", attract.Stage, moved.Body.X, moved.Body.Y, int(moved.Angle))${nativeProbe}${actorProbe}
        }`)
        .replaceAll(cursorCommit, `${cursorCommit};
            log("Demo command committed", attract.Stage, recorded.Command.Forward, recorded.Command.Side,
                recorded.Command.Turn, recorded.Buttons)`)
        .replace(demoStart, `${demoStart}
            log("Demo column cache", attract.Stage, rendered.Columns.Enabled)`);
    writeFileSync(entry, source);
    const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
    const output = path.join(scratch, "map.json");
    const built = spawnSync("dotnet", [cli, "build", entry, "--package-root", port,
        "--asset-root", scratch, "-o", output], { cwd: root, encoding: "utf8", timeout: 45_000 });
    if (built.error) throw built.error;
    assert.equal(built.status, 0, built.stderr || built.stdout);

    const scene = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    const events = label => scene.logs.filter(row => row[0] === label).map(row => Array.from(row).slice(1));
    let firstDemo = 0, stageCount = 0, nextLog = 0;
    for (let frames = 0; frames < expectedCommands.length + 1500 && stageCount < 8; frames++) {
        // Open with an ordinary key and leave the menu up for several demo
        // commands. T closes the panel while the demo continues underneath.
        const keys = firstDemo >= 8 && firstDemo < 12 ? [23] : firstDemo >= 24 && firstDemo < 28 ? [20] : [];
        scene.step([], new Map(), keys);
        for (; nextLog < scene.logs.length; nextLog++) {
            const row = scene.logs[nextLog];
            if (row[0] === "Attract stage") {
                stageCount++;
                if (values.full) console.log(`Attract stage ${row[1]} at game tic ${row[2]}.`);
            }
            if (row[0] === "Demo command committed" && row[1] === 2) firstDemo++;
        }
    }
    const stages = events("Attract stage");
    if (stages.length < 8) console.error("Last simulation logs", scene.logs.slice(-12));
    assert.deepEqual(stages.map(row => row[0]), [1, 2, 3, 4, 5, 6, 7, 1]);
    assert.equal(stages[1][1] - stages[0][1], 171, "the title lasts for 170 plus one C page tics");
    assert.equal(stages[3][1] - stages[2][1], 201, "the first credit page lasts for 200 plus one C page tics");
    assert.equal(stages[5][1] - stages[4][1], 201, "the second credit page lasts for 200 plus one C page tics");
    assert.deepEqual(events("Doom demo started"), expectedStarts);
    assert.deepEqual(events("Demo column cache"), demoStages.map(stage => [stage, true]),
        "title startup leaves the wall column cache enabled in every demo");
    const committed = events("Demo command committed");
    assert.deepEqual(committed, expectedCommands, "every demo tic commits the recorded command");
    if (values["native-traces"]) {
        const samples = events("Demo player state");
        const actorSamples = values["native-actors"] ? events("Demo actor state") : [];
        assert.equal(samples.length, committed.length, "one state sample for every committed command");
        for (const [index, stage] of demoStages.entries()) {
            const file = path.resolve(values["native-traces"], `native-demo-${index + 1}.log`);
            const trace = readFileSync(file, "utf8");
            const native = Array.from(trace.matchAll(/^DEMO-TIC (.+)$/gm),
                match => match[1].trim().split(/\s+/).map(Number));
            const traced = samples.filter(row => row[0] === stage);
            assert.ok(native.length >= traced.length, `DEMO${index + 1} native trace covers every sampled tic`);
            if (values.full) assert.equal(native.length, traced.length, "the complete traces have the same length");
            for (const [tic, [, ...observed]] of traced.entries()) {
                const [nativeTic, ...reference] = native[tic];
                assert.equal(nativeTic, tic, "native tics are contiguous from zero");
                assert.equal(reference.length, nativeFields.length);
                assert.equal(observed.length, nativeFields.length);
                for (const [field, name] of nativeFields.entries()) {
                    assert.equal(observed[field], reference[field], `DEMO${index + 1} tic ${tic} ${name}`);
                }
            }
            if (values["native-actors"]) {
                const expected = Array.from(trace.matchAll(/^DEMO-ACTOR (\d+) (.+)$/gm),
                    ([, tic, fields]) => [Number(tic), fields.trim()]);
                const seen = actorSamples.filter(row => row[0] === stage);
                for (let tic = 0; tic < traced.length; tic += 16) {
                    // Handles differ after actor removal. Compare the complete
                    // multiset of live records, including repeated objects.
                    const reference = expected.filter(row => row[0] === tic).map(row => row[1]).sort();
                    const observed = seen.filter(row => row[1] === tic).map(row => row.slice(2).join(" ")).sort();
                    assert.ok(reference.length, `DEMO${index + 1} has native actor records at tic ${tic}`);
                    assert.deepEqual(observed, reference, `DEMO${index + 1} live actors at tic ${tic}`);
                }
            }
        }
        console.log(`Matched ${nativeFields.length} player and RNG fields against pinned Linux Doom on ${samples.length} tics.`);
        if (values["native-actors"]) console.log(`Matched ${actorSamples.length} live actor records sampled every 16 tics.`);
    }
    const players = events("Demo player");
    for (const stage of demoStages) {
        const positions = players.filter(row => row[0] === stage).map(row => row.slice(1).join(","));
        assert.ok(new Set(positions).size > 1, `demo stage ${stage} moved or turned the player`);
    }
    assert.equal(events("Doom campaign menu opened").length, 1);
    assert.equal(events("Doom campaign menu closed").length, 1);
    console.log(`Verified the retail title loop and ${committed.length} committed stock-demo commands across four original maps.`);
    if (!values.full) {
        function until(label, count, key) {
            for (let frame = 0; frame < 300; frame++) {
                scene.step([], new Map(), key ? [key] : []);
                const rows = events(label);
                if (rows.length >= count) return rows[count - 1];
            }
            assert.fail(`${label} #${count} was never reached`);
        }
        until("Demo command committed", committed.length + 1);
        assert.equal(events("Attract stage").at(-1)[0], 2);
        until("Doom campaign menu opened", 2, 46); // F10 while Demo 1 is playing.
        scene.step([], new Map(), []);
        until("Doom returned to title", 1, 25); // Y
        const stoppedAt = events("Demo command committed").length;
        assert.deepEqual(events("Attract stage").slice(-2).map(([stage]) => stage), [2, 1]);
        for (let frame = 0; frame < 65; frame++) scene.step();
        assert.equal(events("Demo command committed").length, stoppedAt, "Quit stops the old demo cursor");
        const restarted = until("Demo command committed", stoppedAt + 1);
        assert.deepEqual(restarted, expectedCommands[0]);
        console.log("Quit during Demo 1 returned to the title and restarted the demo at its first command.");
    }
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
