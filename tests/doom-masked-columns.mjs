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
const scratch = mkdtempSync(path.join(artifacts, "doom-masked-columns-"));

function build(entry) {
    const output = path.join(scratch, "output.json");
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output], { encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
}

try {
    const patch = Buffer.alloc(25);
    patch.writeInt16LE(2, 0); patch.writeInt16LE(4, 2);
    patch.writeUInt32LE(16, 8); patch.writeUInt32LE(17, 12);
    patch[16] = 255;
    patch.set([1, 2, 0, 9, 10, 0, 255], 17);
    const brokenDirectory = Buffer.from(patch); brokenDirectory.writeUInt32LE(8, 8);
    const brokenPosts = Buffer.from(patch); brokenPosts[23] = 0;
    writeFileSync(path.join(scratch, "PATCH.BIN"), patch);
    writeFileSync(path.join(scratch, "DIRECTORY.BIN"), brokenDirectory);
    writeFileSync(path.join(scratch, "POSTS.BIN"), brokenPosts);
    const entry = path.join(scratch, "main.flt");
    writeFileSync(entry, `package main
import "wad"
const Bytes = readFile("PATCH.BIN")
const Directory = readFile("DIRECTORY.BIN")
const Posts = readFile("POSTS.BIN")
func lump(file bytes) wad.LumpRef { return wad.LumpRef{File: file, Size: len(file), Valid: true} }
map "Doom masked columns" {
    tick {
        patch := lump(Bytes)
        empty := wad.PatchPostSource(patch, 0)
        filled := wad.PatchPostSource(patch, 1)
        sheet := wad.TextureSheet{Patch: patch, OriginX: 4, Width: 2, Height: 4, Valid: true}
        wall := wad.TextureSheetPostSource(sheet, 5)
        outside := wad.TextureSheetPostSource(sheet, 6)
        badDirectory := wad.PatchPostSource(lump(Directory), 0)
        badPosts := wad.PatchPostSource(lump(Posts), 1)
        log(empty.Valid, empty.Offset, int(empty.Patch.File[empty.Offset]))
        log(filled.Valid, filled.Offset, int(filled.Patch.File[filled.Offset]), int(filled.Patch.File[filled.Offset + 3]))
        log(wall.Valid, wall.Offset, outside.Valid, badDirectory.Valid, badPosts.Valid)
    }
}
`);
    const sim = build(entry);
    sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [true, 16, 255],
        [true, 17, 1, 9],
        [true, 17, false, false, false],
    ]);
    console.log("Doom masked patch-column directory, transparent, and malformed-stream checks passed.");
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
