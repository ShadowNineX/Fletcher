import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runNativeLineTeleportOracle } from "./doom-native-line-teleport-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-line-teleport-"));
const unit = 65536;

function body(kind, x, y, { z = 0, angle = 0, flags = 0, delay = 0, mx = 0, my = 0, mz = 0, view = 0 } = {}) {
    return [kind, x * unit, y * unit, z * unit, angle, flags, delay, mx * unit, my * unit, mz * unit, view * unit];
}

const player = body(0, -12, 5, { z: 12, angle: 0x10000000, flags: 6, delay: 2, mx: 14, my: -3, mz: 5, view: 37 });
const imp = body(11, -12, 5, { z: 9, flags: 6, delay: 7, mx: 9, my: -2, mz: 1 });
const marker = (x, y, angle = 0) => body(41, x, y, { angle, flags: 24, z: 75 });
const first = marker(52, 17, 0x80000000), second = marker(79, -35, 0x40000000), laterSector = marker(171, 12, 0x20000000);
const liftedOccupant = body(0, 54, 18, { z: 128, flags: 4 });
const rocket = body(33, -12, 5, { flags: 0x10000 });
const spiderPlasma = body(36, -12, 5, { flags: 0x10000 });

function fixture(name, special, bodies, options) { return { name, special, bodies, ...options }; }

const cases = [
    fixture("front player crossing consumes the line and uses the first marker in the lowest tagged sector", 39, [player, laterSector, first, second]),
    fixture("walkover 97 uses the same destination search and remains repeatable", 97, [player, laterSector, second, first]),
    fixture("back crossing consumes 39 without a teleport attempt", 39, [player, first], { side: 1 }),
    fixture("back crossing preserves 97", 97, [player, first], { side: 1 }),
    fixture("no tagged sector consumes 39 without a teleport attempt", 39, [player, first], { tag: 70 }),
    fixture("no marker in lowest tagged sector advances to next tagged sector", 97, [player, laterSector]),
    fixture("player cannot attempt or consume monster-only 125", 125, [player, first]),
    fixture("player also skips monster-only 126", 126, [player, first]),
    fixture("monster uses ordinary 39", 39, [imp, first]),
    fixture("monster uses monster-only 125 and retains its reaction time", 125, [imp, first]),
    fixture("monster-only 126 is repeatable", 126, [imp, first]),
    fixture("monster back crossing consumes 125", 125, [imp, first], { side: 1 }),
    fixture("a blocked first marker stops selection and still consumes 125", 125, [imp, first, second, laterSector, liftedOccupant]),
    fixture("a filtered rocket leaves the special armed", 39, [rocket, first]),
    fixture("spider plasma reaches EV_Teleport, which rejects its missile flag after the one-shot dispatch", 39, [spiderPlasma, first]),
    fixture("teleport attempt clears the rest of the current crossing batch", 39, [imp, first], { batch: true }),
    fixture("failed landing also clears the rest of the current crossing batch", 125, [imp, first, liftedOccupant], { batch: true }),
    fixture("a walking imp crosses 125 through P_Move", 125, [imp, first], { monsterMove: true }),
    fixture("EV_Teleport stages both fog sounds and the player view, with RNG wrapping through zero", 97, [player, second], { direct: true, rng: 254 }),
    fixture("EV_Teleport stages source then diagonal destination fog for a monster", 126, [imp, laterSector], { direct: true, rng: 50 }),
    fixture("EV_Teleport stops on the first occupied marker outside MAP30", 126, [imp, laterSector, first, second, liftedOccupant], { direct: true }),
    fixture("EV_Teleport player can telefrag from either vertical overlap", 97, [player, first, liftedOccupant], { direct: true }),
    fixture("EV_Teleport monster can telefrag MAP30 from either vertical overlap", 126, [imp, first, liftedOccupant], { direct: true, map: 30 }),
];

function words(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, i) => bytes.writeUInt16LE(value & 65535, i * 2));
    return bytes;
}

function casesSource() {
    const geometry = [];
    let offset = 0;
    const arms = cases.map(({ special, tag = 7, map = 7, rng = 0, bodies, side = 0, direct, batch, monsterMove }, index) => {
        const sectors = Buffer.alloc(78), sides = Buffer.alloc(90), nodes = Buffer.alloc(56);
        [[0, 160, 0], [24, 140, 7], [48, 208, 7]].forEach(([floor, ceiling, id], sector) => {
            sectors.writeInt16LE(floor, sector * 26);
            sectors.writeInt16LE(ceiling, sector * 26 + 2);
            sectors.writeInt16LE(id, sector * 26 + 24);
            sides.writeUInt16LE(sector, sector * 30 + 28);
        });
        nodes.writeInt16LE(128, 0);
        nodes.writeInt16LE(1, 6);
        nodes.writeUInt16LE(0x8002, 24);
        nodes.writeUInt16LE(0x8001, 26);
        nodes.writeInt16LE(1, 28 + 6);
        nodes.writeUInt16LE(0, 28 + 24);
        nodes.writeUInt16LE(0x8000, 28 + 26);
        const splitX = monsterMove ? -16 : -32;
        const blocks = words([-512, -512, 8, 8, ...Array(64).fill(68), ...(monsterMove ? [0] : []), -1]);
        const lumps = [
            ["Vertices", words([splitX, 64, splitX, -64, -20, 64, -20, -64, 384, 64, 384, -64]), 6],
            ["Lines", words([0, 1, monsterMove ? 4 : 0, special, tag, 0, monsterMove ? 0 : 65535,
                2, 3, 0, 97, 7, 1, 65535, 4, 5, 0, 0, 0, 2, 65535]), 3],
            ["Sides", sides, 3], ["Sectors", sectors, 3], ["Nodes", nodes, 2],
            ["Segs", words([0, 1, 0, 0, 0, 0, 2, 3, 0, 1, 0, 0, 4, 5, 0, 2, 0, 0]), 3],
            ["Subsectors", words([1, 0, 1, 1, 1, 2]), 3],
            ["BlockMap", blocks, blocks.length],
        ];
        const descriptors = lumps.map(([name, bytes, count]) => {
            const entry = `${name}: wad.Lump{Offset: ${offset}, Count: ${count}, Valid: true}`;
            offset += bytes.length;
            geometry.push(bytes);
            return entry;
        });
        const rows = bodies.map(row => {
            const args = row.map((value, i) => i === 4 ? `bits<32>(${value})` : value);
            return `world.Actors = world.Actors.AppendActor(seed(level, ${args}))`;
        });
        const lo = 0x50414d + (48 + Math.floor(map / 10)) * 0x1000000;
        return `        case ${index}:
            level = wad.BspLevel{File: data, MapName: wad.LumpName{Low: ${lo}, High: ${48 + map % 10}},
                ${descriptors.join(",\n                ")}, Valid: true}
            world.Random.GameplayIndex = ${rng}
            ${rows.join("\n            ")}
            side, mode = ${side}, ${direct ? 1 : batch ? 2 : monsterMove ? 3 : 0}`;
    });
    return { data: Buffer.concat(geometry), script: template.replace("@CASES@", arms.join("\n")) };
}

const template = `package main
import "actorinfo"
import "enemy"
import "play"
import "wad"

const data = readFile("geometry.bin")

func seed(level wad.BspLevel, kind int, x int, y int, z int, angle bits<32>, flags int, delay int,
    mx int, my int, mz int, viewHeight int) play.LevelActor {
    actor := play.SpawnMobj(level, kind, x, y, z, 2, play.RandomState{}).Actor
    actor.LastLook, actor.Health, actor.ReactionTime = 0, 100, delay
    actor.Physics.Body.Flags, actor.Physics.Angle = bits<32>(flags), angle
    actor.Physics.MomentumX, actor.Physics.MomentumY, actor.Physics.MomentumZ = mx, my, mz
    if viewHeight != 0 {
        actor.Physics.Body.Player, actor.Physics.ViewHeight, actor.PlayerSlot = true, viewHeight, 0
    }
    return actor
}

map "Teleport line parity" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        var level wad.BspLevel
        var world play.CombatWorld
        side, mode := 0, 0
        switch currentTick() {
@CASES@
        }
        blocks := wad.LoadBlockMap(level)
        if mode == 3 {
            // The C fixture receives the mobj after its eight-unit step.
            actor := world.Actors.ActorAt(0)
            actor.Physics.Body.X = actor.Physics.Body.X - 8 * 65536
            world.Actors = world.Actors.WithActor(1, actor)
        }
        world.Links = play.BuildActorLinks(world.Actors, blocks)
        if world.Actors.ActorAt(0).Physics.Body.Player {
            world.Actors.PlayerActors[0] = 1
            world.Players[0].Health = 100
        }
        crossed := play.WalkoverState{Level: level, World: world}
        actions := play.DefaultWalkoverTelefrag{}
        rules := play.CombatRules{Skill: 2}
        if mode == 1 {
            step := play.BeginLineTeleport(level, blocks, world, 1, level.LineAt(0).Tag, side, rules)
            var done bit
            for range 128 {
                if !done {
                    feedback := step.Combat.Feedback
                    if feedback.Sound != 0 { log(11, feedback.SoundOrigin, feedback.Sound) }
                    if step.Hit.Amount != 0 { log(12, step.Hit.Target, step.Hit.Inflictor, step.Hit.Source, step.Hit.Amount) }
                    crossed.World = step.Combat.World
                    done = step.Done || step.Combat.Failed
                    if !done {
                        if step.Combat.State.Action != 0 { crossed = actions.OnTelefrag(crossed, step.Combat, rules) }
                        step.Combat.World = crossed.World
                        step = play.ResumeLineTeleport(level, step, rules)
                    }
                }
            }
            crossed.Teleported, crossed.TeleportTried, crossed.EyeZ = step.Teleported, step.Destination != 0, step.EyeZ
            crossed.Failed = !step.Done || step.Combat.Failed
        } else if mode == 2 {
            check := play.MapPositionCheck{SpecialCount: 2}
            check.Specials = check.Specials.With(0, 1).With(1, 0)
            crossed = play.CrossActorMove(blocks, crossed, 1, -48 * 65536, 0, check, rules, actions)
            if crossed.Count != 1 { log(98) }
        } else if mode == 3 {
            moved := enemy.Move(level, blocks, enemy.MonsterMove{World: world, Level: level}, 1, rules)
            crossed.World, crossed.Level, crossed.Failed = moved.World, moved.Level, moved.Failed || !moved.Moved
            crossed.Teleported, crossed.TeleportTried = moved.Teleported, moved.Teleported
        } else {
            crossed = play.CrossActorLine(blocks, crossed, 1, play.SpecialCrossing{Line: 0, OldSide: side}, rules, actions)
        }
        if crossed.Failed { log(98) }
        for index := range crossed.World.Actors.Count {
            actor := crossed.World.Actors.ActorAt(index)
            physics, body := actor.Physics, actor.Physics.Body
            log(10, actor.Kind, body.X, body.Y, body.Z, body.Floor, body.Ceiling, actor.Sector, physics.Angle,
                physics.MomentumX, physics.MomentumY, physics.MomentumZ, actor.ReactionTime, actor.State, actor.Tics, actor.LastLook)
            if actor.Health <= 0 { log(13, index + 1, actor.Health) }
        }
        log(14, crossed.Level.LineAt(0).Action, crossed.TeleportTried, crossed.Teleported, crossed.EyeZ, crossed.World.Random.GameplayIndex)
        log(99, currentTick())
    }
}
`;

function traceFletcher() {
    const { data, script } = casesSource();
    const source = path.join(scratch, "teleport.flt"), output = path.join(scratch, "teleport.json");
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
        for (let host = 0; host < 96 && sim.logs.length === before; host++) sim.step();
        const raw = Array.from(sim.logs.slice(before), row => Array.from(row, Number));
        assert.deepEqual(raw.pop(), [99, index], fixture.name);
        const actors = [], sounds = [], hits = [], health = [];
        for (const [tag, ...row] of raw) {
            assert.ok(tag >= 10 && tag <= 14, fixture.name + " completed its actions");
            if (tag === 10) actors.push(row);
            if (tag === 11) sounds.push(row);
            if (tag === 12) hits.push(row);
            if (tag === 13) health.push(row);
        }
        const [tag, special, tried, warped, eye, rng] = raw.at(-1);
        assert.equal(tag, 14);
        return { special, tried, warped, eye, rng, sounds, hits, actors, health };
    });
}

function compare(actual, native, fixture) {
    const { health, ...observed } = structuredClone(actual);
    const struck = native.hits.map(hit => hit[0]);
    assert.deepEqual(health, struck.toSorted((a, b) => a - b).map(handle => [handle, -9900]), `${fixture.name} executes telefrag damage`);
    for (const handle of struck) {
        const victim = observed.actors[handle - 1], expected = native.actors[handle - 1];
        for (const field of [8, 9, 10, 12, 13]) victim[field] = expected[field];
    }
    if (!fixture.direct) native.sounds = [];
    assert.deepEqual(observed, native, fixture.name);
}

try {
    const observed = traceFletcher();
    const digest = createHash("sha256").update(JSON.stringify(observed)).digest("hex");
    if (values.upstream) {
        const native = runNativeLineTeleportOracle(path.resolve(root, values.upstream), scratch, cases);
        cases.forEach((fixture, i) => compare(observed[i], native[i], fixture));
        console.log(`Matched ${cases.length} teleport line cases with pinned Doom C. Fletcher SHA-256 ${digest}.`);
    } else {
        assert.equal(digest, "c2d3b00e841296227d879cbb603353e53bf5d200ee67cd0c602352cfede3f280");
        console.log(`Verified ${cases.length} teleport line cases against the pinned snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-line-teleport-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
