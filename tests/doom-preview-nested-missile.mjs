// A missile impact wakes a monster whose chase can replace ceilingline.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-nested-missile-"));

function words(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => bytes.writeUInt16LE(value & 0xffff, index * 2));
    return bytes;
}

function createWad(sky) {
    const sides = Buffer.alloc(60);
    sides.writeUInt16LE(1, 58);
    const sectors = Buffer.alloc(52);
    for (const [index, height] of [128, 96].entries()) {
        const sector = index * 26;
        sectors.writeInt16LE(height, sector + 2);
        sectors.write("FLOOR0_1", sector + 4);
        sectors.write(sky && index === 1 ? "F_SKY1" : "CEIL1_1", sector + 12);
        sectors.writeInt16LE(160, sector + 20);
    }
    const palette = Buffer.alloc(256 * 3);
    palette.set([255, 0, 0], 3);
    const lumps = [["E1M1", Buffer.alloc(0)],
        ["THINGS", words([-110, 0, 0, 1, 7, 40, 0, 0, 3004, 7])],
        ["LINEDEFS", words([
            2, 3, 4, 0, 0, 0, 1,
            0, 1, 0, 0, 0, 0, -1, 1, 2, 0, 0, 0, 0, -1, 3, 0, 0, 0, 0, 0, -1,
            2, 4, 0, 0, 0, 1, -1, 4, 5, 0, 0, 0, 1, -1, 5, 3, 0, 0, 0, 1, -1,
        ])], ["SIDEDEFS", sides],
        ["VERTEXES", words([-128, -64, -128, 64, 60, 64, 60, -64, 128, 64, 128, -64])],
        ["SEGS", words([
            0, 1, 0x4000, 1, 0, 0, 1, 2, 0, 2, 0, 0, 2, 3, 0xc000, 0, 0, 0, 3, 0, 0x8000, 3, 0, 0,
            3, 2, 0x4000, 0, 1, 0, 2, 4, 0, 4, 0, 0, 4, 5, 0xc000, 5, 0, 0, 5, 3, 0x8000, 6, 0, 0,
        ])], ["SSECTORS", words([4, 0, 4, 4])],
        ["NODES", words([60, -64, 0, 128, 64, -64, 60, 128, 64, -64, -128, 60, 0x8001, 0x8000])],
        ["SECTORS", sectors], ["REJECT", Buffer.alloc(1)],
        ["BLOCKMAP", words([-128, -128, 2, 2, 8, 8, 8, 8, 0, 1, 2, 3, 4, 5, 6, -1])],
        ["F_START", Buffer.alloc(0)], ["FLOOR0_1", Buffer.alloc(4096, 1)], ["CEIL1_1", Buffer.alloc(4096, 1)],
        ["F_SKY1", Buffer.alloc(4096, 1)], ["F_END", Buffer.alloc(0)], ["PLAYPAL", palette],
        ["COLORMAP", Buffer.from(Array.from({ length: 33 * 256 }, (_, index) => index & 255))]];
    const directory = 12 + lumps.reduce((size, [, data]) => size + data.length, 0);
    const wad = Buffer.alloc(directory + lumps.length * 16);
    wad.write("PWAD"); wad.writeUInt32LE(lumps.length, 4); wad.writeUInt32LE(directory, 8);
    let offset = 12;
    for (const [index, [name, data]] of lumps.entries()) {
        const entry = directory + index * 16;
        wad.writeUInt32LE(offset, entry); wad.writeUInt32LE(data.length, entry + 4); wad.write(name, entry + 8);
        data.copy(wad, offset); offset += data.length;
    }
    return wad;
}

function replace(source, anchor, addition) {
    assert.equal(source.split(anchor).length, 2, anchor.trim());
    return source.replace(anchor, `${addition}\n${anchor}`);
}

function trace(profile) {
    const preview = path.join(scratch, `preview-${profile}`);
    mkdirSync(preview);
    const sourceDir = path.join(port, "wad-bsp");
    for (const name of readdirSync(sourceDir).filter(name => name.endsWith(".flt"))) {
        let source = readFileSync(path.join(sourceDir, name), "utf8");
        if (name === "main.flt") {
            source = replace(source, 'import "enemy"', 'import "actorinfo"');
            source = replace(source, "                            start := spawned.ActorAt(spawned.PlayerActors[0] - 1)", `
                            victim := spawned.ActorAt(1)
                            victim.MoveCount, victim.MoveDirection, victim.Tics = 2, enemy.ChaseEast, 10
                            spawned = spawned.WithActor(2, victim)`);
            const saveActors = "                                    next actors = spawned";
            source = replace(source, saveActors, `
                                    missile := play.SpawnMobj(level, actorinfo.ActorTroopShot, 0, 0, 8 << 16, rules.Skill, play.RandomState{}).Actor
                                    missile.Physics.MomentumX, missile.Target, missile.Tics = 15 << 16, 1, 10
                                    links = links.SetActorPosition(level, spawned.NextTransientHandle(), missile).Links`);
            source = source.replace(saveActors, `${saveActors}.AppendTransient(missile)`);
            source = replace(source, "                                    next lightState = spawnedLights", `
                                    spawnedLights.Random.GameplayIndex = ${profile === 2 ? 0 : 1}`);
            source = replace(source, "                    next player = moved", `
                    if gameTime == 0 {
                        missile := actorFrame.Actors.ActorAt(2)
                        victim := actorFrame.Actors.ActorAt(1)
                        if !missile.Valid { missile = play.LevelActor{} }
                        log("missile-impact", ${profile}, missile.Valid, missile.State, missile.Tics,
                            missile.Physics.Body.Flags & play.MoveMissile != 0, victim.Physics.Body.X, victim.Physics.Body.Z,
                            victim.Physics.MomentumX, victim.State, victim.Health, lighting.Random.GameplayIndex)
                    }`);
        }
        writeFileSync(path.join(preview, name), source);
    }
    writeFileSync(path.join(scratch, "LEVEL.WAD"), createWad(profile !== 1));
    const output = path.join(scratch, `missile-${profile}.json`);
    const args = [cli, "build", path.join(preview, "main.flt"), "--package-root", port, "--asset-root", scratch, "-o", output];
    const built = spawnSync("dotnet", args, { cwd: root, encoding: "utf8", timeout: 60_000 });
    if (built.error) throw built.error;
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let host = 0; host < 140; host++) {
        sim.step();
        const row = sim.logs.find(row => row[0] === "missile-impact");
        if (row) return row.slice(1).map(Number);
    }
    assert.fail(`Profile ${profile} did not finish the impact tic: ${JSON.stringify(sim.logs.slice(-12))}`);
}

try {
    const rows = [0, 1, 2].map(trace);
    if (values.upstream) {
        const { runNativeNestedMissileOracle } = await import("./doom-native-nested-missile-oracle.mjs");
        const native = runNativeNestedMissileOracle(path.resolve(root, values.upstream), scratch);
        assert.deepEqual(rows, native, "compiled missile impacts match pinned Doom C");
    }
    assert.deepEqual(rows, [
        [0, 0, 0, 0, 0, 48 * 65536, 0, 147453, 176, 2, 4],
        [1, 1, 99, 4, 0, 48 * 65536, 0, 147453, 176, 2, 5],
        [2, 1, 99, 5, 0, 40 * 65536, 0, 24575, 187, 17, 3],
    ], "pinned traces for the nested sky, ordinary ceiling, and pain cases");
    console.log("Preview missile impacts passed nested sky removal, solid-ceiling explosion, and pain without a nested check.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-nested-missile-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
