import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values, positionals } = parseArgs({
    options: { upstream: { type: "string" }, cli: { type: "string" } },
    allowPositionals: true,
});
const cli = path.resolve(root, values.cli ?? positionals[0] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-actor-spawn-"));
const metadataRows = 137 + 967 + 138;

const medium = { skill: 2, commercial: false, noMonsters: false, health: [93, 0, 0, 0] };
const cases = [
    { ...medium, name: "duplicate player-one bodies, inactive starts, skill and solo filters",
        things: [
            [-8, 12, 90, 1, 0], [-22, 34, 17, 2, 0], [2, 6, 80, 3, 7], [40, -6, -45, 4, 0],
            [18, 7, 0, 11, 0], [-10, 23, 126, 3004, 10],
            [64, 15, 0, 999, 1], [65, 15, 0, 999, 18],
            [13, 23, 0, 2014, 7], [28, 25, 45, 49, 7], [0, 6, 0, 2035, 7],
            [9, 12, 315, 1, 16],
        ] },
    { ...medium, name: "nightmare without monsters", skill: 4, noMonsters: true, things: [
        [1, -2, 0, 3004, 7], [2, -2, 0, 3006, 7], [-4, 6, -91, 2014, 4],
        [7, -7, 0, 49, 4], [-5, 6, 0, 2014, 2], [0, 0, 0, 1, 0],
    ] },
    { ...medium, name: "commercial campaign spawns its key and monster past alternate starts", commercial: true,
        things: [
            [-4, 10, 0, 1, 0], [12, 10, 0, 2, 0], [-6, 0, 0, 5, 7],
            ...Array.from({ length: 12 }, (_, index) => [index + 1, 0, index * 45, 11, 0]),
            [30, 2, 180, 3004, 18], [91, 2, 270, 68, 7],
        ] },
    { ...medium, name: "non-commercial load break", things: [
        [-10, 8, 45, 1, 0], [-12, 6, 0, 2035, 7], [18, 4, 0, 68, 7], [22, 5, 0, 999, 7],
    ] },
    { ...medium, name: "first unknown actor rejects the remaining records", things: [
        [-10, 8, 45, 1, 0], [18, 4, 0, 999, 7], [-12, 6, 0, 2035, 7],
    ] },
    { ...medium, name: "baby skill and lost soul kill count", skill: 0, things: [
        [-16, 16, 0, 3006, 1], [17, 16, 180, 3004, 1], [18, 5, 0, 2035, 2],
    ] },
    { ...medium, name: "nightmare clears monster reaction delay", skill: 4, things: [
        [1, 3, 269, 3004, 4], [-1, 3, -135, 3004, 1], [-3, 9, -135, 3006, 4],
    ] },
];

const bspLumps = [];
function makeLump(name, count, size, fill) {
    const offset = bspLumps.reduce((total, lump) => total + lump.data.length, 0);
    const data = Buffer.alloc(count * size);
    for (let index = 0; index < count; index++) fill(data, index, index * size);
    bspLumps.push({ name, offset, count, data });
}

makeLump("Sectors", 2, 26, (data, index, at) => {
    data.writeInt16LE(index === 0 ? 8 : -16, at);
    data.writeInt16LE(index === 0 ? 128 : 192, at + 2);
});
makeLump("Subsectors", 2, 4, (data, index, at) => {
    data.writeUInt16LE(1, at);
    data.writeUInt16LE(index, at + 2);
});
makeLump("Segs", 2, 12, (data, index, at) => data.writeUInt16LE(index, at + 6));
makeLump("Lines", 2, 14, (data, index, at) => {
    data.writeUInt16LE(index, at + 10);
    data.writeUInt16LE(0xffff, at + 12);
});
makeLump("Sides", 2, 30, (data, index, at) => data.writeUInt16LE(index, at + 28));
makeLump("Nodes", 1, 28, (data) => {
    data.writeInt16LE(1, 6); // Vertical partition at x = 0. Its back side is x <= 0.
    data.writeUInt16LE(0x8001, 24);
    data.writeUInt16LE(0x8000, 26);
});

function makeThings() {
    const all = cases.flatMap(({ things }) => things);
    const bytes = Buffer.alloc(all.length * 10);
    for (let index = 0; index < all.length; index++) {
        all[index].forEach((value, field) => bytes.writeInt16LE(value, index * 10 + field * 2));
    }
    return bytes;
}

function createFixture() {
    let offset = bspLumps.reduce((total, lump) => total + lump.data.length, 0);
    const branches = cases.map((entry, index) => {
        const trace = `case ${index}: {
            things = wad.Lump{Offset: ${offset}, Count: ${entry.things.length}, Valid: true}
            health = [4]int{${entry.health.join(", ")}}
            rules = wad.ThingRules{Skill: ${entry.skill}, Commercial: ${entry.commercial}, NoMonsters: ${entry.noMonsters}}
        }`;
        offset += entry.things.length * 10;
        return trace;
    });
    const lumps = bspLumps.map(({ name, offset, count }) => `${name}: wad.Lump{Offset: ${offset}, Count: ${count}, Valid: true},`);
    const source = `package main
import "actorinfo"
import "play"
import "wad"
const MapData = readFile("MAP.BIN")
map "Doom actor spawn" {
    tick {
        row := currentTick() - ${cases.length}
        if row < 0 {
            var things wad.Lump
            var health [4]int
            var rules wad.ThingRules
            switch currentTick() {
                ${branches.join("\n                ")}
            }
            level := wad.BspLevel{File: MapData, Valid: true, Things: things,
                ${lumps.join("\n                ")}
            }
            spawned := play.SpawnMapActors(level, rules, health, play.ClearRandom())
            log(spawned.Count, spawned.TotalKills, spawned.TotalItems, spawned.Random.GameplayIndex,
                spawned.Failed, spawned.RejectedThing,
                spawned.PlayerActors[0], spawned.PlayerActors[1], spawned.PlayerActors[2], spawned.PlayerActors[3])
            for index := range spawned.Count {
                actor := spawned.ActorAt(index)
                body := actor.Physics.Body
                thing := actor.SpawnPoint
                log(actor.Kind, body.X, body.Y, body.Z, body.Floor, body.Ceiling, actor.Sector, body.Radius, body.Height,
                    body.Flags, actor.Health, actor.ReactionTime, actor.LastLook, actor.State, actor.Tics,
                    actor.Sprite, actor.Frame, actor.Physics.Angle, actor.PlayerSlot,
                    thing.X, thing.Y, thing.Angle, thing.Type, thing.Options)
            }
        } else if row < actorinfo.ActorKindCount {
            actor := actorinfo.KindAt(row)
            log(row, actor.DoomedNum, actorinfo.KindForThing(actor.DoomedNum), actor.SpawnState, actor.SpawnHealth,
                actor.SeeState, actor.SeeSound, actor.ReactionTime, actor.AttackSound, actor.PainState, actor.PainChance,
                actor.PainSound, actor.MeleeState, actor.MissileState, actor.DeathState, actor.XDeathState, actor.DeathSound,
                actor.Speed, actor.Radius, actor.Height, actor.Mass, actor.Damage, actor.ActiveSound, actor.RaiseState, actor.Flags)
        } else if row < actorinfo.ActorKindCount + actorinfo.ActorStateCount {
            id := row - actorinfo.ActorKindCount
            state := actorinfo.StateAt(id)
            log(id, state.Sprite, state.Frame, state.Tics, state.Action, state.Next, state.Misc1, state.Misc2)
        } else {
            id := row - actorinfo.ActorKindCount - actorinfo.ActorStateCount
            log(id, actorinfo.SpriteNameLow(id))
        }
    }
}
`;
    const fixture = path.join(scratch, "main.flt");
    writeFileSync(fixture, source);
    writeFileSync(path.join(scratch, "MAP.BIN"), Buffer.concat([...bspLumps.map(lump => lump.data), makeThings()]));
    return fixture;
}

function traceFletcher() {
    const output = path.join(scratch, "output.json");
    const result = spawnSync("dotnet", [cli, "build", createFixture(), "--package-root", port,
        "--asset-root", scratch, "-o", output], {
        encoding: "utf8", cwd: root, timeout: 25_000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    const spawns = cases.map(({ name }) => {
        const first = sim.logs.length;
        sim.step();
        const rows = Array.from(sim.logs.slice(first), row => Array.from(row, Number));
        assert.equal(rows[0]?.length, 10, name);
        assert.equal(rows.length, rows[0][0] + 1, name);
        for (const actor of rows.slice(1)) assert.equal(actor.length, 24, name);
        return rows;
    });
    const firstMetadata = sim.logs.length;
    for (let row = 0; row < metadataRows; row++) sim.step();
    const metadata = Array.from(sim.logs.slice(firstMetadata), row => Array.from(row, Number));
    assert.equal(metadata.length, metadataRows);
    return { spawns, metadata };
}

const digest = trace => createHash("sha256").update(JSON.stringify(trace)).digest("hex");

try {
    const observed = traceFletcher();
    if (values.upstream) {
        const { runNativeActorOracle } = await import("./doom-native-actor-oracle.mjs");
        const upstream = runNativeActorOracle(path.resolve(root, values.upstream), scratch, cases);
        for (const [index, { name }] of cases.entries()) assert.deepEqual(observed.spawns[index], upstream.spawns[index], name);
        assert.equal(upstream.metadata.length, metadataRows);
        for (const [index, row] of observed.metadata.entries()) assert.deepEqual(row, upstream.metadata[index], `metadata row ${index}`);
        console.log(`Compared ${cases.length} startup traces and ${metadataRows} metadata rows with pinned Linux Doom C.`);
        console.log(`Spawn SHA-256 ${digest(upstream.spawns)}. Metadata SHA-256 ${digest(upstream.metadata)}.`);
    } else {
        assert.equal(digest(observed.spawns), "e1b4250ab0800aeb481213ffe75c9d87dd0f6f4cce613769ed331117743f846a");
        assert.equal(digest(observed.metadata), "87b88406804d12d26b7d79a97a6ace70b83d4aa1b6e9da2fe92059ab73965c5e");
        console.log(`Verified ${cases.length} startup traces and ${metadataRows} metadata rows against the pinned C snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-actor-spawn-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
