// Verify the playable preview routes real Doom cues into native Music Arrows.
// The fixture has no art or audio data; the simulator observes the tile pulses.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, destinations, keyOf, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" } } });
const cli = path.join(root, "src", "Fletcher.Cli", "bin", "Debug", "net11.0", "fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-music-arrows-"));

const fire = [18]; // R
const forward = [23]; // W
const use = [6]; // F
const toggleAudio = [15]; // O
const lanes = {
    fire: { x: -55, y: 62 },
    pickup: { x: -41, y: 63 },
    damage: { x: -33, y: 63 },
    monster: { x: -25, y: 63 },
    mechanism: { x: -17, y: 63 },
    impact: { x: -9, y: 63 },
    stage: { x: -1, y: 63 },
    blockedUse: { x: 7, y: 63 },
};

function words(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => bytes.writeUInt16LE(value & 0xffff, index * 2));
    return bytes;
}

function wad(lumps) {
    const directory = 12 + lumps.reduce((size, [, bytes]) => size + bytes.length, 0);
    const out = Buffer.alloc(directory + lumps.length * 16);
    out.write("PWAD"); out.writeUInt32LE(lumps.length, 4); out.writeUInt32LE(directory, 8);
    let offset = 12;
    for (const [index, [name, bytes]] of lumps.entries()) {
        const entry = directory + index * 16;
        out.writeUInt32LE(offset, entry); out.writeUInt32LE(bytes.length, entry + 4); out.write(name, entry + 8);
        bytes.copy(out, offset); offset += bytes.length;
    }
    return out;
}

// A blue key door immediately ahead of the player makes the failed-use cue
// deterministic. A health bonus and blue card lie on the walking route.
function level(doorAction = 26, doorHeight = 0) {
    const vertices = words([-128, -64, -128, 64, 0, 64, 0, -64, 256, 64, 256, -64]);
    const lines = words([
        2, 3, 4, doorAction, 7, 0, 1,
        0, 1, 0, 0, 0, 0, 65535, 1, 2, 0, 0, 0, 0, 65535, 3, 0, 0, 0, 0, 0, 65535,
        2, 4, 0, 0, 0, 1, 65535, 4, 5, 0, 0, 0, 1, 65535, 5, 3, 0, 0, 0, 1, 65535,
    ]);
    const sides = Buffer.alloc(60); sides.writeUInt16LE(1, 58);
    const segs = words([
        0, 1, 0x4000, 1, 0, 0, 1, 2, 0, 2, 0, 0, 2, 3, 0xc000, 0, 0, 0, 3, 0, 0x8000, 3, 0, 0,
        3, 2, 0x4000, 0, 1, 0, 2, 4, 0, 4, 0, 0, 4, 5, 0xc000, 5, 0, 0, 5, 3, 0x8000, 6, 0, 0,
    ]);
    const nodes = words([0, -64, 0, 128, 64, -64, 0, 256, 64, -64, -128, 0, 0x8001, 0x8000]);
    const sectors = Buffer.alloc(52);
    for (const offset of [0, 26]) {
        sectors.writeInt16LE(offset === 26 ? doorHeight : 128, offset + 2);
        sectors.write("FLOOR0_1", offset + 4); sectors.write("CEIL1_1", offset + 12); sectors.writeInt16LE(160, offset + 20);
    }
    const block = words([-128, -128, 4, 2, ...Array(8).fill(12), 0, 1, 2, 3, 4, 5, 6, -1]);
    const things = words([-50, 0, 0, 1, 7, -38, 0, 0, 2014, 7, -9, 0, 0, 5, 7]);
    return [["E1M1", Buffer.alloc(0)], ["THINGS", things], ["LINEDEFS", lines], ["SIDEDEFS", sides], ["VERTEXES", vertices],
        ["SEGS", segs], ["SSECTORS", words([4, 0, 4, 4])], ["NODES", nodes], ["SECTORS", sectors], ["REJECT", Buffer.alloc(1)], ["BLOCKMAP", block]];
}

function build(entry = path.join(port, "wad-bsp", "main.flt")) {
    const output = path.join(scratch, "music-arrows.json");
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port,
        "--asset-root", scratch, "-o", output], { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
}

function checkUseTrace() {
    writeFileSync(path.join(scratch, "OPEN.WAD"), wad(level(0, 128)));
    writeFileSync(path.join(scratch, "SHUT.WAD"), wad(level(0)));
    const entry = path.join(scratch, "use-trace.flt");
    writeFileSync(entry, `package main
import "wad"
import "play"
const Open = readFile("OPEN.WAD")
const Shut = readFile("SHUT.WAD")
const Locked = readFile("LEVEL.WAD")
map "Doom use trace" {
    tick {
        file := Open
        x := -50
        var heading bits<32>
        switch currentTick() {
        case 0: x, heading = -100, 0x80000000
        case 1: file = Shut
        case 3: x = 64
        case 4: file, x, heading = Locked, 50, 0x80000000
        case 5: file = Locked
        }
        level := wad.LoadBspLevel(file, wad.LE32(file, 8))
        blocks := wad.LoadBlockMap(level)
        actor := play.ActorPhysics{Body: play.MapActor{Player: true, X: x << 16}, Angle: heading}
        hit := play.FindUseLine(level, blocks, actor.Body.X, 0, heading)
        used := play.UseLevelSpecialWithInventory(level, blocks, play.LevelSpecials{}, actor, play.PlayerInventory{})
        log(hit.Valid, hit.Found, hit.Blocked, used.Used, used.MissingKey, used.Sound)
    }
}`);
    const sim = build(entry);
    for (let i = 0; i < 6; i++) sim.step();
    assert.deepEqual(Array.from(sim.logs, row => Array.from(row)), [
        [true, false, true, false, false, 81],  // One-sided ordinary wall.
        [true, false, true, false, false, 81],  // Two-sided with zero opening.
        [true, false, false, false, false, 0],  // Passable ordinary portal.
        [true, false, false, false, false, 0],  // Empty use ray.
        [true, true, false, false, false, 0],   // Back side of a special.
        [true, true, false, true, true, 34],    // Front of a key-locked special.
    ]);
}

function assertMusicLanes(sim) {
    const extras = [0x0340, 0x0857, 0x1334, 0x0131, 0x1237, 0x153a, 0x0747, 0x0346];
    for (const [lane, [name, tile]] of Object.entries(lanes).entries()) {
        const music = sim.tileAt(tile);
        assert.equal(music?.type, 29, `${name} is a native Music Arrow`);
        assert.equal(music.rotation, 1);
        assert.equal(music.extra, extras[lane], `${name} has its configured instrument, octave and note`);
        const source = lane === 0 ? sim.tileAt({ x: tile.x - 1, y: tile.y }) : sim.tileAt({ x: tile.x, y: tile.y - 1 });
        assert.equal(source?.type, lane === 0 ? 22 : 16, `${name} uses its dynamic tone source or fixed pulse gate`);
        assert.equal(source.rotation, lane === 0 ? 1 : 2, `${name} source feeds its Music Arrow`);
    }
}

function checkFixedCuePulses(campaign) {
    // Exercise the placed gates from the compiled campaign without running a
    // whole WAD frame for each phase pattern. Drive the real forwarding lamp.
    const music = lanes.pickup;
    const phase = { x: music.x - 7, y: music.y - 3 };
    const lamp = campaign.tileAt(phase);
    assert.equal(lamp.type, 28);
    assert.equal(lamp.rotation, 2);
    const phaseKey = keyOf(phase);
    const tiles = [campaign.tileAt(music)];
    const included = new Set([keyOf(music)]);
    // Walk the actual incoming connections. A generated data block can use
    // an empty cell in this circuit's footprint without sending a signal.
    for (let index = 0; index < tiles.length; index++) {
        const target = tiles[index];
        const targetKey = keyOf(target);
        if (targetKey === phaseKey) continue;
        for (let y = target.y - 2; y <= target.y + 2; y++) {
            for (let x = target.x - 2; x <= target.x + 2; x++) {
                const tile = campaign.tileAt({ x, y });
                if (!tile || included.has(keyOf(tile)) || !destinations(tile).includes(targetKey)) continue;
                included.add(keyOf(tile));
                tiles.push(tile);
            }
        }
    }
    assert.equal(tiles.length, 13, "one phase lamp, eleven gates and one Music Arrow");
    assert.ok(included.has(phaseKey), "the phase lamp drives the pulse circuit");
    for (let pattern = 0; pattern < 1024; pattern++) {
        const sim = simulator(tiles);
        let previousPhase = 0, pending = false, previousPulse = false;
        const expected = [];
        for (let tick = 0; tick < 22; tick++) {
            const current = (pattern >>> Math.min(tick, 9)) & 1;
            if (current !== previousPhase) pending = true;
            const pulse = pending && !previousPulse;
            if (pulse) pending = false;
            expected.push(pulse);
            previousPulse = pulse;
            previousPhase = current;
            sim.step([], new Map([[phaseKey, current]]));
            assert.equal(sim.value(music) > 0, expected[tick - 7] ?? false,
                `fixed cue pulse for pattern ${pattern} at host tick ${tick}`);
        }
    }
}

function risingEdges(sim, tile, keys, ticks) {
    const edges = [];
    let previous = sim.value(tile) ?? 0;
    for (let tick = 0; tick < ticks; tick++) {
        sim.step([], new Map(), keys);
        const current = sim.value(tile) ?? 0;
        if (previous <= 0 && current > 0) edges.push(tick);
        previous = current;
    }
    return edges;
}

function untilRises(sim, tile, keys, description, limit = 260) {
    let previous = sim.value(tile) ?? 0;
    for (let tick = 0; tick < limit; tick++) {
        sim.step([], new Map(), keys);
        const current = sim.value(tile) ?? 0;
        if (previous <= 0 && current > 0) return tick;
        previous = current;
    }
    assert.fail(`${description}; recent logs: ${JSON.stringify(sim.logs.slice(-8))}`);
}

function checkWeaponTimbres() {
    const lumps = level(0, 128);
    lumps[0][0] = "MAP01";
    lumps[1][1] = words([-50, 0, 0, 1, 7, -42, 0, 0, 2001, 7, 112, 0, 0, 82, 7]);
    writeFileSync(path.join(scratch, "LEVEL.WAD"), wad(lumps));
    const sim = build();
    assertMusicLanes(sim);
    checkFixedCuePulses(sim);
    function expectTone(keys, extra, name) {
        untilRises(sim, lanes.fire, keys, name + " emits a fresh pulse");
        assert.equal(sim.tileAt(lanes.fire).extra, extra, name + " note and instrument at its rising edge");
    }
    function settle() {
        // Allow the current psprite to finish firing, lowering or raising.
        assert.deepEqual(risingEdges(sim, lanes.fire, [], 125), [], "no extra weapon cues during settling");
    }

    expectTone(fire, 0x0340, "pistol");
    untilRises(sim, lanes.pickup, forward, "the player walks over the shotgun");
    settle();
    expectTone(fire, 0x0337, "shotgun");
    untilRises(sim, lanes.pickup, forward, "the player walks over the super shotgun");
    settle();
    expectTone(fire, 0x032b, "super shotgun");
    expectTone([], 0x1249, "super shotgun open");
    expectTone([], 0x124b, "super shotgun load");
    expectTone([], 0x1250, "super shotgun close");
    sim.step([], new Map(), [29]); // Top-row 2 selects the pistol.
    settle();
    expectTone(fire, 0x0340, "pistol reselected after the super shotgun");
}

const soundCases = [
    ["zombieman death variation", "Possessed", "Scream", "sfx_podth1", 0, false, 0, [61, 7, 1]],
    ["shotgunner death variation wraps", "ShotGuy", "Scream", "sfx_podth2", 0, false, 255, [59, 7, 0]],
    ["imp death variation", "Imp", "Scream", "sfx_bgdth1", 0, false, 1, [63, 7, 2]],
    ["demon fixed death sound", "Demon", "Scream", "sfx_sgtdth", 0, false, 255, [64, 7, 255]],
    ["spider death at full volume", "Spider", "Scream", "sfx_spidth", 0, false, 255, [69, 0, 255]],
    ["cyberdemon death at full volume", "Cyborg", "Scream", "sfx_cybdth", 0, false, 255, [68, 0, 255]],
    ["silent death", "TeleportTarget", "Scream", "0", 0, false, 255, [0, 0, 255]],
    ["player pain", "Player", "Pain", "sfx_plpain", 0, false, 255, [25, 7, 255]],
    ["silent pain", "Barrel", "Pain", "0", 0, false, 255, [0, 0, 255]],
    ["gib sound", "Player", "XScream", "0", -150, true, 255, [31, 7, 255]],
    ["ordinary death at minus fifty", "Player", "PlayerScream", "0", -50, true, 255, [57, 7, 255]],
    ["Doom II high death cry", "Player", "PlayerScream", "0", -51, true, 255, [58, 7, 255]],
    ["Doom episode keeps regular death cry", "Player", "PlayerScream", "0", -51, false, 255, [57, 7, 255]],
    ["cyberdemon hoof", "Cyborg", "Hoof", "sfx_hoof", 100, true, 4, [84, 7, 4]],
    ["spider metal step", "Spider", "Metal", "sfx_metal", 100, true, 4, [85, 7, 4]],
    ["arachnotron step", "Arachnotron", "BabyMetal", "sfx_bspwlk", 100, true, 4, [79, 7, 4]],
];

function checkActorSoundTrace() {
    const fixture = path.join(scratch, "actor-sound-trace");
    mkdirSync(fixture);
    const entry = path.join(fixture, "main.flt");
    writeFileSync(entry, `package main
import "actorinfo"
import "play"
map "Doom actor sound trace" {
    tick {
        switch currentTick() {
${soundCases.map(([, kind, action, , health, commercial, seed], index) => `        case ${index}:
            actor := play.LevelActor{Valid: true, Kind: actorinfo.Actor${kind}, Health: ${health}}
            sound, origin, random := play.ActorActionSound(actor, 7, actorinfo.Action${action}, ${commercial},
                play.RandomState{GameplayIndex: ${seed}})
            log(sound, origin, random.GameplayIndex)`).join("\n")}
        }
    }
}`);
    const sim = build(entry);
    for (const [label, , , , , , , expected] of soundCases) {
        sim.step();
        assert.deepEqual(Array.from(sim.logs.at(-1)), expected, label);
    }
}

function checkNativeSoundActions(upstream) {
    const read = name => readFileSync(path.join(upstream, name), "utf8");
    const enemy = read("p_enemy.c");
    const sounds = read("sounds.h").match(/typedef enum\s*\{\s*sfx_None,[\s\S]+?\} sfxenum_t;/);
    const random = read("light-m_random.c");
    const randomTable = random.match(/unsigned char rndtable\[256\] = \{[\s\S]+?\};/);
    assert.ok(sounds && randomTable, "pinned sound IDs and Doom RNG table");
    const source = path.join(scratch, "actor-sound-trace.c");
    const executable = path.join(scratch, "actor-sound-trace.exe");
    writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
${sounds[0]}
${randomTable[0]}
static int prndindex;
${extractFunction(random, "int", "P_Random")}
enum { MT_SPIDER=19, MT_CYBORG=21, shareware=0, commercial=1 };
typedef struct { int deathsound, painsound; } mobjinfo_t;
typedef struct { mobjinfo_t *info; int type, health; } mobj_t;
static int gamemode, soundId, origin;
static void S_StartSound(mobj_t *actor, int sound) { soundId = sound; origin = actor ? 7 : 0; }
static void A_Chase(mobj_t *actor) { if (!actor || !soundId) abort(); }
${["Scream", "XScream", "Pain", "PlayerScream", "Hoof", "Metal", "BabyMetal"].map(action => extractFunction(enemy, "void", "A_" + action)).join("\n")}
int main(void) {
${soundCases.map(([, kind, action, sound, health, commercialMode, seed]) => `    {
        mobjinfo_t info={${action === "Scream" ? sound : "0"}, ${action === "Pain" ? sound : "0"}};
        mobj_t actor={&info, ${kind === "Spider" ? "MT_SPIDER" : kind === "Cyborg" ? "MT_CYBORG" : "0"}, ${health}};
        gamemode=${commercialMode ? "commercial" : "shareware"}; prndindex=${seed}; soundId=origin=0;
        A_${action}(&actor);
        printf("%d,%d,%d\\n",soundId,origin,prndindex);
    }`).join("\n")}
}`);
    const compile = spawnSync("gcc", ["-std=c99", source, "-o", executable], { encoding: "utf8", timeout: 30000 });
    if (compile.error) throw compile.error;
    assert.equal(compile.status, 0, compile.stderr);
    const native = spawnSync(executable, { encoding: "utf8", timeout: 30000 });
    if (native.error) throw native.error;
    assert.equal(native.status, 0, native.stderr);
    assert.deepEqual(native.stdout.trim().split(/\r?\n/).map(row => row.split(",").map(Number)),
        soundCases.map(row => row.at(-1)));
}

function checkActorSoundCues() {
    const preview = path.join(scratch, "sound-preview");
    cpSync(path.join(port, "wad-bsp"), preview, { recursive: true });
    const entry = path.join(preview, "main.flt");
    let source = readFileSync(entry, "utf8");
    const spawn = "                            start := spawned.ActorAt(spawned.PlayerActors[0] - 1)";
    const combat = "                combat.GameTic, combat.World.AttackRange = gameTime, attackRange";
    const actorTick = "                    stepped := tickPreviewWorldActors(combat, blockMap, command, view, contacts, passiveActors, levelTime)";
    assert.ok(source.includes(spawn) && source.includes(combat) && source.includes(actorTick), "sound fixture anchors");
    source = source.replace(spawn, `${spawn}
                            start.Physics.Body.Z, start.Physics.MomentumZ = 8 << 16, -(9 << 16)
                            spawned = spawned.WithActor(spawned.PlayerActors[0], start)`);
    source = source.replace(combat, `${combat}
                if levelTime == 2 || levelTime == 8 {
                    target, amount := contacts.Handle, 1
                    if levelTime == 8 { target, amount = mapActors, 20 }
                    combat.World.Random.GameplayIndex = 255
                    damage := play.DamageMobj(combat.Level, combat.World, play.DamageRequest{Target: target, Amount: amount}, combat.Rules)
                    combat = finishPreviewMobjCombat(combat, blockMap, damage, combat.Rules)
                }`);
    source = source.replace(actorTick, `${actorTick}
                    if stepped.Thinkers.Combat.LastSound != 0 {
                        log("actor sound", stepped.Thinkers.Combat.LastSound)
                    }`);
    writeFileSync(entry, source);
    const lumps = level();
    lumps[1][1] = Buffer.concat([lumps[1][1], words([128, 0, 180, 3004, 7])]);
    writeFileSync(path.join(scratch, "LEVEL.WAD"), wad(lumps));
    const sim = build(entry);
    untilRises(sim, lanes.blockedUse, [], "the hard landing sends the native oof to the Music Arrow");
    untilRises(sim, lanes.damage, [], "the player's delayed pain callback sends a damage cue");
    assert.ok(sim.logs.some(([event, sound]) => event === "actor sound" && sound === 25));
    untilRises(sim, lanes.monster, [], "the zombieman's delayed death callback sends a monster cue");
    assert.ok(sim.logs.some(([event, sound]) => event === "actor sound" && sound >= 59 && sound <= 61));
}

try {
    writeFileSync(path.join(scratch, "LEVEL.WAD"), wad(level()));
    checkUseTrace();
    const sim = build();
    assertMusicLanes(sim);
    risingEdges(sim, lanes.fire, [], 24); // let initialization settle before observing player input

    untilRises(sim, lanes.blockedUse, use, "locked use emits the blocked-use Music Arrow cue");
    risingEdges(sim, lanes.blockedUse, [], 8);
    untilRises(sim, lanes.fire, fire, "firing emits the fire Music Arrow cue");
    risingEdges(sim, lanes.fire, [], 8);
    untilRises(sim, lanes.pickup, forward, "walking through the fixture pickup emits the pickup Music Arrow cue");
    risingEdges(sim, lanes.pickup, [], 8);

    // O toggles cue delivery, rather than stopping the game simulation. Held
    // R would normally produce several pistol sound requests in this interval.
    risingEdges(sim, lanes.fire, toggleAudio, 3);
    risingEdges(sim, lanes.fire, [], 8);
    assert.deepEqual(risingEdges(sim, lanes.fire, fire, 140), [], "muted Music Arrow lane stays silent while firing");
    risingEdges(sim, lanes.fire, [], 8);
    risingEdges(sim, lanes.fire, toggleAudio, 3);
    risingEdges(sim, lanes.fire, [], 8);
    untilRises(sim, lanes.fire, fire, "unmuting restores fire Music Arrow cues");

    writeFileSync(path.join(scratch, "LEVEL.WAD"), wad(level(0)));
    const shut = build();
    risingEdges(shut, lanes.blockedUse, [], 24);
    untilRises(shut, lanes.blockedUse, use, "using a closed ordinary portal emits the denied-use Music Arrow cue");
    assert.deepEqual(risingEdges(shut, lanes.blockedUse, use, 20), [], "holding use does not repeat the denied cue");
    checkActorSoundTrace();
    if (values.upstream) checkNativeSoundActions(path.resolve(root, values.upstream));
    checkActorSoundCues();
    checkWeaponTimbres();
    console.log("Seven fixed Music Arrows retained their tones. The compiled pulse circuit matched 1,024 phase sequences at seven host ticks of latency.");
    console.log("Six use traces matched Doom wall/portal behavior. The preview routed blocked-use, locked-use, fire, and pickup cues through Music Arrows.");
    console.log(`Actor sounds matched ${soundCases.length} sound, origin, and random-index traces. The preview emitted landing, pain, and death cues through Music Arrows.`);
    console.log("The weapon Music Arrow emitted pistol, shotgun, super shotgun, open, load, close and reselected pistol tones.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-music-arrows-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
