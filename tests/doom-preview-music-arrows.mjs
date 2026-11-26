// Verify the playable preview routes real Doom cues into native Music Arrows.
// The fixture has no art or audio data; the simulator observes the tile pulses.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import vm from "node:vm";
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
const cueVoices = (x, y) => [{ x, y }, { x: x - 4, y }];
const cueTrigger = voice => ({ x: voice.x, y: voice.y - 1 });
const cueAccent = (voice, index) => ({ x: voice.x + (index === 0 ? -1 : 1), y: voice.y - 1 });
const cueAccents = ({ tones, voices }) => voices.flatMap(voice => tones.map((tone, index) => ({
    ...cueAccent(voice, index), tone,
})));
const commonLanes = [
    ["pickup", 0x0857, 0x0847], ["damage", 0x1334, 0x0342], ["monster", 0x0131, 0x1531],
    ["mechanism", 0x1237, 0x0337], ["impact", 0x153a, 0x1235, 0x0340], ["stage", 0x0747, 0x0757],
    ["blockedUse", 0x0346, 0x1246],
].map(([name, tone, ...tones], index) => ({ name, tone, tones, voices: cueVoices(-41 + 8 * index, 63) }));
const weaponTones = [0x0340, 0x0337, 0x032b, 0x1251, 0x1249, 0x124b, 0x1250, 0x1357,
    0x1534, 0x1539, 0x1527, 0x1537, 0x152b, 0x1227, 0x0330, 0x0341];
const weaponLanes = new Map(weaponTones.map((tone, index) => [tone, cueVoices(-57 + 8 * index, 76)]));
const weaponAccents = new Map([
    [0, [0x1230, 0x0342]], [1, [0x1225, 0x0340]], [2, [0x1220, 0x0344]], [7, [0x0347]],
    [8, [0x0330, 0x1224]], [9, [0x0349]], [12, [0x034b]], [13, [0x0330, 0x0347]],
    [14, [0x0340]], [15, [0x1232, 0x0343]],
]);
const weapons = weaponTones.map((tone, lane) => ({
    name: `weapon lane ${lane}`, tone, tones: weaponAccents.get(lane) ?? [], voices: weaponLanes.get(tone),
}));
const menuLanes = [
    ["cursor", 0x1253, 0x0353], ["slider", 0x1243, 0x0343], ["back", 0x1246, 0x0346],
    ["dismiss", 0x1240, 0x0330], ["select", 0x0340, 0x1230],
].map(([name, tone, ...tones], index) => ({ name, tone, tones, voices: cueVoices(71 + 8 * index, 76) }));
const lanes = {
    fire: weaponLanes.get(0x0340),
    ...Object.fromEntries(commonLanes.map(({ name, voices }) => [name, voices])),
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

function assertMusicArrow(sim, name, tile, tone) {
    const music = sim.tileAt(tile);
    assert.equal(music?.type, 29, `${name} is a native Music Arrow`);
    assert.equal(music.rotation, 1);
    assert.equal(music.extra, tone, `${name} has its configured instrument, octave and note`);
}

function assertCueVoice(sim, name, voice, tone) {
    assertMusicArrow(sim, name, voice, tone);
    const trigger = sim.tileAt(cueTrigger(voice));
    assert.equal(trigger?.type, 8, `${name} uses a physical T splitter`);
    assert.equal(trigger.rotation, 2);
    const outputs = destinations(trigger);
    assert.ok(outputs.includes(keyOf(voice)), `${name} drives its tone in one hop`);
    return outputs;
}

function assertMusicLanes(sim) {
    for (const { name, tone, tones, voices } of [...commonLanes, ...weapons, ...menuLanes]) {
        for (const [bank, voice] of voices.entries()) {
            const label = `${name} bank ${bank}`;
            const outputs = assertCueVoice(sim, label, voice, tone);
            for (const accent of cueAccents({ tones, voices: [voice] })) {
                assertMusicArrow(sim, `${label} accent`, accent, accent.tone);
                assert.ok(outputs.includes(keyOf(accent)), `${label} drives its accent in the same hop`);
            }
            for (let index = tones.length; index < 2; index++) {
                assert.notEqual(sim.tileAt(cueAccent(voice, index))?.type, 29, `${label} has no unconfigured accent`);
            }
        }
    }
}

function checkCommonCuePulses(campaign) {
    // Run the compiled conductor and physical voices with synthetic publications.
    const stepConductor = cueConductor(campaign);
    const voices = commonLanes.flatMap(lane => [...lane.voices, ...cueAccents(lane)]);
    const triggers = commonLanes.flatMap(lane => lane.voices.map(cueTrigger));
    const sim = simulator([...voices, ...triggers].map(tile => campaign.tileAt(tile)));
    let hostTick = 1;
    for (let pattern = 0; pattern < 1024; pattern++) {
        const lastPrimary = commonLanes.map(() => -1);
        let previousNotes = [];
        for (let tick = 0; tick < 12; tick++, hostTick++) {
            let requests = 0;
            const notes = new Set();
            const writesExpected = [];
            for (const [lane, { tones, voices }] of commonLanes.entries()) {
                // Offset each lane's ten-bit sequence to expose cross-lane interference.
                if (tick >= 10 || (pattern & (1 << ((tick + lane) % 10))) === 0) continue;
                requests |= 1 << lane;
                const bank = lastPrimary[lane] === hostTick - 1 ? 1 : 0;
                if (bank === 0) lastPrimary[lane] = hostTick;
                const voice = voices[bank];
                const { x, y } = cueTrigger(voice);
                writesExpected.push([x, y, 1]);
                notes.add(keyOf(voice));
                for (const accent of cueAccents({ tones, voices: [voice] })) notes.add(keyOf(accent));
            }
            const writes = stepConductor(hostTick, hostTick, requests);
            assert.deepEqual(writes, writesExpected, `common trigger writes for pattern ${pattern} at offset ${tick}`);
            sim.step([], new Map(writes.map(([x, y, value]) => [keyOf({ x, y }), value])));
            assert.deepEqual(voices.filter(voice => sim.value(voice) > 0), previousNotes,
                `every common request sounds in one hop for pattern ${pattern} at offset ${tick}`);
            previousNotes = voices.filter(voice => notes.has(keyOf(voice)));
        }
    }
}

function checkFastWeaponAndMenuPulses(campaign) {
    for (const { name, voices, tones } of [...weapons, ...menuLanes]) {
        const triggers = voices.map(cueTrigger);
        const layers = voices.map(voice => [voice, ...cueAccents({ tones, voices: [voice] })]);
        const sim = simulator([...triggers, ...layers.flat()].map(tile => campaign.tileAt(tile)));
        const schedule = [0, 1, 0];
        for (let tick = 0; tick <= schedule.length + 1; tick++) {
            const bank = schedule[tick];
            sim.step([], bank === undefined ? new Map() : new Map([[keyOf(triggers[bank]), 1]]));
            const expected = [schedule[tick - 1] === 0, schedule[tick - 1] === 1];
            for (const [index, layer] of layers.entries()) {
                assert.deepEqual(layer.map(voice => sim.value(voice) > 0), layer.map(() => expected[index]),
                    `${name} bank ${index} tones rise together one hop after the request at tick ${tick}`);
            }
        }
    }
}

function cueConductor(campaign) {
    const driver = campaign.tileAt({ x: 16, y: 64 });
    assert.equal(driver?.type, 22);
    const frames = {};
    const writes = [];
    let hostTick = 0, callback;
    vm.runInNewContext(driver.payload.toString("utf8"), {
        getPosition: () => driver,
        globalState: frames,
        state: {},
        world: {
            getTick: () => hostTick,
            setSignal: (...args) => writes.push(args),
            setArrow: () => assert.fail("cues must reuse their configured Music Arrows"),
        },
        always: handler => { callback = handler; },
    }, { timeout: 1000 });

    return (tick, epoch, requests, publishedTick = tick - 1) => {
        hostTick = tick;
        const slot = tick % 2 === 0 ? "__fletcherOdd" : "__fletcherEven";
        frames[slot] = { t: publishedTick, p: { soundCueEpoch: epoch, soundCueRequests: requests } };
        callback();
        return writes.splice(0);
    };
}

function checkCueConductor(campaign) {
    const step = cueConductor(campaign);
    const menuRequests = 0x1f << 23;
    const requests = (1 << 0) | (1 << 6) | (1 << 7) | (1 << 22) | menuRequests;
    assert.deepEqual(step(0), [], "idle before the first published frame");
    assert.deepEqual(step(1, 0, requests), [], "the zero epoch sentinel publishes no signal writes");
    assert.deepEqual(step(2, 1, requests), [[-41, 62, 1], [7, 62, 1], [-57, 75, 1], [63, 75, 1],
        [71, 75, 1], [79, 75, 1], [87, 75, 1], [95, 75, 1], [103, 75, 1]],
        "every requested common, weapon, and menu lane receives exactly one trigger pulse");
    const repeated = (1 << 0) | (1 << 7) | (1 << 23);
    assert.deepEqual(step(3, 2, repeated), [[-45, 62, 1], [-61, 75, 1], [67, 75, 1]],
        "adjacent requests use the alternate physical voices");
    assert.deepEqual(step(4, 2, repeated), [], "a render slice can repeat an epoch without retransmitting");
    assert.deepEqual(step(5, 3, 1, 3), [], "stale host publication is ignored");
    assert.deepEqual(step(6, 3, 1 | (1 << 24)), [[-41, 62, 1], [75, 75, 1]],
        "common cues return to primary after idle while menu cues keep alternating");
    assert.deepEqual(step(12), [], "a clock jump before any valid frame is silent");
    assert.deepEqual(step(13, 3, requests), [], "the first valid frame after a jump is the baseline");
    assert.deepEqual(step(14, 3, requests), [], "the retained epoch stays silent after resync");
    assert.deepEqual(step(15, 4, 1 << 8), [[-49, 75, 1]], "a new post-resync cue is delivered");
    assert.deepEqual(step(6, 2, requests), [], "rewinding even to a valid older frame is silent");
    assert.deepEqual(step(7, 0x80000000, 1 << 7), [[-57, 75, 1]], "a full-width unsigned epoch after rewind is delivered");
}

function risingEdges(sim, tile, keys, ticks) {
    const edges = [];
    const tiles = Array.isArray(tile) ? tile : [tile];
    const previous = tiles.map(tile => sim.value(tile) ?? 0);
    for (let tick = 0; tick < ticks; tick++) {
        sim.step([], new Map(), keys);
        for (const [index, tile] of tiles.entries()) {
            const current = sim.value(tile) ?? 0;
            if (previous[index] <= 0 && current > 0) edges.push(tick);
            previous[index] = current;
        }
    }
    return edges;
}

function untilRises(sim, tile, keys, description, limit = 260) {
    const tiles = Array.isArray(tile) ? tile : [tile];
    let previous = tiles.map(tile => sim.value(tile) > 0);
    for (let tick = 0; tick < limit; tick++) {
        sim.step([], new Map(), keys);
        const current = tiles.map(tile => sim.value(tile) > 0);
        if (current.some((active, index) => active && !previous[index])) return tick;
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
    function expectTone(keys, extra, name) {
        const voices = weaponLanes.get(extra);
        if (keys.length > 0) sim.step([], new Map(), keys);
        untilRises(sim, voices, [], name + " emits a fresh pulse");
        const sounded = voices.filter(voice => sim.value(voice) > 0);
        assert.equal(sounded.length, 1, `${name} sounds in one bank`);
        assert.equal(sim.tileAt(sounded[0]).extra, extra, `${name} note and instrument at its rising edge`);
    }
    function settle() {
        // Allow the current psprite to finish firing, lowering or raising.
        assert.deepEqual(risingEdges(sim, [...weaponLanes.values()].flat(), [], 125), [], "no extra weapon cues during settling");
    }

    settle();
    expectTone([53], 0x0340, "pistol from the native Ctrl alias");
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

function checkSimultaneousCues() {
    const preview = path.join(scratch, "simultaneous-cue-preview");
    cpSync(path.join(port, "wad-bsp"), preview, { recursive: true });
    const entry = path.join(preview, "main.flt");
    const source = readFileSync(entry, "utf8");
    const combat = "                combat.GameTic, combat.World.AttackRange = gameTime, attackRange";
    assert.ok(source.includes(combat), "simultaneous sound fixture anchor");
    writeFileSync(entry, source.replace(combat, `${combat}
                if levelTime == 2 {
                    combat = cuePreviewActorSound(combat, 1, contacts.Handle)
                    combat = cuePreviewActorSound(combat, 2, 0)
                    soundCues = soundCues | cueMechanism
                    menuStep.Sound = play.CampaignMenuSoundAdjust
                }`));
    writeFileSync(path.join(scratch, "LEVEL.WAD"), wad(level()));

    const sim = build(entry);
    const requested = [weapons[0], weapons[1], commonLanes[3], menuLanes[1]];
    for (let host = 0; host < 260; host++) {
        sim.step();
        const active = requested.map(({ voices }) => voices.find(voice => sim.value(voice) > 0));
        if (active.some(Boolean)) {
            for (const [index, { name, tones }] of requested.entries()) {
                const voice = active[index];
                assert.ok(voice, `${name} fires with the other cues`);
                for (const accent of cueAccents({ tones, voices: [voice] })) {
                    assert.ok(sim.value(accent) > 0, `${name} accent fires with the other cues`);
                }
            }
            return;
        }
    }
    assert.fail(`simultaneous cues never arrived; recent logs: ${JSON.stringify(sim.logs.slice(-8))}`);
}

try {
    writeFileSync(path.join(scratch, "LEVEL.WAD"), wad(level()));
    checkUseTrace();
    const sim = build();
    assertMusicLanes(sim);
    checkCueConductor(sim);
    checkCommonCuePulses(sim);
    checkFastWeaponAndMenuPulses(sim);
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
    const pistolOutputs = [...lanes.fire, ...cueAccents(weapons[0])];
    assert.deepEqual(risingEdges(sim, pistolOutputs, fire, 140), [], "both weapon banks and their accents stay silent while muted");
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
    checkSimultaneousCues();
    console.log("Seven common cue lanes delivered every request in one host tick across 1,024 sequences per lane.");
    console.log("Sixteen weapon and five menu lanes fired in one host tick, with same-tick accents and alternating banks for consecutive requests.");
    console.log("Cue dispatch wrote no idle or repeated signals and resynchronized without replaying cues on clock jumps.");
    console.log("Six use traces matched Doom wall/portal behavior. The preview routed blocked-use, locked-use, fire, and pickup cues through Music Arrows.");
    console.log(`Actor sounds matched ${soundCases.length} sound, origin, and random-index traces. The preview emitted landing, pain, and death cues through Music Arrows.`);
    console.log("The preview emitted distinct weapon and reload tones, and simultaneous pistol, shotgun, mechanism, and menu cues.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-music-arrows-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
