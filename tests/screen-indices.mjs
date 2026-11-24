import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "src", "Fletcher.Cli", "bin", "Debug", "net11.0", "fletcher.dll");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-screen-indices-"));

try {
    const source = path.join(scratch, "indices.flt"), output = path.join(scratch, "indices.json");
    writeFileSync(source, `
map "Indexed framebuffer" {
    screen at (0, 0) size (5, 1) with { style = "solid", hold = true }
    tick {
        if currentTick() == 0 {
            pixel(0, 0, true, color.Red, 112)
            pixel(1, 0, true, color.Blue, 255)
            pixel(2, 0, true, color.Blue, 10)
            pixel(2, 0, true, color.Green, 256)
            pixel(3, 0, true, color.Green, 11)
            pixel(3, 0, false, color.White, 7)
            pixel(4, 0, true, color.Green, 12)
            pixel(4, 0, true, color.Green)
        }
        log(pixelIndexAt(0, 0), pixelIndexAt(1, 0), pixelIndexAt(2, 0), pixelIndexAt(3, 0),
            pixelIndexAt(4, 0), pixelIndexAt(-1, 0))
    }
}
`);
    const built = spawnSync("dotnet", [cli, "build", source, "-o", output], { cwd: root, encoding: "utf8", timeout: 30_000 });
    if (built.error) throw built.error;
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    const sim = simulator(decode(encoded));
    sim.step();
    sim.step();
    assert.deepEqual(sim.logs, [[112, 255, -1, -1, -1, -1], [-1, -1, -1, -1, -1, -1]],
        "ordinary, off, and out-of-range writes clear any earlier index");
    const slicedSource = path.join(scratch, "sliced.flt"), slicedOutput = path.join(scratch, "sliced.json");
    writeFileSync(slicedSource, `
map "Sliced indexed framebuffer" {
    screen at (0, 0) size (128, 96) with { style = "solid", slice = true }
    input mark bit at (129, 0) with { key = "W" }
    tick {
        if mark { pixel(0, 0, true, color.Red, 42) }
        for index := range 30_000 { }
        log(pixelIndexAt(0, 0))
    }
}
`);
    const slicedBuild = spawnSync("dotnet", [cli, "build", slicedSource, "-o", slicedOutput], { cwd: root, encoding: "utf8", timeout: 30_000 });
    if (slicedBuild.error) throw slicedBuild.error;
    assert.equal(slicedBuild.status, 0, slicedBuild.stderr || slicedBuild.stdout);
    const data = JSON.parse(readFileSync(slicedOutput, "utf8")).data;
    const sliced = simulator(decode(data), true);
    sliced.step([], new Map(), [23]);
    assert.deepEqual(sliced.logs, [], "the tick suspends after drawing and before publication");
    for (let host = 1; host < 12 && sliced.logs.length < 2; host++) sliced.step();
    assert.deepEqual(sliced.logs, [[42], [-1]], "sliced frames retain indexes across yields and reset at each logical tick");

    const interrupted = simulator(decode(data), true);
    interrupted.step([], new Map(), [23]);
    interrupted.setTick(10);
    for (let host = 0; host < 12 && interrupted.logs.length === 0; host++) interrupted.step();
    assert.deepEqual(interrupted.logs, [[-1]], "discarding the frame also discards its source indexes");
    console.log("Indexed solid-screen pixels retain current-frame source values and reset on the next frame.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-screen-indices-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
