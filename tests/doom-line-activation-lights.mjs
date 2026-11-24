// Compare shared tagged lights and reusable wall buttons through both line dispatchers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" } } });
const upstream = path.resolve(root, values.upstream ?? "artifacts/doom-upstream");
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-line-light-"));
const levels = [128, 80, 16, 240], tags = [7, 7, 8, 9];
// Room order west to east is 2, 0, 1, 3. Sector 0 is visited before sector 1.
// Actions on the north/south walls of sector 0 share the same first sidedef.
const edges = [
    // first vertex, last vertex, front sector/side, back sector/side, special, tag
    [5, 4, 0, 1, 80, 7], [3, 2, 2, 0, 104, 7], [7, 6, 1, 3, 12, 7],
    [3, 5, 0, -1, 138, 7], [4, 2, 0, -1, 139, 7], [1, 3, 2, -1, 138, 8],
    [10, 11, 2, 2, 79, 7], [12, 13, 3, 3, 81, 7], [6, 4, 1, -1, 138, 99],
    [0, 1, 2, -1, 0, 0], [7, 9, 3, -1, 0, 0], [9, 8, 3, -1, 0, 0], [8, 6, 3, -1, 0, 0],
    [2, 0, 2, -1, 0, 0], [5, 7, 1, -1, 0, 0],
    [14, 15, 2, 2, 13, 7], [16, 17, 3, 3, 35, 7],
];
// line, use instead of crossing, player, back side
const commands = [
    [0, 0, 1, 0], [7, 0, 1, 0], [1, 0, 1, 0], [1, 0, 1, 0],
    [3, 1, 1, 1], [3, 1, 0, 0], [3, 1, 1, 0], [4, 1, 1, 0],
    [3, 1, 1, 0], [6, 0, 0, 0], [6, 0, 1, 0], [5, 1, 1, 0],
    [0, 0, 1, 0], [4, 1, 1, 0], [2, 0, 1, 0], [2, 0, 1, 0], [8, 1, 1, 0],
];
const buttonsRestoredTic = commands.length + 35;
const brightOnce = edges.findIndex(edge => edge[4] === 13), dimOnce = edges.findIndex(edge => edge[4] === 35);
const oneShotCommands = [
    [6, 0, 1, 0], [brightOnce, 0, 0, 0], [brightOnce, 0, 1, 0], [dimOnce, 0, 1, 0],
    [brightOnce, 0, 1, 0], [7, 0, 1, 0], [dimOnce, 0, 1, 0],
];
const schedule = [...commands.map((cmd, tic) => [tic, ...cmd]),
    ...oneShotCommands.map((cmd, i) => [buttonsRestoredTic + 1 + i, ...cmd])];
const finalTic = schedule.at(-1)[0];

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 60000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function words(values) {
    const data = Buffer.alloc(2 * values.length);
    values.forEach((value, i) => data.writeInt16LE(value, i * 2));
    return data;
}

function writeLevel() {
    const sides = Buffer.alloc(30 * tags.length), sectors = Buffer.alloc(26 * tags.length);
    for (const [s, tag] of tags.entries()) {
        sides.write("SW1BRCOM", 30 * s + 4);
        sides.writeInt16LE(s, 30 * s + 28);
        sectors.writeInt16LE(128, 26 * s + 2);
        sectors.writeInt16LE(levels[s], 26 * s + 20);
        sectors.writeInt16LE(tag, 26 * s + 24);
    }
    const names = ["DUMMY", "SW1BRCOM", "SW2BRCOM"];
    const textures = Buffer.alloc(4 + 26 * names.length);
    textures.writeInt32LE(names.length);
    names.forEach((name, i) => {
        const record = 4 + 4 * names.length + 22 * i;
        textures.writeInt32LE(record, 4 + i * 4);
        textures.write(name, record);
        textures.writeInt16LE(1, record + 12);
        textures.writeInt16LE(1, record + 14);
    });
    // Only the tagged sector graph and texture table are queried by the dispatchers.
    const vertices = [-128, -64, 0, 64, 128, -96, 96, -112, 112].flatMap(x => [x, -32, x, 32]);
    const lines = edges.flatMap(([v1, v2, front, back, special, tag]) =>
        [v1, v2, back < 0 ? 1 : 4, special, tag, front, back]);
    const lumps = [["E1M1", Buffer.alloc(0)], ["THINGS", words([-32, 0, 0, 1, 7])], ["LINEDEFS", words(lines)],
        ["SIDEDEFS", sides], ["VERTEXES", words(vertices)], ["SEGS", words([3, 5, 0, 3, 0, 0])],
        ["SSECTORS", words([1, 0])], ["NODES", Buffer.alloc(0)], ["SECTORS", sectors],
        ["REJECT", Buffer.alloc(2)], ["BLOCKMAP", words([-128, -128, 1, 1, 5, 0, -1])],
        ["PNAMES", Buffer.alloc(4)], ["TEXTURE1", textures]];
    const directory = lumps.reduce((pos, [, data]) => pos + data.length, 12);
    const file = Buffer.alloc(directory + 16 * lumps.length);
    file.write("PWAD");
    file.writeInt32LE(lumps.length, 4);
    file.writeInt32LE(directory, 8);
    let offset = 12;
    for (const [i, [name, data]] of lumps.entries()) {
        const entry = directory + 16 * i;
        file.writeInt32LE(offset, entry);
        file.writeInt32LE(data.length, entry + 4);
        file.write(name, entry + 8);
        data.copy(file, offset);
        offset += data.length;
    }
    writeFileSync(path.join(scratch, "LIGHTS.WAD"), file);
}

function fletcherRows() {
    writeLevel();
    const source = path.join(scratch, "main.flt"), output = path.join(scratch, "map.json");
    writeFileSync(source, `package main
import "play"
import "wad"
const Data = readFile("LIGHTS.WAD")
map "Tagged light dispatch" {
    screen at (0, 0) size (1, 1) with {style = "solid", hold = true, slice = true}
    register saved play.LevelSpecials = play.LevelSpecials{}
    register tic int = 0
    tick {
        base := wad.LoadBspLevel(Data, wad.LE32(Data, 8))
        state := saved
        live := state.ApplyTo(base)
        index, use, player, back := -1, false, true, false
        switch tic {
${schedule.map(([t, i, use, player, back]) => `        case ${t}: index, use, player, back = ${i}, ${!!use}, ${!!player}, ${!!back}`).join("\n")}
        }
        used := -1
        if index >= 0 {
            if use {
                activated := play.UseActorLine(live, state, index, back, player, play.PlayerInventory{})
                state, used = activated.State, 0
                if activated.Used { used = 1 }
            } else if player { state = play.CrossLevelSpecial(live, state, index) } else {
                state = play.CrossMonsterLine(live, state, index)
            }
        }
        state.Doors = state.Doors.TickButtonTimers(base)
        live = state.ApplyTo(base)
        lights, buttons := state.Lighting.Lights, state.Doors.Switches
        log(tic, used, live.LineAt(1).Action, live.LineAt(2).Action,
            ${tags.map((_, i) => `lights.LightAt(${i}, base.SectorLight(${i}))`).join(", ")},
            ${[3, 8, 5].map(i => `live.SideMaterialAt(live.LineFrontSide(${i})).Upper.Low == 0x42325753`).join(", ")},
            buttons.ButtonCount, ${[0, 1, 2, 3].map(i => `buttons.Buttons[${i}].Tics`).join(", ")},
            live.LineAt(0).Action, live.LineAt(3).Action, live.LineAt(4).Action,
            live.LineAt(${brightOnce}).Action, live.LineAt(${dimOnce}).Action)
        next saved = state
        next tic = tic + 1
    }
}`);
    run("dotnet", [cli, "build", source, "--package-root", path.join(root, "examples/doom-engine"), "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let host = 0; host < 6000 && sim.logs.length <= finalTic; ++host) sim.step();
    assert.equal(sim.logs.length, finalTic + 1, "sliced light simulation completed");
    return sim.logs.map(row => Array.from(row, Number));
}

function nativeRows() {
    const read = name => readFileSync(path.join(upstream, name), "utf8").replaceAll("\r\n", "\n");
    const spec = read("animated-p_spec.c"), switches = read("switch-p_switch.c"), lights = read("light-p_lights.c");
    const cross = extractFunction(spec, "void", "P_CrossSpecialLine");
    const use = extractFunction(switches, "boolean", "P_UseSpecialLine");
    const update = extractFunction(spec, "void", "P_UpdateSpecials");
    const buttonLoop = update.match(/\/\/\s*DO BUTTONS\s*([\s\S]*)\}\s*$/)?.[1];
    assert.ok(buttonLoop?.includes("sizeof(button_t)"), "native button expiry loop");
    const supported = ["EV_LightTurnOn", "EV_TurnTagLightsOff"];
    const others = [...new Set((cross + use).match(/\b(?:EV_|G_)[A-Za-z]+\b/g))].filter(n => !supported.includes(n));
    const source = path.join(scratch, "lighting.c"), exe = path.join(scratch, process.platform === "win32" ? "lighting.exe" : "lighting");
    writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef int boolean;
typedef struct { int player, type; } mobj_t;
typedef struct sector_s sector_t;
typedef struct { sector_t *frontsector,*backsector; int special,flags,tag,sidenum[2]; } line_t;
struct sector_s { int tag,lightlevel,linecount; line_t *lines[${edges.length}]; mobj_t soundorg; };
typedef struct { int toptexture,midtexture,bottomtexture; } side_t;
typedef enum { top,middle,bottom } bwhere_e;
typedef struct { line_t *line; bwhere_e where; int btexture,btimer; mobj_t *soundorg; } button_t;
enum { false,true, MAXBUTTONS=16,BUTTONTIME=35,ML_SECRET=32,ML_TWOSIDED=4,
       MT_ROCKET,MT_PLASMA,MT_BFG,MT_TROOPSHOT,MT_HEADSHOT,MT_BRUISERSHOT,sfx_swtchn,sfx_swtchx };
static sector_t sectors[${tags.length}]; static int numsectors=${tags.length};
static line_t lines[${edges.length}]; static side_t sides[${tags.length}];
static button_t buttonlist[MAXBUTTONS]; static int numswitches=1,switchlist[]={1,2};
static void S_StartSound(mobj_t *origin,int sound) {}
static void I_Error(char *message) { fprintf(stderr,"%s\\n",message); abort(); }
${extractFunction(spec, "sector_t\\*", "getNextSector")}
${supported.map(n => extractFunction(lights, "void", n)).join("\n")}
${extractFunction(switches, "void", "P_StartButton")}
${extractFunction(switches, "void", "P_ChangeSwitchTexture")}
${others.map(n => `#define ${n}(...) (abort(),0)`).join("\n")}
${cross}
${use}
static void tickButtons(void) { int i; ${buttonLoop} }
int main(void) {
    const int tags[] = {${tags}}, levels[] = {${levels}};
    const int graph[][4] = {${edges.map(([, , front, back, action, tag]) => `{${front},${back},${action},${tag}}`).join(",")}};
    const int cmds[][5] = {${schedule.map(row => `{${row}}`).join(",")}};
    for (int s=0;s<numsectors;s++) {
        sectors[s].tag=tags[s]; sectors[s].lightlevel=levels[s]; sides[s].toptexture=1;
    }
    for (int i=0;i<${edges.length};i++) {
        int front=graph[i][0],back=graph[i][1];
        line_t *line=&lines[i];
        *line=(line_t){.frontsector=&sectors[front],.special=graph[i][2],.tag=graph[i][3],.sidenum={front,back}};
        sectors[front].lines[sectors[front].linecount++]=line;
        if (back>=0) {
            line->backsector=&sectors[back]; line->flags=ML_TWOSIDED;
            if (front!=back) sectors[back].lines[sectors[back].linecount++]=line;
        }
    }
    int next=0;
    for (int tic=0;tic<=${finalTic};tic++) {
        int used=-1,active=0;
        if (next<${schedule.length} && tic==cmds[next][0]) {
            const int *cmd=cmds[next++];
            mobj_t actor={.player=cmd[3]};
            if (cmd[2]) used=P_UseSpecialLine(&actor,&lines[cmd[1]],cmd[4]);
            else P_CrossSpecialLine(cmd[1],cmd[4],&actor);
        }
        tickButtons();
        printf("%d,%d,%d,%d",tic,used,lines[1].special,lines[2].special);
        for (int s=0;s<numsectors;s++) printf(",%d",sectors[s].lightlevel);
        for (int s=0;s<3;s++) printf(",%d",sides[s].toptexture==2);
        for (int i=0;i<MAXBUTTONS;i++) active+=buttonlist[i].btimer!=0;
        printf(",%d",active);
        for (int i=0;i<4;i++) printf(",%d",buttonlist[i].btimer);
        printf(",%d,%d,%d,%d,%d\\n",lines[0].special,lines[3].special,lines[4].special,
            lines[${brightOnce}].special,lines[${dimOnce}].special);
    }
    return 0;
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(row => row.split(",").map(Number));
}

try {
    const native = nativeRows(), compiled = fletcherRows();
    assert.deepEqual(native[0].slice(4, 8), [80, 80, 16, 240], "brightest neighbor carries to the second tagged sector");
    assert.deepEqual(native[2].slice(4, 8), [16, 16, 16, 240], "darkening propagates through the shared tagged edge");
    assert.equal(native[8][12], 32, "repressing the first switch preserves the original release time");
    assert.deepEqual(native[buttonsRestoredTic].slice(8, 12), [1, 0, 0, 0], "shared-side timers restore their individual split-time textures");
    assert.deepEqual(native.slice(buttonsRestoredTic + 1).map(row => [...row.slice(4, 8), ...row.slice(-2)]), [
        [35,35,255,240,13,35], [35,35,255,240,13,35], [255,255,255,240,0,35],
        [35,35,255,240,0,0], [35,35,255,240,0,0], [255,255,255,240,0,0], [255,255,255,240,0,0],
    ], "one-shot fixed lights affect both tagged sectors, survive monster crossing and stay spent on player revisits");
    for (const [tic, row] of native.entries()) assert.deepEqual(compiled[tic], row, `tagged light and switch state at tic ${tic}`);
    console.log(`Matched ${native.length} tics across ${schedule.length} use/cross requests for light specials 12, 13, 35, 79, 80, 81, 104, 138 and 139 with pinned Doom C.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-line-light-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
