import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const scratch = mkdtempSync(path.join(root, "artifacts", "doom-visplanes-"));

try {
    function build(fixture, name) {
        const output = path.join(scratch, name + ".json");
        const result = spawnSync("dotnet", [cli, "build", path.join(root, "tests", "fixtures", fixture),
        "--package-root", path.join(root, "examples", "doom-engine"), "-o", output], {
        encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
        });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, result.stderr);
        return decode(JSON.parse(readFileSync(output, "utf8")).data);
    }
    const core = simulator(build(path.join("visplane-normal", "main.flt"), "normal"));
    core.step();
    assert.deepEqual(JSON.parse(JSON.stringify(core.logs)), [
        [0, 1, 0, 2, 2, 3, 6],
        [0, false, 8, 23, false, true, false],
        [4, true, 0, 15, 0, false, 5, true],
        [false, false, true, true, true, false, false],
        [true, false],
    ]);
    const tiles = build(path.join("visplane-capacity", "main.flt"), "capacity").map(tile => {
        if (!tile.payload) return tile;
        return { ...tile, payload: Buffer.from(tile.payload.toString().replace(/__budget = \d+;/, "__budget = 1000000;")) };
    });
    const sim = simulator(tiles);
    sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [260],
        [260, false, 161, false, 161, false],
        [30, 41, 260, true, 32, 40, 161],
        [false, true, true, true, false, false, false],
        [261, false, -1, true],
        [true, true, true, true, true, true],
    ]);
    console.log("Doom visplane allocator passed all 260 exact lookups, first-match, sky normalization, overlap splitting, and retained snapshots through 261 planes.");
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
