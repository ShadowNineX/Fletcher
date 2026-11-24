import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runNativeNoiseOracle } from "./doom-native-noise-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-noise-"));
const unit = 65536;
const twoSided = 4, blockSound = 64;
const open = [0, 128 * unit], closed = [0, 0];
const portal = (front, back, block = false) => [front, back, twoSided | (block ? blockSound : 0)];
const cue = (emitter, target, changes = []) => ({ emitter, target, changes });

const fixtures = [
    {
        name: "one blocker transmits and two blockers stop",
        sectors: [open, open, open, open, closed, open],
        lines: [portal(0, 1), portal(1, 2, true), portal(2, 3, true), portal(1, 4), portal(4, 5), [3, -1, blockSound]],
        pulses: [cue(0, 7), cue(3, 8)],
        expected: [[7, 1], [7, 1], [7, 2], [0, 0], [0, 0], [0, 0], [7, 1], [7, 1], [8, 2], [8, 1], [0, 0], [0, 0]],
    },
    {
        name: "a lower-cost revisit opens a new route behind a blocker",
        sectors: Array(6).fill(open),
        lines: [portal(0, 1, true), portal(1, 2), portal(2, 4, true), portal(0, 3), portal(3, 2), portal(4, 5)],
        pulses: [cue(0, 3)],
        expected: [[3, 1], [3, 1], [3, 1], [3, 1], [3, 2], [3, 2]],
    },
    {
        name: "doors use live heights and preserve a previous alert behind a closed door",
        sectors: [open, closed, open],
        lines: [portal(0, 1), portal(1, 2)],
        pulses: [cue(0, 19), cue(2, 20, [[1, 0, 64 * unit]]), cue(0, 21, [[1, 0, 0]])],
        expected: [[19, 1], [0, 0], [0, 0], [20, 1], [20, 1], [20, 1], [21, 1], [20, 1], [20, 1]],
    },
    {
        name: "parallel portals and same-sector lines preserve the cheapest opening",
        sectors: [open, open, [-80 * unit, 0], [-80 * unit, -32 * unit]],
        lines: [portal(0, 0, true), portal(0, 1, true), portal(1, 0), portal(1, 2), portal(2, 3), portal(3, 3)],
        pulses: [cue(0, 11), cue(3, 12)],
        expected: [[11, 1], [11, 1], [0, 0], [0, 0], [11, 1], [11, 1], [12, 1], [12, 1]],
    },
    {
        name: "a single isolated sector hears its own alert",
        sectors: [open],
        lines: [[0, -1, 0]],
        pulses: [cue(0, 1), cue(0, 2)],
        expected: [[1, 1], [2, 1]],
    },
    {
        name: "deep open chains exhaust the traversal stack safely across script slices",
        sectors: Array(64).fill(open),
        lines: Array.from({ length: 63 }, (_, i) => portal(i, i + 1)),
        pulses: [cue(0, 13), cue(63, 14)],
        expected: [...Array.from({ length: 64 }, () => [13, 1]), ...Array.from({ length: 64 }, () => [14, 1])],
    },
];

function generateFixtures() {
    const data = [];
    let offset = 0;
    function writeLump(name, count, recordSize, write) {
        const bytes = Buffer.alloc(count * recordSize);
        for (let i = 0; i < count; i++) write(bytes, i * recordSize, i);
        const field = `                ${name}: wad.Lump{Valid: true, Offset: ${offset}, Count: ${count}},`;
        offset += bytes.length;
        data.push(bytes);
        return field;
    }
    const source = fixtures.map(({ sectors, lines, pulses }, index) => {
        const vertices = writeLump("Vertices", 2, 4, (buf, offset, i) => buf.writeInt16LE(i * 64, offset));
        const sectorRecords = writeLump("Sectors", sectors.length, 26, (buf, offset, i) => {
            buf.writeInt16LE(sectors[i][0] / unit, offset);
            buf.writeInt16LE(sectors[i][1] / unit, offset + 2);
        });
        const sides = writeLump("Sides", sectors.length, 30, (buf, offset, i) => buf.writeUInt16LE(i, offset + 28));
        const lineRecords = writeLump("Lines", lines.length, 14, (buf, offset, i) => {
            const [front, back, flags] = lines[i];
            buf.writeUInt16LE(1, offset + 2);
            buf.writeUInt16LE(flags, offset + 4);
            buf.writeUInt16LE(front, offset + 10);
            buf.writeUInt16LE(back < 0 ? 65535 : back, offset + 12);
        });
        const commands = pulses.map(({ emitter, target, changes }, i) => {
            const edits = changes.map(([slot, floor, ceiling]) =>
                `                live.Changed[${slot}], live.Floors[${slot}], live.Ceilings[${slot}] = true, ${floor}, ${ceiling}`);
            return [`            case ${i}:`, `                emitter, target = ${emitter}, ${target}`, ...edits].join("\n");
        }).join("\n");
        return `        case ${index}:
            base = wad.BspLevel{Valid: true, File: Geometry,
${[vertices, sectorRecords, sides, lineRecords].join("\n")}
            }
            pulseCount = ${pulses.length}
            graph := play.BuildSoundGraph(base)
            for i := range pulseCount {
                emitter, target := 0, 0
                switch i {
${commands}
                }
                sounds = play.NoiseAlert(base.WithChanges(live), graph, sounds, emitter, target)
                if !sounds.Valid { log(-1, -1) }
                for sector := range base.Sectors.Count {
                    entry := sounds.At(sector)
                    log(entry.Target, entry.Traversed)
                }
            }`;
    });
    writeFileSync(path.join(scratch, "GEOMETRY.BIN"), Buffer.concat(data));
    return source.join("\n");
}

function traceFletcher() {
    const main = path.join(scratch, "main.flt"), output = path.join(scratch, "result.json");
    writeFileSync(main, `package main
import "engine"
import "play"
import "wad"
const Geometry = readFile("GEOMETRY.BIN")

type LiveHeights struct {
    Changed [8]bit
    Floors [8]int
    Ceilings [8]int
}

func (live LiveHeights) ReadHeights(sector int, original engine.SectorHeights) engine.SectorHeights {
    if sector < 8 && live.Changed[sector] { return engine.SectorHeights{Floor: live.Floors[sector], Ceiling: live.Ceilings[sector]} }
    return original
}
func (live LiveHeights) ReadLineAction(line int, original int) int { return original }
func (live LiveHeights) ReadSectorSpecial(sector int, original int) int { return original }
func (live LiveHeights) ReadSideMaterial(side int, original wad.SideMaterial) wad.SideMaterial { return original }
func (live LiveHeights) ReadFloorName(sector int, original wad.LumpName) wad.LumpName { return original }

map "Doom noise alert parity" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        var live LiveHeights
        var base wad.BspLevel
        var sounds play.SoundTargets
        pulseCount := 0
        switch currentTick() {
${generateFixtures()}
        }
        log(99, currentTick())
    }
}
`);
    const run = spawnSync("dotnet", [cli, "build", main, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (run.error) throw run.error;
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    const sim = simulator(decode(encoded), true);
    return fixtures.map((entry, i) => {
        const from = sim.logs.length;
        let host = 0;
        while (sim.logs.length === from && host++ < 60) sim.step();
        const rows = Array.from(sim.logs.slice(from), row => Array.from(row, Number));
        assert.deepEqual(rows.pop(), [99, i], entry.name + " committed");
        assert.deepEqual(rows, entry.expected, entry.name);
        if (entry.sectors.length === 64) assert.ok(host > 1, "deep traversal spans host work slices");
        return rows;
    });
}

const digest = rows => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
try {
    const observed = traceFletcher();
    if (values.upstream) {
        const native = runNativeNoiseOracle(path.resolve(root, values.upstream), scratch, fixtures);
        fixtures.forEach(({ name }, i) => assert.deepEqual(observed[i], native[i], name));
        console.log(`Matched ${fixtures.length} sector sound traces with pinned Doom C. SHA-256 ${digest(native)}.`);
    } else {
        console.log(`Verified ${fixtures.length} sector sound traces against the pinned C snapshots.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-noise-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
