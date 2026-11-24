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
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-line-sides-"));

const source = `package main

import "engine"
import "wad"

map "Doom collision side parity" {
    tick {
        if currentTick() == 0 {
            vertical := wad.CollisionLine{Valid: true, First: engine.Vertex{X: 0, Y: 0}, DeltaY: 128 << 16, Slope: wad.LineSlopeVertical}
            horizontal := wad.CollisionLine{Valid: true, First: engine.Vertex{X: 0, Y: 0}, DeltaX: 128 << 16, Slope: wad.LineSlopeHorizontal}
            positive := wad.CollisionLine{Valid: true, First: engine.Vertex{X: 0, Y: 0}, DeltaX: 128 << 16, DeltaY: 128 << 16, Slope: wad.LineSlopePositive}
            negative := wad.CollisionLine{Valid: true, First: engine.Vertex{X: 0, Y: 0}, DeltaX: 128 << 16, DeltaY: -(128 << 16), Slope: wad.LineSlopeNegative}
            invalid := wad.CollisionLine{}
            log(wad.PointOnCollisionLineSide(vertical, 0, 0), wad.PointOnCollisionLineSide(vertical, 1 << 16, 0), wad.PointOnCollisionLineSide(vertical, -(1 << 16), 0))
            log(wad.PointOnCollisionLineSide(horizontal, 0, 0), wad.PointOnCollisionLineSide(horizontal, 0, 1 << 16), wad.PointOnCollisionLineSide(horizontal, 0, -(1 << 16)))
            log(wad.PointOnCollisionLineSide(positive, 0, 128 << 16), wad.PointOnCollisionLineSide(positive, 128 << 16, 0), wad.PointOnCollisionLineSide(negative, 0, -(128 << 16)))
            straddleH := engine.Box{Top: 10 << 16, Bottom: -(10 << 16), Left: 0, Right: 20 << 16}
            above := engine.Box{Top: 30 << 16, Bottom: 10 << 16, Left: 0, Right: 20 << 16}
            straddleV := engine.Box{Top: 20 << 16, Bottom: 0, Left: -(10 << 16), Right: 10 << 16}
            left := engine.Box{Top: 20 << 16, Bottom: 0, Left: -(30 << 16), Right: -(10 << 16)}
            log(wad.BoxOnCollisionLineSide(horizontal, straddleH), wad.BoxOnCollisionLineSide(horizontal, above), wad.BoxOnCollisionLineSide(vertical, straddleV), wad.BoxOnCollisionLineSide(vertical, left))
            log(wad.PointOnCollisionLineSide(invalid, 0, 0), wad.BoxOnCollisionLineSide(invalid, straddleH))
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
        [1, 0, 1], [0, 1, 0], [1, 0, 0], [-1, 1, -1, 1], [-1, -1],
    ]);
    console.log("Doom line-side helpers passed axis ties, diagonal fixed-point sides, box straddles, and invalid-line guards.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-line-sides-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
