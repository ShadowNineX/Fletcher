// Run map/plane callbacks through the campaign preview's combat-state bridge.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runNativeHeavyOracle } from "./doom-native-heavy-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-walkover-context-"));
const unit = 65536;
const seed = 113;

function room() {
    function words(values) {
        const data = Buffer.alloc(values.length * 2);
        values.forEach((value, i) => data.writeUInt16LE(value & 65535, i * 2));
        return data;
    }
    const sector = Buffer.alloc(26);
    sector.writeInt16LE(64, 2);
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0]];
    const block = words([-128, -128, 2, 2, 8, 8, 8, 8, 0, 0, 1, 2, 3, -1]);
    const lumps = [
        ["Vertices", 4, words([-96, -96, -96, 96, 96, 96, 96, -96])],
        ["Lines", 4, words(edges.flatMap(([a, b]) => [a, b, 1, 0, 0, 0, -1]))],
        ["Sides", 1, Buffer.alloc(30)], ["Sectors", 1, sector], ["Nodes", 0, Buffer.alloc(0)],
        ["Segs", 4, words(edges.flatMap(([a, b], i) => [a, b, [0x4000, 0, 0xc000, 0x8000][i], i, 0, 0]))],
        ["Subsectors", 1, words([4, 0])], ["BlockMap", block.length, block],
    ];
    writeFileSync(path.join(scratch, "LEVEL.WAD"), Buffer.concat(lumps.map(([, , bytes]) => bytes)));
    let offset = 0;
    return lumps.map(([name, count, data]) => {
        const field = `${name}: wad.Lump{Valid: true, Offset: ${offset}, Count: ${count}}`;
        offset += data.length;
        return field;
    }).join(",\n");
}

function probe() {
    const copy = path.join(scratch, "preview"), entry = path.join(copy, "main.flt");
    cpSync(path.join(port, "wad-bsp"), copy, { recursive: true });
    let source = readFileSync(entry, "utf8");
    const start = source.indexOf('map "Original WAD BSP View"');
    assert.ok(start > 0);
    source = source.slice(0, start);
    if (!source.includes('import "actorinfo"')) source = source.replace('import "play"', 'import "play"\nimport "actorinfo"');
    writeFileSync(entry, source + `
map "Campaign walkover callbacks" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true }
    tick {
        tic := currentTick()
        level := wad.BspLevel{File: Archive, Valid: true, ${room()}}
        blocks := wad.LoadBlockMap(level)
        random := play.RandomState{GameplayIndex: ${seed}, MenuIndex: 37}
        rules := play.CombatRules{Skill: 3, Fast: true}
        scene := PreviewCombat{Level: level, Base: level, GameTic: 63 + tic, RespawnMonsters: true, Rules: rules, Cues: cueMechanism}
        scene.LastSound = actorinfo.SoundPlatformStart
        scene.World.Random, scene.Specials.Lighting.Random = random, random
        scene.World.Players[0] = play.NewPlayerInventory(83)
        scene.World.AttackRange = 64 << 16
        scene.View.Weapon.Y, scene.View.Refire = 41 << 16, 5
        scene.Brain.EasyTurn = true
        handler := PreviewWalkoverTelefrag{Blocks: blocks}
        if tic < 2 {
            player := play.SpawnMobj(level, actorinfo.ActorPlayer, -(64 << 16), -(64 << 16), play.ActorOnFloor, rules.Skill, random).Actor
            player.PlayerSlot, player.Physics.Body.Player = 0, true
            eye := play.SpawnMobj(level, actorinfo.ActorBossEye, -(50 << 16), 0, play.ActorOnFloor, rules.Skill, random).Actor
            left := play.SpawnMobj(level, actorinfo.ActorBossTarget, -(32 << 16), 48 << 16, play.ActorOnFloor, rules.Skill, random).Actor
            right := play.SpawnMobj(level, actorinfo.ActorBossTarget, 48 << 16, 64 << 16, play.ActorOnFloor, rules.Skill, random).Actor
            shot := play.SpawnMobj(level, actorinfo.ActorTracer, 24 << 16, 32 << 16, 20 << 16, rules.Skill, random).Actor
            shot.Physics.MomentumX = 3 << 16
            tracer := play.SetMobjStateWithFast(shot, actorinfo.StateAt(shot.State).Next, rules.Fast)
            actors := play.MapActors{}.AppendActor(player).AppendActor(eye).AppendActor(left).AppendActor(right)
            actors.PlayerActors[0] = 1
            scene.MapActors = actors.Count
            scene.World.Actors = actors.AppendTransient(tracer.Actor)
            scene.World.Links = play.BuildActorLinks(scene.World.Actors, blocks)
            scene.Hearing.Graph = play.BuildSoundGraph(level)
            scene.Hearing.Targets = play.NoiseAlert(level, scene.Hearing.Graph, scene.Hearing.Targets, 0, 1)
            state := previewWalkoverState(scene)
            state = handler.OnTelefrag(state, play.CombatStep{World: state.World, ActorHandle: 5, State: tracer}, rules)
            quiet := resumePreviewWalkover(scene, state)
            log("quiet", scene.GameTic, state.DamageSound, quiet.LastSound == actorinfo.SoundPlatformStart, quiet.Cues)
            for index := range state.World.Actors.Count - 5 {
                effect := state.World.Actors.ActorAt(index + 5)
                body := effect.Physics.Body
                log("trail", scene.GameTic, effect.Kind, body.X, body.Y, body.Z, effect.Physics.MomentumX,
                    effect.Physics.MomentumY, effect.Physics.MomentumZ, effect.Tics, effect.State, effect.LastLook)
            }
            // A second callback runs before the caller resumes. It must see
            // the old easy-skill alternator and publish the newly found targets.
            awake := play.SetMobjStateWithFast(eye, actorinfo.KindAt(eye.Kind).SeeState, rules.Fast)
            state.World.Actors = state.World.Actors.WithActor(2, awake.Actor)
            state = handler.OnTelefrag(state, play.CombatStep{World: state.World, ActorHandle: 2, State: awake}, rules)
            scene = resumePreviewWalkover(scene, state)
            log("context", scene.GameTic, scene.Failed, tracer.Action == actorinfo.ActionTracer,
                awake.Action == actorinfo.ActionBrainAwake, scene.World.Random.GameplayIndex, scene.World.Random.MenuIndex,
                scene.World.Actors.Count, scene.Brain.Count, scene.Brain.Cursor, scene.Brain.Targets[0], scene.Brain.Targets[1],
                scene.Brain.EasyTurn, scene.Hearing.Targets.At(0).Target, scene.LastSound, scene.Cues,
                scene.View.Weapon.Y, scene.View.Refire, scene.World.Players[0].Health, scene.World.AttackRange,
                scene.MapActors, scene.Rules.Skill, scene.Rules.Fast, scene.RespawnMonsters)
        } else {
            // ChangeSector receives a genuine candidate ceiling and a native
            // 16-unit boss brain. Its pain callback runs before blood is added.
            kind := actorinfo.KindForThing(88)
            if tic == 3 { kind = actorinfo.ActorPlayer }
            victim := play.SpawnMobj(level, kind, 32 << 16, 32 << 16, play.ActorOnFloor, rules.Skill, random).Actor
            if tic == 3 {
                victim.PlayerSlot, victim.Physics.Body.Player, victim.Health = 0, true, 8
                scene.World.Players[0] = play.NewPlayerInventory(8)
                scene.World.Actors.PlayerActors[0] = 1
            }
            scene.World.Actors = scene.World.Actors.AppendActor(victim)
            scene.MapActors = 1
            scene.World.Links = play.BuildActorLinks(scene.World.Actors, blocks)
            scene.Specials.Ceilings = scene.Specials.Ceilings.Append(play.SectorCeiling{Sector: 0, Motion: play.CeilingState{Height: 8 << 16}})
            scene.Level = scene.Specials.ApplyTo(level)
            step := play.ChangeSector(previewWalkoverState(scene), blocks, 0, 4, true, rules, handler)
            scene = resumePreviewWalkover(scene, step.State)
            victim = scene.World.Actors.ActorAt(0)
            blood := scene.World.Actors.ActorAt(1)
            if tic == 2 {
                log("plane", scene.Failed, step.Blocked, step.Changed, victim.Health, victim.State == actorinfo.KindAt(victim.Kind).PainState,
                    victim.Tics, victim.Damaged, scene.FirstActive, step.DamageSound, scene.LastSound, scene.Cues,
                    blood.Valid && blood.Kind == actorinfo.ActorBlood, blood.Physics.Body.Z, scene.World.Random.GameplayIndex,
                    scene.World.Random.MenuIndex, scene.Level.SectorHeightsAt(0).Ceiling, scene.Base.SectorHeightsAt(0).Ceiling)
            } else {
                inventory := scene.World.Players[0]
                log("drop", scene.Failed, step.Blocked, step.Changed, inventory.Dead, inventory.Health, victim.Health,
                    victim.State == actorinfo.KindAt(victim.Kind).DeathState, scene.View.Weapon.State == actorinfo.WeaponAt(inventory.ReadyWeapon).Down,
                    scene.View.Weapon.Y, scene.View.Weapon.Tics, scene.View.Refire, step.DamageSound, blood.Valid && blood.Kind == actorinfo.ActorBlood,
                    scene.Rules.Skill, scene.Rules.Fast)
            }
        }
    }
}`);
    const output = path.join(scratch, "bridge.json");
    const build = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output],
        { encoding: "utf8", timeout: 60000 });
    if (build.error) throw build.error;
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let i = 0; i < 4; i++) sim.step();
    return sim.logs;
}

function nativeTracer(tics) {
    const actor = { kind: 6, x: 24 * unit, y: 32 * unit, z: 20 * unit, mx: 3 * unit, my: 0, mz: 0,
        angle: 0, health: 1000, flags: 0x10610 };
    const cases = tics.map(gameTic => ({ actor, target: { ...actor, kind: 0 }, actions: ["tracer"], gameTic,
        rng: seed, tryMove: true, attackRange: 64 * unit, skulls: 0, split: 0 }));
    return runNativeHeavyOracle(path.resolve(root, values.upstream), scratch, cases).map(([step]) => [
        step.spawns.map(s => [...s.slice(0, 4), ...s.slice(5, 9), s[11], s[12]]), step.rng,
    ]);
}

try {
    const logs = probe();
    const rows = tag => logs.filter(row => row[0] === tag).map(row => row.slice(1).map(Number));
    const tics = [63, 64];
    const expected = [
        [[], seed],
        [[[37, 1572864, 2097152, 1301504, 0, 0, 65536, 4, 95, 3],
          [7, 1376256, 2097152, 1310720, 0, 0, 65536, 4, 311, 3]], 119],
    ];
    if (values.upstream) assert.deepEqual(nativeTracer(tics), expected, "pinned A_Tracer and native effect allocation");
    assert.deepEqual(rows("quiet"), [[63, 0, 1, 16], [64, 0, 1, 16]], "a silent tracer retains the earlier sound without emitting a damage sound");
    assert.equal(rows("context").length, 2);
    for (const [i, tic] of tics.entries()) {
        const [spawns, rng] = expected[i];
        assert.deepEqual(rows("trail").filter(([game]) => game === tic).map(row => row.slice(1)), spawns,
            "walkover tracer trail at game tic " + tic);
        assert.deepEqual(rows("context")[i], [tic, 0, 1, 1, rng, 37, 5 + spawns.length,
            2, 0, 3, 4, 1, 1, 96, 24, 41 * unit, 5, 83, 64 * unit, 4, 3, 1, 1],
            "brain, hearing, actor and weapon state after chained callbacks at game tic " + tic);
    }
    assert.deepEqual(rows("plane"), [[0, 1, 1, 240, 1, 36, 1, 1, 97, 97, 24, 1, 8 * unit, 119, 37,
        8 * unit, 64 * unit]], "the real crusher retains brain pain and the blood allocated after its callback");
    assert.deepEqual(rows("drop"), [[0, 1, 1, 1, 0, -2, 1, 1, 47 * unit, 1, 5, 0, 1, 3, 1]],
        "lethal plane damage lowers the original player weapon exactly once without an entry action");
    console.log("Preview walkover callbacks passed tracer tics 63/64, chained brain awakening, crusher pain and lethal weapon lowering.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-walkover-context-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
