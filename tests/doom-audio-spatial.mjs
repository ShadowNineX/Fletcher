import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const upstream = path.join(root, "artifacts/doom-upstream");
const scratch = mkdtempSync(path.join(realpathSync(os.tmpdir()), "fletcher-doom-audio-spatial-"));
const cli = path.join(root, "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const unit = 65536;
const fixtures = [
    [0, 0, 0, 0, 0, 0, 1, 127], [0, 0, 0, 80, 0, 0, 1, 90],
    [0, 0, 0, 80, 0, 0, 1, 0],
    [0, 0, 0, 160, 0, 0, 1, 127], [0, 0, 0, 700, 700, 0, 1, 127],
    [0, 0, 0x20000000, 600, 0, 0, 1, 127], [100, -200, 0xc0000000, -1200, 160, 0, 1, 127],
    [0, 0, 0, 1400, 0, 0, 1, 127], [0, 0, 0, 1600, 0, 0, 8, 127],
    [0, 0, 0x80000000, -600, 450, 0, 8, 15],
];

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function native() {
    const read = file => readFileSync(path.join(upstream, file), "utf8").replaceAll("\r\n", "\n");
    const sound = read("s_sound.c"), render = read("r_main.c"), fixed = read("m_fixed.c"), tables = read("tables.c");
    const fine = tables.match(/int finesine\[10240\]\s*=\s*\{[\s\S]*?^\};/m)?.[0];
    const tangents = tables.match(/angle_t tantoangle\[2049\]\s*=\s*\{[\s\S]*?^\};/m)?.[0];
    assert.ok(fine && tangents, "Missing pinned Doom lookup tables");
    const input = path.join(scratch, "spatial.c"), exe = path.join(scratch, "spatial.exe");
    const calls = fixtures.map(row => `emit(${row.map((value, index) => index === 2 ? `UINT32_C(${value >>> 0})` : value).join(", ")});`).join("\n    ");
    writeFileSync(input, `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
typedef int32_t fixed_t; typedef uint32_t angle_t; typedef struct { fixed_t x,y; angle_t angle; } mobj_t;
typedef struct sfxinfo_struct { int priority; } sfxinfo_t;
typedef struct { sfxinfo_t *sfxinfo; void *origin; } channel_t;
enum { FRACBITS=16, FRACUNIT=65536, SLOPERANGE=2048, ANGLETOFINESHIFT=19, S_CLIPPING_DIST=1200*FRACUNIT, S_CLOSE_DIST=160*FRACUNIT, S_ATTENUATOR=(S_CLIPPING_DIST-S_CLOSE_DIST)>>FRACBITS, S_STEREO_SWING=96*FRACUNIT, ANG90=0x40000000, ANG180=0x80000000, ANG270=0xc0000000 };
static fixed_t viewx,viewy; static int gamemap,snd_SfxVolume; static int numChannels=8; static channel_t channels[8];
${fine}
${tangents}
static unsigned SlopeDiv(unsigned num,unsigned den) { unsigned answer; if(den<512)return SLOPERANGE; answer=(num<<3)/(den>>8); return answer>SLOPERANGE?SLOPERANGE:answer; }
${extractFunction(fixed, "fixed_t", "FixedMul")}
${extractFunction(render, "angle_t", "R_PointToAngle")}
${extractFunction(render, "angle_t", "R_PointToAngle2")}
static void S_StopChannel(int cnum) { channels[cnum].sfxinfo=0; }
${extractFunction(sound, "int", "S_AdjustSoundParams")}
${extractFunction(sound, "int", "S_getChannel")}
static void emit(int lx,int ly,uint32_t angle,int sx,int sy,int unused,int map,int volume) { int sep=0,pitch=128,audible; mobj_t l={lx*FRACUNIT,ly*FRACUNIT,angle},s={sx*FRACUNIT,sy*FRACUNIT,0}; gamemap=map;snd_SfxVolume=volume; audible=S_AdjustSoundParams(&l,&s,&volume,&sep,&pitch); printf("%d,%d,%d\\n",audible,volume,sep); }
static void slot(int active,int same,int oldPriority,int origin,int priority) { sfxinfo_t old={oldPriority}, incoming={priority}; for(int i=0;i<8;i++){channels[i].sfxinfo=active?&old:0;channels[i].origin=(void *)(intptr_t)(same&&i==0?origin:100+i);} printf("%d\\n",S_getChannel((void *)(intptr_t)origin,&incoming)); }
int main(void) { ${calls} slot(0,0,0,4,64);slot(1,1,96,2,64);slot(1,0,96,3,64);slot(1,0,20,3,64);slot(1,0,20,3,20);slot(1,0,20,0,64); }
`);
    run("gcc", ["-std=c11", "-O2", input, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(row => row.split(",").map(Number));
}

function fletcher() {
    const input = path.join(scratch, "main.flt"), output = path.join(scratch, "spatial.json");
    const first = fixtures[0];
    const rows = fixtures.slice(1).map((r, i) => `if step == ${i + 1} { next listener = audio.SoundPoint{X: ${r[0] * unit}, Y: ${r[1] * unit}, Angle: bits<32>(${r[2] >>> 0})}; next source = audio.SoundPoint{X: ${r[3] * unit}, Y: ${r[4] * unit}}; next mapNumber = ${r[6]}; next volume = ${r[7]} }`).join(" else ");
    writeFileSync(input, `package main
import "audio"
map "Doom spatial audio parity" { screen at (0,0) size (1,1) with { style = "solid", slice = true }
 register step int = 0
 register listener audio.SoundPoint = audio.SoundPoint{X: ${first[0] * unit}, Y: ${first[1] * unit}, Angle: bits<32>(${first[2] >>> 0})}
 register source audio.SoundPoint = audio.SoundPoint{X: ${first[3] * unit}, Y: ${first[4] * unit}}
 register mapNumber int = ${first[6]}
 register volume int = ${first[7]}
 tick { ${rows}
  result := audio.AdjustSound(listener, source, mapNumber, volume)
  log(result.Audible, result.Volume, result.Separation)
  next step = step + 1
 }
}`);
    run("dotnet", [cli, "build", input, "--package-root", path.join(root, "examples/doom-engine"), "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let i = 0; i <= fixtures.length; ++i) sim.step();
    const spatial = sim.logs.slice(1).map(row => [Number(row[0]), ...row.slice(1).map(Number)]);
    const slotSource = `package main
import "audio"
map "Doom channel parity" {
 screen at (0,0) size (1,1) with { style = "solid", slice = true }
 tick {
  var full [audio.SoundChannels]audio.SoundSlot
  for i := range audio.SoundChannels { full[i] = audio.SoundSlot{Active: true, Origin: 100+i, Priority: 20} }
  var loud [audio.SoundChannels]audio.SoundSlot
  for i := range audio.SoundChannels { loud[i] = audio.SoundSlot{Active: true, Origin: 100+i, Priority: 96} }
  loud[0].Origin = 2
  log(audio.SelectSoundSlot([audio.SoundChannels]audio.SoundSlot{},4,64), audio.SelectSoundSlot(loud,2,64), audio.SelectSoundSlot(loud,3,64), audio.SelectSoundSlot(full,3,64), audio.SelectSoundSlot(full,3,20), audio.SelectSoundSlot(full,0,64))
 }
}`;
    writeFileSync(input, slotSource); run("dotnet", [cli, "build", input, "--package-root", path.join(root, "examples/doom-engine"), "-o", output]);
    const slotSim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true); slotSim.step();
    return [...spatial, slotSim.logs.at(-1).map(Number)];
}

try {
    const actual = fletcher(), expected = native();
    assert.deepEqual(actual.slice(0, fixtures.length), expected.slice(0, fixtures.length));
    assert.deepEqual(actual.at(-1), expected.slice(fixtures.length).flat());
    console.log("Doom spatial attenuation, stereo wrap, map-eight floor, and channel pressure matched pinned C.");
} finally { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
