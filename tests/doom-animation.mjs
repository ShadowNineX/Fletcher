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
const scratch = mkdtempSync(path.join(artifacts, "doom-animation-"));

function build(entry) {
    const output = path.join(scratch, "output.json");
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output], {
        encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
}

function name(value) {
    const out = Buffer.alloc(8);
    out.write(value);
    return out;
}

function texture(nameValue) {
    const out = Buffer.alloc(22);
    name(nameValue).copy(out);
    out.writeInt16LE(1, 12); out.writeInt16LE(1, 14);
    return out;
}

function textureDirectory(names) {
    const out = Buffer.alloc(4 + names.length * 4 + names.length * 22);
    out.writeInt32LE(names.length, 0);
    let offset = 4 + names.length * 4;
    names.forEach((value, index) => {
        out.writeInt32LE(offset, 4 + index * 4);
        texture(value).copy(out, offset);
        offset += 22;
    });
    return out;
}

function wad(lumps) {
    const directory = 12 + lumps.reduce((size, [, data]) => size + data.length, 0);
    const out = Buffer.alloc(directory + lumps.length * 16);
    out.write("PWAD"); out.writeInt32LE(lumps.length, 4); out.writeInt32LE(directory, 8);
    let offset = 12;
    lumps.forEach(([label, data], index) => {
        const entry = directory + index * 16;
        out.writeInt32LE(offset, entry); out.writeInt32LE(data.length, entry + 4);
        name(label).copy(out, entry + 8); data.copy(out, offset); offset += data.length;
    });
    return out;
}

try {
    const entry = path.join(scratch, "main.flt");
    writeFileSync(entry, `package main
import "wad"
map "Doom animation parity" {
    tick {
        texture := wad.NewTextureAnimation(10, 12)
        flat := wad.NewFlatAnimation(4, 7)
        missing := wad.NewTextureAnimation(-1, -1)
        backwards := wad.NewFlatAnimation(9, 8)
        oneFrame := wad.NewTextureAnimation(3, 3)
        log(texture.Valid, texture.Count, flat.Valid, flat.Count, missing.Valid, backwards.Valid, oneFrame.Valid)
        for time := range 33 {
            log(wad.AnimationTextureIndex(texture, 10, time), wad.AnimationTextureIndex(texture, 11, time),
                wad.AnimationTextureIndex(texture, 12, time), wad.AnimationFlatIndex(flat, 4, time),
                wad.AnimationFlatIndex(flat, 7, time))
        }
        log(wad.AnimationTextureIndex(flat, 4, 8), wad.AnimationFlatIndex(texture, 10, 8))
        log(wad.AnimationTextureIndex(texture, 9, 8), wad.AnimationTextureIndex(missing, 10, 8), wad.AnimationIndex(texture, 10, -1))
    }
}
`);
    const sim = build(entry); sim.step();
    const rows = JSON.parse(JSON.stringify(sim.logs));
    assert.deepEqual(rows[0], [true, 3, true, 4, false, false, false]);
    // Frozen values of Linux Doom 1.10 P_UpdateSpecials for source indices
    // 10..12 and 4..7. The first range proves the original global-index
    // modulo phase (it does not begin with texture 10 at tic zero).
    assert.deepEqual(rows.slice(1, 34), [
        ...Array.from({ length: 8 }, () => [11, 12, 10, 4, 7]),
        ...Array.from({ length: 8 }, () => [12, 10, 11, 5, 4]),
        ...Array.from({ length: 8 }, () => [10, 11, 12, 6, 5]),
        ...Array.from({ length: 8 }, () => [11, 12, 10, 7, 6]),
        [12, 10, 11, 4, 7],
    ]);
    assert.deepEqual(rows.slice(34), [[4, 10], [9, 10, 10]]);

    // A partial archive exposes only two of Doom's 22 built-in cycles. The
    // other 20 must be skipped exactly like the source's optional episode
    // assets, while loaded indices use the original global modulo phase.
    writeFileSync(path.join(scratch, "ANIMS.WAD"), wad([
        ["F_START", Buffer.alloc(0)], ["NUKAGE1", Buffer.alloc(1)], ["NUKAGE2", Buffer.alloc(1)], ["NUKAGE3", Buffer.alloc(1)], ["F_END", Buffer.alloc(0)],
        ["PNAMES", Buffer.alloc(4)], ["TEXTURE1", textureDirectory(["BLODGR1", "BLODGR2", "BLODGR3", "BLODGR4"])],
    ]));
    writeFileSync(entry, `package main
import "wad"
const Archive = readFile("ANIMS.WAD")
map "Doom built-in animations" {
    tick {
        mounts := wad.OpenArchive(Archive)
        animations := wad.LoadAnimations(wad.LoadFlats(mounts), wad.LoadMountedTextureSet(mounts))
        log(animations.Count, wad.AnimatedFlatIndex(animations, 0, 0), wad.AnimatedFlatIndex(animations, 2, 8), wad.AnimatedFlatIndex(animations, 9, 8))
        log(wad.AnimatedTextureIndex(animations, 0, 8), wad.AnimatedTextureIndex(animations, 3, 8), wad.AnimatedTextureIndex(animations, 5, 8))
    }
}
`);
    const builtin = build(entry); builtin.step();
    assert.deepEqual(JSON.parse(JSON.stringify(builtin.logs)), [[2, 0, 0, 9], [1, 0, 5]]);

    // Exercise every animdefs[] endpoint in source order. Each pair encloses
    // an unrelated name to prove that the range uses directory order.
    const flatEndpoints = [
        ["NUKAGE1", "NUKAGE3"], ["FWATER1", "FWATER4"], ["SWATER1", "SWATER4"],
        ["LAVA1", "LAVA4"], ["BLOOD1", "BLOOD3"], ["RROCK05", "RROCK08"],
        ["SLIME01", "SLIME04"], ["SLIME05", "SLIME08"], ["SLIME09", "SLIME12"],
    ];
    const textureEndpoints = [
        ["BLODGR1", "BLODGR4"], ["SLADRIP1", "SLADRIP3"], ["BLODRIP1", "BLODRIP4"],
        ["FIREWALA", "FIREWALL"], ["GSTFONT1", "GSTFONT3"], ["FIRELAV3", "FIRELAVA"],
        ["FIREMAG1", "FIREMAG3"], ["FIREBLU1", "FIREBLU2"], ["ROCKRED1", "ROCKRED3"],
        ["BFALL1", "BFALL4"], ["SFALL1", "SFALL4"], ["WFALL1", "WFALL4"], ["DBRAIN1", "DBRAIN4"],
    ];
    const expand = (pairs) => pairs.flatMap(([start, end], i) => [start, `FRAME${i}`, end]);
    const flatNames = expand(flatEndpoints);
    const textureNames = ["VOID", ...expand(textureEndpoints)];
    textureNames[4] = "sladrip1"; // Texture matching is case-insensitive.
    writeFileSync(path.join(scratch, "ANIMS.WAD"), wad([
        ["F_START", Buffer.alloc(0)], ...flatNames.map(label => [label, Buffer.alloc(1)]), ["F_END", Buffer.alloc(0)],
        ["PNAMES", Buffer.alloc(4)], ["TEXTURE1", textureDirectory(textureNames.slice(0, 6))],
        ["TEXTURE2", textureDirectory(textureNames.slice(6))],
    ]));
    writeFileSync(entry, `package main
import "wad"
const Archive = readFile("ANIMS.WAD")
map "All Doom animation ranges" {
    tick {
        mounts := wad.OpenArchive(Archive)
        animations := wad.LoadAnimations(wad.LoadFlats(mounts), wad.LoadMountedTextureSet(mounts))
        log(animations.Count)
        for index := range animations.Count {
            cycle := animations.Ranges[index]
            log(cycle.Texture, cycle.Base, cycle.Last, cycle.Count)
        }
    }
}
`);
    const complete = build(entry); complete.step();
    assert.deepEqual(JSON.parse(JSON.stringify(complete.logs)), [
        [22],
        ...flatEndpoints.map((_, i) => [false, i * 3, i * 3 + 2, 3]),
        ...textureEndpoints.map((_, i) => [true, i * 3 + 1, i * 3 + 3, 3]),
    ]);
    console.log("Doom texture and flat animation parity passed for all 22 built-in ranges.");
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
