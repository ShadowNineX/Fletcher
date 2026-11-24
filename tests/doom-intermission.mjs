import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runNativeIntermissionOracle } from "./doom-native-intermission-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-intermission-"));

const source = `package main
import "play"

map "Doom intermission" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register state play.IntermissionState = play.IntermissionState{}
    tick {
        nextState := state
        if currentTick() == 0 {
            route := play.CampaignRoute{Valid: true, ShowPar: true, ParTics: 70}
            score := play.IntermissionScore{Kills: 50, MaxKills: 100, Items: 10, MaxItems: 10, TimeTics: 140}
            nextState = play.StartIntermission(route, score, true, false)
        }
        attack, use := false, false
        if currentTick() == 0 { attack = true }
        if currentTick() == 36 { use = true }
        if currentTick() == 39 { attack = true }
        if currentTick() == 41 { attack = true }
        nextState = play.TickIntermission(nextState, attack, use)
        shown := nextState
        if currentTick() >= 52 {
            route := play.CampaignRoute{Valid: true, Commercial: true}
            score := play.IntermissionScore{}
            if currentTick() == 53 { score.Kills = 2 }
            shown = play.TickIntermission(play.StartIntermission(route, score, false, false), false, true)
        }
        log(currentTick(), shown.Stage, shown.StatsState, shown.Pause, shown.Countdown, shown.Counts.Kills, shown.Counts.Items,
            shown.Counts.Secrets, shown.Counts.Time, shown.Counts.Par, shown.PointerOn, shown.Changed, shown.AttackDown, shown.UseDown, shown.Sound)
        next state = nextState
    }
}
`;

function trace() {
    const input = path.join(scratch, "intermission.flt");
    const output = path.join(scratch, "intermission.json");
    writeFileSync(input, source);
    const built = spawnSync("dotnet", [cli, "build", input, "--package-root", port, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30_000 });
    if (built.error) throw built.error;
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    const sim = simulator(decode(encoded), true);
    for (let host = 0; host < 220 && sim.logs.length < 55; host++) sim.step();
    assert.equal(sim.logs.length, 55);
    return sim.logs.map(row => Array.from(row, Number));
}

try {
    const rows = trace();
    const at = tic => rows.find(row => row[0] === tic);
    assert.deepEqual(at(0), [0, 1, 1, 34, 0, -1, -1, -1, -1, -1, 0, 0, 1, 0, 0], "held attack is latched, not accelerated");
    assert.deepEqual(at(34).slice(1, 5), [1, 2, 35, 0], "the opening pause lasts 35 tics");
    assert.deepEqual(at(35).slice(1, 15), [1, 2, 35, 0, 1, -1, -1, -1, -1, 0, 1, 0, 0, 1], "counts tick by two and pistol clips every four background tics");
    assert.deepEqual(at(36).slice(1, 15), [1, 10, 35, 0, 50, 100, 0, 4, 2, 0, 1, 0, 1, 2], "a use edge skips independently to all final counters");
    assert.equal(at(37)[1], 1, "holding use does not re-accelerate");
    assert.deepEqual(at(39).slice(1, 15), [2, 10, 35, 140, 50, 100, 0, 4, 2, 0, 1, 1, 0, 3], "an attack edge enters the 140-tic next-location page");
    assert.deepEqual(at(40).slice(1, 15), [2, 10, 35, 139, 50, 100, 0, 4, 2, 1, 1, 0, 0, 0], "the pointer follows Doom's 32-tic blink phase");
    assert.deepEqual(at(41).slice(1, 15), [3, 10, 35, 10, 50, 100, 0, 4, 2, 1, 1, 1, 0, 0], "next-location input enters the 10-tic delay without changing Doom's pointer latch");
    assert.equal(at(51)[1], 4, "the delay reaches the done stage after ten tics");
    assert.deepEqual(at(52).slice(1, 15), [1, 10, 35, 0, 0, 0, 0, 0, -1, 0, 1, 0, 1, 2], "zero maxima accelerate safely and leave a hidden par unavailable");
    assert.equal(at(53)[5], 200, "native zero-max normalization gives bonus kills a denominator of one");
    if (values.upstream) {
        const native = runNativeIntermissionOracle(path.resolve(root, values.upstream), scratch);
        const comparable = rows.slice(0, 51).map(row => [row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10], row[14]]);
        assert.deepEqual(comparable, native.slice(0, 51), "pinned WI single-player ticker trace");
    }
    console.log("Verified intermission pauses, edge acceleration, count targets, pointer blink, and handoff delay.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-intermission-[^/\\\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
