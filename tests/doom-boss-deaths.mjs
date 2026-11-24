import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runNativeBossDeathOracle } from "./doom-native-boss-death-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-boss-deaths-"));
const unit = 65536;
const fatso = 8, baby = 20, baron = 15, cyber = 21, spider = 19, keen = 24, brain = 25;

const live = kind => ({ kind, health: 10 });
const boss = (name, episode, map, actorKind, options) => ({ name, action: "boss", commercial: episode === 0, episode, map, actorKind, ...options });
const cases = [
    boss("MAP07 lowers the mancubus sector", 0, 7, fatso),
    boss("MAP07 raises the arachnotron sector by its lower texture height", 0, 7, baby),
    boss("MAP17 is not MAP07", 0, 17, fatso),
    boss("MAP30 does not lower tag 666 on a mancubus death", 0, 30, fatso),
    boss("untagged breed on MAP07", 0, 7, spider),
    boss("MAP07 waits for surviving same-kind actors", 0, 7, fatso, { others: [live(baby), live(fatso)] }),
    boss("MAP07 ignores a living actor of the other boss kind", 0, 7, baby, { others: [live(fatso)] }),
    boss("a removed thinker cannot defer the special", 0, 7, fatso, { others: [{ ...live(fatso), active: false }] }),
    boss("a dead same-kind actor cannot defer the special", 0, 7, fatso, { others: [{ kind: fatso, health: 0 }] }),
    boss("no living player defers boss victory", 0, 7, fatso, { players: [0, null, -4] }),
    boss("victory accepts a live player in the last slot", 0, 7, fatso, { players: [0, null, -4, 1] }),
    boss("E1M8 lowers the baron sector", 1, 8, baron),
    boss("E1M8 ignores a cyberdemon", 1, 8, cyber),
    boss("E1M7 does not trigger on death", 1, 7, baron),
    boss("E2M8 cyberdemon exits", 2, 8, cyber),
    boss("E3M8 spider exits", 3, 8, spider),
    boss("E3M8 waits for a player to survive", 3, 8, spider, { players: [null] }),
    boss("E4M6 cyberdemon opens the blazing door", 4, 6, cyber),
    boss("E4M8 spider lowers the floor", 4, 8, spider),
    boss("E4M8 ignores the E4M6 boss kind", 4, 8, cyber),
    boss("unknown episode retains the pinned map-eight exit fallback", 5, 8, fatso),
    { name: "Keen falls even with a living peer", action: "keen", commercial: true, episode: 0, map: 32, actorKind: keen, others: [live(keen)] },
    { name: "last Keen opens tag 666 even with no living players", action: "keen", commercial: true, episode: 0, map: 32, actorKind: keen, players: [] },
    { name: "Keen callback has no map gate", action: "keen", commercial: false, episode: 1, map: 1, actorKind: keen },
    { name: "brain death requests exit even with no living players", action: "brain", commercial: true, episode: 0, map: 30, actorKind: brain, players: [] },
];

function words(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => bytes.writeUInt16LE(value & 65535, index * 2));
    return bytes;
}

function makeWad() {
    const pnames = Buffer.alloc(4);
    const texture = Buffer.alloc(56);
    texture.writeInt32LE(2);
    texture.writeInt32LE(12, 4);
    texture.writeInt32LE(34, 8);
    for (const [offset, name] of [[12, "DUMMY"], [34, "LOWER"]]) {
        texture.write(name, offset);
        texture.writeInt16LE(16, offset + 12);
        texture.writeInt16LE(16, offset + 14);
    }
    const sectors = Buffer.alloc(52);
    sectors.writeInt16LE(32);
    sectors.writeInt16LE(64, 2);
    sectors.writeInt16LE(666, 24);
    sectors.writeInt16LE(192, 28);
    sectors.writeInt16LE(667, 50);
    const sides = Buffer.alloc(60);
    sides.write("LOWER", 12);
    sides.write("LOWER", 42);
    sides.writeUInt16LE(1, 58);
    const lumps = [["PNAMES", pnames], ["TEXTURE1", texture], ["SECTORS", sectors], ["LINEDEFS", words([0, 1, 4, 0, 0, 0, 1])],
        ["SIDEDEFS", sides], ["VERTEXES", words([0, -64, 0, 64])]];
    const directory = 12 + lumps.reduce((length, [, bytes]) => length + bytes.length, 0);
    const data = Buffer.alloc(directory + lumps.length * 16), offsets = {};
    data.write("PWAD");
    data.writeInt32LE(lumps.length, 4);
    data.writeInt32LE(directory, 8);
    let offset = 12;
    for (const [index, [name, bytes]] of lumps.entries()) {
        const entry = directory + index * 16;
        offsets[name] = offset;
        data.writeInt32LE(offset, entry);
        data.writeInt32LE(bytes.length, entry + 4);
        data.write(name, entry + 8);
        bytes.copy(data, offset);
        offset += bytes.length;
    }
    return { data, offsets };
}

function build() {
    const entry = path.join(scratch, "main.flt"), output = path.join(scratch, "out.json");
    const { data, offsets } = makeWad();
    writeFileSync(path.join(scratch, "MAP.WAD"), data);
    const actions = { boss: "ActionBossDeath", keen: "ActionKeenDie", brain: "ActionBrainDie" };
    const arms = cases.map((fixture, index) => {
        const name = Buffer.alloc(8);
        name.write(fixture.commercial ? `MAP${String(fixture.map).padStart(2, "0")}` : `E${fixture.episode}M${fixture.map}`);
        const peers = (fixture.others ?? []).map(peer => `world.Actors = world.Actors.AppendActor(seed(${peer.kind}, ${peer.health}, ${peer.active !== false}))`);
        const players = [];
        for (const [slot, health] of (fixture.players ?? [100]).entries()) {
            if (health == null) continue;
            players.push(`world.Actors = world.Actors.AppendActor(seed(0, ${health}, true))`,
                `world.Actors.PlayerActors[${slot}] = world.Actors.Count`, `world.Players[${slot}].Health = ${health}`);
        }
        const lines = [`level.MapName = wad.LumpName{Low: ${name.readInt32LE(0)}, High: ${name.readInt32LE(4)}}`,
            `action = actorinfo.${actions[fixture.action]}`, `world.Actors = world.Actors.AppendActor(seed(${fixture.actorKind}, 0, true))`,
            ...peers, ...players];
        return `        case ${index}:\n            ${lines.join("\n            ")}`;
    });
    writeFileSync(entry, `package main
import "actorinfo"
import "play"
import "wad"

const data = readFile("MAP.WAD")

func seed(kind int, health int, valid bit) play.LevelActor {
    return play.LevelActor{Valid: valid, Kind: kind, Health: health,
        Physics: play.ActorPhysics{Body: play.MapActor{Flags: play.ActorSolid}}}
}

map "Doom boss deaths" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        level := wad.BspLevel{File: data, Valid: true,
            Sectors: wad.Lump{Offset: ${offsets.SECTORS}, Count: 2, Valid: true},
            Lines: wad.Lump{Offset: ${offsets.LINEDEFS}, Count: 1, Valid: true},
            Sides: wad.Lump{Offset: ${offsets.SIDEDEFS}, Count: 2, Valid: true},
            Vertices: wad.Lump{Offset: ${offsets.VERTEXES}, Count: 2, Valid: true}}
        var world play.CombatWorld
        action := 0
        switch currentTick() {
${arms.join("\n")}
        }
        result := play.ApplyBossSpecial(level, play.LevelSpecials{}, world, 1, action)
        kind, tag, destination, speed := 0, 0, 0, 0
        if result.State.Floors.Count > 0 {
            floor := result.State.Floors.EntryAt(result.State.Floors.First())
            tag, destination, speed = level.SectorTag(floor.Sector), floor.Motion.Destination, floor.Motion.Speed
            if floor.Motion.Mode == play.FloorLowerLowest { kind = 1 }
            if floor.Motion.Mode == play.FloorRaiseTexture { kind = 2 }
        } else if result.State.Doors.Count > 0 {
            door := result.State.Doors.EntryAt(result.State.Doors.First())
            tag, destination, speed = level.SectorTag(door.Sector), door.State.Top, door.State.Speed
            if door.State.Mode == play.DoorOpen { kind = 3 }
            if door.State.Mode == play.DoorBlazeOpen { kind = 4 }
        } else if result.State.ExitRequested { kind = 5 }
        log(currentTick(), kind, tag, result.World.Actors.ActorAt(0).Physics.Body.Flags & play.ActorSolid != 0,
            destination, speed, result.State.Doors.UsedCount)
    }
}
`);
    const built = spawnSync("dotnet", [cli, "build", entry, "--package-root", path.join(root, "examples", "doom-engine"),
        "--asset-root", scratch, "-o", output], { encoding: "utf8", cwd: root, timeout: 30_000 });
    if (built.error) throw built.error;
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const payload = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(payload, "base64")[2], 1);
    return simulator(decode(payload), true);
}

try {
    const sim = build();
    for (let host = 0; host < 192 && sim.logs.length < cases.length; host++) sim.step();
    assert.equal(sim.logs.length, cases.length);
    const mover = [[0, 0], [0, unit], [16 * unit, unit], [188 * unit, 2 * unit], [188 * unit, 8 * unit], [0, 0]];
    const observed = Array.from(sim.logs, (raw, index) => {
        const [tic, kind, tag, solid, target, speed, used] = Array.from(raw, Number);
        assert.equal(tic, index);
        assert.deepEqual([target, speed], mover[kind], cases[index].name + " mover target and speed");
        assert.equal(used, 0, cases[index].name + " did not consume a map line");
        return [kind, tag, solid];
    });
    const digest = createHash("sha256").update(JSON.stringify(observed)).digest("hex");
    if (values.upstream) {
        const native = runNativeBossDeathOracle(path.resolve(root, values.upstream), scratch, cases);
        cases.forEach((fixture, index) => assert.deepEqual(observed[index], native[index], fixture.name));
        console.log(`Matched ${cases.length} boss, Keen, and brain death cases with pinned Doom C. SHA-256 ${digest}.`);
    } else {
        assert.equal(digest, "fb5ecbd3e32cc508950b0aee01b2063dbaa514c6cbc605d9da88c315d580a28c");
        console.log(`Verified ${cases.length} boss death cases against the pinned snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-boss-deaths-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
