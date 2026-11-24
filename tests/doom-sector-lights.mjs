import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(path.join(artifacts, "doom-sector-lights-"));

const specials = [1, 2, 3, 4, 8, 12, 13, 17];
const connections = specials.map((_, index) => index % 2 === 0 ? [index, 8, 4] : [8, index, 4]);
connections.push([0, 9, 0], [0, 0, 4]); // One-sided neighbor and self reference.
const sectorBytes = 10 * 26;
const lineBytes = connections.length * 14;
const sideBytes = connections.length * 60;

function levelRecords(minimum) {
    const sectors = Buffer.alloc(sectorBytes);
    for (const [i, special] of specials.entries()) {
        sectors.writeInt16LE(160, i * 26 + 20);
        sectors.writeInt16LE(special, i * 26 + 22);
    }
    sectors.writeInt16LE(minimum, 8 * 26 + 20);
    sectors.writeInt16LE(32, 9 * 26 + 20);
    const lines = Buffer.alloc(lineBytes);
    const sides = Buffer.alloc(sideBytes);
    for (const [i, [front, back, flags]] of connections.entries()) {
        lines.writeUInt16LE(1, i * 14 + 2);
        lines.writeUInt16LE(flags, i * 14 + 4);
        lines.writeUInt16LE(i * 2, i * 14 + 10);
        lines.writeUInt16LE(i * 2 + 1, i * 14 + 12);
        sides.writeUInt16LE(front, i * 60 + 28);
        sides.writeUInt16LE(back, i * 60 + 58);
    }
    const vertices = Buffer.alloc(8);
    vertices.writeInt16LE(16, 4);
    return Buffer.concat([sectors, lines, sides, vertices]);
}

const nativeDigests = {
    neighboring: "7263da46990ece74ddcd9b146a9371600f322839608b9c45a56ebb5140de3ef4",
    isolated: "35f2d8b59b866b749401992798adef12953a491deaebe259f20a07a0e5ddef17",
};

try {
    const source = path.join(scratch, "main.flt");
    const output = path.join(scratch, "output.json");
    writeFileSync(source, `package main
import "play"
import "wad"
const Records = readFile("level.bin")

map "Doom lighting thinkers" {
    register lights play.LevelLightStep = play.LevelLightStep{}
    tick {
        tic := currentTick()
        frame := lights
        if tic == 0 {
            level := wad.BspLevel{Valid: true, File: Records,
                Sectors: wad.Lump{Valid: true, Count: 10},
                Lines: wad.Lump{Valid: true, Count: ${connections.length}, Offset: ${sectorBytes}},
                Sides: wad.Lump{Valid: true, Count: ${connections.length * 2}, Offset: ${sectorBytes + lineBytes}},
                Vertices: wad.Lump{Valid: true, Count: 2, Offset: ${sectorBytes + lineBytes + sideBytes}}}
            frame = play.LoadLevelLights(level, play.ClearRandom())
            log(frame.Lights.Count, frame.Lights.EntryAt(0).Special, frame.Lights.EntryAt(3).Special,
                frame.Lights.EntryAt(7).Special, frame.Random.MenuIndex)
        } else {
            frame = play.TickLevelLights(lights.Lights, lights.Random)
        }
        next lights = frame
        log(tic, frame.Random.GameplayIndex, ${specials.map((_, i) => `frame.Lights.EntryAt(${i}).Level`).join(", ")})
    }
}
`);

    for (const [variant, minimum] of [["neighboring", 96], ["isolated", 160]]) {
        writeFileSync(path.join(scratch, "level.bin"), levelRecords(minimum));
        const build = spawnSync("dotnet", [cli, "build", source, "--package-root", path.join(root, "examples", "doom-engine"),
            "--asset-root", scratch, "-o", output], { encoding: "utf8", cwd: root, timeout: 15_000 });
        assert.equal(build.status, 0, build.error?.message ?? build.stderr);
        const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
        for (let tic = 0; tic <= 72; tic++) sim.step();
        assert.deepEqual(JSON.parse(JSON.stringify(sim.logs[0])), [8, 0, 4, 0, 0]);
        const rows = sim.logs.slice(1).map(row => row.join(" ")).join("\n");
        assert.equal(createHash("sha256").update(rows).digest("hex"), nativeDigests[variant], `pinned light trace for ${variant} sectors`);
        if (process.argv[3]) {
            const oracle = spawnSync(path.resolve(process.argv[3]), variant === "isolated" ? ["isolated"] : [],
                { encoding: "utf8", timeout: 5000 });
            assert.equal(oracle.status, 0, oracle.error?.message ?? oracle.stderr);
            assert.equal(rows, oracle.stdout.replaceAll("\r", "").trim());
        }
    }
    console.log("Doom sector-light thinkers and gameplay RNG matched 146 native samples.");
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
