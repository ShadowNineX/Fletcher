import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const oracle = process.argv[3] ? path.resolve(root, process.argv[3]) : null;
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-thinkers-"));

function build(fixture, outputName) {
    const output = path.join(scratch, outputName + ".json");
    const result = spawnSync("dotnet", [cli, "build", path.join(root, "tests", "fixtures", fixture, "main.flt"),
        "--package-root", port, "-o", output], {
        encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return decode(JSON.parse(readFileSync(output, "utf8")).data);
}

try {
    const normal = simulator(build("doom-thinkers", "normal"));
    normal.step();
    const normalLogs = JSON.parse(JSON.stringify(normal.logs));
    assert.deepEqual(normalLogs, [
        // The first callback marks handle 2 and appends handle 3. Handle 1
        // marks itself, so it survives until the second scheduler run.
        [0, 1, 2, 3, 0, 1, 3, 3, 0, 3, 11, true, false, 41, false],
        [2, 0, 3, 2, 0, 3, 12, false, 42, false],
    ]);

    const capacity = simulator(build("doom-thinkers-capacity", "capacity"));
    capacity.step();
    capacity.step();
    const capacityLogs = JSON.parse(JSON.stringify(capacity.logs));
    assert.deepEqual(capacityLogs, [
        [64, 0, 63, false, -1, true, 64],
        [2, 63, 0, 2, 63, 0, false],
    ]);
    if (oracle) {
        const native = spawnSync(oracle, [], { encoding: "utf8", timeout: 5_000 });
        if (native.error) throw native.error;
        assert.equal(native.status, 0, native.stderr);
        assert.deepEqual(native.stdout.trim().split(/\s+/).map(Number),
            [...normalLogs.flat(), ...capacityLogs[1]].map(Number));
    }
    console.log("Doom thinkers passed insertion order, lazy removal, in-run append, and bounded-capacity checks.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-thinkers-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
