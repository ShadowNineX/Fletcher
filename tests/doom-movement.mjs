import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const oracle = process.argv[3] ? path.resolve(root, process.argv[3]) : null;
const denseOracle = process.argv[4] ? path.resolve(root, process.argv[4]) : null;
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-movement-"));

const vertices = [[0, -64], [0, 64], [6, -64], [6, 64], [128, -64], [128, 64], [256, -64], [256, 64],
    [-128, -64], [384, -64], [-64, 32], [96, 32], [-64, -32], [96, -32]];
const sectors = [[0, 128], [24, 112], [49, 120], [-16, 128]];
// Two portals with actions lie within one radius of each other. Line 1 has
// the same sector on both sides. The BLOCKMAP repeats it in multiple cells.
const lines = [[0, 1, 4, 101, 1, 0], [2, 3, 4, 102, 1, 1], [4, 5, 4, 103, 2, 1], [6, 7, 4, 104, 3, 2],
    [8, 9, 0, 0, 0, -1], [10, 11, 5, 0, 1, 1], [12, 13, 6, 0, 1, 1]];
const nodes = [[0, 0, 0, 1, 0x8001, 0x8000], [256, 0, 0, 1, 0x8003, 0x8002], [128, 0, 0, 1, 1, 0]];
const leaves = [[0, 1], [0, 0], [2, 0], [3, 0]];
const blocks = [
    [0, 1, 4, 5, 6], [0, 1, 1, 2, 4, 5, 6], [0, 2, 3, 4], [0, 3, 4],
    [0], [0, 1, 2], [0, 2, 3], [0, 3],
];
const width = 4, height = 2, originX = -128, originY = -64;
const stockGeometry = { vertices, sectors, lines, nodes, leaves, blocks, width, height, originX, originY };

const dropoff = 0x400, noclip = 0x1000, float = 0x4000, teleport = 0x8000, missile = 0x10000;
const scenarios = [
    [ "advance over a 24-unit step and dispatch both actions in reverse order",
        [-12, 0, 0, 16, 56, 0, 1, 9, 0], [1, 1, 24, 112, 0, -1, 9, 0, 0, 2, 1, 1, 0, 1] ],
    [ "reverse through the same two lines",
        [9, 0, 24, 16, 56, 0, 1, -9, 0], [1, 1, 24, 112, 0, 0, -9, 0, 24, 2, 1, 0, 0, 0] ],
    [ "touching a wall edge exactly leaves the opening unchecked",
        [-20, 0, 0, 16, 56, 0, 1, -16, 0], [1, 1, 0, 128, 0, -1, -16, 0, 0, 0] ],
    [ "straddling an action line without crossing it leaves the trace empty",
        [-20, 0, 0, 16, 56, 0, 1, -15, 0], [1, 1, 24, 112, 0, 0, -15, 0, 0, 0] ],
    [ "reject an actor one unit too high, with vertical adjustment possible",
        [60, 0, 57, 16, 56, 0, 1, 70, 0], [0, 1, 24, 112, 24, -1, 60, 0, 57, 0] ],
    [ "accept exact vertical clearance",
        [60, 0, 56, 16, 56, 0, 1, 70, 0], [1, 1, 24, 112, 24, -1, 70, 0, 56, 0] ],
    [ "reject a sector shorter than the actor",
        [60, 0, 24, 16, 89, 0, 1, 70, 0], [0, 0, 24, 112, 24, -1, 60, 0, 24, 0] ],
    [ "reject a 25-unit step even with dropoff enabled",
        [120, 0, 24, 16, 56, dropoff, 1, 132, 0], [0, 1, 49, 112, 24, 2, 120, 0, 24, 0] ],
    [ "teleport bypasses the step check and suppresses actions",
        [120, 0, 24, 16, 56, teleport | dropoff, 1, 132, 0], [1, 1, 49, 112, 24, 2, 132, 0, 24, 0] ],
    [ "teleport alone still checks dropoff",
        [120, 0, 24, 16, 56, teleport, 1, 132, 0], [0, 1, 49, 112, 24, 2, 120, 0, 24, 0] ],
    [ "reject a ledge with a 65-unit dropoff",
        [252, 0, 49, 16, 56, 0, 0, 264, 0], [0, 1, 49, 120, -16, 3, 252, 0, 49, 0] ],
    [ "allow the ledge for dropoff actors",
        [252, 0, 49, 16, 56, dropoff, 0, 264, 0], [1, 1, 49, 120, -16, 3, 264, 0, 49, 1, 3, 1] ],
    [ "allow the ledge for floating actors",
        [252, 0, 49, 16, 56, float, 0, 264, 0], [1, 1, 49, 120, -16, 3, 264, 0, 49, 1, 3, 1] ],
    [ "respect ML_BLOCKING for players",
        [60, 20, 24, 16, 56, 0, 1, 60, 30], [0, 0, 24, 112, 24, -1, 60, 20, 24, 0] ],
    [ "missiles ignore ML_BLOCKING on a two-sided line",
        [60, 20, 24, 16, 56, missile, 0, 60, 30], [1, 1, 24, 112, 24, -1, 60, 30, 24, 0] ],
    [ "players ignore ML_BLOCKMONSTERS",
        [60, -20, 24, 16, 56, 0, 1, 60, -30], [1, 1, 24, 112, 24, -1, 60, -30, 24, 0] ],
    [ "monsters respect ML_BLOCKMONSTERS",
        [60, -20, 24, 16, 56, 0, 0, 60, -30], [0, 0, 24, 112, 24, -1, 60, -20, 24, 0] ],
    [ "one-sided walls block even missiles and span an out-of-range cell",
        [60, -45, 24, 16, 56, missile, 0, 60, -60], [0, 0, 24, 112, 24, -1, 60, -45, 24, 0] ],
    [ "noclip bypasses a one-sided wall",
        [60, -45, 24, 16, 56, noclip, 1, 60, -60], [1, 0, 24, 112, 24, -1, 60, -60, 24, 0] ],
    [ "noclip uses the destination sector heights and skips line actions",
        [120, 0, 99, 16, 56, noclip, 1, 132, 0], [1, 0, 49, 120, 49, -1, 132, 0, 99, 0] ],
    [ "a move ending its radius flush with a dropoff tests the base sector",
        [252, 0, 49, 16, 56, 0, 1, 272, 0], [1, 1, -16, 128, -16, -1, 272, 0, 49, 0] ],
    [ "axis equality selects the original BSP and linedef side",
        [9, 0, 24, 16, 56, 0, 1, 0, 0], [1, 1, 24, 112, 0, 0, 0, 0, 24, 2, 1, 0, 0, 0] ],
];

const specials = Array.from({ length: 68 }, (_, i) => i + 1);
const encountered = [0, 1, ...specials.slice(1).reverse(), 69];
const crossingLines = encountered.filter(index => index > 0 && index < 69).reverse();
const denseGeometry = {
    vertices: [240, 4, 13, 17, 25, 31].flatMap(x => [[x, -96], [x, 96]]),
    sectors: [[0, 128]],
    lines: [
        [0, 1, 4, 0, 0, 0],
        ...specials.map((index, i) => {
            const first = (1 + Math.floor(i / 17)) * 2;
            return [first, first + 1, 4, index === 1 ? 52 : 48, 0, 0];
        }),
        [10, 11, 4, 48, 0, 0],
    ],
    nodes: [], leaves: [[0, 0]], width: 2, height: 2, originX: -128, originY: -128,
    blocks: [[...encountered, 1, 69], [...encountered].reverse(), encountered, encountered],
};
const denseCases = [
    ["forward through a dense set of contacts", [0, 0, 0, 32, 56, 0, 1, 30, 0],
        [1, 1, 0, 128, 0, -1, 30, 0, 0, 68, ...crossingLines.flatMap(index => [index, 1])]],
    ["reverse through the same dense set", [30, 0, 0, 32, 56, 0, 1, 0, 0],
        [1, 1, 0, 128, 0, -1, 0, 0, 0, 68, ...crossingLines.flatMap(index => [index, 0])]],
    ["teleport through dense contacts without dispatching them", [0, 0, 0, 32, 56, teleport, 1, 30, 0],
        [1, 1, 0, 128, 0, -1, 30, 0, 0, 0]],
];

function words(values) {
    const buffer = Buffer.alloc(values.length * 2);
    for (const [i, value] of values.entries()) buffer.writeUInt16LE(value & 0xffff, i * 2);
    return buffer;
}

function fixture({ vertices, sectors, lines, nodes, leaves, blocks, width, height, originX, originY }) {
    const sides = [];
    const linedefs = lines.map(([a, b, flags, action, front, back]) => {
        const first = sides.length;
        sides.push(Buffer.concat([Buffer.alloc(28), words([front])]));
        if (back >= 0) sides.push(Buffer.concat([Buffer.alloc(28), words([back])]));
        return words([a, b, flags, action, 0, first, back < 0 ? -1 : first + 1]);
    });
    const segs = leaves.map(([index, side]) => {
        const [a, b] = lines[index];
        return words([side === 0 ? a : b, side === 0 ? b : a, 0, index, side, 0]);
    });
    const blockHeader = [originX, originY, width, height];
    const blockLists = [];
    for (const list of blocks) {
        blockHeader.push(4 + blocks.length + blockLists.length);
        blockLists.push(...list, -1);
    }

    const lumps = [
        ["MAP01", Buffer.alloc(0)], ["THINGS", words([-12, 0, 0, 1, 7])],
        ["LINEDEFS", Buffer.concat(linedefs)], ["SIDEDEFS", Buffer.concat(sides)], ["VERTEXES", words(vertices.flat())],
        ["SEGS", Buffer.concat(segs)], ["SSECTORS", words(leaves.flatMap((_, i) => [1, i]))],
        ["NODES", words(nodes.flatMap(([x, y, dx, dy, front, back]) => [x, y, dx, dy, 64, -64, -128, 384, 64, -64, -128, 384, front, back]))],
        ["SECTORS", Buffer.concat(sectors.map(([floor, ceiling]) => Buffer.concat([words([floor, ceiling]), Buffer.alloc(22)])))],
        ["REJECT", Buffer.alloc(2)], ["BLOCKMAP", words([...blockHeader, ...blockLists])],
    ];
    const directory = 12 + lumps.reduce((length, [, data]) => length + data.length, 0);
    const wad = Buffer.alloc(directory + lumps.length * 16);
    wad.write("PWAD");
    wad.writeUInt32LE(lumps.length, 4);
    wad.writeUInt32LE(directory, 8);
    let offset = 12;
    for (const [i, [name, data]] of lumps.entries()) {
        const entry = directory + i * 16;
        wad.writeUInt32LE(offset, entry);
        wad.writeUInt32LE(data.length, entry + 4);
        wad.write(name, entry + 8);
        data.copy(wad, offset);
        offset += data.length;
    }
    return wad;
}

const source = `package main

import "play"
import "wad"

const Archive = readFile("LEVEL.WAD")
const Dense = readFile("DENSE.WAD")
const CaseCount = ${scenarios.length}
const Cases = [CaseCount][9]int{
    ${scenarios.map(([, args]) => `[9]int{${args.join(", ")}}`).join(",\n    ")},
}
const DenseCases = [${denseCases.length}][9]int{
    ${denseCases.map(([, args]) => `[9]int{${args.join(", ")}}`).join(",\n    ")},
}

map "Doom terrain movement parity" {
    tick {
        index := currentTick()
        level := wad.LoadBspLevel(Archive, wad.LE32(Archive, 8))
        if index < CaseCount || (index >= CaseCount + 3 && index < CaseCount + 3 + ${denseCases.length}) {
            var args [9]int
            if index < CaseCount { args = Cases[index] } else {
                level = wad.LoadBspLevel(Dense, wad.LE32(Dense, 8))
                args = DenseCases[index - CaseCount - 3]
            }
            actor := play.MapActor{X: args[0] << 16, Y: args[1] << 16, Z: args[2] << 16,
                Radius: args[3] << 16, Height: args[4] << 16, Flags: bits<32>(args[5]), Player: args[6] != 0}
            move := play.TryMapMove(level, wad.LoadBlockMap(level), actor, args[7] << 16, args[8] << 16)
            check := move.Position
            log(check.Valid, move.Allowed, move.FloatOK, check.Floor >> 16, check.Ceiling >> 16,
                check.Dropoff >> 16, check.CeilingLine, move.Actor.X >> 16, move.Actor.Y >> 16,
                move.Actor.Z >> 16, move.CrossingCount, move.Actor.Floor >> 16, move.Actor.Ceiling >> 16)
            for i := range move.CrossingCount {
                crossing := move.Crossings.At(i)
                log(crossing.Line, crossing.OldSide)
            }
        } else if index == CaseCount {
            // Keep the final block list within the lump but remove its terminator.
            level.BlockMap.Count = level.BlockMap.Count - 2
            actor := play.MapActor{Radius: 16 << 16, Height: 56 << 16}
            check := play.CheckMapPosition(level, wad.LoadBlockMap(level), actor, 300 << 16, 70 << 16)
            log(check.Valid, check.Clear)
        } else if index == CaseCount + 1 {
            level.Lines.Count = 6
            actor := play.MapActor{Radius: 16 << 16, Height: 56 << 16}
            check := play.CheckMapPosition(level, wad.LoadBlockMap(level), actor, 60 << 16, 0)
            log(check.Valid, check.Clear)
        } else if index == CaseCount + 2 {
            level.Nodes.Count = level.Nodes.Count + 1000
            log(level.SectorAtPoint(9 << 16, 0).Valid, level.SubsectorSector(0).Index)
        } else if index == CaseCount + 3 + ${denseCases.length} {
            scene := wad.LoadBspLevel(Dense, wad.LE32(Dense, 8))
            blocks := wad.LoadBlockMap(scene)
            physics := play.ActorPhysics{MomentumX: 30 << 16, Body: play.MapActor{Player: true, Radius: 32 << 16,
                Height: 56 << 16, Ceiling: 128 << 16, Flags: play.ActorSolid | play.ActorPickup}}
            actor := play.LevelActor{Valid: true, Health: 100, Physics: physics}
            actors := play.MapActors{}.AppendActor(actor)
            player := play.PlayerContacts{Handle: 1, Actors: actors, Links: play.BuildActorLinks(actors, blocks),
                Inventory: play.NewPlayerInventory(100)}
            move := play.MovePlayerWithContacts(scene, blocks, physics, play.PlayerMoveCommand{}, play.LevelSpecials{}, player)
            log(move.Valid, move.Actor.Body.X >> 16, move.CrossingCount, move.ExitRequested, move.SecretExit,
                move.Contacts.Actors.ActorAt(0).Physics.Body.X >> 16, move.Contacts.Links.BlockFirst(1, 1))
            for i := range move.CrossingCount {
                crossing := move.Crossings.At(i)
                log(crossing.Line, crossing.OldSide)
            }
        }
    }
}
`;

function readTrace(sim, [name, , expected]) {
    const first = sim.logs.length;
    sim.step();
    const [header, ...crossings] = sim.logs.slice(first);
    assert.equal(header?.[0], true, name);
    const [,, floor, ceiling] = expected;
    assert.deepEqual(Array.from(header.slice(-2)), expected[0] ? [floor, ceiling] : [0, 0], name);
    const trace = [...Array.from(header.slice(1, -2), Number), ...crossings.flatMap(pair => Array.from(pair))];
    assert.deepEqual(trace, expected, name);
    return trace;
}

function compareNative(executable, geometry, cases, traces) {
    const { vertices, sectors, lines, nodes, leaves, blocks, width, height, originX, originY } = geometry;
    const input = [
        vertices.length, sectors.length, lines.length, nodes.length, leaves.length, width, height, originX, originY,
        ...vertices.flat(), ...sectors.flat(), ...lines.flat(), ...nodes.flat(),
        ...leaves.map(([line, side]) => lines[line][4 + side]),
        ...blocks.flatMap(block => [block.length, ...block]),
        cases.length, ...cases.flatMap(([, args]) => args),
    ].join(" ");
    const native = spawnSync(executable, { input, encoding: "utf8", timeout: 5000, cwd: scratch });
    if (native.error) throw native.error;
    assert.equal(native.status, 0, native.stderr);
    const reference = native.stdout.trim().split(/\r?\n/).map(row => row.trim().split(/\s+/).map(Number));
    assert.deepEqual(traces, reference, "terrain, step and ordered special-line traces must match pinned Doom C");
}

try {
    writeFileSync(path.join(scratch, "LEVEL.WAD"), fixture(stockGeometry));
    writeFileSync(path.join(scratch, "DENSE.WAD"), fixture(denseGeometry));
    const main = path.join(scratch, "main.flt");
    const output = path.join(scratch, "map.json");
    writeFileSync(main, source);
    const build = spawnSync("dotnet", [cli, "build", main, "--package-root", port, "--asset-root", scratch, "-o", output], {
        encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (build.error) throw build.error;
    assert.equal(build.status, 0, build.stderr);
    const map = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(Buffer.from(map.data, "base64")[2], 1, "the WAD is in the compressed map");
    const sim = simulator(decode(map.data));
    const traces = scenarios.map(test => readTrace(sim, test));
    for (const expected of [[false, false], [false, false], [false, 0]]) {
        sim.step();
        assert.deepEqual(Array.from(sim.logs.at(-1)), expected);
    }

    const denseTraces = denseCases.map(test => readTrace(sim, test));
    const start = sim.logs.length;
    sim.step();
    const [state, ...walked] = Array.from(sim.logs.slice(start), row => Array.from(row));
    assert.deepEqual(state, [true, 30, 68, true, false, 30, 1], "the linked player completes both substeps and reaches the exit");
    const firstStep = crossingLines.filter(index => index <= 34);
    const secondStep = crossingLines.filter(index => index > 34);
    assert.deepEqual(walked, [...firstStep, ...secondStep].map(index => [index, 1]), "walkovers retain per-substep reverse order");

    if (oracle) compareNative(oracle, stockGeometry, scenarios, traces);
    if (denseOracle) compareNative(denseOracle, denseGeometry, denseCases, denseTraces);
    console.log(`Doom terrain movement passed ${scenarios.length} scenarios and malformed WAD checks.`);
    console.log(`Doom dense movement passed ${denseTraces.length} traces and a linked player crossing 68 special lines over two substeps.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-movement-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
