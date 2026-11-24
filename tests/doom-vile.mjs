import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runNativeVileOracle } from "./doom-native-vile-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-vile-"));
const unit = 65536;
const actorVile = 3, actorImp = 11, actorSkull = 18;
const actions = { start: 1, target: 2, fire: 3, startFire: 4, crackle: 5, attack: 6, chase: 7 };

function body(kind, { x = 0, y = 0, z = 0, angle = 0, mx = 0, my = 0, mz = 0, health = 1000, flags = 6,
    dir = 0, tics = 1, radius = -1, height = -1 } = {}) {
    return [kind, x * unit, y * unit, z * unit, angle, mx * unit, my * unit, mz * unit, health, flags,
        dir, tics, radius * unit, height * unit].map(Math.trunc);
}

function corpse(x, y, options) {
    return body(options?.kind ?? actorImp, { x, y, health: -2, flags: 0x100400, mx: 3, my: -2, mz: 2,
        height: 14, tics: -1, ...options });
}

function fixture(name, commands, { vile = body(actorVile, { y: -140, flags: 0x400026 }),
    victim = body(0, { x: 28, angle: 0x40000000, flags: 4 }), extra = [], ...rest } = {}) {
    return { name, commands, bodies: [vile, victim, ...extra], blocked: false, low: false, target: true, rng: 0, ...rest };
}

const walkingVile = body(actorVile, { y: -80, flags: 0x400026 });
const farTarget = body(0, { x: 250, y: 70 });
const cases = [
    fixture("windup, front follow, sound and a blast across the BSP split without relinking", ["start", "target", "startFire", "crackle", "attack"], { resolveBlast: 63 }),
    fixture("flame moves from its initial spawn's high sector and preserves cached heights", ["target", "fire"], {
        victim: body(0, { x: 110, y: -40, z: 7 }), rng: 81,
    }),
    fixture("REJECT stops follow and the attack but leaves crackle sound and the original flame origin", ["target", "crackle", "attack"], {
        victim: body(0, { x: 110, y: -40, z: 7, flags: 0x40004 }), blocked: true, rng: 254,
    }),
    fixture("direct strike lifts the target even without a fire actor", ["attack"], {
        victim: body(actorImp, { x: 56, y: 32, flags: 0x41004 }), rng: 14,
    }),
    fixture("missing target skips spawn and damage", ["start", "target", "attack"], { target: false }),
    fixture("successful raise restores the state, flags and health while retaining the old target", ["chase"], {
        vile: walkingVile, victim: farTarget, extra: [corpse(48, -80, { flags: 0x140400 })], rng: 253,
    }),
    fixture("newest corpse is rejected by an overlapping solid; the earlier corpse is next", ["chase"], {
        vile: walkingVile, victim: body(0, { x: 78, y: -76, flags: 2 }), extra: [corpse(38, -120), corpse(49, -75)],
    }),
    fixture("search examines the left block before the right block", ["chase"], {
        vile: body(actorVile, { x: 110, y: -30 }), victim: farTarget, extra: [corpse(127, 10), corpse(129, 10)],
    }),
    fixture("diagonal chase uses the integer movement table at the exact radius boundary", ["chase"], {
        vile: body(actorVile, { y: -80, dir: 1 }), victim: farTarget,
        extra: [corpse(40 + 705000 / unit, -80 + 705000 / unit)],
    }),
    fixture("P_CheckPosition permits a raise under less than standing clearance", ["chase"], {
        vile: body(actorVile, { y: 22 }), victim: farTarget, low: true, extra: [corpse(48, 22)],
    }),
    fixture("resurrection preserves the zero dimensions of a crushed corpse", ["chase"], {
        vile: body(actorVile, { y: 22 }), victim: farTarget, low: true, extra: [corpse(48, 22, { radius: 0, height: 0 })],
    }),
    fixture("uncollapsed and non-raisable corpses are ignored and normal chase continues", ["chase"], {
        vile: walkingVile, victim: farTarget, extra: [corpse(48, -80, { kind: actorSkull }), corpse(49, -82, { tics: 3 })],
    }),
    fixture("no movement direction skips the whole search", ["chase"], {
        vile: body(actorVile, { y: -80, dir: 8 }), victim: farTarget, extra: [corpse(48, -80)],
    }),
    fixture("rejected resurrection still zeroes the checked corpse's horizontal momentum", ["chase"], {
        vile: walkingVile, victim: body(0, { x: 76, y: -78, flags: 2 }), extra: [corpse(47, -80)],
    }),
];

function words(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => bytes.writeUInt16LE(value & 65535, index * 2));
    return bytes;
}

function fixtureSource() {
    const geometry = [];
    let offset = 0;
    const arms = cases.map((fixture, index) => {
        const sectors = Buffer.concat([words([0, 192]), Buffer.alloc(22), words([8, fixture.low ? 32 : 160]), Buffer.alloc(22)]);
        const nodes = Buffer.alloc(28), sides = Buffer.alloc(60);
        nodes.writeInt16LE(8, 2);
        nodes.writeInt16LE(1, 4);
        nodes.writeUInt16LE(0x8000, 24);
        nodes.writeUInt16LE(0x8001, 26);
        sides.writeUInt16LE(1, 58);
        const blocks = words([-512, -512, 8, 8, ...Array(64).fill(68), -1]);
        const lumps = [
            ["Vertices", words([-340, -300, 340, -300, 340, 300, -340, 300]), 4],
            ["Lines", words([0, 1, 0, 0, 0, 0, 65535, 2, 3, 0, 0, 0, 1, 65535]), 2],
            ["Sides", sides, 2], ["Sectors", sectors, 2], ["Segs", words([0, 1, 0, 0, 0, 0, 2, 3, 0, 1, 0, 0]), 2],
            ["Subsectors", words([1, 0, 1, 1]), 2], ["Nodes", nodes, 1], ["BlockMap", blocks, blocks.length],
            ["Reject", Buffer.of(fixture.blocked ? 15 : 0), 1],
        ];
        const descriptors = lumps.map(([name, bytes, count]) => {
            const entry = `${name}: wad.Lump{Offset: ${offset}, Count: ${count}, Valid: true}`;
            geometry.push(bytes);
            offset += bytes.length;
            return entry;
        });
        const rows = fixture.bodies.map((body, j) => {
            const args = body.map((value, i) => i === 4 ? `bits<32>(${value})` : value);
            return `world.Actors = world.Actors.AppendActor(seed(level, ${args}, ${j === 0 && fixture.target ? 2 : 0}))`;
        });
        const commands = fixture.commands.map(command => actions[command]);
        const padded = commands.concat(Array(5 - commands.length).fill(0));
        return `        case ${index}:
            level = wad.BspLevel{File: data,\n                ${descriptors.join(",\n                ")}, Valid: true}
            world.Random.GameplayIndex = ${fixture.rng}
            ${rows.join("\n            ")}
            commands, commandCount = [5]int{${padded}}, ${commands.length}
            resolveBlast = ${Boolean(fixture.resolveBlast)}`;
    });
    return { data: Buffer.concat(geometry), script: template.replace("@CASES@", arms.join("\n")) };
}

const template = `package main
import "enemy"
import "actorinfo"
import "play"
import "wad"

const data = readFile("geometry.bin")

func seed(level wad.BspLevel, kind int, x int, y int, z int, angle bits<32>, mx int, my int, mz int,
    health int, flags int, dir int, tics int, radius int, height int, target int) play.LevelActor {
    actor := play.SpawnMobj(level, kind, x, y, z, 2, play.RandomState{}).Actor
    actor.Target, actor.Health, actor.Tics, actor.LastLook = target, health, tics, 0
    actor.MoveDirection, actor.Physics.Angle = dir, angle
    actor.Physics.MomentumX, actor.Physics.MomentumY, actor.Physics.MomentumZ = mx, my, mz
    actor.Physics.Body.Flags = bits<32>(flags)
    if radius >= 0 { actor.Physics.Body.Radius = radius }
    if height >= 0 { actor.Physics.Body.Height = height }
    return actor
}

map "Arch-vile actions" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        var level wad.BspLevel
        var world play.CombatWorld
        var commands [5]int
        commandCount := 0
        resolveBlast := false
        switch currentTick() {
@CASES@
        }
        blocks := wad.LoadBlockMap(level)
        world.Links = play.BuildActorLinks(world.Actors, blocks)
        rules := play.CombatRules{Skill: 2}
        for index := range commandCount {
            command := commands[index]
            var result play.CombatStep
            var damage play.DamageRequest
            fireHandle := world.Actors.ActorAt(0).Tracer
            origin, source, blastDamage, chase := 0, 0, 0, 0
            switch command {
            case 1: result = enemy.VileStart(world, 1)
            case 2: result = enemy.TargetVileFire(level, world, 1, rules)
            case 3: result = enemy.MoveVileFire(level, world, fireHandle, actorinfo.ActionFire)
            case 4: result = enemy.MoveVileFire(level, world, fireHandle, actorinfo.ActionStartFire)
            case 5: result = enemy.MoveVileFire(level, world, fireHandle, actorinfo.ActionFireCrackle)
            case 6:
                step := enemy.BeginVileAttack(level, world, 1, rules)
                sound := step.Combat.Feedback
                damage = step.Damage
                for range actorinfo.ActorStateCount {
                    if !step.Done && !step.Combat.Failed { step = enemy.ResumeVileAttack(level, step, rules) }
                }
                result = step.Combat
                result.Feedback = sound
                if !step.Done { result.Failed = true }
                origin, source = step.BlastOrigin, step.BlastSource
                if origin != 0 { blastDamage = enemy.VileBlastDamage }
            case 7:
                raised := enemy.TryVileResurrection(level, blocks, world, 1)
                result = play.CombatStep{World: raised.World, Feedback: raised.Feedback, Failed: raised.Failed}
                if !raised.Raised { chase = 1 }
            }
            if result.Failed { log(98, command) }
            world = result.World
            for index := range world.Actors.Count {
                actor := world.Actors.ActorAt(index)
                body, physics := actor.Physics.Body, actor.Physics
                log(10, actor.Kind, body.X, body.Y, body.Z, physics.Angle, physics.MomentumX, physics.MomentumY, physics.MomentumZ,
                    actor.Health, body.Flags, body.Floor, body.Ceiling, actor.Sector, actor.LastLook, actor.Tics, actor.State,
                    actor.Target, actor.Tracer, body.Radius, body.Height)
            }
            log(11, world.Random.GameplayIndex, result.Feedback.SoundOrigin, result.Feedback.Sound, damage.Target, damage.Inflictor,
                damage.Source, damage.Amount, origin, source, blastDamage, chase)
            if origin > 0 && resolveBlast {
                blast := play.BeginRadiusAttack(level, blocks, world, origin, source, blastDamage, rules)
                amount := 0
                for range 128 {
                    if !blast.Done && !blast.Combat.Failed {
                        if blast.Hit.Target == 2 { amount = blast.Hit.Amount }
                        blast = play.ResumeRadiusAttack(level, blast, rules)
                    }
                }
                if blast.Done && !blast.Combat.Failed {
                    log(12, amount, blast.Combat.World.Actors.ActorAt(1).Health)
                } else { log(98, command) }
            }
        }
        log(99, currentTick())
    }
}
`;

function traceFletcher() {
    const { data, script } = fixtureSource();
    const source = path.join(scratch, "vile.flt"), output = path.join(scratch, "vile.json");
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
        const frames = [];
        let actors = [], splash;
        for (const [tag, ...row] of raw) {
            assert.ok(tag >= 10 && tag <= 12, fixture.name + " resolved all actions");
            if (tag === 10) actors.push(row);
            if (tag === 11) {
                const [rng, origin, sound, target, inflictor, source, amount, fire, attacker, blast, chase] = row;
                frames.push({ actors, rng, sound: [origin, sound], direct: [target, inflictor, source, amount], blast: [fire, attacker, blast], chase });
                actors = [];
            }
            if (tag === 12) splash = row;
        }
        assert.equal(frames.length, fixture.commands.length, fixture.name);
        if (fixture.resolveBlast) assert.deepEqual(splash, [fixture.resolveBlast, 980 - fixture.resolveBlast], "live BLOCKMAP blast applies damage");
        return frames;
    });
}

function compare(actual, expected, fixture, index) {
    const normalized = structuredClone(actual);
    if (expected.direct[3] !== 0) {
        const target = normalized.actors[1], before = expected.actors[1];
        // The native probe records the direct request. Fletcher applies it
        // and consumes a pain roll before installing the arch-vile thrust.
        assert.equal(target[8], before[8] - expected.direct[3]);
        assert.equal(normalized.rng, (expected.rng + 1) & 255);
        for (const field of [5, 6, 8, 9, 14, 15]) target[field] = before[field];
        normalized.rng = expected.rng;
    }
    assert.deepEqual(normalized, expected, `${fixture.name} ${fixture.commands[index]}`);
}

try {
    const observed = traceFletcher();
    const digest = createHash("sha256").update(JSON.stringify(observed)).digest("hex");
    if (values.upstream) {
        const native = runNativeVileOracle(path.resolve(root, values.upstream), scratch, cases);
        cases.forEach((fixture, i) => fixture.commands.forEach((_, j) => compare(observed[i][j], native[i][j], fixture, j)));
        console.log(`Matched ${cases.length} arch-vile fixtures with pinned Doom C. Fletcher SHA-256 ${digest}.`);
    } else {
        assert.equal(digest, "e664bd3c19e12f0eb5982b5bd2e6a5e0d1eed17f0f378e1cb18ac3a74ad5cc5b");
        console.log(`Verified ${cases.length} arch-vile fixtures against the pinned snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-vile-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
