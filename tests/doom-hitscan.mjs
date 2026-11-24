import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { hitscanFixtures as cases } from "./doom-hitscan-fixtures.mjs";
import { runNativeHitscanOracle } from "./doom-native-hitscan-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-hitscan-"));
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const unit = 65536;
const actorHealth = 500;

function records(rows, size, write) {
    const data = Buffer.alloc(rows.length * size);
    rows.forEach((row, index) => write(data, index * size, row));
    return { data, count: rows.length };
}

function blockLump({ x, y, width, height, lines }) {
    assert.equal(lines.length, width * height);
    let next = 4 + lines.length;
    const words = [x / unit, y / unit, width, height];
    for (const cell of lines) {
        words.push(next);
        next += cell.length + 1;
    }
    for (const cell of lines) words.push(...cell, -1);
    const data = Buffer.alloc(words.length * 2);
    words.forEach((word, index) => data.writeUInt16LE(word & 0xffff, index * 2));
    return { data, count: data.length };
}

function geometry(fixture) {
    const sides = [];
    const lines = fixture.lines.map(([v1, v2, flags, action, front, back, tag = 0]) => {
        const right = sides.push(front) - 1;
        const left = back < 0 ? 0xffff : sides.push(back) - 1;
        return [v1, v2, flags, action, tag, right, left];
    });
    return {
        Vertices: records(fixture.vertices, 4, (data, offset, [x, y]) => {
            data.writeInt16LE(x / unit, offset);
            data.writeInt16LE(y / unit, offset + 2);
        }),
        Sectors: records(fixture.sectors, 26, (data, offset, [floor, ceiling, sky, tag = 0]) => {
            data.writeInt16LE(floor / unit, offset);
            data.writeInt16LE(ceiling / unit, offset + 2);
            if (sky) data.write("F_SKY1", offset + 12, "ascii");
            data.writeInt16LE(tag, offset + 24);
        }),
        Lines: records(lines, 14, (data, offset, row) => {
            row.forEach((value, index) => data.writeUInt16LE(value, offset + 2 * index));
        }),
        Sides: records(sides, 30, (data, offset, sector) => data.writeUInt16LE(sector, offset + 28)),
        Segs: records([[0, 1]], 12, (data, offset, [, last]) => data.writeUInt16LE(last, offset + 2)),
        Subsectors: records([1], 4, (data, offset, count) => data.writeUInt16LE(count, offset)),
        Nodes: { data: Buffer.alloc(0), count: 0 },
        BlockMap: blockLump(fixture.blocks),
    };
}

function compileCases() {
    const blobs = [];
    let offset = 0;
    const source = cases.map((fixture, index) => {
        const lumps = Object.entries(geometry(fixture)).map(([name, { data, count }]) => {
            const line = `                ${name}: wad.Lump{Valid: true, Offset: ${offset}, Count: ${count}},`;
            offset += data.length;
            blobs.push(data);
            return line;
        });
        const actors = fixture.actors.map((record, i) => {
            const slot = i + 1 === fixture.shooter && !fixture.enemyAction ? 0 : fixture.bfgAngle === undefined ? -1 : i;
            return `            world.Actors = world.Actors.AppendActor(makeActor(${[...record, slot].join(", ")}))`;
        });
        const overrides = fixture.overrides.map(([line, sector, height], i) => `
            triggers[${i}], sectors[${i}], ceilings[${i}] = ${line}, ${sector}, ${height}`);
        const rawPath = fixture.pathEnd ? `
            rawPath, endX, endY = true, ${fixture.pathEnd.join(", ")}` : "";
        return `        case ${index}:
            base = wad.BspLevel{Valid: true, File: Geometry,
${lumps.join("\n")}
            }
            shooter, heading, distance, amount = ${fixture.shooter}, bits<32>(${fixture.angle}), ${fixture.range}, ${fixture.amount}
            auto, fixedSlope = ${fixture.slope === null}, ${fixture.slope ?? 0}
            gunMode, accurate = ${fixture.gun !== undefined}, ${fixture.gun ?? false}
            bfg, bfgAngle = ${fixture.bfgAngle !== undefined}, bits<32>(${fixture.bfgAngle ?? 0})
            weaponAction, strength = ${fixture.weaponAction ?? 0}, ${fixture.strength ? 1 : 0}
            enemyAction = ${fixture.enemyAction ?? 0}
            world.Random.GameplayIndex = ${fixture.randomIndex ?? 0}
            overrideCount, realSpecial = ${fixture.overrides.length}, ${fixture.realSpecial ?? false}${rawPath}
${actors.join("\n")}
${overrides.join("")}`;
    });
    writeFileSync(path.join(scratch, "HITSCAN.BIN"), Buffer.concat(blobs));
    return source.join("\n");
}

function traceFletcher() {
    const source = path.join(scratch, "main.flt"), output = path.join(scratch, "result.json");
    writeFileSync(source, `package main
import "actorinfo"
import "enemy"
import "engine"
import "play"
import "wad"
const Geometry = readFile("HITSCAN.BIN")

func makeActor(x int, y int, z int, height int, radius int, flags bits<32>, slot int) play.LevelActor {
    kind := actorinfo.ActorPossessed
    if slot >= 0 { kind = actorinfo.ActorPlayer }
    info := actorinfo.KindAt(kind)
    state := actorinfo.StateAt(info.SpawnState)
    return play.LevelActor{Valid: true, Kind: kind, Health: ${actorHealth}, PlayerSlot: slot, State: info.SpawnState,
        Tics: state.Tics, Physics: play.ActorPhysics{Body: play.MapActor{X: x, Y: y, Z: z, Height: height,
            Radius: radius, Flags: flags, Player: slot >= 0}}}
}

map "Doom hitscan parity" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        var base wad.BspLevel
        var world play.CombatWorld
        var heading bits<32>
        var auto bit
        var rawPath bit
        var realSpecial bit
        var gunMode bit
        var accurate bit
        var bfg bit
        var bfgAngle bits<32>
        var triggers [4]int
        var sectors [4]int
        var ceilings [4]int
        shooter, distance, amount, fixedSlope, overrideCount, endX, endY := 0, 0, 0, 0, 0, 0, 0
        weaponAction, strength := 0, 0
        enemyAction := 0
        switch currentTick() / 2 {
${compileCases()}
        }
        source := world.Actors.ActorAt(shooter - 1)
        source.Physics.Angle = heading
        world.Actors = world.Actors.WithActor(shooter, source)
        blocks := wad.LoadBlockMap(base)
        world.Links = play.BuildActorLinks(world.Actors, blocks)
        world.Players[0] = play.NewPlayerInventory(${actorHealth})
        world.Players[0].Powers[play.PowerStrength] = strength
        if bfg {
            if currentTick() % 2 != 0 {
                for i := range wad.VanillaPlayers - 1 {
                    world.Players[i + 1] = play.NewPlayerInventory(${actorHealth})
                    world.Players[i + 1].Powers[play.PowerInvulnerability] = 1
                }
                missile := world.Actors.Count + 1
                world.Actors = world.Actors.AppendActor(play.LevelActor{Valid: true, Kind: actorinfo.ActorBfg,
                    Target: shooter, PlayerSlot: -1, Physics: play.ActorPhysics{Angle: bfgAngle}})
                rules := play.CombatRules{Skill: 2}
                spray := play.BeginBfgSpray(base, blocks, world, missile, rules)
                finished := false
                for range 64 {
                    if !finished {
                        if spray.Combat.Failed { log(-1); finished = true }
                        if spray.Effect > 0 {
                            effect := spray.Combat.World.Actors.ActorAt(spray.Effect - 1)
                            body := effect.Physics.Body
                            log(6, effect.Kind, body.X, body.Y, body.Z, effect.Physics.MomentumZ, effect.State, effect.Tics, effect.LastLook)
                            hit := spray.Hit
                            log(4, hit.Target, hit.Inflictor, hit.Source, hit.Amount)
                        }
                        if spray.Done { finished = true }
                        if !finished { spray = play.ResumeBfgSpray(base, blocks, spray, rules) }
                    }
                }
                if !finished { log(-1) }
                log(17, spray.Combat.World.Random.GameplayIndex)
            }
        } else if enemyAction != 0 {
            if currentTick() % 2 != 0 {
                source.Target = 2
                world.Actors = world.Actors.WithActor(shooter, source)
                rules := play.CombatRules{Skill: 2}
                attack := enemy.BeginMonsterAttack(base, blocks, world, shooter, enemyAction, rules)
                finished := false
                for range 32 {
                    if !finished {
                        if attack.Combat.Failed { log(-1); finished = true }
                        if attack.Combat.Feedback.Sound != 0 { log(15, attack.Combat.Feedback.Sound) }
                        shot := attack.Shot()
                        impact := shot.Impact
                        if impact.EffectActor > 0 {
                            effect := attack.Combat.World.Actors.ActorAt(impact.EffectActor - 1)
                            body := effect.Physics.Body
                            log(2, impact.X, impact.Y, impact.Z)
                            log(6, effect.Kind, body.X, body.Y, body.Z, effect.Physics.MomentumZ, effect.State, effect.Tics, effect.LastLook)
                        }
                        if attack.Done { finished = true }
                        if !finished { attack = enemy.ResumeMonsterAttack(base, blocks, attack, rules) }
                    }
                }
                if !finished { log(-1) }
                resolved := attack.Combat.World.Actors.ActorAt(shooter - 1).Physics
                log(14, resolved.Angle, resolved.Body.Flags, attack.Combat.World.Random.GameplayIndex)
            }
        } else if weaponAction != 0 {
            if currentTick() % 2 != 0 {
                rules := play.CombatRules{Skill: 2}
                attack := play.BeginWeaponAttack(base, blocks, world, shooter, weaponAction, 0, rules)
                damageCalls := 0
                finished := false
                for range 64 {
                    if !finished {
                        if attack.Combat.Failed { log(-1); finished = true }
                        if attack.SpecialLine >= 0 { log(1, attack.SpecialLine) }
                        impact, hit := attack.Impact, attack.Hit
                        if impact.EffectActor > 0 {
                            effect := attack.Combat.World.Actors.ActorAt(impact.EffectActor - 1)
                            body := effect.Physics.Body
                            if effect.Kind == actorinfo.ActorPuff { log(2, impact.X, impact.Y, impact.Z) }
                            if effect.Kind == actorinfo.ActorBlood { log(3, impact.X, impact.Y, impact.Z, hit.Amount) }
                            log(6, effect.Kind, body.X, body.Y, body.Z, effect.Physics.MomentumZ, effect.State, effect.Tics, effect.LastLook)
                        }
                        if hit.Target > 0 { log(4, hit.Target, hit.Inflictor, hit.Source, hit.Amount); damageCalls = damageCalls + 1 }
                        if attack.Combat.Feedback.Sound != 0 { log(15, attack.Combat.Feedback.Sound) }
                        if attack.Done { finished = true }
                        if !finished { attack = play.ResumeWeaponAttack(base, blocks, attack, rules) }
                    }
                }
                if !finished { log(-1) }
                resolved := attack.Combat.World.Actors.ActorAt(shooter - 1).Physics
                // The native oracle records damage requests. Fletcher also applies them,
                // consuming a pain roll on the single, surviving melee target.
                log(14, resolved.Angle, resolved.Body.Flags, (attack.Combat.World.Random.GameplayIndex - damageCalls) & 255)
                if damageCalls > 0 { log(7, attack.Combat.World.Actors.ActorAt(1).Health) }
                if weaponAction == actorinfo.ActionFireShotgun {
                    // Drive the same seven pellets through the ready state and
                    // the real player tick. One held button starts the attack.
                    held := actorinfo.WeaponAt(play.WeaponShotgun)
                    view := play.WeaponView{Weapon: play.WeaponOverlay{State: held.Ready, Tics: 1, Y: 32 << 16}}
                    world.Players[0].ReadyWeapon, world.Players[0].PendingWeapon = play.WeaponShotgun, play.WeaponNoChange
                    world.Players[0].Ammo[play.AmmoShell] = 10
                    soundCount, noiseCount, lines := 0, 0, 0
                    for tic := range 4 {
                        weapon := play.BeginPlayerWeaponTick(base, blocks, world, shooter, view,
                            play.WeaponInput{Attack: true, LevelTime: tic}, rules)
                        for range 32 {
                            if !weapon.Done && !weapon.Combat.Failed {
                                if weapon.Combat.Feedback.Sound == actorinfo.SoundShotgun { soundCount = soundCount + 1 }
                                if weapon.Noise { noiseCount = noiseCount + 1 }
                                if weapon.SpecialLine >= 0 { lines = lines + 1 }
                                weapon = play.ResumePlayerWeaponTick(base, blocks, weapon, rules)
                            }
                        }
                        if !weapon.Done || weapon.Combat.Failed { log(-1) }
                        world, view = weapon.Combat.World, weapon.View
                    }
                    player := world.Actors.ActorAt(shooter - 1)
                    log(16, world.Players[0].Ammo[play.AmmoShell], world.Random.GameplayIndex, world.Actors.Count,
                        player.State, view.Flash.Tics, soundCount, noiseCount, lines)
                }
            }
        } else if currentTick() % 2 == 0 {
            body := world.Actors.ActorAt(shooter - 1).Physics.Body
            if !rawPath {
                endX = body.X + (distance >> 16) * engine.AngleCosine(heading)
                endY = body.Y + (distance >> 16) * engine.AngleSine(heading)
            }
            path := play.TraceAttackPath(base, blocks, world, body.X, body.Y, endX, endY)
            if !path.Valid { log(-1) }
            for i := range path.Count {
                hit := path.Hits.At(i)
                if hit.Fraction <= engine.FracUnit { log(9, hit.IsLine, hit.Index, hit.Fraction) }
            }
        } else {
            var aim play.LineAim
            if gunMode {
                selected := play.AimPlayerAttack(base, blocks, world, shooter)
                aim = play.LineAim{Valid: selected.Valid, Target: selected.Target, Slope: selected.Slope}
            } else {
                aim = play.AimLineAttack(base, blocks, world, shooter, heading, distance)
            }
            if !aim.Valid { log(-1) }
            log(0, aim.Target, aim.Slope)
            slope := fixedSlope
            if auto { slope = aim.Slope }

            live := base
            rules := play.CombatRules{Skill: 2}
            var changed play.LevelDoors
            var specials play.LevelSpecials
            var step play.LineAttackStep
            if gunMode {
                step = play.BeginGunShot(live, blocks, world, shooter, slope, accurate, rules)
            } else {
                step = play.BeginLineAttack(live, blocks, world, shooter, heading, distance, slope, amount, rules)
            }
            finished := false
            for range 16 {
                if !finished {
                    if step.Combat.Failed { log(-1); finished = true }
                    if step.Event == play.ShotSpecial {
                        line := step.SpecialLine
                        log(1, line)
                        if realSpecial {
                            specials = play.ShootLevelSpecial(live, specials, line, true)
                            live = specials.ApplyTo(base)
                        }
                        for i := range overrideCount {
                            if triggers[i] == line {
                                changed = changed.Append(play.SectorDoor{Sector: sectors[i], Order: changed.Count,
                                    State: play.DoorState{Ceiling: ceilings[i]}})
                                live = changed.ApplyTo(base)
                            }
                        }
                    }
                    impact := step.Impact
                    switch step.Event {
                    case play.ShotPuff: log(2, impact.X, impact.Y, impact.Z)
                    case play.ShotBlood: log(3, impact.X, impact.Y, impact.Z, step.Hit.Amount)
                    case play.ShotSky: log(5, impact.Line)
                    }
                    if impact.EffectActor > 0 {
                        effect := step.Combat.World.Actors.ActorAt(impact.EffectActor - 1)
                        body := effect.Physics.Body
                        log(6, effect.Kind, body.X, body.Y, body.Z, effect.Physics.MomentumZ, effect.State, effect.Tics, effect.LastLook)
                        if step.Combat.World.Links.SectorFirst(effect.Sector) != impact.EffectActor { log(-1) }
                    }
                    hit := step.Hit
                    if hit.Target > 0 { log(4, hit.Target, hit.Inflictor, hit.Source, hit.Amount) }
                    if step.Done { finished = true }
                    if !finished { step = play.ResumeLineAttack(live, step, rules) }
                }
            }
            if !finished { log(-1) }
            log(8, specials.Doors.Count, step.Combat.World.Random.GameplayIndex, step.Combat.World.Actors.Count)
            for i := range world.Actors.Count { log(7, step.Combat.World.Actors.ActorAt(i).Health) }
        }
        log(10, currentTick())
    }
}
`);
    const run = spawnSync("dotnet", [cli, "build", source, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (run.error) throw run.error;
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const map = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(Buffer.from(map.data, "base64")[2], 1);
    const sim = simulator(decode(map.data), true);
    function logicalTick(index, name) {
        const start = sim.logs.length;
        let hosts = 0;
        while (sim.logs.length === start && hosts < 64) {
            sim.step();
            hosts++;
        }
        const rows = Array.from(sim.logs.slice(start), row => Array.from(row, Number));
        assert.deepEqual(rows.pop(), [10, index], name + " committed its logical tick");
        return { rows, hosts };
    }
    return cases.map((fixture, index) => {
        const { rows: pathRows, hosts: pathHosts } = logicalTick(2 * index, fixture.name);
        if (fixture.bfgAngle !== undefined) {
            const { rows } = logicalTick(2 * index + 1, fixture.name);
            assert.ok(!rows.some(([tag]) => tag === -1), fixture.name + " ran to completion");
            const victims = rows.filter(([tag]) => tag === 4).map(([, target]) => target);
            assert.deepEqual([...new Set(victims)].sort(), fixture.blockedSpray ? [] : fixture.actors.slice(1).map((_, i) => i + 2));
            return rows;
        }
        if (fixture.weaponAction || fixture.enemyAction) {
            const { rows } = logicalTick(2 * index + 1, fixture.name);
            assert.ok(!rows.some(([tag]) => tag === -1), fixture.name + " ran to completion");
            assert.equal(rows.filter(([tag]) => tag === 2 || tag === 3).length, fixture.shots, fixture.name);
            if (fixture.weaponAction && fixture.actors.length === 2) {
                assert.deepEqual(rows.find(([tag]) => tag === 7), [7, actorHealth - fixture.amount], fixture.name);
            }
            if (fixture.weaponAction === 9) {
                assert.deepEqual(rows.find(([tag]) => tag === 16), [16, 9, 49, 8, 155, 3, 1, 1, 7],
                    "player command delivers shot, switches, ammo, game RNG, lights and flashes");
            }
            return rows.filter(([tag]) => tag !== 7 && tag !== 16);
        }
        const { rows: [aimRow, ...shotRows] } = logicalTick(2 * index + 1, fixture.name);
        const rows = [aimRow, ...pathRows, ...shotRows];
        const { aim, effect, target, specials, sky, state, pathCount } = fixture.expected;
        assert.ok(!rows.some(([tag]) => tag === -1), fixture.name + " did not fail");
        assert.equal(rows[0]?.[1], aim, fixture.name + " aim target");
        assert.equal(rows.find(([tag]) => tag === 2 || tag === 3)?.[0] ?? 0, effect, fixture.name + " impact effect");
        assert.equal(rows.find(([tag]) => tag === 4)?.[1], target, fixture.name + " damage target");
        assert.equal(rows.some(([tag]) => tag === 5), !!sky, fixture.name + " sky decision");
        assert.deepEqual(rows.filter(([tag]) => tag === 1).map(([, line]) => line), specials ?? [], fixture.name + " line callbacks");
        if (state) assert.equal(rows.find(([tag]) => tag === 6)?.[6], state, fixture.name + " effect state");
        const gunDraws = fixture.gun === undefined ? 0 : fixture.gun ? 1 : 3;
        const randomIndex = ((fixture.randomIndex ?? 0) + gunDraws + (effect ? 4 : 0) + (target ? 1 : 0)) & 255;
        assert.deepEqual(rows.find(([tag]) => tag === 8), [8, fixture.realSpecial ? 1 : 0,
            randomIndex, fixture.actors.length + (effect ? 1 : 0)], fixture.name + " world and RNG");
        assert.deepEqual(rows.filter(([tag]) => tag === 7).map(([, health]) => health), fixture.actors.map(
            (_, index) => actorHealth - (index + 1 === target ? fixture.amount : 0)), fixture.name + " applied damage");
        if (fixture.tie) {
            const ties = rows.filter(([tag, isLine, index]) => tag === 9 && (isLine || index !== fixture.shooter));
            assert.equal(ties[0]?.[3], ties[1]?.[3], fixture.name + " equal intercept fractions");
        }
        if (pathCount) assert.equal(rows.filter(([tag]) => tag === 9).length, pathCount, fixture.name);
        if (fixture.crowded) assert.ok(pathHosts > 1, "crowded blocks exercise resumable script work");
        return rows.filter(([tag]) => tag <= 4 || tag === 6 || tag === 9);
    });
}

const digest = trace => createHash("sha256").update(JSON.stringify(trace)).digest("hex");
try {
    const observed = traceFletcher();
    if (values.upstream) {
        const upstream = path.resolve(root, values.upstream);
        for (const expanded of [false, true]) {
            const indices = cases.flatMap((fixture, index) => !!fixture.expandedTrace === expanded ? [index] : []);
            const native = runNativeHitscanOracle(upstream, scratch, indices.map(index => cases[index]));
            indices.forEach((index, i) => assert.deepEqual(observed[index], native[i], cases[index].name));
            console.log(`Matched ${native.length} hitscan traces with pinned Linux Doom C using ${expanded ? "256" : "128"} intercept slots.`);
        }
        console.log(`SHA-256 ${digest(observed)}.`);
    } else {
        assert.equal(digest(observed), "0565a95a5915f769a3ab25538d543ca25a77f57944690baa5c69675cd68541ab");
        console.log(`Verified ${observed.length} hitscan traces against the pinned C snapshots.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-hitscan-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
