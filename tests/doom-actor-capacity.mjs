import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runNativeActorOracle } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-actor-capacity-"));
const bonusCount = 1030;
const things = [[-8, 12, 0, 1, 0], ...Array.from({ length: bonusCount }, (_, i) => [1 + (i % 16), 4, 0, 2014, 7]), [32, 4, 0, 1, 0]];

function geometry() {
    const parts = [];
    function lump(name, count, size, fill) {
        const offset = parts.reduce((sum, part) => sum + part.data.length, 0);
        const data = Buffer.alloc(count * size);
        for (let i = 0; i < count; i++) fill(data, i * size, i);
        parts.push({ name, count, offset, data });
    }
    lump("Things", things.length, 10, (data, at, i) =>
        things[i].forEach((value, column) => data.writeInt16LE(value, at + 2 * column)));
    // The native actor oracle uses the same split at x=0 and sector heights.
    lump("Sectors", 2, 26, (data, at, i) => {
        data.writeInt16LE(i === 0 ? 8 : -16, at);
        data.writeInt16LE(i === 0 ? 128 : 192, at + 2);
    });
    lump("Subsectors", 2, 4, (data, at, i) => {
        data.writeUInt16LE(1, at);
        data.writeUInt16LE(i, at + 2);
    });
    lump("Segs", 2, 12, (data, at, i) => data.writeUInt16LE(i, at + 6));
    lump("Lines", 2, 14, (data, at, i) => {
        data.writeUInt16LE(i, at + 10);
        data.writeUInt16LE(0xffff, at + 12);
    });
    lump("Sides", 2, 30, (data, at, i) => data.writeUInt16LE(i, at + 28));
    lump("Nodes", 1, 28, (data, at) => {
        data.writeInt16LE(1, at + 6);
        data.writeUInt16LE(0x8001, at + 24);
        data.writeUInt16LE(0x8000, at + 26);
    });
    writeFileSync(path.join(scratch, "MAP.BIN"), Buffer.concat(parts.map(part => part.data)));
    return parts.map(({ name, count, offset }) => `${name}: wad.Lump{Offset: ${offset}, Count: ${count}, Valid: true}`).join(",\n                ");
}

function trace() {
    const main = path.join(scratch, "main.flt"), output = path.join(scratch, "actors.json");
    writeFileSync(main, `package main
import "play"
import "wad"
const Geometry = readFile("MAP.BIN")
map "High actor handles" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register phase int = 0
    register roster play.MapActors = play.MapActors{}
    register spatial play.ActorLinks = play.ActorLinks{}
    tick {
        level := wad.BspLevel{Valid: true, File: Geometry,
                ${geometry()}}
        blocks := wad.BlockMapInfo{Valid: true, Width: 1, Height: 1}
        switch phase {
        case 0:
            actors := play.SpawnMapActors(level, wad.ThingRules{Skill: 2}, [4]int{93, 0, 0, 0}, play.ClearRandom())
            next roster = actors
            log("spawn", actors.Count, actors.TotalKills, actors.TotalItems, actors.Random.GameplayIndex,
                actors.Failed, actors.RejectedThing, actors.PlayerActors[0], actors.PlayerActors[1], actors.PlayerActors[2], actors.PlayerActors[3])
            for i := range actors.Count {
                actor := actors.ActorAt(i)
                body, thing := actor.Physics.Body, actor.SpawnPoint
                log("actor", actor.Kind, body.X, body.Y, body.Z, body.Floor, body.Ceiling, actor.Sector, body.Radius, body.Height,
                    body.Flags, actor.Health, actor.ReactionTime, actor.LastLook, actor.State, actor.Tics,
                    actor.Sprite, actor.Frame, actor.Physics.Angle, actor.PlayerSlot, thing.X, thing.Y, thing.Angle, thing.Type, thing.Options)
            }
        case 1:
            links := play.BuildActorLinks(roster, blocks)
            actor := roster.ActorAt(1024)
            actor.Physics.Body.X = actor.Physics.Body.X + 65536
            moved := links.SetActorPosition(level, 1025, actor)
            next roster = roster.WithActor(1025, moved.Actor)
            next spatial = moved.Links
            log("relink", moved.Valid, links.BlockFirst(0, 0), links.BlockNext(1025), moved.Links.BlockFirst(0, 0),
                moved.Links.BlockNext(1025), moved.Links.BlockNext(1026), moved.Links.SectorFirst(1), moved.Links.SectorNext(1025))
        case 2:
            passive := play.SelectPassiveActors(roster)
            frame := play.TickPassiveActors(roster, passive, spatial)
            next roster = frame.Actors
            next spatial = frame.Links
            log("passive", passive.Count, frame.Cursor, frame.Failed, frame.Links.BlockFirst(0, 0))
            for i := range passive.Count {
                handle := passive.HandleAt(i)
                actor := frame.Actors.ActorAt(handle - 1)
                log("thinker", handle, actor.State, actor.Tics, actor.Sprite, actor.Frame)
            }
        case 3:
            actor := roster.ActorAt(1024)
            first := roster.NextTransientHandle()
            placed := spatial.SetActorPosition(level, first, actor)
            actors := roster.AppendTransient(placed.Actor)
            second := actors.NextTransientHandle()
            secondPlaced := placed.Links.SetActorPosition(level, second, actor)
            actors = actors.AppendTransient(secondPlaced.Actor)
            expired := actors.ActorAt(first - 1)
            expired.Valid = false
            actors = actors.WithActor(first, expired).ReleaseTransient(0, first)
            next roster = actors
            next spatial = secondPlaced.Links.UnlinkActor(first)
            log("release", placed.Valid && secondPlaced.Valid, first, second, actors.NextTransientHandle(),
                actors.TransientFirst(), actors.TransientNext(second), actors.ActorAt(first - 1).Valid)
        case 4:
            handle := roster.NextTransientHandle()
            placed := spatial.SetActorPosition(level, handle, roster.ActorAt(1024))
            actors := roster.AppendTransient(placed.Actor)
            head := actors.TransientFirst()
            log("reuse", placed.Valid, actors.Count, head, actors.TransientNext(head), actors.TransientNext(handle),
                actors.ActorAt(handle - 1).Transient, actors.TransientOrder(head) < actors.TransientOrder(handle),
                placed.Links.BlockFirst(0, 0), placed.Links.BlockNext(handle))
        }
        log("phase", phase)
        next phase = phase + 1
    }
}`);
    const build = spawnSync("dotnet", [cli, "build", main, "--package-root", path.join(root, "examples/doom-engine"),
        "--asset-root", scratch, "-o", output], { cwd: root, encoding: "utf8", timeout: 60_000 });
    if (build.error) throw build.error;
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    const slices = [];
    for (let phase = 0; phase < 5; phase++) {
        const complete = () => sim.logs.at(-1)?.[0] === "phase" && sim.logs.at(-1)[1] === phase;
        let host = 0;
        for (; host < 500 && !complete(); host++) sim.step();
        assert.ok(complete(), `actor capacity phase ${phase} must finish`);
        slices.push(host);
        if (phase === 1 || phase === 3) sim.roundTripScriptState();
    }
    const rows = tag => sim.logs.filter(row => row[0] === tag).map(row => Array.from(row.slice(1), Number));
    return { summary: rows("spawn")[0], actors: rows("actor"), relink: rows("relink")[0],
        passive: rows("passive")[0], thinks: rows("thinker"), release: rows("release")[0], reuse: rows("reuse")[0], slices };
}

try {
    const observed = trace();
    assert.deepEqual(observed.summary, [1032, 0, 1030, 14, 0, -1, 1032, 0, 0, 0]);
    assert.deepEqual(observed.relink, [1, 1032, 1024, 1025, 1032, 1024, 1025, 1032]);
    assert.deepEqual(observed.passive, [1030, 1030, 0, 1025]);
    assert.deepEqual(observed.release, [1, 1033, 1034, 1033, 1034, 0, 0]);
    assert.deepEqual(observed.reuse, [1, 1034, 1034, 1033, 0, 1, 1, 1033, 1034]);
    assert.equal(observed.actors.length, things.length);
    const hash = createHash("sha256").update(JSON.stringify([observed.actors, observed.thinks])).digest("hex");
    if (values.upstream) {
        const native = runNativeActorOracle(path.resolve(root, values.upstream), scratch,
            [{ skill: 2, commercial: false, noMonsters: false, health: [93, 0, 0, 0], things }]);
        const [summary, ...actors] = native.spawns[0];
        assert.deepEqual([observed.summary, ...observed.actors], [summary, ...actors]);
        const states = native.metadata.filter(row => row.length === 8);
        const expected = actors.slice(1, -1).map((actor, index) => {
            const [state, tics, sprite, frame] = actor.slice(13, 17);
            if (tics > 1) return [index + 2, state, tics - 1, sprite, frame];
            // The stationary bonus only decrements tics and enters its next state in P_MobjThinker.
            const next = states[state][5];
            const [id, nextSprite, nextFrame, nextTics, action] = states[next];
            assert.equal(id, next);
            assert.equal(action, 0);
            return [index + 2, id, nextTics, nextSprite, nextFrame];
        });
        assert.deepEqual(observed.thinks, expected);
    } else {
        assert.equal(hash, "e27b32f20f9ae16cc4db3128f2ab9ceeda56970887434dba3e61739f76c90d65");
    }
    console.log(`Verified ${observed.actors.length} actors and ${observed.thinks.length} passive tics, plus high links and reuse after state round trips. Host slices ${observed.slices.join(", ")}. SHA-256 ${hash}.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-actor-capacity-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
