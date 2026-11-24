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
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-thing-contacts-"));
const unit = 65536;
const flags = { special: 1, solid: 2, shootable: 4, offGrid: 0x10, pickup: 0x800, noClip: 0x1000,
    missile: 0x10000, skull: 0x1000000 };
const settings = { mover: 1, x: 0, y: 0, origin: [-128 * unit, -128 * unit], width: 4, height: 4,
    randomIndex: 0, lineBlocked: false, removePickups: false };

function thing(kind, x, y, extra = {}) {
    const { z = 0, radius = 20, height = 56, momX = 0, momY = 0, momZ = 0, ...other } = extra;
    return { kind, x: x * unit, y: y * unit, z: z * unit, radius: radius * unit, height: height * unit,
        momX: momX * unit, momY: momY * unit, momZ: momZ * unit, target: 0, damage: 0, spawnState: 0,
        flags: flags.solid | flags.shootable, ...other };
}

const player = thing(0, -72, 0, { radius: 16, spawnState: 149, flags: flags.solid | flags.pickup });
const rocket = thing(33, -72, 0, { radius: 11, height: 8, damage: 20, spawnState: 114, flags: flags.missile });
const skull = thing(18, -72, 0, { radius: 16, flags: flags.skull, damage: 3, spawnState: 585, momX: 20, momY: -14, momZ: 4 });
const pickup = (x, y, extra = {}) => thing(45, x, y, { flags: flags.special, ...extra });
const zombie = (x, y, extra = {}) => thing(1, x, y, { spawnState: 174, ...extra });
const test = (name, moving, others, extra = {}) => ({ ...settings, name, ...extra,
    actors: [moving, ...others].map((actor, index) => ({ handle: index + 1, ...actor })) });
const cases = [
    test("own actor pointer does not block", player, [], { x: player.x }),
    test("axis touching at combined radius is clear", player, [zombie(36, 0)]),
    test("Doom square overlap blocks at its diagonal", player, [zombie(35, 35)]),
    test("regular solid thing ignores vertical distance", player, [zombie(0, 0, { z: 120 })]),
    test("shootable-only object does not block regular movement", player, [zombie(0, 0, { flags: flags.shootable })]),
    test("unlinked BLOCKMAP actor is absent", player, [zombie(0, 0, { flags: 2 | flags.offGrid })]),
    test("no-clip skips pickups, solids and lines", { ...player, flags: player.flags | flags.noClip },
        [pickup(0, 0), zombie(0, 0)], { lineBlocked: true }),
    test("non-picker can overlap pickups without touching", { ...player, flags: flags.solid }, [pickup(0, 0)]),
    test("adjacent block searched using MAXRADIUS", player, [zombie(2, 0)], { x: -20 * unit }),
    test("pickup side effects happen before a rejecting line", player, [pickup(-7, -7)], { lineBlocked: true }),
    test("native solid bit survives pickup removal", player, [pickup(-7, -7, { flags: flags.special | flags.solid })],
        { removePickups: true }),
    test("pickup removal resumes successor and block order", player,
        [pickup(-7, -7), pickup(-4, -6), pickup(-4, 2), zombie(4, -6), pickup(4, 6)], { removePickups: true }),
    test("blocked actor stops traversal before later pickup", player, [pickup(0, 7), zombie(0, -5)]),
    test("off-grid lookups do not reject", player, [zombie(-512, -512)], { x: -512 * unit, y: -512 * unit }),
    test("missile clears actor strictly above", { ...rocket, z: 57 * unit }, [zombie(0, 0)]),
    test("missile clears actor strictly below", rocket, [zombie(0, 0, { z: 9 })]),
    test("missile exact overhead boundary hits", { ...rocket, z: 56 * unit }, [zombie(0, 0)], { randomIndex: 255 }),
    test("missile exact underneath boundary hits", rocket, [zombie(0, 0, { z: 8 })]),
    test("missile ignores owner by handle", { ...rocket, target: 2 }, [zombie(0, 0)]),
    test("missile stops without damage on same species", { ...rocket, target: 2 }, [zombie(-100, 0), zombie(0, 0)]),
    test("baron missile cannot damage knight", { ...rocket, target: 2 }, [thing(15, -100, 0), thing(17, 0, 0)]),
    test("knight missile cannot damage baron", { ...rocket, target: 2 }, [thing(17, -100, 0), thing(15, 0, 0)]),
    test("missiles can hit another player", { ...rocket, target: 2 }, [thing(0, -100, 0), thing(0, 0, 0)]),
    test("missile stops on unshootable solid without RNG", rocket, [zombie(0, 0, { flags: flags.solid })]),
    test("missile passes unshootable non-solid pickup", rocket, [pickup(0, 0)]),
    test("skull slam precedes missile height and pickup logic", { ...skull, z: 96 * unit, flags: flags.skull | flags.missile },
        [pickup(0, 0)], { randomIndex: 5 }),
];

function geometry() {
    const lumps = [
        ["Sectors", 1, 26], ["Subsectors", 1, 4], ["Segs", 1, 12],
        ["Lines", 1, 14], ["Sides", 1, 30], ["Vertices", 2, 4],
    ];
    const offsets = new Map();
    let length = 0;
    for (const [name, count, size] of lumps) {
        offsets.set(name, length);
        length += count * size;
    }
    const base = Buffer.alloc(length);
    base.writeInt16LE(128, offsets.get("Sectors") + 2);
    base.writeUInt16LE(1, offsets.get("Subsectors"));
    base.writeUInt16LE(1, offsets.get("Lines") + 2);
    base.writeUInt16LE(0xffff, offsets.get("Lines") + 12);
    base.writeInt16LE(256, offsets.get("Vertices") + 2);
    base.writeInt16LE(-256, offsets.get("Vertices") + 6);
    function blocks(closed) {
        const cells = settings.width * settings.height;
        const lump = Buffer.alloc((4 + cells + (closed ? 2 : 1)) * 2);
        lump.writeInt16LE(settings.origin[0] / unit);
        lump.writeInt16LE(settings.origin[1] / unit, 2);
        lump.writeUInt16LE(settings.width, 4);
        lump.writeUInt16LE(settings.height, 6);
        for (let cell = 0; cell < cells; cell++) lump.writeUInt16LE(4 + cells, 8 + cell * 2);
        lump.writeInt16LE(-1, lump.length - 2);
        return lump;
    }
    const open = blocks(false), closed = blocks(true);
    writeFileSync(path.join(scratch, "MAP.BIN"), Buffer.concat([base, open, closed]));
    return {
        fields: lumps.map(([name, count]) =>
            `        ${name}: wad.Lump{Offset: ${offsets.get(name)}, Count: ${count}, Valid: true},`).join("\n"),
        blockLumps: `const Open = ${length}
const Closed = ${length + open.length}`,
        openLength: open.length,
        closedLength: closed.length,
    };
}

function fletcherCase({ actors, x, y, randomIndex, lineBlocked, removePickups }, index) {
    const roster = actors.map(actor => `            actors = actors.AppendActor(play.LevelActor{
                Valid: true, Kind: ${actor.kind}, Target: ${actor.target}, Physics: play.ActorPhysics{
                    MomentumX: ${actor.momX}, MomentumY: ${actor.momY}, MomentumZ: ${actor.momZ},
                    Body: play.MapActor{X: ${actor.x}, Y: ${actor.y}, Z: ${actor.z},
                        Radius: ${actor.radius}, Height: ${actor.height}, Flags: ${actor.flags}},
                },
            })`);
    return `        case ${index}:
            x, y, random.GameplayIndex, closed, removePickups = ${x}, ${y}, ${randomIndex}, ${lineBlocked}, ${removePickups}
${roster.join("\n")}`;
}

function traceFletcher() {
    const fixture = geometry();
    const source = path.join(scratch, "main.flt");
    const output = path.join(scratch, "result.json");
    writeFileSync(source, `package main
import "play"
import "wad"
const Geometry = readFile("MAP.BIN")
${fixture.blockLumps}
func level(closed bit) wad.BspLevel {
    blocks := wad.Lump{Offset: Open, Count: ${fixture.openLength}, Valid: true}
    if closed { blocks = wad.Lump{Offset: Closed, Count: ${fixture.closedLength}, Valid: true} }
    return wad.BspLevel{File: Geometry, Valid: true, BlockMap: blocks, Nodes: wad.Lump{Valid: true},
${fixture.fields}
    }
}
func playerContactWorld(blocks wad.BlockMapInfo, closed bit) play.PlayerContacts {
    moving := play.LevelActor{Valid: true, Health: 100, Kind: 0, Physics: play.ActorPhysics{
        MomentumX: 8 << 16, Body: play.MapActor{X: -20 << 16, Player: true, Radius: 16 << 16, Height: 56 << 16,
            Ceiling: 128 << 16, Flags: play.ActorSolid | play.ActorPickup},
    }}
    obstacle := play.LevelActor{Valid: true, Health: 20, Kind: 30, Physics: play.ActorPhysics{
        Body: play.MapActor{X: 20 << 16, Radius: 20 << 16, Height: 42 << 16, Flags: play.ActorSolid},
    }}
    if closed {
        obstacle.Kind, obstacle.Sprite = 45, 60
        obstacle.Physics.Body.X, obstacle.Physics.Body.Flags = -5 << 16, play.ActorSpecial | play.ActorCountItem
    }
    actors := play.MapActors{}.AppendActor(moving).AppendActor(obstacle)
    return play.PlayerContacts{Handle: 1, Actors: actors, Links: play.BuildActorLinks(actors, blocks),
        Inventory: play.NewPlayerInventory(100), Rules: play.PickupRules{Skill: 2}}
}
map "Thing contact parity" {
    tick {
        if currentTick() >= ${cases.length} {
            closed := currentTick() == ${cases.length}
            scene := level(closed)
            blocks := wad.LoadBlockMap(scene)
            contacts := playerContactWorld(blocks, closed)
            move := play.MovePlayerWithContacts(scene, blocks, contacts.Actors.ActorAt(0).Physics,
                play.PlayerMoveCommand{}, play.LevelSpecials{}, contacts)
            log(move.Valid, move.Actor.Body.X, move.Contacts.Inventory.Health, move.Contacts.Inventory.ItemCount,
                move.Contacts.Actors.ActorAt(1).Valid, move.Contacts.Removed)
        } else {
        var actors play.MapActors
        var random play.RandomState
        var closed bit
        var removePickups bit
        x, y := 0, 0
        switch currentTick() {
${cases.map(fletcherCase).join("\n")}
        }
        scene := level(closed)
        blocks := wad.LoadBlockMap(scene)
        links := play.BuildActorLinks(actors, blocks)
        moving := actors.ActorAt(0)
        scan := play.BeginThingScan(blocks, moving.Physics.Body, x, y)
        for range actors.Count + 1 {
            if !scan.Done {
                step := play.ScanThingContacts(scan, actors, links, moving, 1, random)
                scan, random = step.Scan, step.Random
                match := step.Contact
                if match.Action == play.ContactTouch {
                    log(1, match.Target, 1)
                    if removePickups { links = links.UnlinkActor(match.Target) }
                } else if match.Action == play.ContactDamage || match.Action == play.ContactSkull {
                    log(2, match.Target, 1, match.Source, match.Damage)
                    if match.Action == play.ContactSkull {
                        moving.Physics.Body.Flags = moving.Physics.Body.Flags & ~bits<32>(play.MoveSkullFly)
                        moving.Physics.MomentumX, moving.Physics.MomentumY, moving.Physics.MomentumZ = 0, 0, 0
                        log(3, 1, match.ResetState)
                    }
                }
            }
        }
        position := play.BeginMapPositionCheck(scene, blocks, moving.Physics.Body, x, y)
        position.Clear = position.Clear && scan.Done && !scan.Blocked
        position = play.FinishMapPositionCheck(scene, blocks, moving.Physics.Body, x, y, position)
        log(0, position.Clear, random.GameplayIndex, moving.Physics.Body.Flags,
            moving.Physics.MomentumX, moving.Physics.MomentumY, moving.Physics.MomentumZ)
        }
    }
}
`);
    const result = spawnSync("dotnet", [cli, "build", source, "--package-root", port, "--asset-root", scratch, "-o", output],
        { encoding: "utf8", cwd: root, timeout: 25000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    const observed = cases.map(({ name }) => {
        const start = sim.logs.length;
        sim.step();
        const rows = Array.from(sim.logs.slice(start), row => Array.from(row, Number));
        assert.equal(rows.at(-1)?.[0], 0, name);
        return rows;
    });
    const start = sim.logs.length;
    sim.step();
    sim.step();
    assert.deepEqual(Array.from(sim.logs.slice(start), row => Array.from(row)), [
        [true, -16.25 * unit, 101, 1, false, true], // The slide stops short of the wall and retains the pickup.
        [true, -20 * unit, 100, 0, true, false], // Solid actor blocks the otherwise open move.
    ]);
    return observed;
}

const digest = trace => createHash("sha256").update(JSON.stringify(trace)).digest("hex");
try {
    const observed = traceFletcher();
    if (values.upstream) {
        const { runNativeContactOracle } = await import("./doom-native-contact-oracle.mjs");
        const native = runNativeContactOracle(path.resolve(root, values.upstream), scratch, cases);
        for (const [index, { name }] of cases.entries()) assert.deepEqual(observed[index], native[index], name);
        console.log(`Matched ${native.length} thing contact cases with pinned Linux Doom C. SHA-256 ${digest(native)}.`);
    } else {
        assert.equal(digest(observed), "692285d5c7dc7765de37978343e7aa0ac13db08ed41399921e915891c034ca38");
        console.log(`Verified ${observed.length} thing contact cases against the pinned C snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-thing-contacts-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
