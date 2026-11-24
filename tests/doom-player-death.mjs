import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runNativePlayerDeathOracle } from "./doom-native-player-death-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-player-death-"));
const unit = 65536;
const angle90 = 0x40000000;
const north = angle90 - 1;
const deathTurn = Math.floor(angle90 / 18);

const entry = (name, options = {}) => ({
    name, z: 0, floor: 0, ceiling: 128 * unit, height: 41 * unit, angle: north, damage: 9, attacker: 0, use: false,
    momentumX: 0, momentumY: 0, cheats: 0, ...options,
});
const cases = [
    entry("no attacker fades the damage flash"),
    entry("self attacker fades the damage flash", { attacker: 2 }),
    entry("near positive delta snaps to attacker and fades", { attacker: 1, angle: north - deathTurn + 1 }),
    entry("positive five-degree boundary turns without fading", { attacker: 1, angle: north - deathTurn }),
    entry("negative five-degree boundary turns without fading", { attacker: 1, angle: north + deathTurn }),
    entry("near negative delta snaps to attacker and fades", { attacker: 1, angle: north + deathTurn - 1 }),
    entry("wrapped eastward target snaps across zero", { attacker: 3, angle: 0xffffffff }),
    entry("diagonal attacker uses the original point-angle table", { attacker: 4, angle: 0 }),
    entry("half turn advances toward the southern attacker", { attacker: 5, angle: north }),
    entry("falling view reaches the six-unit floor cutoff", { height: 7 * unit, damage: 0 }),
    entry("short view clamps to the six-unit floor cutoff", { height: 6 * unit - 1, damage: 0 }),
    entry("low grounded ceiling clamps the death view", { ceiling: 30 * unit, damage: 0 }),
    entry("airborne view keeps the death height over the ceiling clamp", { z: 20 * unit, ceiling: 30 * unit, height: 20 * unit, damage: 0 }),
    entry("ground momentum produces Doom bob", { momentumX: unit, damage: 0 }),
    entry("no-momentum cheat bypasses the bob and low ceiling clamp", { momentumX: unit, ceiling: 30 * unit, cheats: 4, damage: 0 }),
    entry("use requests rebirth immediately", { use: true, damage: 0 }),
];

function source() {
    const arms = cases.map((scenario, index) => `        case ${index}: z, floor, ceiling, height, angle, damage, attacker, use, momentumX, momentumY, cheats = ${scenario.z}, ${scenario.floor}, ${scenario.ceiling}, ${scenario.height}, bits<32>(${scenario.angle >>> 0}), ${scenario.damage}, ${scenario.attacker}, ${scenario.use ? "true" : "false"}, ${scenario.momentumX}, ${scenario.momentumY}, ${scenario.cheats}`).join("\n");
    return `package main
import "actorinfo"
import "play"

map "Doom player death thinker" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        z, floor, ceiling, height, angle, damage, attacker, momentumX, momentumY, cheats := 0, 0, 0, 0, bits<32>(0), 0, 0, 0, 0, 0
        use := false
        switch currentTick() {
${arms}
        }
        player := play.LevelActor{Valid: true, Kind: actorinfo.ActorPlayer, PlayerSlot: 0,
            Physics: play.ActorPhysics{Angle: angle, MomentumX: momentumX, MomentumY: momentumY, ViewHeight: height, ViewHeightDelta: 7 * 65536,
                Body: play.MapActor{X: 0, Y: 0, Z: z, Floor: floor, Ceiling: ceiling, Player: true, Flags: play.ActorShootable}}}
        var world play.CombatWorld
        world.Actors = world.Actors.AppendActor(player)
        world.Actors.PlayerActors[0] = 1
        if attacker == 1 || attacker == 3 || attacker == 4 || attacker == 5 {
            x, y := 0, 64 * 65536
            if attacker == 3 { x, y = 64 * 65536, 0 }
            if attacker == 4 { x, y = 64 * 65536, 64 * 65536 }
            if attacker == 5 { x, y = 0, -64 * 65536 }
            world.Actors = world.Actors.AppendActor(play.LevelActor{Valid: true, Kind: actorinfo.ActorImp,
                Physics: play.ActorPhysics{Body: play.MapActor{X: x, Y: y}}})
            world.Players[0].Attacker = 2
        } else if attacker == 2 { world.Players[0].Attacker = 1 }
        world.Players[0].Dead, world.Players[0].DamageCount, world.Players[0].Cheats = true, damage, bits<32>(cheats)
        step := play.TickPlayerDeath(world, 1, 0, use)
        live := step.World.Actors.ActorAt(0)
        log(live.Physics.Angle, live.Physics.ViewHeight, live.Physics.ViewHeightDelta, step.View.Z,
            step.World.Players[0].DamageCount, step.Reborn)
    }
}
`;
}

function traceFletcher() {
    const input = path.join(scratch, "player-death.flt");
    const output = path.join(scratch, "player-death.json");
    writeFileSync(input, source());
    const built = spawnSync("dotnet", [cli, "build", input, "--package-root", port, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (built.error) throw built.error;
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    const sim = simulator(decode(encoded), true);
    return cases.map((scenario, index) => {
        const before = sim.logs.length;
        for (let host = 0; host < 96 && sim.logs.length === before; host++) sim.step();
        assert.equal(sim.logs.length, before + 1, scenario.name);
        const [angle, height, delta, z, damage, reborn] = Array.from(sim.logs[before], Number);
        return { angle, height, delta, z, damage, reborn };
    });
}

try {
    const observed = traceFletcher();
    const digest = createHash("sha256").update(JSON.stringify(observed)).digest("hex");
    if (values.upstream) {
        const native = runNativePlayerDeathOracle(path.resolve(root, values.upstream), scratch, cases);
        cases.forEach((scenario, index) => assert.deepEqual(observed[index], native[index], scenario.name));
        console.log(`Matched ${cases.length} player-death cases with pinned Doom C. Fletcher SHA-256 ${digest}.`);
    } else {
        assert.equal(digest, "061bd561ab1f3fde8518147cfe652e28279958fda25479b4d19645e34d23f734");
        console.log(`Verified ${cases.length} player-death cases against the pinned snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-player-death-[^/\\\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
