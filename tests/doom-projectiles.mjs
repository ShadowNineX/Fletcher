import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runNativeProjectileOracle } from "./doom-native-damage-oracle.mjs";
import { projectileFixtures } from "./doom-projectile-fixtures.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-projectiles-"));
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const unit = 65536;
const cases = projectileFixtures.map(fixture => ({
    ...fixture, consolePlayer: 0, automap: false, sectorSpecial: 0,
    rollOnAction: fixture.rollOnAction ?? false,
    actors: fixture.actors.map(actor => ({ ...actor, mx: 0, my: 0, mz: 0, threshold: 0, reaction: 8, target: 0 })),
    players: Array.from({ length: 4 }, (_, slot) => ({
        health: fixture.actors.find(actor => actor.slot === slot)?.health ?? 100,
        armor: 0, armorType: 0, invulnerable: 0, ready: 1, cheats: 0, damageCount: 0,
        attacker: 0, killCount: 0, frags: [0, 0, 0, 0],
    })),
}));

function setupGeometry() {
    const blobs = [];
    let offset = 0;

    function record({ name, count, size, entries }) {
        const data = Buffer.alloc(count * size);
        for (const [wordOffset, word] of entries) data.writeUInt16LE(word & 0xffff, wordOffset);
        const field = `        ${name}: wad.Lump{Offset: ${offset}, Count: ${count}, Valid: true},`;
        offset += data.length;
        blobs.push(data);
        return field;
    }

    const branches = Array.from({ length: 4 }, (_, variant) => {
        const sectors = Buffer.alloc(52);
        sectors.writeInt16LE(128, 2);
        sectors.writeInt16LE(24, 28);
        if (variant === 3) sectors.write("F_SKY1", 38, "ascii");
        const sectorFields = `        Sectors: wad.Lump{Offset: ${offset}, Count: 2, Valid: true},`;
        offset += sectors.length;
        blobs.push(sectors);
        const lumps = [
            { name: "Vertices", count: 2, size: 4, entries: [[0, 8], [2, -64], [4, 8], [6, 64]] },
            { name: "Lines", count: 1, size: 14, entries: [[2, 1], [4, variant >= 2 ? 4 : 0], [12, variant >= 2 ? 1 : -1]] },
            { name: "Sides", count: 2, size: 30, entries: [[58, 1]] },
            { name: "Segs", count: 1, size: 12, entries: [[2, 1]] },
            { name: "Subsectors", count: 1, size: 4, entries: [[0, 1]] },
            { name: "Nodes", count: 0, size: 28, entries: [] },
        ].map(record);
        const words = [-128, -128, 4, 4, ...Array(16).fill(20), variant === 0 ? -1 : 0, -1];
        const blocks = Buffer.alloc(words.length * 2);
        words.forEach((word, index) => blocks.writeUInt16LE(word & 0xffff, index * 2));
        const blockFields = `        BlockMap: wad.Lump{Offset: ${offset}, Count: ${blocks.length}, Valid: true},`;
        offset += blocks.length;
        blobs.push(blocks);
        return `    case ${variant}: return wad.BspLevel{File: Geometry, Valid: true,
${[sectorFields, ...lumps, blockFields].join("\n")}
    }`;
    });
    writeFileSync(path.join(scratch, "MAP.BIN"), Buffer.concat(blobs));
    return `func loadSector(variant int) wad.BspLevel {
    switch variant {
${branches.join("\n")}
    default: return wad.BspLevel{}
    }
}`;
}

function fletcherCase(entry, index) {
    const { actors, players, barrier, kind, source, dest, skill, randomIndex, rollOnAction, fast = false } = entry;
    return `        case ${index}:
            variant, source, dest, kind, skill = ${barrier}, ${source}, ${dest}, ${kind}, ${skill}
            world.Random.GameplayIndex = ${randomIndex}
            rollOnAction = ${rollOnAction}
            fast = ${fast}
${actors.map(actor => `            world.Actors = world.Actors.AppendActor(makeActor(${actor.kind}, ${actor.flags},
                ${actor.health}, ${actor.x}, ${actor.y}, ${actor.z}, ${actor.height}, ${actor.slot}, bits<32>(${actor.angle})))`).join("\n")}
${players.map((player, slot) => `            world.Players[${slot}] = play.PlayerInventory{Health: ${player.health}, ReadyWeapon: 1}`).join("\n")}`;
}

function traceFletcher() {
    const source = path.join(scratch, "main.flt"), output = path.join(scratch, "result.json");
    writeFileSync(source, `package main
import "actorinfo"
import "play"
import "wad"

const Geometry = readFile("MAP.BIN")
${setupGeometry()}

func makeActor(kind int, flags bits<32>, health int, x int, y int, z int, height int, slot int, angle bits<32>) play.LevelActor {
    info := actorinfo.KindAt(kind)
    state := actorinfo.StateAt(info.SpawnState)
    return play.LevelActor{Valid: true, Kind: kind, Health: health, ReactionTime: 8, State: info.SpawnState,
        Tics: state.Tics, Sprite: state.Sprite, Frame: state.Frame, PlayerSlot: slot,
        Physics: play.ActorPhysics{Angle: angle, Body: play.MapActor{X: x, Y: y, Z: z, Height: height, Flags: flags,
            Radius: info.Radius, Ceiling: 128 << 16, Player: slot >= 0}}}
}

map "Doom projectile launch parity" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        var world play.CombatWorld
        var rollOnAction bit
        var fast bit
        variant, source, dest, kind, skill := 0, 0, 0, 0, 0
        switch currentTick() {
${cases.map(fletcherCase).join("\n")}
        }

        scene := loadSector(variant)
        blocks := wad.LoadBlockMap(scene)
        world.Links = play.BuildActorLinks(world.Actors, blocks)
        rules := play.CombatRules{Skill: skill, Fast: fast}
        var launch play.MissileLaunch
        if dest > 0 {
            launch = play.BeginMonsterMissile(scene, world, source, dest, kind, rules)
        } else {
            launch = play.BeginPlayerMissile(scene, blocks, world, source, kind, rules)
        }
        first := launch.Combat.World.Actors.ActorAt(launch.Handle - 1)
        origin := world.Actors.ActorAt(source - 1).Physics.Body
        if launch.Handle != world.Actors.Count + 1 || first.Physics.Body.X != origin.X ||
            first.Physics.Body.Y != origin.Y || first.Physics.Body.Z != origin.Z + (32 << 16) || first.Target != 0 {
            log(-1, launch.Handle)
        }
        log(13, launch.Combat.Feedback.Sound)
        done, drop := false, 0
        for range 12 {
            if !done && !launch.Combat.Failed {
                combat := launch.Combat
                feedback := combat.Feedback
                if feedback.Tactile != 0 { log(2, feedback.Tactile) }
                if feedback.LowerWeapon != 0 { log(3, feedback.LowerWeapon - 1) }
                if feedback.CloseAutomap { log(4) }
                if feedback.Sound != 0 { log(9, feedback.Sound, feedback.SoundOrigin) }
                if feedback.DroppedActor > 0 { drop = feedback.DroppedActor }
                if combat.State.Action != 0 {
                    log(1, combat.ActorHandle, combat.State.Actor.State, combat.State.Action)
                    if rollOnAction { launch.Combat.World.Random = play.PRandom(launch.Combat.World.Random).State }
                }
                done = launch.Done
                if !done { launch = play.ResumeMissileLaunch(scene, blocks, launch, rules) }
            }
        }
        if !done || launch.Combat.Failed { log(-1, launch.Handle) }
        result := launch.Combat.World
        for index := range world.Actors.Count {
            actor := result.Actors.ActorAt(index)
            body := actor.Physics.Body
            log(5, actor.Health, body.Flags, body.Height, actor.Physics.MomentumX, actor.Physics.MomentumY,
                actor.Physics.MomentumZ, actor.State, actor.Tics, actor.Target, actor.Threshold,
                actor.ReactionTime, actor.Sprite, actor.Frame, body.X, body.Y, body.Z, actor.MoveCount, actor.Valid)
        }
        for slot := range wad.VanillaPlayers {
            player := result.Players[slot]
            log(6, player.Health, player.Armor, player.ArmorType, player.DamageCount, player.Attacker, player.KillCount,
                player.Dead, player.Frags[0], player.Frags[1], player.Frags[2], player.Frags[3])
        }
        if drop != 0 {
            item := result.Actors.ActorAt(drop - 1)
            body := item.Physics.Body
            log(7, item.Kind, body.Flags, body.X, body.Y, body.Z, item.State, item.Tics, item.LastLook)
        }
        missile := result.Actors.ActorAt(launch.Handle - 1)
        body := missile.Physics.Body
        log(12, missile.Kind, body.Flags, missile.Physics.Angle, body.X, body.Y, body.Z,
            missile.Physics.MomentumX, missile.Physics.MomentumY, missile.Physics.MomentumZ, body.Floor, body.Ceiling,
            missile.State, missile.Tics, missile.LastLook, missile.Target, launch.Aim.Target)
        member := result.Links.SectorFirst(0)
        for range result.Actors.Count {
            if member != 0 { log(10, member); member = result.Links.SectorNext(member) }
        }
        for y := range blocks.Height {
            for x := range blocks.Width {
                member = result.Links.BlockFirst(x, y)
                for range result.Actors.Count {
                    if member != 0 { log(11, x, y, member); member = result.Links.BlockNext(member) }
                }
            }
        }
        log(8, result.Random.GameplayIndex, 0)
        if kind == actorinfo.ActorPlasma && dest == 0 {
            info := actorinfo.WeaponAt(play.WeaponPlasma)
            player := world.Actors.ActorAt(source - 1)
            world.Players[player.PlayerSlot].ReadyWeapon = play.WeaponPlasma
            world.Players[player.PlayerSlot].PendingWeapon = play.WeaponNoChange
            world.Players[player.PlayerSlot].Ammo[play.AmmoCell] = 4
            view := play.WeaponView{Weapon: play.WeaponOverlay{State: info.Ready, Tics: 1}}
            weapon := play.BeginPlayerWeaponTick(scene, blocks, world, source, view, play.WeaponInput{Attack: true}, rules)
            plasmaSound := actorinfo.KindAt(kind).SeeSound
            events := 0
            for range 12 {
                if !weapon.Done && !weapon.Combat.Failed {
                    if weapon.Combat.Feedback.Sound == plasmaSound { events = 10 * events + 1 }
                    if weapon.Noise { events = 10 * events + 2 }
                    weapon = play.ResumePlayerWeaponTick(scene, blocks, weapon, rules)
                }
            }
            armed := weapon.Combat.World
            launched := armed.Actors.ActorAt(launch.Handle - 1)
            if !weapon.Done || weapon.Combat.Failed || events != 12 || armed.Random.GameplayIndex != 3 ||
                armed.Players[player.PlayerSlot].Ammo[play.AmmoCell] != 3 || weapon.View.Flash.Tics != 3 ||
                launched.Kind != actorinfo.ActorPlasma || launched.Target != source || !launched.Valid ||
                launched.Physics.Body.X != body.X || launched.Physics.Body.Y != body.Y || launched.Physics.Body.Z != body.Z {
                log(-1, events)
            }
        }
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
    return cases.map(fixture => {
        const start = sim.logs.length;
        for (let tick = 0; sim.logs.length === start && tick < 64; tick++) sim.step();
        const rows = Array.from(sim.logs.slice(start), row => Array.from(row, Number));
        assert.ok(rows.every(([tag]) => tag > 0) && rows.at(-1)?.[0] === 8, fixture.name + " completed launch");
        const projectile = rows.find(([tag]) => tag === 12);
        assert.equal(projectile?.[15], fixture.source, fixture.name + " owner");
        if (fixture.expectedAim !== undefined) assert.equal(projectile[16], fixture.expectedAim, fixture.name);
        if (fixture.expectedHeading !== undefined) assert.equal(projectile[3], fixture.expectedHeading, fixture.name);
        if (fixture.expectedSound !== undefined) assert.equal(rows[0][1], fixture.expectedSound, fixture.name);
        if (fixture.expectedImpact !== undefined) assert.equal((projectile[2] & 0x10000) === 0, fixture.expectedImpact, fixture.name);
        if (fixture.expectedCeiling !== undefined) assert.equal(projectile[11], fixture.expectedCeiling, fixture.name);
        return rows.filter(([tag]) => tag !== 13);
    });
}

const digest = trace => createHash("sha256").update(JSON.stringify(trace)).digest("hex");
try {
    const observed = traceFletcher();
    if (values.upstream) {
        const native = runNativeProjectileOracle(path.resolve(root, values.upstream), scratch, cases);
        cases.forEach(({ name }, index) => assert.deepEqual(observed[index], native[index], name));
        console.log(`Matched ${native.length} projectile launches with pinned Linux Doom C. SHA-256 ${digest(native)}.`);
    } else {
        assert.equal(digest(observed), "381584528c34176ad81077e58e665ddc95336b1087c3c4c5cdfb7de229199ed5");
        console.log(`Verified ${observed.length} projectile launches against the pinned C snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-projectiles-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
