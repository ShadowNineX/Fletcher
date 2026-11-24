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
const { values } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-actor-state-"));

const puff4 = 96, player = 149, stand = 174, stand2 = 175;
const vileAttack = 255, vileFace = 256, vileTarget = 257;
const barrelA = 806, barrelB = 807;
const countKill = 0x400000;

// The native fixture needs only the referenced rows. The Fletcher side reads
// the production banks, which are independently checked against all C rows.
const stateTable = [
    [puff4, 17, 3, 4, 0, 0],
    [player, 28, 0, -1, 0, 0],
    [stand, 29, 0, 10, 29, stand2],
    [stand2, 29, 1, 10, 29, stand],
    [vileAttack, 31, 32774, 0, 36, vileFace],
    [vileFace, 31, 32774, 10, 31, vileTarget],
    [vileTarget, 31, 32775, 8, 37, 258],
    [barrelA, 57, 0, 6, 0, barrelB],
    [barrelB, 57, 1, 6, 0, barrelA],
];

const tic = value => ["tick", value];
const set = value => ["set", value];
const normal = { actionMode: 0, respawnMonsters: false };
const cases = [
    { ...normal, name: "passive frame timer and wrap", initial: [barrelA, 2, 20, 0, 0, 0],
        commands: Array.from({ length: 9 }, (_, index) => tic(index)) },
    { ...normal, name: "zero-tic entry runs actions in order", initial: [stand, 4, 40, 0, countKill, 5],
        commands: [set(vileAttack), ...Array.from({ length: 10 }, (_, index) => tic(index))] },
    { ...normal, name: "action can leave nonzero tics and stop the chain", actionMode: 1,
        initial: [stand, 4, 40, 0, countKill, 5], commands: [set(vileAttack), tic(0), tic(1), tic(2)] },
    { ...normal, name: "action changes current state but the entered successor wins", actionMode: 2,
        initial: [stand, 4, 40, 0, countKill, 5], commands: [set(vileAttack)] },
    { ...normal, name: "finite terminal frame removes actor from its thinker", initial: [puff4, 2, 10, 0, 0, 5],
        commands: [tic(0), tic(1)] },
    { ...normal, name: "direct null transition preserves the previous frame and tics", initial: [barrelA, 4, 20, 0, 0, 0],
        commands: [set(0)] },
    { ...normal, name: "negative one is a terminal hold", initial: [player, 2, 29, 44, 0, 23],
        commands: [set(player), tic(63), tic(64)] },
    { ...normal, name: "zero tics at the start of a thinker is decremented", initial: [vileAttack, 0, 29, 44, 0, 23],
        commands: [tic(63), tic(64)] },
    { ...normal, name: "nightmare minimum age, cadence, exact roll threshold and rejection", respawnMonsters: true,
        initial: [player, -1, 29, 418, countKill, 65], commands: [tic(32), tic(33), tic(64), tic(96)] },
    { ...normal, name: "nightmare skips uncounted actors", respawnMonsters: true,
        initial: [player, -1, 29, 419, 0, 65], commands: [tic(32)] },
    { ...normal, name: "nightmare-disabled actor consumes no movement counter or RNG",
        initial: [player, -1, 29, 419, countKill, 65], commands: [tic(32)] },
];

function casesToFletcher() {
    let frame = 0;
    return cases.flatMap(test => test.commands.map(([operation, value], index) => {
        const [id, tics, health, count, flags, rng] = test.initial;
        const setup = index === 0 ? `
            definition := actorinfo.StateAt(${id})
            current = play.LevelActor{Valid: true, State: ${id}, Tics: ${tics}, Health: ${health}, MoveCount: ${count},
                Sprite: definition.Sprite, Frame: definition.Frame,
                Physics: play.ActorPhysics{Body: play.MapActor{Flags: ${flags}}}}
            random = play.RandomState{GameplayIndex: ${rng}}` : "";
        return `case ${frame++}:${setup}
            direct, value, mode, nightmare = ${operation === "set"}, ${value}, ${test.actionMode}, ${test.respawnMonsters}`;
    })).join("\n        ");
}

function traceFletcher() {
    const source = path.join(scratch, "main.flt");
    const map = path.join(scratch, "state-test.json");
    writeFileSync(source, `package main
import "actorinfo"
import "play"

map "Doom actor state trace" {
    register actor play.LevelActor = play.LevelActor{}
    register rng play.RandomState = play.RandomState{}
    tick {
        current, random := actor, rng
        var direct bit
        var value int
        var mode int
        var nightmare bit
        switch currentTick() {
        ${casesToFletcher()}
        }
        var step play.ActorStateStep
        respawn := false
        if direct {
            step = play.SetMobjState(current, value)
        } else {
            advanced := play.TickMobjState(current, value, nightmare, random)
            step, random, respawn = advanced.Step, advanced.Random, advanced.Respawn
        }
        for range 8 {
            if step.Action != 0 {
                action, update := step.Action, step.Actor
                log(0, action, update.State, update.Tics, update.Sprite, update.Frame,
                    update.Health, update.MoveCount, random.GameplayIndex)
                update.Health = update.Health + action
                if action == actorinfo.ActionVileStart && mode == 1 { update.Tics = 3 }
                if action == actorinfo.ActionVileStart && mode == 2 { update.State = ${stand} }
                step = play.ResumeMobjState(step, update)
            }
        }
        if step.Failed || step.Action != 0 { log(-1) }
        after := step.Actor
        log(1, after.State, after.Tics, after.Sprite, after.Frame, after.Health,
            after.MoveCount, random.GameplayIndex, after.Valid, respawn)
        next actor = after
        next rng = random
    }
}
`);
    const result = spawnSync("dotnet", [cli, "build", source, "--package-root", port, "-o", map], {
        encoding: "utf8", cwd: root, timeout: 25000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(map, "utf8")).data), true);
    return cases.map(test => test.commands.map(() => {
        const first = sim.logs.length;
        sim.step();
        const rows = Array.from(sim.logs.slice(first), row => Array.from(row, Number));
        assert.equal(rows.at(-1)?.length, 10, test.name);
        assert.equal(rows.at(-1)[0], 1, test.name);
        for (const row of rows.slice(0, -1)) assert.equal(row[0], 0, test.name);
        return rows;
    }));
}

const digest = trace => createHash("sha256").update(JSON.stringify(trace)).digest("hex");

try {
    const observed = traceFletcher();
    if (values.upstream) {
        const { runNativeStateOracle } = await import("./doom-native-state-oracle.mjs");
        const native = runNativeStateOracle(path.resolve(root, values.upstream), scratch, stateTable, cases);
        for (const [index, test] of cases.entries()) assert.deepEqual(observed[index], native[index], test.name);
        console.log(`Compared ${cases.length} actor state traces with pinned Linux Doom C. SHA-256 ${digest(native)}.`);
    } else {
        assert.equal(digest(observed), "889a792d3a4360f9599c9543c20987aaad770d9ffc3ead88ddb400eb3a31b889");
        console.log(`Verified ${cases.length} actor state traces against the pinned C snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-actor-state-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
