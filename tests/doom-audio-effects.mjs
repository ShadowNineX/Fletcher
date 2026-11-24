// Compare the compiled Fletcher sound catalogue with the actual pinned C
// table, then exercise sound starts with two generated PCM lumps.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "src", "Fletcher.Cli", "bin", "Debug", "net11.0", "fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const upstream = path.join(root, "artifacts", "doom-upstream");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-audio-effects-"));

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
}

function pcm(samples) {
    const lump = Buffer.alloc(8 + samples.length);
    lump.writeUInt16LE(3, 0);
    lump.writeUInt16LE(11025, 2);
    lump.writeUInt32LE(samples.length, 4);
    lump.set(samples, 8);
    return lump;
}

function wad(lumps) {
    const directory = 12 + lumps.reduce((size, [, bytes]) => size + bytes.length, 0);
    const file = Buffer.alloc(directory + 16 * lumps.length);
    file.write("PWAD");
    file.writeUInt32LE(lumps.length, 4);
    file.writeUInt32LE(directory, 8);
    let offset = 12;
    lumps.forEach(([name, bytes], index) => {
        const record = directory + index * 16;
        file.writeUInt32LE(offset, record);
        file.writeUInt32LE(bytes.length, record + 4);
        file.write(name, record + 8);
        file.set(bytes, offset);
        offset += bytes.length;
    });
    return file;
}

function nativeCatalogs() {
    const source = readFileSync(path.join(upstream, "sounds.c"), "utf8");
    const start = source.indexOf("musicinfo_t S_music[]");
    assert.ok(start >= 0, "find the pinned sound catalogue");
    const sound = readFileSync(path.join(upstream, "s_sound.c"), "utf8");
    const startup = /^void S_Start\(void\)\s*\{[\s\S]*?^\}/m.exec(sound)?.[0];
    assert.ok(startup, "find the pinned level music selector");
    const input = path.join(scratch, "effects.c");
    const binary = path.join(scratch, "effects.exe");
    writeFileSync(input, `
#include <stdbool.h>
#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include "sounds.h"
${source.slice(start)}
static struct { sfxinfo_t *sfxinfo; } channels[1];
static int numChannels, gamemode, gamemap, gameepisode, mus_paused, nextcleanup, selected;
enum { commercial = 1 };
static void S_StopChannel(int channel) { (void)channel; }
static void S_ChangeMusic(int id, bool loop) { (void)loop; selected = id; }
${startup}

static void nameWords(char prefix, const char *source, uint32_t *low, uint32_t *high) {
    unsigned char name[8] = {'D', prefix};
    for (int j = 0; j < 6 && source[j]; ++j) name[j + 2] = toupper((unsigned char)source[j]);
    *low = *high = 0;
    for (int j = 0; j < 4; ++j) {
        *low |= (uint32_t)name[j] << (8 * j);
        *high |= (uint32_t)name[j + 4] << (8 * j);
    }
}
int main(void) {
    for (int i = 1; i < NUMSFX; ++i) {
        sfxinfo_t *effect = &S_sfx[i];
        sfxinfo_t *sample = effect->link ? effect->link : effect;
        uint32_t low, high;
        nameWords('S', sample->name, &low, &high);
        printf("effect,%d,%u,%u,%d,%d,%d,%d\\n", i, low, high, effect->priority,
            effect->link ? effect->pitch : 128, effect->link ? effect->volume : 0, !!effect->singularity);
    }
    for (int i = 1; i < NUMMUSIC; ++i) {
        uint32_t low, high;
        nameWords('_', S_music[i].name, &low, &high);
        printf("track,%d,%u,%u\\n", i, low, high);
    }
    for (gameepisode = 1; gameepisode <= 4; ++gameepisode) {
        for (gamemap = 1; gamemap <= 9; ++gamemap) {
            S_Start();
            printf("level-track,%d\\n", selected);
        }
    }
    gamemode = commercial;
    for (gamemap = 1; gamemap <= 32; ++gamemap) {
        S_Start();
        printf("level-track,%d\\n", selected);
    }
    printf("intermission-track,%d,%d\\n", mus_inter, mus_dm2int);
}
`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-I", upstream, input, "-o", binary]);
    return run(binary, []).split(/\r?\n/).map(row => {
        const [tag, ...values] = row.split(",");
        return [tag, ...values.map(Number)];
    });
}

function preview() {
    const entry = path.join(scratch, "effects.flt");
    const output = path.join(scratch, "effects.json");
    writeFileSync(path.join(scratch, "EFFECTS.WAD"), wad([
        ["DSPISTOL", pcm([245, 32, 168, 0])], ["DSITEMUP", pcm([36, 192, 108, 211])],
    ]));
    writeFileSync(entry, `
package main
import "audio"
import "play"
import "wad"
const Effects = readFile("EFFECTS.WAD")

map "Doom sound effects parity" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register done bit = false
    tick {
        if !done {
            for index := range audio.SoundEffectCount - 1 {
                id := index + 1
                effect := audio.SoundEffectAt(id)
                log("effect", id, effect.LumpName.Low, effect.LumpName.High, effect.Priority,
                    effect.Pitch, effect.VolumeAdjustment, effect.Singular)
            }
            for index := range audio.MusicCount - 1 {
                id := index + 1
                track := audio.MusicLumpName(id)
                log("track", id, track.Low, track.High)
            }
            for episode := range 4 {
                for number := range 9 { log("level-track", audio.LevelMusic(false, episode + 1, number + 1)) }
            }
            for number := range 32 { log("level-track", audio.LevelMusic(true, 1, number + 1)) }
            log("intermission-track", audio.IntermissionMusic(false), audio.IntermissionMusic(true))
            mounts := wad.OpenArchive(Effects)
            listener := audio.SoundListener{Origin: 1, Volume: 64, MapNumber: 1}
            random := play.RandomState{GameplayIndex: 37}
            pistol := audio.StartSound(audio.SoundScene{}, mounts, listener, audio.SoundRequest{Id: audio.SoundPistol, Origin: 1}, random)
            log("pistol", pistol.Slot, pistol.Pitch, pistol.Parameters.Volume, pistol.Parameters.Separation,
                pistol.Random.MenuIndex, pistol.Random.GameplayIndex)
            alias := audio.StartSound(pistol.Scene, mounts, listener,
                audio.SoundRequest{Id: audio.SoundChaingun, Origin: 2}, pistol.Random)
            log("alias", alias.Slot, alias.Pitch, alias.Parameters.Separation, alias.Random.MenuIndex,
                alias.Scene.Mixer.Voices[alias.Slot].Sample.Lump.Name.Low)
            pickup := audio.StartSound(alias.Scene, mounts, listener,
                audio.SoundRequest{Id: audio.SoundItemUp, Origin: 1}, alias.Random)
            log("pickup", pickup.Slot, pickup.Pitch, pickup.Random.MenuIndex, pickup.Scene.Sounds[pickup.Slot])
            quiet := audio.StartSound(pickup.Scene, mounts, listener,
                audio.SoundRequest{Id: audio.SoundPistol, Origin: 3, Position: audio.SoundPoint{X: 1500 * 65536}}, pickup.Random)
            log("quiet", quiet.Slot, quiet.Random.MenuIndex)
            mixed := audio.MixFrame(pickup.Scene.Mixer)
            log("mix", mixed.Left, mixed.Right)
            fallback := audio.LoadSoundEffect(mounts, audio.SoundEffectAt(14))
            log("fallback", fallback.Valid, fallback.Lump.Name.Low)
            log("done")
            next done = true
        }
    }
}
`);
    run("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let tick = 0; tick < 70; tick++) {
        if (sim.logs.some(([name]) => name === "done")) return sim.logs;
        sim.step();
    }
    assert.fail("audio probe did not finish: " + JSON.stringify(sim.logs.slice(-5)));
}

try {
    const expected = nativeCatalogs();
    const logs = preview();
    const catalog = new Set(["effect", "track", "level-track", "intermission-track"]);
    assert.deepEqual(logs.filter(([name]) => catalog.has(name)).map(([name, ...fields]) => [name, ...fields.map(Number)]), expected);
    const values = name => logs.find(row => row[0] === name)?.slice(1);
    const pistolName = expected[0][2];
    assert.deepEqual(values("pistol"), [0, 136, 64, 128, 1, 37]);
    assert.deepEqual(values("alias"), [1, 153, 128, 2, pistolName]);
    assert.deepEqual(values("pickup"), [0, 128, 2, 32]);
    assert.deepEqual(values("quiet"), [-1, 2]);
    assert.ok(values("mix").every(sample => sample > 0), "both stereo channels carry the synthetic signal");
    assert.deepEqual(values("fallback"), [true, pistolName]);
    console.log("Doom audio passed pinned sound and music tables, map track selection, alias, pitch RNG, spatial rejection, and WAD-backed mix.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-audio-effects-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
