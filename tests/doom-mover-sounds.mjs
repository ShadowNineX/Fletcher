import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" } } });
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-mover-sounds-"));
const cases = [];
function add(family, modes, directions) {
    for (const mode of modes) for (const direction of directions) {
        for (const levelTime of [7, 8]) for (const atEnd of [0, 1]) {
            for (const blocked of [0, 1]) for (const count of [1, 2]) {
                cases.push([family, mode, direction, levelTime, atEnd, blocked, count, 1]);
            }
        }
        cases.push([family, mode, direction, 8, 1, 0, 1, 0]); // Removed thinker.
    }
}
add(0, [0, 1, 2, 3, 4, 5, 6, 7], [-1, 0, 1, 2]); // Vertical door directions and waits.
add(1, [1, 5, 12, 14], [-1, 1]); // Ordinary, crushing and texture-changing floors.
add(2, [1, 2, 3, 4, 5], [0, 1, 2, 3]); // Platform up/down/waiting/stasis.
add(3, [1, 2, 3, 4, 5, 6], [-1, 0, 1]); // Ceiling up/down/stasis.

function run(command, args, input) {
    const child = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30_000, input });
    if (child.error) throw child.error;
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return child.stdout;
}

function runFletcher() {
    const entry = path.join(scratch, "main.flt"), output = path.join(scratch, "map.json");
    writeFileSync(path.join(scratch, "INPUT.BIN"),
        Buffer.from(cases.flatMap(row => row.map((value, index) => index === 2 ? value + 1 : value))));
    writeFileSync(entry, `package main
import "play"
const Inputs = readFile("INPUT.BIN")
map "Doom mover sounds" {
    tick {
        i := currentTick() * 8
        family, mode, direction := int(Inputs[i]), int(Inputs[i + 1]), int(Inputs[i + 2]) - 1
        levelTime, atEnd, blocked := int(Inputs[i + 3]), Inputs[i + 4] != 0, Inputs[i + 5] != 0
        count, active := int(Inputs[i + 6]), Inputs[i + 7] != 0
        low, high := 0, 16
        if atEnd { low, high = 8, 8 }
        var sounds play.MoverTickSounds
        switch family {
        case 0:
            before := play.DoorState{Active: active, Mode: mode, Direction: direction,
                Countdown: count, Speed: 1, Floor: low, Ceiling: 8, Top: high, TopWait: 150}
            sounds = play.DoorTickSounds(before, play.TickDoor(before, blocked))
        case 1:
            dest := high
            if direction == -1 { dest = low }
            before := play.FloorState{Active: active, Mode: mode, Direction: direction,
                Height: 8, Speed: 1, Crush: mode == play.FloorRaiseCrush, Destination: dest}
            sounds = play.FloorTickSounds(before, play.TickFloor(before, blocked), levelTime)
        case 2:
            before := play.PlatformState{Active: active, Mode: mode, Status: direction, Count: count,
                Height: 8, Speed: 1, Low: low, High: high, Wait: 105}
            sounds = play.PlatformTickSounds(before, play.TickPlatform(before, blocked), levelTime)
        case 3:
            before := play.CeilingState{Active: active, Mode: mode, Direction: direction,
                Height: 8, Speed: 1, Bottom: low, Top: high, Crush: mode >= play.CeilingCrushAndRaise}
            sounds = play.CeilingTickSounds(before, play.TickCeiling(before, blocked), levelTime)
        }
        log(sounds.First, sounds.Second)
    }
}`);
    const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
    run("dotnet", [cli, "build", entry, "--package-root", path.join(root, "examples/doom-engine"), "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let i = 0; i < cases.length; i++) sim.step();
    return Array.from(sim.logs, row => Array.from(row));
}

function runNative(directory) {
    const read = file => readFileSync(path.resolve(root, directory, file), "utf8").replaceAll("\r\n", "\n");
    const floor = read("door-p_floor.c");
    const sounds = read("sounds.h").match(/typedef enum\s*\{\s*sfx_None,[\s\S]*?\}\s*sfxenum_t\s*;/)?.[0];
    assert.ok(sounds, "Missing Linux Doom sound enum");
    const source = path.join(scratch, "movers.c"), exe = path.join(scratch, "movers.exe");
    writeFileSync(source, `#include <assert.h>
#include <stdio.h>
typedef int boolean, fixed_t, mobj_t;
enum {false, true};
typedef enum {ok, crushed, pastdest} result_e;
enum {normal, close30ThenOpen, close, open, raiseIn5Mins, blazeRaise, blazeOpen, blazeClose};
enum {lowerAndChange=12, donutRaise=14};
enum {perpetualRaise=1, downWaitUpStay, raiseAndChange, raiseToNearestAndChange, blazeDWUS};
enum {up, down, waiting, in_stasis};
enum {lowerToFloor=1, raiseToHighest, lowerAndCrush, crushAndRaise, fastCrushAndRaise, silentCrushAndRaise};
enum {CEILSPEED=65536};
${sounds}
typedef struct {
    int floorheight, ceilingheight, floorpic, special, soundorg;
    void *specialdata;
} sector_t;
typedef struct { sector_t *sector; int type, speed, direction, thinker, topcountdown, topwait, topheight; } vldoor_t;
typedef struct { sector_t *sector; int type, speed, direction, thinker, floordestheight, crush, newspecial, texture; } floormove_t;
typedef struct { sector_t *sector; int type, speed, status, count, wait, low, high, crush; } plat_t;
typedef struct { sector_t *sector; int type, speed, direction, bottomheight, topheight, crush; } ceiling_t;
static sector_t sec;
static int leveltime, blocked, emitted[2], length;
static void S_StartSound(mobj_t *origin, int sound) {
    assert(origin==&sec.soundorg && length<2);
    emitted[length++]=sound;
}
static boolean P_ChangeSector(sector_t *sector, boolean crush) { return blocked; }
static void P_RemoveThinker(int *thinker) {}
static void P_RemoveActivePlat(plat_t *platform) {}
static void P_RemoveActiveCeiling(ceiling_t *ceiling) {}
${extractFunction(floor, "result_e", "T_MovePlane")}
${extractFunction(floor, "void", "T_MoveFloor")}
${extractFunction(read("door-p_doors.c"), "void", "T_VerticalDoor")}
${extractFunction(read("platform-p_plats.c"), "void", "T_PlatRaise")}
${extractFunction(read("ceiling-p_ceilng.c"), "void", "T_MoveCeiling")}
int main(void) {
    int family, mode, direction, atEnd, count, active;
    while (scanf("%d%d%d%d%d%d%d%d", &family,&mode,&direction,&leveltime,&atEnd,&blocked,&count,&active)==8) {
        int low=atEnd ? 8 : 0, high=atEnd ? 8 : 16;
        sec=(sector_t){.floorheight=8,.ceilingheight=8};
        length=emitted[0]=emitted[1]=0;
        if (active) switch (family) {
        case 0: {
            sec.floorheight=low;
            vldoor_t door={.sector=&sec,.type=mode,.speed=1,.direction=direction,.topcountdown=count,.topwait=150,.topheight=high};
            T_VerticalDoor(&door);
            break;
        }
        case 1: {
            floormove_t floor={.sector=&sec,.type=mode,.speed=1,.direction=direction,.crush=mode==5,
                .floordestheight=direction==-1 ? low : high};
            T_MoveFloor(&floor);
            break;
        }
        case 2: {
            plat_t plat={.sector=&sec,.type=mode,.speed=1,.status=direction,.low=low,.high=high,.count=count,.wait=105};
            T_PlatRaise(&plat);
            break;
        }
        case 3: {
            ceiling_t ceiling={.sector=&sec,.type=mode,.speed=1,.direction=direction,.bottomheight=low,.topheight=high,
                .crush=mode>=crushAndRaise};
            T_MoveCeiling(&ceiling);
            break;
        }}
        printf("[%d,%d]\\n",emitted[0],emitted[1]);
    }
    return 0;
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", exe]);
    const input = cases.map(row => row.join(" ")).join("\n");
    return run(exe, [], input).trim().split(/\r?\n/).map(line => JSON.parse(line));
}

try {
    const actual = runFletcher();
    assert.equal(actual.length, cases.length);
    const digest = rows => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    if (values.upstream) {
        const native = runNative(values.upstream);
        assert.equal(native.length, cases.length);
        native.forEach((expected, i) => assert.deepEqual(actual[i], expected, `mover sound vector ${cases[i]}`));
        console.log(`Matched ${cases.length} mover sound pairs against Linux Doom C. SHA-256 ${digest(native)}.`);
    } else {
        assert.equal(digest(actual), "c4e3b04868f209017421647b362d2274f37ae350f90c11169758525100c4501c");
        console.log(`Verified ${cases.length} mover sound pairs against the native snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-mover-sounds-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
