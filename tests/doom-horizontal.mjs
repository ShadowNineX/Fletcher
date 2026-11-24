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
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-horizontal-"));
const unit = 0x10000;
const moveMissile = 0x10000, moveSkullFly = 0x1000000, moveCorpse = 0x100000;

const vertices = [[0, -64], [0, 160], [6, -64], [6, 64], [256, -64], [-128, -64],
    [224, 70], [224, 150], [148, -34], [216, 34], [20, 32], [96, 32]];
const sectors = [[0, 128, 0], [24, 112, 1]];
// line = first vertex, last vertex, flags, action, front sector, back sector.
const lines = [[0, 1, 4, 101, 0, 1], [2, 3, 4, 102, 1, 1], [4, 5, 0, 0, 1, -1],
    [6, 7, 0, 0, 1, -1], [8, 9, 0, 0, 1, -1], [10, 11, 5, 0, 1, 1]];
const nodes = [[0, 0, 0, 1, 0x8001, 0x8000]];
const leaves = [[0, 0], [0, 1]];
const blocks = [[0, 2], [0, 1, 2, 5], [0, 2, 4], [0], [0, 1], [0, 3]];
const width = 3, height = 2, originX = -128, originY = -64;

function actorCase({
    x = 48, y = 4, z = 24, floor = 24, ceiling = 112, radius = 16, actorHeight = 56,
    flags = 0, player = 1, mx = 4, my = 0, mz = 0, extraX = 0, extraY = 0,
    forward = 0, side = 0, noMomentum = 0,
} = {}) {
    return [...[x, y, z, floor, ceiling, radius, actorHeight].map(value => value * unit),
        flags, player, mx * unit + extraX, my * unit + extraY, mz * unit, forward, side, noMomentum];
}

const scenarios = [
    ["ground friction", actorCase()],
    ["airborne momentum", actorCase({ z: 25 })],
    ["no-momentum cheat", actorCase({ noMomentum: 1 })],
    ["below stop speed", actorCase({ mx: 0, extraX: 0xfff })],
    ["exact stop-speed boundary", actorCase({ mx: 0, extraX: 0x1000 })],
    ["input preserves small momentum", actorCase({ mx: 0, extraX: 0xfff, side: 1 })],
    ["movement capped at 30 units", actorCase({ x: 20, y: 0, mx: 40 })],
    ["positive split keeps Doom's signed rounding", actorCase({ x: 20, y: 0, mx: 21, extraX: 1, extraY: -3 })],
    ["negative movement is not split", actorCase({ x: 80, y: 0, mx: -21, extraX: -1 })],
    ["crossings retain order across the two half steps", actorCase({ x: -10, y: 0, z: 0, floor: 0, ceiling: 128, mx: 22 })],
    ["slide along a horizontal wall", actorCase({ x: 60, y: -44, mx: 10, my: -10 })],
    ["slide along a vertical wall at the edge of the blockmap", actorCase({ x: 244, y: 96, mx: -10, my: 10 })],
    ["project momentum along an angled wall", actorCase({ x: 188, y: -34, mx: 4, my: 14 })],
    ["stair-step checks Y before X at an explicitly blocked portal", actorCase({ x: 60, y: 10, mx: 5, my: 9 })],
    ["non-player stops without sliding", actorCase({ x: 60, y: -45, mx: 0, my: -15, mz: 2, player: 0 })],
    ["missile explosion clears all momentum", actorCase({ x: 60, y: -45, mx: 0, my: -15, mz: 2, player: 0, flags: moveMissile })],
    ["missile hitting a sky-backed ceiling is removed", actorCase({ x: -24, y: 0, z: 107, floor: 0, ceiling: 128,
        actorHeight: 8, mx: 15, player: 0, flags: moveMissile })],
    ["missiles retain momentum in the clear", actorCase({ player: 0, flags: moveMissile })],
    ["stalled flying skull resets", actorCase({ player: 0, flags: moveSkullFly, mx: 0, mz: 3 })],
    ["corpse drifting off a step skips friction", actorCase({ x: -21, y: 0, player: 0, flags: moveCorpse, mx: 8 })],
];

// Raw 16.16 results from the pinned C movement, sliding, and line-trace routines.
const expected = [
    [3407872, 262144, 1572864, 1572864, 7340032, 237568, 0, 0, 0, 0, 0],
    [3407872, 262144, 1638400, 1572864, 7340032, 262144, 0, 0, 0, 0, 0],
    [3407872, 262144, 1572864, 1572864, 7340032, 0, 0, 0, 0, 0, 0],
    [3149823, 262144, 1572864, 1572864, 7340032, 0, 0, 0, 0, 0, 0],
    [3149824, 262144, 1572864, 1572864, 7340032, 3712, 0, 0, 0, 0, 0],
    [3149823, 262144, 1572864, 1572864, 7340032, 3711, 0, 0, 0, 0, 0],
    [3276800, 0, 1572864, 1572864, 7340032, 1781760, 0, 0, 0, 0, 0],
    [2686976, -3, 1572864, 1572864, 7340032, 1247232, -3, 0, 0, 0, 0],
    [3866623, 0, 1572864, 1572864, 7340032, -1247233, 0, 0, 0, 0, 0],
    [786432, 0, 0, 1572864, 7340032, 1306624, 0, 0, 0, 0, 2, 0, 1, 1, 1],
    [4567040, -3125244, 1572864, 1572864, 7340032, 356355, 0, 0, 0, 0, 0],
    [15749124, 6926336, 1572864, 1572864, 7340032, 0, 356355, 0, 0, 0, 0],
    [12651953, -1393337, 1572864, 1572864, 7340032, 117508, 117420, 0, 0, 0, 0],
    [4259840, 655360, 1572864, 1572864, 7340032, 296960, 534528, 0, 0, 0, 0],
    [3932160, -2949120, 1572864, 1572864, 7340032, 0, 0, 131072, 0, 0, 0],
    [3932160, -2949120, 1572864, 1572864, 7340032, 0, 0, 0, 0, 1, 0],
    [-1572864, 0, 7012352, 0, 8388608, 983040, 0, 0, 65536, 2, 0],
    [3407872, 262144, 1572864, 1572864, 7340032, 262144, 0, 0, 65536, 0, 0],
    [3145728, 262144, 1572864, 1572864, 7340032, 0, 0, 0, 0, 3, 0],
    [-851968, 0, 1572864, 1572864, 7340032, 524288, 0, 0, 1048576, 0, 0],
];

function words(values) {
    const buffer = Buffer.alloc(values.length * 2);
    for (const [i, value] of values.entries()) buffer.writeUInt16LE(value & 0xffff, i * 2);
    return buffer;
}

function fixture() {
    const sides = [];
    const linedefs = lines.map(([a, b, flags, action, front, back]) => {
        const side = sides.length;
        sides.push(Buffer.concat([Buffer.alloc(28), words([front])]));
        if (back >= 0) sides.push(Buffer.concat([Buffer.alloc(28), words([back])]));
        return words([a, b, flags, action, 0, side, back < 0 ? -1 : side + 1]);
    });
    const segs = leaves.map(([line, side]) => {
        const [a, b] = lines[line];
        return words([side ? b : a, side ? a : b, 0, line, side, 0]);
    });
    const blockHeader = [originX, originY, width, height];
    const blockLists = [];
    for (const list of blocks) {
        blockHeader.push(4 + blocks.length + blockLists.length);
        blockLists.push(...list, -1);
    }
    const lumps = [
        ["MAP01", Buffer.alloc(0)], ["THINGS", words([48, 4, 0, 1, 7])],
        ["LINEDEFS", Buffer.concat(linedefs)], ["SIDEDEFS", Buffer.concat(sides)], ["VERTEXES", words(vertices.flat())],
        ["SEGS", Buffer.concat(segs)], ["SSECTORS", words(leaves.flatMap((_, i) => [1, i]))],
        ["NODES", words(nodes.flatMap(([x, y, dx, dy, front, back]) => [x, y, dx, dy, 160, -64, -128, 256, 160, -64, -128, 256, front, back]))],
        ["SECTORS", Buffer.concat(sectors.map(([floor, ceiling, sky]) => {
            const sector = Buffer.alloc(26);
            words([floor, ceiling]).copy(sector);
            if (sky) sector.write("F_SKY1", 12);
            return sector;
        }))],
        ["REJECT", Buffer.alloc(1)], ["BLOCKMAP", words([...blockHeader, ...blockLists])],
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
const Count = ${scenarios.length}
const Cases = [Count][15]int{
    ${scenarios.map(([, args]) => `[15]int{${args.join(", ")}}`).join(",\n    ")},
}

map "Doom horizontal movement parity" {
    tick {
        index := currentTick()
        if index < Count {
            args := Cases[index]
            body := play.MapActor{X: args[0], Y: args[1], Z: args[2], Floor: args[3], Ceiling: args[4],
                Radius: args[5], Height: args[6], Flags: bits<32>(args[7]), Player: args[8] != 0}
            actor := play.ActorPhysics{Body: body, MomentumX: args[9], MomentumY: args[10], MomentumZ: args[11]}
            command := play.PlayerMoveCommand{Forward: args[12], Side: args[13]}
            level := wad.LoadBspLevel(Archive, wad.LE32(Archive, 8))
            result := play.MoveHorizontally(level, wad.LoadBlockMap(level), actor, command, args[14] != 0)
            moved := result.Actor
            log(result.Valid, result.StopWalking)
            log(moved.Body.X, moved.Body.Y, moved.Body.Z, moved.Body.Floor, moved.Body.Ceiling,
                moved.MomentumX, moved.MomentumY, moved.MomentumZ, moved.Body.Flags, result.Event, result.CrossingCount)
            for i := range result.CrossingCount {
                crossing := result.Crossings.At(i)
                log(crossing.Line, crossing.OldSide)
            }
        }
    }
}
`;

try {
    writeFileSync(path.join(scratch, "LEVEL.WAD"), fixture());
    const main = path.join(scratch, "main.flt");
    const output = path.join(scratch, "map.json");
    writeFileSync(main, source);
    const build = spawnSync("dotnet", [cli, "build", main, "--package-root", port, "--asset-root", scratch, "-o", output], {
        encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (build.error) throw build.error;
    assert.equal(build.status, 0, build.stderr);
    const map = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(Buffer.from(map.data, "base64")[2], 1);
    const sim = simulator(decode(map.data));
    const traces = [];
    for (const [index, [name]] of scenarios.entries()) {
        const first = sim.logs.length;
        sim.step();
        const [status, header, ...crossings] = sim.logs.slice(first);
        assert.equal(status?.[0], true, name);
        assert.equal(status[1], index === 3, name);
        assert.equal(crossings.length, header[10], name);
        const trace = [...Array.from(header), ...crossings.flatMap(pair => Array.from(pair))];
        assert.deepEqual(trace, expected[index], name);
        traces.push(trace);
    }

    if (oracle) {
        const input = [
            vertices.length, sectors.length, lines.length, nodes.length, leaves.length, width, height, originX, originY,
            ...vertices.flat(), ...sectors.flat(), ...lines.flat(), ...nodes.flat(),
            ...leaves.map(([line, side]) => lines[line][4 + side]), ...blocks.flatMap(block => [block.length, ...block]),
            scenarios.length, ...scenarios.flatMap(([, args]) => args),
        ].join(" ");
        const native = spawnSync(oracle, { input, encoding: "utf8", timeout: 5000, cwd: scratch });
        if (native.error) throw native.error;
        assert.equal(native.status, 0, native.stderr);
        const reference = native.stdout.trim().split(/\r?\n/).map(row => row.trim().split(/\s+/).map(Number));
        for (const [index, [name]] of scenarios.entries()) {
            assert.deepEqual(traces[index], reference[index], name);
        }
    }
    console.log(`Doom horizontal movement passed ${scenarios.length} fixed-point traces, including angled slides and sky missile impacts.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-horizontal-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
