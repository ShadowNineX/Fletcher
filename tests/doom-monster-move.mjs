import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples/doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-monster-move-"));
const cases = [
    { name: "ground movement snaps to the floor", z: 4, expected: [1, 36, 0, 0, 0, 0, 0] },
    { name: "normal doors open from a blocked monster move", ceiling: 0, action: 1, expected: [1, 28, 0, 8, 1, 1, 0] },
    { name: "secret doors ignore monsters", ceiling: 0, action: 1, secret: true, expected: [0, 28, 0, 8, 0, 0, 0] },
    { name: "locked doors refuse the monster without losing the use result", ceiling: 0, action: 32, expected: [1, 28, 0, 8, 0, 0, 0] },
    { name: "floating monster climbs without translating on a high step", floor: 32, float: true, expected: [1, 28, 4, 0, 0, 0, 1] },
    { name: "a solid actor blocks an ordinary monster move", occupied: true, expected: [0, 28, 0, 0, 0, 0, 0] },
    { name: "monsters leave an opening door moving upward", ceiling: 0, action: 1, opened: true, expected: [1, 28, 0, 8, 1, 1, 0] },
];

function words(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, i) => bytes.writeUInt16LE(value & 65535, i * 2));
    return bytes;
}

function geometry() {
    const records = [];
    let offset = 0;
    const code = cases.map((test, i) => {
        const sectors = Buffer.alloc(52), sides = Buffer.alloc(60);
        sectors.writeInt16LE(128, 2);
        sectors.writeInt16LE(test.floor ?? 0, 26);
        sectors.writeInt16LE(test.ceiling ?? 128, 28);
        sides.writeUInt16LE(1, 58);
        const blocks = words([-128, -128, 2, 2, 8, 8, 8, 8, 0, -1]);
        const lumps = [
            ["Vertices", words([40, -64, 40, 64]), 2],
            ["Lines", words([0, 1, test.secret ? 36 : 4, test.action ?? 0, 0, 0, 1]), 1],
            ["Sides", sides, 2], ["Sectors", sectors, 2],
            ["Segs", words([0, 1, 0, 0, 0, 0]), 1], ["Subsectors", words([1, 0]), 1],
            ["Nodes", Buffer.alloc(0), 0], ["BlockMap", blocks, blocks.length],
        ];
        const fields = lumps.map(([name, bytes, count]) => {
            const field = `                ${name}: wad.Lump{Offset: ${offset}, Count: ${count}, Valid: true},`;
            offset += bytes.length;
            records.push(bytes);
            return field;
        });
        return `    case ${i}: return wad.BspLevel{File: MapData, Valid: true,\n${fields.join("\n")}\n    }`;
    });
    writeFileSync(path.join(scratch, "MAP.BIN"), Buffer.concat(records));
    return code.join("\n");
}

try {
    const main = path.join(scratch, "main.flt"), output = path.join(scratch, "result.json");
    writeFileSync(main, `package main
import "enemy"
import "play"
import "wad"
const MapData = readFile("MAP.BIN")
const InitialZ = [${cases.length}]int{${cases.map(test => test.z ?? 0)}}
const Floaters = [${cases.length}]bit{${cases.map(test => !!test.float)}}
const Occupied = [${cases.length}]bit{${cases.map(test => !!test.occupied)}}
const Opened = [${cases.length}]bit{${cases.map(test => !!test.opened)}}

func makeScene(index int) wad.BspLevel {
    switch index {
${geometry()}
    default: return wad.BspLevel{}
    }
}

map "Monster walking contacts" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        index := currentTick()
        base := makeScene(index)
        blocks := wad.LoadBlockMap(base)
        actor := play.LevelActor{Valid: true, Kind: 1, Physics: play.ActorPhysics{Body: play.MapActor{
            X: 28 << 16, Z: InitialZ[index] << 16, Radius: 20 << 16, Height: 56 << 16, Ceiling: 128 << 16, Flags: 2}}}
        var context enemy.MonsterMove
        if Floaters[index] {
            actor.Kind = 14
            actor.Physics.Body.Flags = actor.Physics.Body.Flags | play.MoveFloat
        }
        context.World.Actors = context.World.Actors.AppendActor(actor)
        if Occupied[index] {
            actor.Physics.Body.X = 64 << 16
            context.World.Actors = context.World.Actors.AppendActor(actor)
        }
        context.World.Links = play.BuildActorLinks(context.World.Actors, blocks)
        if Opened[index] { context.Specials = play.UseMonsterLine(base, context.Specials, 0).State }
        context.Level = context.Specials.ApplyTo(base)
        moved := enemy.Move(base, blocks, context, 1, play.CombatRules{Skill: 2})
        final := moved.World.Actors.ActorAt(0)
        if moved.Failed { log(-1) }
        log(moved.Moved, final.Physics.Body.X >> 16, final.Physics.Body.Z >> 16, final.MoveDirection,
            moved.Specials.Doors.Count, moved.Specials.Doors.EntryAt(moved.Specials.Doors.First()).State.Direction,
            final.Physics.Body.Flags & play.MoveInFloat != 0)
    }
}
`);
    const run = spawnSync("dotnet", [cli, "build", main, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (run.error) throw run.error;
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    const sim = simulator(decode(encoded), true);
    for (const test of cases) {
        const from = sim.logs.length;
        for (let host = 0; sim.logs.length === from && host < 20; host++) sim.step();
        const rows = Array.from(sim.logs.slice(from), row => Array.from(row, Number));
        assert.deepEqual(rows, [test.expected], test.name);
    }
    console.log(`Verified ${cases.length} live monster movement, collision, and door-use cases.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-monster-move-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
