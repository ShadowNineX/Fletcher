import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runNativePlayerSectorOracle } from "./doom-native-player-sector-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-player-sectors-"));
const unit = 65536;

const entry = (name, special, options = {}) => ({
    name, special, z: 0, floor: 0, time: 32, iron: 0, health: 100, cheats: 0, random: 0, repeat: 1, ...options,
});
const cases = [
    entry("ordinary ground does nothing", 0),
    entry("hellslime waits for the thirty-second phase", 5, { time: 31 }),
    entry("hellslime damages ten on phase", 5),
    entry("hellslime ignores a player still above the floor", 5, { z: unit }),
    entry("nukage damages five on phase", 7),
    entry("super hellslime damages twenty on phase", 16),
    entry("super hellslime suit consumes one random value", 16, { iron: 1 }),
    entry("super hellslime suit leaks at a low random roll", 16, { iron: 1, random: 61 }),
    entry("strobe hurt damages twenty without a suit", 4),
    entry("strobe hurt suit consumes one random value off phase", 4, { iron: 1, time: 31 }),
    entry("strobe hurt suit consumes one random value without damage", 4, { iron: 1 }),
    entry("strobe hurt suit leaks at a low random roll", 4, { iron: 1, random: 61 }),
    entry("secret sector counts once and clears itself", 9, { repeat: 2 }),
    entry("a floor transfer can restore and clear a secret sector", 9, { repeat: 2, restoreSecret: true }),
    entry("exit damage clears god mode before the phase", 11, { time: 31, cheats: 2 }),
    entry("exit damage leaves the player alive at one health and exits", 11, { health: 10, cheats: 2 }),
    entry("exit damage does not exit above ten health", 11, { health: 31 }),
];

function sectorBytes({ special, floor }) {
    const bytes = Buffer.alloc(26);
    bytes.writeInt16LE(floor / unit, 0);
    bytes.writeInt16LE(128, 2);
    bytes.write("FLOOR0_1", 4);
    bytes.write("CEIL1_1", 12);
    bytes.writeInt16LE(160, 20);
    bytes.writeInt16LE(special, 22);
    return bytes;
}

function entrySource() {
    const files = [], arms = [];
    for (const [index, scenario] of cases.entries()) {
        writeFileSync(path.join(scratch, `sector${index}.bin`), sectorBytes(scenario));
        files.push(`const sector${index} = readFile("sector${index}.bin")`);
        arms.push(`        case ${index}:
            source, z, time, iron, health, cheats, random, repeat, restoreSecret = sector${index}, ${scenario.z}, ${scenario.time}, ${scenario.iron}, ${scenario.health}, ${scenario.cheats}, ${scenario.random}, ${scenario.repeat}, ${scenario.restoreSecret ? "true" : "false"}`);
    }
    return `package main
import "actorinfo"
import "play"
import "wad"

${files.join("\n")}

map "Doom player sector effects" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        var source bytes
        z, time, iron, health, cheats, random, repeat, restoreSecret := 0, 0, 0, 0, 0, 0, 0, false
        switch currentTick() {
${arms.join("\n")}
        }
        level := wad.BspLevel{Valid: true, File: source, Sectors: wad.Lump{Offset: 0, Count: 1, Valid: true}}
        player := play.LevelActor{Valid: true, Kind: actorinfo.ActorPlayer, Sector: 0, Health: health, PlayerSlot: 0,
            Physics: play.ActorPhysics{Body: play.MapActor{Z: z, Floor: 0, Ceiling: 128 * 65536, Height: 56 * 65536,
                Flags: play.ActorShootable, Player: true}}}
        var world play.CombatWorld
        world.Actors = world.Actors.AppendActor(player)
        world.Actors.PlayerActors[0] = 1
        world.Players[0] = play.PlayerInventory{Health: health, Cheats: bits<32>(cheats)}
        world.Players[0].Powers[play.PowerIronFeet] = iron
        world.Random.GameplayIndex = random
        var state play.LevelSpecials
        var step play.PlayerSectorStep
        for index := range repeat {
            step = play.TickPlayerSector(level, state, world, 1, time, play.CombatRules{Skill: 2, ConsolePlayer: 0})
            state, world = step.State, step.Combat.World
            if index == 0 && restoreSecret {
                // A prior transfer restored the special and finished. Use the live
                // mover path to retire the floor before the player finds it again.
                state.Floors = state.Floors.Append(play.SectorFloor{Sector: 0, Surface: play.FloorSurface{Changed: true, Special: 9},
                    Motion: play.FloorState{Active: true, Direction: 1, Speed: 1, Mode: play.FloorRaise}})
                state = play.TickLevelMovers(level, wad.BlockMapInfo{}, state, play.MapActor{}).State
            }
        }
        live := world.Actors.ActorAt(0)
        log(world.Players[0].Health, world.Players[0].SecretCount, world.Players[0].Cheats,
            state.ApplyTo(level).SectorSpecial(0), world.Random.GameplayIndex, state.ExitRequested, live.Health, state.Floors.Revision)
    }
}
`;
}

function compileFixture(name, text) {
    const folder = path.join(scratch, name);
    mkdirSync(folder);
    const source = path.join(folder, "main.flt");
    const output = path.join(scratch, `${name}.json`);
    writeFileSync(source, text);
    const built = spawnSync("dotnet", [cli, "build", source, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (built.error) throw built.error;
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    return simulator(decode(encoded), true);
}

function traceFletcher() {
    const sim = compileFixture("player-sectors", entrySource());
    return cases.map((scenario, index) => {
        const before = sim.logs.length;
        for (let host = 0; host < 96 && sim.logs.length === before; host++) sim.step();
        const rows = sim.logs.slice(before).map(row => Array.from(row, Number));
        assert.equal(rows.length, 1, scenario.name);
        const [health, secret, cheats, special, random, exit, actorHealth, revision] = rows[0];
        return { health, secret, cheats, special, random, exit, actorHealth, revision };
    });
}

function verifyTimedDoorFloorTransfer() {
    for (const special of [10, 14, 5]) {
        const front = sectorBytes({ special, floor: 0 });
        front.write("SRCFLAT0", 4);
        const back = sectorBytes({ special: 0, floor: 32 * unit });
        back.writeInt16LE(7, 24);
        const vertices = Buffer.alloc(8);
        vertices.writeInt16LE(64, 6);
        const sides = Buffer.alloc(60);
        sides.writeInt16LE(1, 58);
        const line = Buffer.alloc(14);
        line.writeInt16LE(1, 2);   // last vertex
        line.writeInt16LE(4, 4);   // two-sided
        line.writeInt16LE(59, 6);  // W1 raise by 24 and copy the front surface
        line.writeInt16LE(7, 8);   // back sector's tag
        line.writeInt16LE(1, 12);  // back sidedef
        writeFileSync(path.join(scratch, `transfer${special}.bin`), Buffer.concat([front, back, vertices, sides, line]));
    }
    const sim = compileFixture("timed-door-transfer", `package main
import "play"
import "wad"

const closeDoor = readFile("transfer10.bin")
const raiseDoor = readFile("transfer14.bin")
const damage = readFile("transfer5.bin")

map "Doom timed-door floor transfer" {
    tick {
        source := closeDoor
        if currentTick() == 1 { source = raiseDoor }
        if currentTick() == 2 { source = damage }
        level := wad.BspLevel{Valid: true, File: source,
            Sectors: wad.Lump{Offset: 0, Count: 2, Valid: true}, Vertices: wad.Lump{Offset: 52, Count: 2, Valid: true},
            Sides: wad.Lump{Offset: 60, Count: 2, Valid: true}, Lines: wad.Lump{Offset: 120, Count: 1, Valid: true}}
        doors := play.LoadTimedDoors(level)
        state := play.CrossLevelSpecial(level, play.LevelSpecials{Doors: doors}, 0)
        changed := state.ApplyTo(level)
        log(level.SectorSpecial(0), doors.Count, state.Floors.Count, changed.LineAt(0).Action,
            changed.SectorSpecial(1), changed.FloorNameAt(1).Low, changed.FloorNameAt(1).High)
    }
}
`);
    for (let tic = 0; tic < 3; tic++) sim.step();
    const flat = Buffer.from("SRCFLAT0");
    const name = [flat.readInt32LE(0), flat.readInt32LE(4)];
    assert.deepEqual(sim.logs.map(row => Array.from(row, Number)), [
        [10, 1, 1, 0, 0, ...name],
        [14, 1, 1, 0, 0, ...name],
        [5, 0, 1, 0, 5, ...name],
    ], "a floor transfer copies the live sector special and flat after timed-door startup");
}

try {
    const observed = traceFletcher();
    const digest = createHash("sha256").update(JSON.stringify(observed)).digest("hex");
    if (values.upstream) {
        const native = runNativePlayerSectorOracle(path.resolve(root, values.upstream), scratch, cases);
        const expected = native.map(row => ({ ...row, actorHealth: row.health }));
        cases.forEach((scenario, index) => {
            const { revision, ...actual } = observed[index];
            assert.deepEqual(actual, expected[index], scenario.name);
            if (scenario.restoreSecret) assert.equal(revision, 1, "clearing a transferred secret revises its floor surface");
        });
        console.log(`Matched ${cases.length} player-sector cases with pinned Doom C. Fletcher SHA-256 ${digest}.`);
    } else {
        assert.equal(digest, "01862bfba212daa1cf257ed8db15e69df60f45c2bf3f41d0e9e4d7b0cd42ff29");
        console.log(`Verified ${cases.length} player-sector cases against the pinned snapshot.`);
    }
    verifyTimedDoorFloorTransfer();
    console.log("Verified two timed-door sector clears and the damaging-sector control through actual floor transfers.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-player-sectors-[^/\\\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
