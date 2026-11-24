import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(path.join(artifacts, "file-imports-"));

function write(relative, data) {
    const file = path.join(scratch, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
    return file;
}

function run(...args) {
    const result = spawnSync("dotnet", [cli, ...args], {
        encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (result.error) throw result.error;
    return result;
}

function checkDiagnostic(name, expression, message) {
    const entry = write(`entry/${name}.flt`, `map "Invalid import" { tick { ${expression} } }\n`);
    const result = run("check", entry);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /\(1,\d+\): error:/);
    assert.match(result.stderr, message);
}

try {
    const data = Buffer.alloc(90_001);
    for (let i = 0; i < data.length; i++) data[i] = (i * 127 + 251) & 255;
    data[512] = 42; // Different word at the same direct-mapped cache slot as offset zero.
    write("external/asset.bin", data);
    write("external/empty.bin", "");
    const entry = write("app/main.flt", `package main
import "aux"

const assetPath = "asset" + ".bin"
const media = readFile(assetPath)
const again = readFile("./asset.bin")
const Count = len(media)
const Signature = media[2]
const offsets = 11

func readAt(file bytes, i int) bits<8> { return file[i] }

map "File imports" {
    tick {
        log(Count, Signature, len(aux.Empty()), media)
        points := [offsets]int{0, 1, 2, 3, 44999, 45000, 45001, 45002, 89998, 89999, 90000}
        for _, point := range points {
            log(readAt(media, point), again[point])
        }
        for i, byte := range readFile("head.bin") { log(i, byte) }
        var empty bytes
        log(len(empty), len(readFile("empty.bin")))
    }
}
`);
    write("app/aux/empty.flt", `package aux\nfunc Empty() bytes { return readFile("empty.bin") }\n`);
    const small = Buffer.from([0, 0xef, 0xbe, 0xff]);
    write("external/head.bin", small);
    const output = path.join(scratch, "file-import.json");
    const build = run("build", entry, "--asset-root", path.join(scratch, "external"), "-o", output);
    assert.equal(build.status, 0, build.stderr);
    const map = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(Buffer.from(map.data, "base64")[2], 1, "imports stay in the zlib-compressed map body");
    assert.ok(map.data.length < data.length / 4, "compressible data should stay compact");
    const tiles = decode(map.data);
    const chunks = tiles.filter(tile => tile.type === 33 && tile.payload.toString().startsWith("onStart"));
    assert.equal(chunks.length, 4, "three large asset chunks and one small asset, with the duplicate import deduplicated");
    assert.ok(chunks.every(tile => tile.payload.length <= 65535));
    for (const order of [tiles, [...tiles].reverse()]) {
        const chunkReads = new Map();
        const sim = simulator(order, false, key => {
            if (typeof key === "string" && key.startsWith("__fletcherFile")) {
                chunkReads.set(key, (chunkReads.get(key) ?? 0) + 1);
            }
        });
        sim.step();
        const offsets = [0, 1, 2, 3, 44999, 45000, 45001, 45002, 89998, 89999, 90000];
        assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
            [data.length, data[2], 0, `bytes(${data.length})`],
            ...offsets.map(index => [data[index], data[index]]),
            ...Array.from(small, (byte, i) => [i, byte]),
            [0, 0],
        ]);
        sim.step();
        assert.equal(chunkReads.size, 4);
        assert.ok([...chunkReads.values()].every(count => count === 1), "the controller retrieves each immutable chunk once");
    }

    // Alternate long overlapping matches, incompressible blocks, and long
    // literal prefixes followed by distant matches. Finish on a partial chunk.
    const blockBytes = 45_000;
    const mixed = Buffer.alloc(24 * blockBytes + 17);
    let seed = 0x531cafe;
    for (let i = 0; i < mixed.length; i++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        const chunk = Math.floor(i / blockBytes), offset = i % blockBytes;
        if (chunk % 3 === 0) mixed[i] = (offset >>> 9) & 255;
        else if (chunk % 3 === 1 || offset < 4096) mixed[i] = seed >>> 24;
        else mixed[i] = mixed[i - 4096];
    }
    write("external/mixed.bin", mixed);
    const scanner = write("scan/main.flt", `const Data = readFile("mixed.bin")
map "Mixed block scan" {
    tick {
        start := currentTick() * 1024
        var batch [1024]bits<8>
        for i := range 1024 { if start + i < len(Data) { batch[i] = Data[start + i] } }
        log(batch)
    }
}`);
    const scanned = run("build", scanner, "--asset-root", path.join(scratch, "external"), "-o", output);
    assert.equal(scanned.status, 0, scanned.stderr);
    const mixedTiles = decode(JSON.parse(readFileSync(output, "utf8")).data);
    const fileTiles = new Map();
    for (const tile of mixedTiles) {
        const file = tile.payload?.toString().match(/__fletcherFile0_(\d+)"\] = "([^"]+)"/);
        if (file) fileTiles.set(Number(file[1]), file[2]);
    }
    assert.equal(fileTiles.size, 25);
    for (let chunk = 0; chunk < 24; chunk++) {
        const encoded = fileTiles.get(chunk);
        if (chunk % 3 === 1) {
            assert.equal(encoded, mixed.subarray(chunk * blockBytes, (chunk + 1) * blockBytes).toString("base64"),
                "a nonshrinking block retains the exact original payload and tile size");
        } else {
            assert.ok(encoded.startsWith("!") && encoded.length < 60000, "compressible blocks use the packed encoding");
        }
    }
    const accesses = [];
    const scan = simulator(mixedTiles, false, key => { if (String(key).startsWith("__fletcherFile")) accesses.push(key); });
    assert.equal(accesses.length, 0);
    const roundTrip = Buffer.alloc(mixed.length);
    for (let tick = Math.floor((mixed.length - 1) / 1024); tick >= 0; tick--) {
        scan.setTick(tick);
        scan.step();
        Buffer.from(scan.logs.pop()[0]).copy(roundTrip, tick * 1024);
    }
    assert.deepEqual(roundTrip, mixed, "reverse-order batches recover every raw and compressed byte through Fletcher indexing");
    assert.equal(accesses.length, fileTiles.size, "each block is retrieved exactly once on demand");
    assert.equal(new Set(accesses).size, fileTiles.size);
    for (const invalid of [[0xf0, 255], [0, 0, 0], [0x10, 65, 2, 0]]) {
        const broken = mixedTiles.map(tile => {
            const source = tile.payload?.toString();
            return source?.includes('__fletcherFile0_0"] = "') ? {
                ...tile, payload: Buffer.from(source.replace(fileTiles.get(0), "!" + Buffer.from(invalid).toString("base64"))),
            } : tile;
        });
        assert.throws(() => simulator(broken).step(), /Invalid Fletcher file data block/);
    }

    write("local/parts/inside.bin", Buffer.from([37]));
    write("local/parts/package.flt", 'package parts\nconst Inside = readFile("inside.bin")\n');
    const local = write("local/main.flt", 'package main\nimport "parts"\nmap "Local file" { tick { log(parts.Inside[0]) } }\n');
    assert.equal(run("build", local, "-o", output).status, 0);
    const inline = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
    inline.step();
    assert.equal(inline.logs[0][0], 37);

    write("entry/data.bin", Buffer.from([2, 3, 5]));
    const shared = write("entry/shared.flt", `const Data = readFile("data.bin")
map "Shared bytes" {
    screen at (0, 0) size (1, 1) with { style = "solid", slice = true }
    place scriptBlock at (5, 5) with { code = "always(() => { const tick = world.getTick(); if (tick === 1) globalState.rows = [251, 0, 255]; if (tick === 2) globalState.rows[0] = -1; });" }
    tick {
        rows := sharedBytes("rows")
        if len(rows) == 0 { log("pending") } else {
            log(sameFile(rows, sharedBytes("rows")), sameFile(rows, Data), len(rows), rows[0], rows[2], Data[1])
        }
    }
}`);
    const sharedIr = path.join(scratch, "shared.ir.json");
    const sharedBuild = run("build", shared, "-o", output, "--emit-ir", sharedIr);
    assert.equal(sharedBuild.status, 0, sharedBuild.stderr);
    assert.match(readFileSync(sharedIr, "utf8"), /"op": "sharedBytes",\s*"type": \d+,\s*"key": "rows"/);
    const sharedTiles = decode(JSON.parse(readFileSync(output, "utf8")).data);
    for (const order of [sharedTiles, [...sharedTiles].reverse()]) {
        const bridge = simulator(order);
        for (let host = 0; host < 5; host++) bridge.step();
        assert.deepEqual([...bridge.logs[0]], ["pending"], "the table is absent until published");
        const ready = bridge.logs.filter(row => row[0] !== "pending");
        assert.ok(ready.length >= 3);
        for (const row of ready) assert.deepEqual([...row], [true, false, 3, 251, 255, 3]);
    }
    const invalidShared = sharedTiles.map(tile => tile.payload?.includes("globalState.rows =") ? {
        ...tile, payload: Buffer.from(tile.payload.toString().replace("[251, 0, 255]", "[256]")),
    } : tile);
    const brokenBridge = simulator(invalidShared);
    assert.throws(() => { for (let host = 0; host < 4; host++) brokenBridge.step(); }, /Invalid Fletcher shared byte for rows at 0/);

    write("entry/optional.bin", Buffer.from([13, 42]));
    const optional = write("entry/optional.flt", `const Present = readFileIfPresent("optional.bin")
const Missing = readFileIfPresent("not-created/missing.bin")
map "Optional import" { tick { log(len(Present), Present[1], len(Missing)) } }
`);
    assert.equal(run("build", optional, "-o", output).status, 0);
    const optionalMap = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
    optionalMap.step();
    assert.deepEqual([...optionalMap.logs[0]], [2, 42, 0], "present optional files import normally and missing paths are empty bytes");

    checkDiagnostic("missing", 'log(readFile("missing.bin"))', /Cannot import 'missing\.bin'/);
    checkDiagnostic("required-after-optional",
        'log(readFileIfPresent("missing-after-optional.bin")); log(readFile("missing-after-optional.bin"))',
        /Cannot import 'missing-after-optional\.bin'/);
    checkDiagnostic("escape", 'log(readFile("../external/asset.bin"))', /must stay inside/);
    checkDiagnostic("optional-escape", 'log(readFileIfPresent("../external/optional.bin"))', /must stay inside/);
    checkDiagnostic("dynamic-path", 'file := "data.bin"; log(readFile(file))', /compile-time string path/);
    checkDiagnostic("mutation", 'data := readFile("data.bin"); data[0] = 0', /read-only/);
    checkDiagnostic("out-of-range", 'log(readFile("data.bin")[3])', /out of bounds/);
    checkDiagnostic("bad-length", 'log(len(2))', /requires one bytes value/);
    checkDiagnostic("dynamic-shared-key", 'key := "rows"; log(sharedBytes(key))', /compile-time string key/);
    const oversized = write("entry/large.bin", "");
    truncateSync(oversized, 16 * 1024 * 1024 + 1);
    const sparseImport = write("entry/large.flt", `
const Data = readFile("large.bin")
map "Sparse import" { tick { log(len(Data), Data[len(Data) - 1]) } }
`);
    const sparseBuild = run("build", sparseImport, "-o", output);
    assert.equal(sparseBuild.status, 0, sparseBuild.stderr);
    const sparseMap = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
    sparseMap.step();
    assert.deepEqual(Array.from(sparseMap.logs[0]), [16 * 1024 * 1024 + 1, 0]);

    const input = write("entry/input.json", "user data");
    const protect = write("entry/protect.flt", 'map "Protected" { tick { log(readFile("input.json")) } }\n');
    const attempted = run("build", protect, "-o", input);
    assert.equal(attempted.status, 2, attempted.stderr);
    assert.match(attempted.stderr, /distinct from every file imported/);
    assert.equal(readFileSync(input, "utf8"), "user data");

    const bounds = write("entry/bounds.flt", 'const Data = readFile("data.bin")\nmap "Bounds" { tick { log(Data[currentTick() + len(Data)]) } }\n');
    assert.equal(run("build", bounds, "-o", output).status, 0);
    const bounded = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
    assert.throws(() => bounded.step(), /index out of bounds/);

    const readers = `const A = readFile("asset.bin")
const B = readFile("head.bin")
func word(f bytes, i int) int { return int(f[i]) | (int(f[i + 1]) << 8) }
func swapped(f bytes, i int) int { return int(f[i + 1]) | (int(f[i]) << 8) }
func timed(f bytes, i int) int { return int(f[i]) + int(f[i + 1]) + currentTick() }
`;
    function slicedFileMap(tick) {
        const source = write("sliced/main.flt", readers + `map "Read cache" {
            screen at (0, 0) size (1, 1) with { style = "solid", slice = true }
            tick { ${tick} }
        }`);
        const build = run("build", source, "--asset-root", path.join(scratch, "external"), "-o", output);
        assert.equal(build.status, 0, build.stderr);
        return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
    }
    const repeated = slicedFileMap(`total := 0
        for range 2800 { total = total + word(A, 0) }
        log(total, word(B, 0), swapped(A, 0), word(A, 512), word(A, 0), timed(A, 0))
        if currentTick() == 2 { log(word(A, len(A) - 1)) }`);
    const expected = [2800 * data.readUInt16LE(0), small.readUInt16LE(0), data.readUInt16BE(0),
        data.readUInt16LE(512), data.readUInt16LE(0)];
    for (let tick = 0; tick < 2; tick++) {
        repeated.step();
        assert.deepEqual([...repeated.logs[tick]], [...expected, data[0] + data[1] + tick],
            "repeated immutable reads complete in one slice and other file, offset, function and clock values stay distinct");
    }
    assert.throws(() => repeated.step(), /index out of bounds/);

    const exhausted = slicedFileMap(`word(A, 0)
        for range 4095 {}
        log(word(A, 0))`);
    exhausted.step();
    assert.deepEqual(Array.from(exhausted.logs[0]), [data.readUInt16LE(0)],
        "the cache hit can finish at a full slice");

    const suspended = slicedFileMap(`word(A, 0)
        for range 4095 {}
        nextWord := word(A, 1)
        for range 4096 {}
        log(nextWord)`);
    suspended.step();
    assert.equal(suspended.logs.length, 0, "the cache miss suspends before reading at a full slice");
    suspended.step();
    assert.equal(suspended.logs.length, 0, "the resumed miss uses the first step of the next slice");
    suspended.step();
    assert.deepEqual(Array.from(suspended.logs[0]), [data.readUInt16LE(1)]);

    console.log("File import checks passed for data, compression, chunk boundaries, packages, and diagnostics.");
} finally {
    assert.match(path.relative(realpathSync(artifacts), realpathSync(scratch)), /^file-imports-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
