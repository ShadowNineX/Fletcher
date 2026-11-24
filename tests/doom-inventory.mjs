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
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-inventory-"));
const unit = 65536;
const defaults = { health: 100, armor: 0, armorType: 0, ammo: [50, 0, 0, 0], ready: 1, owned: 3,
    skill: 2, commercial: true };
const item = (name, flags = 1, z = 0, height = 56) => ({ sprite: "SPR_" + name, flags, z: z * unit, height: height * unit });
const counted = 0x800000 | 1;
const dropped = 0x20000 | 1;
const cases = [
    { ...defaults, name: "health, armor and megasphere", health: 12, touches: [
        item("STIM"), item("MEDI"), item("BON1", counted), item("SOUL", counted), item("BON1", counted),
        item("STIM"), item("BON2", counted), item("ARM1"), item("ARM1"), item("ARM2"), item("MEGA"),
    ] },
    { ...defaults, name: "pickup reach uses toucher height and exact lower bound", touches: [
        item("BON1", counted, -9), item("BON1", counted, -8), item("BON1", counted, 56),
        item("BON1", counted, 57), item("BON1", counted, 5, 4), item("BON1", counted, 4, 4),
    ] },
    { ...defaults, name: "noncommercial megasphere and all six keys", commercial: false, touches: [
        item("MEGA"), item("BKEY"), item("YKEY"), item("RKEY"), item("BSKU"), item("YSKU"), item("RSKU"), item("RSKU"),
    ] },
    { ...defaults, name: "power durations, shadow flag, and held map power", health: 22, touches: [
        item("PINV", counted), item("PSTR", counted), item("PINS", counted), item("SUIT"), item("PMAP", counted),
        item("PMAP", counted), item("PVIS"), item("PINS", counted),
    ] },
    { ...defaults, name: "every ammo category and skill doubling", skill: 4, touches: [
        item("CLIP", dropped), item("AMMO"), item("ROCK"), item("BROK"), item("CELL"), item("CELP"),
        item("SHEL"), item("SBOX"), item("BPAK"), item("BPAK"), item("CLIP"),
    ] },
    { ...defaults, name: "all weapon families, dropped weapons, and ammo caps", ammo: [196, 49, 299, 49], touches: [
        item("SHOT", dropped), item("SGN2"), item("MGUN", dropped), item("CSAW"), item("LAUN"),
        item("PLAS"), item("BFUG"), item("SHOT"), item("SHEL"), item("CLIP"),
    ] },
    { ...defaults, name: "duplicate keys are consumed and placed and dropped weapons grant different ammo", ready: 0,
        ammo: [0, 0, 0, 0], touches: [item("BKEY"), item("BKEY"), item("MGUN"), item("MGUN"), item("MGUN", dropped)] },
    { ...defaults, name: "an owned shotgun remains when shells are full", ammo: [50, 50, 0, 0], owned: 7,
        touches: [item("SHOT"), item("SHOT", dropped)] },
    { ...defaults, name: "dead player receives no items", health: 0, touches: [item("BON1", counted), item("SHOT")] },
    { ...defaults, name: "ammo gained from zero changes weapon when eligible", ready: 0, owned: 31,
        ammo: [0, 0, 0, 0], touches: [item("CLIP"), item("SHEL"), item("CELL"), item("ROCK")] },
];

const metadata = readFileSync(path.join(port, "actorinfo", "tables.flt"), "utf8");
const names = metadata.match(/const SpriteNames = \[\d+\]int\{([^}]+)\}/s)[1].match(/-?\d+/g).map(Number);
function spriteId(name) {
    const id = names.indexOf(Buffer.from(name.slice(4), "ascii").readInt32LE());
    assert.ok(id >= 0, name);
    return id;
}

function generateCases() {
    let frame = 0;
    return cases.flatMap(entry => entry.touches.map((touch, index) => {
        const initial = index === 0 ? `
            player = play.NewPlayerInventory(${entry.health})
            player.Armor, player.ArmorType = ${entry.armor}, ${entry.armorType}
            player.ReadyWeapon, player.PendingWeapon = ${entry.ready}, ${entry.ready}
            player.Ammo = [4]int{${entry.ammo.join(", ")}}
            player.Weapons = [9]bit{${Array.from({ length: 9 }, (_, bit) => Boolean(entry.owned & (1 << bit))).join(", ")}}
            toucher = play.LevelActor{Valid: true, Health: ${entry.health}, Physics: play.ActorPhysics{
                Body: play.MapActor{Player: true},
            }}` : "";
        return `        case ${frame++}:${initial}
            toucher.Physics.Body.Height = ${touch.height}
            special = play.LevelActor{Valid: true, Sprite: ${spriteId(touch.sprite)},
                Physics: play.ActorPhysics{Body: play.MapActor{Flags: ${touch.flags}, Z: ${touch.z}}}}
            rules = play.PickupRules{Skill: ${entry.skill}, Commercial: ${entry.commercial}}`;
    })).join("\n");
}

function traceFletcher() {
    const source = path.join(scratch, "main.flt");
    const output = path.join(scratch, "inventory.json");
    writeFileSync(source, `package main
import "play"
map "Doom inventory parity" {
    register saved play.PlayerInventory = play.PlayerInventory{}
    register body play.LevelActor = play.LevelActor{}
    tick {
        player, toucher := saved, body
        var rules play.PickupRules
        var special play.LevelActor
        switch currentTick() {
${generateCases()}
        }
        grant := play.TouchPickup(player, special, toucher, rules)
        item := grant.Inventory
        owned, cards := 0, 0
        for index := range play.WeaponCount {
            if item.Weapons[index] { owned = owned | (1 << index) }
        }
        for index := range play.CardCount {
            if item.Cards[index] { cards = cards | (1 << index) }
        }
        log(grant.Removed, grant.Sound, item.Health, grant.Actor.Health, item.Armor, item.ArmorType,
            item.ItemCount, item.BonusCount, item.ReadyWeapon, item.PendingWeapon, owned, cards, item.Backpack,
            grant.Actor.Physics.Body.Flags, item.Ammo[0], item.Ammo[1], item.Ammo[2], item.Ammo[3],
            item.MaxAmmo[0], item.MaxAmmo[1], item.MaxAmmo[2], item.MaxAmmo[3],
            item.Powers[0], item.Powers[1], item.Powers[2], item.Powers[3], item.Powers[4], item.Powers[5])
        next saved = item
        next body = grant.Actor
    }
}
`);
    const result = spawnSync("dotnet", [cli, "build", source, "--package-root", port, "-o", output],
        { encoding: "utf8", cwd: root, timeout: 25000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    return cases.map(entry => entry.touches.map(() => {
        const before = sim.logs.length;
        sim.step();
        assert.equal(sim.logs.length, before + 1, entry.name);
        return Array.from(sim.logs[before], Number);
    }));
}

const digest = trace => createHash("sha256").update(JSON.stringify(trace)).digest("hex");
try {
    const actual = traceFletcher();
    const count = cases.reduce((total, entry) => total + entry.touches.length, 0);
    if (values.upstream) {
        const { runNativeInventoryOracle } = await import("./doom-native-inventory-oracle.mjs");
        const expected = runNativeInventoryOracle(path.resolve(root, values.upstream), scratch, cases);
        for (const [index, entry] of cases.entries()) {
            for (const [event, touch] of entry.touches.entries()) {
                assert.deepEqual(actual[index][event], expected[index][event], `${entry.name}: ${touch.sprite} touch ${event + 1}`);
            }
        }
        console.log(`Matched ${count} inventory touches with pinned Linux Doom C. SHA-256 ${digest(expected)}.`);
    } else {
        assert.equal(digest(actual), "a41ca6640607cbd56a83dffbc7f6579f2d9c2b1468f4530d752a2c764347a586");
        console.log(`Verified ${count} inventory touches against the pinned C snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-inventory-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
