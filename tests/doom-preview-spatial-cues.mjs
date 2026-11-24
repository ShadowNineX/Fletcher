// Compile the preview's cue filter and Music Arrow source without a WAD.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples/doom-engine");
const scratch = mkdtempSync(path.join(os.tmpdir(), "fletcher-preview-spatial-cues-"));
const monsterCue = 8;
// The listener is handle 2. Handle 1 is positioned relative to the listener.
// Handle 3 is allocated but removed and handle 4 is outside the roster.
const cases = [
    ["E1M1", 1, 80, 0, true], ["E1M1", 1, 1130, 0, true], ["E1M1", 1, 1131, 0, false],
    ["E1M1", 1, 800, 800, false], ["E1M1", 1, 1600, 0, false],
    ["E1M1", 2, 1600, 0, true], ["E1M1", 0, 1600, 0, true],
    ["MAP08", 1, 80, 0, true], ["MAP08", 1, 1600, 0, true],
    ["MAP08", 2, 1600, 0, true], ["MAP08", 0, 1600, 0, true],
    ["E2M8", 1, 1600, 0, true], ["MAP18", 1, 1600, 0, false],
    ["MAP08", 3, 80, 0, false], ["MAP08", 4, 80, 0, false],
];

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function nativeAudibility(upstream) {
    const raw = readFileSync(path.resolve(root, upstream, "s_sound.c"), "utf8").replaceAll("\r\n", "\n");
    const routine = extractFunction(raw, "int", "S_AdjustSoundParams");
    const source = path.join(scratch, "spatial.c"), exe = path.join(scratch, "spatial.exe");
    // Separation is not represented by these Music Arrows. Its angle and sine
    // inputs do not affect S_AdjustSoundParams' volume or return value.
    writeFileSync(source, `#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
typedef int32_t fixed_t; typedef uint32_t angle_t;
typedef struct {fixed_t x,y; angle_t angle;} mobj_t;
enum { FRACBITS=16, FRACUNIT=65536, ANGLETOFINESHIFT=19, S_CLIPPING_DIST=1200*FRACUNIT,
       S_CLOSE_DIST=160*FRACUNIT, S_ATTENUATOR=1040, S_STEREO_SWING=96*FRACUNIT };
static const int finesine[8192]={0};
static const int snd_SfxVolume=15;
static int gamemap;
static angle_t R_PointToAngle2(int x1,int y1,int x2,int y2){return 0;}
static fixed_t FixedMul(fixed_t a,fixed_t b){return ((int64_t)a*b)>>FRACBITS;}
${routine}
static void sample(int map,int dx,int dy) {
    mobj_t listener={37*FRACUNIT,-72*FRACUNIT,0}, source={(37+dx)*FRACUNIT,(-72+dy)*FRACUNIT,0};
    int vol=snd_SfxVolume,sep=128,pitch=128;
    gamemap=map; printf("%d\\n",S_AdjustSoundParams(&listener,&source,&vol,&sep,&pitch));
}
int main(void) {
${cases.filter(c => c[1] === 1).map(([map,,dx,dy]) =>
    `    sample(${Number(map.startsWith("MAP") ? map.slice(3) : map.slice(-1))},${dx},${dy});`).join("\n")}
}
`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(value => Boolean(Number(value)));
}

function mapName(name) {
    const data = Buffer.alloc(8);
    data.write(name);
    return `wad.LumpName{Low: ${data.readUInt32LE()}, High: ${data.readUInt32LE(4)}}`;
}

function checkCombatDispatch() {
    for (const name of ["combat-preview", "monster-preview", "action-preview", "player-preview", "teleport-preview"]) {
        copyFileSync(path.join(port, "wad-bsp", name + ".flt"), path.join(scratch, name + ".flt"));
    }
    const entry = path.join(scratch, "main.flt"), output = path.join(scratch, "dispatch.json");
    const checks = [
        ["Demon", "Scream", 80, 64], ["Demon", "Scream", 1600, 0],
        ["Cyborg", "Scream", 1600, 68], ["Cyborg", "Look", 1600, 44],
        ["Cyborg", "Hoof", 80, 84], ["Cyborg", "Hoof", 1600, 0],
    ];
    writeFileSync(entry, `package main
import "actorinfo"
import "play"
import "wad"
map "Combat dispatch sound origins" {
    tick {
        level := wad.BspLevel{Valid: true, MapName: ${mapName("E1M1")}, Sectors: wad.Lump{Valid: true, Count: 1}}
        kind, action, distance := 0, 0, 0
        switch currentTick() {
${checks.map(([kind, action, distance], i) => `        case ${i}: kind, action, distance = actorinfo.Actor${kind}, actorinfo.Action${action}, ${distance}`).join("\n")}
        }
        listener := play.LevelActor{Valid: true, Health: 100}
        listener.Physics.Body.Flags = play.ActorShootable
        source := play.LevelActor{Valid: true, Kind: kind, Target: 2}
        source.Physics.Body.X = distance << 16
        source.Physics.Body.Flags = play.ActorJustAttacked
        actors := play.MapActors{}.AppendActor(source).AppendActor(listener)
        actors.PlayerActors[0] = 2
        scene := PreviewCombat{Level: level, Base: level, World: play.CombatWorld{Actors: actors}}
        scene.Hearing.Targets = play.NoiseAlert(level, play.BuildSoundGraph(level), scene.Hearing.Targets, 0, 2)
        event := play.CombatStep{World: scene.World, ActorHandle: 1, State: play.ActorStateStep{Action: action}}
        // The just-attacked branch completes A_Chase after the footstep.
        scene = dispatchPreviewCombat(scene, wad.BlockMapInfo{}, event, play.CombatRules{Skill: 4})
        log(scene.LastSound, scene.Cues, scene.Failed)
    }
}`);
    run("dotnet", [cli, "build", entry, "--package-root", port, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (const [index, [kind, action, distance, sound]] of checks.entries()) {
        sim.step();
        assert.deepEqual(Array.from(sim.logs[index] ?? []), [sound, sound ? monsterCue : 0, false],
            `${kind} A_${action} at ${distance} units`);
    }
}

try {
    if (values.upstream) {
        assert.deepEqual(nativeAudibility(values.upstream), cases.filter(c => c[1] === 1).map(c => c[4]));
    }
    copyFileSync(path.join(port, "wad-bsp/sound-cues.flt"), path.join(scratch, "sound-cues.flt"));
    copyFileSync(path.join(port, "wad-bsp/fixed-cue.flt"), path.join(scratch, "fixed-cue.flt"));
    const source = path.join(scratch, "main.flt"), output = path.join(scratch, "map.json");
    writeFileSync(source, `package main
import "play"
import "wad"
map "Spatial Music Arrow cues" {
    register phase bits<8> = 0
    script { output bus bits<8> at (0, 0) with { forward = "down" } = phase }
    expand FixedCue(24, 0, 1, 3, 1)
    tick {
        index := currentTick() / 16
        if currentTick() % 16 == 1 && index < ${cases.length} {
            var level wad.BspLevel
            origin, dx, dy := 0, 0, 0
            switch index {
${cases.map(([map, origin, dx, dy], i) => `            case ${i}: level.MapName, origin, dx, dy = ${mapName(map)}, ${origin}, ${dx}, ${dy}`).join("\n")}
            }
            listener := play.LevelActor{Valid: true}
            listener.Physics.Body.X, listener.Physics.Body.Y = 37 << 16, -72 << 16
            emitter := listener
            emitter.Physics.Body.X, emitter.Physics.Body.Y = (37 + dx) << 16, (-72 + dy) << 16
            actors := play.MapActors{}.AppendActor(emitter).AppendActor(listener).AppendActor(play.LevelActor{})
            actors.PlayerActors[0] = 2
            cue := previewActorCue(level, actors, 64, origin)
            next phase = phase ^ cue
            log(index, cue, phase ^ cue)
        }
    }
}`);
    run("dotnet", [cli, "build", source, "--package-root", port, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    const music = { x: 31, y: 3 };
    assert.equal(sim.tileAt(music)?.type, 29);
    let phase = 0, high = false;
    for (const [index, [map, origin, dx, dy, audible]] of cases.entries()) {
        const label = `${map}, origin ${origin}, offset (${dx}, ${dy})`;
        let onsets = 0;
        for (let tick = 0; tick < 16; ++tick) {
            sim.step();
            const signal = sim.value(music) > 0;
            if (!high && signal) onsets++;
            high = signal;
        }
        const cue = audible ? monsterCue : 0;
        phase ^= cue;
        assert.deepEqual(Array.from(sim.logs[index] ?? []), [index, cue, phase], label);
        assert.equal(onsets, Number(audible), label);
        assert.equal(high, false, `${label} pulse ends`);
    }
    checkCombatDispatch();
    console.log(`Verified ${cases.length} preview sound origins through the compiled cue phase and Music Arrow pulses.`);
    console.log("Combat dispatch preserved global boss sounds and clipped distant ordinary deaths and hoofsteps.");
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
