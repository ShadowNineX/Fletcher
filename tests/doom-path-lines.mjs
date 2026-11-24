import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-path-lines-"));

function record(size, writes) {
    const value = Buffer.alloc(size);
    for (const [offset, bytes] of writes) Buffer.from(bytes).copy(value, offset);
    return value;
}
function i16(value) { const b = Buffer.alloc(2); b.writeInt16LE(value); return b; }
function u16(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function fixture() {
    const vertices = Buffer.concat([i16(0), i16(32), i16(128), i16(32), i16(0), i16(96), i16(128), i16(96)]);
    const lines = Buffer.concat([
        u16(0), u16(1), u16(0), u16(0), u16(0), u16(0), u16(0xffff),
        u16(2), u16(3), u16(0), u16(0), u16(0), u16(0), u16(0xffff),
    ]);
    const side = record(30, [[28, u16(0)]]);
    const sector = record(26, [[0, i16(0)], [2, i16(128)]]);
    const block = Buffer.concat([i16(0), i16(0), u16(1), u16(1), u16(5), u16(1), u16(0), u16(1), u16(0xffff)]);
    return Buffer.concat([vertices, lines, side, sector, block]);
}

const denseCount = 145;
const near = Array.from({ length: 72 }, (_, i) => 142 - 2 * i);
const far = Array.from({ length: 72 }, (_, i) => 143 - 2 * i);
const special = denseCount - 1;

function denseFixture() {
    const vertices = Buffer.concat([0, 24, 128, 24, 0, 48, 128, 48].map(i16));
    const lines = Buffer.concat(Array.from({ length: denseCount }, (_, i) => {
        const first = i === special || i % 2 ? 2 : 0;
        return Buffer.concat([first, first + 1, 4, i === special ? 11 : 0, 0, 0, 0].map(u16));
    }));
    const side = record(30, [[28, u16(0)]]);
    const sector = record(26, [[0, i16(0)], [2, i16(128)]]);
    const entries = far.flatMap((line, i) => [line, near[i]]);
    const block = Buffer.concat([0, 0, 1, 1, 5, ...entries, special, near[0], special, 0xffff].map(u16));
    return Buffer.concat([vertices, lines, side, sector, block]);
}

const source = `package main
import "play"
import "wad"
const File = readFile("PATH.BIN")
const Dense = readFile("DENSE.BIN")
const DenseCount = ${denseCount}
map "Doom path lines" {
    tick {
        if currentTick() == 0 {
            level := wad.BspLevel{File: File,
                Lines: wad.Lump{Offset: 16, Count: 2, Valid: true},
                Vertices: wad.Lump{Offset: 0, Count: 4, Valid: true},
                Sides: wad.Lump{Offset: 44, Count: 1, Valid: true},
                Sectors: wad.Lump{Offset: 74, Count: 1, Valid: true},
                BlockMap: wad.Lump{Offset: 100, Count: 18, Valid: true}}
            block := wad.LoadBlockMap(level)
            hit := wad.TraceMapLines(level, block, 64 << 16, 0, 64 << 16, 127 << 16)
            log(hit.Valid, hit.Count, hit.Hits.At(0).Index, hit.Hits.At(1).Index,
                hit.Hits.At(0).Fraction, hit.Hits.At(1).Fraction)
            outside := wad.TraceMapLines(level, block, 64 << 16, -32 << 16, 64 << 16, 160 << 16)
            log(outside.Valid, outside.Count, outside.Hits.At(0).Fraction, outside.Hits.At(1).Fraction)
            level.BlockMap.Count = level.BlockMap.Count - 2
            log(wad.TraceMapLines(level, wad.LoadBlockMap(level), 64 << 16, 0, 64 << 16, 127 << 16).Valid)

            blockOffset := 16 + DenseCount * 14 + 30 + 26
            dense := wad.BspLevel{File: Dense,
                Lines: wad.Lump{Offset: 16, Count: DenseCount, Valid: true},
                Vertices: wad.Lump{Offset: 0, Count: 4, Valid: true},
                Sides: wad.Lump{Offset: 16 + DenseCount * 14, Count: 1, Valid: true},
                Sectors: wad.Lump{Offset: blockOffset - 26, Count: 1, Valid: true},
                BlockMap: wad.Lump{Offset: blockOffset, Count: len(Dense) - blockOffset, Valid: true}}
            blocks := wad.LoadBlockMap(dense)
            trace := wad.TraceMapLines(dense, blocks, 64 << 16, 1 << 16, 64 << 16, 65 << 16)
            log(trace.Valid, trace.Count)
            for i := range trace.Count {
                item := trace.Hits.At(i)
                log(item.Index, item.Fraction)
            }
            action := play.FindUseLine(dense, blocks, 64 << 16, 1 << 16, 0x40000000)
            log(action.Valid, action.Found, action.Index)
        }
    }
}
`;

try {
    writeFileSync(path.join(scratch, "PATH.BIN"), fixture());
    writeFileSync(path.join(scratch, "DENSE.BIN"), denseFixture());
    const main = path.join(scratch, "main.flt");
    const output = path.join(scratch, "map.json");
    writeFileSync(main, source);
    const result = spawnSync("dotnet", [cli, "build", main, "--package-root", port, "--asset-root", scratch, "-o", output], {
        encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
    sim.step();
    const [valid, count, first, second, firstFraction, secondFraction] = sim.logs[0];
    assert.equal(valid, true);
    assert.equal(count, 2);
    assert.deepEqual([first, second], [0, 1]);
    assert.deepEqual([firstFraction, secondFraction], [16123, 49412]);
    assert.deepEqual(Array.from(sim.logs[1]), [true, 2, 21845, 43690]);
    assert.deepEqual(Array.from(sim.logs[2]), [false]);
    assert.deepEqual(Array.from(sim.logs[3]), [true, denseCount]);
    const contacts = Array.from(sim.logs.slice(4, -1), row => Array.from(row));
    assert.deepEqual(contacts, [...near.map(index => [index, 23 * 1024]), ...[...far, special].map(index => [index, 47 * 1024])]);
    assert.deepEqual(Array.from(sim.logs.at(-1)), [true, true, special], "use reaches the special after 144 open lines");
    console.log("Doom line traversal passed BLOCKMAP nudges, invalid-list handling, and all 145 dense intercepts with stable ties and use-line selection.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-path-lines-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
