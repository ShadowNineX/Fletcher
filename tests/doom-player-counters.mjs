import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runNativePlayerCounterOracle } from "./doom-native-player-counter-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-player-counters-"));

const entry = (name, options = {}) => ({
    name, strength: 0, invulnerability: 0, invisibility: 0, infrared: 0, iron: 0, damage: 0, bonus: 0, shadow: 0, ...options,
});
const cases = [
    entry("all active counters update and invisibility expires", { strength: 1, invulnerability: 130, invisibility: 1, infrared: 130, iron: 1, damage: 2, bonus: 1, shadow: 1 }),
    entry("inverse colormap turns off at exactly 128", { invulnerability: 129 }),
    entry("inverse colormap flashes in the final window", { invulnerability: 121 }),
    entry("infrared colormap wins after invulnerability expires", { infrared: 130 }),
    entry("infrared colormap turns off at exactly 128", { infrared: 129 }),
    entry("inverse colormap has priority over infrared", { invulnerability: 130, infrared: 130 }),
    entry("zero counters preserve an unshadowed player"),
];

function source() {
    const arms = cases.map((scenario, index) => `        case ${index}: strength, invulnerability, invisibility, infrared, iron, damage, bonus, shadow = ${scenario.strength}, ${scenario.invulnerability}, ${scenario.invisibility}, ${scenario.infrared}, ${scenario.iron}, ${scenario.damage}, ${scenario.bonus}, ${scenario.shadow}`).join("\n");
    return `package main
import "actorinfo"
import "play"

map "Doom player counters" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        strength, invulnerability, invisibility, infrared, iron, damage, bonus, shadow := 0, 0, 0, 0, 0, 0, 0, 0
        switch currentTick() {
${arms}
        }
        flags := bits<32>(play.ActorShootable)
        if shadow != 0 { flags = flags | play.ActorShadow }
        actor := play.LevelActor{Valid: true, Kind: actorinfo.ActorPlayer, PlayerSlot: 0,
            Physics: play.ActorPhysics{Body: play.MapActor{Player: true, Flags: flags}}}
        var world play.CombatWorld
        world.Actors = world.Actors.AppendActor(actor)
        world.Actors.PlayerActors[0] = 1
        world.Players[0].Powers[play.PowerStrength] = strength
        world.Players[0].Powers[play.PowerInvulnerability] = invulnerability
        world.Players[0].Powers[play.PowerInvisibility] = invisibility
        world.Players[0].Powers[play.PowerInfrared] = infrared
        world.Players[0].Powers[play.PowerIronFeet] = iron
        world.Players[0].DamageCount, world.Players[0].BonusCount = damage, bonus
        world = play.TickLivePlayerCounters(world, 1)
        player := world.Players[0]
        live := world.Actors.ActorAt(0)
        log(player.Powers[0], player.Powers[1], player.Powers[2], player.Powers[3], player.Powers[4], player.Powers[5],
            player.DamageCount, player.BonusCount, player.FixedColormap, live.Physics.Body.Flags & play.ActorShadow != 0)
    }
}
`;
}

function traceFletcher() {
    const input = path.join(scratch, "player-counters.flt");
    const output = path.join(scratch, "player-counters.json");
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
        const row = Array.from(sim.logs[before], Number);
        assert.equal(sim.logs.length, before + 1, scenario.name);
        return { powers: row.slice(0, 6), damage: row[6], bonus: row[7], colormap: row[8], shadow: row[9] };
    });
}

try {
    const observed = traceFletcher();
    const digest = createHash("sha256").update(JSON.stringify(observed)).digest("hex");
    if (values.upstream) {
        const native = runNativePlayerCounterOracle(path.resolve(root, values.upstream), scratch, cases);
        cases.forEach((scenario, index) => assert.deepEqual(observed[index], native[index], scenario.name));
        console.log(`Matched ${cases.length} player-counter cases with pinned Doom C. Fletcher SHA-256 ${digest}.`);
    } else {
        assert.equal(digest, "b7b7af5d0a9a5e170338a09ebf56ecb8a639ebb96bba3bb1d9527680d0117ece");
        console.log(`Verified ${cases.length} player-counter cases against the pinned snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-player-counters-[^/\\\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
