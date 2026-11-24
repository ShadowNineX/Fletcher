// Exercise a lost-soul impact through the compiled WAD preview. The fixture is
// synthetic and contains no proprietary Doom assets.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-skull-impact-"));
const unit = 65536;

function words(values) {
    const result = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => result.writeUInt16LE(value & 0xffff, index * 2));
    return result;
}

function wad(lumps) {
    const directory = 12 + lumps.reduce((size, [, bytes]) => size + bytes.length, 0);
    const result = Buffer.alloc(directory + lumps.length * 16);
    result.write("PWAD"); result.writeUInt32LE(lumps.length, 4); result.writeUInt32LE(directory, 8);
    let offset = 12;
    for (const [index, [name, bytes]] of lumps.entries()) {
        const entry = directory + index * 16;
        result.writeUInt32LE(offset, entry); result.writeUInt32LE(bytes.length, entry + 4); result.write(name, entry + 8);
        bytes.copy(result, offset); offset += bytes.length;
    }
    return result;
}

function level() {
    const vertices = words([-128, -64, 128, -64, 128, 64, -128, 64]);
    const lines = Buffer.concat([[0, 1], [1, 2], [2, 3], [3, 0]].map(([a, b]) => words([a, b, 0, 0, 0, 0, 0xffff])));
    const sides = Buffer.alloc(4 * 30);
    const sectors = Buffer.alloc(26);
    sectors.writeInt16LE(128, 2); sectors.write("FLOOR0_1", 4); sectors.write("CEIL1_1", 12); sectors.writeInt16LE(160, 20);
    const segs = Buffer.concat([[0, 1], [1, 2], [2, 3], [3, 0]].map(([a, b], index) => words([a, b, [0x4000, 0, 0xc000, 0x8000][index], index, 0, 0])));
    // Player, lost soul, former human. The skull precedes the victim to make
    // the nested contact order observable.
    const things = words([-110, 0, 0, 1, 7, 0, 0, 0, 3006, 7, 40, 0, 0, 3004, 7]);
    const blockMap = words([-128, -128, 2, 2, 8, 8, 8, 8, 0, 1, 2, 3, -1]);
    return [["E1M1", Buffer.alloc(0)], ["THINGS", things], ["LINEDEFS", lines], ["SIDEDEFS", sides],
        ["VERTEXES", vertices], ["SEGS", segs], ["SSECTORS", words([4, 0])], ["NODES", Buffer.alloc(0)],
        ["SECTORS", sectors], ["REJECT", Buffer.alloc(1)], ["BLOCKMAP", blockMap]];
}

function resources() {
    const palette = Buffer.alloc(256 * 3);
    palette.set([255, 0, 0], 3); palette.set([255, 255, 255], 6); palette.set([0, 255, 0], 15);
    return [["F_START", Buffer.alloc(0)], ["FLOOR0_1", Buffer.alloc(4096, 1)], ["CEIL1_1", Buffer.alloc(4096, 1)],
        ["F_END", Buffer.alloc(0)], ["PLAYPAL", palette],
        ["COLORMAP", Buffer.from(Array.from({ length: 33 * 256 }, (_, index) => index & 255))]];
}

function previewSource(profile) {
    const preview = path.join(scratch, `preview-${profile}`);
    mkdirSync(preview);
    for (const name of readdirSync(path.join(port, "wad-bsp")).filter(name => name.endsWith(".flt"))) {
        let source = readFileSync(path.join(port, "wad-bsp", name), "utf8");
        if (name === "main.flt") {
            source = source.replace('import "automap"', 'import "automap"\nimport "actorinfo"');
            const seed = "                                    next lightState = spawnedLights";
            assert.equal(source.split(seed).length, 2, "lighting seed anchor");
            source = source.replace(seed, `                                    spawnedLights.Random.GameplayIndex = ${profile === 0 ? 1 : 0}
${seed}`);
            const actors = "                            start := spawned.ActorAt(spawned.PlayerActors[0] - 1)";
            assert.equal(source.split(actors).length, 2, "actor setup anchor");
            source = source.replace(actors, `                            skullSetup := spawned.ActorAt(1)
                            skullSetup = play.SetMobjState(skullSetup, actorinfo.KindAt(skullSetup.Kind).MissileState + 1).Actor
                            skullSetup.Physics.Body.Z, skullSetup.Physics.MomentumX, skullSetup.Physics.MomentumZ = 8 << 16, 8 << 16, 2 << 16
                            skullSetup.Physics.Body.Flags = skullSetup.Physics.Body.Flags | play.MoveSkullFly
                            skullSetup.Tics = 10
                            victimSetup := spawned.ActorAt(2)
                            victimSetup.MoveCount, victimSetup.MoveDirection, victimSetup.Tics = 2, enemy.ChaseEast, 10
                            spawned = spawned.WithActor(2, skullSetup).WithActor(3, victimSetup)
${actors}`);
            const trace = "                    next player = moved";
            assert.equal(source.split(trace).length, 2, "combat trace anchor");
            source = source.replace(trace, `                    if gameTime < 2 {
                        skullTrace := actorFrame.Actors.ActorAt(1)
                        victimTrace := actorFrame.Actors.ActorAt(2)
                        log("skull-impact", ${profile}, gameTime, skullTrace.Physics.Body.X, skullTrace.Physics.Body.Z,
                            skullTrace.Physics.MomentumZ, skullTrace.Physics.Body.Flags & play.MoveSkullFly != 0,
                            victimTrace.Physics.Body.X, victimTrace.Physics.MomentumX, victimTrace.State, victimTrace.Health,
                            lighting.Random.GameplayIndex)
                    }
${trace}`);
        }
        writeFileSync(path.join(preview, name), source);
    }
    return path.join(preview, "main.flt");
}

function build(profile) {
    writeFileSync(path.join(scratch, "LEVEL.WAD"), wad([...level(), ...resources()]));
    const output = path.join(scratch, `skull-${profile}.json`);
    const result = spawnSync("dotnet", [cli, "build", previewSource(profile), "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 60_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let host = 0; host < 160 && sim.logs.filter(row => row[0] === "skull-impact").length < 2; host++) sim.step();
    const rows = sim.logs.filter(row => row[0] === "skull-impact").map(row => row.slice(1).map(Number));
    assert.equal(rows.length, 2, `profile ${profile} did not trace two gameplay tics: ${JSON.stringify(sim.logs.slice(-12))}`);
    assert.deepEqual(rows.map(row => row[0]), [profile, profile]);
    assert.deepEqual(rows.map(row => row[1]), [0, 1]);
    return rows;
}

try {
    const profiles = [build(0), build(1)];
    assert.ok(profiles.every(rows => rows.every(row => row.length === 11)), "skull trace shape");
    const expected = [
        [0, 0, 0, 10 * unit, 2 * unit, 1, 48 * unit, 0, 174, 2, 4],
        [0, 1, 0, 10 * unit, 0, 0, 48 * unit, 0, 174, 2, 4],
        [1, 0, 0, 8 * unit, 0, 0, 2646015, 22271, 187, 17, 2],
        [1, 1, 0, 8 * unit, 0, 0, 2668286, 20183, 187, 17, 2],
    ];
    assert.deepEqual(profiles.flat(), expected, "offline skull trace snapshot");
    if (values.upstream) {
        const { runNativeSkullImpactOracle } = await import("./doom-native-skull-impact-oracle.mjs");
        const native = runNativeSkullImpactOracle(path.resolve(root, values.upstream), scratch);
        assert.deepEqual(profiles.flat(), native, "compiled skull impacts match pinned Doom C");
        console.log("Preview skull impacts matched nested-hit and ordinary-pain native traces.");
    } else {
        console.log("Preview skull impacts matched the pinned native snapshots for both paths.");
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-skull-impact-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
