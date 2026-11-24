import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-actor-links-"));

const unit = 65536;
const set = (h, x, y, flags = 0) => ["set", h, x * unit, y * unit, flags];
const move = (h, x, y, flags = 0) => ["move", h, x * unit, y * unit, flags];
const unlink = h => ["unset", h];
const sector = index => ["sector", index];
const block = (x, y, stop = 0) => ["block", x, y, stop];
const fixture = {
    splitX: 0,
    origin: [-128 * unit, -128 * unit],
    width: 1024,
    height: 2,
    commands: [
        sector(0), block(0, 0), block(-1, 0), block(0, 2),
        set(1, -96, -64), set(2, -40, -32),
        set(3, 40, -32, 0x8), set(4, 52, 12, 0x10), set(5, -56, 18),
        set(6, 768, -200), set(7, 0, -28), set(8, 30, -5, 0x18),
        sector(0), sector(1024), block(0, 0), block(0, 1), block(1, 0), block(1, 1), block(0, 0, 2),
        unlink(2), sector(0), block(0, 0), block(0, 1),
        move(1, -92, 24), sector(0), block(0, 0), block(0, 1, 5),
        move(5, -32, 48), sector(0), block(0, 1),
        move(7, 115, -12), sector(0), sector(1024), block(1, 0), block(1, 0, 3),
        move(6, -116, -48), sector(1024), sector(0), block(0, 0),
        move(6, -116, -200), sector(0), block(0, 0),
        unlink(6), unlink(5), unlink(1), unlink(7), unlink(8),
        sector(0), sector(1024), block(0, 1), block(1, 0),
        unlink(3), unlink(4), sector(1024), block(1, 0), set(2, -1, -1), sector(0), unlink(2),
        set(1024, -90, -64), set(1025, -44, -64), set(2050, -32, -32),
        sector(0), block(0, 0), move(1025, -42, -64), sector(0), block(0, 0, 2050),
        move(1025, 40, 48), sector(0), sector(1024), block(0, 0), block(1, 1),
        unlink(1024), unlink(2050), unlink(1025), set(1025, -90, 24), sector(0), block(0, 1),
    ],
};

function geometry() {
    const lumps = [
        ["Sectors", 1025, 26], ["Subsectors", 2, 4], ["Segs", 2, 12],
        ["Lines", 2, 14], ["Sides", 2, 30], ["Nodes", 1, 28],
    ];
    let length = 0;
    const offsets = new Map();
    for (const [name, count, size] of lumps) {
        offsets.set(name, length);
        length += count * size;
    }
    const data = Buffer.alloc(length);
    for (let leaf = 0; leaf < 2; leaf++) {
        const subsector = offsets.get("Subsectors") + leaf * 4;
        data.writeUInt16LE(1, subsector);
        data.writeUInt16LE(leaf, subsector + 2);
        data.writeUInt16LE(leaf, offsets.get("Segs") + leaf * 12 + 6);
        data.writeUInt16LE(leaf, offsets.get("Lines") + leaf * 14 + 10);
        data.writeUInt16LE(leaf * 1024, offsets.get("Sides") + leaf * 30 + 28);
    }
    const node = offsets.get("Nodes");
    data.writeInt16LE(fixture.splitX / unit, node);
    data.writeInt16LE(1, node + 6);
    data.writeUInt16LE(0x8001, node + 24);
    data.writeUInt16LE(0x8000, node + 26);
    writeFileSync(path.join(scratch, "BSP.BIN"), data);
    return lumps.map(([name, count]) =>
        `        ${name}: wad.Lump{Offset: ${offsets.get(name)}, Count: ${count}, Valid: true},`).join("\n");
}

function traceFletcher() {
    const source = path.join(scratch, "main.flt");
    const output = path.join(scratch, "map.json");
    const ops = { set: 0, move: 0, unset: 1, sector: 2, block: 3 };
    const handleCount = new Set(fixture.commands.filter(([op]) => op === "set").map(([, handle]) => handle)).size;
    const cases = fixture.commands.map(([op, a, b = 0, c = 0, d = 0], tic) =>
        `        case ${tic}: op, a, b, c, flags = ${ops[op]}, ${a}, ${b}, ${c}, ${d}`);
    writeFileSync(source, `package main
import "play"
import "wad"
const MapData = readFile("BSP.BIN")
func geometry() wad.BspLevel {
    return wad.BspLevel{File: MapData, Valid: true,
${geometry()}
    }
}
map "Doom spatial links" {
    register links play.ActorLinks = play.ActorLinks{}
    tick {
        current := links
        if currentTick() == 0 {
            current = play.BuildActorLinks(play.MapActors{}, wad.BlockMapInfo{Valid: true,
                Width: ${fixture.width}, Height: ${fixture.height}, OriginX: ${fixture.origin[0]}, OriginY: ${fixture.origin[1]}})
        }
        op, a, b, c, flags := -1, 0, 0, 0, 0
        switch currentTick() {
${cases.join("\n")}
        }
        switch op {
        case 0:
            actor := play.LevelActor{Valid: true, Physics: play.ActorPhysics{
                Body: play.MapActor{X: b, Y: c, Flags: bits<32>(flags)},
            }}
            update := current.SetActorPosition(geometry(), a, actor)
            log(update.Actor.Sector, update.Actor.Subsector, update.Valid)
            current = update.Links
        case 1:
            current = current.UnlinkActor(a)
        case 2:
            handle := current.SectorFirst(a)
            for range ${handleCount} {
                if handle > 0 {
                    log(handle)
                    handle = current.SectorNext(handle)
                }
            }
            if handle != 0 { log(-1) }
        case 3:
            handle := current.BlockFirst(a, b)
            complete := true
            for range ${handleCount} {
                if handle > 0 {
                    log(handle)
                    if handle == c {
                        complete, handle = false, 0
                    } else {
                        handle = current.BlockNext(handle)
                    }
                }
            }
            log(complete && handle == 0)
        }
        if op == 0 || op == 1 || currentTick() == 0 { next links = current }
    }
}
`);
    const result = spawnSync("dotnet", [cli, "build", source, "--package-root", port, "--asset-root", scratch, "-o", output],
        { encoding: "utf8", cwd: root, timeout: 25000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const map = JSON.parse(readFileSync(output, "utf8"));
    const sim = simulator(decode(map.data), true);
    return fixture.commands.map(([op, handle, x]) => {
        const first = sim.logs.length;
        sim.step();
        if (op === "set" && handle === 2050) sim.roundTripScriptState();
        const row = Array.from(sim.logs.slice(first)).flatMap(log => Array.from(log, Number));
        if (op === "set" || op === "move") {
            const [linkedSector, leaf, valid] = row;
            assert.equal(valid, 1);
            assert.equal(leaf, Number(x > fixture.splitX));
            return [linkedSector];
        }
        if (op === "block") row.unshift(row.pop());
        return row;
    });
}

const digest = trace => createHash("sha256").update(JSON.stringify(trace)).digest("hex");
try {
    const observed = traceFletcher();
    if (values.upstream) {
        const { runNativeLinksOracle } = await import("./doom-native-links-oracle.mjs");
        const native = runNativeLinksOracle(path.resolve(root, values.upstream), scratch, fixture);
        assert.equal(native.length, fixture.commands.length);
        for (const [index, command] of fixture.commands.entries()) {
            assert.deepEqual(observed[index], native[index], `${index}: ${command.join(" ")}`);
        }
        console.log(`Matched ${native.length} spatial link operations with pinned Linux Doom C. SHA-256 ${digest(native)}.`);
    } else {
        assert.equal(digest(observed), "66b788920e4bb31f64906561693d4f2de1e7b8fca1a53f4530cf14b0f28ada88");
        console.log(`Verified ${observed.length} spatial link operations against the pinned C snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-actor-links-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
