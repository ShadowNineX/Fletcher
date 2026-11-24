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
const scratch = mkdtempSync(path.join(artifacts, "doom-sprite-frames-"));

function name(value) { const out = Buffer.alloc(8); out.write(value); return out; }
function patch(bad = false) {
    const out = Buffer.alloc(17); out.writeInt16LE(1, 0); out.writeInt16LE(1, 2); out.writeUInt32LE(bad ? 8 : 12, 8);
    if (!bad) { out[12] = 0; out[13] = 1; out[15] = 1; out[16] = 255; }
    return out;
}
function wad(lumps) {
    const directory = 12 + lumps.reduce((total, [, data]) => total + data.length, 0), out = Buffer.alloc(directory + lumps.length * 16);
    out.write("PWAD"); out.writeInt32LE(lumps.length, 4); out.writeInt32LE(directory, 8);
    let cursor = 12;
    lumps.forEach(([label, data], index) => { const entry = directory + index * 16; out.writeInt32LE(cursor, entry); out.writeInt32LE(data.length, entry + 4); name(label).copy(out, entry + 8); data.copy(out, cursor); cursor += data.length; });
    return out;
}
function build(entry) {
    const output = path.join(scratch, "output.json");
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output], { encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
}

try {
    const lumps = [["S_START", Buffer.alloc(0)], ["TROOA0", patch()]];
    for (let rotation = 1; rotation <= 8; rotation++) {
        lumps.push([`ROTAA${rotation}`, patch()]);
        // Both prefixes hash to bucket 1016, and their entries interleave.
        if (rotation === 4) lumps.push(["YJBAA0", patch()]);
    }
    lumps.push(["DUALA0B0", patch()], ["DUPLA0", patch()], ["DUPLA0", patch()], ["MISSA1", patch()], ["BADDA0", patch(true)], ["S_END", Buffer.alloc(0)]);
    writeFileSync(path.join(scratch, "SPRITES.WAD"), wad(lumps));
    writeFileSync(path.join(scratch, "OVERRIDE.bin"), patch());
    writeFileSync(path.join(scratch, "NEWSPR.WAD"), wad([["S_START", Buffer.alloc(0)], ["NEWAA0", patch()], ["S_END", Buffer.alloc(0)]]));
    const entry = path.join(scratch, "main.flt");
    writeFileSync(entry, `package main
import "wad"
const Archive = readFile("SPRITES.WAD")
const Override = readFile("OVERRIDE.bin")
const NewSprites = readFile("NEWSPR.WAD")
func sprite(low int) wad.LumpName { return wad.LumpName{Low: low} }
func sameSprite(left wad.SpriteDef, right wad.SpriteDef) bit {
    if left.Valid != right.Valid || left.FrameCount != right.FrameCount { return false }
    for frame := range left.FrameCount {
        a, b := wad.SpriteFrameAt(left, frame), wad.SpriteFrameAt(right, frame)
        if a.Valid != b.Valid || a.Rotate != b.Rotate { return false }
        for rotation := range 8 {
            x, y := wad.SpriteLumpAt(a, rotation), wad.SpriteLumpAt(b, rotation)
            if x.Valid != y.Valid || x.Flip != y.Flip { return false }
            if x.Valid && (x.Patch.Index != y.Patch.Index || !sameFile(x.Patch.File, y.Patch.File)) { return false }
        }
    }
    return true
}
map "Doom sprite frames" {
    tick {
        mounts := wad.OpenArchive(Archive)
        troo := wad.LoadSprite(mounts, sprite(0x4f4f5254))
        rota := wad.LoadSprite(mounts, sprite(0x41544f52))
        dual := wad.LoadSprite(mounts, sprite(0x4c415544))
        dupe := wad.LoadSprite(mounts, sprite(0x4c505544))
        missing := wad.LoadSprite(mounts, sprite(0x5353494d))
        bad := wad.LoadSprite(mounts, sprite(0x44444142))
        one := wad.SpriteFrameAt(troo, 0)
        rotating := wad.SpriteFrameAt(rota, 0)
        flip := wad.SpriteFrameAt(dual, 1)
        log(troo.Valid, troo.FrameCount, one.Valid, one.Rotate, wad.SpriteLumpAt(one, 7).Valid, wad.SpriteLumpAt(one, 7).Flip)
        log(rota.Valid, rotating.Valid, rotating.Rotate, wad.SpriteLumpAt(rotating, 0).Valid, wad.SpriteLumpAt(rotating, 7).Valid)
        log(dual.Valid, dual.FrameCount, wad.SpriteLumpAt(wad.SpriteFrameAt(dual, 0), 0).Flip, flip.Valid, wad.SpriteLumpAt(flip, 3).Flip)
        log(dupe.Valid, missing.Valid, bad.Valid, wad.SpriteFrameAt(troo, 1).Valid)

        incompleteDirectory := mounts.BuildIndex(1).BuildSpriteIndex(2)
        completeDirectory := mounts.BuildIndex(64)
        incompleteSprites := completeDirectory.BuildSpriteIndex(1)
        indexed := incompleteSprites.BuildSpriteIndex(64)
        log(mounts.SpriteIndexReady(), incompleteDirectory.IndexReady(), incompleteDirectory.SpriteIndexReady(),
            completeDirectory.IndexReady(), incompleteSprites.SpriteIndexReady(), indexed.SpriteIndexReady())
        log(sameSprite(troo, wad.LoadSprite(incompleteDirectory, sprite(0x4f4f5254))),
            sameSprite(rota, wad.LoadSprite(incompleteSprites, sprite(0x41544f52))),
            sameSprite(dual, wad.LoadSprite(incompleteSprites, sprite(0x4c415544))),
            sameSprite(troo, wad.LoadSprite(indexed, sprite(0x4f4f5254))),
            sameSprite(rota, wad.LoadSprite(indexed, sprite(0x41544f52))),
            sameSprite(dual, wad.LoadSprite(indexed, sprite(0x4c415544))),
            sameSprite(dupe, wad.LoadSprite(indexed, sprite(0x4c505544))),
            sameSprite(missing, wad.LoadSprite(indexed, sprite(0x5353494d))),
            sameSprite(bad, wad.LoadSprite(indexed, sprite(0x44444142))))
        collision := wad.LoadSprite(indexed, sprite(0x41424a59))
        log(collision.Valid, collision.FrameCount, sameSprite(collision, wad.LoadSprite(mounts, sprite(0x41424a59))))

        overridden := wad.AddLooseLump(indexed, Override, wad.LumpName{Low: 0x4c415544, High: 0x30423041})
        beforeOverride := wad.LoadSprite(overridden, sprite(0x4c415544))
        reindexedOverride := overridden.BuildIndex(64).BuildSpriteIndex(64)
        afterOverride := wad.LoadSprite(reindexedOverride, sprite(0x4c415544))
        primary := wad.SpriteLumpAt(wad.SpriteFrameAt(afterOverride, 0), 0)
        mirrored := wad.SpriteLumpAt(wad.SpriteFrameAt(afterOverride, 1), 3)
        log(overridden.SpriteIndexReady(), reindexedOverride.SpriteIndexReady(), sameSprite(beforeOverride, afterOverride),
            sameFile(primary.Patch.File, Override), primary.Flip, sameFile(mirrored.Patch.File, Archive), mirrored.Flip)

        expanded := wad.AddArchive(indexed, NewSprites)
        beforeNew := wad.LoadSprite(expanded, sprite(0x4157454e))
        reindexedNew := expanded.BuildIndex(64).BuildSpriteIndex(64)
        afterNew := wad.LoadSprite(reindexedNew, sprite(0x4157454e))
        log(expanded.SpriteIndexReady(), reindexedNew.SpriteIndexReady(), sameSprite(beforeNew, afterNew), afterNew.Valid,
            wad.SpriteLumpAt(wad.SpriteFrameAt(afterNew, 0), 0).Valid, wad.LoadSprite(reindexedNew, sprite(0x4f4f5254)).Valid)
    }
}
`);
    const sim = build(entry); sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [true, 1, true, false, true, false], [true, true, true, true, true],
        [true, 2, false, true, true], [false, false, false, false],
        [false, false, false, true, false, true], [true, true, true, true, true, true, true, true, true], [true, 1, true],
        [false, true, true, true, false, true, true], [false, true, true, true, true, false],
    ]);
    console.log("Doom sprite-frame legacy/indexed parity, staged indexes, overrides, reindexing, and malformed checks passed.");
} finally { rmSync(scratch, { recursive: true, force: true }); }
