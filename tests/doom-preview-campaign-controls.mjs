// Exercise campaign-only controls and monster rules through a synthetic WAD.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { runNativeNightmareOracle } from "./doom-native-damage-oracle.mjs";
import { decode, destinations, keyOf, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" } } });
const cli = path.join(root, "src", "Fletcher.Cli", "bin", "Debug", "net11.0", "fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-campaign-controls-"));
const unit = 65536;

function words(values) {
    const result = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => result.writeUInt16LE(value & 65535, index * 2));
    return result;
}

function wad(lumps, signature = "PWAD") {
    const directory = 12 + lumps.reduce((size, [, value]) => size + value.length, 0);
    const result = Buffer.alloc(directory + lumps.length * 16);
    result.write(signature); result.writeUInt32LE(lumps.length, 4); result.writeUInt32LE(directory, 8);
    let offset = 12;
    for (const [index, [name, value]] of lumps.entries()) {
        const entry = directory + index * 16;
        result.writeUInt32LE(offset, entry); result.writeUInt32LE(value.length, entry + 4); result.write(name, entry + 8);
        value.copy(result, offset); offset += value.length;
    }
    return result;
}

function level(name, startX, light, things = [], sectorSpecial = 0) {
    const vertices = words([-256, -128, -256, 128, 256, 128, 256, -128]);
    const lines = Buffer.concat([[0, 1], [1, 2], [2, 3], [3, 0]].map(([a, b]) => words([a, b, 0, 0, 0, 0, 65535])));
    const sides = Buffer.alloc(30);
    const segs = Buffer.concat([[0, 1, 0x4000, 0, 0, 0], [1, 2, 0, 1, 0, 0],
        [2, 3, 0xc000, 2, 0, 0], [3, 0, 0x8000, 3, 0, 0]].map(value => words(value)));
    const sector = Buffer.alloc(26);
    sector.writeInt16LE(128, 2); sector.write("FLOOR0_1", 4); sector.write("CEIL1_1", 12); sector.writeInt16LE(light, 20);
    sector.writeInt16LE(sectorSpecial, 22);
    return [[name, Buffer.alloc(0)], ["THINGS", words([startX, 0, 0, 1, 7, ...things])], ["LINEDEFS", lines], ["SIDEDEFS", sides],
        ["VERTEXES", vertices], ["SEGS", segs], ["SSECTORS", words([4, 0])], ["NODES", Buffer.alloc(0)],
        ["SECTORS", sector], ["REJECT", Buffer.alloc(1)], ["BLOCKMAP", words([-256, -128, 4, 2, 12, 12, 12, 12, 12, 12, 12, 12, 0, 1, 2, 3, -1])]];
}

function resources() {
    const palette = Buffer.alloc(256 * 3);
    palette.set([128, 0, 128], 1 * 3);
    palette.set([255, 0, 0], 2 * 3);
    const pausePatch = Buffer.alloc(8 + 10 * 4 + 10 * 13);
    pausePatch.writeUInt16LE(10); pausePatch.writeUInt16LE(8, 2);
    for (let x = 0; x < 10; x++) {
        const column = 48 + x * 13;
        pausePatch.writeUInt32LE(column, 8 + x * 4);
        pausePatch[column + 1] = 8;
        pausePatch.fill(2, column + 3, column + 11);
        pausePatch[column + 12] = 255;
    }
    return [["F_START", Buffer.alloc(0)], ["FLOOR0_1", Buffer.alloc(4096, 1)], ["CEIL1_1", Buffer.alloc(4096, 1)], ["F_END", Buffer.alloc(0)],
        ["PLAYPAL", palette], ["COLORMAP", Buffer.from(Array.from({ length: 33 * 256 }, (_, index) => index & 255))], ["M_PAUSE", pausePatch]];
}

function previewSource({ skill, fast, respawn, previousRoute }) {
    const preview = path.join(scratch, "preview");
    mkdirSync(preview, { recursive: true });
    for (const name of readdirSync(path.join(port, "wad-bsp")).filter(name => name.endsWith(".flt"))) {
        let source = readFileSync(path.join(port, "wad-bsp", name), "utf8");
        if (name === "main.flt") {
            source = source.replace('import "play"', 'import "play"\nimport "actorinfo"');
            source = source.replace("register previousNextMap int = 0", `register previousNextMap int = ${previousRoute}`);
            const menu = "            next campaignMenu = menuStep.Menu";
            const request = "                    next newCampaignMarker = menuStep.Marker";
            const spawn = "                            spawned := play.SpawnMapActors(level, rules, health, random)";
            for (const hook of [menu, request, spawn]) assert.equal(source.split(hook).length, 2, `unique hook: ${hook}`);
            source = source.replace(menu, `${menu}\n            log("new-game-menu", menuStep.Menu.Stage, menuStep.Menu.Cursor)`);
            source = source.replace(request, `                    log("new-game-request", gameTime, previousNextMap,
                        lightState.Random.GameplayIndex, lightState.Random.MenuIndex)
${request}`);
            source = source.replace(spawn, `                            if startingNew {
                                log("new-game-load", gameTime, previousNextMap, random.GameplayIndex, random.MenuIndex)
                            }
${spawn}`);
            const spawned = "                            start := spawned.ActorAt(spawned.PlayerActors[0] - 1)";
            assert.ok(source.includes(spawned), "campaign skill spawn trace anchor moved");
            source = source.replace(spawned, `                            if startingNew {
                                log("campaign-skill-spawn", rules.Skill, spawned.Count, spawned.TotalKills, spawned.TotalItems)
                                for index := range spawned.Count {
                                    actor := spawned.ActorAt(index)
                                    log("campaign-skill-actor", actor.Kind, actor.SpawnPoint.Options, actor.ReactionTime)
                                }
                            }
${spawned}`);
            const actorTick = "                    stepped := tickPreviewWorldActors(combat, blockMap, command, view, contacts, passiveActors, levelTime)";
            assert.ok(source.includes(actorTick), "monster fixture anchor moved");
            // Enter the actual thinker at the first eligible respawn tic. The
            // selected PRandom index advances to value 4, then each spawn draws once.
            source = source.replace(actorTick, `                    if levelTime == 0 && mapActors >= 3 {
                        demon := combat.World.Actors.ActorAt(1)
                        demon.State, demon.Tics = actorinfo.KindAt(demon.Kind).PainState, 1
                        corpse := combat.World.Actors.ActorAt(2)
                        corpse.Tics, corpse.MoveCount, corpse.Health, corpse.Damaged = -1, 419, 0, true
                        corpse.Physics.Body.Flags = (corpse.Physics.Body.Flags & ~bits<32>(play.ActorSolid | play.ActorShootable)) | play.MoveCorpse
                        corpse.Physics.Body.X = 64 << 16
                        position := combat.World.Links.SetActorPosition(combat.Level, 3, corpse)
                        combat.World.Actors = combat.World.Actors.WithActor(2, demon).WithActor(3, position.Actor)
                        combat.World.Links = position.Links
                        combat.World.Random.GameplayIndex = 65
                    }
${actorTick}`);
            const anchor = "                    next player = moved";
            assert.ok(source.includes(anchor), "campaign trace anchor moved");
            source = source.replace(anchor, `                    log("campaign-tic", marker, gameTime, levelTime, moved.Body.X, previousNextMap)
                    log("player-buttons", frame.Contacts.Inventory.Ammo[play.AmmoClip], frame.Contacts.Inventory.ReadyWeapon,
                        frame.Contacts.Inventory.PendingWeapon, useHeld, heldWeapon.AttackDown)
                    if inventory.Dead { log("corpse-tic", restartLevel) }
                    if levelTime == 0 && mapActors >= 3 {
                        demon := actorFrame.Actors.ActorAt(1)
                        corpse := actorFrame.Actors.ActorAt(2)
                        log("monster-timing", demon.Tics, corpse.Valid, corpse.MoveCount, lighting.Random.GameplayIndex)
                        handle := actorFrame.Actors.TransientFirst()
                        for range 3 {
                            if handle != 0 {
                                actor := actorFrame.Actors.ActorAt(handle - 1)
                                log("respawn-thinker", actor.Kind, actor.Physics.Body.X, actor.Health, int(actor.Physics.Angle),
                                    actor.ReactionTime, actor.Physics.Body.Flags & play.ActorAmbush != 0)
                                handle = actorFrame.Actors.TransientNext(handle)
                            }
                        }
                    }
${anchor}`);
            const useLine = "                    useResult := play.UseLevelSpecialWithInventory";
            assert.ok(source.includes(useLine), "use action trace anchor moved");
            source = source.replace(useLine, `                    log("use-lines", levelTime)\n${useLine}`);
            const view = "                playerActor.Physics = actor";
            assert.ok(source.includes(view), "player view trace anchor moved");
            source = source.replace(view, `                log("movement-command", command.Forward, command.Side, command.Turn)
                log("player-view", levelTime, actor.MomentumX, actor.MomentumY, actor.Body.Z, actor.Body.Ceiling,
                    actor.ViewHeight, actor.ViewHeightDelta, view.Z)
${view}`);
        }
        if (name === "combat-preview.flt") {
            for (const [constant, value] of [["previewCombatSkill", skill], ["previewFastMonsters", fast], ["previewRespawnMonsters", respawn]]) {
                const declaration = new RegExp(`^const ${constant} = (?:[0-4]|true|false)$`, "m");
                assert.match(source, declaration);
                source = source.replace(declaration, `const ${constant} = ${value}`);
            }
        }
        writeFileSync(path.join(preview, name), source);
    }
    return path.join(preview, "main.flt");
}

function build({ skill = 2, fast = false, respawn = false, monsters = false, blocked = false, sectorSpecial = 0,
    maps, things: explicitThings, signature = "PWAD", previousRoute = 0, disconnectRun = false, disconnectAction = false } = {}) {
    const entry = previewSource({ skill, fast, respawn, previousRoute });
    const things = explicitThings ?? (monsters ? [64, 64, 0, 3002, 7, 160, 0, 95, 3002, 15] : []);
    if (blocked) things.push(160, 0, 0, 2035, 7);
    // A valid classic recording targeting E1M2, with one forward command.
    const recording = Buffer.from([110, 2, 1, 2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 20, 0, 0, 0, 0x80]);
    const levels = maps ?? [...level("E1M1", -192, 96, things, sectorSpecial), ...level("E1M2", -64, 176)];
    const lumps = [...levels, ["DEMO1", recording], ...resources()];
    writeFileSync(path.join(scratch, "LEVEL.WAD"), wad(lumps, signature));
    const output = path.join(scratch, "campaign.json");
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const data = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(data, "base64")[2], 1, "preview map stays compressed");
    const tiles = decode(data);
    if (disconnectRun) {
        const bridge = tiles.find(tile => tile.type === 33 && tile.payload?.includes("doomKeyboardDeltas = results"));
        assert.ok(bridge);
        const pad = tiles.find(tile => tile.x === bridge.x + 3 && tile.y === bridge.y + 4);
        assert.equal(pad?.type, 1, "the forward command board has a physical Run input pad");
        pad.type = 25;
        pad.extra = 7;
    }
    if (disconnectAction) {
        const hub = tiles.find(tile => tile.x === 54 && tile.y === 112);
        assert.equal(hub?.type, 10, "Fire and Use share a native Blue Arrow activity gate");
        const sources = tiles.filter(tile => tile.type === 21 && destinations(tile).includes(keyOf(hub)));
        assert.deepEqual(sources.map(tile => tile.extra).sort((a, b) => a - b), [6, 18, 49, 53]);
        hub.type = 25;
        hub.extra = 7;
    }
    return simulator(tiles, true);
}

function checkMonsterRules(rules, expectedTiming, expectedRespawn) {
    const sim = build({ ...rules, monsters: true });
    stepsUntil(sim, undefined, () => logs(sim, "Classic WAD BSP frame rendered").length === 1, "render E1M1");
    stepsUntil(sim, undefined, () => logs(sim, "monster-timing").length === 1, "run the monster thinkers");
    assert.deepEqual(logs(sim, "monster-timing")[0].slice(1).map(Number), expectedTiming);
    const actual = logs(sim, "respawn-thinker").map(row => row.slice(1).map(Number));
    assert.deepEqual(actual, expectedRespawn);
    const impact = { x: -9, y: 63 };
    assert.equal(sim.tileAt(impact)?.type, 29);
    let played = (sim.value(impact) ?? 0) > 0;
    for (let host = 0; host < 16; host++) {
        sim.step();
        played ||= (sim.value(impact) ?? 0) > 0;
    }
    assert.equal(played, expectedRespawn.length > 0, "the audible Nightmare fogs reach the impact Music Arrow");
}

function logs(sim, event) { return sim.logs.filter(row => row[0] === event); }
function stepsUntil(sim, key, predicate, description, limit = 400) {
    const keys = Array.isArray(key) ? key : key === undefined ? [] : [key];
    for (let host = 0; host < limit && !predicate(); host++) sim.step([], new Map(), keys);
    assert.ok(predicate(), description + ": " + JSON.stringify(sim.logs.slice(-12)));
}
function rowValues([, marker, game, level, x]) {
    return { marker: Number(marker), game: Number(game), level: Number(level), x: Number(x) };
}

function checkCampaignIgnoresWadRecording(sim) {
    const worldTics = () => logs(sim, "campaign-tic");
    const before = worldTics().length;
    const lastTic = rowValues(worldTics().at(-1));
    stepsUntil(sim, 9, () => worldTics().length >= before + 8, "the campaign ticks while I is held");
    for (const [index, row] of worldTics().slice(before).map(rowValues).entries()) {
        assert.deepEqual(row, { marker: lastTic.marker, game: lastTic.game + index + 1, level: lastTic.level + index + 1, x: -192 * unit });
    }
    stepsUntil(sim, 23, () => rowValues(worldTics().at(-1)).x > -192 * unit, "W still walks forward in E1M1");
}

function checkLivePause(sim) {
    // P and W are keyboard-arrow codes 16 and 23. The synthetic M_PAUSE
    // rectangle starts at Doom's (126, 4), scaled to the 128×96 display.
    const displayPixel = (x, y) => sim.tileAt({ x: x - 64, y: y - 48 }).extra;
    const screen = () => Array.from({ length: 128 * 96 }, (_, index) => displayPixel(index % 128, Math.floor(index / 128)));
    const pausePixel = () => displayPixel(51, 2);
    const worldTics = () => logs(sim, "campaign-tic");
    stepsUntil(sim, undefined, () => worldTics().length > 0, "run a live world tic");
    const frozen = screen();
    const unpausedPixel = pausePixel();
    stepsUntil(sim, 16, () => logs(sim, "Doom paused").length === 1, "P enters live pause");
    const before = worldTics().length;
    const lastLive = rowValues(worldTics().at(-1));
    for (let host = 0; host < 24; host++) sim.step([], new Map(), [16, 23]);
    assert.equal(logs(sim, "Doom resumed").length, 0, "holding P keeps the world paused");
    assert.equal(worldTics().length, before, "W cannot tick the world while paused");
    assert.notEqual(pausePixel(), unpausedPixel, "the external WAD pause patch overlays the frozen view");
    for (const [index, color] of screen().entries()) {
        const x = index % 128, y = Math.floor(index / 128);
        if (x < 51 || x >= 55 || y < 2 || y >= 6) assert.equal(color, frozen[index], `paused scene pixel ${x},${y}`);
    }
    for (let host = 0; host < 10; host++) sim.step();
    sim.step([], new Map(), [16]);
    stepsUntil(sim, undefined, () => logs(sim, "Doom resumed").length === 1, "one host tick of P resumes live play");
    stepsUntil(sim, undefined, () => worldTics().length > before, "resume runs the next live world tic");
    const resumed = rowValues(worldTics()[before]);
    assert.equal(resumed.level, lastLive.level + 1, "paused host time never advances the Doom level clock");
    assert.ok(resumed.game > lastLive.game + 1, "the game command clock continues while paused");
    assert.equal(resumed.x, lastLive.x, "movement while paused has no lasting effect");
    stepsUntil(sim, undefined, () => pausePixel() === unpausedPixel, "resume redraw clears the pause patch");
}

function pulseButtons(sim, keys) {
    const buttons = () => logs(sim, "player-buttons");
    const before = buttons().length;
    sim.step([], new Map(), keys);
    stepsUntil(sim, undefined, () => buttons().length > before, "run the next gameplay command");
    return Array.from(buttons()[before]).slice(1).map(Number);
}
function resumeWith(sim, keys) {
    const before = logs(sim, "Doom paused").length;
    stepsUntil(sim, 16, () => logs(sim, "Doom paused").length > before, "pause the world");
    for (let host = 0; host < 10; host++) sim.step();
    return pulseButtons(sim, [16, ...keys]);
}
function checkResumeButtons(sim) {
    // The pistol is ready after the preceding walking and turn tics.
    const [ammo, pistol, noChange] = pulseButtons(sim, []);
    assert.deepEqual([pistol, noChange], [1, 10]);
    const uses = logs(sim, "use-lines").length;
    assert.deepEqual(resumeWith(sim, [23, 18, 6]), [ammo, pistol, noChange, 0, 0], "P+W+R+F leaves the pistol idle on the resume tic");
    assert.deepEqual(Array.from(logs(sim, "movement-command").at(-1)).slice(1), [25, 0, 0], "W survives the pause special command");
    assert.equal(logs(sim, "use-lines").length, uses, "F does not activate a line on resume");
    assert.deepEqual(pulseButtons(sim, [18, 6]).slice(1), [pistol, noChange, 0, 1], "R starts a shot and the use latch starts released on the next tic");
    assert.equal(logs(sim, "use-lines").length, uses + 1, "F activates a line on the next tic");
    assert.equal(pulseButtons(sim, [])[3], 1, "the following tic observes the committed F latch");
    assert.equal(pulseButtons(sim, [])[3], 0, "releasing F clears the latch");
    assert.deepEqual(resumeWith(sim, [28]).slice(1, 3), [pistol, noChange], "P+1 does not switch to the fist");
    pulseButtons(sim, []);
    assert.deepEqual(resumeWith(sim, [24]).slice(1, 3), [pistol, noChange], "P+X does not cycle to the fist");
    assert.deepEqual(pulseButtons(sim, [24]).slice(1, 3), [pistol, 0], "X cycles normally on the next tic");
}

function checkDeadResume() {
    const sim = build({ sectorSpecial: 16 }); // Super hellslime deals 20 damage every 32 tics.
    const death = () => logs(sim, "corpse-tic");
    stepsUntil(sim, undefined, () => death().length > 0, "die on the damaging floor", 1700);
    const before = death().length;
    resumeWith(sim, [6]);
    assert.equal(death().length, before + 1, "the death thinker still runs on resume");
    assert.equal(Number(death().at(-1)[1]), 0, "P+F leaves the dead player in the level");
    pulseButtons(sim, [6]);
    assert.equal(Number(death().at(-1)[1]), 1, "F requests rebirth on the following tic");
    stepsUntil(sim, undefined, () => logs(sim, "Doom level restarted").length === 1, "rebuild the level after rebirth");
}

function checkKeyboardMovement(sim) {
    // A host pulse is sampled once. Holding a key throughout a sliced render
    // would also queue it for the next logical tic.
    function pulse(keys, done, description) {
        sim.step([], new Map(), keys);
        stepsUntil(sim, undefined, done, description);
    }
    function command(keys) {
        const before = logs(sim, "movement-command").length;
        pulse(keys, () => logs(sim, "movement-command").length > before, "commit keyboard command");
        return Array.from(logs(sim, "movement-command")[before]).slice(1);
    }
    command([]); // Drain the W key held by the preceding test.
    for (let tic = 1; tic <= 5; tic++) {
        assert.deepEqual(command([1]), [0, 0, 320], "A turns slowly for the first five held tics");
    }
    pulse([25], () => logs(sim, "Doom checkpoint saved").length === 1, "save five tics into a turn");
    assert.deepEqual(command([1]), [0, 0, 640], "A reaches full walking turn rate on tic six");
    assert.deepEqual(command([4]), [0, 0, -640], "changing direction without a release retains acceleration");
    assert.deepEqual(command([1, 4]), [0, 0, 0], "opposing turn keys cancel");
    assert.deepEqual(command([]), [0, 0, 0], "releasing both keys resets acceleration");
    assert.deepEqual(command([4]), [0, 0, -320], "D starts at the slow rate after release");
    pulse([12], () => logs(sim, "Doom checkpoint loaded").length === 1, "restore saved turn acceleration");
    assert.deepEqual(command([1]), [0, 0, 640], "the restored tic resumes the native turn phase");
    assert.deepEqual(command([23, 5]), [25, 24, 0], "W and E use walking rates");
    for (let tic = 1; tic <= 6; tic++) {
        assert.deepEqual(command([9, 19, 17, 4]), [-50, -40, tic < 6 ? -320 : -1280],
            "I uses running movement rates while sharing the slow turn phase");
    }
    assert.deepEqual(command([9, 23, 19, 17, 5]), [0, 0, 0], "opposing running movement keys cancel");

    const up = 56, down = 57, left = 58, right = 59, alt = 54, shift = 52;
    assert.deepEqual(command([23, up]), [25, 0, 0], "W and ArrowUp share one forward direction");
    assert.deepEqual(command([19, up]), [0, 0, 0], "opposite aliases cancel forward movement");
    assert.deepEqual(command([up, down]), [0, 0, 0], "opposite forward arrows cancel");
    assert.deepEqual(command([shift, down]), [-50, 0, 0], "Shift and ArrowDown reach the same command");
    for (let tic = 1; tic <= 5; tic++) {
        assert.deepEqual(command([1, left]), [0, 0, 320], "same-side turn aliases advance the hold count once");
    }
    assert.deepEqual(command([left]), [0, 0, 640], "ArrowLeft reaches full turn rate on the sixth tic");
    assert.deepEqual(command([right, 1]), [0, 0, 0], "opposite aliases cancel turning");
    assert.deepEqual(command([left, right]), [0, 0, 0], "opposite turn arrows cancel");
    assert.deepEqual(command([right]), [0, 0, -640], "opposed and switched cursor keys retain the turn hold count");
    command([]);
    for (let tic = 1; tic <= 5; tic++) {
        assert.deepEqual(command([alt, left]), [0, -24, 0], "Alt and ArrowLeft strafe without turning");
    }
    assert.deepEqual(command([left]), [0, 0, 640], "Alt-strafe advances the native turn hold count");
    assert.deepEqual(command([shift, alt, right, 5]), [0, 50, 0], "running strafe and E add then clamp without turning");
    assert.deepEqual(command([27, right]), [0, 24, 0], "the 0 strafe alias remains available");
}

function checkNativeCommandSource() {
    const sim = build({ disconnectRun: true });
    const commands = () => logs(sim, "movement-command");
    function runningCommand() {
        const before = commands().length;
        pulseButtons(sim, [56, 52]); // ArrowUp + Shift
        return Array.from(commands()[before]).slice(1);
    }
    stepsUntil(sim, undefined, () => commands().length > 0, "enter the playable room");
    assert.deepEqual(runningCommand(), [50, 0, 0], "startup fallback can run while the circuit fills the table");
    stepsUntil(sim, undefined, () => logs(sim, "Doom native player command ready").length === 1, "receive the physical command table", 720);
    assert.deepEqual(runningCommand(), [25, 0, 0], "disconnecting the physical Run pad changes the live movement command");
}

function checkNativeActionGuard() {
    for (const disconnectAction of [false, true]) {
        const sim = build({ disconnectAction });
        stepsUntil(sim, undefined, () => logs(sim, "player-buttons").length > 0, "enter the playable room");
        for (let tic = 0; tic < 18; tic++) pulseButtons(sim, []);
        const uses = logs(sim, "use-lines").length;
        const [, , , , attack] = pulseButtons(sim, [53, 49]); // Ctrl and Space for a single host tick.
        assert.equal(attack, disconnectAction ? 0 : 1, "the native gate admits the attack chord");
        assert.equal(logs(sim, "use-lines").length, uses + (disconnectAction ? 0 : 1), "the native gate also admits Use");
        let ammo;
        for (let tic = 0; tic < 12; tic++) [ammo] = pulseButtons(sim, []);
        assert.equal(ammo, disconnectAction ? 50 : 49, "Doom consumes the ammo after the pistol's attack wind-up");
    }
}

function checkMouseMovement() {
    const sim = build();
    const commands = () => logs(sim, "movement-command");
    const mouse = (x, y) => sim.moveMouse(x / 1024, y / 1024);
    const neutral = [0, 0, 0];
    // Level key IDs for the 0 and 9 digits.
    const strafe = 27, toggle = 36;
    function command(keys = []) {
        const before = commands().length;
        pulseButtons(sim, keys);
        return Array.from(commands()[before]).slice(1);
    }

    stepsUntil(sim, undefined, () => commands().length > 0, "enter the playable room");
    assert.deepEqual(command([toggle]), neutral, "enable mouse before a pointer sample");
    assert.equal(logs(sim, "Doom mouse enabled").length, 1);
    mouse(512, 512);
    assert.deepEqual(command(), neutral, "the first sample establishes the origin");
    mouse(640, 512);
    assert.deepEqual(command(), [0, 0, -1024], "pointer movement turns right");
    assert.deepEqual(command(), neutral, "a consumed delta never repeats across logical tics");
    mouse(664, 448);
    assert.deepEqual(command([strafe, 4, 23]), [50, 50, 0], "mouse and keyboard combine and clamp with strafe held");
    mouse(676, 448);
    assert.deepEqual(command([54]), [0, 24, 0], "Alt routes mouse X to strafing without a direction key");
    assert.deepEqual(command([13]), neutral, "open the automap");
    mouse(800, 576);
    assert.deepEqual(command(), neutral, "pointer motion belongs to the automap while it is open");
    assert.deepEqual(command([13]), neutral, "closing the automap discards the last interface delta");
    assert.equal(logs(sim, "Doom automap closed").length, 1);

    stepsUntil(sim, 16, () => logs(sim, "Doom paused").length === 1, "pause before moving the pointer");
    const beforePause = commands().length;
    mouse(400, 100);
    for (let host = 0; host < 12; host++) sim.step();
    assert.equal(commands().length, beforePause);
    mouse(384, 100);
    assert.deepEqual(command([16]), neutral, "the resume tic discards motion from pause");
    mouse(400, 100);
    assert.deepEqual(command(), [0, 0, -128], "the next tic uses the new pointer baseline");

    stepsUntil(sim, 20, () => logs(sim, "Doom campaign menu opened").length === 1, "open the campaign menu");
    const beforeMenu = commands().length;
    mouse(860, 320);
    for (let host = 0; host < 12; host++) sim.step();
    assert.equal(commands().length, beforeMenu);

    const sensitivityMeter = () => Array.from({ length: 10 }, (_, slot) => sim.tileAt({ x: 2 + slot * 3, y: 24 }).extra);
    const [filled] = sensitivityMeter();
    const empty = sensitivityMeter().at(-1);
    assert.notEqual(filled, empty, "the sensitivity meter shows the current position");
    const assertSensitivity = value => assert.deepEqual(sensitivityMeter(),
        Array.from({ length: 10 }, (_, slot) => slot <= value ? filled : empty), `mouse sensitivity ${value}`);
    const strafeLeft = 17, strafeRight = 5;
    function menuKeys(keys, ticks = 1) {
        for (let host = 0; host < ticks; host++) sim.step([], new Map(), keys);
        for (let host = 0; host < 12; host++) sim.step();
    }
    assertSensitivity(5);
    menuKeys([strafeLeft, strafeRight]);
    assertSensitivity(5);
    menuKeys([strafeRight], 12);
    assertSensitivity(6);
    for (let press = 0; press < 5; press++) menuKeys([strafeRight]);
    assertSensitivity(9);
    assert.equal(commands().length, beforeMenu, "adjusting mouse sensitivity keeps movement paused");

    stepsUntil(sim, 20, () => logs(sim, "Doom campaign menu closed").length === 1, "close the campaign menu");
    assert.deepEqual(command(), neutral, "repositioning the pointer in the menu leaves the first-person heading alone");
    mouse(869, 329);
    assert.deepEqual(command(), [-12, 0, -96], "maximum sensitivity scales both axes before command building");

    stepsUntil(sim, 20, () => logs(sim, "Doom campaign menu opened").length === 2, "reopen the campaign menu");
    for (let press = 0; press < 11; press++) menuKeys([strafeLeft]);
    assertSensitivity(0);
    stepsUntil(sim, 20, () => logs(sim, "Doom campaign menu closed").length === 2, "close after selecting minimum sensitivity");
    assert.deepEqual(command(), neutral, "closing the menu consumes no motion");
    mouse(860, 320);
    assert.deepEqual(command(), [4, 0, 32], "minimum sensitivity rounds signed deltas toward zero");

    assert.deepEqual(command([toggle]), neutral, "switch back to keyboard-only controls");
    assert.equal(logs(sim, "Doom mouse disabled").length, 1);
    mouse(960, 928);
    assert.deepEqual(command([1]), [0, 0, 320], "keyboard remains active while the pointer is disabled");
}

function checkNativeWalkingView(upstream, sim) {
    const read = name => readFileSync(path.join(upstream, name), "utf8");
    const sine = read("tables.c").match(/^int finesine\[10240\][\s\S]*?^};/m);
    assert.ok(sine, "pinned Doom sine table");
    const cases = logs(sim, "player-view").map(row => row.slice(1));
    assert.ok(cases.some(([, x, y]) => x !== 0 || y !== 0), "view fixture includes walking momentum");
    const source = path.join(scratch, "walking-view.c");
    const output = path.join(scratch, "walking-view.exe");
    writeFileSync(source, `#include <stdint.h>
#include <stdio.h>
typedef int32_t fixed_t;
enum { FRACBITS=16, FRACUNIT=1<<16, FINEANGLES=8192, FINEMASK=8191, VIEWHEIGHT=41*FRACUNIT,
    MAXBOB=0x100000, CF_NOMOMENTUM=2, PST_LIVE=0 };
typedef struct { fixed_t momx, momy, z, ceilingz; } mobj_t;
typedef struct { mobj_t *mo; fixed_t bob, viewz, viewheight, deltaviewheight; int cheats, playerstate; } player_t;
static int onground=1, leveltime;
${sine[0]}
${extractFunction(read("m_fixed.c"), "fixed_t", "FixedMul")}
${extractFunction(read("p_user.c"), "void", "P_CalcHeight")}
int main(void) {
    const int cases[][7] = {
${cases.map(row => "        {" + row.slice(0, -1).join(", ") + "},").join("\n")}
    };
    for (unsigned i=0; i<sizeof(cases)/sizeof(*cases); i++) {
        const int *input=cases[i];
        leveltime=input[0];
        mobj_t body={input[1], input[2], input[3], input[4]};
        player_t player={.mo=&body, .viewheight=input[5], .deltaviewheight=input[6]};
        P_CalcHeight(&player);
        printf("%d\\n", player.viewz);
    }
}`);
    const compile = spawnSync("gcc", ["-std=c99", source, "-o", output], { encoding: "utf8", timeout: 30000 });
    if (compile.error) throw compile.error;
    assert.equal(compile.status, 0, compile.stderr);
    const native = spawnSync(output, { encoding: "utf8", timeout: 30000 });
    if (native.error) throw native.error;
    assert.equal(native.status, 0, native.stderr);
    assert.deepEqual(cases.map(row => row.at(-1)), native.stdout.trim().split(/\r?\n/).map(Number),
        "preview camera height uses the native level tic and fixed-point walking bob");
}

function checkArchiveOpening(first, opening, signature, expectedX, previousRoute = 0) {
    const maps = [...level(first, -192, 80), ...level(opening, -128, 96), ...level(opening, -96, 112)];
    const sim = build({ maps, signature, previousRoute });
    stepsUntil(sim, undefined, () => logs(sim, "campaign-tic").length > 0, `play the ${signature} opening`);
    const start = rowValues(logs(sim, "campaign-tic")[0]);
    assert.deepEqual([start.level, start.game, start.x], [0, 0, expectedX * unit], `${signature} opening from ${first}`);
    return sim;
}

function checkNewCampaign(sim) {
    const buttons = () => logs(sim, "player-buttons");
    const world = () => logs(sim, "campaign-tic");
    stepsUntil(sim, undefined, () => Number(buttons().at(-1)[3]) === 10, "raise the original pistol");
    stepsUntil(sim, 18, () => Number(buttons().at(-1)[1]) < 50, "spend ammunition before New Game");
    stepsUntil(sim, 20, () => logs(sim, "Doom campaign menu opened").length === 1, "open the episode menu");
    const oldTic = rowValues(world().at(-1));
    const oldWorldCount = world().length;
    const menu = () => logs(sim, "new-game-menu");
    function releaseMenuKey() {
        const before = menu().length;
        stepsUntil(sim, undefined, () => menu().length > before, "release the previous menu key");
    }
    function select(key, stage, cursor) {
        releaseMenuKey();
        const before = menu().length;
        stepsUntil(sim, key, () => menu().slice(before).some(([, next, row]) => next === stage && row === cursor),
            `select menu stage ${stage} row ${cursor}`);
    }
    select(6, 2, 2); // Keep episode one and open the skill menu.
    select(19, 2, 3); // S selects Ultra-Violence.
    releaseMenuKey();
    stepsUntil(sim, 6, () => logs(sim, "new-game-request").length === 1, "confirm New Game");
    const request = Array.from(logs(sim, "new-game-request")[0]).slice(1).map(Number);
    assert.ok(request[0] > oldTic.game + 1, "the game clock advanced while the menu held the world");
    assert.ok(request[2] > 1 && request[3] > 0, "the previous game advanced both RNG streams");
    assert.equal(world().length, oldWorldCount);
    stepsUntil(sim, undefined, () => world().length > oldWorldCount, "enter the first tic of the new campaign");
    assert.equal(logs(sim, "Doom campaign started")[0][1], 3);
    const first = rowValues(world()[oldWorldCount]);
    const load = Array.from(logs(sim, "new-game-load")[0]).slice(1).map(Number);
    assert.deepEqual([first.game, first.level, first.x], [request[0], 0, -96 * unit]);
    assert.deepEqual(load, [request[0], 5, 0, 0], "New Game loads at the confirmation tic with both RNG streams cleared");
    const previousRoute = Number(world()[oldWorldCount][5]);
    assert.equal(previousRoute, 5, "New Game retains the previous intermission's route field");
    assert.equal(Number(buttons()[oldWorldCount][1]), 50, "New Game restores the starting clip");
    return { request, result: [first.game, previousRoute, ...load.slice(2), first.level] };
}

function checkEveryCampaignSkill() {
    // These three zombies are mutually exclusive by the native THINGS skill
    // mask. Each real New Game selection must carry the menu value through
    // main.flt's newCampaignSkill -> ThingRules.Skill load path.
    const things = [
        32, 0, 0, 3001, 1,
        64, 0, 0, 3001, 2,
        96, 0, 0, 3001, 4,
    ];
    for (let skill = 0; skill <= 4; skill++) {
        const sim = build({ things });
        const menus = () => logs(sim, "new-game-menu");
        stepsUntil(sim, undefined, () => logs(sim, "Classic WAD BSP frame rendered").length === 1, `render skill ${skill} fixture`);
        stepsUntil(sim, 20, () => logs(sim, "Doom campaign menu opened").length === 1, `open skill ${skill} menu`);
        function release() {
            const before = menus().length;
            stepsUntil(sim, undefined, () => menus().length > before, `release skill ${skill} menu key`);
        }
        function choose(key, stage, cursor) {
            release();
            const before = menus().length;
            stepsUntil(sim, key, () => menus().slice(before).some(([, next, row]) => next === stage && row === cursor),
                `select skill ${skill} menu row ${cursor}`);
        }
        choose(6, 2, 2); // E1, then the initially medium skill row.
        for (let row = 2; row > skill; row--) choose(23, 2, row - 1); // W
        for (let row = 2; row < skill; row++) choose(19, 2, row + 1); // S
        release();
        if (skill === 4) {
            choose(6, 3, 0); // Nightmare confirmation prompt.
            choose(19, 3, 1);
        }
        const started = logs(sim, "Doom campaign started").length;
        stepsUntil(sim, 6, () => logs(sim, "Doom campaign started").length === started + 1, `start campaign at skill ${skill}`);
        const spawn = logs(sim, "campaign-skill-spawn").at(-1).slice(1).map(Number);
        assert.deepEqual(spawn, [skill, 2, 1, 0], `skill ${skill} loads exactly player one and its masked zombie`);
        const actor = logs(sim, "campaign-skill-actor").at(-1).slice(1).map(Number);
        assert.equal(actor[1], skill <= 1 ? 1 : skill === 2 ? 2 : 4, `skill ${skill} selects its native THINGS option bit`);
        assert.equal(actor[2], skill === 4 ? 0 : 8, `skill ${skill} applies Nightmare's zero reaction delay only at skill four`);
    }
}

function checkNativeNewGame(upstream, { request, result }) {
    const read = name => readFileSync(path.join(upstream, name), "utf8").replaceAll("\r\n", "\n");
    const game = read("g_game.c");
    const source = path.join(scratch, "new-game.c");
    const exe = path.join(scratch, "new-game.exe");
    writeFileSync(source, `#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef int skill_t;
enum { MAXPLAYERS=4, sk_nightmare=4, FRACUNIT=65536, PST_DEAD=1, PST_REBORN=2, GS_LEVEL=0,
       commercial=0, pack_tnt, pack_plut, retail, shareware, ga_nothing=0,
       S_SARG_RUN1=0, S_SARG_PAIN2=13, MT_BRUISERSHOT=0, MT_HEADSHOT, MT_TROOPSHOT };
#define SKYFLATNAME "F_SKY1"
static int gamemode=retail, gametic, levelstarttic, leveltime, gameepisode, gamemap, gameskill=2;
static int rndindex, prndindex, skyflatnum, skytexture, wipegamestate, gamestate, paused, respawnparm, respawnmonsters, fastparm;
static int usergame, demoplayback, automapactive, viewactive, displayplayer, consoleplayer, starttime, gameaction;
static int gamekeydown[256], joyxmove, joyymove, mousex, mousey, sendpause, sendsave, mousebuttons[4], joybuttons[4];
static int playeringame[MAXPLAYERS] = {1};
static struct { int playerstate, frags[MAXPLAYERS]; } players[MAXPLAYERS];
static struct { int tics; } states[14];
static struct { int speed; } mobjinfo[3];
static struct { int next; } wminfo;
static void P_SetupLevel(int episode, int map, int mask, skill_t skill) {
    (void)episode; (void)map; (void)mask; (void)skill;
    leveltime=0;
}
static void S_ResumeSound(void) {}
static void Z_CheckHeap(void) {}
static int R_FlatNumForName(const char *name) { (void)name; return 0; }
static int R_TextureNumForName(const char *name) { (void)name; return 0; }
static int I_GetTime(void) { return 0; }
${extractFunction(read("light-m_random.c"), "void", "M_ClearRandom")}
${extractFunction(game, "void", "G_DoLoadLevel")}
${extractFunction(game, "void", "G_InitNew")}
int main(int argc, char **argv) {
    if (argc != 5) return 2;
    gametic=atoi(argv[1]); wminfo.next=atoi(argv[2]); prndindex=atoi(argv[3]); rndindex=atoi(argv[4]);
    leveltime=80;
    G_InitNew(3, 1, 1);
    printf("%d %d %d %d %d\\n", levelstarttic, wminfo.next, prndindex, rndindex, leveltime);
    return gametic != levelstarttic;
}`);
    const compile = spawnSync(process.env.CC ?? "gcc", ["-std=c99", source, "-o", exe], { encoding: "utf8", timeout: 30000 });
    if (compile.error) throw compile.error;
    assert.equal(compile.status, 0, compile.stderr);
    const native = spawnSync(exe, request.map(String), { encoding: "utf8", timeout: 30000 });
    if (native.error) throw native.error;
    assert.equal(native.status, 0, native.stderr);
    assert.deepEqual(result, native.stdout.trim().split(/\s+/).map(Number), "new campaign startup matches native clock and RNG state");
}

try {
    const sim = build();
    stepsUntil(sim, undefined, () => logs(sim, "Classic WAD BSP frame rendered").length === 1, "render E1M1");
    checkLivePause(sim);
    checkCampaignIgnoresWadRecording(sim);
    checkKeyboardMovement(sim);
    checkMouseMovement();
    checkResumeButtons(sim);
    checkDeadResume();
    if (values.upstream) checkNativeWalkingView(path.resolve(root, values.upstream), sim);
    console.log("Campaign controls passed pause, live and dead resume commands, ignored recordings, keyboard and mouse movement, turn acceleration, and checkpoint continuity.");
    const episode = checkArchiveOpening("E1M2", "E1M1", "IWAD", -96, 5);
    checkArchiveOpening("MAP06", "MAP01", "IWAD", -96);
    checkArchiveOpening("E1M2", "E1M1", "PWAD", -192);
    const newGame = checkNewCampaign(episode);
    checkEveryCampaignSkill();
    if (values.upstream) checkNativeNewGame(path.resolve(root, values.upstream), newGame);
    console.log(`IWAD opening lookup and PWAD directory startup passed. New Game began at game tic ${newGame.result[0]} with a fresh level clock and RNG.`);
    const respawned = [
        [39, 64 * unit, 1000, 0, 0, 0],
        [39, 160 * unit, 1000, 0, 0, 0],
        [12, 160 * unit, 150, 0x40000000, 18, 1],
    ];
    const cases = [
        { skill: 4, fast: false, respawn: false, blocked: false, timing: [1, 0, 0, 69], thinkers: respawned },
        { skill: 2, fast: true, respawn: false, blocked: false, timing: [1, 1, 419, 65], thinkers: [] },
        { skill: 2, fast: false, respawn: true, blocked: true, timing: [2, 1, 420, 66], thinkers: [] },
    ];
    const native = values.upstream && runNativeNightmareOracle(path.resolve(root, values.upstream), scratch, cases);
    cases.forEach(({ timing, thinkers, ...rules }, index) => {
        if (native) {
            const trace = native[index];
            assert.deepEqual(trace.find(([tag]) => tag === 20)?.slice(1), timing);
            assert.deepEqual(trace.filter(([tag]) => tag === 21).map(row => row.slice(1)), thinkers);
            assert.deepEqual(trace.filter(([tag, sound]) => tag === 9 && sound === 35),
                thinkers.length ? [[9, 35, 3], [9, 35, 4]] : []);
        }
        checkMonsterRules(rules, timing, thinkers);
    });
    console.log("WAD preview passed Nightmare fast timing, ordered monster respawn, independent fast/respawn flags and blocked spawn RNG.");
    checkNativeCommandSource();
    checkNativeActionGuard();
    console.log("The campaign consumes its physical arithmetic circuit: disconnecting Run changed Shift+Up from +50 to +25.");
    console.log("Single-host Ctrl+Space reached Fire and Use together. Disconnecting their physical gate suppressed both actions.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-campaign-controls-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
