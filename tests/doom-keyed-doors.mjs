import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runNativeKeyedDoorOracle } from "./doom-native-keyed-door-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-keyed-doors-"));

const kinds = [[26, 0], [27, 1], [28, 2], [32, 0], [33, 2], [34, 1],
    [99, 0], [133, 0], [134, 2], [135, 2], [136, 1], [137, 1]];
const fixture = (name, special, options = {}) => ({ name, special, ...options });
const cases = [
    ...[1, 31, 117, 118].flatMap(special => [
        fixture(`manual ${special} starts from idle`, special),
        fixture(`manual ${special} refuses back use`, special, { back: true }),
        fixture(`manual ${special} responds to ordinary monster use`, special, { player: false }),
        ...[-1, 0, 1].map(busy => fixture(`manual ${special} responds to a door in direction ${busy}`, special, { busy })),
    ]),
    fixture("an ordinary monster reopens a closing door", 1, { player: false, busy: -1 }),
    fixture("an ordinary monster leaves a waiting door open", 1, { player: false, busy: 0 }),
    fixture("an ordinary monster leaves an opening door alone", 1, { player: false, busy: 1 }),
    fixture("an ordinary monster cannot use a secret manual door", 1, { player: false, secretLine: true }),
    fixture("a player can use a secret manual door", 1, { secretLine: true }),
    ...kinds.flatMap(([special, key]) => [
        fixture(`${special} with no key`, special),
        fixture(`${special} with another color`, special, { keys: 1 << ((key + 1) % 3) }),
        fixture(`${special} with its card`, special, { keys: 1 << key }),
        fixture(`${special} with its skull`, special, { keys: 1 << (key + 3) }),
    ]),
    fixture("closing manual door reverses with the key", 26, { busy: -1, keys: 1 }),
    fixture("opening manual door reverses with the key", 27, { busy: 1, keys: 1 << 1 }),
    fixture("waiting manual door reverses with the skull", 28, { busy: 0, keys: 1 << 5 }),
    fixture("manual door preserves its closing direction without the key", 26, { busy: -1 }),
    fixture("keyed open-stay adds a new thinker beside the active door", 32, { busy: -1, keys: 1 << 3 }),
    fixture("open-stay adds a thinker even when the active door is waiting", 33, { busy: 0, keys: 1 << 2 }),
    fixture("tagged one-shot stays armed when its sector is busy", 133, { busy: 1, keys: 1 }),
    fixture("tagged button stays released when its sector is busy", 99, { busy: -1, keys: 1 }),
    fixture("tagged switch reports a missing key before the busy-sector check", 137, { busy: -1 }),
    fixture("tagged switch stays armed when nothing matches the tag", 135, { tag: 77, keys: 1 << 5 }),
    fixture("tagged switch consumes even when no texture matches", 137, { texture: false, keys: 1 << 4 }),
    fixture("tagged button opens even when no texture matches", 99, { texture: false, keys: 1 }),
    fixture("back use cannot trigger a manual lock", 26, { back: true }),
    fixture("back use cannot trigger a tagged lock", 137, { back: true, keys: 1 << 1 }),
    fixture("player can use a secret keyed door", 26, { secretLine: true, keys: 1 }),
    fixture("monster use refuses keyed raise", 26, { player: false }),
    fixture("monster use reports success on locked manual open without opening", 32, { player: false }),
    fixture("monster cannot use a secret locked door", 32, { player: false, secretLine: true }),
    fixture("monster cannot use a keyed switch", 133, { player: false }),
    fixture("normal exit switch clears an earlier secret choice", 11, { priorSecret: true }),
    fixture("exit switch consumes without a matching texture", 11, { texture: false }),
    fixture("back use cannot activate a normal exit", 11, { back: true }),
    fixture("episode secret exit switch", 51),
    fixture("commercial secret exit switch falls back without MAP31", 51, { commercial: true, priorSecret: true }),
    fixture("commercial secret exit switch with MAP31", 51, { commercial: true, map31: true }),
    fixture("monster cannot activate an exit switch", 51, { player: false }),
    fixture("normal walkover exit leaves its action in place", 52, { crossing: true }),
    fixture("normal walkover exit accepts the back crossing", 52, { crossing: true, back: true }),
    fixture("commercial secret walkover with MAP31", 124, { crossing: true, commercial: true, map31: true }),
    fixture("commercial secret walkover falls back without MAP31", 124, { crossing: true, commercial: true }),
    fixture("monster cannot trigger a secret exit crossing", 124, { crossing: true, player: false }),
];

function words(entries) {
    const bytes = Buffer.alloc(entries.length * 2);
    entries.forEach((value, i) => bytes.writeUInt16LE(value & 65535, i * 2));
    return bytes;
}

function lumpName(name) {
    const bytes = Buffer.alloc(8);
    bytes.write(name);
    return `wad.LumpName{Low: ${bytes.readInt32LE(0)}, High: ${bytes.readInt32LE(4)}}`;
}

function mapFixture({ special, secretLine = false, tag = 7, commercial = false, map31 = false, texture = true }) {
    const tex = Buffer.alloc(82);
    tex.writeInt32LE(3);
    for (const [i, name] of ["DUMMY", "SW1BRCOM", "SW2BRCOM"].entries()) {
        const offset = 16 + 22 * i;
        tex.writeInt32LE(offset, 4 + 4 * i);
        tex.write(name, offset);
        tex.writeInt16LE(16, offset + 12);
        tex.writeInt16LE(16, offset + 14);
    }
    const sides = Buffer.alloc(60), sectors = Buffer.alloc(52);
    if (texture) sides.write("SW1BRCOM", 20);
    sides.writeUInt16LE(1, 58);
    sectors.writeInt16LE(128, 2);
    sectors.writeInt16LE(16, 28);
    sectors.writeInt16LE(7, 50);
    const map = commercial ? "MAP15" : "E1M3";
    const lumps = [[map, Buffer.alloc(0)], ["LINEDEFS", words([0, 1, 4 | (secretLine ? 32 : 0), special, tag, 0, 1])],
        ["SIDEDEFS", sides], ["VERTEXES", words([0, 64, 0, -64])], ["SECTORS", sectors], ["PNAMES", Buffer.alloc(4)], ["TEXTURE1", tex]];
    if (map31) lumps.push(["MAP31", Buffer.alloc(0)]);
    const directory = 12 + lumps.reduce((length, [, bytes]) => length + bytes.length, 0);
    const data = Buffer.alloc(directory + 16 * lumps.length), offsets = {};
    data.write("PWAD");
    data.writeInt32LE(lumps.length, 4);
    data.writeInt32LE(directory, 8);
    let offset = 12;
    for (const [i, [name, bytes]] of lumps.entries()) {
        const entry = directory + 16 * i;
        offsets[name] = offset;
        data.writeInt32LE(offset, entry);
        data.writeInt32LE(bytes.length, entry + 4);
        data.write(name, entry + 8);
        bytes.copy(data, offset);
        offset += bytes.length;
    }
    return { data, offsets, map };
}

function entrySource() {
    const sources = [], arms = [];
    for (const [index, scenario] of cases.entries()) {
        const { data, offsets, map } = mapFixture(scenario);
        writeFileSync(path.join(scratch, `case${index}.wad`), data);
        sources.push(`const wad${index} = readFile("case${index}.wad")`);
        const { keys = 0, player = true, back = false, busy = 9, crossing = false, priorSecret = false } = scenario;
        const cards = Array.from({ length: 6 }, (_, i) => Boolean(keys & (1 << i)));
        arms.push(`        case ${index}:
            level = wad.BspLevel{Valid: true, File: wad${index}, MapName: ${lumpName(map)},
                Lines: wad.Lump{Offset: ${offsets.LINEDEFS}, Count: 1, Valid: true},
                Sides: wad.Lump{Offset: ${offsets.SIDEDEFS}, Count: 2, Valid: true},
                Vertices: wad.Lump{Offset: ${offsets.VERTEXES}, Count: 2, Valid: true},
                Sectors: wad.Lump{Offset: ${offsets.SECTORS}, Count: 2, Valid: true}}
            inventory.Cards = [6]bit{${cards}}
            player, back, crossing = ${player}, ${back}, ${crossing}
            busy, state.SecretExit = ${busy}, ${priorSecret}`);
    }
    return template.replace("@WADS@", sources.join("\n")).replace("@CASES@", arms.join("\n")).replace("@SWITCH@", lumpName("SW2BRCOM"));
}

const template = `package main
import "play"
import "wad"

@WADS@

map "Doom manual and keyed doors and exits" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        var level wad.BspLevel
        var state play.LevelSpecials
        var inventory play.PlayerInventory
        player, back, crossing, busy := true, false, false, 9
        switch currentTick() {
@CASES@
        }
        if busy != 9 {
            door := play.OpenManualDoor(1, 16 * 65536, 0, 128 * 65536)
            door.Direction, door.Countdown = busy, 27
            state.Doors = state.Doors.Append(play.SectorDoor{Sector: 1, State: door})
            state.Doors.NextMover = 1
        }
        var use play.ActorLineUse
        if crossing {
            world := play.CombatWorld{}
            world.Actors = world.Actors.AppendActor(play.LevelActor{Valid: true, Kind: 11, Physics: play.ActorPhysics{Body: play.MapActor{Player: player}}})
            side := 0
            if back { side = 1 }
            crossed := play.CrossActorLine(wad.BlockMapInfo{}, play.WalkoverState{Level: level, Specials: state, World: world},
                1, play.SpecialCrossing{Line: 0, OldSide: side}, play.CombatRules{}, play.DefaultWalkoverTelefrag{})
            use.State = crossed.Specials
        } else { use = play.UseActorLine(level, state, 0, back, player, inventory) }
        state = use.State
        changed := state.ApplyTo(level)
        denied := 0
        if use.MissingKey {
            denied = use.Key + 1
            if use.TaggedLock { denied = denied + 3 }
        }
        button := 0
        if state.Doors.Switches.ButtonCount > 0 { button = state.Doors.Switches.Buttons[0].Tics }
        line := changed.LineAt(0)
        log(10, use.Used, denied, use.Sound, line.Action, wad.SameLumpName(changed.SideMaterialAt(changed.LineFrontSide(0)).Middle, @SWITCH@),
            button, state.ExitRequested, state.SecretExit)
        handle := state.Doors.First()
        for range state.Doors.Count {
            door := state.Doors.EntryAt(handle)
            log(11, door.Sector, door.State.Mode, door.State.Direction, door.State.Speed, door.State.Top, door.State.TopWait, door.State.Countdown)
            handle = state.Doors.Following(handle)
        }
        log(99, currentTick())
    }
}
`;

function traceFletcher() {
    const entry = path.join(scratch, "keyed.flt"), output = path.join(scratch, "keyed.json");
    writeFileSync(entry, entrySource());
    const built = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (built.error) throw built.error;
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    const sim = simulator(decode(encoded), true);
    return cases.map((scenario, index) => {
        const before = sim.logs.length;
        for (let host = 0; host < 96 && sim.logs.length === before; host++) sim.step();
        const rows = Array.from(sim.logs.slice(before), row => Array.from(row, Number));
        assert.deepEqual(rows.pop(), [99, index], scenario.name);
        const [tag, used, denied, grunt, special, switchOn, button, exit, secret] = rows.shift();
        assert.equal(tag, 10);
        const doors = rows.map(([marker, ...door]) => { assert.equal(marker, 11); return door; });
        return { used, denied, grunt, special, switchOn, button, exit: [exit, secret], doors };
    });
}

try {
    const observed = traceFletcher();
    const digest = createHash("sha256").update(JSON.stringify(observed)).digest("hex");
    if (values.upstream) {
        const native = runNativeKeyedDoorOracle(path.resolve(root, values.upstream), scratch, cases);
        cases.forEach((scenario, i) => assert.deepEqual(observed[i], native[i], scenario.name));
        console.log(`Matched ${cases.length} manual-door, keyed-door and exit cases with pinned Doom C. Fletcher SHA-256 ${digest}.`);
    } else {
        assert.equal(digest, "b8a7324adffa279848b8613cd29e02831ea141e4cdd3e3fd7b9d24100d38b296");
        console.log(`Verified ${cases.length} manual-door, keyed-door and exit cases against the pinned snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-keyed-doors-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
