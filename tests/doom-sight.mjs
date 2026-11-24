import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runNativeSightOracle } from "./doom-native-sight-oracle.mjs";
import { blockedSightFixtures, malformedSightFixtures, visibleSightFixtures } from "./doom-sight-fixtures.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const port = path.join(root, "examples", "doom-engine");
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-sight-"));
const unit = 65536;
const shootable = 4, barrel = 30, rocket = 33, missile = 0x10000;

function targetActor(x, y, extra = {}) {
    return { x: x * unit, y: y * unit, z: 0, height: 56 * unit, radius: 20 * unit, kind: 1,
        flags: shootable, sector: 0, health: 500, ...extra };
}

const blastMap = {
    sectors: [[0, 128 * unit]], vertices: [[240 * unit, -20 * unit], [240 * unit, 20 * unit]],
    lines: [[0, 1, 0]], segs: [[0, 0, -1]], leaves: [[1, 0]], nodes: [], reject: [0],
};
const blastSpot = targetActor(0, 0, { kind: rocket, height: 8 * unit, radius: 11 * unit, flags: missile, owner: 2 });
const blastOwner = targetActor(230, 0, { kind: 0, flags: 0, slot: 0 });
function blast(name, targets, { map = blastMap, spot = blastSpot, owner = blastOwner,
    source = 2, damage = 128, explode = false } = {}) {
    return { ...map, name, blast: { actors: [spot, owner, ...targets], spot: 1, source, damage, explode } };
}

const closedDoor = blockedSightFixtures.find(({ name }) => name.includes("closed door"));
const wall = blockedSightFixtures.find(({ name }) => name.includes("finite wall"));
const metadata = new Map([[0, [16, 0]], [1, [20, 0]], [3, [20, 0]], [5, [20, 335]],
    [11, [20, 452]], [18, [16, 0]], [19, [128, 0]], [21, [40, 0]]]);

function decision(name, x, expected, { kind = 11, targetKind = 0, flags = shootable,
    reactionTime = 0, randomIndex = 0, map = visibleSightFixtures[0], targetSector = 0 } = {}) {
    return { ...map, name, viewer: [0, 0, 0, 56 * unit, 0], target: [x * unit, 0, 0, 56 * unit, targetSector],
        enemyDecision: { kind, meleeState: metadata.get(kind)[1], targetKind, targetRadius: metadata.get(targetKind)[0] * unit,
            flags, reactionTime, randomIndex, expected } };
}
const enemyDecisions = [
    decision("one fractional unit inside strict melee reach", 60 - 1 / unit, [1, 1, 4, 1]),
    decision("exactly at melee reach fails the strict comparison", 60, [0, 1, 4, 1]),
    decision("melee uses the target kind's original radius", 100, [1, 1, 4, 2], { targetKind: 19, randomIndex: 1 }),
    decision("wall blocks melee and missile retaliation without drawing RNG", 40, [0, 0, 68, 0],
        { map: wall, targetSector: 1, flags: 68 }),
    decision("forward REJECT blocks both decisions", 40, [0, 0, 68, 0],
        { map: blockedSightFixtures[0], targetSector: 1, flags: 68 }),
    decision("retaliation consumes the just-hit flag before considering reaction delay", 40, [1, 1, 4, 0],
        { flags: 68, reactionTime: 12 }),
    decision("reaction delay prevents a missile attack without using RNG", 40, [1, 0, 4, 0], { reactionTime: 12 }),
    decision("revenant prefers melee below the close-range missile cutoff", 259, [0, 0, 4, 1], { kind: 5, randomIndex: 1 }),
    decision("revenant halves the threshold at the cutoff", 260, [0, 1, 4, 2], { kind: 5, randomIndex: 1 }),
    decision("arch-vile reaches its exact range limit", 1088, [0, 1, 4, 3], { kind: 3, randomIndex: 2 }),
    decision("arch-vile rejects beyond its range limit without drawing RNG", 1089, [0, 0, 4, 2], { kind: 3, randomIndex: 2 }),
    decision("cyberdemon uses the tighter cap at long range", 550, [0, 1, 4, 24], { kind: 21, randomIndex: 23 }),
    decision("spider uses half distance with the ordinary cap", 550, [0, 0, 4, 24], { kind: 19, randomIndex: 23 }),
    decision("lost soul halves the missile threshold", 360, [0, 1, 4, 2], { kind: 18, randomIndex: 1 }),
    decision("ordinary missile chance clamps at 200", 400, [0, 1, 4, 3], { randomIndex: 2 }),
    decision("a draw equal to the threshold fires", 173, [0, 1, 4, 2], { randomIndex: 1 }),
    decision("a draw one below the threshold does not fire", 174, [0, 0, 4, 2], { randomIndex: 1 }),
];
const cases = [
    ...visibleSightFixtures.map(fixture => ({ ...fixture, visible: true })),
    ...blockedSightFixtures.map(fixture => ({ ...fixture, visible: false })),
    { ...closedDoor, name: "opening the live door restores sight", sectors: [[0, 128 * unit], [0, 0]],
        movingCeiling: { sector: 1, height: 112 * unit }, visible: true },
    { ...closedDoor, name: "closing the live door blocks sight", sectors: [[0, 128 * unit], [0, 112 * unit]],
        movingCeiling: { sector: 1, height: 0 }, visible: false },
    { ...visibleSightFixtures[1], name: "absent REJECT falls back to geometry", reject: [0], omitReject: true, visible: true },
    { ...wall, name: "the full linedef blocks sight even when the visited seg ends short", visible: false,
        vertices: [...wall.vertices, [32 * unit, -8 * unit]], segs: [[0, 0, -1, 0, 2]] },
    { ...wall, name: "colocated actors with different heights can see each other", visible: true,
        target: [0, 0, 80 * unit, 10 * unit, 0] },
    blast("blast visits BLOCKMAP rows first and the newest actor first in a cell", [
        targetActor(10, -126), targetActor(-10, -126), targetActor(-15, -127), targetActor(-125, 10),
        targetActor(3, 3), targetActor(2, 2, { kind: 21 }), targetActor(3, 5, { kind: 19 }),
        targetActor(2, 9, { flags: 1 }), targetActor(2, 11, { flags: shootable | 16 }),
    ]),
    blast("a block outside the wrapped scan extent is skipped even when the radius overlaps",
        [targetActor(10, -130), targetActor(10, -126)]),
    blast("blast uses radius, max-axis distance, and a strict reach cutoff", [
        targetActor(148, 0), targetActor(147, 0, { x: 148 * unit - 1 }),
        targetActor(16, 15, { z: 130 * unit }), targetActor(60, 80), targetActor(-60, -80),
    ]),
    blast("one-sided wall blocks blast damage", [targetActor(64, 0, { sector: 1 })], { map: wall }),
    blast("a closed two-sided door blocks blast damage", [targetActor(64, 0, { sector: 1 })], { map: closedDoor }),
    blast("blast checks REJECT from candidate to origin", [targetActor(64, 0, { sector: 1 })],
        { map: { ...blastMap, sectors: [blastMap.sectors[0], blastMap.sectors[0]], reject: [0x04] } }),
    blast("reverse REJECT bit alone does not block blast", [targetActor(64, 0, { sector: 1 })],
        { map: { ...blastMap, sectors: [blastMap.sectors[0], blastMap.sectors[0]], reject: [0x02] } }),
    blast("barrel damage falloff with no source handle", [targetActor(33, 25)],
        { damage: 30, source: 0, spot: targetActor(0, 0, { kind: barrel, flags: 0 }) }),
    blast("players can take splash damage from their own rockets", [],
        { owner: targetActor(40, 15, { kind: 0, slot: 0, radius: 16 * unit }) }),
    blast("rocket explosion runs blast damage and its drop before resuming missile jitter",
        [targetActor(16, 0, { health: 20, flags: shootable | 0x400000 })], { explode: true }),
    ...enemyDecisions,
    ...malformedSightFixtures.map(fixture => ({ ...fixture, malformed: true })),
];

function records(rows, size, write) {
    const bytes = Buffer.alloc(rows.length * size);
    rows.forEach((row, index) => write(bytes, index * size, row, index));
    return { bytes, count: rows.length };
}

function lumpData(fixture) {
    const { sectors, vertices, lines, segs, leaves, nodes, reject } = fixture;
    const sides = [];
    const lineSides = lines.map((_, lineId) => {
        const [, front = 0, back = -1] = segs.find(([id]) => id === lineId) ?? [];
        const right = sides.length;
        sides.push(front);
        if (back < 0) return [right, 0xffff];
        return [right, sides.push(back) - 1];
    });
    return {
        Sectors: records(sectors, 26, (bytes, offset, [floor, ceiling]) => {
            bytes.writeInt16LE(floor / unit, offset);
            bytes.writeInt16LE(ceiling / unit, offset + 2);
        }),
        Vertices: records(vertices, 4, (bytes, offset, [x, y]) => {
            bytes.writeInt16LE(x / unit, offset);
            bytes.writeInt16LE(y / unit, offset + 2);
        }),
        Sides: records(sides, 30, (bytes, offset, sector) => bytes.writeUInt16LE(sector, offset + 28)),
        Lines: records(lines, 14, (bytes, offset, [a, b, flags], lineId) => {
            bytes.writeUInt16LE(a, offset);
            bytes.writeUInt16LE(b, offset + 2);
            bytes.writeUInt16LE(flags, offset + 4);
            bytes.writeUInt16LE(lineSides[lineId][0], offset + 10);
            bytes.writeUInt16LE(lineSides[lineId][1], offset + 12);
        }),
        Segs: records(segs, 12, (bytes, offset, [lineId, front, , segStart, segEnd]) => {
            const [v1, v2] = lines[lineId] ?? [0, 0];
            const baseSide = lineSides[lineId]?.[0];
            const reversed = baseSide !== undefined && sides[baseSide] !== front;
            bytes.writeUInt16LE(segStart ?? (reversed ? v2 : v1), offset);
            bytes.writeUInt16LE(segEnd ?? (reversed ? v1 : v2), offset + 2);
            bytes.writeUInt16LE(lineId, offset + 6);
            bytes.writeUInt16LE(Number(reversed), offset + 8);
        }),
        Subsectors: records(leaves, 4, (bytes, offset, [count, first]) => {
            bytes.writeUInt16LE(count, offset);
            bytes.writeUInt16LE(first, offset + 2);
        }),
        Nodes: records(nodes, 28, (bytes, offset, [x, y, dx, dy, front, back]) => {
            [x, y, dx, dy].forEach((value, index) => bytes.writeInt16LE(value / unit, offset + index * 2));
            bytes.writeUInt16LE(front, offset + 24);
            bytes.writeUInt16LE(back, offset + 26);
        }),
        Reject: { bytes: Buffer.from(reject), count: reject.length, valid: !fixture.omitReject },
    };
}

function fletcherCases() {
    const lumps = [];
    let offset = 0;
    const point = ([x, y, z, height, sector]) =>
        `wad.SightEndpoint{X: ${x}, Y: ${y}, Z: ${z}, Height: ${height}, Sector: ${sector}}`;
    const branches = cases.map((fixture, index) => {
        const fields = Object.entries(lumpData(fixture)).map(([name, lump]) => {
            const field = `                ${name}: wad.Lump{Offset: ${offset}, Count: ${lump.count}, Valid: ${lump.valid ?? true}},`;
            lumps.push(lump.bytes);
            offset += lump.bytes.length;
            return field;
        });
        const change = fixture.movingCeiling;
        const changes = change ? `
            changed = changed.Append(play.SectorDoor{Sector: ${change.sector}, State: play.DoorState{Ceiling: ${change.height}}})
            level = changed.ApplyTo(level)` : "";
        const blast = fixture.blast;
        const enemyDecision = fixture.enemyDecision;
        const request = blast ? `
            spot, source, blastDamage, explode = ${blast.spot}, ${blast.source}, ${blast.damage}, ${blast.explode}
${blast.actors.map(a => `            world.Actors = world.Actors.AppendActor(makeActor(${[
            a.kind, a.flags, a.x, a.y, a.z, a.height, a.sector, a.radius, a.health, a.owner ?? 0, a.slot ?? -1,
        ].join(", ")}))`).join("\n")}` : enemyDecision ? `
            checkEnemy = true
            attacker := makeActor(${[enemyDecision.kind, enemyDecision.flags, ...fixture.viewer, 0, 500, 2, -1].join(", ")})
            attacker.ReactionTime = ${enemyDecision.reactionTime}
            victim := makeActor(${[enemyDecision.targetKind, shootable, ...fixture.target, 0, 500, 0, -1].join(", ")})
            world.Actors = world.Actors.AppendActor(attacker).AppendActor(victim)
            world.Random.GameplayIndex = ${enemyDecision.randomIndex}` : `
            viewer, target = ${point(fixture.viewer)}, ${point(fixture.target)}`;
        return `        case ${index}:
            level = wad.BspLevel{Valid: true, File: Geometry,
${fields.join("\n")}
            }
            ${request.trimStart()}${changes}`;
    });
    writeFileSync(path.join(scratch, "SIGHT.BIN"), Buffer.concat(lumps));
    return branches.join("\n");
}

function fletcherTrace() {
    const source = path.join(scratch, "main.flt"), output = path.join(scratch, "result.json");
    writeFileSync(source, `package main
import "wad"
import "play"
import "actorinfo"
import "enemy"
const Geometry = readFile("SIGHT.BIN")
func makeActor(kind int, flags bits<32>, x int, y int, z int, height int, sector int, radius int, health int,
    owner int, slot int) play.LevelActor {
    info := actorinfo.KindAt(kind)
    definition := actorinfo.StateAt(info.SpawnState)
    return play.LevelActor{Valid: true, Kind: kind, Health: health, Sector: sector, State: info.SpawnState,
        Tics: definition.Tics, Sprite: definition.Sprite, Frame: definition.Frame, Target: owner, PlayerSlot: slot,
        Physics: play.ActorPhysics{Body: play.MapActor{X: x, Y: y, Z: z, Radius: radius, Height: height,
            Flags: flags, Player: slot >= 0}}}
}
map "Doom sight parity" {
    screen at (0, 0) size (1, 1) with {style = "solid", hold = true, slice = true}
    tick {
        var level wad.BspLevel
        var viewer wad.SightEndpoint
        var target wad.SightEndpoint
        var changed play.LevelDoors
        var world play.CombatWorld
        var explode bit
        var checkEnemy bit
        spot, source, blastDamage := 0, 0, 0
        switch currentTick() {
${fletcherCases()}
        }
        if spot > 0 {
            blocks := wad.BlockMapInfo{Valid: true, OriginX: -(256 << 16), OriginY: -(256 << 16), Width: 4, Height: 4}
            world.Links = play.BuildActorLinks(world.Actors, blocks)
            world.Players[0] = play.NewPlayerInventory(500)
            rules := play.CombatRules{Skill: 2}
            var attack play.RadiusAttackStep
            var rocketTick play.MobjTick
            if explode {
                rocket := world.Actors.ActorAt(spot - 1)
                rocket.Physics.Body.Z, rocket.Physics.MomentumZ = 1 << 16, -2 << 16
                world.Actors = world.Actors.WithActor(spot, rocket)
                rocketTick = play.BeginMobjTick(level, blocks, world, spot, 0, false, rules)
                if rocketTick.Combat.State.Action != actorinfo.ActionExplode { log(6, rocketTick.Combat.State.Action) }
                attack = play.BeginExplodeAction(level, blocks, rocketTick.Combat.World, spot, rules)
            } else {
                attack = play.BeginRadiusAttack(level, blocks, world, spot, source, blastDamage, rules)
            }
            dropped := 0
            for range 72 {
                if !attack.Done && !attack.Combat.Failed {
                    hit := attack.Hit
                    if hit.Target != 0 { log(1, hit.Target, hit.Inflictor, hit.Source, hit.Amount) }
                    if attack.Combat.Feedback.DroppedActor != 0 { dropped = attack.Combat.Feedback.DroppedActor }
                    attack = play.ResumeRadiusAttack(level, attack, rules)
                }
            }
            world = attack.Combat.World
            sound := 0
            if explode {
                rocketTick.Combat.World = world
                rocketTick = play.ResumeMobjTick(level, blocks, rocketTick, rules)
                sound = rocketTick.Combat.Feedback.Sound
                for range 4 {
                    if !rocketTick.Done && !rocketTick.Combat.Failed {
                        rocketTick = play.ResumeMobjTick(level, blocks, rocketTick, rules)
                    }
                }
                if !rocketTick.Done || rocketTick.Combat.Failed { log(6, rocketTick.Done, rocketTick.Combat.Failed) }
                world = rocketTick.Combat.World
                rocket := world.Actors.ActorAt(spot - 1)
                body := rocket.Physics.Body
                if body.Z != body.Floor || body.Flags & play.MoveMissile != 0 { log(6, body.Z, body.Flags) }
                log(5, rocket.State, rocket.Tics)
            }
            log(2, attack.Done, attack.Combat.Failed, world.Actors.Count, world.Random.GameplayIndex,
                world.Players[0].KillCount, sound)
            if dropped > 0 {
                item := world.Actors.ActorAt(dropped - 1)
                log(3, item.Kind, world.Links.SectorFirst(0) == dropped, item.LastLook)
            }
            for index := range world.Actors.Count { log(4, world.Actors.ActorAt(index).Health) }
        } else if checkEnemy {
            attacker := world.Actors.ActorAt(0)
            melee := enemy.CheckMeleeRange(level, world.Actors, attacker)
            missile := enemy.CheckMissileRange(level, world.Actors, attacker, world.Random)
            log(melee, missile.Attack, missile.Actor.Physics.Body.Flags, missile.Random.GameplayIndex)
        } else {
            result := wad.CheckSight(level, viewer, target)
            log(result.Valid, result.Visible, result.Rejected, result.Leaves, result.Lines, result.EyeZ,
                result.BottomSlope, result.TopSlope)
        }
    }
}
`);
    const result = spawnSync("dotnet", [cli, "build", source, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const map = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(Buffer.from(map.data, "base64")[2], 1, "zlib-compressed logic map");
    const sim = simulator(decode(map.data), true);
    return cases.map(fixture => {
        const start = sim.logs.length;
        for (let host = 0; host < 64 && sim.logs.length === start; host++) sim.step();
        if (fixture.blast) {
            const rows = Array.from(sim.logs.slice(start), row => Array.from(row, Number));
            const hits = rows.filter(([tag]) => tag === 1).map(row => row.slice(1));
            const summary = rows.find(([tag]) => tag === 2);
            assert.deepEqual(summary?.slice(1, 3), [1, 0], fixture.name + " completed the sweep");
            const health = rows.filter(([tag]) => tag === 4).map(row => row[1]);
            const damage = new Map(hits.map(([handle, , , amount]) => [handle, amount]));
            const expected = fixture.blast.actors.map((actor, index) => actor.health - (damage.get(index + 1) ?? 0));
            assert.deepEqual(health.slice(0, expected.length), expected, fixture.name + " applied the damage");
            if (fixture.blast.explode) {
                assert.ok(!rows.some(([tag]) => tag === 6), fixture.name + " completed the rocket thinker");
                assert.deepEqual(summary.slice(3), [4, 3, 1, 82], fixture.name + " drop, RNG, kill credit and sound");
                assert.deepEqual(rows.find(([tag]) => tag === 3), [3, 63, 1, 1],
                    fixture.name + " linked the clip drop and used the second RNG draw");
                assert.deepEqual(rows.find(([tag]) => tag === 5), [5, 127, 7],
                    fixture.name + " completed the normal state timer after explosion jitter");
            }
            return [0, ...hits.flat()];
        }
        const [row] = sim.logs.slice(start);
        assert.equal(sim.logs.length, start + 1, fixture.name);
        if (fixture.enemyDecision) {
            const trace = Array.from(row, Number);
            assert.deepEqual(trace, fixture.enemyDecision.expected, fixture.name);
            return trace;
        }
        const [valid, ...trace] = Array.from(row, Number);
        assert.equal(valid, Number(!fixture.malformed), fixture.name);
        assert.equal(trace[0], Number(fixture.visible ?? false), fixture.name);
        return trace;
    });
}

const digest = trace => createHash("sha256").update(JSON.stringify(trace)).digest("hex");
try {
    const allTraces = fletcherTrace();
    const nativeCases = cases.filter(fixture => !fixture.malformed);
    const observed = allTraces.filter((_, index) => !cases[index].malformed);
    if (values.upstream) {
        const native = runNativeSightOracle(path.resolve(root, values.upstream), scratch, nativeCases);
        nativeCases.forEach(({ name }, index) => assert.deepEqual(observed[index], native[index], name));
        const blasts = nativeCases.filter(fixture => fixture.blast).length;
        console.log(`Matched ${native.length - blasts - enemyDecisions.length} sight traces, ${blasts} radius attacks, and ${enemyDecisions.length} enemy attack decisions with pinned Linux Doom C. SHA-256 ${digest(native)}.`);
    } else {
        assert.equal(digest(observed), "4312fac6e200553858fe9ee4c77e7c13b71d31be57df96ed453fa2ac63de6fb5");
        console.log(`Verified ${observed.length} sight, radius, and attack decision traces against the pinned C snapshot.`);
    }
    console.log(`Malformed input checks passed for ${cases.length - nativeCases.length} sight traces.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-sight-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
