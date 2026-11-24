import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runNativeBrainOracle } from "./doom-native-brain-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-campaign-brain-"));
const unit = 65536;
const empty = Buffer.alloc(0);
const levels = [
    { marker: "MAP01", eye: [-36, -70], targets: [[-36, 80], [-90, 48]], exit: 11 },
    { marker: "MAP02", eye: [-48, -59], targets: [[-36, 72]], exit: 0, bonus: true },
];

function words(values) {
    const data = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => data.writeUInt16LE(value & 65535, index * 2));
    return data;
}

function level({ marker, eye, targets, exit, bonus }) {
    const things = [32, 0, 0, 1, 7];
    if (bonus) things.push(-96, 0, 0, 2014, 7);
    things.push(...eye, 0, 89, 7);
    for (const target of targets) things.push(...target, 0, 87, 7);
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0]];
    const linedefs = edges.flatMap(([a, b], index) => [a, b, 0, index === 2 ? exit : 0, 0, 0, 65535]);
    const segs = edges.flatMap(([a, b], index) => [a, b, 0, index, 0, 0]);
    const sector = Buffer.alloc(26);
    sector.writeInt16LE(192, 2);
    sector.writeInt16LE(160, 20);
    return [[marker, empty], ["THINGS", words(things)], ["LINEDEFS", words(linedefs)], ["SIDEDEFS", Buffer.alloc(30)],
        ["VERTEXES", words([-128, -128, -128, 128, 64, 128, 64, -128])], ["SEGS", words(segs)],
        ["SSECTORS", words([4, 0])], ["NODES", empty], ["SECTORS", sector], ["REJECT", Buffer.of(0)],
        ["BLOCKMAP", words([-128, -128, 2, 2, 8, 8, 8, 8, 0, 0, 1, 2, 3, -1])]];
}

function campaignWad() {
    const lumps = levels.flatMap(level);
    const header = Buffer.alloc(12), directory = Buffer.alloc(lumps.length * 16);
    header.write("PWAD");
    header.writeInt32LE(lumps.length, 4);
    let offset = header.length;
    for (const [index, [name, data]] of lumps.entries()) {
        directory.writeInt32LE(offset, index * 16);
        directory.writeInt32LE(data.length, index * 16 + 4);
        directory.write(name, index * 16 + 8);
        offset += data.length;
    }
    header.writeInt32LE(offset, 8);
    return Buffer.concat([header, ...lumps.map(([, data]) => data), directory]);
}

function instrument(file, anchor, replacement) {
    const source = readFileSync(file, "utf8");
    assert.equal(source.split(anchor).length, 2, anchor);
    writeFileSync(file, source.replace(anchor, replacement));
}

function build() {
    const preview = path.join(scratch, "preview"), output = path.join(scratch, "campaign.json");
    cpSync(path.join(port, "wad-bsp"), preview, { recursive: true, filter: file => !file.toLowerCase().endsWith(".wad") });
    const main = path.join(preview, "main.flt"), actions = path.join(preview, "action-preview.flt");
    const combat = path.join(preview, "combat-preview.flt");
    const scene = "type PreviewCombat struct {";
    instrument(combat, scene, `${scene}
    TraceAwake bit
    TraceSpit bit
    TraceBefore int
    TraceAfter int
    TraceCube play.LevelActor`);
    const menu = "            next campaignMenu = menuStep.Menu";
    instrument(main, menu, `            if menuStep.Changed { log("brain-menu", menuStep.Menu.Stage, menuStep.Menu.Cursor) }
${menu}`);
    const awake = "        scene.Brain = enemy.AwakenBrain(scene.World, scene.Brain)";
    instrument(actions, awake, `${awake}
        scene.TraceAwake = true`);
    const begin = "        shot := enemy.BeginBrainSpit(scene.Level, scene.World, scene.Brain, handle, rules)";
    instrument(actions, begin, `        scene.TraceBefore = scene.World.Random.GameplayIndex
${begin}`);
    const spit = "    progress := previewActionEvent(scene, shot.Combat)\n    if !shot.Done {";
    instrument(actions, spit, `    if shot.Done {
        scene.TraceSpit = true
        scene.TraceAfter = shot.Combat.World.Random.GameplayIndex
        scene.TraceCube = shot.Combat.World.Actors.ActorAt(shot.Handle - 1)
    }
${spit}`);
    const tick = "                    combat = stepped.Thinkers.Combat";
    instrument(main, tick, `${tick}
                    if combat.TraceAwake {
                        log("brain-awake", base.MapName.High, gameTime, combat.Brain.Count, combat.Brain.Cursor, combat.Brain.EasyTurn)
                    }
                    if combat.TraceSpit {
                        cube := combat.TraceCube
                        target := combat.World.Actors.ActorAt(cube.Target - 1)
                        log("brain-spit", base.MapName.High, gameTime, combat.Brain.EasyTurn, combat.Brain.Cursor,
                            combat.TraceBefore, cube.Valid, cube.Kind, cube.Physics.Body.X, cube.Physics.Body.Y, cube.Physics.Body.Z,
                            cube.Physics.MomentumX, cube.Physics.MomentumY, cube.Physics.MomentumZ, cube.ReactionTime, cube.State,
                            cube.Tics, target.Physics.Body.X, target.Physics.Body.Y, combat.TraceAfter)
                    }`);
    writeFileSync(path.join(scratch, "LEVEL.WAD"), campaignWad());
    const result = spawnSync("dotnet", [cli, "build", main, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    return simulator(decode(encoded), true);
}

function marker(name) {
    const bytes = Buffer.alloc(8);
    bytes.write(name);
    return bytes.readInt32LE(4);
}

function compareNative(shots) {
    const body = (kind, [x, y]) => [kind, x * unit, y * unit, 0, 0, 24, 8, 3, 0];
    const fixtures = levels.map(({ marker: name, eye, targets }, index) => ({
        bodies: [body(26, eye), ...targets.map(target => body(27, target))],
        commands: index ? ["awake", "spit", "spit"] : ["awake", "spit"],
        rng: shots.find(shot => shot.map === marker(name)).before, skill: 1, map: index + 1, carryEasy: index > 0,
    }));
    const native = runNativeBrainOracle(path.resolve(root, values.upstream), scratch, fixtures);
    const nativeShots = native.flatMap((events, index) => events.slice(1).map(event => {
        const originalCount = fixtures[index].bodies.length;
        const cube = event.actors[originalCount];
        if (!cube) return [event.cursor, false, event.rng];
        const [kind, x, y, z, , mx, my, mz, tics, reaction, target, state] = cube;
        const [, targetX, targetY] = event.actors[target - 1];
        return [event.cursor, true, kind, x, y, z, mx, my, mz, reaction, state, tics, targetX, targetY, event.rng];
    }));
    assert.deepEqual(shots.map(({ cursor, valid, cube, rng }) => valid ? [cursor, true, ...cube, rng] : [cursor, false, rng]), nativeShots);
}

try {
    const sim = build();
    const events = name => sim.logs.filter(row => row[0] === name).map(row => row.slice(1).map(Number));
    const logged = name => sim.logs.some(row => row[0] === name);
    function until(keys, predicate, label, limit = 250) {
        for (let tick = 0; tick < limit && !predicate(); tick++) sim.step([], new Map(), keys(tick));
        assert.ok(predicate(), `${label}: ${JSON.stringify(sim.logs.slice(-12))}`);
    }
    const idle = () => [];
    function menuKey(key, stage, cursor) {
        for (let tick = 0; tick < 12; tick++) sim.step();
        const count = events("brain-menu").length;
        until(() => [key], () => events("brain-menu").length > count, `menu key ${key}`);
        assert.deepEqual(events("brain-menu").at(-1), [stage, cursor]);
    }

    until(idle, () => logged("Classic WAD BSP frame rendered"), "start MAP01");
    menuKey(20, 2, 2);
    menuKey(23, 2, 1);
    menuKey(6, 0, 1);
    until(idle, () => events("Doom campaign started").length > 0, "start the easy campaign");
    assert.equal(events("Doom campaign started")[0][0], 1);
    until(idle, () => events("brain-spit").length === 1, "MAP01 first native spit", 2400);
    until(() => [6], () => logged("Doom level exit requested"), "use the MAP01 exit");
    until(tick => tick % 16 < 8 ? [6] : [], () => logged("Doom next level rendered"), "finish intermission", 650);
    until(idle, () => events("brain-spit").length === 3, "MAP02 skip and then emit", 2400);

    const map01 = marker("MAP01"), map02 = marker("MAP02");
    const awakenings = events("brain-awake").slice(-2);
    assert.deepEqual(awakenings.map(([map, , count, cursor, turn]) => [map, count, cursor, turn]),
        [[map01, 2, 0, 0], [map02, 1, 0, 1]]);
    const shots = events("brain-spit").map(([map, tic, turn, cursor, before, valid, ...trace]) =>
        ({ map, tic, turn, cursor, before, valid: valid === 1, cube: trace.slice(0, -1), rng: trace.at(-1) }));
    assert.deepEqual(shots.map(({ map, turn, cursor, valid }) => [map, turn, cursor, valid]),
        [[map01, 1, 1, true], [map02, 0, 0, false], [map02, 1, 0, true]]);
    assert.equal(shots[1].before, shots[1].rng, "skipped spits consume no gameplay random numbers");
    assert.equal(shots[1].rng, shots[2].before, "no other action consumes gameplay random numbers before the next spit");
    assert.deepEqual(shots.filter(shot => shot.valid).map(shot => shot.cube.slice(-2)),
        levels.map(({ targets }) => targets[0].map(coordinate => coordinate * unit)));
    if (values.upstream) compareNative(shots);
    console.log(`Campaign brain cadence passed at game tics ${shots.map(shot => shot.tic).join(", ")}.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-campaign-brain-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
