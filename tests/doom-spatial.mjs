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
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-spatial-"));

// The four BLOCKMAP lists deliberately begin with zero. linuxdoom-1.10's
// P_BlockLinesIterator treats that as linedef zero, not as a skipped marker.
function fixture() {
    const block = Buffer.alloc(38);
    const words = [-128, 64, 2, 2, 8, 11, 13, 17, 0, 3, -1, 0, -1, 0, 7, 2, -1, 0, -1];
    for (const [index, value] of words.entries()) block.writeInt16LE(value, index * 2);
    return Buffer.concat([block, Buffer.from([0b00001100, 0b00000001])]);
}

const source = `package main

import "wad"

const Source = readFile("SPATIAL.BIN")

map "Doom spatial parity" {
    tick {
        if currentTick() == 0 {
            level := wad.BspLevel{
                File: Source,
                BlockMap: wad.Lump{Offset: 0, Count: 38, Valid: true},
                Reject: wad.Lump{Offset: 38, Count: 2, Valid: true},
                Sectors: wad.Lump{Count: 3},
            }
            block := wad.LoadBlockMap(level)
            first := wad.BlockCellAt(block, -128 << 16, 64 << 16)
            second := wad.BlockCellAt(block, 0, 64 << 16)
            last := wad.BlockCellAt(block, 127 << 16, 319 << 16)
            outside := wad.BlockCellAt(block, 128 << 16, 64 << 16)
            start := wad.BlockLineListStart(level, block, first)
            log(block.Valid, block.OriginX >> 16, block.OriginY >> 16, block.Width, block.Height)
            log(first.Valid, first.X, first.Y, second.Valid, second.X, second.Y, last.Valid, last.X, last.Y, outside.Valid)
            log(start, wad.BlockLineAt(level, block, start, 0), wad.BlockLineAt(level, block, start, 1), wad.BlockLineAt(level, block, start, 2))
            log(wad.RejectsSight(level, 0, 0), wad.RejectsSight(level, 0, 2), wad.RejectsSight(level, 1, 0), wad.RejectsSight(level, 2, 2))
            bad := level
            bad.BlockMap.Count = 7
            malformed := wad.LoadBlockMap(bad)
            shortReject := level
            shortReject.Reject.Count = 1
            log(malformed.Valid, wad.BlockLineAt(level, block, start, 64), wad.RejectsSight(shortReject, 0, 2), wad.RejectsSight(level, -1, 0))
        }
    }
}
`;

try {
    writeFileSync(path.join(scratch, "SPATIAL.BIN"), fixture());
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
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [true, -128, 64, 2, 2],
        [true, 0, 0, true, 1, 0, true, 1, 1, false],
        [16, 0, 3, -1],
        [false, true, true, true],
        [false, -1, false, false],
    ]);
    console.log("Doom BLOCKMAP and REJECT helpers passed fixed-point cells, raw list zero semantics, terminators, malformed bounds, and sector-pair bit checks.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-spatial-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
