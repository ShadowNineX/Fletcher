import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(path.join(artifacts, "doom-sprite-project-"));

function build(entry) {
    const output = path.join(scratch, "output.json");
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output], { encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
}

try {
    const patches = Buffer.alloc(16);
    patches.writeInt16LE(16, 0); patches.writeInt16LE(8, 4); patches.writeInt16LE(20, 6);
    patches.writeInt16LE(32, 8); patches.writeInt16LE(16, 12); patches.writeInt16LE(24, 14);
    writeFileSync(path.join(scratch, "PATCHES.BIN"), patches);
    const entry = path.join(scratch, "main.flt");
    writeFileSync(entry, `package main
import "engine"
import "sprites"
import "wad"
const Patches = readFile("PATCHES.BIN")
const Unit = engine.FracUnit
func patch(offset int) wad.LumpRef { return wad.LumpRef{File: Patches, Offset: offset, Size: 8, Valid: true} }
func direct() wad.SpriteFrame {
    frame := wad.SpriteFrame{Valid: true}
    for i := range 8 { frame.Filled[i], frame.Lumps[i] = true, patch(0) }
    return frame
}
func rotated() wad.SpriteFrame {
    frame := wad.SpriteFrame{Valid: true, Rotate: true}
    for i := range 8 { frame.Filled[i], frame.Lumps[i] = true, patch(0) }
    frame.Lumps[4], frame.Flips[4] = patch(8), true
    return frame
}
map "Doom sprite projection" {
    tick {
        camera := engine.Camera{View: engine.NewViewProjection(128)}
        first := sprites.ProjectSprite(camera, sprites.SpriteActor{X: 128 * Unit, Z: 3 * Unit, Light: 160}, direct())
        rotatedSprite := sprites.ProjectSprite(camera, sprites.SpriteActor{X: 128 * Unit, Heading: 0, Z: 3 * Unit, Light: 160}, rotated())
        behind := sprites.ProjectSprite(camera, sprites.SpriteActor{X: -128 * Unit}, direct())
        side := sprites.ProjectSprite(camera, sprites.SpriteActor{X: 128 * Unit, Y: 600 * Unit}, direct())
        bright := sprites.ProjectSprite(camera, sprites.SpriteActor{X: 128 * Unit, FullBright: true, Light: 0}, direct())
        turned := sprites.ProjectSprite(engine.Camera{View: engine.NewViewProjection(128), Heading: 0x20000000}, sprites.SpriteActor{X: 128 * Unit, Y: 32 * Unit, Z: Unit, Light: 160}, direct())
        log(first.Valid, first.Span.First, first.Span.End, first.Scale, first.StartFrac, first.XStep, first.TextureMid, first.TopZ, first.LightRow, first.Patch.Offset)
        log(rotatedSprite.Valid, rotatedSprite.Span.First, rotatedSprite.Span.End, rotatedSprite.Scale, rotatedSprite.StartFrac, rotatedSprite.XStep, rotatedSprite.TextureMid, rotatedSprite.TopZ, rotatedSprite.LightRow, rotatedSprite.Patch.Offset)
        log(behind.Valid, behind.Span.First, behind.Span.End, behind.Scale, behind.StartFrac, behind.XStep, behind.TextureMid, behind.TopZ, behind.LightRow, behind.Patch.Offset)
        log(side.Valid, side.Span.First, side.Span.End, side.Scale, side.StartFrac, side.XStep, side.TextureMid, side.TopZ, side.LightRow, side.Patch.Offset)
        log(bright.Valid, bright.Span.First, bright.Span.End, bright.Scale, bright.StartFrac, bright.XStep, bright.TextureMid, bright.TopZ, bright.LightRow, bright.Patch.Offset)
        log(turned.Valid, turned.Span.First, turned.Span.End, turned.Scale, turned.StartFrac, turned.XStep, turned.TextureMid, turned.TopZ, turned.LightRow, turned.Patch.Offset)
    }
}
`);
    const sim = build(entry); sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [true, 60, 68, 32768, 0, 131072, 1507328, 1507328, 10, 0],
        [true, 56, 72, 32768, 2097151, -131072, 1769472, 1769472, 10, 8],
        [false, 0, 0, 0, 0, 0, 0, 0, 0, 0], [false, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [true, 60, 68, 32768, 0, 131072, 1310720, 1310720, 0, 0],
        [true, 97, 106, 37081, 0, 115826, 1376256, 1376256, 9, 0],
    ]);
    console.log("Doom sprite projection rotation, flipping, scale, clip, lighting, and culling parity passed.");
} finally { rmSync(scratch, { recursive: true, force: true }); }
