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
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-wad-index-"));

function wad(lumps, signature = "PWAD") {
    const directory = 12 + lumps.reduce((size, [, data]) => size + data.length, 0);
    const file = Buffer.alloc(directory + lumps.length * 16);
    file.write(signature); file.writeInt32LE(lumps.length, 4); file.writeInt32LE(directory, 8);
    let offset = 12;
    for (const [index, [name, data]] of lumps.entries()) {
        const entry = directory + index * 16;
        file.writeInt32LE(data.length ? offset : 0, entry);
        file.writeInt32LE(data.length, entry + 4);
        file.write(name, entry + 8, 8);
        data.copy(file, offset); offset += data.length;
    }
    return file;
}
function key(name) {
    const bytes = Buffer.alloc(8); bytes.write(name);
    return `wad.LumpName{Low: ${bytes.readInt32LE()}, High: ${bytes.readInt32LE(4)}}`;
}

function crowdedLumps() {
    const result = [];
    const bytes = Buffer.alloc(8);
    for (let i = 0; i < 1_000_000 && result.length < 33; i++) {
        const name = `C${String(i).padStart(7, "0")}`;
        bytes.write(name);
        let hash = Math.imul(bytes.readInt32LE(), 0x9e3779b1) ^ Math.imul(bytes.readInt32LE(4), 0x85ebca6b);
        hash = Math.imul(hash ^ (hash >>> 16), 0xc2b2ae35);
        if (((hash ^ (hash >>> 16)) & 8191) === 0) result.push([name, Buffer.from([result.length])]);
    }
    assert.equal(result.length, 33, "fixture needs a chain past the probe limit");
    return result;
}

const baseLumps = [["PADDING", Buffer.alloc(44_985, 0xa5)], ["EDGE", Buffer.from([66, 77, 88, 99])], ...Array.from({ length: 218 }, (_, index) => {
    const name = index === 127 ? "SEAM" : index === 128 ? "CASEPAD\0" : index === 129 ? "lower\0" : `L${String(index).padStart(6, "0")}`;
    return [name, Buffer.from([index & 255])];
})];
baseLumps[4] = ["DUP", Buffer.from([4])];
baseLumps[219] = ["BADWIN", Buffer.from([219])];
const addonLumps = [["DUP", Buffer.from([240])], ["SEAM", Buffer.from([241])], ["BADWIN", Buffer.from([242])]];
const broken = wad(addonLumps);
const brokenDirectory = broken.readInt32LE(8);
broken.writeInt32LE(broken.length + 5, brokenDirectory + 2 * 16);
writeFileSync(path.join(scratch, "BASE.WAD"), wad(baseLumps, "IWAD"));
writeFileSync(path.join(scratch, "ADDON.WAD"), wad(addonLumps));
writeFileSync(path.join(scratch, "BROKEN.WAD"), broken);
writeFileSync(path.join(scratch, "LOOSE.BIN"), Buffer.from([250]));
const crowded = crowdedLumps();
const exactCollision = ["SV1YHMM6", "Y8FRVVWE"];
const fullHash = name => {
    const bytes = Buffer.from(name);
    let hash = Math.imul(bytes.readInt32LE(), 0x9e3779b1) ^ Math.imul(bytes.readInt32LE(4), 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 16), 0xc2b2ae35);
    return (hash ^ (hash >>> 16)) >>> 0;
};
assert.equal(fullHash(exactCollision[0]), fullHash(exactCollision[1]));
writeFileSync(path.join(scratch, "CROWDED.WAD"), wad(crowded));
const large = [
    ...exactCollision.map((name, index) => [name, Buffer.from([200 + index])]),
    ...Array.from({ length: 9000 }, (_, index) => [`L${String(index).padStart(7, "0")}`, Buffer.from([index & 255])]),
    ["TAIL", Buffer.from([209])], ["TAIL", Buffer.from([210])],
];
writeFileSync(path.join(scratch, "LARGE.WAD"), wad(large));

const source = `package main
import "wad"
const Base = readFile("BASE.WAD")
const Addon = readFile("ADDON.WAD")
const Broken = readFile("BROKEN.WAD")
const Loose = readFile("LOOSE.BIN")
const Crowded = readFile("CROWDED.WAD")
const Large = readFile("LARGE.WAD")
map "WAD index parity" {
    register mounts wad.Archives = wad.Archives{}
    register snapshot wad.Archives = wad.Archives{}
    tick {
        if currentTick() < 20 {
            frame := mounts
            if currentTick() == 0 { frame = wad.OpenArchive(Base) }
            if currentTick() == 7 { frame = wad.AddArchive(frame, Addon) }
            frame = frame.BuildIndex(17)
            dup := frame.Find(${key("dup")})
            seam := frame.Find(${key("seam")})
            padded := frame.Find(${key("casepad")})
            lower := frame.Find(${key("LOWER")})
            missing := frame.Find(${key("missing")})
            log(currentTick(), frame.IndexReady(), dup.Valid, dup.File[dup.Offset], seam.Valid,
                seam.File[seam.Offset], padded.Valid, padded.File[padded.Offset], lower.Found, missing.Found)
            if currentTick() == 0 || currentTick() == 13 {
                edge := frame.Find(${key("edge")})
                log(edge.Index, edge.Offset, edge.File[edge.Offset], edge.File[edge.Offset + 1],
                    edge.File[edge.Offset + 2], edge.File[edge.Offset + 3])
            }
            if currentTick() == 13 { next snapshot = frame }
            if currentTick() == 14 {
                frame = wad.AddLooseLump(frame, Loose, ${key("dup")})
                pending := frame.Find(${key("dup")})
                ready := frame.IndexReady()
                frame = frame.BuildIndex(17)
                loose := frame.Find(${key("dup")})
                old := snapshot.Find(${key("dup")})
                log(ready, pending.File[pending.Offset], frame.IndexReady(), loose.File[loose.Offset], old.File[old.Offset])
            }
            if currentTick() == 16 {
                bad := wad.AddArchive(frame, Broken).BuildIndex(17)
                winner := bad.Find(${key("badwin")})
                log(bad.IndexReady(), winner.Found, winner.Valid, winner.Index, frame.Find(${key("badwin")}).Valid)
            }
            next mounts = frame
        } else if currentTick() == 20 {
            next mounts = wad.OpenArchive(Crowded).BuildIndex(16)
        } else if currentTick() == 21 {
            frame := mounts.BuildIndex(16)
            log(frame.CanIndex(), frame.IndexReady(), frame.Find(${key(crowded.at(-1)[0])}).Index)
            next mounts = frame
        } else if currentTick() == 22 {
            frame := mounts.BuildIndex(16)
            log(frame.CanIndex(), frame.IndexReady(), frame.Find(${key(crowded.at(-1)[0])}).Index,
                frame.Find(${key(crowded[0][0])}).Index)
            next mounts = frame
        } else if currentTick() == 23 {
            updated := wad.AddLooseLump(mounts, Loose, ${key(crowded[1][0])}).BuildIndex(16)
            new := updated.Find(${key(crowded[1][0])})
            old := mounts.Find(${key(crowded[1][0])})
            log(updated.IndexReady(), new.Index, new.File[new.Offset], old.Index, old.File[old.Offset])
        } else if currentTick() == 24 {
            large := wad.OpenArchive(Large).BuildIndex(17)
            log(large.CanIndex(), large.IndexReady(), large.Find(${key("TAIL")}).Index)
            next mounts = large
        } else if !mounts.IndexReady() {
            frame := mounts.BuildIndex(257)
            if frame.IndexReady() {
                first, second := frame.Find(${key(exactCollision[0])}), frame.Find(${key(exactCollision[1])})
                tail := frame.Find(${key("TAIL")})
                log(frame.CanIndex(), frame.IndexReady(), first.Index, second.Index, tail.Index, tail.File[tail.Offset])
            }
            next mounts = frame
        } else if currentTick() == 60 {
            matched := 0
            for index := range ${large.length - 2} {
                ref := mounts.LumpAt(index)
                if mounts.Find(ref.Name).Index == index { matched = matched + 1 }
            }
            log(matched, mounts.Find(${key("MISSING")}).Found)
        }
    }
}
`;

try {
    const entry = path.join(scratch, "main.flt");
    const output = path.join(scratch, "index.json");
    writeFileSync(entry, source);
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output], {
        encoding: "utf8", cwd: root, timeout: 20_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    const wrapper = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(Buffer.from(wrapper.data, "base64")[2], 1);
    const sim = simulator(decode(wrapper.data), true);
    for (let tic = 0; tic <= 60; tic++) sim.step();
    const logs = JSON.parse(JSON.stringify(sim.logs));
    const expected = [];
    for (let tic = 0; tic < 20; tic++) {
        const duplicate = tic < 7 ? 4 : tic <= 14 ? 240 : 250;
        expected.push([tic, tic >= 13, true, duplicate, true, tic < 7 ? 127 : 241, true, 128, false, false]);
        if (tic === 0 || tic === 13) expected.push([1, 44_997, 66, 77, 88, 99]);
        if (tic === 14) expected.push([false, 250, true, 250, 240]);
        if (tic === 16) expected.push([true, true, false, 226, true]);
    }
    expected.push([true, false, 32], [true, true, 32, 0], [true, 33, 250, 1, 1],
        [true, false, large.length - 1], [true, true, 0, 1, large.length - 1, 210], [large.length - 2, false]);
    assert.deepEqual(logs, expected);
    console.log(`WAD index parity passed layered overrides, exact hash collisions, snapshots, and ${large.length} entries.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-wad-index-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
