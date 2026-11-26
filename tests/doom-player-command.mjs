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
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-player-command-"));
const inputs = ["Forward", "Reverse", "TurnLeft", "TurnRight", "StrafeLeft", "StrafeRight", "Run", "Strafe"];
// Prior turn tics followed by relative mouse X/Y in Doom's command units.
const conditions = [[0, 0, 0], [4, 0, 0], [5, 0, 0], [32, 0, 0], [5, 9, 11], [0, -24, 64],
    [6, 1024, -1024], [6, -1024, 1024], [0, 6144, 0], [0, -6144, 0]];
const maskCount = 1 << inputs.length;
const caseCount = maskCount * conditions.length;

function run(exe, args) {
    const result = spawnSync(exe, args, { cwd: root, encoding: "utf8", timeout: 60_000,
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function fletcherRows() {
    const main = path.join(scratch, "main.flt"), map = path.join(scratch, "map.json");
    writeFileSync(path.join(scratch, "zero-deltas.bin"), Buffer.alloc(maskCount * 3));
    writeFileSync(main, `package main
import "play"
const Tests = [${conditions.length}][3]int{${conditions.map(row => `[3]int{${row.join(", ")}}`).join(", ")}}
const ZeroDeltas = readFile("zero-deltas.bin")
map "Player command" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        row := currentTick()
        if row == 0 {
            var noKeys play.PlayerMoveKeys
            for axis := range 3 {
                axes := play.PlayerMoveAxes{Forward: axis == 0, Turn: axis == 1, Sidestep: axis == 2}
                command, held := play.BuildPlayerMoveCommandWithTable(noKeys, 0, 0, 0, axes, ZeroDeltas)
                log("axis-default", command.Forward, command.Side, command.Turn, held)
            }
        }
        sample := Tests[row / ${maskCount}]
        keys := bits<${inputs.length}>(row)
        move := play.PlayerMoveKeys{${inputs.map((field, index) => `${field}: keys[${index}]`).join(", ")}}
        command, held := play.BuildPlayerMoveCommand(move, sample[0], sample[1], sample[2])
        log(command.Forward, command.Side, command.Turn, held)
    }
}`);
    run("dotnet", [cli, "build", main, "--package-root", port, "-o", map]);
    const sim = simulator(decode(JSON.parse(readFileSync(map, "utf8")).data), true);
    for (let host = 0; host < 3 * caseCount && sim.logs.length < caseCount + 3; host++) sim.step();
    const [forward, turn, side, ...rows] = sim.logs.map(row => Array.from(row));
    assert.deepEqual([forward, turn, side], [
        ["axis-default", 25, 0, 0, 0], ["axis-default", 0, 0, 320, 0], ["axis-default", 0, -24, 0, 0],
    ]);
    assert.equal(rows.length, caseCount);
    return rows.map(row => row.map(Number));
}

function nativeRows(upstream) {
    const game = readFileSync(path.join(upstream, "g_game.c"), "utf8").replaceAll("\r\n", "\n");
    const rates = game.match(/^fixed_t\s+(?:forwardmove|sidemove|angleturn)\[[^\]]+\]\s*=\s*\{[^}]+\};/gm);
    assert.equal(rates?.length, 3);
    const tuning = game.match(/^#define\s+(?:MAXPLMOVE|SLOWTURNTICS)\s+[^\n]+/gm);
    assert.equal(tuning?.length, 2);
    const source = path.join(scratch, "commands.c");
    const exe = path.join(scratch, process.platform === "win32" ? "commands.exe" : "commands");
    writeFileSync(source, `#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef int32_t fixed_t;
typedef int boolean;
typedef struct {
    int8_t forwardmove, sidemove;
    int16_t angleturn, consistancy;
    uint8_t chatchar, buttons;
} ticcmd_t;

enum { BACKUPTICS = 12, NUMWEAPONS = 9, BT_ATTACK = 1, BT_USE = 2, BT_CHANGE = 4,
    BT_WEAPONSHIFT = 3, BT_SPECIAL = 128, BTS_PAUSE = 1, BTS_SAVEGAME = 2, BTS_SAVESHIFT = 2 };
enum { key_up, key_down, key_left, key_right, key_strafeleft, key_straferight, key_speed, key_strafe, key_fire, key_use };
enum { mousebfire, mousebstrafe, mousebforward, joybfire = 0, joybstrafe, joybspeed, joybuse };

${rates.join("\n")}
${tuning.join("\n")}
static boolean gamekeydown[256], mousebuttons[3], joybuttons[4];
static int mousex, mousey, joyxmove, joyymove, turnheld;
static int consoleplayer, maketic, consistancy[1][BACKUPTICS], ticdup = 1;
static int dclickstate, dclicktime, dclicks, dclickstate2, dclicktime2, dclicks2;
static int sendpause, sendsave, savegameslot;
static ticcmd_t base;
static ticcmd_t *I_BaseTiccmd(void) { return &base; }
static int HU_dequeueChatChar(void) { return 0; }

${extractFunction(game, "void", "G_BuildTiccmd")}

int main(void) {
    const int cases[][3] = {${conditions.map(row => `{${row.join(", ")}}`).join(", ")}};
    for (size_t mode = 0; mode < sizeof(cases) / sizeof(cases[0]); ++mode) {
        for (int mask = 0; mask < ${maskCount}; ++mask) {
            for (int key = key_up; key <= key_strafe; ++key) gamekeydown[key] = (mask >> key) & 1;
            turnheld = cases[mode][0]; mousex = cases[mode][1]; mousey = cases[mode][2];
            ticcmd_t command;
            G_BuildTiccmd(&command);
            printf("%d,%d,%d,%d\\n", command.forwardmove, command.sidemove, command.angleturn, turnheld);
        }
    }
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(row => row.split(",").map(Number));
}

try {
    const fletcher = fletcherRows();
    const hash = createHash("sha256").update(JSON.stringify(fletcher)).digest("hex");
    if (values.upstream) {
        const native = nativeRows(path.resolve(root, values.upstream));
        assert.equal(native.length, caseCount);
        for (let row = 0; row < caseCount; row++) {
            assert.deepEqual(fletcher[row], native[row], `condition ${row >> inputs.length}, key mask ${row & (maskCount - 1)}`);
        }
        console.log(`Matched ${caseCount} keyboard and mouse movement commands with pinned G_BuildTiccmd. SHA-256 ${hash}.`);
    } else {
        assert.equal(hash, "be83281f2faa1239071fe023ad8fef4e1e2182ac6a70bd9a0df7c1e3a7a43bcf");
        console.log(`Verified ${caseCount} movement commands against the pinned C snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-player-command-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
