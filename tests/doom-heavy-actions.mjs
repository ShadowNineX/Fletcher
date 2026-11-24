import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runNativeHeavyOracle } from "./doom-native-heavy-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-heavy-actions-"));
const unit = 65536;
const revenant = 5, tracer = 6, mancubus = 8, demon = 12, spectre = 13, pain = 22;
const actionId = new Map(Object.entries({
    tracer: 42, whoosh: 43, fist: 44, skel: 45, fatRaise: 46, fat1: 47, fat2: 48, fat3: 49, demonBite: 54, painAttack: 64, painDie: 65,
}));

function body(kind, { x = 0, y = 0, z = 0, mx = 0, my = 0, mz = 0, ...fields } = {}) {
    return { kind, x: x * unit, y: y * unit, z: z * unit, mx: mx * unit, my: my * unit, mz: mz * unit,
        angle: 0, health: 1000, flags: 6, ...fields };
}

function fixture(name, actions, { actor = body(revenant, { z: 7, flags: 38 }), target = body(0, { x: 200 }),
    split = 8 * unit, ...rest } = {}) {
    return { name, actions, actor, target: { present: true, tracked: false, ...target }, split,
        rng: 0, gameTic: 0, tryMove: true, attackRange: 0, skulls: 0, ...rest };
}

const cases = [
    fixture("revenant restores its height and advances raw XY beyond its retained sector link", ["skel"]),
    fixture("revenant launching at a shadowed target draws both face and launch spread", ["skel"], {
        rng: 251, actor: body(revenant, { x: 24, y: -20, z: 28 }), target: body(0, { x: 185, y: 59, z: 42, flags: 0x40006 }),
    }),
    fixture("blocked revenant missile explodes before the extra advance", ["skel"], { rng: 4, tryMove: false }),
    fixture("revenant swing faces a shadowed target before its sound", ["whoosh"], {
        actor: body(revenant, { angle: 0x20000000, flags: 38 }), target: body(0, { x: -55, y: -21, flags: 0x40006 }),
    }),
    fixture("revenant fist rolls damage when it reaches the target", ["fist"], { target: body(0, { x: 42, y: 1 }) }),
    fixture("demon turns again when its target moved during the bite windup", ["demonBite"], {
        actor: body(demon, { angle: 0, flags: 38 }), target: body(0, { x: -29, y: 22 }), bites: true,
    }),
    fixture("spectre rolls facing spread before bite damage against an invisible target", ["demonBite"], {
        actor: body(spectre, { angle: 0x40000000, flags: 0x40026 }),
        target: body(0, { x: 35, y: -12, flags: 0x40006 }), rng: 254, bites: true,
    }),
    fixture("demon rolls facing spread even when the invisible target steps out of bite range", ["demonBite"], {
        actor: body(demon, { angle: 0x80000000, flags: 38 }),
        target: body(0, { x: 68, y: 18, flags: 0x40006 }), rng: 72,
    }),
    fixture("only divisible-by-four game tics emit a tracer trail", ["tracer"], {
        actor: body(tracer, { x: 33, z: 48, mx: 10 }), target: body(0, { x: 180, y: 58, tracked: true }), gameTic: 7, rng: 113,
    }),
    fixture("tracer turns up and climbs while emitting the old-velocity trail", ["tracer"], {
        actor: body(tracer, { x: 39, z: 31, mx: 9, my: -2, mz: -0.2 }),
        target: body(0, { x: 180, y: 120, z: 72, tracked: true }), gameTic: 8,
    }),
    fixture("tracer takes the short clockwise path across the unsigned wrap", ["tracer"], {
        actor: body(tracer, { x: 12, z: 65, mx: 9, my: 2, mz: 0.5, angle: 0x01000000 }),
        target: body(0, { x: 170, y: -107, z: 1, tracked: true }), gameTic: 12, rng: 253,
    }),
    fixture("tracer clamps a short turn to the exact angle and preserves the short-range puff", ["tracer"], {
        actor: body(tracer, { x: 43, z: 72, mx: 10, angle: 0x05000000 }),
        target: body(0, { x: 170, y: 0, z: 1, tracked: true }), gameTic: 16, attackRange: 64 * unit,
    }),
    fixture("tracer keeps its momentum when the tracked target is dead", ["tracer"], {
        actor: body(tracer, { x: 53, y: 72, z: 37, mx: 8, my: 1, mz: -2, angle: 0x60000000 }),
        target: body(0, { x: 208, y: 51, health: 0, tracked: true }), gameTic: 16, rng: 99,
    }),
    fixture("tracer emits its trail with no tracked target", ["tracer"], {
        actor: body(tracer, { x: 24, y: -18, z: 38, mx: -3 }), gameTic: 0,
    }),
    fixture("mancubus winds up and launches the six-missile pattern in three pairs", ["fatRaise", "fat1", "fat2", "fat3"], {
        actor: body(mancubus, { y: 4, z: 6, angle: 0x70000000, flags: 38 }), target: body(0, { x: 180, y: -63, z: 12 }),
    }),
    fixture("mancubus adjusts both final missiles after their unmodified half-steps", ["fat3"], {
        actor: body(mancubus, { x: 19, y: -11, z: 4 }), target: body(0, { x: 90, y: -20, z: 18, flags: 0x40006 }), rng: 249,
    }),
    fixture("mancubus preserves the native spread adjustment after blocked launches", ["fat2"], {
        actor: body(mancubus, { z: 0 }), target: body(0, { x: 80, y: -8 }), tryMove: false,
    }),
    fixture("pain elemental faces and charges a skull from its native offset", ["painAttack"], { actor: body(pain, { z: 16, flags: 38 }) }),
    fixture("pain elemental death launches three skulls in order", ["painDie"], { actor: body(pain, { angle: 0x08000000, z: 10, health: -10 }) }),
    fixture("pain elemental accepts a twenty-first skull then hits the shared cap", ["painDie"], { actor: body(pain), skulls: 20, rng: 254 }),
    fixture("pain elemental counts existing corpses toward the cap", ["painAttack"], { actor: body(pain), skulls: 21 }),
    fixture("a rejected skull is killed before its charge", ["painAttack"], { actor: body(pain), tryMove: false, rng: 248 }),
];

function words(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, i) => bytes.writeUInt16LE(value & 65535, i * 2));
    return bytes;
}

function fixturesSource() {
    const data = [];
    let offset = 0;
    const source = cases.map((fixture, index) => {
        const sectors = Buffer.alloc(52), sides = Buffer.alloc(60), nodes = Buffer.alloc(28);
        for (const sector of [0, 1]) sectors.writeInt16LE(fixture.tryMove ? 192 : 0, sector * 26 + 2);
        sides.writeUInt16LE(1, 58);
        nodes.writeInt16LE(fixture.split / unit, 0);
        nodes.writeInt16LE(1, 6);
        nodes.writeUInt16LE(0x8001, 24);
        nodes.writeUInt16LE(0x8000, 26);
        const columns = 8, cells = columns * columns;
        const blocks = words([-512, -512, columns, columns, ...Array(cells).fill(4 + cells), -1]);
        const lumps = [
            ["Vertices", words([-340, -300, -340, 300, 340, -300, 340, 300]), 4],
            ["Lines", words([0, 1, 0, 0, 0, 0, 65535, 2, 3, 0, 0, 0, 1, 65535]), 2],
            ["Sides", sides, 2], ["Sectors", sectors, 2],
            ["Segs", words([0, 1, 0, 0, 0, 0, 2, 3, 0, 1, 0, 0]), 2],
            ["Subsectors", words([1, 0, 1, 1]), 2], ["Nodes", nodes, 1], ["BlockMap", blocks, blocks.length],
            ["Reject", Buffer.alloc(1), 1],
        ];
        const fields = lumps.map(([name, bytes, count]) => {
            const field = `                ${name}: wad.Lump{Offset: ${offset}, Count: ${count}, Valid: true},`;
            offset += bytes.length;
            data.push(bytes);
            return field;
        });
        const args = entry => [entry.kind, entry.x, entry.y, entry.z, `bits<32>(${entry.angle})`, entry.mx, entry.my, entry.mz, entry.health, entry.flags].map(
            item => typeof item === "number" ? Math.trunc(item) : item).join(", ");
        const actions = fixture.actions.map(action => actionId.get(action));
        return `        case ${index}:
            level = wad.BspLevel{File: Geometry, Valid: true,\n${fields.join("\n")}\n            }
            actor, target = makeActor(${args(fixture.actor)}), makeActor(${args(fixture.target)})
            actor.Target, actor.Tracer = ${fixture.target.present ? 2 : 0}, ${fixture.target.tracked ? 2 : 0}
            world.Random.GameplayIndex, world.AttackRange = ${fixture.rng}, ${fixture.attackRange}
            gameTic, skulls, actionCount = ${fixture.gameTic}, ${fixture.skulls}, ${actions.length}
            actions = [4]int{${actions}}`;
    });
    writeFileSync(path.join(scratch, "GEOMETRY.BIN"), Buffer.concat(data));
    return source.join("\n");
}

function traceFletcher() {
    const entry = path.join(scratch, "main.flt"), output = path.join(scratch, "result.json");
    writeFileSync(entry, `package main
import "actorinfo"
import "enemy"
import "play"
import "wad"
const Geometry = readFile("GEOMETRY.BIN")

func makeActor(kind int, x int, y int, z int, heading bits<32>, mx int, my int, mz int, health int, flags bits<32>) play.LevelActor {
    info := actorinfo.KindAt(kind)
    return play.LevelActor{Valid: true, Kind: kind, Health: health, PlayerSlot: -1,
        State: info.SpawnState, Physics: play.ActorPhysics{Angle: heading, MomentumX: mx, MomentumY: my, MomentumZ: mz,
        Body: play.MapActor{X: x, Y: y, Z: z, Height: info.Height, Radius: info.Radius, Flags: flags, Ceiling: 192 << 16}}}
}

map "Heavy monster actions parity" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        var level wad.BspLevel
        var world play.CombatWorld
        var actor play.LevelActor
        var target play.LevelActor
        var actions [4]int
        actionCount, gameTic, skulls := 0, 0, 0
        switch currentTick() {
${fixturesSource()}
        }
        world.Actors = world.Actors.AppendActor(actor).AppendActor(target)
        for index := range skulls {
            corpse := makeActor(actorinfo.ActorSkull, (-400 + 36 * index) << 16, -250 << 16, 0, 0, 0, 0, 0, -1, play.MoveCorpse)
            corpse.Tics = -1
            world.Actors = world.Actors.AppendActor(corpse)
        }
        baseCount := world.Actors.Count
        blocks := wad.LoadBlockMap(level)
        world.Links = play.BuildActorLinks(world.Actors, blocks)
        rules := play.CombatRules{Skill: 2}
        for index := range actionCount {
            action := actions[index]
            if action == actorinfo.ActionTracer {
                trace := enemy.RunTracer(level, world, 1, gameTic, rules)
                if trace.Failed { log(-1) }
                world = trace.World
            } else if action == actorinfo.ActionPainAttack || action == actorinfo.ActionPainDie {
                var burst enemy.PainElementalStep
                if action == actorinfo.ActionPainDie { burst = enemy.BeginPainDie(level, blocks, world, 1, rules)
                } else { burst = enemy.BeginPainAttack(level, blocks, world, 1, rules) }
                done := false
                for range 24 {
                    if !done {
                        sound := burst.Combat.Feedback.Sound
                        if sound != 0 { log(12, sound) }
                        if burst.Combat.Failed { log(-1) }
                        done = burst.Done || burst.Combat.Failed
                        if !done { burst = enemy.ResumePainElemental(level, blocks, burst, rules) }
                    }
                }
                if !done { log(-1) }
                world = burst.Combat.World
            } else {
                attack := enemy.BeginMonsterAttack(level, blocks, world, 1, action, rules)
                done := false
                for range 32 {
                    if !done {
                        sound := attack.Combat.Feedback.Sound
                        if sound != 0 { log(12, sound) }
                        if attack.Combat.Failed { log(-1) }
                        done = attack.Done || attack.Combat.Failed
                        if !done { attack = enemy.ResumeMonsterAttack(level, blocks, attack, rules) }
                    }
                }
                if !done { log(-1) }
                world = attack.Combat.World
            }
            current := world.Actors.ActorAt(0)
            body, physics := current.Physics.Body, current.Physics
            log(10, body.X, body.Y, body.Z, physics.Angle, physics.MomentumX, physics.MomentumY, physics.MomentumZ,
                body.Flags, current.Target, current.Tracer)
            for i := range world.Actors.Count - baseCount {
                spawned := world.Actors.ActorAt(baseCount + i)
                body, physics = spawned.Physics.Body, spawned.Physics
                log(11, spawned.Kind, body.X, body.Y, body.Z, physics.Angle, physics.MomentumX, physics.MomentumY, physics.MomentumZ,
                    spawned.Tics, spawned.Target, spawned.Tracer, spawned.State, spawned.LastLook, spawned.Sector, spawned.Health, body.Flags)
            }
            log(13, world.Random.GameplayIndex, world.Actors.ActorAt(1).Health)
        }
        log(99, currentTick())
    }
}
`);
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 40_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    const sim = simulator(decode(encoded), true);
    return cases.map((fixture, index) => {
        const before = sim.logs.length;
        for (let host = 0; host < 96 && sim.logs.length === before; host++) sim.step();
        const raw = Array.from(sim.logs.slice(before), row => Array.from(row, Number));
        assert.deepEqual(raw.pop(), [99, index], fixture.name + " committed its tic");
        assert.ok(raw.every(([tag]) => tag >= 10 && tag <= 13), fixture.name + " resolved its action");
        const frames = [];
        let frame = { actor: [], spawns: [], sounds: [] };
        for (const [tag, ...row] of raw) {
            if (tag === 10) frame.actor = row;
            if (tag === 11) frame.spawns.push(row);
            if (tag === 12) frame.sounds.push(row[0]);
            if (tag === 13) {
                frames.push({ ...frame, rng: row[0], targetHealth: row[1] });
                frame = { actor: [], spawns: [], sounds: [] };
            }
        }
        assert.equal(frames.length, fixture.actions.length, fixture.name);
        return frames;
    });
}

function compare(actual, native, fixture, index) {
    const command = fixture.actions[index];
    const { damage, ...expected } = native;
    let { targetHealth, ...observed } = actual;
    if (command === "fist" || fixture.bites) {
        assert.deepEqual(damage.slice(0, 3), [2, 1, 1]);
        assert.equal(fixture.target.health - targetHealth, damage[3]);
        // Damage is probed by the C harness. The real Fletcher routine also
        // consumes a pain roll after subtracting this nonlethal hit.
        observed.rng = (observed.rng - 1) & 255;
    } else if (command === "painAttack" && !fixture.tryMove) {
        assert.deepEqual(damage, [3, 1, 1, 10000]);
        const [skull] = observed.spawns;
        assert.equal(skull[14], -9900);
        assert.equal(skull[15] & 0x1000004, 0, "rejected skull cannot attack or be hit");
        // Compare the blocked spawn itself. Fletcher runs the subsequent
        // death action and thrust, which the C harness reports as a request.
        observed.spawns = observed.spawns.map(row => row.slice(0, 5));
        expected.spawns = expected.spawns.map(row => row.slice(0, 5));
        observed.rng = (observed.rng - 1) & 255;
    } else {
        assert.deepEqual(damage, [0, 0, 0, 0], fixture.name + " has no direct damage request");
        assert.equal(targetHealth, fixture.target.health);
    }
    assert.deepEqual(observed, expected, fixture.name + " " + command);
}

const digest = trace => createHash("sha256").update(JSON.stringify(trace)).digest("hex");
try {
    const observed = traceFletcher();
    if (values.upstream) {
        const native = runNativeHeavyOracle(path.resolve(root, values.upstream), scratch, cases);
        cases.forEach((fixture, i) => fixture.actions.forEach((_, j) => compare(observed[i][j], native[i][j], fixture, j)));
        console.log(`Matched ${cases.length} specialized monster action cases with pinned Doom C. Fletcher SHA-256 ${digest(observed)}.`);
    } else {
        assert.equal(digest(observed), "8221d547663e831d87a0a5b8f0330db240a7de420dee8b4dc39ff1a6e8b2c364");
        console.log(`Verified ${cases.length} specialized monster action cases against the pinned snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-heavy-actions-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
