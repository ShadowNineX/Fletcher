import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runNativeMonsterOracle, runNativeChaseOracle } from "./doom-native-monster-oracle.mjs";
import { runNativeChaseDirections } from "./doom-native-chase-direction-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-monsters-"));
const unit = 65536;
const shootable = 4, ambush = 32, justHit = 64, justAttacked = 128;
const east = 0, north = 2, noDir = 8;
// Pinned actor metadata used to seed the native action harness.
const roster = new Map([
    [1, [174, 176, 36, 0, 184, 1, 75, 8]],
    [11, [442, 444, 39, 452, 452, 0, 76, 8]],
    [12, [475, 477, 41, 485, 0, 52, 77, 10]],
    [18, [585, 587, 0, 0, 589, 51, 77, 8]],
    [19, [601, 603, 45, 0, 615, 2, 77, 12]],
    [21, [674, 676, 44, 0, 684, 0, 77, 16]],
]);

const player = (x = 180, y = 0, extra = {}) => ({
    present: true, x: x * unit, y: y * unit, health: 100, radius: 16 * unit, ...extra,
});
function monsterCase(name, { kind = 1, monster = {}, players = [player()], ...other } = {}) {
    const [state, seestate, seesound, meleeState, missileState, attackSound, activeSound, speed] = roster.get(kind);
    return { name, rng: 0, players, monster: { kind, type: kind, x: 0, y: 0, angle: 0, flags: shootable, threshold: 7,
        lastlook: 0, state, spawnstate: state, seestate, seesound, meleeState, missileState, attackSound, activeSound, speed,
        reaction: 0, moveDirection: noDir, moveCount: 0, target: 1, ...monster }, ...other };
}

const looks = [
    monsterCase("human sees the player and rolls a sight sound"),
    monsterCase("far rear player stays outside the search", { players: [player(-96)] }),
    monsterCase("near rear player is seen at the inclusive range", { players: [player(-64)] }),
    monsterCase("a rear edge just outside range stays unseen", { players: [player(-64 - 1 / unit)] }),
    monsterCase("starting slot is absent and next occupied slot is seen", { players: [null, null, player()] }),
    monsterCase("scan spends inspection counts on dead and obstructed players", {
        players: [player(160, 0, { health: 0 }), player(160, 0, { sight: false }), player()],
    }),
    monsterCase("scan stops when it reaches the occupied stop mark", {
        monster: { lastlook: 2 }, players: [null, player(), player(100, 0, { sight: false }), null],
    }),
    monsterCase("sound target wakes a guard behind a sight-blocking sector", {
        kind: 11, soundTarget: 1, rng: 255, players: [player(-128, 0, { sight: false })],
    }),
    monsterCase("ambush needs sight even when the sector heard a player", {
        kind: 11, soundTarget: 1, monster: { flags: shootable | ambush }, players: [player(150, 0, { sight: false })],
    }),
    monsterCase("ambush sees its sound target outside the forward cone", {
        kind: 11, soundTarget: 1, monster: { flags: shootable | ambush }, players: [player(-128)],
    }),
    monsterCase("spider wakes with a global sound origin", { kind: 19, soundTarget: 1 }),
    monsterCase("cyberdemon wakes with a global sound origin", { kind: 21, soundTarget: 1 }),
    monsterCase("lost soul enters chase silently", { kind: 18, soundTarget: 1 }),
].map(entry => ({ ...entry, monster: { ...entry.monster, target: 0 } }));

const chases = [
    monsterCase("missing target acquires a player behind actor", { monster: { target: 0 }, players: [player(-150)] }),
    monsterCase("unseen dead target returns to spawn", { monster: { target: 0 }, players: [player(120, 0, { health: 0 })] }),
    monsterCase("ordinary chase steps and can emit an active sound", { monster: { moveCount: 2, moveDirection: east }, rng: 255 }),
    monsterCase("a blocked walk requests a new direction", { monster: { moveCount: 2, moveDirection: north }, moveAllowed: false }),
    monsterCase("expired move count skips the first walk", { monster: { reaction: 6, moveCount: 0, moveDirection: north } }),
    monsterCase("melee comes before missile decisions", { kind: 12, monster: { moveCount: 2, reaction: 7 }, players: [player(35)] }),
    monsterCase("reaction reaches zero before the missile chance is tested", { monster: { reaction: 1 }, players: [player(120)] }),
    monsterCase("nightmare permits a missile decision on a positive move count", { skill: 4, monster: { moveCount: 3 } }),
    monsterCase("fast mode permits a missile decision on a positive move count", { fast: true, monster: { moveCount: 3 } }),
    monsterCase("a recent successful attack requests a new course", { monster: { flags: shootable | justAttacked } }),
    monsterCase("nightmare recent attack only clears the flag", { skill: 4, monster: { flags: shootable | justAttacked } }),
    monsterCase("fast recent attack only clears the flag", { fast: true, monster: { flags: shootable | justAttacked } }),
    monsterCase("retaliation consumes just-hit without a distance roll", { monster: { flags: shootable | justHit, reaction: 9 } }),
    monsterCase("lost sight and expired threshold keep the campaign chase target", {
        monster: { lastlook: 3, threshold: 1, moveCount: 2 }, players: [player(120, 0, { sight: false })],
    }),
    monsterCase("dead target clears threshold while turning across north", {
        monster: { angle: 0xffffeeee, moveCount: 3, moveDirection: east }, players: [player(160, 0, { health: 0 })],
    }),
    monsterCase("turn takes shortest signed wrap toward southeast", { monster: { moveCount: 2, angle: 123, moveDirection: 7 } }),
].map(entry => ({ ...entry, monster: { ...entry.monster, state: entry.monster.seestate } }));

function direction(dx, dy, oldDirection, rng, allowed, moveCount = 7) {
    return { dx: dx * unit, dy: dy * unit, oldDirection, rng, allowed, moveCount };
}
const directions = [
    direction(21, 21, noDir, 0, 255), direction(-27, 36, 7, 255, 255),
    direction(-29, -26, east, 0, 255), direction(29, -26, north, 0, 255),
    direction(0, 33, east, 0, 1 << north), direction(0, 33, east, 3, 1 << north),
    direction(21, 0, north, 4, 1 << north), direction(19, 37, north, 1, 1 << east),
    direction(29, 37, north, 2, 1 << 6), direction(30, 0, noDir, 0, 0),
    direction(10, -10, noDir, 1, 0), direction(0, 0, north, 250, 0),
    direction(0, 0, 6, 254, 1 << 2), direction(-21, 0, east, 255, 1 << 4),
    direction(0, 10 + 1 / unit, noDir, 0, 1 << north),
];

function geometry() {
    const vertices = Buffer.alloc(8);
    vertices.writeInt16LE(1800);
    vertices.writeInt16LE(1700, 2);
    vertices.writeInt16LE(1800, 4);
    vertices.writeInt16LE(1800, 6);
    const line = Buffer.alloc(14);
    line.writeUInt16LE(1, 2);
    line.writeUInt16LE(65535, 12);
    const segments = Buffer.alloc(12);
    segments.writeUInt16LE(1, 2);
    const leaves = Buffer.alloc(4);
    leaves.writeUInt16LE(1);
    const sectors = Buffer.alloc(5 * 26);
    for (let i = 0; i < 5; i++) sectors.writeInt16LE(128, i * 26 + 2);
    const parts = [["Vertices", vertices, 2], ["Lines", line, 1], ["Sides", Buffer.alloc(30), 1],
        ["Segs", segments, 1], ["Subsectors", leaves, 1], ["Sectors", sectors, 5], ["Nodes", Buffer.alloc(0), 0]];
    let offset = 0;
    const fields = parts.map(([name, bytes, count]) => {
        const field = `        ${name}: wad.Lump{Offset: ${offset}, Count: ${count}, Valid: true},`;
        offset += bytes.length;
        return field;
    });
    const rejects = [...looks, ...chases].map(({ players }) => {
        const bits = players.reduce((mask, target, i) => target?.sight === false ? mask | 1 << (i + 1) : mask, 0);
        return Buffer.from([bits, 0, 0, 0]);
    });
    writeFileSync(path.join(scratch, "GEOMETRY.BIN"), Buffer.concat([...parts.map(([, bytes]) => bytes), ...rejects]));
    return `func sceneAt(index int) wad.BspLevel {
    return wad.BspLevel{File: Geometry, Valid: true,
${fields.join("\n")}
        Reject: wad.Lump{Offset: ${offset} + index * 4, Count: 4, Valid: true}}
}`;
}

function sourceForCase(entry, index) {
    const { monster: m, players } = entry;
    const setup = Array.from({ length: 4 }, (_, i) => {
        const p = players[i];
        const present = !!p?.present;
        const health = p?.health ?? 0;
        return `            world.Actors = world.Actors.AppendActor(play.LevelActor{Valid: ${present}, Kind: 0, Sector: ${i + 1},
                Health: ${health}, PlayerSlot: ${i}, Physics: play.ActorPhysics{Body: play.MapActor{Player: true, Flags: 4,
                X: ${p?.x ?? 0}, Y: ${p?.y ?? 0}, Height: 56 << 16}}})
            world.Actors.PlayerActors[${i}] = ${present && p.inGame !== false ? i + 1 : 0}
            world.Players[${i}].Health = ${health}`;
    });
    return `        case ${index}:
${setup.join("\n")}
            actor = play.LevelActor{Valid: true, Kind: ${m.kind}, Health: 100, State: ${m.state}, LastLook: ${m.lastlook},
                Threshold: ${m.threshold}, Target: ${m.target}, ReactionTime: ${m.reaction}, MoveCount: ${m.moveCount}, MoveDirection: ${m.moveDirection},
                PlayerSlot: -1, Physics: play.ActorPhysics{Angle: bits<32>(${m.angle}), Body: play.MapActor{Flags: ${m.flags},
                X: ${m.x}, Y: ${m.y}, Height: 56 << 16}}}
            world.Random.GameplayIndex = ${entry.rng}
            soundTarget, skill = ${entry.soundTarget ?? 0}, ${entry.skill ?? 2}
            fast, moveAllowed = ${!!entry.fast}, ${entry.moveAllowed !== false}`;
}

function traceFletcher() {
    const main = path.join(scratch, "main.flt"), map = path.join(scratch, "result.json");
    const monsterCases = [...looks, ...chases];
    const directionSource = directions.map((entry, i) => `        case ${monsterCases.length + i}:
            direction = enemy.BeginChaseDirection(enemy.ChaseDirectionRequest{OldDirection: ${entry.oldDirection},
                TargetX: ${entry.dx}, TargetY: ${entry.dy}, Random: play.RandomState{GameplayIndex: ${entry.rng}}})
            allowed, oldCount = ${entry.allowed}, ${entry.moveCount}`).join("\n");
    writeFileSync(main, `package main
import "enemy"
import "play"
import "wad"

const Geometry = readFile("GEOMETRY.BIN")
${geometry()}

map "Doom monster behavior parity" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        var world play.CombatWorld
        var actor play.LevelActor
        var direction enemy.ChaseDirectionTrace
        fast, moveAllowed := false, false
        soundTarget, skill, allowed, oldCount := 0, 0, 0, 0
        index := currentTick()
        switch index {
${monsterCases.map(sourceForCase).join("\n")}
${directionSource}
        }
        if index < ${monsterCases.length} {
            level := sceneAt(index)
            if index < ${looks.length} {
                looked := enemy.Look(level, world, actor, 5, soundTarget)
                state := looked.State
                if state == enemy.KeepMonsterState { state = actor.State }
                log(looked.Actor.Target, looked.Actor.LastLook, looked.Actor.Threshold, state,
                    looked.Random.GameplayIndex, looked.Sound, looked.SoundOrigin == 5)
            } else {
                chased := enemy.Chase(level, world, actor, skill, fast)
                course := chased.Course
                if course != 0 {
                    if course == enemy.ChaseMove && !moveAllowed { course = enemy.ChaseNewDirection }
                    world.Actors = world.Actors.AppendActor(chased.Actor)
                    world.Random = chased.Random
                    chased = enemy.FinishChaseMovement(chased, world, 5)
                }
                state, flags := chased.State, chased.Actor.Physics.Body.Flags
                if state == enemy.KeepMonsterState { state = actor.State }
                if chased.Missile { flags = flags | play.ActorJustAttacked }
                log(chased.Actor.Target, chased.Actor.LastLook, chased.Actor.Threshold, state, chased.Random.GameplayIndex,
                    chased.Sound, chased.Actor.ReactionTime, chased.Actor.Physics.Angle, flags, chased.Actor.MoveCount, course)
            }
        } else {
            attempts := 0
            for range 16 {
                if direction.Valid && !direction.Done {
                    candidate := direction.Direction
                    if candidate >= enemy.ChaseNoDir { log(-1) }
                    log(40, candidate)
                    direction = enemy.ResumeChaseDirection(direction, (allowed >> candidate) & 1 != 0)
                    attempts = attempts + 1
                }
            }
            if !direction.Valid || !direction.Done { log(-1, attempts) }
            count := oldCount
            if direction.Direction != enemy.ChaseNoDir { count = direction.MoveCount }
            log(41, direction.Direction, count, direction.Random.GameplayIndex)
        }
        log(99, index)
    }
}
`);
    const built = spawnSync("dotnet", [cli, "build", main, "--package-root", port, "--asset-root", scratch, "-o", map],
        { cwd: root, encoding: "utf8", timeout: 40_000 });
    if (built.error) throw built.error;
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const encoded = JSON.parse(readFileSync(map, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    const sim = simulator(decode(encoded), true);
    const results = Array.from({ length: monsterCases.length + directions.length }, (_, index) => {
        const start = sim.logs.length;
        for (let host = 0; sim.logs.length === start && host < 32; host++) sim.step();
        const rows = Array.from(sim.logs.slice(start), row => Array.from(row, Number));
        assert.deepEqual(rows.pop(), [99, index]);
        if (index < monsterCases.length) {
            assert.equal(rows.length, 1);
            return rows[0];
        }
        const [tag, ...summary] = rows.pop();
        assert.equal(tag, 41);
        assert.ok(rows.every(([tag]) => tag === 40));
        return [rows.map(([, candidate]) => candidate), ...summary];
    });
    return [results.slice(0, looks.length), results.slice(looks.length, monsterCases.length), results.slice(monsterCases.length)];
}

const digest = traces => createHash("sha256").update(JSON.stringify(traces)).digest("hex");
try {
    const actual = traceFletcher();
    if (values.upstream) {
        const upstream = path.resolve(root, values.upstream);
        const expected = [
            runNativeMonsterOracle(upstream, scratch, looks),
            runNativeChaseOracle(upstream, scratch, chases),
            runNativeChaseDirections(upstream, scratch, directions),
        ];
        [looks, chases, directions].forEach((group, kind) => group.forEach((entry, index) =>
            assert.deepEqual(actual[kind][index], expected[kind][index], entry.name ?? JSON.stringify(entry))));
        console.log(`Matched ${looks.length} look, ${chases.length} chase, and ${directions.length} movement search cases with pinned C. SHA-256 ${digest(expected)}.`);
    } else {
        assert.equal(digest(actual), "d9b214ad8ac72e3fdfd63291d4476fffdc0f91972c3e69ca13774d64c528b816");
        console.log("Verified monster look, chase, and movement search against the pinned C snapshot.");
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-monsters-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
