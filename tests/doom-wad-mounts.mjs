import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const oracle = process.argv[3] ? path.resolve(root, process.argv[3]) : null;
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-mounts-"));
const empty = Buffer.alloc(0);

function encodeWad(signature, lumps) {
    const directory = 12 + lumps.reduce((length, [, data]) => length + data.length, 0);
    const file = Buffer.alloc(directory + lumps.length * 16);
    file.write(signature);
    file.writeInt32LE(lumps.length, 4);
    file.writeInt32LE(directory, 8);
    let offset = 12;
    for (const [index, [name, data]] of lumps.entries()) {
        const entry = directory + index * 16;
        file.writeInt32LE(data.length === 0 ? 0 : offset, entry);
        file.writeInt32LE(data.length, entry + 4);
        file.write(name, entry + 8, 8);
        data.copy(file, offset);
        offset += data.length;
    }
    return file;
}

function level(startX) {
    const thing = Buffer.alloc(10);
    const blockmap = Buffer.alloc(14);
    [0, 0, 1, 1, 5, 0, 0xffff].forEach((word, i) => blockmap.writeUInt16LE(word, i * 2));
    thing.writeInt16LE(startX, 0);
    thing.writeInt16LE(1, 6);
    return [
        ["LAB01", empty], ["THINGS", thing], ["LINEDEFS", Buffer.alloc(14)],
        ["SIDEDEFS", Buffer.alloc(30)], ["VERTEXES", Buffer.alloc(8)], ["SEGS", Buffer.alloc(12)],
        ["SSECTORS", Buffer.from([1, 0, 0, 0])], ["NODES", empty], ["SECTORS", Buffer.alloc(26)],
        ["REJECT", Buffer.from([Number(startX === 7)])], ["BLOCKMAP", blockmap],
    ];
}

function key(name) {
    const words = Buffer.alloc(8);
    words.write(name);
    return `wad.LumpName{Low: ${words.readInt32LE()}, High: ${words.readInt32LE(4)}}`;
}

try {
    const edge = [66, 77, 88, 99];
    const base = encodeWad("IWAD", [
        ["PADDING", Buffer.alloc(44_985, 0xa5)], ["EDGE", Buffer.from(edge)],
        ["DUP", Buffer.from([10])], ["DUP", Buffer.from([22])], ["PAD\0TAIL", Buffer.from([52])],
        ["FULLNAME", Buffer.from([75])], ...level(1),
    ]);
    const addon = encodeWad("PWAD", [["DUP", Buffer.from([33])], ["ONLY", Buffer.from([42])], ...level(7)]);
    const broken = Buffer.from(addon);
    broken.writeInt32LE(broken.length + 1, broken.readInt32LE(8)); // The winning DUP extent is invalid.
    writeFileSync(path.join(scratch, "BASE.WAD"), base);
    writeFileSync(path.join(scratch, "ADDON.WAD"), addon);
    writeFileSync(path.join(scratch, "BROKEN.WAD"), broken);
    writeFileSync(path.join(scratch, "PARTIAL.WAD"), encodeWad("PWAD", [["LAB01", empty]]));
    writeFileSync(path.join(scratch, "EMPTY.WAD"), encodeWad("PWAD", []));
    writeFileSync(path.join(scratch, "BADHEADER.WAD"), base.subarray(0, 12));
    writeFileSync(path.join(scratch, "DUP.lmp"), Buffer.from([44]));

    const source = path.join(scratch, "main.flt");
    writeFileSync(source, `package main
import "wad"

const Base = readFile("BASE.WAD")
const Addon = readFile("ADDON.WAD")
const Broken = readFile("BROKEN.WAD")
const Partial = readFile("PARTIAL.WAD")
const Empty = readFile("EMPTY.WAD")
const BadHeader = readFile("BADHEADER.WAD")
const Loose = readFile("DUP.lmp")

map "Mounted WAD lookup parity" {
    tick {
        duplicate := ${key("dup")}
        levelName := ${key("lab01")}
        base := wad.OpenArchive(Base)
        combined := wad.AddArchive(base, Addon)
        all := wad.AddLooseLump(wad.AddArchive(combined, Empty), Loose, duplicate)
        if currentTick() == 0 {
            first := base.Find(duplicate)
            last := combined.Find(duplicate)
            loose := all.Find(duplicate)
            log(base.LumpCount(), combined.LumpCount(), all.LumpCount())
            log(first.Index, last.Index, loose.Index, first.File[first.Offset], last.File[last.Offset], loose.File[loose.Offset])
            original := all.LumpAt(first.Index)
            log(original.File[original.Offset], all.LumpAt(30).Index, all.LumpAt(-1).Found, all.LumpAt(31).Found)
            seam := all.Find(${key("edge")})
            log(seam.Index, seam.Offset, seam.Size, seam.File[seam.Offset], seam.File[seam.Offset + 1],
                seam.File[seam.Offset + 2], seam.File[seam.Offset + 3])
            pad := all.Find(${key("PaD")})
            full := all.Find(${key("fullNAME")})
            log(pad.Index, pad.File[pad.Offset], full.Index, full.File[full.Offset], all.Find(${key("missing")}).Index)
        } else if currentTick() == 1 {
            original := wad.LoadMountedLevel(base, levelName)
            replacement := wad.LoadMountedLevel(all, levelName)
            log(base.Find(levelName).Index, all.Find(levelName).Index, original.FindPlayerStart(1).X, replacement.FindPlayerStart(1).X)
            mark := all.Find(levelName)
            log(mark.Valid, mark.Size, mark.Offset)
            broken := wad.AddArchive(base, Broken).Find(duplicate)
            log(broken.Found, broken.Valid, broken.Index)
            log(wad.LoadMountedLevel(wad.AddArchive(base, Partial), levelName).Valid,
                wad.LoadMountedLevel(wad.AddLooseLump(all, Loose, levelName), levelName).Valid)
            log(wad.AddArchive(base, BadHeader).Failed)
            spatial := wad.LoadBlockMap(replacement)
            cell := wad.BlockCellAt(spatial, 0, 0)
            start := wad.BlockLineListStart(replacement, spatial, cell)
            log(spatial.Valid, start, wad.BlockLineAt(replacement, spatial, start, 0),
                wad.RejectsSight(original, 0, 0), wad.RejectsSight(replacement, 0, 0))
            log(wad.SkyTextureName(${key("MAP11")}).Low, wad.SkyTextureName(${key("MAP12")}).Low,
                wad.SkyTextureName(${key("MAP21")}).Low, wad.SkyTextureName(${key("E4M1")}).Low,
                wad.SkyTextureName(${key("E2MX")}).Low)
        } else if currentTick() < 18 {
            for sample := range 16 {
                byte := (currentTick() - 2) * 16 + sample
                var words [2]int
                for lane := range 8 {
                    words[lane / 4] = words[lane / 4] | (((byte + lane * 57) & 255) << ((lane % 4) * 8))
                }
                direct := wad.AddLooseLump(wad.Archives{}, Loose, wad.LumpName{Low: words[0], High: words[1]}).LumpAt(0).Name
                log(direct.Low, direct.High)
            }
        }
    }
}
`);
    const output = path.join(scratch, "map.json");
    const result = spawnSync("dotnet", [cli, "build", source, "--package-root", port, "--asset-root", scratch, "-o", output], {
        cwd: root, encoding: "utf8", timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    const wrapper = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(Buffer.from(wrapper.data, "base64")[2], 1);
    const tiles = decode(wrapper.data);
    assert.ok(tiles.some(tile => tile.payload?.toString().includes("__fletcherFile0_1")), "the base spans two data tiles");
    const run = simulator(tiles);
    run.step();
    run.step();
    const logs = JSON.parse(JSON.stringify(run.logs));
    assert.deepEqual(logs, [
        [17, 30, 31], [3, 17, 30, 22, 33, 44], [22, 30, false, false], [1, 44_997, 4, ...edge],
        [4, 52, 5, 75, -1], [6, 19, 1 << 16, 7 << 16], [true, 0, 0], [true, false, 17],
        [false, false], [true], [true, 10, 0, false, true],
        [0x31594b53, 0x32594b53, 0x33594b53, 0x34594b53, 0x31594b53],
    ]);
    for (let tick = 2; tick < 18; tick++) run.step();
    const expectedNames = Array.from({ length: 256 }, (_, byte) => {
        const name = Buffer.alloc(8);
        for (let lane = 0; lane < 8; lane++) {
            const value = (byte + lane * 57) & 255;
            if (value === 0) break;
            name[lane] = value >= 97 && value <= 122 ? value - 32 : value;
        }
        return [name.readInt32LE(0), name.readInt32LE(4)];
    });
    assert.deepEqual(JSON.parse(JSON.stringify(run.logs.slice(logs.length))), expectedNames,
        "WAD name normalization matches byte-by-byte ASCII uppercase and NUL padding");
    if (oracle) {
        const native = spawnSync(oracle, ["BASE.WAD", "ADDON.WAD", "DUP.lmp"], { cwd: scratch, encoding: "utf8", timeout: 5_000 });
        if (native.error) throw native.error;
        assert.equal(native.status, 0, native.stderr);
        const trace = native.stdout.split(/\r?\n/).find(line => line.startsWith("TRACE "));
        assert.ok(trace, native.stdout);
        assert.deepEqual(trace.slice(6).trim().split(/\s+/).map(Number), [
            ...logs[0], ...logs[1], ...logs[3], ...logs[4], ...logs[5].slice(0, 2),
        ]);
    }
    console.log("WAD mounting passed layered names and levels, loose lumps, compressed boundaries, and malformed archives.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-mounts-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
