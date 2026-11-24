import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runNativeDamageOracle } from "./doom-native-damage-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const port = path.join(root, "examples", "doom-engine");
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-damage-"));
const unit = 65536;
const flags = { solid: 2, shootable: 4, noGravity: 0x200, noClip: 0x1000, missile: 0x10000,
    float: 0x4000, corpse: 0x100000, countKill: 0x400000, skullFly: 0x1000000 };
const kinds = { player: 0, possessed: 1, shotGuy: 2, vile: 3, chainGuy: 10, skull: 18, wolfSS: 23,
    spider: 19, cyborg: 21, rocket: 33 };

function actor(kind, extra = {}) {
    const { x = 18, y = 7, z = 0, height = 56, mx = 1, my = 2, mz = 3, ...fields } = extra;
    return { kind, flags: flags.solid | flags.shootable | flags.countKill, health: 20,
        x: x * unit, y: y * unit, z: z * unit, height: height * unit, mx: mx * unit, my: my * unit, mz: mz * unit,
        slot: -1, reaction: 8, threshold: 0, target: 0, ...fields };
}
function player(slot, extra = {}) {
    return actor(kinds.player, { health: 100, slot, flags: flags.solid | flags.shootable, ...extra });
}
function inventory(extra = {}) {
    return { health: 100, armor: 0, armorType: 0, invulnerable: 0, ready: 1, cheats: 0, damageCount: 0,
        attacker: 0, killCount: 0, frags: [0, 0, 0, 0], ...extra };
}

const zombie = actor(kinds.possessed);
const shooter = player(3, { x: -40, y: -38 });
const projectile = actor(kinds.rocket, { x: 12, y: -9, height: 8, flags: flags.missile | flags.noGravity });
function damage(name, target, amount, extra = {}) {
    const { actors = [target, projectile, shooter], hit = [1, 2, 3, amount], players = [], ...rules } = extra;
    return { name, actors, hit, players: Array.from({ length: 4 }, (_, slot) => inventory(players[slot])),
        skill: 2, consolePlayer: 0, automap: false, sectorSpecial: 0,
        randomIndex: 0, rollOnAction: false, ...rules };
}
const movingRocket = extra => actor(kinds.rocket, {
    x: -48, y: 0, height: 8, mx: 30, my: 0, mz: 0, flags: flags.noGravity | flags.missile, target: 2, ...extra,
});
const movingSkull = extra => actor(kinds.skull, {
    x: -28, y: 0, mx: 15, my: 0, mz: 2, health: 100,
    flags: flags.noGravity | flags.skullFly | flags.shootable | flags.solid, ...extra,
});
const victim = actor(kinds.possessed, { x: 0, y: 0 });
const owner = player(3, { x: -85, y: -60 });
const motion = (name, actors, extra = {}) => damage(name, actors[0], 0, { actors, move: actors.length, ...extra });
const cases = [
    damage("ignore unshootable actors", { ...zombie, flags: flags.solid }, 10),
    damage("ignore actors already dead", { ...zombie, health: -1 }, 10),
    damage("baby damage halves before green armor, with console feedback", player(0), 55,
        { skill: 0, players: [{ armor: 13, armorType: 1, damageCount: 97, attacker: 3 }] }),
    damage("blue armor depletes exactly at the saved half", player(0), 21,
        { players: [{ armor: 10, armorType: 2 }] }),
    damage("god mode keeps thrust and skips all subsequent effects", player(0), 80,
        { players: [{ cheats: 2, attacker: 2 }], randomIndex: 19 }),
    damage("invulnerability rejects 999 damage", player(0), 999,
        { players: [{ invulnerable: 15 }] }),
    damage("1000 damage overrides both protections", player(0), 1000,
        { automap: true, players: [{ invulnerable: 15, cheats: 2 }], rollOnAction: true }),
    damage("sector 11 caps damage at health minus one", player(0), 1000,
        { sectorSpecial: 11, players: [{ armor: 10, armorType: 2 }] }),
    damage("chainsaw source suppresses thrust even with a distinct inflictor", zombie, 1,
        { players: [null, null, null, { ready: 7 }] }),
    damage("no-clip target suppresses thrust", { ...zombie, flags: zombie.flags | flags.noClip }, 1),
    damage("skull charge clears three momentum axes before thrust", actor(kinds.skull, {
        health: 100, flags: flags.solid | flags.shootable | flags.noGravity | flags.skullFly,
    }), 1),
    damage("lethal low damage with a high fall reverses and quadruples thrust on an odd roll",
        actor(kinds.possessed, { z: 65, health: 8 }), 30, { randomIndex: 1, rollOnAction: true }),
    damage("even fall roll leaves thrust forward", actor(kinds.possessed, { z: 65, health: 8 }), 30),
    damage("exactly 64 units never draws the reversal roll", actor(kinds.possessed, { z: 64, health: 8 }), 30,
        { randomIndex: 1 }),
    damage("successful pain enters a state before changing the target", zombie, 1),
    damage("cyberdemon pain action runs before retargeting", actor(kinds.cyborg, { health: 500 }), 1,
        { rollOnAction: true }),
    damage("failed pain wakes the spawn state and runs its chase action", zombie, 1,
        { randomIndex: 2, rollOnAction: true }),
    damage("existing threshold preserves the target when pain fails", { ...zombie, target: 2, threshold: 7 }, 1,
        { randomIndex: 2 }),
    damage("arch-vile target ignores its threshold", actor(kinds.vile, { health: 700, target: 2, threshold: 7 }), 1,
        { randomIndex: 2 }),
    damage("arch-vile source does not become the target", zombie, 1,
        { actors: [zombie, projectile, actor(kinds.vile)], randomIndex: 2 }),
    damage("actor cannot retarget itself", zombie, 1, { hit: [1, 1, 1, 1], randomIndex: 2 }),
    damage("environment death charges self-frag and closes console automap", player(0, { health: 22 }), 30,
        { hit: [1, 0, 0, 30], automap: true, rollOnAction: true, players: [{ health: 22, frags: [4, 3, 2, 1] }] }),
    damage("a lethal self-inflicted rocket credits a self-frag", player(0, { health: 13 }), 20,
        { actors: [player(0, { health: 13 }), projectile], hit: [1, 2, 1, 20], automap: true,
            players: [{ health: 13, frags: [4, 0, 0, 0] }] }),
    damage("environmental monster kill credits slot zero in single player", zombie, 20,
        { hit: [1, 0, 0, 20], players: [{ killCount: 19 }] }),
    damage("a monster killed by infighting credits the campaign player", zombie, 20,
        { actors: [zombie, actor(kinds.shotGuy)], hit: [1, 2, 2, 20], players: [{ killCount: 19 }] }),
    damage("exact negative spawn health uses ordinary death", zombie, 40, { rollOnAction: true }),
    damage("one point past negative spawn health chooses the gib state", zombie, 41, { rollOnAction: true }),
    damage("spider death action runs before jitter is drawn", actor(kinds.spider, { health: 4 }), 10,
        { rollOnAction: true }),
    damage("lost soul corpse keeps no-gravity while other flight flags clear", actor(kinds.skull, {
        flags: flags.solid | flags.shootable | flags.noGravity | flags.float | flags.skullFly,
    }), 40),
    ...[kinds.shotGuy, kinds.chainGuy, kinds.wolfSS].map(kind => damage("dropped item from kind " + kind,
        actor(kind, { z: 12 }), 23, { rollOnAction: true, randomIndex: 254 })),
    damage("rocket explosion enters the action before drawing jitter and emitting sound", projectile, 0,
        { actors: [projectile], explosion: 1, rollOnAction: true, randomIndex: 5 }),
    motion("split rocket reaches the target on its second substep", [victim, owner, movingRocket()],
        { rollOnAction: true }),
    motion("first substep impact finishes damage and explosion before the remaining substep",
        [victim, owner, movingRocket({ x: -28 })], { rollOnAction: true }),
    motion("same-species rocket contact explodes without damaging the target",
        [victim, actor(kinds.possessed, { x: -85, y: -60 }), movingRocket()]),
    motion("missile passes above the target and keeps both substeps",
        [victim, owner, movingRocket({ z: 57 })]),
    motion("skull resolves its victim's death before it resets",
        [player(0, { x: 0, y: 0, health: 2 }), movingSkull()],
        { automap: true, rollOnAction: true, players: [{ health: 2 }] }),
    motion("skull waits for its victim's death action before running its own spawn action",
        [actor(kinds.spider, { x: 0, y: 0, health: 2 }), movingSkull()], { rollOnAction: true }),
    motion("stationary charging skull resets before the vertical thinker step",
        [movingSkull({ mx: 0, mz: 5 })], { rollOnAction: true }),
    motion("floor impact explodes a descending missile",
        [movingRocket({ z: 1, mx: 0, mz: -2, target: 0 })], { rollOnAction: true }),
    motion("ceiling impact explodes an ascending missile",
        [movingRocket({ z: 119, mx: 0, mz: 3, target: 0 })], { rollOnAction: true }),
    motion("no-clip missile clamps to the floor and does not explode",
        [movingRocket({ z: 1, mx: 0, mz: -2, target: 0, flags: flags.missile | flags.noClip | flags.noGravity })]),
    motion("ground actor relinks after a capped split and loses momentum to friction",
        [actor(kinds.possessed, { x: -50, y: -26, z: 0, mx: 37, my: -11, mz: 0 })]),
    motion("airborne actor moves before gravity starts",
        [actor(kinds.possessed, { x: -50, y: -26, z: 40, mx: -24, my: -11, mz: 0 })]),
    motion("Nightmare respawn consumes RNG after movement and timing",
        [actor(kinds.possessed, { mx: 0, my: 0, mz: 0, health: 0, tics: -1, moveCount: 419,
            flags: flags.corpse | flags.countKill })], { respawnMonsters: true, levelTime: 448, randomIndex: 255 }),
    motion("Nightmare respawn skips RNG outside its check cadence",
        [actor(kinds.possessed, { mx: 0, my: 0, mz: 0, health: 0, tics: -1, moveCount: 419,
            flags: flags.corpse | flags.countKill })], { respawnMonsters: true, levelTime: 447, randomIndex: 255 }),
];

function geometry() {
    const sizes = { Sectors: 26, Subsectors: 4, Segs: 12, Lines: 14, Sides: 30, Vertices: 8 };
    const total = Object.values(sizes).reduce((sum, size) => sum + size, 0);
    const base = Buffer.alloc(total * 2);
    const fields = [];
    let offset = 0;
    for (const [name, size] of Object.entries(sizes)) {
        fields.push(name + ": wad.Lump{Offset: base + " + offset + ", Count: " +
            (name === "Vertices" ? 2 : 1) + ", Valid: true},");
        offset += size;
    }
    for (const start of [0, total]) {
        base.writeInt16LE(128, start + 2); // SECTORS ceiling
        base.writeInt16LE(start ? 11 : 0, start + 22); // special
        base.writeUInt16LE(1, start + 26); // SSECTORS numsegs
        base.writeUInt16LE(1, start + 44); // LINEDEFS end vertex
        base.writeUInt16LE(0xffff, start + 54); // absent back sidedef
        base.writeInt16LE(256, start + total - 6);
        base.writeInt16LE(-256, start + total - 2);
    }
    const blockmap = Buffer.alloc(42);
    blockmap.writeInt16LE(-128);
    blockmap.writeInt16LE(-128, 2);
    blockmap.writeUInt16LE(4, 4);
    blockmap.writeUInt16LE(4, 6);
    for (let cell = 0; cell < 16; cell++) blockmap.writeUInt16LE(20, 8 + cell * 2);
    blockmap.writeInt16LE(-1, 40);
    writeFileSync(path.join(scratch, "MAP.BIN"), Buffer.concat([base, blockmap]));
    return `func level(special bit) wad.BspLevel {
    base := 0
    if special { base = ${total} }
    return wad.BspLevel{File: Geometry, Valid: true, Nodes: wad.Lump{Valid: true},
        BlockMap: wad.Lump{Offset: ${base.length}, Count: ${blockmap.length}, Valid: true},
        ${fields.join("\n        ")}
    }
}`;
}

function fixture(entry, index) {
    const actors = entry.actors.map(a => `            world.Actors = world.Actors.AppendActor(makeActor(
                ${[a.kind, a.flags, a.health, a.x, a.y, a.z, a.height, a.mx, a.my, a.mz, a.slot, a.reaction, a.threshold,
                    a.target, a.tics ?? 0, a.moveCount ?? 0].join(", ")}))`);
    const players = entry.players.map((p, slot) => `            world.Players[${slot}] = play.PlayerInventory{
                Health: ${p.health}, Armor: ${p.armor}, ArmorType: ${p.armorType}, ReadyWeapon: ${p.ready},
                Cheats: ${p.cheats}, DamageCount: ${p.damageCount}, Attacker: ${p.attacker}, KillCount: ${p.killCount},
                Frags: [4]int{${p.frags.join(", ")}},
            }
            world.Players[${slot}].Powers[play.PowerInvulnerability] = ${p.invulnerable}`);
    return `        case ${index}:
            rules = play.CombatRules{Skill: ${entry.skill}, ConsolePlayer: ${entry.consolePlayer},
                Automap: ${entry.automap}}
            world.Random.GameplayIndex = ${entry.randomIndex}
            special, rollOnAction, explosion = ${entry.sectorSpecial === 11}, ${entry.rollOnAction}, ${entry.explosion ?? 0}
            mover, levelTime, respawn = ${entry.move ?? 0}, ${entry.levelTime ?? 0}, ${entry.respawnMonsters ?? false}
            hit = play.DamageRequest{Target: ${entry.hit[0]}, Inflictor: ${entry.hit[1]},
                Source: ${entry.hit[2]}, Amount: ${entry.hit[3]}}
${actors.join("\n")}
${players.join("\n")}`;
}

function traceFletcher() {
    const source = path.join(scratch, "main.flt");
    const output = path.join(scratch, "result.json");
    writeFileSync(source, `package main
import "play"
import "wad"
import "actorinfo"
const Geometry = readFile("MAP.BIN")
${geometry()}
func makeActor(kind int, flags bits<32>, health int, x int, y int, z int,
    height int, mx int, my int, mz int, slot int, reaction int, threshold int, target int, tics int, moveCount int) play.LevelActor {
    info := actorinfo.KindAt(kind)
    state := actorinfo.StateAt(info.SpawnState)
    if tics == 0 { tics = state.Tics }
    return play.LevelActor{Valid: true, Kind: kind, Health: health, State: info.SpawnState, Tics: tics, MoveCount: moveCount,
        Sprite: state.Sprite, Frame: state.Frame, ReactionTime: reaction, Threshold: threshold, Target: target,
        PlayerSlot: slot, Physics: play.ActorPhysics{MomentumX: mx, MomentumY: my, MomentumZ: mz,
            Body: play.MapActor{X: x, Y: y, Z: z, Height: height, Flags: flags, Player: slot >= 0,
                Radius: info.Radius, Ceiling: 128 << 16}},
    }
}
map "Doom damage parity" {
    tick {
        var world play.CombatWorld
        var rules play.CombatRules
        var hit play.DamageRequest
        var special bit
        var rollOnAction bit
        var respawn bit
        explosion, mover, levelTime := 0, 0, 0
        switch currentTick() {
${cases.map(fixture).join("\n")}
        }
        scene := level(special)
        blocks := wad.LoadBlockMap(scene)
        world.Links = play.BuildActorLinks(world.Actors, blocks)
        var step play.CombatStep
        var moving play.MobjTick
        if mover > 0 {
            moving = play.BeginMobjTick(scene, blocks, world, mover, levelTime, respawn, rules)
            step = moving.Combat
        } else if explosion > 0 {
            step = play.ExplodeMissile(scene, world, explosion, rules)
        } else {
            step = play.DamageMobj(scene, world, hit, rules)
        }
        done := false
        dropped, respawned := 0, 0
        for range 18 {
            if !done && !step.Failed {
                feedback := step.Feedback
                if feedback.Tactile != 0 { log(2, feedback.Tactile) }
                if feedback.LowerWeapon != 0 { log(3, feedback.LowerWeapon - 1) }
                if feedback.CloseAutomap { log(4) }
                if feedback.Sound != 0 { log(9, feedback.Sound, feedback.SoundOrigin) }
                if feedback.DroppedActor != 0 { dropped = feedback.DroppedActor }
                if step.State.Action != 0 {
                    log(1, step.ActorHandle, step.State.Actor.State, step.State.Action)
                    if rollOnAction { step.World.Random = play.PRandom(step.World.Random).State }
                }
                if mover > 0 {
                    if moving.Done {
                        done = true
                        if moving.Respawn { respawned = mover }
                    } else {
                        moving.Combat = step
                        moving = play.ResumeMobjTick(scene, blocks, moving, rules)
                        step = moving.Combat
                    }
                } else if step.State.Action != 0 {
                    step = play.ResumeMobjCombat(scene, step, rules)
                } else {
                    done = true
                }
            }
        }
        if !done { log(-1, step.ActorHandle) }
        for index := range world.Actors.Count {
            actor := step.World.Actors.ActorAt(index)
            body := actor.Physics.Body
            log(5, actor.Health, body.Flags, body.Height, actor.Physics.MomentumX, actor.Physics.MomentumY,
                actor.Physics.MomentumZ, actor.State, actor.Tics, actor.Target, actor.Threshold,
                actor.ReactionTime, actor.Sprite, actor.Frame, body.X, body.Y, body.Z, actor.MoveCount, actor.Valid)
        }
        for slot := range wad.VanillaPlayers {
            player := step.World.Players[slot]
            log(6, player.Health, player.Armor, player.ArmorType, player.DamageCount, player.Attacker, player.KillCount,
                player.Dead, player.Frags[0], player.Frags[1], player.Frags[2], player.Frags[3])
        }
        if dropped > 0 {
            item := step.World.Actors.ActorAt(dropped - 1)
            body := item.Physics.Body
            log(7, item.Kind, body.Flags, body.X, body.Y, body.Z, item.State, item.Tics, item.LastLook)
        }
        links := step.World.Links
        member := links.SectorFirst(0)
        for range step.World.Actors.Count {
            if member != 0 {
                log(10, member)
                member = links.SectorNext(member)
            }
        }
        if member != 0 { log(-1, member) }
        for y := range blocks.Height {
            for x := range blocks.Width {
                member = links.BlockFirst(x, y)
                for range step.World.Actors.Count {
                    if member != 0 {
                        log(11, x, y, member)
                        member = links.BlockNext(member)
                    }
                }
                if member != 0 { log(-1, member) }
            }
        }
        log(8, step.World.Random.GameplayIndex, respawned)
    }
}
`);
    const build = spawnSync("dotnet", [cli, "build", source, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (build.error) throw build.error;
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    return cases.map(({ name }) => {
        const start = sim.logs.length;
        sim.step();
        const rows = Array.from(sim.logs.slice(start), row => Array.from(row, Number));
        assert.ok(rows.every(([tag]) => tag > 0) && rows.at(-1)?.[0] === 8, name + " produced an incomplete trace");
        return rows;
    });
}

const digest = trace => createHash("sha256").update(JSON.stringify(trace)).digest("hex");
try {
    const observed = traceFletcher();
    if (values.upstream) {
        const native = runNativeDamageOracle(path.resolve(root, values.upstream), scratch, cases);
        for (const [index, { name }] of cases.entries()) assert.deepEqual(observed[index], native[index], name);
        console.log(`Matched ${native.length} combat cases with pinned Linux Doom C. SHA-256 ${digest(native)}.`);
    } else {
        assert.equal(digest(observed), "2f1873f2c0ae17b4fffb0dbd8a19e749dd7a5f761365e37593aa970464755971");
        console.log(`Verified ${observed.length} combat cases against the pinned C snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-damage-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
