import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runNativeBrainOracle } from "./doom-native-brain-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-brain-"));
const unit = 65536;
const commands = { awake: 1, spit: 2, fly: 3, spawnSound: 4, scream: 5, explode: 6 };
const bossBrain = 25, bossEye = 26, bossTarget = 27, spawnCube = 28, rocket = 33;

function body(kind, x, y, { z = 0, angle = 0, flags = 0, timer = 8, tics = 3, target = 0 } = {}) {
    return [kind, x * unit, y * unit, z * unit, angle, flags, timer, tics, target];
}

const eye = body(bossEye, -96, -192, { flags: 24 });
const spots = [body(bossTarget, -28, 64, { flags: 24, z: 18 }), body(bossTarget, 190, 70, { flags: 24 })];
const cube = body(spawnCube, 28, -64, { flags: 0x11610, timer: 1, target: 2 });
const target = body(bossTarget, 92, 70, { flags: 24, z: 13 });
const seeds = [254, 115, 113, 23, 187, 246, 43, 158, 138, 192, 22, 88, 122, 106, 244, 75, 229, 2, 214, 87, 156];
const cases = [
    { name: "thinker order, half-step launch, target cycle and wrap", bodies: [eye, spots[0], body(11, 18, 10), spots[1]],
        commands: ["awake", "spit", "spit", "spit"] },
    { name: "easy difficulty skips alternate attempts without advancing the target cursor", bodies: [eye, ...spots],
        commands: ["awake", "spit", "spit", "spit"], skill: 1, rng: 253 },
    { name: "awakening again resets the target cursor and keeps the easy toggle", bodies: [eye, ...spots],
        commands: ["awake", "spit", "awake", "spit", "spit"], skill: 0 },
    { name: "cube tick consumes no RNG until its last flight state", bodies: [body(spawnCube, 71, -20, { timer: 3, target: 2 }), target],
        commands: ["spawnSound", "fly", "fly"], rng: 253 },
    { name: "brain death sweep installs and jitters 65 rockets", bodies: [body(bossBrain, 70, 240)], commands: ["scream"], rng: 244 },
    { name: "brain explosion consumes two lateral RNG draws before spawning", bodies: [body(rocket, -80, 170, { z: 20 })],
        commands: ["explode"], rng: 255 },
    ...seeds.map(rng => ({ name: `spawn probability boundary from RNG index ${rng}`, bodies: [cube, target], commands: ["spawnSound"], rng })),
    { name: "MAP30 spawn stomps occupants in x-major cell and reverse insertion order regardless of Z",
        bodies: [cube, body(bossTarget, 128, 128, { flags: 24 }), body(0, 114, 130, { z: 128, flags: 6 }),
            body(0, 137, 120, { z: 172, flags: 4 }), body(0, 112, 134, { flags: 4 }), body(0, 127, 170, { flags: 2 })],
        commands: ["spawnSound"], rng: 115 },
    { name: "map 29 blocks a monster teleport without applying any damage",
        bodies: [cube, target, body(0, 96, 76, { flags: 4 })], commands: ["fly"], map: 29, rng: 254 },
];

function words(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, i) => bytes.writeUInt16LE(value & 65535, i * 2));
    return bytes;
}

function fixtureSource() {
    const lumps = [
        ["Vertices", words([-400, -400, 400, -400]), 2], ["Lines", words([0, 1, 0, 0, 0, 0, 65535]), 1],
        ["Sides", Buffer.alloc(30), 1], ["Sectors", Buffer.concat([words([0, 192]), Buffer.alloc(22)]), 1],
        ["Segs", words([0, 1, 0, 0, 0, 0]), 1], ["Subsectors", words([1, 0]), 1], ["Nodes", Buffer.alloc(0), 0],
        ["BlockMap", words([-512, -512, 8, 8, ...Array(64).fill(68), -1]), 138], ["Reject", Buffer.of(0), 1],
    ];
    const data = Buffer.concat(lumps.map(([, bytes]) => bytes));
    let offset = 0;
    const descriptors = lumps.map(([name, bytes, count]) => {
        const entry = `${name}: wad.Lump{Offset: ${offset}, Count: ${count}, Valid: true}`;
        offset += bytes.length;
        return entry;
    });
    const arms = cases.map(({ bodies, commands: list, skill = 2, rng = 0, map = 30 }, index) => {
        const rows = bodies.map(body => {
            const args = body.map((value, i) => i === 4 ? `bits<32>(${value})` : value);
            return `world.Actors = world.Actors.AppendActor(seed(level, ${args}))`;
        });
        const ids = list.map(command => commands[command]);
        return `        case ${index}:
            world.Random.GameplayIndex = ${rng}
            rules.Skill, mapNumber = ${skill}, ${map}
            ${rows.join("\n            ")}
            queued, commandCount = [5]int{${ids.concat(Array(5 - ids.length).fill(0))}}, ${ids.length}`;
    });
    return { data, script: template.replace("@GEOMETRY@", descriptors.join(",\n            ")).replace("@CASES@", arms.join("\n")) };
}

const template = `package main
import "actorinfo"
import "enemy"
import "play"
import "wad"

const data = readFile("geometry.bin")

func seed(level wad.BspLevel, kind int, x int, y int, z int, angle bits<32>, flags int,
    reaction int, tics int, target int) play.LevelActor {
    actor := play.SpawnMobj(level, kind, x, y, z, 2, play.RandomState{}).Actor
    actor.Physics.Angle, actor.Physics.Body.Flags = angle, bits<32>(flags)
    actor.LastLook, actor.Target, actor.ReactionTime, actor.Tics = 0, target, reaction, tics
    return actor
}

map "Icon of Sin parity" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        level := wad.BspLevel{File: data,
            @GEOMETRY@, Valid: true}
        var world play.CombatWorld
        var brain enemy.BrainState
        var rules play.CombatRules
        var queued [5]int
        commandCount, mapNumber := 0, 0
        switch currentTick() {
@CASES@
        }
        blocks := wad.LoadBlockMap(level)
        world.Links = play.BuildActorLinks(world.Actors, blocks)
        for commandIndex := range commandCount {
            command := queued[commandIndex]
            warp := 0
            switch command {
            case 1:
                brain = enemy.AwakenBrain(world, brain)
                log(11, 0, actorinfo.SoundBossAwake)
            case 2:
                shot := enemy.BeginBrainSpit(level, world, brain, 1, rules)
                brain = shot.Brain
                var done bit
                for range 16 {
                    if !done {
                        feedback := shot.Combat.Feedback
                        if feedback.Sound != 0 { log(11, feedback.SoundOrigin, feedback.Sound) }
                        done = shot.Done || shot.Combat.Failed
                        if !done { shot = enemy.ResumeBrainSpit(level, blocks, shot, rules) }
                    }
                }
                if !shot.Done || shot.Combat.Failed { log(98, command) }
                world = shot.Combat.World
            case 3, 4:
                action := actorinfo.ActionSpawnFly
                if command == 4 { action = actorinfo.ActionSpawnSound }
                arrival := enemy.BeginBrainArrival(world, 1, action)
                var done bit
                for range 128 {
                    if !done {
                        feedback := arrival.Combat.Feedback
                        if feedback.Sound != 0 { log(11, feedback.SoundOrigin, feedback.Sound) }
                        if arrival.Hit.Amount != 0 {
                            hit := arrival.Hit
                            log(12, hit.Target, hit.Inflictor, hit.Source, hit.Amount)
                        }
                        done = arrival.Done || arrival.Combat.Failed
                        if !done { arrival = enemy.ResumeBrainArrival(level, blocks, arrival, mapNumber, rules) }
                    }
                }
                if !arrival.Done || arrival.Wake || arrival.Combat.Failed { log(98, command) }
                world, warp = arrival.Combat.World, arrival.Spawned
            case 5, 6:
                action := actorinfo.ActionBrainScream
                if command == 6 { action = actorinfo.ActionBrainExplode }
                fireworks := enemy.BrainFireworks(level, world, 1, action, rules)
                feedback := fireworks.Feedback
                if feedback.Sound != 0 { log(11, feedback.SoundOrigin, feedback.Sound) }
                if fireworks.Failed { log(98, command) }
                world = fireworks.World
            }
            for index := range brain.Count { log(13, brain.Targets[index]) }
            for index := range world.Actors.Count {
                actor := world.Actors.ActorAt(index)
                physics, body := actor.Physics, actor.Physics.Body
                log(10, actor.Kind, body.X, body.Y, body.Z, physics.Angle, physics.MomentumX, physics.MomentumY,
                    physics.MomentumZ, actor.Tics, actor.ReactionTime, actor.Target, actor.State, actor.LastLook, actor.Valid)
                if actor.Health <= 0 && actor.Valid { log(14, index + 1, actor.Health) }
            }
            log(15, world.Random.GameplayIndex, brain.Cursor, warp)
        }
        log(99, currentTick())
    }
}
`;

function traceFletcher() {
    const { data, script } = fixtureSource();
    const source = path.join(scratch, "brain.flt"), output = path.join(scratch, "brain.json");
    writeFileSync(path.join(scratch, "geometry.bin"), data);
    writeFileSync(source, script);
    const built = spawnSync("dotnet", [cli, "build", source, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (built.error) throw built.error;
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    const sim = simulator(decode(encoded), true);
    return cases.map((fixture, index) => {
        const before = sim.logs.length;
        for (let host = 0; host < 192 && sim.logs.length === before; host++) sim.step();
        const raw = Array.from(sim.logs.slice(before), row => Array.from(row, Number));
        assert.deepEqual(raw.pop(), [99, index], fixture.name);
        const frames = [];
        let rows = newRows();
        for (const [tag, ...row] of raw) {
            assert.ok(tag >= 10 && tag <= 15, fixture.name + " completed its actions");
            if (tag === 10) rows.actors.push(row);
            if (tag === 11) rows.sounds.push(row);
            if (tag === 12) rows.hits.push(row);
            if (tag === 13) rows.targets.push(row[0]);
            if (tag === 14) rows.health.push(row);
            if (tag === 15) {
                const [rng, cursor, warp] = row;
                frames.push({ ...rows, rng, cursor, warp });
                rows = newRows();
            }
        }
        assert.equal(frames.length, fixture.commands.length, fixture.name);
        return frames;
    });
}

function newRows() { return { actors: [], sounds: [], hits: [], targets: [], health: [] }; }

function compare(actual, expected, name) {
    const { health, ...rest } = structuredClone(actual);
    const struck = expected.hits.map(hit => hit[0]);
    assert.deepEqual(health, struck.toSorted((a, b) => a - b).map(handle => [handle, -9900]), `${name} executes telefrag damage`);
    // The C probe records damage requests. Fletcher applies the deaths and
    // consumes one death-jitter RNG draw for each victim.
    rest.rng = (rest.rng - struck.length) & 255;
    for (const handle of struck) {
        const victim = rest.actors[handle - 1], native = expected.actors[handle - 1];
        for (const field of [5, 6, 7, 8, 11]) victim[field] = native[field];
    }
    assert.deepEqual(rest, expected, name);
}

try {
    const observed = traceFletcher();
    const digest = createHash("sha256").update(JSON.stringify(observed)).digest("hex");
    if (values.upstream) {
        const native = runNativeBrainOracle(path.resolve(root, values.upstream), scratch, cases);
        cases.forEach((fixture, i) => fixture.commands.forEach((command, j) => compare(observed[i][j], native[i][j], `${fixture.name} (${command})`)));
        console.log(`Matched ${cases.length} boss brain fixtures with pinned Doom C. Fletcher SHA-256 ${digest}.`);
    } else {
        assert.equal(digest, "2addb09252f0af3af90431c40a603cc27e4758391fd86ac94e1d146ae177bed5");
        console.log(`Verified ${cases.length} boss brain fixtures against the pinned snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-brain-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
