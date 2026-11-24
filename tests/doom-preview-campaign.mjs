// Exercise a secret campaign route and return through the production WAD preview.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runNativeHeavyOracle } from "./doom-native-heavy-oracle.mjs";
import { runNativeDamageOracle } from "./doom-native-damage-oracle.mjs";
import { runNativeActorOracle } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: {
    cli: { type: "string" }, upstream: { type: "string" }, "low-detail": { type: "boolean" },
} });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-campaign-"));
const unit = 65536;

function words(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => bytes.writeUInt16LE(value & 65535, index * 2));
    return bytes;
}

function wad(lumps) {
    const directory = 12 + lumps.reduce((length, [, bytes]) => length + bytes.length, 0);
    const result = Buffer.alloc(directory + lumps.length * 16);
    result.write("PWAD");
    result.writeInt32LE(lumps.length, 4);
    result.writeInt32LE(directory, 8);
    let offset = 12;
    for (const [index, [name, bytes]] of lumps.entries()) {
        const entry = directory + index * 16;
        result.writeInt32LE(offset, entry);
        result.writeInt32LE(bytes.length, entry + 4);
        result.write(name, entry + 8);
        bytes.copy(result, offset);
        offset += bytes.length;
    }
    return result;
}

function solidPatch(width, height, color) {
    const firstColumn = 8 + width * 4;
    const columnSize = height + 5;
    const result = Buffer.alloc(firstColumn + width * columnSize);
    result.writeInt16LE(width, 0);
    result.writeInt16LE(height, 2);
    for (let column = 0; column < width; column++) {
        const offset = firstColumn + column * columnSize;
        result.writeUInt32LE(offset, 8 + column * 4);
        result[offset] = 0;
        result[offset + 1] = height;
        result.fill(color, offset + 3, offset + 3 + height);
        result[offset + 4 + height] = 255;
    }
    return result;
}

function intermissionResources() {
    const palette = Buffer.alloc(256 * 3);
    palette.set([255, 0, 0], 3);
    palette.set([255, 255, 255], 6);
    return [["PLAYPAL", palette], ["COLORMAP", Buffer.from(Array.from({ length: 33 * 256 }, (_, index) => index & 255))],
        ["WIMAP0", solidPatch(320, 200, 1)], ["INTERPIC", solidPatch(320, 200, 1)],
        ...[0, 1, 2].map(frame => [`WIA0000${frame}`, solidPatch(12, 12, 2)]),
        ["F_START", Buffer.alloc(0)], ["SLIME16", Buffer.alloc(4096, 2)], ["F_END", Buffer.alloc(0)]];
}

function level(marker, exitAction, withBlueCard = false, sectorSpecial = 0, { startX = 0, extraThings = [], scrolling = false, halfWidth = 64 } = {}) {
    const vertices = words([-halfWidth, -64, halfWidth, -64, halfWidth, 64, -halfWidth, 64]);
    const columns = halfWidth / 64;
    const blockmap = words([-halfWidth, -64, columns, 1, ...Array(columns).fill(4 + columns), 0, 1, 2, 3, -1]);
    // The exit must face the player: Doom's use dispatch only accepts its front side.
    const actions = [scrolling ? 48 : 0, exitAction, scrolling ? 48 : 0, 0];
    const lines = Buffer.concat([[0, 1], [2, 1], [2, 3], [3, 0]].map(([first, last], index) =>
        words([first, last, 0, actions[index], 0, 0, 65535])));
    const sides = Buffer.alloc(30);
    const segs = Buffer.concat([[0, 1], [1, 2], [2, 3], [3, 0]].map(([first, last], index) =>
        words([first, last, 0, index, 0, 0])));
    const sector = Buffer.alloc(26);
    sector.writeInt16LE(128, 2);
    sector.write("FLOOR0_1", 4);
    sector.write("CEIL1_1", 12);
    sector.writeInt16LE(160, 20);
    sector.writeInt16LE(sectorSpecial, 22);
    const things = [startX, 0, 0, 1, 7, ...extraThings];
    if (withBlueCard) things.push(10, 0, 0, 5, 7);
    return [[marker, Buffer.alloc(0)], ["THINGS", words(things)], ["LINEDEFS", lines], ["SIDEDEFS", sides],
        ["VERTEXES", vertices], ["SEGS", segs], ["SSECTORS", words([4, 0])], ["NODES", Buffer.alloc(0)],
        ["SECTORS", sector], ["REJECT", Buffer.alloc(1)],
        ["BLOCKMAP", blockmap]];
}

function campaignWad() {
    return wad([
        ...level("E1M3", 51, true, 5, { scrolling: true }),
        ...level("E1M9", 11),
        ...level("E1M4", 11),
        ...intermissionResources(),
    ]);
}

function tracerSource(source) {
    const seed = "                combat.GameTic, combat.World.AttackRange = gameTime, attackRange";
    const tick = "                    stepped := tickPreviewDynamicThinkers(combat, blockMap, levelTime)";
    assert.ok(source.includes(seed) && source.includes(tick));
    source = source.replace('import "automap"', 'import "actorinfo"\nimport "automap"');
    // A targetless, stationary tracer isolates the native trail gate. Its
    // first state expires now, then the two-tic native frames alternate.
    source = source.replace(seed, `${seed}
                if levelTime == 0 && base.MapName.Low == ${marker("E1M2")[0]} {
                    shot := play.SpawnMobj(combat.Level, actorinfo.ActorTracer, -(32 << 16), 32 << 16,
                        48 << 16, skill, combat.World.Random)
                    shot.Actor.Tics = 1
                    linked := combat.World.Links.SetActorPosition(combat.Level, combat.World.Actors.NextTransientHandle(), shot.Actor)
                    combat.World.Actors = combat.World.Actors.AppendTransient(linked.Actor)
                    combat.World.Links, combat.World.Random = linked.Links, shot.Random
                }`);
    return source.replace(tick, `${tick}
                    if base.MapName.Low == ${marker("E1M2")[0]} {
                        before := combat.World.Actors
                        after := stepped.Combat.World.Actors
                        shot := before.ActorAt(1)
                        log("tracer-state", gameTime, levelTime, shot.Tics, shot.State, after.ActorAt(1).State,
                            combat.World.Random.GameplayIndex, stepped.Combat.World.Random.GameplayIndex)
                        h := after.TransientFirst()
                        for range after.Count {
                            if after.TransientOrder(h) >= before.NextThinkerOrder {
                                log("tracer-spawn", levelTime, after.ActorAt(h - 1).Kind)
                            }
                            h = after.TransientNext(h)
                        }
                    }`);
}

function meleeActionSource(source) {
    const launch = "        return pendingVolley(scene, enemy.BeginMonsterAttack(scene.Level, blocks, scene.World, handle, action, rules))";
    const trail = "        scene = observePreviewCombat(scene, enemy.RunTracer(scene.Level, scene.World, handle, scene.GameTic, rules))";
    assert.ok(source.includes(launch) && source.includes(trail));
    return source.replace(launch, `        if action == actorinfo.ActionSkelMissile {
            scene.TraceLaunch = handle
        }
${launch}`).replace(trail, `        old := scene.World
${trail}
        if scene.World.Actors.NextThinkerOrder > old.Actors.NextThinkerOrder {
            shot := old.Actors.ActorAt(handle - 1)
            puffID := old.Actors.NextTransientHandle()
            scene.TraceMissile = handle
            scene.TracePuff = scene.World.Actors.ActorAt(puffID - 1)
            scene.TraceSmoke = scene.World.Actors.ActorAt(scene.World.Actors.TransientNext(puffID) - 1)
            scene.TraceShot, scene.TracePrey = shot, old.Actors.ActorAt(shot.Tracer - 1)
            scene.TraceRange, scene.TraceStart, scene.TraceEnd = old.AttackRange, old.Random.GameplayIndex, scene.World.Random.GameplayIndex
        }`);
}

function previewSource(mode = "normal") {
    const preview = path.join(scratch, mode + "-preview");
    mkdirSync(preview);
    for (const name of readdirSync(path.join(port, "wad-bsp")).filter(name => name.endsWith(".flt"))) {
        let source = readFileSync(path.join(port, "wad-bsp", name), "utf8");
        if (values["low-detail"] && name === "display.flt") {
            assert.match(source, /^const LowDetail = false$/m);
            source = source.replace(/^const LowDetail = false$/m, "const LowDetail = true");
        }
        if (mode === "melee" && name === "combat-preview.flt") {
            const decl = "type PreviewCombat struct {";
            assert.ok(source.includes(decl));
            source = source.replace(decl, decl + "\n" + [
                ...["TracePuff", "TraceSmoke", "TraceShot", "TracePrey"].map(field => field + " play.LevelActor"),
                ...["TraceRange", "TraceStart", "TraceEnd", "TraceLaunch", "TraceMissile"].map(field => field + " int"),
            ].join("\n") + "\n");
        }
        if (name === "action-preview.flt" && mode === "melee") source = meleeActionSource(source);
        if (name === "main.flt") {
            if (mode === "clock") source = tracerSource(source);
            const insertion = "                    next player = moved";
            assert.ok(source.includes(insertion));
            if (mode === "melee") {
                const actors = "                    combat = stepped.Thinkers.Combat";
                const dynamics = "                    stepped := tickPreviewDynamicThinkers(combat, blockMap, levelTime)";
                assert.ok(source.includes(actors) && source.includes(dynamics));
                source = source.replace(actors, `${actors}
                    if combat.TraceLaunch != 0 {
                        log("revenant-launch", gameTime, combat.TraceLaunch, combat.World.Actors.ActorAt(combat.TraceLaunch - 1).Target)
                    }`).replace(dynamics, `${dynamics}
                    witness := stepped.Combat
                    if witness.TracePuff.Valid {
                        shot, prey := witness.TraceShot, witness.TracePrey
                        body := shot.Physics
                        puff, smoke := witness.TracePuff, witness.TraceSmoke
                        log("revenant-trail", gameTime, witness.TraceRange, witness.TraceStart, witness.TraceEnd,
                            shot.Kind, shot.Target, shot.Tracer, body.Body.X, body.Body.Y, body.Body.Z, body.Angle,
                            body.MomentumX, body.MomentumY, body.MomentumZ, shot.Health, body.Body.Flags,
                            prey.Kind, prey.Physics.Body.X, prey.Physics.Body.Y, prey.Physics.Body.Z, prey.Health,
                            witness.TraceMissile, combat.World.Actors.TransientOrder(witness.TraceMissile))
                        log("revenant-puff", puff.Kind, puff.Physics.Body.X, puff.Physics.Body.Y, puff.Physics.Body.Z,
                            puff.Physics.MomentumZ, puff.Tics, puff.State, smoke.Kind, smoke.Tics, smoke.State)
                    }
                    if witness.World.Players[0].Health < combat.World.Players[0].Health {
                        before := combat.World.Actors
                        first := before.TransientFirst()
                        log("missile-impact", base.MapName.High, gameTime, first, before.TransientOrder(first), combat.World.Random.GameplayIndex,
                            witness.World.Random.GameplayIndex, witness.World.Players[0].Health,
                            witness.World.Players[0].DamageCount, witness.World.Players[0].Attacker)
                        for i := range 3 {
                            a := before.ActorAt(i)
                            b := a.Physics.Body
                            log("impact-before", base.MapName.High, i + 1, a.Kind, b.Flags, a.Health, b.X, b.Y, b.Z, b.Height,
                                a.Physics.MomentumX, a.Physics.MomentumY, a.Physics.MomentumZ, a.Threshold, a.ReactionTime, a.Target, a.Tics)
                            after := witness.World.Actors.ActorAt(i)
                            log("impact-after", base.MapName.High, i + 1, after.Health, after.Physics.Body.Flags, after.Physics.MomentumX,
                                after.Physics.MomentumY, after.Physics.MomentumZ, after.State, after.Tics, after.Target)
                        }
                    }`);
                const start = "                            start := spawned.ActorAt(spawned.PlayerActors[0] - 1)";
                const finish = "                        next inventory = finished.Inventory";
                assert.ok(source.includes(start) && source.includes(finish));
                source = source.replace(start, `${start}
                            log("combat-load", level.MapName.High, carry.Health, start.Health, random.GameplayIndex, spawned.Random.GameplayIndex)`)
                    .replace(finish, `                        log("combat-exit", base.MapName.High, finished.Inventory.Health, lighting.Random.GameplayIndex)
${finish}`);
                source = source.replace(insertion, `                    log("melee-input", base.MapName.High, frame.Contacts.Inventory.ReadyWeapon,
                        heldWeapon.Weapon.State, attackRange, frame.Contacts.Inventory.Ammo[play.AmmoClip])
${insertion}`);
            }
            source = source.replace(insertion, `
                    log("campaign-tic", gameTime, levelTime, base.MapName.Low, base.MapName.High,
                        moved.Body.X, frame.Contacts.Inventory.Health, frame.Contacts.Inventory.Ammo[play.AmmoClip],
                        frame.Contacts.Inventory.Cards[play.CardBlue], campaignSkill, actors.Count,
                        lightState.Random.GameplayIndex, lightState.Random.MenuIndex, weaponView.Weapon.State,
                        player.Body.Y, player.MomentumX, scrolled.OffsetForSide(base.Sides.Offset))
${insertion}`);
            const picker = "            next campaignMenu = menuStep.Menu";
            assert.ok(source.includes(picker));
            source = source.replace(picker, `            if menuStep.Changed { log("campaign-menu", menuStep.Menu.Stage, menuStep.Menu.Cursor) }
            if menuStep.Start { log("campaign-start-request", gameTime) }
${picker}`);
            const story = "            } else if finale.Stage != play.FinaleInactive {";
            assert.ok(source.includes(story));
            source = source.replace(story, story + '\n                if finale.Stage == play.FinaleStory { log("campaign-story-tic", 51 - finale.Tics, gameTime) }');
        }
        writeFileSync(path.join(preview, name), source);
    }
    return path.join(preview, "main.flt");
}

function marker(name) {
    const bytes = Buffer.alloc(8);
    bytes.write(name);
    return [bytes.readInt32LE(0), bytes.readInt32LE(4)];
}

function build(entry, input) {
    const output = path.join(scratch, "campaign.json");
    writeFileSync(path.join(scratch, "LEVEL.WAD"), input);
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    return simulator(decode(encoded), true);
}

function rows(sim) {
    return sim.logs.filter(row => row[0] === "campaign-tic").map(([
        , game, levelTime, low, high, x, health, clip, blue, skill, actors, gameplayRandom, menuRandom, weapon, y, momentum, scroll,
    ]) =>
        ({ game: Number(game), levelTime: Number(levelTime), marker: [Number(low), Number(high)], x: Number(x),
            health: Number(health), clip: Number(clip), blue: Number(blue), skill: Number(skill), actors: Number(actors),
            gameplayRandom: Number(gameplayRandom), menuRandom: Number(menuRandom), weapon: Number(weapon),
            y: Number(y), momentum: Number(momentum), scroll: Number(scroll) }));
}

function stepUntil(sim, keys, predicate, message) {
    for (let host = 0; host < 220 && !predicate(); host++) sim.step([], new Map(), keys);
    assert.ok(predicate(), `${message}: ${JSON.stringify(sim.logs.slice(-10))}`);
}

function pulseUntil(sim, predicate, message) {
    for (let host = 0; host < 500 && !predicate(); host++) {
        sim.step([], new Map(), host % 16 < 8 ? [6] : []);
    }
    assert.ok(predicate(), `${message}: ${JSON.stringify(sim.logs.slice(-10))}`);
}

function settle(sim, keys = []) {
    for (let host = 0; host < 12; host++) sim.step([], new Map(), keys);
}

function menuRows(sim) {
    return sim.logs.filter(row => row[0] === "campaign-menu").map(([, stage, cursor]) => [Number(stage), Number(cursor)]);
}

function menuKey(sim, key, stage, cursor) {
    settle(sim);
    const count = menuRows(sim).length;
    stepUntil(sim, [key], () => menuRows(sim).length > count, `menu key ${key} changes the selection`);
    assert.deepEqual(menuRows(sim).at(-1), [stage, cursor]);
}

function framebuffer(sim) {
    return Buffer.from(Array.from({ length: 128 * 96 }, (_, index) => sim.tileAt({
        x: index % 128 - 64, y: Math.floor(index / 128) - 48,
    }).extra));
}

function checkpointCommands(sim, holdLoad = false) {
    const start = rows(sim).length;
    const frames = [];
    const fire = holdLoad ? [18, 12] : [18];
    for (const [keys, tics] of [[fire, 7], [[], 2], [[19], 4], [[23], 5]]) {
        const target = rows(sim).length + tics;
        stepUntil(sim, keys, () => rows(sim).length >= target, "run checkpoint replay command");
        frames.push(framebuffer(sim));
    }
    return { trace: rows(sim).slice(start), frames };
}

function exerciseNewCampaign(entry) {
    const hardPickup = [-48, 0, 0, 2007, 4];
    const sim = build(entry, wad([
        ...level("E1M1", 0, true, 5),
        ...level("E2M1", 11, false, 0, { startX: 16, extraThings: hardPickup }),
        ...level("E2M2", 0, false, 0, { extraThings: hardPickup }),
        ...level("E3M1", 0).filter(([name]) => name !== "BLOCKMAP"),
        ...intermissionResources(),
    ]));
    stepUntil(sim, [], () => rows(sim).length > 0, "render the default episode");
    stepUntil(sim, [18], () => rows(sim).at(-1).clip < 50, "change inventory before starting a new campaign");
    stepUntil(sim, [16], () => sim.logs.some(row => row[0] === "Doom paused"), "pause the old episode");
    settle(sim);
    const oldFrame = framebuffer(sim);
    const oldTicCount = rows(sim).length;

    menuKey(sim, 20, 1, 0);
    settle(sim, [20]);
    const episodeFrame = framebuffer(sim);
    assert.notDeepEqual(episodeFrame, oldFrame, "the campaign menu is painted on the live display");
    assert.equal(menuRows(sim).length, 1, "holding T cannot immediately close the menu");
    menuKey(sim, 23, 1, 2);
    menuKey(sim, 19, 1, 0);
    menuKey(sim, 6, 2, 2);
    menuKey(sim, 20, 1, 0);
    assert.deepEqual(framebuffer(sim), episodeFrame, "returning to episode selection clears the previous panel");
    menuKey(sim, 20, 0, 0);
    settle(sim);
    assert.deepEqual(framebuffer(sim), oldFrame, "cancel restores the complete paused framebuffer");
    assert.equal(rows(sim).length, oldTicCount, "the paused level holds through opening and closing the menu");

    menuKey(sim, 20, 1, 0);
    menuKey(sim, 23, 1, 2);
    menuKey(sim, 6, 2, 2);
    menuKey(sim, 23, 2, 1);
    menuKey(sim, 6, 0, 1);
    stepUntil(sim, [], () => sim.logs.some(row => row[0] === "Doom campaign level has no valid BLOCKMAP"),
        "reject an episode whose map cannot run");
    assert.deepEqual(framebuffer(sim), oldFrame, "a failed start keeps the previous framebuffer");
    assert.equal(rows(sim).length, oldTicCount, "a failed start keeps the previous pause state");

    menuKey(sim, 20, 1, 0);
    menuKey(sim, 19, 1, 1);
    menuKey(sim, 6, 2, 2);
    menuKey(sim, 19, 2, 3);
    menuKey(sim, 19, 2, 4);
    menuKey(sim, 6, 3, 0);
    settle(sim, [6]);
    assert.deepEqual(menuRows(sim).at(-1), [3, 0], "holding F cannot dismiss the Nightmare prompt");
    menuKey(sim, 6, 2, 4);
    menuKey(sim, 6, 3, 0);
    menuKey(sim, 19, 3, 1);
    menuKey(sim, 6, 0, 1);
    stepUntil(sim, [], () => rows(sim).length > oldTicCount, "the selected episode loads and resumes play");
    const first = rows(sim)[oldTicCount];
    assert.deepEqual(first.marker, marker("E2M1"));
    const [, confirmationTic] = sim.logs.findLast(([tag]) => tag === "campaign-start-request");
    assert.ok(confirmationTic > rows(sim)[oldTicCount - 1].game, "the game clock advanced through the paused menu");
    assert.deepEqual([first.game, first.levelTime, first.x, first.health, first.clip, first.blue, first.skill, first.actors],
        [confirmationTic, 0, 16 * unit, 100, 50, 0, 4, 2],
        "a fresh Nightmare start keeps the game clock, resets level time and inventory, and spawns the hard pickup");

    stepUntil(sim, [23], () => rows(sim).at(-1).x > 32 * unit, "reach E2M1's exit");
    stepUntil(sim, [6], () => sim.logs.some(row => row[0] === "Doom level exit requested"), "exit E2M1");
    pulseUntil(sim, () => rows(sim).at(-1).marker[0] === marker("E2M2")[0], "advance to E2M2");
    assert.deepEqual([rows(sim).at(-1).skill, rows(sim).at(-1).actors], [4, 2], "skill and its spawn filter survive level advance");
}

function exerciseCampaignTracer() {
    const sim = build(previewSource("clock"), wad([...level("E1M1", 11, false, 0, { startX: 32 }), ...level("E1M2", 0)]));
    // Two initial tics put the two four-tic gates exactly out of phase.
    stepUntil(sim, [], () => rows(sim).length >= 2, "run the first map before using its exit");
    stepUntil(sim, [6], () => sim.logs.some(row => row[0] === "Doom level exit requested"), "use E1M1's exit switch");
    pulseUntil(sim, () => sim.logs.some(row => row[0] === "Doom next level rendered"), "continue the intermission");
    const states = () => sim.logs.filter(([tag]) => tag === "tracer-state").map(row => row.slice(1).map(Number));
    stepUntil(sim, [], () => states().length >= 5, "run the tracer's first five tics on E1M2");
    const trace = states().slice(0, 5);
    const phase = trace[0][0];
    assert.ok(phase > rows(sim).filter(row => row.marker[0] === marker("E1M1")[0]).at(-1).game);
    assert.equal(phase % 4, 2, `campaign phase on E1M2 tic zero (game tic ${phase})`);
    const callbacks = [];
    for (const [index, [game, levelTime, tics, before, after, rng, afterRng]] of trace.entries()) {
        assert.deepEqual([game, levelTime, tics, before !== after], [phase + index, index, 1 + index % 2, index % 2 === 0]);
        const spawns = sim.logs.filter(([tag, time]) => tag === "tracer-spawn" && Number(time) === index).map(row => Number(row[2]));
        const emitted = game % 4 === 0 && tics === 1;
        assert.deepEqual(spawns, emitted ? [37, 7] : [], `puff and smoke at game tic ${game}, level tic ${levelTime}`);
        assert.equal(afterRng, (rng + (emitted ? 6 : 0)) & 255);
        if (tics === 1) callbacks.push({ game, rng, afterRng, spawns });
    }
    if (values.upstream) {
        const shot = { kind: 6, x: -32 * unit, y: 32 * unit, z: 48 * unit, mx: 0, my: 0, mz: 0,
            angle: 0, health: 1000, flags: 0x10610 };
        const cases = callbacks.map(({ game, rng }) => ({ actor: shot, target: { ...shot, kind: 0 },
            actions: ["tracer"], gameTic: game, rng, tryMove: true, attackRange: 0, skulls: 0, split: 0 }));
        const native = runNativeHeavyOracle(path.resolve(root, values.upstream), scratch, cases);
        for (const [i, [action]] of native.entries()) {
            assert.deepEqual([callbacks[i].spawns, callbacks[i].afterRng], [action.spawns.map(row => row[0]), action.rng]);
        }
    }
    console.log(`Campaign tracer passed game tics ${callbacks.map(row => row.game)} against E1M2 tics 0,2,4.`);
}

function verifyMissileImpact(sim, map, enemyKind, missileKind, initialHp, playerX) {
    const tagged = name => sim.logs.filter(([tag, high]) => tag === name && Number(high) === marker(map)[1]).map(row => row.slice(2).map(Number));
    stepUntil(sim, [], () => tagged("missile-impact").length > 0, `follow the first ${map} missile into the stationary player`);
    const [game, missile, order, rng, endRng, hp, damage, attacker] = tagged("missile-impact")[0];
    assert.ok(hp < initialHp && hp > 0);
    const before = tagged("impact-before"), after = tagged("impact-after");
    assert.deepEqual(before.map(row => row.slice(0, 2)), [[1, 0], [2, enemyKind], [missile, missileKind]]);
    assert.deepEqual([before[0][3], before[0][4], before[0][5], after[0][1], attacker, damage],
        [initialHp, playerX * unit, 0, hp, 2, initialHp - hp]);
    assert.ok(before[2][2] & 0x10000);
    assert.equal(after[2][2] & 0x10000, 0);
    assert.deepEqual(after[2].slice(3, 6), [0, 0, 0], "impact stops missile momentum");
    assert.equal(endRng, (rng + 3) & 255, "contact damage, pain and explosion each draw from gameplay RNG");
    if (values.upstream) {
        // Move the occupied portion of the synthetic room into the C harness's open sector.
        // Whole columns preserve the subcell X offset and the Y shift aligns the two origins.
        const shiftX = playerX > 0 ? -256 : 256;
        const actors = before.map(([id, kind, flags, health, x, y, z, height, mx, my, mz, threshold, reaction, target, tics]) =>
            ({ kind, flags, health, x: x + shiftX * unit, y: y - 64 * unit, z, height, mx, my, mz, threshold, reaction, target, tics, slot: id === 1 ? 0 : -1 }));
        const players = Array.from({ length: 4 }, () => ({ health: initialHp, armor: 0, armorType: 0, invulnerable: 0,
            ready: 0, cheats: 0, damageCount: 0, attacker: 0, killCount: 0, frags: [0, 0, 0, 0] }));
        const [native] = runNativeDamageOracle(path.resolve(root, values.upstream), scratch, [{ actors, players, move: missile,
            skill: 2, consolePlayer: 0, automap: false, sectorSpecial: 0, randomIndex: rng, rollOnAction: false }]);
        const nativeActors = native.filter(row => row[0] === 5);
        for (const i of [0, 2]) {
            const a = nativeActors[i];
            assert.deepEqual(after[i].slice(1), [a[1], a[2], a[4], a[5], a[6], a[7], a[8], a[9]],
                i === 0 ? "native victim damage, thrust and pain" : "native missile explosion state and tics");
        }
        const inventory = native.find(row => row[0] === 6);
        assert.deepEqual([hp, damage, attacker, endRng], [inventory[1], inventory[4], inventory[5], native.find(row => row[0] === 8)[1]]);
    }
    console.log(`${map} missile hit at game tic ${game}: ${damage} damage, missile state ${after[2][6]}, RNG ${rng}→${endRng}.`);
    return { hp, game, missile, order, explosion: after[2][6], damage };
}

function exerciseCampaignMeleeTrail() {
    const sim = build(previewSource("melee"), wad([
        ...level("MAP01", 11, false, 0, { halfWidth: 384, startX: 352, extraThings: [-160, 0, 0, 3001, 7] }),
        ...level("MAP02", 0, false, 0, { halfWidth: 384, startX: -300, extraThings: [180, 0, 180, 66, 7] }),
    ]));
    const latest = tag => sim.logs.findLast(([name]) => name === tag)?.slice(1).map(Number);
    stepUntil(sim, [], () => Boolean(latest("melee-input")), "render MAP01");
    assert.deepEqual(latest("melee-input").slice(0, 2), [marker("MAP01")[1], 1]);
    stepUntil(sim, [28], () => latest("melee-input")[2] === 2, "select and fully raise the fist with 1");
    assert.deepEqual(latest("melee-input"), [marker("MAP01")[1], 0, 2, 0, 50]);
    const imp = verifyMissileImpact(sim, "MAP01", 11, 31, 100, 352);
    assert.deepEqual([imp.damage, imp.explosion], [9, 99], "the Imp fireball enters S_TBALLX1");
    stepUntil(sim, [18], () => latest("melee-input")[3] === 64 * unit, "punch the MAP01 wall with R");
    assert.equal(latest("melee-input")[4], 50);
    stepUntil(sim, [6], () => sim.logs.some(([tag]) => tag === "Doom level exit requested"), "use MAP01's exit");
    pulseUntil(sim, () => sim.logs.some(([tag]) => tag === "Doom next level rendered"), "continue through intermission");
    const [, exitHealth, exitRandom] = latest("combat-exit");
    const [map, carried, bodyHp, seed, spawnRandom] = latest("combat-load");
    assert.deepEqual([map, exitHealth, carried, bodyHp, seed], [marker("MAP02")[1], imp.hp, imp.hp, imp.hp, exitRandom]);
    assert.ok(seed > 0);
    let spawnDraws = 3;
    if (values.upstream) {
        const native = runNativeActorOracle(path.resolve(root, values.upstream), scratch, [{
            things: [[-300, 0, 0, 1, 7], [180, 0, 180, 66, 7]], skill: 2, commercial: true,
            noMonsters: false, health: [imp.hp, 0, 0, 0],
        }]);
        const [summary, player] = native.spawns[0];
        assert.equal(summary[0], 2);
        assert.deepEqual([player[0], player[10]], [0, bodyHp], "the carried player body starts with the native spawn health");
        spawnDraws = summary[3];
    }
    assert.equal(spawnRandom, (seed + spawnDraws) & 255, "MAP02 loads its two map things from the carried gameplay RNG");
    console.log(`MAP01→MAP02 carried ${bodyHp} HP and gameplay RNG ${seed}; actor setup advanced it to ${spawnRandom}.`);
    stepUntil(sim, [], () => Boolean(latest("revenant-puff")), "wait for a naturally launched Revenant missile trail on MAP02");
    assert.equal(latest("melee-input")[0], marker("MAP02")[1]);
    const [launch, owner, player] = latest("revenant-launch");
    const [game, range, rng, endRng, kind, shooter, tracer, x, y, z, angle, mx, my, mz, health, flags,
        targetKind, targetX, targetY, targetZ, targetHealth, missile, order] = latest("revenant-trail");
    assert.deepEqual([owner, player, kind, shooter, tracer, targetKind], [2, 1, 6, owner, player, 0]);
    assert.ok(game >= launch && game % 4 === 0);
    const puff = latest("revenant-puff");
    assert.deepEqual([puff[0], puff[4], puff[5], puff[6], puff[7]], [37, unit, 4, 95, 7], "real homing tracer emits S_PUFF3 after the earlier punch");
    assert.equal(range, 64 * unit);
    assert.equal(endRng, (rng + 6) & 255);
    if (values.upstream) {
        const cases = [range, 0].map(attackRange => ({
            actor: { kind, x, y, z, angle, mx, my, mz, health, flags },
            target: { kind: targetKind, x: targetX, y: targetY, z: targetZ, health: targetHealth, mx: 0, my: 0, mz: 0,
                angle: 0, flags: 0, tracked: true }, actions: ["tracer"], gameTic: game, rng, attackRange,
            tryMove: true, skulls: 0, split: 0,
        }));
        const [[melee], [reset]] = runNativeHeavyOracle(path.resolve(root, values.upstream), scratch, cases);
        const [p, s] = melee.spawns;
        assert.deepEqual(puff, [p[0], p[1], p[2], p[3], p[7], p[8], p[11], s[0], s[8], s[11]]);
        assert.equal(endRng, melee.rng);
        assert.deepEqual([melee.spawns[0][11], reset.spawns[0][11]], [95, 93]);
    }
    console.log(`MAP01 fist → MAP02 Revenant passed at game tic ${game}, puff state ${puff[6]}, RNG ${rng}→${endRng}.`);
    const impact = verifyMissileImpact(sim, "MAP02", 5, 6, imp.hp, -300);
    assert.ok(impact.game > game);
    assert.deepEqual([impact.missile, impact.order, impact.explosion, impact.damage], [missile, order, 318, 60],
        "the missile that emitted S_PUFF3 later enters S_TRACEEXP1 on the player");
}

try {
    exerciseCampaignMeleeTrail();
    exerciseCampaignTracer();
    const entry = previewSource();
    const sim = build(entry, campaignWad());
    const e1m3 = marker("E1M3"), e1m9 = marker("E1M9"), e1m4 = marker("E1M4");
    stepUntil(sim, [], () => rows(sim).some(row => row.marker[0] === e1m3[0] && row.marker[1] === e1m3[1]), "render E1M3");
    stepUntil(sim, [12], () => sim.logs.some(row => row[0] === "No Doom checkpoint saved"), "loading an empty checkpoint leaves the level running");
    stepUntil(sim, [18], () => rows(sim).at(-1).clip < 50, "spend ammunition in E1M3");
    stepUntil(sim, [23], () => rows(sim).at(-1).blue === 1, "collect E1M3's blue card before exiting");
    stepUntil(sim, [25], () => sim.logs.some(row => row[0] === "Doom checkpoint saved"), "save during play with a collected key");
    const savedFrame = framebuffer(sim);
    const savedTic = rows(sim).at(-1);
    const beforeExit = checkpointCommands(sim);
    const firstAfterSave = beforeExit.trace[0];
    assert.deepEqual([firstAfterSave.game, firstAfterSave.levelTime, firstAfterSave.blue], [savedTic.game + 1, savedTic.levelTime + 1, 1]);
    assert.ok(new Set(beforeExit.trace.map(row => row.x)).size > 1, "the replay commands move the player");
    for (const tic of beforeExit.trace) {
        assert.equal(tic.scroll, 2 * (tic.levelTime + 1) * unit, "both lines advance their shared side every tic, even without wall texture lumps");
    }
    stepUntil(sim, [23], () => rows(sim).at(-1).x > 32 * unit, "walk within use range of E1M3's secret exit");
    stepUntil(sim, [6], () => sim.logs.some(row => row[0] === "Doom secret level exit requested"), "use E1M3's secret exit");
    const finished = rows(sim).at(-1);
    assert.ok(finished.health < 100 && finished.clip < 50, "carry actual damage and ammo use across the exit");
    const inIntermissionRows = rows(sim).length;
    for (let host = 0; host < 40; host++) sim.step([], new Map(), [6]);
    assert.equal(sim.logs.filter(row => row[0] === "Doom next level rendered").length, 0,
        "holding F through the exit cannot skip the intermission");
    assert.equal(rows(sim).length, inIntermissionRows, "no map tic runs during the held-key intermission");
    assert.equal(sim.tileAt({ x: 0, y: 0 }).extra, 1,
        "the WIMAP0 intermission patch repaints the live viewport through PLAYPAL/COLORMAP");
    stepUntil(sim, [6], () => sim.tileAt({ x: 90 - 64, y: 51 - 48 }).extra === 0,
        "animate the supplied episode overlay at its original map position");

    pulseUntil(sim, () => rows(sim).some(row => row.marker[0] === e1m9[0] && row.marker[1] === e1m9[1]),
        "advance the intermission into E1M9 with released F presses");
    const secretMap = rows(sim).find(row => row.marker[0] === e1m9[0] && row.marker[1] === e1m9[1]);
    assert.deepEqual([secretMap.levelTime, secretMap.health, secretMap.clip, secretMap.blue, secretMap.scroll],
        [0, finished.health, finished.clip, 0, 0], "level completion clears keys and the previous map's scroll state while carrying health and ammo");

    stepUntil(sim, [23], () => rows(sim).at(-1).marker[0] === e1m9[0] && rows(sim).at(-1).x > 32 * unit,
        "walk within use range of E1M9's normal exit");
    stepUntil(sim, [6], () => sim.logs.filter(row => row[0] === "Doom level exit requested").length === 1,
        "use E1M9's normal exit");
    for (let host = 0; host < 40; host++) sim.step([], new Map(), [6]);
    assert.equal(sim.logs.filter(row => row[0] === "Doom next level rendered").length, 1,
        "the held exit key cannot load the return map");
    pulseUntil(sim, () => rows(sim).some(row => row.marker[0] === e1m4[0] && row.marker[1] === e1m4[1]),
        "advance the return intermission into E1M4");
    const returnMap = rows(sim).find(row => row.marker[0] === e1m4[0] && row.marker[1] === e1m4[1]);
    assert.deepEqual([returnMap.levelTime, returnMap.health, returnMap.clip, returnMap.blue], [0, finished.health, finished.clip, 0]);
    assert.ok(returnMap.game > secretMap.game, "game time remains continuous across both transitions");
    assert.deepEqual(sim.logs.filter(row => row[0] === "Doom secret level exit requested"), [["Doom secret level exit requested"]]);
    assert.deepEqual(sim.logs.filter(row => row[0] === "Doom level exit requested"), [["Doom level exit requested"]]);
    assert.equal(sim.logs.filter(row => row[0] === "Doom next level rendered").length, 2);

    // The native script state API stores JSON values, including interface boxes.
    sim.roundTripScriptState();
    for (let load = 1; load <= 2; load++) {
        const loaded = () => sim.logs.filter(row => row[0] === "Doom checkpoint loaded").length;
        stepUntil(sim, [12], () => loaded() >= load, "load the E1M3 checkpoint after world state changed");
        assert.deepEqual(framebuffer(sim), savedFrame, "the load restores the exact saved display");
        assert.deepEqual(checkpointCommands(sim, true), beforeExit, "restoring repeats both clocks, inventory, motion, weapon, RNG, and screen trace");
        assert.equal(loaded(), load, "holding L does not reload the slot again");
    }
    assert.equal(sim.logs.filter(row => row[0] === "Doom checkpoint saved").length, 1, "the original slot survives repeated loads");

    const doom2 = build(entry, wad([...level("MAP06", 11), ...level("MAP07", 0), ...level("MAP01", 0), ...intermissionResources()]));
    stepUntil(doom2, [], () => rows(doom2).length > 0, "render MAP06");
    menuKey(doom2, 20, 2, 2);
    menuKey(doom2, 20, 0, 2);
    stepUntil(doom2, [23], () => rows(doom2).at(-1).x > 32 * unit, "reach the MAP06 switch");
    stepUntil(doom2, [6], () => doom2.logs.some(row => row[0] === "Doom level exit requested"), "exit MAP06");
    pulseUntil(doom2, () => doom2.logs.some(row => row[0] === "Doom story finale requested"), "enter MAP06's story stage");
    stepUntil(doom2, [], () => doom2.logs.some(row => row[0] === "campaign-story-tic"), "finish the melt before ticking the story");
    assert.equal(doom2.tileAt({ x: 0, y: 0 }).extra, 0, "draw MAP06's SLIME16 story backdrop");
    stepUntil(doom2, [6], () => rows(doom2).at(-1).marker[1] === marker("MAP07")[1], "advance from the story stage into MAP07");
    const storyTicks = doom2.logs.filter(row => row[0] === "campaign-story-tic");
    assert.deepEqual(storyTicks.map(row => Number(row[1])), Array.from({length: 52}, (_, i) => 51 - i),
        "held input only advances after the native story delay");
    exerciseNewCampaign(entry);
    console.log("WAD preview passed checkpoint replay across maps, campaign setup, skill carry, secret routing, inventory carry, intermission art, and the commercial story gate.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-campaign-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
