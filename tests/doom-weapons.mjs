import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runNativeWeaponsOracle } from "./doom-native-weapons-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-weapons-"));
const weapons = ["fist", "pistol", "shotgun", "chaingun", "rocket launcher", "plasma rifle", "BFG", "chainsaw", "super shotgun"];

function fixture(name, { weapon = 1, mode = 1, ammo = [8, 8, 80, 6], owned = [0, 1, weapon],
    seed = 0, attackDown = true, bob = 818212, commands = [[15], [65, true], [16], [23, true]] } = {}) {
    const ticks = commands.flatMap(([count, attack = false, change = {}]) => Array.from({ length: count }, (_, i) => ({
        attack, select: i === 0 ? change.select ?? -1 : -1, health: i === 0 ? change.health ?? -1 : -1,
        dead: i === 0 && !!change.dead, drop: i === 0 && !!change.drop,
    })));
    return { name, weapon, mode, ammo, owned, seed, attackDown, bob, ticks };
}

const cases = [
    ...weapons.map((name, weapon) => fixture(name, { weapon, mode: weapon === 8 ? 2 : 1, seed: Math.min(249 + weapon, 255) })),
    fixture("reborn attack latch blocks a rocket until release", {
        weapon: 4, commands: [[45, true], [6], [56, true]],
    }),
    fixture("raise triggers a shot when attack is already held and unlatched", {
        weapon: 6, attackDown: false, commands: [[44, true]],
    }),
    fixture("plasma fallback takes priority over shells and bullets", {
        weapon: 4, mode: 2, ammo: [12, 6, 3, 0], owned: [0, 1, 2, 3, 4, 5, 8], commands: [[18], [50, true], [16]],
    }),
    fixture("shareware fallback skips plasma and BFG", {
        weapon: 4, mode: 0, ammo: [0, 7, 60, 0], owned: [0, 1, 2, 4, 5, 6, 8], commands: [[18], [46, true], [19]],
    }),
    fixture("two shells fail the stricter automatic SSG selection", {
        mode: 2, ammo: [0, 2, 0, 0], owned: [0, 1, 7, 8], commands: [[19], [43, true], [15]],
    }),
    fixture("three shells select the SSG and check reload before opening", {
        mode: 2, ammo: [0, 3, 0, 0], owned: [0, 1, 7, 8], commands: [[19], [54, true], [23]],
    }),
    fixture("exactly 40 cells cannot choose the BFG as a fallback", {
        ammo: [0, 0, 40, 0], owned: [0, 1, 6], commands: [[19], [47, true]],
    }),
    fixture("a ready BFG fires with exactly 40 cells then switches away", {
        weapon: 6, ammo: [4, 0, 40, 0], commands: [[19], [71, true], [16]],
    }),
    fixture("a chaingun makes its second sound even when the first shot emptied it", {
        weapon: 3, ammo: [1, 0, 0, 0], commands: [[17], [25, true]],
    }),
    fixture("pending change interrupts automatic refire and raises a saw", {
        owned: [0, 1, 7], commands: [[18], [8, true], [64, true, { select: 7 }], [14]],
    }),
    fixture("dead player keeps the lowered sprite at bottom", {
        commands: [[19], [3, true], [30, false, { health: 0, dead: true, drop: true }]],
    }),
    fixture("zero health clears the lowered sprite after its final tic", {
        commands: [[19], [31, false, { health: 0 }]],
    }),
];

const totalTics = cases.reduce((sum, fixture) => sum + fixture.ticks.length + 1, 0);

function renderFletcher() {
    const casesSource = [], attack = [];
    for (const fixture of cases) {
        const { weapon, mode, seed, bob, attackDown, ammo, owned } = fixture;
        casesSource.push(`        case ${attack.length}:
            init = true
            current = play.WeaponStep{Inventory: play.NewPlayerInventory(100), ActorState: actorinfo.StatePlayerReady,
                Random: play.RandomState{GameplayIndex: ${seed}}, View: play.WeaponView{AttackDown: ${attackDown}}}
            current.Inventory.ReadyWeapon = ${weapon}
            current.Inventory.Ammo = [4]int{${ammo}}
            current.Inventory.Weapons = [9]bit{${weapons.map((_, index) => owned.includes(index))}}
            now = play.WeaponInput{Bob: ${bob}, Shareware: ${mode === 0}, Commercial: ${mode === 2}}`);
        attack.push(false);
        for (const command of fixture.ticks) {
            const { select, health, dead, drop } = command;
            const changes = [];
            if (select >= 0) changes.push(`current.Inventory.PendingWeapon = ${select}`);
            if (health >= 0) changes.push(`current.Inventory.Health = ${health}`);
            if (dead) changes.push("current.Inventory.Dead = true");
            if (drop) changes.push("drop = true");
            if (changes.length) casesSource.push(`        case ${attack.length}:\n            ${changes.join("\n            ")}`);
            attack.push(command.attack);
        }
    }
    return `package main
import "actorinfo"
import "play"
const Attack = [${attack.length}]bit{
${Array.from({ length: Math.ceil(attack.length / 32) }, (_, i) => "    " + attack.slice(i * 32, (i + 1) * 32).join(", ") + ",").join("\n")}
}

map "Doom weapon parity" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register active play.WeaponStep = play.WeaponStep{}
    register control play.WeaponInput = play.WeaponInput{}
    tick {
        current, now := active, control
        init, drop := false, false
        switch currentTick() {
${casesSource.join("\n")}
        }
        now.Attack = Attack[currentTick()]
        if init {
            current = play.SetupWeaponSprites(current.Inventory, current.View, current.ActorState, current.Random)
        } else if drop {
            current = play.DropPlayerWeapon(current.Inventory, current.View, current.ActorState, current.Random)
        } else {
            current = play.BeginWeaponTick(current.Inventory, current.View, current.ActorState, current.Random, now)
        }
        hasAttack := current.Action != 0
        for phase := range 2 {
            if phase == 0 || hasAttack {
                for i := range current.SignalCount {
                    signal := current.Signals[i]
                    log(signal.Kind, signal.Value)
                }
                if current.Action != 0 {
                    log(4, current.Action)
                    current = play.ResumeWeaponAction(current)
                }
            }
        }
        if !current.Done || current.Failed || current.Action != 0 { log(-1) }
        held, flash := current.View.Weapon, current.View.Flash
        log(10, held.State, held.Tics, held.X, held.Y)
        log(11, flash.State, flash.Tics, flash.X, flash.Y)
        log(12, current.Inventory.ReadyWeapon, current.Inventory.PendingWeapon, current.View.AttackDown,
            current.View.Refire, current.View.ExtraLight, current.ActorState)
        ammo := current.Inventory.Ammo
        log(13, current.Random.GameplayIndex, ammo[0], ammo[1], ammo[2], ammo[3])
        log(99, currentTick())
        if !init { now.LevelTime = now.LevelTime + 1 }
        next control = now
        next active = current
    }
}
`;
}

function traceFletcher() {
    const source = path.join(scratch, "main.flt"), output = path.join(scratch, "result.json");
    writeFileSync(source, renderFletcher());
    const build = spawnSync("dotnet", [cli, "build", source, "--package-root", port, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 40000 });
    if (build.error) throw build.error;
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const map = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(Buffer.from(map.data, "base64")[2], 1);
    const sim = simulator(decode(map.data), true);
    let index = 0;
    return cases.map(fixture => {
        const trace = [];
        for (let tick = 0; tick < fixture.ticks.length + 1; tick++) {
            const start = sim.logs.length;
            let hostTics = 0;
            while (sim.logs.length === start && hostTics++ < 24) sim.step();
            const rows = Array.from(sim.logs.slice(start), row => Array.from(row, Number));
            assert.deepEqual(rows.pop(), [99, index], fixture.name + " committed logical tic " + tick);
            assert.ok(!rows.some(([tag]) => tag === -1), fixture.name + " completed logical tic " + tick);
            trace.push(...rows);
            index++;
        }
        return trace;
    });
}

const digest = traces => createHash("sha256").update(JSON.stringify(traces)).digest("hex");
try {
    const actual = traceFletcher();
    if (values.upstream) {
        const expected = runNativeWeaponsOracle(path.resolve(root, values.upstream), scratch, cases);
        cases.forEach(({ name }, index) => assert.deepEqual(actual[index], expected[index], name));
        console.log(`Matched ${cases.length} scenarios and ${totalTics} snapshots with pinned Doom C. SHA-256 ${digest(expected)}.`);
    } else {
        assert.equal(digest(actual), "4d115059e9d21c8b8d196040aa57d50c6b682fc725bb749a093ad94084d114b2");
        console.log(`Verified ${cases.length} weapon scenarios against the pinned C snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-weapons-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
