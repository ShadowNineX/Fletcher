// Compare the deterministic Fletcher PCM mixer with i_sound.c's Linux path.
// The fixtures are generated DMX data, not Doom audio assets.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "src", "Fletcher.Cli", "bin", "Debug", "net11.0", "fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const upstream = path.join(root, "artifacts", "doom-upstream", "i_sound.c");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-audio-pcm-"));

function dmx(samples, type = 3, rate = 11025, declared = samples.length) {
    const header = Buffer.alloc(8);
    header.writeUInt16LE(type, 0); header.writeUInt16LE(rate, 2); header.writeUInt32LE(declared, 4);
    return Buffer.concat([header, Buffer.from(samples)]);
}

function source() {
    return `package audio_test
import "audio"
import "wad"
const Data = readFile("SOUND.bin")
map "Audio PCM" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register mixer audio.Mixer = audio.Mixer{}
    register started bit = false
    tick {
        current := mixer
        sound := audio.LoadSoundSample(wad.LumpRef{File: Data, Size: len(Data), Valid: true})
        if !started {
            current.Voices[0] = audio.StartVoice(sound, 127, 128, 128)
            current.Voices[1] = audio.StartVoice(sound, 100, 32, 192)
            next started = true
            log("sample", sound.Valid, sound.Length, sound.PaddedLength, sound.Rate)
        }
        frame := audio.MixFrame(current)
        next mixer = frame.Mixer
        log("frame", frame.Left, frame.Right, frame.Mixer.Voices[0].Active, frame.Mixer.Voices[1].Active)
    }
}`;
}

function build(data, name) {
    const folder = path.join(scratch, name), output = path.join(folder, "map.json");
    mkdirSync(folder); writeFileSync(path.join(folder, "main.flt"), source()); writeFileSync(path.join(folder, "SOUND.bin"), data);
    const built = spawnSync("dotnet", [cli, "build", path.join(folder, "main.flt"), "--package-root", port,
        "--asset-root", folder, "-o", output], { cwd: root, encoding: "utf8", timeout: 30000 });
    assert.equal(built.status, 0, built.stderr || built.stdout);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
}

function extractFunction(source, name) {
    const start = source.indexOf(`void ${name}`);
    assert.ok(start >= 0, `missing ${name}`);
    const first = source.indexOf("{", start);
    let depth = 0;
    for (let index = first; index < source.length; index++) {
        if (source[index] === "{") depth++;
        if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
    }
    assert.fail(`unterminated ${name}`);
}

function nativeFrames() {
    const source = readFileSync(upstream, "utf8").replaceAll("\r\n", "\n");
    const update = extractFunction(source, "I_UpdateSound");
    const folder = path.join(scratch, "native"), input = path.join(folder, "mixer.c"), output = path.join(folder, "mixer.exe");
    mkdirSync(folder, { recursive: true });
    const c = [
        "#include <stdio.h>", "#define SAMPLECOUNT 512", "#define NUM_CHANNELS 8", "#define BUFMUL 4",
        "signed short mixbuffer[SAMPLECOUNT*BUFMUL];",
        "unsigned int channelstep[NUM_CHANNELS], channelstepremainder[NUM_CHANNELS];",
        "unsigned char *channels[NUM_CHANNELS], *channelsend[NUM_CHANNELS];",
        "int lookup[128*256], *channelleftvol_lookup[NUM_CHANNELS], *channelrightvol_lookup[NUM_CHANNELS];",
        update,
        "int main(void) { unsigned char samples[512]; for (int i=0; i<512; i++) samples[i]=128;",
        "samples[0]=128; samples[1]=129; samples[2]=130; samples[3]=131;",
        "for (int volume=0; volume<128; volume++) for (int sample=0; sample<256; sample++) lookup[volume*256+sample]=(volume*(sample-128)*256)/127;",
        "int volume=127, separation=128+1; int left=volume-((volume*separation*separation)>>16); separation-=257; int right=volume-((volume*separation*separation)>>16);",
        "channels[0]=samples; channelsend[0]=samples+512; channelstep[0]=65536; channelleftvol_lookup[0]=&lookup[left*256]; channelrightvol_lookup[0]=&lookup[right*256];",
        "volume=100; separation=32+1; left=volume-((volume*separation*separation)>>16); separation-=257; right=volume-((volume*separation*separation)>>16);",
        "channels[1]=samples; channelsend[1]=samples+512; channelstep[1]=131072; channelleftvol_lookup[1]=&lookup[left*256]; channelrightvol_lookup[1]=&lookup[right*256];",
        "I_UpdateSound(); for (int i=0; i<4; i++) printf(\"%d,%d\\n\", mixbuffer[i*2], mixbuffer[i*2+1]); return 0; }"
    ].join("\n");
    writeFileSync(input, c);
    const compiled = spawnSync(process.env.CC ?? "gcc", ["-std=c11", "-O2", input, "-o", output], { encoding: "utf8", timeout: 30000 });
    assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
    const ran = spawnSync(output, [], { encoding: "utf8", timeout: 30000 });
    assert.equal(ran.status, 0, ran.stderr || ran.stdout);
    return ran.stdout.trim().split(/\r?\n/).map(row => row.split(",").map(Number));
}

function logs(sim, label) { return sim.logs.filter(row => row[0] === label); }

try {
    const expected = nativeFrames();
    const sim = build(dmx([128, 129, 130, 131]), "valid");
    for (let tic = 0; tic < 12 && logs(sim, "frame").length < 4; tic++) sim.step();
    assert.deepEqual(logs(sim, "sample")[0], ["sample", true, 4, 512, 11025]);
    assert.deepEqual(logs(sim, "frame").slice(0, 4).map(([, left, right]) => [Number(left), Number(right)]), expected);
    assert.deepEqual(expected, [[0, 0], [590, 289], [382, 387], [574, 580]], "pinned I_UpdateSound fixture");

    const invalid = build(dmx([128], 1), "invalid");
    for (let tic = 0; tic < 6 && logs(invalid, "frame").length === 0; tic++) invalid.step();
    assert.deepEqual(logs(invalid, "sample")[0], ["sample", false, 0, 0, 0]);
    assert.deepEqual(logs(invalid, "frame")[0], ["frame", 0, 0, false, false]);
    console.log("Doom audio PCM matched pinned i_sound.c stereo frames, DMX padding, pitch stepping, and invalid-header silence.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-audio-pcm-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
