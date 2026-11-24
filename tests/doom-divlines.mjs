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
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-divlines-"));

const source = `package main

import "engine"
import "wad"

map "Doom divline parity" {
    tick {
        if currentTick() == 0 {
            horizontal := wad.CollisionLine{Valid: true, First: engine.Vertex{X: 0, Y: 0}, DeltaX: 128 << 16}
            fromLine := wad.MakeDivLine(horizontal)
            vertical := wad.DivLine{Valid: true, X: 0, Y: 0, DeltaY: 128 << 16}
            diagonal := wad.DivLine{Valid: true, X: 0, Y: 0, DeltaX: 128 << 16, DeltaY: 64 << 16}
            shiftedHorizontal := wad.DivLine{Valid: true, X: 10 << 16, Y: 20 << 16, DeltaX: 128 << 16}
            trace := wad.DivLine{Valid: true, X: 0, Y: 0, DeltaX: 128 << 16}
            crossing := wad.DivLine{Valid: true, X: 32 << 16, Y: -(64 << 16), DeltaY: 128 << 16}
            parallel := wad.DivLine{Valid: true, X: 0, Y: 64 << 16, DeltaX: 128 << 16}
            log(wad.ApproxDistance(3, 5), wad.ApproxDistance(-10, 4))
            log(fromLine.Valid, fromLine.X, fromLine.Y, fromLine.DeltaX >> 16, fromLine.DeltaY)
            log(wad.PointOnDivLineSide(vertical, 0, 50 << 16), wad.PointOnDivLineSide(vertical, 1 << 16, 0), wad.PointOnDivLineSide(vertical, -(1 << 16), 0))
            log(wad.PointOnDivLineSide(shiftedHorizontal, 20 << 16, 20 << 16), wad.PointOnDivLineSide(shiftedHorizontal, 19 << 16, 21 << 16))
            log(wad.PointOnDivLineSide(diagonal, 0, 0), wad.PointOnDivLineSide(diagonal, 0, 64 << 16), wad.PointOnDivLineSide(diagonal, 64 << 16, 0))
            log(wad.InterceptVector(trace, crossing), wad.InterceptVector(trace, parallel), wad.PointOnDivLineSide(wad.DivLine{}, 0, 0))
        }
    }
}
`;

try {
    const main = path.join(scratch, "main.flt");
    const output = path.join(scratch, "map.json");
    writeFileSync(main, source);
    const result = spawnSync("dotnet", [cli, "build", main, "--package-root", port, "-o", output], {
        encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
    sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [7, 12], [true, 0, 0, 128, 0], [1, 0, 1], [0, 1], [1, 1, 0], [16384, 0, -1],
    ]);
    console.log("Doom divline helpers passed approximate distance, construction, pinned side-edge behavior, and intercept fractions.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-divlines-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
