import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(path.join(artifacts, "doom-sector-lines-"));

function build(entry) {
    const output = path.join(scratch, "output.json");
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output], {
        encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
}

function fixture() {
    const vertices = Buffer.alloc(10 * 2);
    [-64, -64, 64, -64, 64, 64, -64, 64, 320, -256].forEach((value, index) => vertices.writeInt16LE(value, index * 2));
    const lines = Buffer.alloc(4 * 14), sides = Buffer.alloc(7 * 30), sectors = Buffer.alloc(2 * 26);
    [[0, 1, 0, 0xffff], [1, 2, 1, 2], [2, 3, 3, 4], [3, 4, 5, 0xffff]].forEach(([a, b, front, back], index) => {
        const offset = index * 14; lines.writeUInt16LE(a, offset); lines.writeUInt16LE(b, offset + 2);
        lines.writeUInt16LE(front, offset + 10); lines.writeUInt16LE(back, offset + 12);
    });
    [0, 0, 1, 1, 1, 1, 1].forEach((sector, index) => sides.writeUInt16LE(sector, index * 30 + 28));
    const blockWords = [-128, -128, 3, 3, 13, 13, 13, 13, 13, 13, 13, 13, 13, -1];
    const block = Buffer.alloc(blockWords.length * 2); blockWords.forEach((word, index) => block.writeInt16LE(word, index * 2));
    return Buffer.concat([vertices, lines, sides, sectors, block]);
}

try {
    writeFileSync(path.join(scratch, "SECTORS.BIN"), fixture());
    copyFileSync(path.join(port, "wad-bsp", "sound-cues.flt"), path.join(scratch, "sound-cues.flt"));
    const entry = path.join(scratch, "main.flt");
    writeFileSync(entry, `package main
import "wad"
const Source = readFile("SECTORS.BIN")
map "Doom sector lines" {
    tick {
        level := wad.BspLevel{File: Source,
            Vertices: wad.Lump{Offset: 0, Count: 5, Valid: true},
            Lines: wad.Lump{Offset: 20, Count: 4, Valid: true},
            Sides: wad.Lump{Offset: 76, Count: 7, Valid: true},
            Sectors: wad.Lump{Offset: 286, Count: 2, Valid: true},
            BlockMap: wad.Lump{Offset: 338, Count: 28, Valid: true}}
        zero, one := level.SectorLineInfo(0), level.SectorLineInfo(1)
        log(level.SectorLineCount(0), level.SectorLineAt(0, 0), level.SectorLineAt(0, 1), level.SectorLineAt(0, 2))
        log(level.SectorLineCount(1), level.SectorLineAt(1, 0), level.SectorLineAt(1, 1), level.SectorLineAt(1, 2), level.SectorLineAt(1, 3))
        log(zero.Valid, zero.Bounds.Left >> 16, zero.Bounds.Right >> 16, zero.Bounds.Bottom >> 16, zero.Bounds.Top >> 16, zero.SoundX >> 16, zero.SoundY >> 16,
            zero.Block.Valid, zero.Block.Left, zero.Block.Right, zero.Block.Bottom, zero.Block.Top)
        log(one.Valid, one.Bounds.Left >> 16, one.Bounds.Right >> 16, one.Bounds.Bottom >> 16, one.Bounds.Top >> 16, one.SoundX >> 16, one.SoundY >> 16,
            one.Block.Valid, one.Block.Left, one.Block.Right, one.Block.Bottom, one.Block.Top)
        log(level.SectorLineCount(2), level.SectorLineAt(1, 4))
        cached := loadSectorSoundBounds(level)
        for sector := range 2 {
            entry := cached.At(sector)
            log(entry.Valid, entry.Box.Left >> 16, entry.Box.Right >> 16, entry.Box.Bottom >> 16, entry.Box.Top >> 16)
        }
        log(cached.At(2).Valid)
    }
}
`);
    const sim = build(entry); sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [2, 0, 1, -1], [3, 1, 2, 3, -1],
        [true, -64, 64, -64, 64, 0, 0, true, 0, 1, 0, 1],
        [true, -64, 320, -256, 64, 128, -96, true, 0, 2, 0, 1],
        [-1, -1],
        [true, -64, 64, -64, 64], [true, -64, 320, -256, 64], [false],
    ]);
    console.log("Doom P_GroupLines sector membership, cached sound bounds, and clipped BLOCKMAP boxes passed.");
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
